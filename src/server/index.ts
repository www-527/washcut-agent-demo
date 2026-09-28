import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {readFile, rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import multer from 'multer';
import {
  envelopeSchema,
  parseEnvelope,
  projectInputSchema,
  relayChatInputSchema,
  relayKeyInputSchema,
  relayKeyUpdateSchema,
  relayModelDiscoveryInputSchema,
  renderJobSchema,
  videoAnalysisTaskSchema,
  videoUploadCreateSchema,
  videoUrlImportSchema,
  type Envelope,
  type RenderJob,
  type TransportError,
} from '../shared/contracts.js';
import {
  AUTO_VIDEO_MAX_ASSET_COUNT,
  AUTO_VIDEO_VISUAL_CONCURRENCY_DEFAULT,
  autoCaptionSchema,
  autoVideoGenerationConnectionPatchSchema,
  autoVideoGenerationCreateSchema,
  transcriptionProviderActivationSchema,
  autoVideoProjectPatchSchema,
  autoVideoProjectCreateSchema,
  autoVideoProjectSchema,
  autoVideoErrorSchema,
  makeInitialProcessingSteps,
  makeInitialLocalProcessingSteps,
  type AiMode,
  type AutoVideoGeneration,
  type AutoVideoProject,
  type AutoVideoError,
  type StoredAutoVideoAsset,
} from '../shared/auto-video-contracts.js';
import {authFromRequest, canMutate, canReadJob} from './auth.js';
import {
  assetVariantPath,
  jobArtifactPath,
  prepareChatTestImages,
  prepareProtocolTestMedia,
  processUploadedMedia,
  publicAsset,
  signedMediaUrl,
  verifyMediaSignature,
} from './media.js';
import {RelayClient, RelayError, normalizeResponsesUrl, type RelayConfig} from './relay-client.js';
import {SqliteStore} from './store.js';
import {
  createTransportEnvelope,
  contextFromHeaders,
  newTransportId,
  sendEnvelope,
  sendTransportError,
} from './transport.js';
import {JobWorker} from './worker.js';
import {AutoVideoWorker, autoVideoModelConcurrencyLimit, toAutoVideoError} from './auto-video-worker.js';
import {recoverWorkersAfterServerListening} from './server-startup.js';
import {decodeMultipartFilename} from './upload-filename.js';
import {
  hashFile,
  isRemotionRenderable,
  persistImmutableOriginal,
  probeAutoVideo,
  renderAutoVideoGenerationCaptioned,
  signedAutoVideoUrl,
  validateAutoVideoUpload,
  verifyAutoVideoSignature,
  autoVideoProjectArtifactPath,
  autoVideoPaths,
  autoVideoGenerationArtifactPath,
  signedAutoVideoGenerationUrl,
  verifyAutoVideoGenerationSignature,
} from './auto-video-media.js';
import {
  createTaskForUpload,
  createTaskForUrl,
  createVideoAnalysisTask,
  createVideoUploadSession,
  saveVideoUploadPart,
  validateUploadedFileSha256,
  videoPartSizeBytes,
  VideoAnalysisWorker,
} from './video-analysis.js';
import {createTranscriptionProviderRegistry} from './transcription-registry.js';
import {TranscriptionProviderError} from './transcription-provider.js';
import {resolveAutoVideoCanvas} from './auto-video-timeline.js';

const app = express();
const port = Number(process.env.PORT ?? 8787);
const root = process.cwd();
const tempUploadDir = path.join(path.resolve(process.env.DATA_ROOT ?? path.join(root, 'data')), 'tmp');
const store = new SqliteStore();

const environmentRelayConfig: RelayConfig | undefined = process.env.DEMO_MODE === 'false' && process.env.RELAY_BASE_URL && process.env.RELAY_API_KEY && process.env.RELAY_MODEL
  ? {baseUrl: process.env.RELAY_BASE_URL, apiKey: process.env.RELAY_API_KEY, model: process.env.RELAY_MODEL}
  : undefined;
const createLoggedRelay = (config: RelayConfig, tenantId: string, relayKeyId?: string) => new RelayClient(config, {
  tenantId,
  relayKeyId,
  onRecord: (record) => { store.saveModelConversation(record); },
  onProgress: (record) => { store.saveModelConversation(record); },
});
const managedRelay = (tenantId: string, keyId: string) => {
  const key = store.getRelayKey(keyId, tenantId);
  return key ? createLoggedRelay({baseUrl: key.baseUrl, apiKey: key.apiKey, model: key.model}, tenantId, key.keyId) : undefined;
};
const activeRelay = (tenantId: string) => {
  const key = store.getActiveRelayKey(tenantId);
  if (key) return {
    client: createLoggedRelay({baseUrl: key.baseUrl, apiKey: key.apiKey, model: key.model}, tenantId, key.keyId),
    keyId: key.keyId,
    connectionId: key.keyId,
    name: key.name,
    model: key.model,
  };
  return environmentRelayConfig ? {
    client: createLoggedRelay(environmentRelayConfig, tenantId),
    keyId: undefined,
    connectionId: 'environment',
    name: '服务端环境连接',
    model: environmentRelayConfig.model,
  } : undefined;
};
const generationRelay = (tenantId: string, connectionId?: string, model?: string, reasoningEffort?: AutoVideoGeneration['reasoningEffort']) => {
  if (connectionId === 'environment') return environmentRelayConfig ? createLoggedRelay({...environmentRelayConfig, model: model ?? environmentRelayConfig.model, reasoningEffort: reasoningEffort ?? 'low', retryAttempts: 1}, tenantId) : undefined;
  const key = connectionId ? store.getRelayKey(connectionId, tenantId) : undefined;
  return key ? createLoggedRelay({baseUrl: key.baseUrl, apiKey: key.apiKey, model: model ?? key.model, reasoningEffort: reasoningEffort ?? 'low', retryAttempts: 1}, tenantId, key.keyId) : undefined;
};
const worker = new JobWorker(store, (tenantId, keyId) => keyId ? managedRelay(tenantId, keyId) : environmentRelayConfig ? new RelayClient(environmentRelayConfig) : undefined);
const videoAnalysisWorker = new VideoAnalysisWorker(store, (tenantId) => activeRelay(tenantId)?.client);
// Saving a tenant Relay key from the web UI and marking it current is an
// explicit opt-in for real visual, understanding, and planning calls. The
// environment-only fallback remains opt-in through DEMO_MODE=false.
const transcriptionRegistry = createTranscriptionProviderRegistry();
const autoVideoWorker = new AutoVideoWorker(store, generationRelay, transcriptionRegistry);
let shutdownScheduled = false;

type ShutdownServiceReport = {status: 'stopped' | 'skipped' | 'warning'; message: string; code?: string; retryable?: boolean; details?: string};

const dockerExecutable = () => [
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe') : undefined,
  process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Docker', 'Docker', 'resources', 'bin', 'docker.exe') : undefined,
].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate))) ?? 'docker.exe';

const stopDockerProjectServices = () => new Promise<ShutdownServiceReport>((resolve) => {
  let finished = false;
  let stderr = '';
  const finish = (result: ShutdownServiceReport) => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    resolve(result);
  };
  const child = spawn(dockerExecutable(), ['compose', 'down', '--remove-orphans'], {cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe']});
  child.stderr?.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-8_000); });
  child.once('error', (error: NodeJS.ErrnoException) => finish(error.code === 'ENOENT'
    ? {status: 'skipped', code: error.code, message: error.message}
    : {status: 'warning', code: error.code, message: error.message}));
  child.once('exit', (code) => finish(code === 0
    ? {status: 'stopped', message: 'Docker services owned by this project were stopped.'}
    : {status: 'warning', code: `docker_compose_exit_${code ?? 'unknown'}`, message: stderr.trim() || `docker compose down exited with code ${code ?? 'unknown'}.`}));
  const timeout = setTimeout(() => {
    child.kill();
    finish({status: 'warning', code: 'docker_compose_shutdown_timeout', message: 'docker compose down did not finish within 30 seconds.', retryable: true});
  }, 30_000);
  timeout.unref();
});

const stopQwenService = async (): Promise<ShutdownServiceReport> => {
  try {
    const result = await transcriptionRegistry.shutdownServices();
    return {status: 'stopped', message: result.message};
  } catch (error) {
    const source = error instanceof Error ? error as Error & {code?: unknown; retryable?: unknown; details?: unknown} : undefined;
    return {
      status: 'warning',
      code: typeof source?.code === 'string' ? source.code : 'qwen_shutdown_failed',
      message: source?.message ?? String(error),
      ...(typeof source?.retryable === 'boolean' ? {retryable: source.retryable} : {}),
      ...(typeof source?.details === 'string' ? {details: source.details} : {}),
    };
  }
};

let shutdownWork: Promise<{qwen: ShutdownServiceReport; docker: ShutdownServiceReport}> | undefined;

const stopOwnedServices = () => shutdownWork ??= Promise.all([stopQwenService(), stopDockerProjectServices()])
  .then(([qwen, docker]) => ({qwen, docker}));

const stopDetachedWebWindow = () => new Promise<void>((resolve) => {
  const child = spawn('taskkill.exe', ['/FI', 'WINDOWTITLE eq Washcut Agent Demo - Web', '/IM', 'cmd.exe', '/T', '/F'], {
    windowsHide: true,
    stdio: 'ignore',
  });
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    resolve();
  };
  child.once('error', finish);
  child.once('exit', finish);
  const timeout = setTimeout(() => {
    child.kill();
    finish();
  }, 3_000);
  timeout.unref();
});

const closeLocalProgram = async () => {
  // In development, this server is a child of tsx watch -> concurrently. Closing
  // that parent tree also stops Vite and releases both local ports. The launcher
  // can also recover a missing web process in its own window, which is outside the
  // API tree and must be closed separately after the response reaches the browser.
  if (process.platform === 'win32' && process.ppid > 1) {
    await stopDetachedWebWindow();
    const taskkill = spawn('taskkill.exe', ['/PID', String(process.ppid), '/T', '/F'], {detached: true, stdio: 'ignore', windowsHide: true});
    taskkill.unref();
    return;
  }
  process.exit(0);
};

app.disable('x-powered-by');
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) callback(null, true);
    else callback(new Error('cors_origin_denied'));
  },
  allowedHeaders: ['content-type', 'content-range', 'content-length', 'x-part-sha256', 'x-file-sha256', 'x-tenant-id', 'x-user-id', 'x-role', 'x-project-id', 'x-job-id', 'x-trace-id', 'x-idempotency-key'],
}));
app.use(express.json({limit: '2mb', type: 'application/json'}));

const quota = new Map<string, {windowStart: number; count: number}>();
app.use('/api', (request, response, next) => {
  // Remotion streams the signed originals while rendering. These paths are
  // already HMAC-gated and must not consume the interactive API quota once per
  // media request/frame, otherwise a legitimate long render can throttle itself.
  const signedAutoVideoMedia = /^\/projects\/[^/]+\/(?:assets\/[^/]+\/original|output\.mp4|captions\.vtt)$/.test(request.path);
  if (request.path.includes('/content') || request.path.includes('/media/') || signedAutoVideoMedia) { next(); return; }
  const key = `${request.ip}:${request.headers['x-tenant-id'] ?? 'tenant_demo'}`;
  const now = Date.now();
  const current = quota.get(key);
  if (!current || now - current.windowStart > 60_000) quota.set(key, {windowStart: now, count: 1});
  else if (++current.count > 180) { response.status(429).json({error: 'rate_limit_exceeded'}); return; }
  next();
});

const upload = multer({
  dest: tempUploadDir,
  limits: {fileSize: 250 * 1024 * 1024, files: AUTO_VIDEO_MAX_ASSET_COUNT},
});
const protocolTestUpload = multer({
  dest: tempUploadDir,
  limits: {fileSize: 250 * 1024 * 1024, files: 10},
});
const chatTestUpload = multer({
  dest: tempUploadDir,
  limits: {fileSize: 15 * 1024 * 1024, files: 10},
});
const videoPartBody = express.raw({type: 'application/octet-stream', limit: Math.ceil(videoPartSizeBytes / 1024 / 1024 + 1) + 'mb'});

const contextForJob = (job: RenderJob) => ({tenantId: job.tenantId, projectId: job.projectId, jobId: job.jobId, traceId: job.traceId});
const genericError = (code: string, stage: string, message: string, retryable = false, details?: unknown): TransportError => ({code, stage, retryable, message, details});

const autoVideoError = (code: AutoVideoError['code'], message: string, retryable = false, details?: string, stage?: string, traceId?: string) => autoVideoErrorSchema.parse({
  code, message, retryable,
  ...(details !== undefined ? {details} : {}),
  ...(stage !== undefined ? {stage} : {}),
  ...(traceId !== undefined ? {traceId} : {}),
});

const sendAutoVideoError = (response: express.Response, status: number, error: ReturnType<typeof autoVideoError>) =>
  response.status(status).json({error});

const canReadAutoProject = (auth: ReturnType<typeof authFromRequest>, project: AutoVideoProject) =>
  project.tenantId === auth.tenantId && (auth.role === 'admin' || project.ownerId === auth.userId);

const activeGenerationStatuses = new Set<AutoVideoGeneration['status']>(['queued', 'analyzing', 'retry_waiting', 'planning', 'rendering']);
const externalTestOwnerPrefix = 'user_external_';
const canReadAutoGeneration = (auth: ReturnType<typeof authFromRequest>, generation: AutoVideoGeneration) =>
  generation.tenantId === auth.tenantId && (auth.role === 'admin' || generation.ownerId === auth.userId);

const canEditAutoVideoAssets = (project: AutoVideoProject) => project.status !== 'archived' && !store.hasActiveAutoVideoGeneration(project.tenantId, project.id);

const transcriptionAvailable = () => process.env.DEMO_MODE !== 'false' || Boolean(process.env.QWEN_ASR_BASE_URL && process.env.QWEN_ALIGN_BASE_URL);

const modelConnectionStatus = (tenantId: string) => {
  const connection = activeRelay(tenantId);
  if (!connection) return {
    mode: 'local' as const,
    reason: 'no_model_connection' as const,
    transcriptionAvailable: transcriptionAvailable(),
    message: '未连接模型。可以按上传顺序合成，但不会理解画面、语音或叙事。',
  };
  const health = connection.connectionId !== 'environment' ? store.getModelConnectionHealth(tenantId, connection.connectionId) : undefined;
  if (health && !health.ok) return {
    mode: 'blocked' as const,
    reason: 'connection_test_failed' as const,
    transcriptionAvailable: transcriptionAvailable(),
    activeConnection: {connectionId: connection.connectionId, name: connection.name, model: connection.model},
    message: health.message || '当前模型连接测试失败。请在模型设置中修复后再开始智能编排。',
  };
  if (!transcriptionAvailable()) return {
    mode: 'connected' as const,
    transcriptionAvailable: false,
    activeConnection: {connectionId: connection.connectionId, name: connection.name, model: connection.model},
    message: '模型连接已保存；语音转写暂未启用，将自动跳过语音分析。',
  };
  return {
    mode: 'connected' as const,
    transcriptionAvailable: true,
    activeConnection: {connectionId: connection.connectionId, name: connection.name, model: connection.model},
    message: health ? 'Model connection was tested and is ready for asset understanding and sequencing.' : 'Model connection is saved and ready for asset understanding and sequencing.',
  };
};

const getOwnedAutoProject = (request: express.Request) => {
  const auth = authFromRequest(request);
  const project = store.getAutoVideoProject(String(request.params.projectId), auth.tenantId);
  return {auth, project: project && canReadAutoProject(auth, project) ? project : undefined};
};

const getOwnedAutoGeneration = (request: express.Request) => {
  const {auth, project} = getOwnedAutoProject(request);
  const generation = project ? store.getAutoVideoGeneration(String(request.params.generationId), auth.tenantId) : undefined;
  return {auth, project, generation: generation && generation.projectId === project?.id && canReadAutoGeneration(auth, generation) ? generation : undefined};
};

const captionedOutputTasks = new Map<string, Promise<void>>();
const ensureCaptionedOutput = async (generation: AutoVideoGeneration) => {
  const outputPath = autoVideoGenerationArtifactPath(generation.projectId, generation.generationId, 'output-captioned.mp4');
  if (existsSync(outputPath)) return;
  const existing = captionedOutputTasks.get(generation.generationId);
  if (existing) return existing;
  if (!generation.timeline) throw new Error('TIMELINE_INVALID');
  const task = (async () => {
    const captionPath = autoVideoGenerationArtifactPath(generation.projectId, generation.generationId, 'captions.json');
    const rawCaptions = JSON.parse(await readFile(captionPath, 'utf8')) as unknown;
    if (!Array.isArray(rawCaptions)) throw new Error('CAPTION_GENERATION_FAILED');
    const captions = rawCaptions.map((caption) => autoCaptionSchema.parse(caption));
    await renderAutoVideoGenerationCaptioned(generation.projectId, generation.generationId, generation.timeline!, captions);
  })();
  captionedOutputTasks.set(generation.generationId, task);
  try {
    await task;
  } finally {
    captionedOutputTasks.delete(generation.generationId);
  }
};

const publicAutoVideoAsset = (asset: StoredAutoVideoAsset) => ({
  id: asset.id,
  projectId: asset.projectId,
  // Existing records created before the multipart decoding fix remain readable.
  originalName: decodeMultipartFilename(asset.originalName),
  originalUrl: signedAutoVideoUrl(asset.projectId, 'original', {assetId: asset.id}),
  mimeType: asset.mimeType,
  fileSize: asset.fileSize,
  checksum: asset.checksum,
  status: asset.status,
  metadata: asset.metadata,
  error: asset.error,
  createdAt: asset.createdAt,
});

const publicAutoVideoGeneration = (generation: AutoVideoGeneration) => ({
  ...generation,
  assetCheckpoints: store.listAutoVideoAssetCheckpoints(generation.generationId, generation.tenantId).map((checkpoint) => ({
    assetId: checkpoint.assetId,
    visualAnalysis: {
      status: checkpoint.visualAnalysis.status,
      attempts: checkpoint.visualAnalysis.attempts,
      nextRetryAt: checkpoint.visualAnalysis.nextRetryAt,
      lastError: checkpoint.visualAnalysis.lastError ? {
        code: checkpoint.visualAnalysis.lastError.code,
        message: checkpoint.visualAnalysis.lastError.message,
        retryable: checkpoint.visualAnalysis.lastError.retryable,
      } : undefined,
      completedAt: checkpoint.visualAnalysis.completedAt,
    },
  })),
  output: generation.output?.status === 'ready' ? {
    ...generation.output,
    videoUrl: generation.artifactStorage === 'legacy_project'
      ? signedAutoVideoUrl(generation.projectId, 'output')
      : signedAutoVideoGenerationUrl(generation.projectId, generation.generationId, 'output'),
    subtitleUrl: generation.artifactStorage === 'legacy_project'
      ? signedAutoVideoUrl(generation.projectId, 'captions')
      : signedAutoVideoGenerationUrl(generation.projectId, generation.generationId, 'captions'),
    captionedVideoUrl: generation.artifactStorage === 'generation'
      && existsSync(autoVideoGenerationArtifactPath(generation.projectId, generation.generationId, 'output-captioned.mp4'))
      ? signedAutoVideoGenerationUrl(generation.projectId, generation.generationId, 'captioned-output')
      : undefined,
  } : generation.output,
});

// Navigation and version history deliberately expose compact records. The
// selected project/version endpoints remain the only places that load media
// metadata, transcript/analysis payloads, timelines, or signed output links.
const publicAutoVideoGenerationSummary = (generation: AutoVideoGeneration) => ({
  generationId: generation.generationId,
  projectId: generation.projectId,
  versionNumber: generation.versionNumber,
  status: generation.status,
  progress: generation.progress,
  aiMode: generation.aiMode,
  connectionId: generation.connectionId,
  model: generation.model,
  reasoningEffort: generation.reasoningEffort,
  createdAt: generation.createdAt,
  startedAt: generation.startedAt,
  completedAt: generation.completedAt,
  updatedAt: generation.updatedAt,
});

const autoVideoProjectResponse = (project: AutoVideoProject) => {
  const generations = store.listAutoVideoGenerations(project.tenantId, project.ownerId, 'admin', project.id, 1);
  const latestGeneration = generations[0];
  return {
    id: project.id,
    tenantId: project.tenantId,
    ownerId: project.ownerId,
    name: project.name,
    userInstruction: project.userInstruction,
    status: project.status,
    canvas: project.canvas,
    assetIds: project.assetIds,
    assets: store.listAutoVideoAssets(project.tenantId, project.id).map(publicAutoVideoAsset),
    generationCount: store.countAutoVideoGenerations(project.tenantId, project.id),
    latestGeneration: latestGeneration ? publicAutoVideoGeneration(latestGeneration) : undefined,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
};

const autoVideoProjectSummary = (project: AutoVideoProject) => {
  const latestGeneration = store.getLatestAutoVideoGeneration(project.tenantId, project.ownerId, 'admin', project.id);
  return {
    id: project.id,
    name: project.name,
    status: project.status,
    generationCount: store.countAutoVideoGenerations(project.tenantId, project.id),
    latestGeneration: latestGeneration ? publicAutoVideoGenerationSummary(latestGeneration) : undefined,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
};

const refreshJobLinks = (job: RenderJob): RenderJob => renderJobSchema.parse({
  ...job,
  videoSpec: job.videoSpec ? {
    ...job.videoSpec,
    scenes: job.videoSpec.scenes.map((scene) => ({
      ...scene,
      media: {...scene.media, url: signedMediaUrl('asset', scene.assetId, scene.media.contentType.startsWith('video/') ? 'proxy' : 'original', 60 * 60)},
    })),
    audio: {
      ...job.videoSpec.audio,
      voice: job.videoSpec.audio.voice ? {...job.videoSpec.audio.voice, url: signedMediaUrl('job', job.jobId, 'voice', 60 * 60)} : undefined,
      bgm: job.videoSpec.audio.bgm ? {...job.videoSpec.audio.bgm, url: signedMediaUrl('job', job.jobId, 'bgm', 60 * 60)} : undefined,
    },
  } : undefined,
  artifacts: job.artifacts.map((artifact) => ({...artifact, downloadUrl: signedMediaUrl('job', job.jobId, artifact.kind, 60 * 60)})),
});

app.get('/api/health', (request, response) => {
  const context = contextFromHeaders(request.headers);
  const relayEnabled = Boolean(activeRelay(context.tenantId));
  sendEnvelope(response, 200, createTransportEnvelope(context, {
    type: 'health.checked', schema: 'health-status.v1',
    data: {ok: true, mode: relayEnabled ? 'relay' : 'local', service: 'washcut-agent-demo', storage: 'sqlite'},
    producer: 'business-api', idempotencyKey: `${context.jobId}:health:v1`,
  }));
});

// ---------------------------------------------------------------------------
// Automatic video orchestration API. This path deliberately does not share the
// legacy marketing-video proxy/transcode pipeline: uploaded originals are kept
// immutable and the final MP4 is a full-length Remotion concatenation.
// ---------------------------------------------------------------------------

app.post('/api/projects', (request, response) => {
  try {
    const auth = authFromRequest(request);
    if (!canMutate(auth)) { sendAutoVideoError(response, 403, autoVideoError('INVALID_UPLOAD', '当前角色无权创建项目。')); return; }
    const input = autoVideoProjectCreateSchema.parse(request.body ?? {});
    const now = new Date().toISOString();
    const project = autoVideoProjectSchema.parse({
      id: `project_${randomUUID()}`,
      tenantId: auth.tenantId,
      ownerId: auth.userId,
      name: input.name,
      userInstruction: input.userInstruction,
      status: 'draft',
      progress: 0,
      canvas: input.canvas ?? {width: 1080, height: 1920, fps: 30},
      assetIds: [],
      steps: [],
      createdAt: now,
      updatedAt: now,
    });
    store.saveAutoVideoProject(project);
    store.audit(auth.tenantId, auth.userId, 'auto-video.project.created', 'auto-video-project', project.id, {name: project.name});
    response.status(201).json(autoVideoProjectResponse(project));
  } catch (error) {
    sendAutoVideoError(response, 400, autoVideoError('INVALID_UPLOAD', '项目参数无效。', false, error instanceof Error ? error.message : undefined));
  }
});

app.get('/api/projects', (request, response) => {
  const auth = authFromRequest(request);
  response.json({projects: store.listAutoVideoProjects(auth.tenantId, auth.userId, auth.role).map(autoVideoProjectSummary)});
});

app.get('/api/admin/public-test/projects', (request, response) => {
  const auth = authFromRequest(request);
  if (auth.role !== 'admin') { sendAutoVideoError(response, 403, autoVideoError('INVALID_UPLOAD', '只有本机管理员可以读取公网测试任务监控摘要。')); return; }
  const limit = Math.max(1, Math.min(100, Number(request.query.limit) || 50));
  const projects = store.listAutoVideoProjects(auth.tenantId, auth.userId, auth.role)
    .filter((project) => project.ownerId.startsWith(externalTestOwnerPrefix))
    .slice(0, limit)
    .map((project) => {
      const generation = store.getLatestAutoVideoGeneration(project.tenantId, project.ownerId, 'admin', project.id);
      return {
        id: project.id,
        testerId: project.ownerId.slice(-8),
        name: project.name,
        assetCount: project.assetIds.length,
        latestGeneration: generation ? {
          generationId: generation.generationId,
          status: generation.status,
          progress: generation.progress,
          steps: generation.steps,
          connectionId: generation.connectionId,
          model: generation.model,
          retryState: generation.retryState,
          error: generation.error,
          output: {status: generation.output?.status ?? 'pending'},
          updatedAt: generation.updatedAt,
        } : undefined,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      };
    });
  response.json({projects});
});

app.get('/api/projects/:projectId', (request, response) => {
  const {project} = getOwnedAutoProject(request);
  if (!project) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '未找到项目。')); return; }
  response.json(autoVideoProjectResponse(project));
});

app.delete('/api/projects/:projectId', async (request, response) => {
  try {
    const {auth, project} = getOwnedAutoProject(request);
    if (!project) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '未找到项目。')); return; }
    if (!canMutate(auth)) { sendAutoVideoError(response, 403, autoVideoError('INVALID_UPLOAD', '当前角色无权删除项目。')); return; }
    if (store.hasActiveAutoVideoGeneration(auth.tenantId, project.id)) {
      sendAutoVideoError(response, 409, autoVideoError('INVALID_UPLOAD', '项目有版本正在运行，完成或中断后才能删除。', true));
      return;
    }
    if (!store.deleteAutoVideoProject(project.id, auth.tenantId, auth.role === 'admin' ? undefined : auth.userId)) {
      sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '未找到项目。'));
      return;
    }
    store.audit(auth.tenantId, auth.userId, 'auto-video.project.deleted', 'auto-video-project', project.id, {name: project.name});
    const paths = autoVideoPaths(project.id);
    await Promise.all([
      rm(paths.projectDir, {recursive: true, force: true}),
      rm(path.join(paths.originalsRoot, project.id), {recursive: true, force: true}),
      rm(path.join(paths.temporaryRoot, project.id), {recursive: true, force: true}),
    ]).catch((error) => console.error('[washcut] auto-video project artifact cleanup failed:', error));
    response.json({accepted: true});
  } catch (error) {
    if (error instanceof Error && error.message === 'auto_video_project_active') {
      sendAutoVideoError(response, 409, autoVideoError('INVALID_UPLOAD', '项目有版本正在运行，完成或中断后才能删除。', true));
      return;
    }
    sendAutoVideoError(response, 500, autoVideoError('INVALID_UPLOAD', '删除项目失败。', true, error instanceof Error ? error.message : undefined));
  }
});

app.get('/api/model-connection/status', (request, response) => {
  const auth = authFromRequest(request);
  response.json(modelConnectionStatus(auth.tenantId));
});

app.get('/api/transcription/providers', async (_request, response) => {
  response.json(await transcriptionRegistry.statusResponse());
});

app.post('/api/transcription/activate', async (request, response) => {
  try {
    const auth = authFromRequest(request);
    if (!canMutate(auth)) {
      sendAutoVideoError(response, 403, autoVideoError('TRANSCRIPTION_PROVIDER_SWITCH_FORBIDDEN', '当前角色无权切换转写模型。', false));
      return;
    }
    if (store.hasAnyActiveAutoVideoGeneration()) {
      sendAutoVideoError(response, 409, autoVideoError('TRANSCRIPTION_PROVIDER_BUSY', '有视频任务正在运行，完成或取消后才能切换转写模型。', true));
      return;
    }
    const input = transcriptionProviderActivationSchema.parse(request.body ?? {});
    const result = await transcriptionRegistry.activate(input.providerId);
    store.audit(auth.tenantId, auth.userId, 'transcription.provider.activated', 'transcription-provider', input.providerId);
    response.json(result);
  } catch (error) {
    if (error instanceof TranscriptionProviderError) {
      sendAutoVideoError(response, 409, autoVideoError(error.code, error.message, error.retryable, error.details));
      return;
    }
    sendAutoVideoError(response, 400, autoVideoError('INVALID_TRANSCRIPTION_PROVIDER', '转写模型参数无效。', false, error instanceof Error ? error.message : undefined));
  }
});

app.post('/api/transcription/deactivate', async (request, response) => {
  try {
    const auth = authFromRequest(request);
    if (!canMutate(auth)) {
      sendAutoVideoError(response, 403, autoVideoError('TRANSCRIPTION_PROVIDER_SWITCH_FORBIDDEN', '当前角色无权关闭转写模型。', false));
      return;
    }
    if (store.hasAnyActiveAutoVideoGeneration()) {
      sendAutoVideoError(response, 409, autoVideoError('TRANSCRIPTION_PROVIDER_BUSY', '有视频任务正在运行，完成或取消后才能关闭转写模型。', true));
      return;
    }
    const input = transcriptionProviderActivationSchema.parse(request.body ?? {});
    const result = await transcriptionRegistry.deactivate(input.providerId);
    store.audit(auth.tenantId, auth.userId, 'transcription.provider.deactivated', 'transcription-provider', input.providerId);
    response.json(result);
  } catch (error) {
    if (error instanceof TranscriptionProviderError) {
      sendAutoVideoError(response, 409, autoVideoError(error.code, error.message, error.retryable, error.details));
      return;
    }
    sendAutoVideoError(response, 400, autoVideoError('INVALID_TRANSCRIPTION_PROVIDER', '转写模型参数无效。', false, error instanceof Error ? error.message : undefined));
  }
});

app.patch('/api/projects/:projectId', (request, response) => {
  try {
    const {auth, project} = getOwnedAutoProject(request);
    if (!project) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '未找到项目。')); return; }
    if (!canMutate(auth)) { sendAutoVideoError(response, 403, autoVideoError('INVALID_UPLOAD', '当前角色无权修改项目。')); return; }
    if (project.status === 'archived' || store.hasActiveAutoVideoGeneration(project.tenantId, project.id)) {
      sendAutoVideoError(response, 409, autoVideoError('INVALID_UPLOAD', '当前项目有运行中的版本或已归档，暂不能修改。'));
      return;
    }
    const input = autoVideoProjectPatchSchema.parse(request.body ?? {});
    const next = store.saveAutoVideoProject({...project, ...input});
    store.audit(auth.tenantId, auth.userId, 'auto-video.project.updated', 'auto-video-project', next.id, {fields: Object.keys(input)});
    response.json(autoVideoProjectResponse(next));
  } catch (error) {
    sendAutoVideoError(response, 400, autoVideoError('INVALID_UPLOAD', '项目修改参数无效。', false, error instanceof Error ? error.message : undefined));
  }
});

app.post('/api/projects/:projectId/archive', (request, response) => {
  const {auth, project} = getOwnedAutoProject(request);
  if (!project) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '未找到项目。')); return; }
  if (!canMutate(auth)) { sendAutoVideoError(response, 403, autoVideoError('INVALID_UPLOAD', '当前角色无权归档项目。')); return; }
  const next = store.saveAutoVideoProject({...project, status: 'archived'});
  store.audit(auth.tenantId, auth.userId, 'auto-video.project.archived', 'auto-video-project', next.id);
  response.json(autoVideoProjectResponse(next));
});

app.get('/api/projects/:projectId/generations', (request, response) => {
  const {auth, project} = getOwnedAutoProject(request);
  if (!project) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '未找到项目。')); return; }
  const limit = Number(request.query.limit);
  const generations = store.listAutoVideoGenerations(auth.tenantId, auth.userId, auth.role, project.id, Number.isFinite(limit) ? limit : 50);
  response.json({generations: generations.map(publicAutoVideoGenerationSummary)});
});

app.post('/api/projects/:projectId/generations', async (request, response) => {
  try {
    const {auth, project} = getOwnedAutoProject(request);
    if (!project) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '未找到项目。')); return; }
    if (!canMutate(auth)) { sendAutoVideoError(response, 403, autoVideoError('INVALID_UPLOAD', '当前角色无权创建生成版本。')); return; }
    if (project.status === 'archived') { sendAutoVideoError(response, 409, autoVideoError('INVALID_UPLOAD', '项目已归档，不能创建新版本。')); return; }
    const input = autoVideoGenerationCreateSchema.parse(request.body ?? {});
    const idempotencyKey = typeof request.headers['x-idempotency-key'] === 'string' && request.headers['x-idempotency-key'].trim()
      ? request.headers['x-idempotency-key'].trim().slice(0, 180)
      : undefined;
    const existing = idempotencyKey ? store.getAutoVideoGenerationByIdempotency(auth.tenantId, idempotencyKey) : undefined;
    if (existing) {
      if (existing.projectId !== project.id) { sendAutoVideoError(response, 409, autoVideoError('INVALID_UPLOAD', '幂等键已用于另一个视频项目。')); return; }
      if (activeGenerationStatuses.has(existing.status)) autoVideoWorker.enqueue(existing.generationId);
      response.status(202).json({accepted: true, generation: publicAutoVideoGeneration(existing)});
      return;
    }
    if (store.hasActiveAutoVideoGeneration(project.tenantId, project.id)) {
      sendAutoVideoError(response, 409, autoVideoError('INVALID_UPLOAD', '当前项目已有运行中的生成版本，请等待完成、失败或取消后再创建。'));
      return;
    }
    const assets = store.listAutoVideoAssets(project.tenantId, project.id);
    if (!assets.length) { sendAutoVideoError(response, 409, autoVideoError('INVALID_UPLOAD', '请先上传至少一个有效视频素材。')); return; }
    const unsupported = assets.find((asset) => asset.status === 'unsupported_asset');
    if (unsupported) { sendAutoVideoError(response, 409, autoVideoError('UNSUPPORTED_ASSET', unsupported.error?.message ?? '项目包含当前无法渲染的素材。')); return; }
    if (assets.some((asset) => asset.status !== 'ready')) { sendAutoVideoError(response, 409, autoVideoError('INVALID_UPLOAD', '项目中存在未就绪素材，请替换或移除后再开始。')); return; }
    const connectionState = modelConnectionStatus(auth.tenantId);
    let aiMode: AiMode;
    if (input.mode === 'local') {
      aiMode = {kind: 'local', reason: connectionState.mode === 'local' ? 'no_model_connection' : 'user_selected_local'};
    } else {
      if (connectionState.mode !== 'connected' || !connectionState.activeConnection) {
        sendAutoVideoError(response, 409, autoVideoError('VISUAL_ANALYSIS_FAILED', connectionState.message));
        return;
      }
      const requestedConnectionId = input.connectionId ?? connectionState.activeConnection.connectionId;
      if (requestedConnectionId === 'environment') {
        aiMode = {
          kind: 'connected',
          connectionId: 'environment',
          model: input.model ?? connectionState.activeConnection.model,
        };
      } else {
        const key = store.getRelayKey(requestedConnectionId, auth.tenantId);
        if (!key) { sendAutoVideoError(response, 404, autoVideoError('VISUAL_ANALYSIS_FAILED', '未找到所选模型连接。')); return; }
        const health = store.getModelConnectionHealth(auth.tenantId, key.keyId);
        if (health && !health.ok) { sendAutoVideoError(response, 409, autoVideoError('VISUAL_ANALYSIS_FAILED', health.message)); return; }
        aiMode = {
          kind: 'connected',
          connectionId: key.keyId,
          model: input.model ?? key.model,
        };
      }
    }
    const transcriptionSnapshot = aiMode.kind === 'connected'
      ? await (async () => {
        const selection = input.transcriptionSelection ?? {providerId: 'qwen3-asr' as const};
        transcriptionRegistry.requireActive(selection.providerId);
        return transcriptionRegistry.createSnapshot(selection);
      })()
      : undefined;
    const reasoningEffort = aiMode.kind === 'connected' ? input.reasoningEffort ?? 'low' : undefined;
    const now = new Date().toISOString();
    const detailBudget = Math.max(0, Math.min(20, Math.floor(Number(process.env.AUTO_VIDEO_VISUAL_DETAIL_BUDGET ?? 6) || 6)));
    const modelConcurrency = autoVideoModelConcurrencyLimit();
    const visualConcurrency = input.visualConcurrency ?? AUTO_VIDEO_VISUAL_CONCURRENCY_DEFAULT;
    const generation = store.createAutoVideoGeneration({
      generationId: `generation_${randomUUID()}`,
      projectId: project.id,
      tenantId: auth.tenantId,
      ownerId: auth.userId,
      status: 'queued',
      progress: 0,
      aiMode,
      ...(aiMode.kind === 'connected' ? {analysisProfile: {name: 'balanced-v1' as const, sampledFramesPerAsset: 3 as const, detailBudget, modelConcurrency, visualConcurrency}} : {}),
      ...(aiMode.kind === 'connected' ? {connectionId: aiMode.connectionId, model: aiMode.model, reasoningEffort, transcriptionSnapshot} : {}),
      instructionSnapshot: input.userInstruction ?? project.userInstruction ?? '',
      // Preserve the source aspect ratio in the rendered file. The project
      // keeps its configurable fallback canvas, while each generation uses the
      // actual uploaded media dimensions as its output canvas.
      canvas: resolveAutoVideoCanvas(project.canvas, assets),
      assetIds: project.assetIds,
      steps: aiMode.kind === 'local' ? makeInitialLocalProcessingSteps() : makeInitialProcessingSteps(),
      transcripts: [],
      screenshotAnalyses: [],
      assetAnalyses: [],
      artifactStorage: 'generation',
      createdAt: now,
      updatedAt: now,
    }, idempotencyKey);
    autoVideoWorker.enqueue(generation.generationId);
    store.audit(auth.tenantId, auth.userId, 'auto-video.generation.created', 'auto-video-generation', generation.generationId, {
      projectId: project.id,
      versionNumber: generation.versionNumber,
      aiMode: generation.aiMode.kind,
      model: generation.model,
      reasoningEffort: generation.reasoningEffort,
      transcriptionProviderId: generation.transcriptionSnapshot?.providerId,
      transcriptionModel: generation.transcriptionSnapshot?.model,
      visualConcurrency: generation.analysisProfile?.name === 'balanced-v1' ? generation.analysisProfile.visualConcurrency : undefined,
    });
    response.status(202).json({accepted: true, generation: publicAutoVideoGeneration(generation)});
  } catch (error) {
    if (error instanceof TranscriptionProviderError) {
      sendAutoVideoError(response, 409, autoVideoError(error.code, error.message, error.retryable, error.details));
      return;
    }
    sendAutoVideoError(response, 400, autoVideoError('INVALID_UPLOAD', '生成版本参数无效。', false, error instanceof Error ? error.message : undefined));
  }
});

app.get('/api/projects/:projectId/generations/:generationId', (request, response) => {
  const {generation} = getOwnedAutoGeneration(request);
  if (!generation) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '未找到生成版本。')); return; }
  response.json(publicAutoVideoGeneration(generation));
});

app.delete('/api/projects/:projectId/generations/:generationId', async (request, response, next) => {
  try {
    const {auth, project, generation} = getOwnedAutoGeneration(request);
    if (!project || !generation) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '未找到生成版本。')); return; }
    if (!canMutate(auth)) { sendAutoVideoError(response, 403, autoVideoError('INVALID_UPLOAD', '当前角色无权删除生成版本。')); return; }
    if (!['completed', 'failed', 'cancelled', 'needs_attention'].includes(generation.status)) {
      sendAutoVideoError(response, 409, autoVideoError('INVALID_UPLOAD', '运行中的生成版本不能删除，请先中断任务。'));
      return;
    }
    if (!store.deleteAutoVideoGeneration(generation.generationId, auth.tenantId, project.id)) {
      sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '未找到生成版本。'));
      return;
    }
    await rm(path.dirname(autoVideoGenerationArtifactPath(project.id, generation.generationId, 'output.mp4')), {recursive: true, force: true});
    store.audit(auth.tenantId, auth.userId, 'auto-video.generation.deleted', 'auto-video-generation', generation.generationId, {projectId: project.id, versionNumber: generation.versionNumber});
    response.json({accepted: true, project: autoVideoProjectResponse(project)});
  } catch (error) {
    next(error);
  }
});

app.get('/api/projects/:projectId/generations/:generationId/progress', (request, response) => {
  const {generation} = getOwnedAutoGeneration(request);
  if (!generation) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '未找到生成版本。')); return; }
  response.json({
    projectId: generation.projectId,
    generationId: generation.generationId,
    status: generation.status,
    progress: generation.progress,
    steps: generation.steps,
    currentStep: generation.steps.find((step) => step.status === 'running')?.name
      ?? generation.steps.find((step) => step.status === 'failed')?.name,
    error: generation.error,
    retryState: generation.retryState,
    updatedAt: generation.updatedAt,
  });
});

app.patch('/api/projects/:projectId/generations/:generationId/model-connection', (request, response) => {
  try {
    const {auth, generation} = getOwnedAutoGeneration(request);
    if (!generation) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '未找到生成版本。')); return; }
    if (!canMutate(auth) || !['failed', 'cancelled', 'needs_attention'].includes(generation.status)) {
      sendAutoVideoError(response, 409, autoVideoError('INVALID_UPLOAD', '只有已停止且需要处理的生成版本才能切换模型连接。'));
      return;
    }
    const input = autoVideoGenerationConnectionPatchSchema.parse(request.body ?? {});
    const key = store.getRelayKey(input.connectionId, auth.tenantId);
    if (!key) { sendAutoVideoError(response, 404, autoVideoError('VISUAL_ANALYSIS_FAILED', '未找到所选模型连接。')); return; }
    const health = store.getModelConnectionHealth(auth.tenantId, key.keyId);
    if (health && !health.ok) {
      sendAutoVideoError(response, 409, autoVideoError('VISUAL_ANALYSIS_FAILED', health.message || '所选模型连接测试失败，请修复或重新测试后再重试。', true));
      return;
    }
    const next = store.saveAutoVideoGeneration({
      ...generation,
      aiMode: {kind: 'connected', connectionId: key.keyId, model: key.model},
      connectionId: key.keyId,
      model: key.model,
      updatedAt: new Date().toISOString(),
    });
    store.audit(auth.tenantId, auth.userId, 'auto-video.generation.connection-changed', 'auto-video-generation', next.generationId, {
      projectId: next.projectId,
      previousConnectionId: generation.connectionId,
      connectionId: key.keyId,
      model: key.model,
    });
    response.json({accepted: true, generation: publicAutoVideoGeneration(next)});
  } catch (error) {
    sendAutoVideoError(response, 400, autoVideoError('INVALID_UPLOAD', '模型连接切换参数无效。', false, error instanceof Error ? error.message : undefined));
  }
});

app.post('/api/projects/:projectId/generations/:generationId/retry', (request, response) => {
  const {auth, generation} = getOwnedAutoGeneration(request);
  if (!generation) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '未找到生成版本。')); return; }
  if (!canMutate(auth) || !['failed', 'cancelled', 'needs_attention'].includes(generation.status)) {
    sendAutoVideoError(response, 409, autoVideoError('INVALID_UPLOAD', '当前生成版本不可重试。'));
    return;
  }
  const next = store.saveAutoVideoGeneration({
    ...generation,
    status: 'queued',
    completedAt: undefined,
    error: undefined,
    output: generation.output?.status === 'failed' ? {
      ...generation.output,
      status: 'pending',
      ...(generation.output.captions === 'failed' ? {captions: 'pending' as const} : {}),
      ...(generation.output.plainRender === 'failed' ? {plainRender: 'pending' as const} : {}),
      ...(generation.output.captionedRender === 'failed' ? {captionedRender: 'pending' as const} : {}),
      ...(generation.output.inspection === 'failed' ? {inspection: 'pending' as const} : {}),
    } : generation.output,
    // A failed parallel stage can leave sibling work marked running when the
    // worker aborts. Reset only unfinished work; completed snapshots remain
    // immutable and are never sent through the pipeline again.
    steps: generation.steps.map((step) => step.status === 'failed' || step.status === 'running'
      ? {...step, status: 'pending', progress: 0, completedAt: undefined, errorCode: undefined, errorMessage: undefined}
      : step),
  });
  store.clearAutoVideoGenerationCancel(next.generationId);
  autoVideoWorker.cancelScheduledGenerationRetry(next.generationId);
  autoVideoWorker.enqueue(next.generationId);
  response.status(202).json({accepted: true, generation: publicAutoVideoGeneration(next)});
});

app.post('/api/projects/:projectId/generations/:generationId/cancel', (request, response) => {
  const {auth, generation} = getOwnedAutoGeneration(request);
  if (!generation) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '未找到生成版本。')); return; }
  const hasRunningStep = generation.steps.some((step) => step.status === 'running');
  if (!canMutate(auth) || (!activeGenerationStatuses.has(generation.status) && !hasRunningStep)) {
    sendAutoVideoError(response, 409, autoVideoError('INVALID_UPLOAD', '当前生成版本不可取消。'));
    return;
  }
  store.requestAutoVideoGenerationCancel(generation.generationId, auth.tenantId);
  autoVideoWorker.cancel(generation.generationId);
  const cancelled = store.saveAutoVideoGeneration({
    ...generation,
    status: 'cancelled',
    completedAt: new Date().toISOString(),
    error: undefined,
    retryState: {
      status: 'paused_by_user',
      totalAttempts: generation.retryState?.totalAttempts ?? 0,
      attemptsByKey: generation.retryState?.attemptsByKey ?? {},
      recoveryAttempts: generation.retryState?.recoveryAttempts ?? 0,
      lastError: generation.retryState?.lastError,
      updatedAt: new Date().toISOString(),
    },
  });
  store.audit(auth.tenantId, auth.userId, 'auto-video.generation.cancel-requested', 'auto-video-generation', generation.generationId);
  response.status(202).json({accepted: true, generation: publicAutoVideoGeneration(cancelled)});
});

app.post('/api/projects/:projectId/generations/:generationId/resume', (request, response) => {
  const {auth, generation} = getOwnedAutoGeneration(request);
  if (!generation) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '未找到生成版本。')); return; }
  if (!canMutate(auth) || !['cancelled', 'retry_waiting', 'needs_attention'].includes(generation.status)) {
    sendAutoVideoError(response, 409, autoVideoError('INVALID_UPLOAD', '当前生成版本不能从断点继续。'));
    return;
  }
  for (const checkpoint of store.listAutoVideoAssetCheckpoints(generation.generationId, generation.tenantId)) {
    if (checkpoint.visualAnalysis.status === 'completed') continue;
    store.saveAutoVideoAssetCheckpoint({...checkpoint, visualAnalysis: {
      ...checkpoint.visualAnalysis,
      status: 'pending',
      value: undefined,
      completedAt: undefined,
      lastError: undefined,
      nextRetryAt: undefined,
    }}, checkpoint.updatedAt);
  }
  const next = store.saveAutoVideoGeneration({
    ...generation,
    status: 'queued',
    completedAt: undefined,
    error: undefined,
    output: generation.output?.status === 'failed' ? {
      ...generation.output,
      status: 'pending',
      ...(generation.output.captions === 'failed' ? {captions: 'pending' as const} : {}),
      ...(generation.output.plainRender === 'failed' ? {plainRender: 'pending' as const} : {}),
      ...(generation.output.captionedRender === 'failed' ? {captionedRender: 'pending' as const} : {}),
      ...(generation.output.inspection === 'failed' ? {inspection: 'pending' as const} : {}),
    } : generation.output,
    // Manual continuation starts a new, user-authorized recovery round. The
    // completed checkpoints above remain intact, while retry budgets reset.
    retryState: {status: 'none', totalAttempts: 0, attemptsByKey: {}, recoveryAttempts: 0, updatedAt: new Date().toISOString()},
    steps: generation.steps.map((step) => step.status === 'failed' || step.status === 'running'
      ? {...step, status: 'pending', progress: 0, completedAt: undefined, errorCode: undefined, errorMessage: undefined}
      : step),
  });
  store.clearAutoVideoGenerationCancel(next.generationId);
  autoVideoWorker.cancelScheduledGenerationRetry(next.generationId);
  autoVideoWorker.enqueue(next.generationId);
  store.audit(auth.tenantId, auth.userId, 'auto-video.generation.resumed', 'auto-video-generation', next.generationId);
  response.status(202).json({accepted: true, generation: publicAutoVideoGeneration(next)});
});

app.get('/api/projects/:projectId/generations/:generationId/output', (request, response) => {
  const {generation} = getOwnedAutoGeneration(request);
  if (!generation) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '未找到生成版本。')); return; }
  if (generation.output?.status !== 'ready') { response.status(202).json({status: generation.output?.status ?? 'pending'}); return; }
  response.json(publicAutoVideoGeneration(generation).output);
});

app.post('/api/projects/:projectId/generations/:generationId/output-captioned', async (request, response) => {
  const {generation} = getOwnedAutoGeneration(request);
  if (!generation || generation.output?.status !== 'ready' || generation.artifactStorage !== 'generation') {
    sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '未找到可生成字幕下载版的成片。'));
    return;
  }
  try {
    await ensureCaptionedOutput(generation);
    response.json({videoUrl: signedAutoVideoGenerationUrl(generation.projectId, generation.generationId, 'captioned-output')});
  } catch (error) {
    sendAutoVideoError(response, 500, toAutoVideoError(error));
  }
});

app.post('/api/projects/:projectId/assets', upload.array('files', AUTO_VIDEO_MAX_ASSET_COUNT), async (request, response, next) => {
  const files = (request.files ?? []) as Express.Multer.File[];
  const persistedAssets: StoredAutoVideoAsset[] = [];
  try {
    const {auth, project: owned} = getOwnedAutoProject(request);
    if (!owned) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '未找到项目。')); return; }
    if (!canMutate(auth)) { sendAutoVideoError(response, 403, autoVideoError('INVALID_UPLOAD', '当前角色无权上传素材。')); return; }
    if (!canEditAutoVideoAssets(owned)) { sendAutoVideoError(response, 409, autoVideoError('INVALID_UPLOAD', '项目已归档或存在运行中的生成版本，暂不能修改素材。')); return; }
    if (!files.length) { sendAutoVideoError(response, 400, autoVideoError('INVALID_UPLOAD', '至少选择一个视频文件。')); return; }
    const remainingAssetCount = AUTO_VIDEO_MAX_ASSET_COUNT - owned.assetIds.length;
    if (files.length > remainingAssetCount) {
      await Promise.all(files.map((file) => rm(file.path, {force: true}).catch(() => undefined)));
      sendAutoVideoError(response, 400, autoVideoError('INVALID_UPLOAD', `每个项目最多上传 ${AUTO_VIDEO_MAX_ASSET_COUNT} 个素材，当前还可添加 ${Math.max(0, remainingAssetCount)} 个。`));
      return;
    }
    // Two-phase batch upload: inspect every temporary file first. No project
    // or asset row is changed until every file passes validation and probing.
    const staged: Array<{file: Express.Multer.File; assetId: string; originalName: string; mimeType: string; checksum: string; metadata: Awaited<ReturnType<typeof probeAutoVideo>>}> = [];
    for (const file of files) {
      const originalName = decodeMultipartFilename(file.originalname);
      const mimeType = await validateAutoVideoUpload(file.path, file.mimetype, originalName);
      const checksum = await hashFile(file.path);
      const assetId = `asset_${randomUUID()}`;
      const metadata = await probeAutoVideo(assetId, file.path);
      if (!isRemotionRenderable(metadata)) throw new Error(`UNSUPPORTED_ASSET:${metadata.videoCodec}`);
      staged.push({file, assetId, originalName, mimeType, checksum, metadata});
    }
    const project = owned;
    const assets: StoredAutoVideoAsset[] = [];
    const now = new Date().toISOString();
    for (const item of staged) {
      const assetId = item.assetId;
      const originalPath = await persistImmutableOriginal({tempPath: item.file.path, projectId: project.id, assetId, mimeType: item.mimeType, originalName: item.originalName});
      const asset: StoredAutoVideoAsset = {
        id: assetId,
        tenantId: auth.tenantId,
        ownerId: auth.userId,
        projectId: project.id,
        originalName: path.basename(item.originalName),
        mimeType: item.mimeType,
        fileSize: item.file.size,
        checksum: item.checksum,
        status: 'ready',
        originalPath,
        metadata: item.metadata,
        screenshots: [],
        createdAt: now,
      };
      persistedAssets.push(asset);
      assets.push(asset);
    }
    const savedProject = store.saveAutoVideoAssetsBatch({...project, assetIds: [...project.assetIds, ...assets.map((asset) => asset.id)], status: 'ready'}, assets);
    for (const asset of assets) store.audit(auth.tenantId, auth.userId, 'auto-video.asset.uploaded', 'auto-video-asset', asset.id, {checksum: asset.checksum, status: asset.status, fileSize: asset.fileSize});
    response.status(201).json({assets: assets.map(publicAutoVideoAsset), project: autoVideoProjectResponse(savedProject)});
  } catch (error) {
    await Promise.all(files.map((file) => rm(file.path, {force: true}).catch(() => undefined)));
    await Promise.all(persistedAssets.map(async (asset) => {
      store.deleteAutoVideoAsset(asset.id, asset.tenantId, asset.projectId);
      await rm(path.dirname(asset.originalPath), {recursive: true, force: true}).catch(() => undefined);
    }));
    if (error instanceof Error && error.message === 'INVALID_UPLOAD') {
      sendAutoVideoError(response, 400, autoVideoError('INVALID_UPLOAD', '仅支持可验证的 MP4、WebM 或 MOV 视频文件。'));
      return;
    }
    if (error instanceof Error && error.message.startsWith('UNSUPPORTED_ASSET')) {
      sendAutoVideoError(response, 400, autoVideoError('UNSUPPORTED_ASSET', '批次中包含当前渲染环境不支持的编码，所有素材均未提交。', false, error.message));
      return;
    }
    if (error instanceof Error && /MEDIA_PROBE_FAILED|NO_VIDEO_STREAM/.test(error.message)) {
      sendAutoVideoError(response, 400, autoVideoError('MEDIA_PROBE_FAILED', '视频媒体信息无法读取，所有素材均未提交。', false, error.message));
      return;
    }
    next(error);
  }
});

app.get('/api/projects/:projectId/assets', (request, response) => {
  const {project} = getOwnedAutoProject(request);
  if (!project) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '未找到项目。')); return; }
  response.json({assets: store.listAutoVideoAssets(project.tenantId, project.id).map(publicAutoVideoAsset)});
});

app.delete('/api/projects/:projectId/assets/:assetId', async (request, response, next) => {
  try {
    const {auth, project: owned} = getOwnedAutoProject(request);
    if (!owned) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '未找到项目。')); return; }
    if (!canMutate(auth)) { sendAutoVideoError(response, 403, autoVideoError('INVALID_UPLOAD', '当前角色无权删除素材。')); return; }
    if (!canEditAutoVideoAssets(owned)) {
      sendAutoVideoError(response, 409, autoVideoError('INVALID_UPLOAD', '项目已归档或存在运行中的生成版本，暂不能删除素材。'));
      return;
    }

    // Re-read immediately before changing state so two delete requests cannot
    // restore a previously removed asset ID in the project record.
    const project = store.getAutoVideoProject(owned.id, auth.tenantId);
    if (!project || !canReadAutoProject(auth, project)) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '未找到项目。')); return; }
    if (!canEditAutoVideoAssets(project)) {
      sendAutoVideoError(response, 409, autoVideoError('INVALID_UPLOAD', '项目已归档或存在运行中的生成版本，暂不能删除素材。'));
      return;
    }
    const asset = store.getAutoVideoAsset(String(request.params.assetId), auth.tenantId);
    if (!asset || asset.projectId !== project.id) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '未找到素材。')); return; }
    if (store.isAutoVideoAssetReferencedByGeneration(project.tenantId, project.id, asset.id)) {
      sendAutoVideoError(response, 409, autoVideoError('INVALID_UPLOAD', '该素材已被生成版本快照引用。为保护历史版本，不能移除。'));
      return;
    }
    if (!store.deleteAutoVideoAsset(asset.id, auth.tenantId, project.id)) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '未找到素材。')); return; }

    const assetIds = project.assetIds.filter((assetId) => assetId !== asset.id);
    const nextProject = store.saveAutoVideoProject({
      ...project,
      assetIds,
      status: assetIds.length ? 'ready' : 'draft',
      progress: 0,
      steps: [],
      transcripts: [],
      screenshotAnalyses: [],
      assetAnalyses: [],
      editPlan: undefined,
      timeline: undefined,
      output: undefined,
      error: undefined,
    });

    // The immutable original is scoped to this project and can be removed with
    // its asset when no generation references it.
    store.audit(auth.tenantId, auth.userId, 'auto-video.asset.deleted', 'auto-video-asset', asset.id, {projectId: project.id, originalName: asset.originalName});
    response.json({accepted: true, project: autoVideoProjectResponse(nextProject)});
  } catch (error) {
    next(error);
  }
});

app.post('/api/projects/:projectId/process', (request, response) => {
  const {project} = getOwnedAutoProject(request);
  if (!project) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '未找到项目。')); return; }
  sendAutoVideoError(response, 410, autoVideoError('INVALID_UPLOAD', '项目级处理接口已升级。请使用 /generations 创建独立生成版本。'));
});

app.post('/api/projects/:projectId/retry', (request, response) => {
  const {project} = getOwnedAutoProject(request);
  if (!project) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '未找到项目。')); return; }
  sendAutoVideoError(response, 410, autoVideoError('INVALID_UPLOAD', '项目级重试接口已升级。请对失败的生成版本使用 /generations/:generationId/retry。'));
});

app.get('/api/projects/:projectId/progress', (request, response) => {
  const {project} = getOwnedAutoProject(request);
  if (!project) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '未找到项目。')); return; }
  response.json({projectId: project.id, status: project.status, progress: project.progress, steps: project.steps, error: project.error});
});

app.get('/api/projects/:projectId/analysis', (request, response) => {
  const {project} = getOwnedAutoProject(request);
  if (!project) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '未找到项目。')); return; }
  response.json({projectId: project.id, transcripts: project.transcripts, screenshots: project.screenshotAnalyses, assets: project.assetAnalyses});
});

app.get('/api/projects/:projectId/edit-plan', (request, response) => {
  const {project} = getOwnedAutoProject(request);
  if (!project?.editPlan) { sendAutoVideoError(response, 404, autoVideoError('EDIT_PLAN_INVALID', '项目尚未生成编排计划。')); return; }
  response.json(project.editPlan);
});

app.get('/api/projects/:projectId/timeline', (request, response) => {
  const {project} = getOwnedAutoProject(request);
  if (!project?.timeline) { sendAutoVideoError(response, 404, autoVideoError('TIMELINE_INVALID', '项目尚未生成时间线。')); return; }
  response.json(project.timeline);
});

app.post('/api/projects/:projectId/render', (request, response) => {
  const {project} = getOwnedAutoProject(request);
  if (!project) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '未找到项目。')); return; }
  sendAutoVideoError(response, 410, autoVideoError('TIMELINE_INVALID', '渲染已包含在生成版本中；请创建或查看 /generations。'));
});

app.get('/api/render-jobs/:renderJobId', (request, response) => {
  const auth = authFromRequest(request);
  const project = store.getAutoVideoProject(request.params.renderJobId, auth.tenantId);
  if (!project || !canReadAutoProject(auth, project)) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '未找到渲染任务。')); return; }
  response.json({renderJobId: project.id, status: project.status, progress: project.progress, error: project.error});
});

app.get('/api/projects/:projectId/output', (request, response) => {
  const {auth, project} = getOwnedAutoProject(request);
  if (!project) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '未找到项目。')); return; }
  const generation = store.getLatestAutoVideoGeneration(auth.tenantId, auth.userId, auth.role, project.id);
  if (!generation?.output || generation.output.status !== 'ready') { response.status(202).json({status: generation?.output?.status ?? 'pending'}); return; }
  response.json(publicAutoVideoGeneration(generation).output);
});

app.get('/api/projects/:projectId/assets/:assetId/original', (request, response) => {
  if (!verifyAutoVideoSignature(request.params.projectId, 'original', request.query.expires, request.query.signature, request.params.assetId)) { response.sendStatus(403); return; }
  const asset = store.getAutoVideoAsset(request.params.assetId);
  if (!asset || asset.projectId !== request.params.projectId) { response.sendStatus(404); return; }
  response.setHeader('cache-control', 'private, max-age=300');
  response.type(asset.mimeType).sendFile(asset.originalPath);
});

app.get('/api/projects/:projectId/generations/:generationId/output.mp4', (request, response) => {
  if (!verifyAutoVideoGenerationSignature(request.params.projectId, request.params.generationId, 'output', request.query.expires, request.query.signature)) { response.sendStatus(403); return; }
  const generation = store.getAutoVideoGeneration(request.params.generationId);
  const project = store.getAutoVideoProject(request.params.projectId);
  if (!generation || !project || generation.projectId !== project.id || generation.output?.status !== 'ready' || generation.artifactStorage !== 'generation') { response.sendStatus(404); return; }
  response.setHeader('cache-control', 'private, max-age=300');
  const displayName = `${project.name.replace(/[\r\n"]/g, '').slice(0, 80) || 'output'}-V${generation.versionNumber}.mp4`;
  response.setHeader('content-disposition', 'attachment; filename="output.mp4"; filename*=UTF-8' + "''" + encodeURIComponent(displayName));
  response.type('video/mp4').sendFile(autoVideoGenerationArtifactPath(project.id, generation.generationId, 'output.mp4'));
});

app.get('/api/projects/:projectId/generations/:generationId/output-captioned.mp4', (request, response) => {
  if (!verifyAutoVideoGenerationSignature(request.params.projectId, request.params.generationId, 'captioned-output', request.query.expires, request.query.signature)) { response.sendStatus(403); return; }
  const generation = store.getAutoVideoGeneration(request.params.generationId);
  const project = store.getAutoVideoProject(request.params.projectId);
  const outputPath = autoVideoGenerationArtifactPath(request.params.projectId, request.params.generationId, 'output-captioned.mp4');
  if (!generation || !project || generation.projectId !== project.id || generation.output?.status !== 'ready' || generation.artifactStorage !== 'generation' || !existsSync(outputPath)) { response.sendStatus(404); return; }
  response.setHeader('cache-control', 'private, max-age=300');
  const displayName = `${project.name.replace(/[\r\n"]/g, '').slice(0, 80) || 'output'}-V${generation.versionNumber}-带字幕.mp4`;
  response.setHeader('content-disposition', 'attachment; filename="output-captioned.mp4"; filename*=UTF-8' + "''" + encodeURIComponent(displayName));
  response.type('video/mp4').sendFile(outputPath);
});

app.get('/api/projects/:projectId/generations/:generationId/captions.vtt', (request, response) => {
  if (!verifyAutoVideoGenerationSignature(request.params.projectId, request.params.generationId, 'captions', request.query.expires, request.query.signature)) { response.sendStatus(403); return; }
  const generation = store.getAutoVideoGeneration(request.params.generationId);
  if (!generation || generation.projectId !== request.params.projectId || generation.output?.status !== 'ready' || generation.artifactStorage !== 'generation') { response.sendStatus(404); return; }
  response.setHeader('cache-control', 'private, max-age=300');
  response.type('text/vtt; charset=utf-8').sendFile(autoVideoGenerationArtifactPath(generation.projectId, generation.generationId, 'captions.vtt'));
});

app.get('/api/projects/:projectId/output.mp4', (request, response) => {
  if (!verifyAutoVideoSignature(request.params.projectId, 'output', request.query.expires, request.query.signature)) { response.sendStatus(403); return; }
  const project = store.getAutoVideoProject(request.params.projectId);
  const generation = project ? store.listAutoVideoGenerations(project.tenantId, project.ownerId, 'admin', project.id, 100).find((candidate) => candidate.output?.status === 'ready') : undefined;
  if (!project || !generation) { response.sendStatus(404); return; }
  response.setHeader('cache-control', 'private, max-age=300');
  const displayName = `${project.name.replace(/[\r\n"]/g, '').slice(0, 80) || 'output'}.mp4`;
  response.setHeader('content-disposition', 'attachment; filename="output.mp4"; filename*=UTF-8' + "''" + encodeURIComponent(displayName));
  response.type('video/mp4').sendFile(generation.artifactStorage === 'legacy_project'
    ? autoVideoProjectArtifactPath(project.id, 'output.mp4')
    : autoVideoGenerationArtifactPath(project.id, generation.generationId, 'output.mp4'));
});

app.get('/api/projects/:projectId/captions.vtt', (request, response) => {
  if (!verifyAutoVideoSignature(request.params.projectId, 'captions', request.query.expires, request.query.signature)) { response.sendStatus(403); return; }
  const project = store.getAutoVideoProject(request.params.projectId);
  const generation = project ? store.listAutoVideoGenerations(project.tenantId, project.ownerId, 'admin', project.id, 100).find((candidate) => candidate.output?.status === 'ready') : undefined;
  if (!project || !generation) { response.sendStatus(404); return; }
  response.setHeader('cache-control', 'private, max-age=300');
  response.type('text/vtt; charset=utf-8').sendFile(generation.artifactStorage === 'legacy_project'
    ? autoVideoProjectArtifactPath(project.id, 'captions.vtt')
    : autoVideoGenerationArtifactPath(project.id, generation.generationId, 'captions.vtt'));
});

app.post('/api/v1/video/analyze', upload.single('file'), async (request, response, next) => {
  const context = contextFromHeaders(request.headers);
  const file = request.file;
  try {
    const auth = authFromRequest(request);
    if (!canMutate(auth)) { sendTransportError(response, 403, context, genericError('forbidden', 'video_upload', '当前角色无权上传并分析视频。')); return; }
    if (!file) { sendTransportError(response, 400, context, genericError('video_file_required', 'video_upload', '请选择一个视频文件。')); return; }
    const prompt = typeof request.body.prompt === 'string' && request.body.prompt.trim() ? request.body.prompt.trim().slice(0, 4_000) : '提取字幕，并按时间轴总结关键动作';
    const language = typeof request.body.language === 'string' && request.body.language.trim() ? request.body.language.trim().slice(0, 32) : 'zh-CN';
    const callbackUrl = typeof request.body.callback_url === 'string' && request.body.callback_url.trim() ? request.body.callback_url.trim() : undefined;
    const idempotencyKey = String(request.headers['x-idempotency-key'] ?? request.body.idempotency_key ?? '').trim() || undefined;
    const expectedSha256 = String(request.headers['x-file-sha256'] ?? request.body.sha256 ?? '').trim() || undefined;
    const existing = idempotencyKey ? store.getVideoAnalysisTaskByIdempotency(auth.tenantId, idempotencyKey) : undefined;
    if (existing) {
      await rm(file.path, {force: true});
      sendEnvelope(response, 200, createTransportEnvelope(context, {
        type: 'video-analysis.accepted', schema: 'video-analysis-task.v1', data: existing, producer: 'business-api', idempotencyKey: idempotencyKey ?? `${existing.task_id}:create`,
      }));
      return;
    }
    await validateUploadedFileSha256(file.path, expectedSha256);
    const assetId = newTransportId('ast');
    const asset = await processUploadedMedia({
      tempPath: file.path, originalName: decodeMultipartFilename(file.originalname), claimedType: file.mimetype, sizeBytes: file.size,
      tenantId: auth.tenantId, projectId: context.projectId, ownerId: auth.userId, assetId,
    });
    store.saveAsset(asset);
    const task = await createVideoAnalysisTask(store, {auth, projectId: context.projectId, traceId: context.traceId, assetId, prompt, language, callbackUrl, idempotencyKey});
    store.audit(auth.tenantId, auth.userId, 'video.analysis.created', 'video-analysis-task', task.task_id, {assetId, source: 'multipart'});
    videoAnalysisWorker.enqueue(task.task_id);
    sendEnvelope(response, 202, createTransportEnvelope(context, {
      type: 'video-analysis.accepted', schema: 'video-analysis-task.v1', data: task, producer: 'business-api', idempotencyKey: idempotencyKey ?? `${task.task_id}:create`,
    }));
  } catch (error) {
    if (file) await rm(file.path, {force: true}).catch(() => undefined);
    next(error);
  }
});

app.post('/api/v1/video/uploads', async (request, response) => {
  const context = contextFromHeaders(request.headers);
  try {
    const auth = authFromRequest(request);
    if (!canMutate(auth)) { sendTransportError(response, 403, context, genericError('forbidden', 'video_upload', '当前角色无权创建上传会话。')); return; }
    const parsed = videoUploadCreateSchema.parse({...request.body, idempotency_key: request.body?.idempotency_key ?? request.headers['x-idempotency-key']});
    const session = createVideoUploadSession(store, auth, context.projectId, parsed);
    sendEnvelope(response, 201, createTransportEnvelope(context, {
      type: 'video-upload.created', schema: 'video-upload-session.v1', data: session, producer: 'business-api', idempotencyKey: parsed.idempotency_key ?? `${session.upload_id}:create`,
    }));
  } catch (error) {
    sendTransportError(response, 400, context, genericError('video_upload_invalid', 'video_upload', '上传会话参数无效。', false, error instanceof Error ? error.message : 'unknown_error'));
  }
});

app.put('/api/v1/video/uploads/:uploadId/parts/:partNumber', videoPartBody, async (request, response) => {
  const context = contextFromHeaders(request.headers);
  try {
    const auth = authFromRequest(request);
    if (!canMutate(auth)) { sendTransportError(response, 403, context, genericError('forbidden', 'video_upload', '当前角色无权上传分片。')); return; }
    const session = store.getVideoUpload(request.params.uploadId, auth.tenantId, auth.role === 'admin' ? undefined : auth.userId);
    if (!session) { sendTransportError(response, 404, context, genericError('upload_not_found', 'video_upload', '未找到上传会话。')); return; }
    if (!Buffer.isBuffer(request.body)) throw new Error('upload_part_body_required');
    const nextSession = await saveVideoUploadPart(store, session, Number(request.params.partNumber), request.body, String(request.headers['content-range'] ?? ''), String(request.headers['x-part-sha256'] ?? ''));
    sendEnvelope(response, 200, createTransportEnvelope(context, {
      type: 'video-upload.part-completed', schema: 'video-upload-session.v1', data: nextSession, producer: 'business-api', idempotencyKey: `${session.upload_id}:part:${request.params.partNumber}:${request.headers['x-part-sha256']}`,
    }));
  } catch (error) {
    sendTransportError(response, 400, context, genericError(error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : 'upload_part_failed', 'video_upload', '视频分片校验失败。', false, error instanceof Error ? error.message : 'unknown_error'));
  }
});

app.get('/api/v1/video/uploads/:uploadId', (request, response) => {
  const context = contextFromHeaders(request.headers);
  const auth = authFromRequest(request);
  const session = store.getVideoUpload(request.params.uploadId, auth.tenantId, auth.role === 'admin' ? undefined : auth.userId);
  if (!session) { sendTransportError(response, 404, context, genericError('upload_not_found', 'video_upload', '未找到上传会话。')); return; }
  sendEnvelope(response, 200, createTransportEnvelope(context, {
    type: 'video-upload.fetched', schema: 'video-upload-session.v1', data: session, producer: 'business-api', idempotencyKey: `${session.upload_id}:fetch:${session.updated_at}`,
  }));
});

app.post('/api/v1/video/uploads/:uploadId/complete', async (request, response) => {
  const context = contextFromHeaders(request.headers);
  try {
    const auth = authFromRequest(request);
    if (!canMutate(auth)) { sendTransportError(response, 403, context, genericError('forbidden', 'video_upload', '当前角色无权完成上传。')); return; }
    const session = store.getVideoUpload(request.params.uploadId, auth.tenantId, auth.role === 'admin' ? undefined : auth.userId);
    if (!session) { sendTransportError(response, 404, context, genericError('upload_not_found', 'video_upload', '未找到上传会话。')); return; }
    const task = await createTaskForUpload(store, session, auth, context.traceId);
    store.audit(auth.tenantId, auth.userId, 'video.analysis.created', 'video-analysis-task', task.task_id, {uploadId: session.upload_id, source: 'multipart-parts'});
    videoAnalysisWorker.enqueue(task.task_id);
    sendEnvelope(response, 202, createTransportEnvelope(context, {
      type: 'video-analysis.accepted', schema: 'video-analysis-task.v1', data: task, producer: 'business-api', idempotencyKey: `${session.upload_id}:complete`,
    }));
  } catch (error) {
    sendTransportError(response, 400, context, genericError(error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : 'upload_complete_failed', 'video_upload', '上传尚未满足完成条件。', false, error instanceof Error ? error.message : 'unknown_error'));
  }
});

app.post('/api/v1/video/analyze-url', async (request, response) => {
  const context = contextFromHeaders(request.headers);
  try {
    const auth = authFromRequest(request);
    if (!canMutate(auth)) { sendTransportError(response, 403, context, genericError('forbidden', 'video_url_import', '当前角色无权导入视频 URL。')); return; }
    const parsed = videoUrlImportSchema.parse({...request.body, idempotency_key: request.body?.idempotency_key ?? request.headers['x-idempotency-key']});
    const task = await createTaskForUrl(store, parsed, auth, context.projectId, context.traceId);
    store.audit(auth.tenantId, auth.userId, 'video.analysis.created', 'video-analysis-task', task.task_id, {source: 'url', host: new URL(parsed.video_url).host});
    videoAnalysisWorker.enqueue(task.task_id);
    sendEnvelope(response, 202, createTransportEnvelope(context, {
      type: 'video-analysis.accepted', schema: 'video-analysis-task.v1', data: task, producer: 'business-api', idempotencyKey: parsed.idempotency_key ?? `${task.task_id}:create`,
    }));
  } catch (error) {
    sendTransportError(response, 400, context, genericError(error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : 'video_url_invalid', 'video_url_import', '视频 URL 未通过格式或安全校验。', false, error instanceof Error ? error.message : 'unknown_error'));
  }
});

app.get('/api/v1/video/tasks/:taskId', (request, response) => {
  const context = contextFromHeaders(request.headers);
  const auth = authFromRequest(request);
  const task = store.getVideoAnalysisTask(request.params.taskId, auth.tenantId);
  if (!task || (auth.role !== 'admin' && task.owner_id !== auth.userId)) { sendTransportError(response, 404, context, genericError('video_task_not_found', 'video_analysis', '未找到分析任务。')); return; }
  sendEnvelope(response, 200, createTransportEnvelope(context, {
    type: 'video-analysis.fetched', schema: 'video-analysis-task.v1', data: task, producer: 'business-api', idempotencyKey: `${task.task_id}:fetch:${task.updated_at}`,
  }));
});

app.post('/api/v1/video/tasks/:taskId/cancel', (request, response) => {
  const context = contextFromHeaders(request.headers);
  const auth = authFromRequest(request);
  const task = store.getVideoAnalysisTask(request.params.taskId, auth.tenantId);
  if (!task || (auth.role !== 'admin' && task.owner_id !== auth.userId)) { sendTransportError(response, 404, context, genericError('video_task_not_found', 'video_analysis', '未找到分析任务。')); return; }
  if (!canMutate(auth) || ['completed', 'failed', 'cancelled'].includes(task.status)) { sendTransportError(response, 409, context, genericError('video_task_not_cancellable', 'video_analysis', '当前任务状态不可取消。')); return; }
  store.requestVideoAnalysisCancel(task.task_id, auth.tenantId);
  videoAnalysisWorker.cancel(task.task_id);
  sendEnvelope(response, 202, createTransportEnvelope(context, {
    type: 'video-analysis.cancel-accepted', schema: 'command-result.v1', data: {accepted: true}, producer: 'business-api', idempotencyKey: `${task.task_id}:cancel`,
  }));
});

app.post('/api/v1/video/tasks/:taskId/retry', (request, response) => {
  const context = contextFromHeaders(request.headers);
  const auth = authFromRequest(request);
  const task = store.getVideoAnalysisTask(request.params.taskId, auth.tenantId);
  if (!task || (auth.role !== 'admin' && task.owner_id !== auth.userId)) { sendTransportError(response, 404, context, genericError('video_task_not_found', 'video_analysis', '未找到分析任务。')); return; }
  if (!canMutate(auth) || task.status !== 'failed' || task.error?.retryable === false) { sendTransportError(response, 409, context, genericError('video_task_not_retryable', 'video_analysis', '当前任务不可重试。')); return; }
  const next = videoAnalysisTaskSchema.parse({...task, status: 'queued', current_stage: 'queued', progress: 0, result: undefined, error: undefined, updated_at: new Date().toISOString()});
  store.clearVideoAnalysisCancel(task.task_id);
  store.saveVideoAnalysisTask(next);
  videoAnalysisWorker.enqueue(task.task_id);
  sendEnvelope(response, 202, createTransportEnvelope(context, {
    type: 'video-analysis.retry-accepted', schema: 'video-analysis-task.v1', data: next, producer: 'business-api', idempotencyKey: `${task.task_id}:retry:${next.updated_at}`,
  }));
});

app.post('/api/system/shutdown', async (request, response) => {
  const auth = authFromRequest(request);
  const context = contextFromHeaders(request.headers);
  const remoteAddress = request.socket.remoteAddress ?? '';
  const localRequest = remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1';
  if (!localRequest || !canMutate(auth)) {
    sendTransportError(response, 403, context, genericError('forbidden', 'system_control', '仅本机有权限的用户可以关闭程序。'));
    return;
  }
  const activeTasksWillResume = store.hasAnyActiveAutoVideoGeneration();
  if (!shutdownScheduled) {
    shutdownScheduled = true;
    console.log('[washcut] Safe local shutdown requested from the web app.');
  }
  const services = await stopOwnedServices();
  response.once('finish', () => setTimeout(closeLocalProgram, 800).unref());
  sendEnvelope(response, 202, createTransportEnvelope(context, {
    type: 'system.shutdown-accepted', schema: 'command-result.v1', data: {accepted: true, activeTasksWillResume, services}, producer: 'business-api',
    idempotencyKey: `${context.jobId}:system-shutdown`,
  }));
});

const assertRelayBaseUrl = (baseUrl: string) => {
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('relay_url_protocol_invalid');
  normalizeResponsesUrl(url.toString());
  return url.toString();
};

app.get('/api/keys', (request, response) => {
  const auth = authFromRequest(request);
  const context = contextFromHeaders(request.headers);
  const keys = store.listRelayKeys(auth.tenantId);
  sendEnvelope(response, 200, createTransportEnvelope(context, {
    type: 'relay-keys.fetched', schema: 'relay-key-batch.v1', data: {keys}, producer: 'business-api',
    idempotencyKey: `${context.jobId}:relay-key-list:${keys[0]?.updatedAt ?? 'empty'}`,
  }));
});

app.post('/api/keys', (request, response) => {
  const auth = authFromRequest(request);
  const context = contextFromHeaders(request.headers);
  if (!canMutate(auth)) { sendTransportError(response, 403, context, genericError('forbidden', 'key_management', '当前角色无权添加 Key。')); return; }
  const input = relayKeyInputSchema.parse(request.body);
  const now = new Date().toISOString();
  const stored = store.saveRelayKey({
    keyId: `key_${randomUUID()}`, tenantId: auth.tenantId, name: input.name,
    baseUrl: assertRelayBaseUrl(input.baseUrl), apiKey: input.apiKey, model: input.model,
    active: input.active ?? false, createdAt: now, updatedAt: now,
  });
  const key = store.relayKeySummary(stored);
  store.audit(auth.tenantId, auth.userId, 'relay-key.created', 'relay-key', key.keyId, {name: key.name, baseUrl: key.baseUrl, model: key.model, active: key.active});
  sendEnvelope(response, 201, createTransportEnvelope(context, {
    type: 'relay-key.created', schema: 'relay-key.v1', data: key, producer: 'business-api', idempotencyKey: `${context.jobId}:relay-key:create:${key.keyId}`,
  }));
});

app.post('/api/keys/models', async (request, response) => {
  const auth = authFromRequest(request);
  const context = contextFromHeaders(request.headers);
  if (!canMutate(auth)) { sendTransportError(response, 403, context, genericError('forbidden', 'key_management', '当前角色无权获取模型列表。')); return; }
  const input = relayModelDiscoveryInputSchema.parse(request.body);
  const stored = input.keyId ? store.getRelayKey(input.keyId, auth.tenantId) : undefined;
  if (input.keyId && !stored) { sendTransportError(response, 404, context, genericError('relay_key_not_found', 'key_management', '未找到指定 Key。')); return; }
  const apiKey = input.apiKey ?? stored?.apiKey;
  if (!apiKey) { sendTransportError(response, 400, context, genericError('relay_api_key_required', 'key_management', '请先填写 API Key。')); return; }
  try {
    const models = await new RelayClient({baseUrl: assertRelayBaseUrl(input.baseUrl), apiKey, model: stored?.model ?? 'model-discovery', timeoutMs: 30_000}).listModels();
    store.audit(auth.tenantId, auth.userId, 'relay-key.models-fetched', 'relay-key', input.keyId ?? 'unsaved', {baseUrl: input.baseUrl, modelCount: models.length});
    sendEnvelope(response, 200, createTransportEnvelope(context, {
      type: 'relay-models.fetched', schema: 'relay-model-list.v1', data: {models}, producer: 'business-api',
      idempotencyKey: `${context.jobId}:relay-models:${input.keyId ?? 'unsaved'}:${Date.now()}`,
    }));
  } catch (error) {
    const code = error instanceof RelayError ? error.code : 'relay_models_failed';
    const message = error instanceof RelayError ? error.message : '获取上游模型失败。';
    sendTransportError(response, 502, context, genericError(code, 'key_management', message, error instanceof RelayError && error.retryable));
  }
});

app.patch('/api/keys/:keyId', (request, response) => {
  const auth = authFromRequest(request);
  const context = contextFromHeaders(request.headers);
  if (!canMutate(auth)) { sendTransportError(response, 403, context, genericError('forbidden', 'key_management', '当前角色无权修改 Key。')); return; }
  const existing = store.getRelayKey(request.params.keyId, auth.tenantId);
  if (!existing) { sendTransportError(response, 404, context, genericError('relay_key_not_found', 'key_management', '未找到指定 Key。')); return; }
  const input = relayKeyUpdateSchema.parse(request.body);
  const stored = store.saveRelayKey({
    ...existing,
    name: input.name ?? existing.name,
    baseUrl: input.baseUrl ? assertRelayBaseUrl(input.baseUrl) : existing.baseUrl,
    apiKey: input.apiKey ?? existing.apiKey,
    model: input.model ?? existing.model,
    active: input.active ?? existing.active,
    updatedAt: new Date().toISOString(),
  });
  const key = store.relayKeySummary(stored);
  store.audit(auth.tenantId, auth.userId, 'relay-key.updated', 'relay-key', key.keyId, {name: key.name, baseUrl: key.baseUrl, model: key.model, active: key.active, credentialChanged: Boolean(input.apiKey)});
  sendEnvelope(response, 200, createTransportEnvelope(context, {
    type: 'relay-key.updated', schema: 'relay-key.v1', data: key, producer: 'business-api', idempotencyKey: `${context.jobId}:relay-key:update:${key.updatedAt}`,
  }));
});

app.post('/api/keys/:keyId/activate', (request, response) => {
  const auth = authFromRequest(request);
  const context = contextFromHeaders(request.headers);
  if (!canMutate(auth)) { sendTransportError(response, 403, context, genericError('forbidden', 'key_management', '当前角色无权启用 Key。')); return; }
  const stored = store.activateRelayKey(request.params.keyId, auth.tenantId, new Date().toISOString());
  if (!stored) { sendTransportError(response, 404, context, genericError('relay_key_not_found', 'key_management', '未找到指定 Key。')); return; }
  const key = store.relayKeySummary(stored);
  store.audit(auth.tenantId, auth.userId, 'relay-key.activated', 'relay-key', key.keyId, {name: key.name, model: key.model});
  sendEnvelope(response, 200, createTransportEnvelope(context, {
    type: 'relay-key.activated', schema: 'relay-key.v1', data: key, producer: 'business-api', idempotencyKey: `${context.jobId}:relay-key:activate:${key.updatedAt}`,
  }));
});

app.post('/api/keys/:keyId/test', async (request, response) => {
  const auth = authFromRequest(request);
  const context = contextFromHeaders(request.headers);
  if (!canMutate(auth)) { sendTransportError(response, 403, context, genericError('forbidden', 'key_management', '当前角色无权测试 Key。')); return; }
  const key = store.getRelayKey(request.params.keyId, auth.tenantId);
  if (!key) { sendTransportError(response, 404, context, genericError('relay_key_not_found', 'key_management', '未找到指定 Key。')); return; }
  const started = Date.now();
  let result: {ok: boolean; latencyMs: number; message: string};
  try {
    await createLoggedRelay({baseUrl: key.baseUrl, apiKey: key.apiKey, model: key.model, timeoutMs: 30_000}, auth.tenantId, key.keyId)
      .requestJson('Return only one JSON object: {"ok": true}. Do not add Markdown.', {action: 'connection_test'}, undefined, [], {
        ownerId: auth.userId,
        projectId: context.projectId,
        jobId: context.jobId,
        source: 'relay.connection-test',
      });
    result = {ok: true, latencyMs: Date.now() - started, message: 'Connection succeeded and returned response.completed.'};
  } catch (error) {
    const message = error instanceof RelayError ? `${error.message} (${error.code})` : 'Connection test failed.';
    result = {ok: false, latencyMs: Date.now() - started, message};
  }
  store.saveModelConnectionHealth(auth.tenantId, key.keyId, {ok: result.ok, message: result.message});
  store.audit(auth.tenantId, auth.userId, 'relay-key.tested', 'relay-key', key.keyId, {ok: result.ok, latencyMs: result.latencyMs});
  sendEnvelope(response, 200, createTransportEnvelope(context, {
    type: 'relay-key.tested', schema: 'relay-key-test.v1', data: result, producer: 'business-api', idempotencyKey: `${context.jobId}:relay-key:test:${Date.now()}`,
  }));
});

const chatTestErrorMessages: Record<string, string> = {
  chat_messages_invalid: '对话消息格式无效。',
  chat_image_count_exceeded: '单次最多选择 10 张图片。',
  chat_image_too_large: '单张图片不能超过 15 MiB。',
  chat_images_too_large: '本次图片合计不能超过 60 MiB。',
  chat_image_type_invalid: '仅支持 JPEG、PNG、WebP、GIF 图片。',
};

app.post('/api/keys/:keyId/chat', chatTestUpload.array('images', 10), async (request, response) => {
  const auth = authFromRequest(request);
  const context = contextFromHeaders(request.headers);
  const files = (request.files ?? []) as Express.Multer.File[];
  const streamMode = request.query.stream === '1';
  const abortController = new AbortController();
  const abortOnDisconnect = () => { if (!response.writableEnded) abortController.abort(); };
  request.on('aborted', abortOnDisconnect);
  const writeStreamEvent = (event: Record<string, unknown>) => {
    if (!streamMode || response.writableEnded || response.destroyed) return;
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  try {
    if (!canMutate(auth)) { sendTransportError(response, 403, context, genericError('forbidden', 'key_chat', '当前角色无权进行对话测试。')); return; }
    const keyId = request.params.keyId;
    if (typeof keyId !== 'string') throw new Error('relay_key_not_found');
    const key = store.getRelayKey(keyId, auth.tenantId);
    if (!key) { sendTransportError(response, 404, context, genericError('relay_key_not_found', 'key_chat', '未找到指定 Key。')); return; }
    const rawMessages = typeof request.body.messages === 'string' ? JSON.parse(request.body.messages) : request.body.messages;
    const input = relayChatInputSchema.safeParse({messages: rawMessages});
    if (!input.success) throw new Error('chat_messages_invalid');
    const media = await prepareChatTestImages(files.map((file) => ({path: file.path, sizeBytes: file.size, fileName: decodeMultipartFilename(file.originalname)})));
    const started = Date.now();
    if (streamMode) {
      response.status(200);
      response.set({'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no'});
      response.flushHeaders();
    }
    const reply = await createLoggedRelay({baseUrl: key.baseUrl, apiKey: key.apiKey, model: key.model, timeoutMs: 60_000}, auth.tenantId, key.keyId)
      .requestChat(input.data.messages, media.imageUrls, abortController.signal, {
        ownerId: auth.userId,
        projectId: context.projectId,
        jobId: context.jobId,
        source: 'relay.chat-test',
      }, streamMode ? (delta) => writeStreamEvent({type: 'delta', delta}) : undefined);
    const latencyMs = Date.now() - started;
    if (streamMode) {
      writeStreamEvent({type: 'completed', reply, model: key.model, latencyMs});
      response.end();
      return;
    }
    store.audit(auth.tenantId, auth.userId, 'relay-key.chat-tested', 'relay-key', key.keyId, {model: key.model, latencyMs, messageCount: input.data.messages.length, uploadedImageCount: media.uploadedImageCount});
    sendEnvelope(response, 200, createTransportEnvelope(context, {
      type: 'relay-chat.completed', schema: 'relay-chat-result.v1', data: {reply, model: key.model, latencyMs},
      producer: 'business-api', idempotencyKey: `${context.jobId}:relay-chat:${key.keyId}:${Date.now()}`,
    }));
  } catch (error) {
    const code = error instanceof RelayError ? error.code : error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : 'relay_chat_failed';
    const message = error instanceof RelayError ? error.message : chatTestErrorMessages[code] ?? '模型对话失败。';
    const status = error instanceof RelayError ? 502 : code.startsWith('chat_') ? 400 : 500;
    if (streamMode && response.headersSent) {
      writeStreamEvent({type: 'error', code, message, retryable: error instanceof RelayError && error.retryable});
      response.end();
      return;
    }
    sendTransportError(response, status, context, genericError(code, 'key_chat', message, error instanceof RelayError && error.retryable));
  } finally {
    request.off('aborted', abortOnDisconnect);
    await Promise.all(files.map((file) => rm(file.path, {force: true}).catch(() => undefined)));
  }
});

const protocolTestErrorMessages: Record<string, string> = {
  protocol_prompt_required: '请先输入测试消息。',
  protocol_prompt_too_long: '测试消息最多 8,000 个字符。',
  protocol_files_limit: '单次最多选择 10 个图片或视频文件。',
  protocol_image_count_exceeded: '图片和视频抽取出的关键帧合计最多 10 张。请减少文件或视频数量。',
  protocol_image_too_large: '单张图片原始数据不能超过 15 MiB。',
  protocol_images_too_large: '本次发送的图片原始数据合计不能超过 60 MiB。',
  protocol_video_too_large: '单个视频不能超过 250 MiB。',
  protocol_videos_too_large: '本次视频合计不能超过 250 MiB。',
  protocol_image_type_invalid: '仅支持 JPEG、PNG、WebP、GIF 图片。',
  protocol_media_type_invalid: '仅支持 JPEG、PNG、WebP、GIF、MP4、WebM 文件。',
  protocol_video_stream_missing: '视频中没有可读取的视频轨道。',
};

app.post('/api/keys/:keyId/protocol-test', protocolTestUpload.array('files', 10), async (request, response) => {
  const auth = authFromRequest(request);
  const context = contextFromHeaders(request.headers);
  const files = (request.files ?? []) as Express.Multer.File[];
  try {
    if (!canMutate(auth)) { sendTransportError(response, 403, context, genericError('forbidden', 'relay_protocol_test', '当前角色无权进行通信测试。')); return; }
    const keyId = request.params.keyId;
    if (typeof keyId !== 'string') throw new Error('relay_key_not_found');
    const key = store.getRelayKey(keyId, auth.tenantId);
    if (!key) { sendTransportError(response, 404, context, genericError('relay_key_not_found', 'relay_protocol_test', '未找到指定 Key。')); return; }
    const prompt = typeof request.body.prompt === 'string' ? request.body.prompt.trim() : '';
    if (!prompt) throw new Error('protocol_prompt_required');
    if (prompt.length > 8_000) throw new Error('protocol_prompt_too_long');
    if (files.length > 10) throw new Error('protocol_files_limit');

    const started = Date.now();
    const media = await prepareProtocolTestMedia(files.map((file) => ({path: file.path, sizeBytes: file.size, fileName: decodeMultipartFilename(file.originalname)})));
    const reply = await createLoggedRelay({baseUrl: key.baseUrl, apiKey: key.apiKey, model: key.model, timeoutMs: 90_000}, auth.tenantId, key.keyId)
      .requestMultimodalText(prompt, media.imageUrls, undefined, {
        ownerId: auth.userId,
        projectId: context.projectId,
        jobId: context.jobId,
        source: 'relay.protocol-test',
      });
    const latencyMs = Date.now() - started;
    store.audit(auth.tenantId, auth.userId, 'relay-key.protocol-tested', 'relay-key', key.keyId, {
      model: key.model,
      latencyMs,
      uploadedImageCount: media.uploadedImageCount,
      uploadedVideoCount: media.uploadedVideoCount,
      inputImageCount: media.imageUrls.length,
    });
    sendEnvelope(response, 200, createTransportEnvelope(context, {
      type: 'relay-protocol-test.completed', schema: 'relay-protocol-test-result.v1',
      data: {reply, model: key.model, latencyMs, inputImageCount: media.imageUrls.length, uploadedImageCount: media.uploadedImageCount, uploadedVideoCount: media.uploadedVideoCount},
      producer: 'business-api', idempotencyKey: `${context.jobId}:relay-protocol-test:${key.keyId}:${Date.now()}`,
    }));
  } catch (error) {
    const code = error instanceof RelayError ? error.code : error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : 'protocol_media_processing_failed';
    const message = error instanceof RelayError ? error.message : protocolTestErrorMessages[code] ?? '无法处理上传媒体，请检查文件格式后重试。';
    const status = error instanceof RelayError ? 502 : code.startsWith('protocol_') ? 400 : 500;
    sendTransportError(response, status, context, genericError(code, 'relay_protocol_test', message, error instanceof RelayError && error.retryable));
  } finally {
    await Promise.all(files.map((file) => rm(file.path, {force: true}).catch(() => undefined)));
  }
});

app.delete('/api/keys/:keyId', (request, response) => {
  const auth = authFromRequest(request);
  const context = contextFromHeaders(request.headers);
  if (!canMutate(auth)) { sendTransportError(response, 403, context, genericError('forbidden', 'key_management', '当前角色无权删除 Key。')); return; }
  if (!store.deleteRelayKey(request.params.keyId, auth.tenantId)) { sendTransportError(response, 404, context, genericError('relay_key_not_found', 'key_management', '未找到指定 Key。')); return; }
  store.audit(auth.tenantId, auth.userId, 'relay-key.deleted', 'relay-key', request.params.keyId);
  sendEnvelope(response, 200, createTransportEnvelope(context, {
    type: 'relay-key.deleted', schema: 'command-result.v1', data: {accepted: true}, producer: 'business-api', idempotencyKey: `${context.jobId}:relay-key:delete:${request.params.keyId}`,
  }));
});

app.get('/api/metrics', (request, response) => {
  const auth = authFromRequest(request);
  if (auth.role !== 'admin') { response.sendStatus(403); return; }
  const metrics = store.metrics();
  const lines = [
    '# HELP washcut_jobs_total Total render jobs by status.',
    '# TYPE washcut_jobs_total gauge',
    ...metrics.jobs.map((row) => `washcut_jobs_total{status="${row.status}"} ${row.count}`),
    '# HELP washcut_assets_total Total persisted assets.',
    '# TYPE washcut_assets_total gauge',
    `washcut_assets_total ${metrics.totals.assets}`,
    '# HELP washcut_events_total Total persisted transport events.',
    '# TYPE washcut_events_total counter',
    `washcut_events_total ${metrics.totals.events}`,
    '# HELP washcut_audit_entries_total Total audit records.',
    '# TYPE washcut_audit_entries_total counter',
    `washcut_audit_entries_total ${metrics.totals.audit_entries}`,
    '# HELP washcut_video_analysis_tasks_total Video analysis tasks by status.',
    '# TYPE washcut_video_analysis_tasks_total gauge',
    ...metrics.videoTasks.map((row) => `washcut_video_analysis_tasks_total{status="${row.status}"} ${row.count}`),
    '# HELP washcut_video_upload_sessions_total Total resumable video upload sessions.',
    '# TYPE washcut_video_upload_sessions_total gauge',
    `washcut_video_upload_sessions_total ${metrics.totals.video_uploads}`,
    '# HELP washcut_webhook_deliveries_total Total video analysis webhook delivery attempts.',
    '# TYPE washcut_webhook_deliveries_total counter',
    `washcut_webhook_deliveries_total ${metrics.totals.webhook_deliveries}`,
  ];
  response.type('text/plain; version=0.0.4').send(`${lines.join('\n')}\n`);
});

app.get('/api/model-conversations', (request, response) => {
  const auth = authFromRequest(request);
  const limit = Number(request.query.limit);
  const status = request.query.status === 'streaming' || request.query.status === 'completed' || request.query.status === 'failed' ? request.query.status : undefined;
  const projectId = typeof request.query.projectId === 'string' && request.query.projectId.length <= 180 ? request.query.projectId : undefined;
  const generationId = typeof request.query.generationId === 'string' && request.query.generationId.length <= 180 ? request.query.generationId : undefined;
  const source = typeof request.query.source === 'string' && request.query.source.length <= 120 ? request.query.source : undefined;
  const conversations = store.listModelConversations(auth.tenantId, auth.userId, auth.role, {
    projectId,
    generationId,
    source,
    status,
    limit: Number.isFinite(limit) ? limit : 100,
  });
  response.json({conversations});
});

app.get('/api/model-conversations/:conversationId', (request, response) => {
  const auth = authFromRequest(request);
  const conversation = store.getModelConversation(request.params.conversationId, auth.tenantId, auth.userId, auth.role);
  if (!conversation) { response.status(404).json({error: {message: '未找到模型对话记录。'}}); return; }
  response.json(conversation);
});

app.post('/api/assets', upload.array('files', 20), async (request, response, next) => {
  const context = contextFromHeaders(request.headers);
  const files = (request.files ?? []) as Express.Multer.File[];
  try {
    const auth = authFromRequest(request);
    if (!canMutate(auth)) { sendTransportError(response, 403, context, genericError('forbidden', 'asset_upload', '当前角色无权上传素材。')); return; }
    if (auth.tenantId !== context.tenantId) throw new Error('tenant_context_mismatch');
    if (!files.length) { sendTransportError(response, 400, context, genericError('asset_files_required', 'asset_upload', '至少需要上传一个媒体文件。')); return; }
    const assets = [];
    for (const file of files) {
      const asset = await processUploadedMedia({
        tempPath: file.path,
        originalName: decodeMultipartFilename(file.originalname),
        claimedType: file.mimetype,
        sizeBytes: file.size,
        tenantId: auth.tenantId,
        projectId: context.projectId,
        ownerId: auth.userId,
        assetId: newTransportId('ast'),
      });
      store.saveAsset(asset);
      store.audit(auth.tenantId, auth.userId, 'asset.uploaded', 'asset', asset.assetId, {sha256: asset.sha256, contentType: asset.contentType, sizeBytes: asset.sizeBytes});
      assets.push(publicAsset(asset));
    }
    sendEnvelope(response, 201, createTransportEnvelope(context, {
      type: 'asset-upload.completed', schema: 'asset-batch.v1', data: {assets}, producer: 'business-api', idempotencyKey: `${context.jobId}:asset-upload:${assets.map((asset) => asset.sha256).join(':')}`,
    }));
  } catch (error) {
    await Promise.all(files.map((file) => rm(file.path, {force: true}).catch(() => undefined)));
    next(error);
  }
});

app.get('/api/assets/:assetId/content', (request, response) => {
  const variant = String(request.query.variant ?? 'original');
  if (!verifyMediaSignature('asset', request.params.assetId, variant, request.query.expires, request.query.signature)) { response.sendStatus(403); return; }
  const asset = store.getAssetById(request.params.assetId);
  const filePath = asset ? assetVariantPath(asset, variant) : undefined;
  if (!asset || !filePath) { response.sendStatus(404); return; }
  response.setHeader('cache-control', 'private, max-age=300');
  response.sendFile(filePath);
});

app.post('/api/jobs', (request, response) => {
  const outer = envelopeSchema.safeParse(request.body);
  const fallbackContext = outer.success
    ? {tenantId: outer.data.tenantId, projectId: outer.data.projectId, jobId: outer.data.jobId, traceId: outer.data.traceId}
    : contextFromHeaders(request.headers);
  try {
    const auth = authFromRequest(request);
    if (!canMutate(auth)) { sendTransportError(response, 403, fallbackContext, genericError('forbidden', 'business_api', '当前角色无权创建任务。')); return; }
    const command = parseEnvelope<unknown>(request.body, {type: 'render-job.create-requested', schema: 'project-input.v1'});
    if (auth.tenantId !== command.tenantId) throw new Error('tenant_context_mismatch');
    const parsedInput = projectInputSchema.parse(command.payload.data);
    if (parsedInput.projectId !== command.projectId) throw new Error('project_id_mismatch');
    store.resolveAssets(parsedInput.assetIds, auth.tenantId, parsedInput.projectId);
    const cached = store.getIdempotent(auth.tenantId, command.idempotencyKey);
    if (cached) { sendEnvelope(response, 200, cached); return; }
    const now = new Date().toISOString();
    const selectedRelay = activeRelay(auth.tenantId);
    const job = renderJobSchema.parse({
      schema: 'render-job.v1', jobId: command.jobId, tenantId: auth.tenantId, ownerId: auth.userId,
      projectId: command.projectId, traceId: command.traceId, status: 'queued', progress: 2,
      mode: selectedRelay ? 'relay' : 'local', relayKeyId: selectedRelay?.keyId,
      attempt: 1, createdAt: now, updatedAt: now, input: parsedInput, artifacts: [],
    });
    store.saveJob(job);
    const accepted = createTransportEnvelope(contextForJob(job), {
      type: 'render-job.accepted', schema: 'render-job.v1', data: job, producer: 'business-api', idempotencyKey: command.idempotencyKey, causationId: command.eventId,
    });
    store.saveIdempotent(auth.tenantId, command.idempotencyKey, accepted);
    store.appendEvent(job.jobId, accepted);
    store.audit(auth.tenantId, auth.userId, 'render.created', 'job', job.jobId, {projectId: job.projectId});
    worker.enqueue(job.jobId);
    sendEnvelope(response, 202, accepted);
  } catch (error) {
    sendTransportError(response, 400, fallbackContext, genericError('invalid_transport_message', 'business_api', '请求未通过身份、归属或 Schema 校验。', false, error instanceof Error ? error.message : 'unknown_error'), outer.success ? outer.data.eventId : undefined);
  }
});

app.get('/api/jobs', (request, response) => {
  const auth = authFromRequest(request);
  const context = contextFromHeaders(request.headers);
  const jobs = store.listJobs(auth.tenantId, auth.userId, auth.role).map(refreshJobLinks);
  sendEnvelope(response, 200, createTransportEnvelope(context, {
    type: 'render-jobs.fetched', schema: 'job-batch.v1', data: {jobs}, producer: 'business-api', idempotencyKey: `${context.jobId}:job-list:${jobs[0]?.updatedAt ?? 'empty'}`,
  }));
});

app.get('/api/jobs/:jobId', (request, response) => {
  const auth = authFromRequest(request);
  const job = store.getJob(request.params.jobId);
  const context = job ? contextForJob(job) : contextFromHeaders(request.headers);
  if (!job || !canReadJob(auth, job)) { sendTransportError(response, 404, context, genericError('job_not_found', 'business_api', '未找到指定任务。')); return; }
  sendEnvelope(response, 200, createTransportEnvelope(context, {
    type: 'render-job.fetched', schema: 'render-job.v1', data: refreshJobLinks(job), producer: 'business-api', idempotencyKey: `${job.jobId}:fetch:${job.updatedAt}`,
  }));
});

app.get('/api/jobs/:jobId/events', (request, response) => {
  const auth = authFromRequest(request);
  const job = store.getJob(request.params.jobId);
  const context = job ? contextForJob(job) : contextFromHeaders(request.headers);
  if (!job || !canReadJob(auth, job)) { sendTransportError(response, 404, context, genericError('job_not_found', 'business_api', '未找到指定任务。')); return; }
  const events = store.getEvents(job.jobId);
  sendEnvelope(response, 200, createTransportEnvelope(context, {
    type: 'event-batch.fetched', schema: 'event-batch.v1', data: {events}, producer: 'business-api', idempotencyKey: `${job.jobId}:events:${events.length}`,
  }));
});

app.delete('/api/jobs/:jobId', (request, response) => {
  const auth = authFromRequest(request);
  const job = store.getJob(request.params.jobId);
  const context = job ? contextForJob(job) : contextFromHeaders(request.headers);
  if (!job || !canReadJob(auth, job)) { sendTransportError(response, 404, context, genericError('job_not_found', 'business_api', '未找到指定任务。')); return; }
  if (!canMutate(auth)) { sendTransportError(response, 403, context, genericError('forbidden', 'business_api', '当前角色无权取消任务。')); return; }
  store.requestCancel(job.jobId, auth.tenantId);
  worker.cancel(job.jobId);
  store.audit(auth.tenantId, auth.userId, 'render.cancelled', 'job', job.jobId);
  sendEnvelope(response, 202, createTransportEnvelope(context, {
    type: 'render-job.cancel-accepted', schema: 'command-result.v1', data: {accepted: true}, producer: 'business-api', idempotencyKey: `${job.jobId}:cancel:${job.attempt}`,
  }));
});

app.post('/api/jobs/:jobId/retry', (request, response) => {
  const auth = authFromRequest(request);
  const job = store.getJob(request.params.jobId);
  const context = job ? contextForJob(job) : contextFromHeaders(request.headers);
  if (!job || !canReadJob(auth, job)) { sendTransportError(response, 404, context, genericError('job_not_found', 'business_api', '未找到指定任务。')); return; }
  if (!canMutate(auth) || job.status !== 'failed') { sendTransportError(response, 409, context, genericError('job_not_retryable', 'business_api', '当前任务状态不可重试。')); return; }
  const next = renderJobSchema.parse({...job, status: 'queued', progress: Math.min(job.progress, 70), attempt: job.attempt + 1, error: undefined, updatedAt: new Date().toISOString()});
  store.clearCancel(job.jobId);
  store.saveJob(next);
  worker.enqueue(job.jobId);
  sendEnvelope(response, 202, createTransportEnvelope(context, {
    type: 'render-job.retry-accepted', schema: 'command-result.v1', data: {accepted: true}, producer: 'business-api', idempotencyKey: `${job.jobId}:retry:${next.attempt}`,
  }));
});

app.post('/api/jobs/:jobId/review', (request, response) => {
  const auth = authFromRequest(request);
  const job = store.getJob(request.params.jobId);
  const context = job ? contextForJob(job) : contextFromHeaders(request.headers);
  if (!job || !canReadJob(auth, job)) { sendTransportError(response, 404, context, genericError('job_not_found', 'business_api', '未找到指定任务。')); return; }
  const status = request.body?.status === 'approved' ? 'approved' : request.body?.status === 'returned' ? 'returned' : undefined;
  if (!canMutate(auth) || !status) { sendTransportError(response, 400, context, genericError('invalid_review', 'business_api', '复核状态必须是 approved 或 returned。')); return; }
  const next = renderJobSchema.parse({...job, review: {status, reason: String(request.body?.reason ?? '').slice(0, 300) || undefined, reviewedAt: new Date().toISOString()}, updatedAt: new Date().toISOString()});
  store.saveJob(next);
  store.audit(auth.tenantId, auth.userId, `review.${status}`, 'job', job.jobId, {reason: next.review?.reason});
  sendEnvelope(response, 200, createTransportEnvelope(context, {
    type: 'render-job.reviewed', schema: 'render-job.v1', data: refreshJobLinks(next), producer: 'business-api', idempotencyKey: `${job.jobId}:review:${next.updatedAt}`,
  }));
});

app.get('/api/jobs/:jobId/media/:variant', (request, response) => {
  const variant = request.params.variant;
  if (!verifyMediaSignature('job', request.params.jobId, variant, request.query.expires, request.query.signature)) { response.sendStatus(403); return; }
  const job = store.getJob(request.params.jobId);
  const filePath = job ? jobArtifactPath(job.jobId, variant) : undefined;
  if (!job || !filePath) { response.sendStatus(404); return; }
  const artifact = job.artifacts.find((item) => item.kind === variant);
  if (artifact) response.setHeader('content-disposition', `attachment; filename="${artifact.fileName.replace(/[\r\n"]/g, '')}"`);
  response.setHeader('cache-control', 'private, max-age=300');
  response.sendFile(filePath);
});

app.use((error: unknown, request: express.Request, response: express.Response, _next: express.NextFunction) => {
  const context = contextFromHeaders(request.headers);
  const message = error instanceof Error ? error.message : '请求处理失败。';
  const code = /^[a-z0-9_]+$/.test(message) ? message : 'request_failed';
  sendTransportError(response, 400, context, genericError(code, 'business_api', '请求处理失败，文件未进入项目。', false, message.slice(0, 800)));
});

const apiServer = createServer(app);
apiServer.once('listening', () => {
  console.log(`[washcut] API ready on http://127.0.0.1:${port} (automatic orchestration + sqlite storage)`);
});
recoverWorkersAfterServerListening(apiServer, [worker, videoAnalysisWorker, autoVideoWorker]);
const handleListenError = (error: NodeJS.ErrnoException) => {
  console.error(JSON.stringify({
    level: 'error',
    event: 'server.listen_failed',
    code: error.code,
    message: error.message,
    retryable: error.code === 'EADDRINUSE',
  }));
  store.close();
  process.exitCode = 1;
};
apiServer.once('error', handleListenError);
apiServer.once('listening', () => apiServer.off('error', handleListenError));
apiServer.listen(port, '127.0.0.1');

