import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {rm} from 'node:fs/promises';
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
  autoVideoGenerationCreateSchema,
  AUTO_VIDEO_VISUAL_CONCURRENCY_OPTIONS,
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
import {AutoVideoWorker} from './auto-video-worker.js';
import {decodeMultipartFilename} from './upload-filename.js';
import {
  hashFile,
  isRemotionRenderable,
  persistImmutableOriginal,
  probeAutoVideo,
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

const localEnvironmentFile = path.join(process.cwd(), '.env');
if (existsSync(localEnvironmentFile)) process.loadEnvFile(localEnvironmentFile);

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
    name: '鏈嶅姟绔幆澧冭繛鎺?',
    model: environmentRelayConfig.model,
  } : undefined;
};
const generationRelay = (tenantId: string, connectionId?: string, model?: string) => {
  if (connectionId === 'environment') return environmentRelayConfig ? createLoggedRelay({...environmentRelayConfig, model: model ?? environmentRelayConfig.model, retryAttempts: 1}, tenantId) : undefined;
  const key = connectionId ? store.getRelayKey(connectionId, tenantId) : undefined;
  return key ? createLoggedRelay({baseUrl: key.baseUrl, apiKey: key.apiKey, model: model ?? key.model, retryAttempts: 1}, tenantId, key.keyId) : undefined;
};
const worker = new JobWorker(store, (tenantId, keyId) => keyId ? managedRelay(tenantId, keyId) : environmentRelayConfig ? new RelayClient(environmentRelayConfig) : undefined);
const videoAnalysisWorker = new VideoAnalysisWorker(store, (tenantId) => activeRelay(tenantId)?.client);
// Saving a tenant Relay key from the web UI and marking it current is an
// explicit opt-in for real visual, understanding, and planning calls. The
// environment-only fallback remains opt-in through DEMO_MODE=false.
const transcriptionRegistry = createTranscriptionProviderRegistry();
const autoVideoWorker = new AutoVideoWorker(store, generationRelay, transcriptionRegistry);
let shutdownScheduled = false;

const closeLocalProgram = () => {
  // In development, this server is a child of tsx watch -> concurrently. Closing
  // that parent tree also stops Vite and releases both local ports.
  if (process.platform === 'win32' && process.ppid > 1) {
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
  limits: {fileSize: 250 * 1024 * 1024, files: 20},
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

const autoVideoError = (code: AutoVideoError['code'], message: string, retryable = false, details?: string) =>
  autoVideoErrorSchema.parse({code, message, retryable, details});

const sendAutoVideoError = (response: express.Response, status: number, error: ReturnType<typeof autoVideoError>) =>
  response.status(status).json({error});

const canReadAutoProject = (auth: ReturnType<typeof authFromRequest>, project: AutoVideoProject) =>
  project.tenantId === auth.tenantId && (auth.role === 'admin' || project.ownerId === auth.userId);

const activeGenerationStatuses = new Set<AutoVideoGeneration['status']>(['queued', 'analyzing', 'retry_waiting', 'planning', 'rendering']);
const canReadAutoGeneration = (auth: ReturnType<typeof authFromRequest>, generation: AutoVideoGeneration) =>
  generation.tenantId === auth.tenantId && (auth.role === 'admin' || generation.ownerId === auth.userId);

const canEditAutoVideoAssets = (project: AutoVideoProject) => project.status !== 'archived' && !store.hasActiveAutoVideoGeneration(project.tenantId, project.id);

const transcriptionAvailable = () => process.env.DEMO_MODE !== 'false' || Boolean(process.env.SPEACHES_BASE_URL);

const modelConnectionStatus = (tenantId: string) => {
  const connection = activeRelay(tenantId);
  if (!connection) return {
    mode: 'local' as const,
    reason: 'no_model_connection' as const,
    transcriptionAvailable: transcriptionAvailable(),
    message: '鏈繛鎺ユā鍨嬨€傚彲浠ユ寜涓婁紶椤哄簭鍚堟垚锛屼絾涓嶄細鐞嗚В鐢婚潰銆佽闊虫垨鍙欎簨銆?',
  };
  const health = connection.connectionId !== 'environment' ? store.getModelConnectionHealth(tenantId, connection.connectionId) : undefined;
  if (health && !health.ok) return {
    mode: 'blocked' as const,
    reason: 'connection_test_failed' as const,
    transcriptionAvailable: transcriptionAvailable(),
    activeConnection: {connectionId: connection.connectionId, name: connection.name, model: connection.model},
    message: health.message || '褰撳墠妯″瀷杩炴帴娴嬭瘯澶辫触銆傝鍦ㄦā鍨嬭缃腑淇鍚庡啀寮€濮嬫櫤鑳界紪鎺掋€?',
  };
  if (!transcriptionAvailable()) return {
    mode: 'connected' as const,
    transcriptionAvailable: false,
    activeConnection: {connectionId: connection.connectionId, name: connection.name, model: connection.model},
    message: '妯″瀷杩炴帴宸蹭繚瀛橈紱璇煶杞啓鏆傛湭鍚敤锛屽皢鑷姩璺宠繃璇煶鍒嗘瀽銆?',
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
    if (!canMutate(auth)) { sendAutoVideoError(response, 403, autoVideoError('INVALID_UPLOAD', '褰撳墠瑙掕壊鏃犳潈鍒涘缓椤圭洰銆?')); return; }
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
    sendAutoVideoError(response, 400, autoVideoError('INVALID_UPLOAD', '椤圭洰鍙傛暟鏃犳晥銆?', false, error instanceof Error ? error.message : undefined));
  }
});

app.get('/api/projects', (request, response) => {
  const auth = authFromRequest(request);
  response.json({projects: store.listAutoVideoProjects(auth.tenantId, auth.userId, auth.role).map(autoVideoProjectSummary)});
});

app.get('/api/projects/:projectId', (request, response) => {
  const {project} = getOwnedAutoProject(request);
  if (!project) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '鏈壘鍒伴」鐩€?')); return; }
  response.json(autoVideoProjectResponse(project));
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

// Legacy endpoints intentionally remain Whisper-only. They must never start or
// report Qwen because Qwen requires its own ASR + aligner health contract.
app.get('/api/transcription/status', async (_request, response) => {
  response.json(await transcriptionRegistry.whisper().status());
});

app.post('/api/transcription/start', async (_request, response) => {
  const result = await transcriptionRegistry.activate('speaches-whisper');
  response.json(result.providers.find((provider) => provider.id === 'speaches-whisper'));
});

app.patch('/api/projects/:projectId', (request, response) => {
  try {
    const {auth, project} = getOwnedAutoProject(request);
    if (!project) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '鏈壘鍒伴」鐩€?')); return; }
    if (!canMutate(auth)) { sendAutoVideoError(response, 403, autoVideoError('INVALID_UPLOAD', '褰撳墠瑙掕壊鏃犳潈淇敼椤圭洰銆?')); return; }
    if (project.status === 'archived' || store.hasActiveAutoVideoGeneration(project.tenantId, project.id)) {
      sendAutoVideoError(response, 409, autoVideoError('INVALID_UPLOAD', '褰撳墠椤圭洰鏈夎繍琛屼腑鐨勭増鏈垨宸插綊妗ｏ紝鏆備笉鑳戒慨鏀广€?'));
      return;
    }
    const input = autoVideoProjectPatchSchema.parse(request.body ?? {});
    const next = store.saveAutoVideoProject({...project, ...input});
    store.audit(auth.tenantId, auth.userId, 'auto-video.project.updated', 'auto-video-project', next.id, {fields: Object.keys(input)});
    response.json(autoVideoProjectResponse(next));
  } catch (error) {
    sendAutoVideoError(response, 400, autoVideoError('INVALID_UPLOAD', '椤圭洰淇敼鍙傛暟鏃犳晥銆?', false, error instanceof Error ? error.message : undefined));
  }
});

app.post('/api/projects/:projectId/duplicate', (request, response) => {
  try {
    const {auth, project} = getOwnedAutoProject(request);
    if (!project) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '鏈壘鍒伴」鐩€?')); return; }
    if (!canMutate(auth)) { sendAutoVideoError(response, 403, autoVideoError('INVALID_UPLOAD', '褰撳墠瑙掕壊鏃犳潈澶嶅埗椤圭洰銆?')); return; }
    const now = new Date().toISOString();
    const sourceAssets = store.listAutoVideoAssets(project.tenantId, project.id);
    const duplicate = autoVideoProjectSchema.parse({
      id: `project_${randomUUID()}`,
      tenantId: auth.tenantId,
      ownerId: auth.userId,
      name: `${project.name} 鍓湰`.slice(0, 80),
      userInstruction: project.userInstruction,
      status: sourceAssets.length ? 'ready' : 'draft',
      progress: 0,
      canvas: project.canvas,
      assetIds: [],
      steps: [],
      createdAt: now,
      updatedAt: now,
    });
    const copiedAssets: StoredAutoVideoAsset[] = sourceAssets.map((asset) => ({
      ...asset,
      id: `asset_${randomUUID()}`,
      tenantId: auth.tenantId,
      ownerId: auth.userId,
      projectId: duplicate.id,
      sourceAssetId: asset.sourceAssetId ?? asset.id,
      rawTranscriptionPath: undefined,
      temporaryAudioPath: undefined,
      screenshots: [],
      createdAt: now,
    }));
    const savedProject = store.saveAutoVideoProject({...duplicate, assetIds: copiedAssets.map((asset) => asset.id)});
    for (const asset of copiedAssets) store.saveAutoVideoAsset(asset);
    store.audit(auth.tenantId, auth.userId, 'auto-video.project.duplicated', 'auto-video-project', savedProject.id, {
      sourceProjectId: project.id,
      assetReuse: 'immutable_reference',
      assetCount: copiedAssets.length,
    });
    response.status(201).json(autoVideoProjectResponse(savedProject));
  } catch (error) {
    sendAutoVideoError(response, 400, autoVideoError('INVALID_UPLOAD', '澶嶅埗椤圭洰澶辫触銆?', false, error instanceof Error ? error.message : undefined));
  }
});

app.post('/api/projects/:projectId/archive', (request, response) => {
  const {auth, project} = getOwnedAutoProject(request);
  if (!project) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '鏈壘鍒伴」鐩€?')); return; }
  if (!canMutate(auth)) { sendAutoVideoError(response, 403, autoVideoError('INVALID_UPLOAD', '褰撳墠瑙掕壊鏃犳潈褰掓。椤圭洰銆?')); return; }
  const next = store.saveAutoVideoProject({...project, status: 'archived'});
  store.audit(auth.tenantId, auth.userId, 'auto-video.project.archived', 'auto-video-project', next.id);
  response.json(autoVideoProjectResponse(next));
});

app.get('/api/projects/:projectId/generations', (request, response) => {
  const {auth, project} = getOwnedAutoProject(request);
  if (!project) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '鏈壘鍒伴」鐩€?')); return; }
  const limit = Number(request.query.limit);
  const generations = store.listAutoVideoGenerations(auth.tenantId, auth.userId, auth.role, project.id, Number.isFinite(limit) ? limit : 50);
  response.json({generations: generations.map(publicAutoVideoGenerationSummary)});
});

app.post('/api/projects/:projectId/generations', async (request, response) => {
  try {
    const {auth, project} = getOwnedAutoProject(request);
    if (!project) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '鏈壘鍒伴」鐩€?')); return; }
    if (!canMutate(auth)) { sendAutoVideoError(response, 403, autoVideoError('INVALID_UPLOAD', '褰撳墠瑙掕壊鏃犳潈鍒涘缓鐢熸垚鐗堟湰銆?')); return; }
    if (project.status === 'archived') { sendAutoVideoError(response, 409, autoVideoError('INVALID_UPLOAD', '椤圭洰宸插綊妗ｏ紝涓嶈兘鍒涘缓鏂扮増鏈€?')); return; }
    const input = autoVideoGenerationCreateSchema.parse(request.body ?? {});
    const idempotencyKey = typeof request.headers['x-idempotency-key'] === 'string' && request.headers['x-idempotency-key'].trim()
      ? request.headers['x-idempotency-key'].trim().slice(0, 180)
      : undefined;
    const existing = idempotencyKey ? store.getAutoVideoGenerationByIdempotency(auth.tenantId, idempotencyKey) : undefined;
    if (existing) {
      if (existing.projectId !== project.id) { sendAutoVideoError(response, 409, autoVideoError('INVALID_UPLOAD', '骞傜瓑閿凡鐢ㄤ簬鍙︿竴涓棰戦」鐩€?')); return; }
      if (activeGenerationStatuses.has(existing.status)) autoVideoWorker.enqueue(existing.generationId);
      response.status(202).json({accepted: true, generation: publicAutoVideoGeneration(existing)});
      return;
    }
    if (store.hasActiveAutoVideoGeneration(project.tenantId, project.id)) {
      sendAutoVideoError(response, 409, autoVideoError('INVALID_UPLOAD', '褰撳墠椤圭洰宸叉湁杩愯涓殑鐢熸垚鐗堟湰锛岃绛夊緟瀹屾垚銆佸け璐ユ垨鍙栨秷鍚庡啀鍒涘缓銆?'));
      return;
    }
    const assets = store.listAutoVideoAssets(project.tenantId, project.id);
    if (!assets.length) { sendAutoVideoError(response, 409, autoVideoError('INVALID_UPLOAD', '璇峰厛涓婁紶鑷冲皯涓€涓湁鏁堣棰戠礌鏉愩€?')); return; }
    const unsupported = assets.find((asset) => asset.status === 'unsupported_asset');
    if (unsupported) { sendAutoVideoError(response, 409, autoVideoError('UNSUPPORTED_ASSET', unsupported.error?.message ?? '椤圭洰鍖呭惈褰撳墠鏃犳硶娓叉煋鐨勭礌鏉愩€?')); return; }
    if (assets.some((asset) => asset.status !== 'ready')) { sendAutoVideoError(response, 409, autoVideoError('INVALID_UPLOAD', '椤圭洰涓瓨鍦ㄦ湭灏辩华绱犳潗锛岃鏇挎崲鎴栫Щ闄ゅ悗鍐嶅紑濮嬨€?')); return; }
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
        aiMode = {kind: 'connected', connectionId: 'environment', model: connectionState.activeConnection.model};
      } else {
        const key = store.getRelayKey(requestedConnectionId, auth.tenantId);
        if (!key) { sendAutoVideoError(response, 404, autoVideoError('VISUAL_ANALYSIS_FAILED', '鏈壘鍒版墍閫夋ā鍨嬭繛鎺ャ€?')); return; }
        const health = store.getModelConnectionHealth(auth.tenantId, key.keyId);
        if (health && !health.ok) { sendAutoVideoError(response, 409, autoVideoError('VISUAL_ANALYSIS_FAILED', health.message)); return; }
        aiMode = {kind: 'connected', connectionId: key.keyId, model: key.model};
      }
    }
    const transcriptionSnapshot = aiMode.kind === 'connected'
      ? await (async () => {
        const selection = input.transcriptionSelection ?? {providerId: 'speaches-whisper' as const};
        transcriptionRegistry.requireActive(selection.providerId);
        return transcriptionRegistry.createSnapshot(selection);
      })()
      : undefined;
    const now = new Date().toISOString();
    const detailBudget = Math.max(0, Math.min(20, Math.floor(Number(process.env.AUTO_VIDEO_VISUAL_DETAIL_BUDGET ?? 6) || 6)));
    const modelConcurrency = Math.max(1, Math.min(20, Math.floor(Number(process.env.AUTO_VIDEO_MODEL_CONCURRENCY ?? 6) || 6)));
    const visualConcurrency = input.visualConcurrency ?? AUTO_VIDEO_VISUAL_CONCURRENCY_OPTIONS[0];
    const generation = store.createAutoVideoGeneration({
      generationId: `generation_${randomUUID()}`,
      projectId: project.id,
      tenantId: auth.tenantId,
      ownerId: auth.userId,
      status: 'queued',
      progress: 0,
      aiMode,
      ...(aiMode.kind === 'connected' ? {analysisProfile: {name: 'balanced-v1' as const, sampledFramesPerAsset: 3 as const, detailBudget, modelConcurrency, visualConcurrency}} : {}),
      ...(aiMode.kind === 'connected' ? {connectionId: aiMode.connectionId, model: aiMode.model, transcriptionSnapshot} : {}),
      instructionSnapshot: input.userInstruction ?? project.userInstruction ?? '',
      canvas: project.canvas,
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
  if (!generation) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '鏈壘鍒扮敓鎴愮増鏈€?')); return; }
  response.json(publicAutoVideoGeneration(generation));
});

app.delete('/api/projects/:projectId/generations/:generationId', async (request, response, next) => {
  try {
    const {auth, project, generation} = getOwnedAutoGeneration(request);
    if (!project || !generation) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '鏈壘鍒扮敓鎴愮増鏈€?')); return; }
    if (!canMutate(auth)) { sendAutoVideoError(response, 403, autoVideoError('INVALID_UPLOAD', '褰撳墠瑙掕壊鏃犳潈鍒犻櫎鐢熸垚鐗堟湰銆?')); return; }
    if (!['completed', 'failed', 'cancelled', 'needs_attention'].includes(generation.status)) {
      sendAutoVideoError(response, 409, autoVideoError('INVALID_UPLOAD', '杩愯涓殑鐢熸垚鐗堟湰涓嶈兘鍒犻櫎锛岃鍏堜腑鏂换鍔°€?'));
      return;
    }
    if (!store.deleteAutoVideoGeneration(generation.generationId, auth.tenantId, project.id)) {
      sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '鏈壘鍒扮敓鎴愮増鏈€?'));
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
  if (!generation) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '鏈壘鍒扮敓鎴愮増鏈€?')); return; }
  response.json({
    projectId: generation.projectId,
    generationId: generation.generationId,
    status: generation.status,
    progress: generation.progress,
    steps: generation.steps,
    error: generation.error,
  });
});

app.post('/api/projects/:projectId/generations/:generationId/retry', (request, response) => {
  const {auth, generation} = getOwnedAutoGeneration(request);
  if (!generation) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '鏈壘鍒扮敓鎴愮増鏈€?')); return; }
  if (!canMutate(auth) || generation.status !== 'failed' || generation.error?.retryable === false) {
    sendAutoVideoError(response, 409, autoVideoError('INVALID_UPLOAD', '褰撳墠鐢熸垚鐗堟湰涓嶅彲閲嶈瘯銆?'));
    return;
  }
  const next = store.saveAutoVideoGeneration({
    ...generation,
    status: 'queued',
    completedAt: undefined,
    error: undefined,
    output: generation.output?.status === 'failed' ? {status: 'pending'} : generation.output,
    // A failed parallel stage can leave sibling work marked running when the
    // worker aborts. Reset only unfinished work; completed snapshots remain
    // immutable and are never sent through the pipeline again.
    steps: generation.steps.map((step) => step.status === 'failed' || step.status === 'running'
      ? {...step, status: 'pending', progress: 0, completedAt: undefined, errorCode: undefined, errorMessage: undefined}
      : step),
  });
  store.clearAutoVideoGenerationCancel(next.generationId);
  autoVideoWorker.enqueue(next.generationId);
  response.status(202).json({accepted: true, generation: publicAutoVideoGeneration(next)});
});

app.post('/api/projects/:projectId/generations/:generationId/cancel', (request, response) => {
  const {auth, generation} = getOwnedAutoGeneration(request);
  if (!generation) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '鏈壘鍒扮敓鎴愮増鏈€?')); return; }
  const hasRunningStep = generation.steps.some((step) => step.status === 'running');
  if (!canMutate(auth) || (!activeGenerationStatuses.has(generation.status) && !hasRunningStep)) {
    sendAutoVideoError(response, 409, autoVideoError('INVALID_UPLOAD', '褰撳墠鐢熸垚鐗堟湰涓嶅彲鍙栨秷銆?'));
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
      lastError: generation.retryState?.lastError,
      updatedAt: new Date().toISOString(),
    },
  });
  store.audit(auth.tenantId, auth.userId, 'auto-video.generation.cancel-requested', 'auto-video-generation', generation.generationId);
  response.status(202).json({accepted: true, generation: publicAutoVideoGeneration(cancelled)});
});

app.post('/api/projects/:projectId/generations/:generationId/resume', (request, response) => {
  const {auth, generation} = getOwnedAutoGeneration(request);
  if (!generation) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '鏈壘鍒扮敓鎴愮増鏈€?')); return; }
  if (!canMutate(auth) || !['cancelled', 'retry_waiting', 'needs_attention'].includes(generation.status)) {
    sendAutoVideoError(response, 409, autoVideoError('INVALID_UPLOAD', '褰撳墠鐢熸垚鐗堟湰涓嶈兘浠庢柇鐐圭户缁€?'));
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
    output: generation.output?.status === 'failed' ? {status: 'pending'} : generation.output,
    retryState: {status: 'none', totalAttempts: generation.retryState?.totalAttempts ?? 0, updatedAt: new Date().toISOString()},
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
  if (!generation) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '鏈壘鍒扮敓鎴愮増鏈€?')); return; }
  if (generation.output?.status !== 'ready') { response.status(202).json({status: generation.output?.status ?? 'pending'}); return; }
  response.json(publicAutoVideoGeneration(generation).output);
});

app.post('/api/projects/:projectId/assets', upload.array('files', 20), async (request, response, next) => {
  const files = (request.files ?? []) as Express.Multer.File[];
  try {
    const {auth, project: owned} = getOwnedAutoProject(request);
    if (!owned) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '鏈壘鍒伴」鐩€?')); return; }
    if (!canMutate(auth)) { sendAutoVideoError(response, 403, autoVideoError('INVALID_UPLOAD', '褰撳墠瑙掕壊鏃犳潈涓婁紶绱犳潗銆?')); return; }
    if (!canEditAutoVideoAssets(owned)) { sendAutoVideoError(response, 409, autoVideoError('INVALID_UPLOAD', '椤圭洰宸插綊妗ｆ垨瀛樺湪杩愯涓殑鐢熸垚鐗堟湰锛屾殏涓嶈兘淇敼绱犳潗銆?')); return; }
    if (!files.length) { sendAutoVideoError(response, 400, autoVideoError('INVALID_UPLOAD', '鑷冲皯閫夋嫨涓€涓棰戞枃浠躲€?')); return; }
    let project = owned;
    const assets = [];
    for (const file of files) {
      const originalName = decodeMultipartFilename(file.originalname);
      const mimeType = await validateAutoVideoUpload(file.path, file.mimetype, originalName);
      const checksum = await hashFile(file.path);
      const duplicate = store.findAutoVideoAssetByChecksum(auth.tenantId, project.id, checksum);
      if (duplicate) {
        await rm(file.path, {force: true});
        if (!project.assetIds.includes(duplicate.id)) project = store.saveAutoVideoProject({...project, assetIds: [...project.assetIds, duplicate.id], status: 'ready'});
        assets.push({...publicAutoVideoAsset(duplicate), duplicateOfAssetId: duplicate.id});
        continue;
      }
      const assetId = `asset_${randomUUID()}`;
      const originalPath = await persistImmutableOriginal({tempPath: file.path, projectId: project.id, assetId, mimeType, originalName});
      const now = new Date().toISOString();
      let asset: StoredAutoVideoAsset = {
        id: assetId,
        tenantId: auth.tenantId,
        ownerId: auth.userId,
        projectId: project.id,
        originalName: path.basename(originalName),
        mimeType,
        fileSize: file.size,
        checksum,
        status: 'uploaded',
        originalPath,
        screenshots: [],
        createdAt: now,
      };
      try {
        const metadata = await probeAutoVideo(asset.id, asset.originalPath);
        asset = isRemotionRenderable(metadata)
          ? {...asset, status: 'ready', metadata}
          : {...asset, status: 'unsupported_asset', metadata, error: autoVideoError('UNSUPPORTED_ASSET', `Asset ${asset.originalName} uses ${metadata.videoCodec} codec, which is not supported by the current render environment. The original file was retained without transcoding.`)};
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught ?? 'unknown_error');
        const code = caught instanceof Error && typeof (caught as Error & {code?: unknown}).code === 'string'
          ? (caught as Error & {code: string}).code
          : message;
        asset = {...asset, status: 'failed', error: autoVideoError(code, message, false, message)};
      }
      store.saveAutoVideoAsset(asset);
      project = store.saveAutoVideoProject({...project, assetIds: [...project.assetIds, asset.id], status: 'ready'});
      store.audit(auth.tenantId, auth.userId, 'auto-video.asset.uploaded', 'auto-video-asset', asset.id, {checksum, status: asset.status, fileSize: asset.fileSize});
      assets.push(publicAutoVideoAsset(asset));
    }
    response.status(201).json({assets, project: autoVideoProjectResponse(project)});
  } catch (error) {
    await Promise.all(files.map((file) => rm(file.path, {force: true}).catch(() => undefined)));
    if (error instanceof Error && error.message === 'INVALID_UPLOAD') {
      sendAutoVideoError(response, 400, autoVideoError('INVALID_UPLOAD', '浠呮敮鎸佸彲楠岃瘉鐨?MP4銆乄ebM 鎴?MOV 瑙嗛鏂囦欢銆?'));
      return;
    }
    next(error);
  }
});

app.get('/api/projects/:projectId/assets', (request, response) => {
  const {project} = getOwnedAutoProject(request);
  if (!project) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '鏈壘鍒伴」鐩€?')); return; }
  response.json({assets: store.listAutoVideoAssets(project.tenantId, project.id).map(publicAutoVideoAsset)});
});

app.delete('/api/projects/:projectId/assets/:assetId', async (request, response, next) => {
  try {
    const {auth, project: owned} = getOwnedAutoProject(request);
    if (!owned) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '鏈壘鍒伴」鐩€?')); return; }
    if (!canMutate(auth)) { sendAutoVideoError(response, 403, autoVideoError('INVALID_UPLOAD', '褰撳墠瑙掕壊鏃犳潈鍒犻櫎绱犳潗銆?')); return; }
    if (!canEditAutoVideoAssets(owned)) {
      sendAutoVideoError(response, 409, autoVideoError('INVALID_UPLOAD', '椤圭洰宸插綊妗ｆ垨瀛樺湪杩愯涓殑鐢熸垚鐗堟湰锛屾殏涓嶈兘鍒犻櫎绱犳潗銆?'));
      return;
    }

    // Re-read immediately before changing state so two delete requests cannot
    // restore a previously removed asset ID in the project record.
    const project = store.getAutoVideoProject(owned.id, auth.tenantId);
    if (!project || !canReadAutoProject(auth, project)) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '鏈壘鍒伴」鐩€?')); return; }
    if (!canEditAutoVideoAssets(project)) {
      sendAutoVideoError(response, 409, autoVideoError('INVALID_UPLOAD', '椤圭洰宸插綊妗ｆ垨瀛樺湪杩愯涓殑鐢熸垚鐗堟湰锛屾殏涓嶈兘鍒犻櫎绱犳潗銆?'));
      return;
    }
    const asset = store.getAutoVideoAsset(String(request.params.assetId), auth.tenantId);
    if (!asset || asset.projectId !== project.id) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '鏈壘鍒扮礌鏉愩€?')); return; }
    if (store.isAutoVideoAssetReferencedByGeneration(project.tenantId, project.id, asset.id)) {
      sendAutoVideoError(response, 409, autoVideoError('INVALID_UPLOAD', '璇ョ礌鏉愬凡琚敓鎴愮増鏈揩鐓у紩鐢ㄣ€備负淇濇姢鍘嗗彶鐗堟湰锛屼笉鑳界Щ闄ゃ€?'));
      return;
    }
    if (!store.deleteAutoVideoAsset(asset.id, auth.tenantId, project.id)) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '鏈壘鍒扮礌鏉愩€?')); return; }

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

    // The immutable original is intentionally retained on disk. It may still be
    // referenced by a duplicated project, and deleting it would violate the
    // original-media invariant even when this project no longer lists it.
    store.audit(auth.tenantId, auth.userId, 'auto-video.asset.deleted', 'auto-video-asset', asset.id, {projectId: project.id, originalName: asset.originalName});
    response.json({accepted: true, project: autoVideoProjectResponse(nextProject)});
  } catch (error) {
    next(error);
  }
});

app.post('/api/projects/:projectId/process', (request, response) => {
  const {project} = getOwnedAutoProject(request);
  if (!project) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '鏈壘鍒伴」鐩€?')); return; }
  sendAutoVideoError(response, 410, autoVideoError('INVALID_UPLOAD', '椤圭洰绾у鐞嗘帴鍙ｅ凡鍗囩骇銆傝浣跨敤 /generations 鍒涘缓鐙珛鐢熸垚鐗堟湰銆?'));
});

app.post('/api/projects/:projectId/retry', (request, response) => {
  const {project} = getOwnedAutoProject(request);
  if (!project) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '鏈壘鍒伴」鐩€?')); return; }
  sendAutoVideoError(response, 410, autoVideoError('INVALID_UPLOAD', '椤圭洰绾ч噸璇曟帴鍙ｅ凡鍗囩骇銆傝瀵瑰け璐ョ殑鐢熸垚鐗堟湰浣跨敤 /generations/:generationId/retry銆?'));
});

app.get('/api/projects/:projectId/progress', (request, response) => {
  const {project} = getOwnedAutoProject(request);
  if (!project) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '鏈壘鍒伴」鐩€?')); return; }
  response.json({projectId: project.id, status: project.status, progress: project.progress, steps: project.steps, error: project.error});
});

app.get('/api/projects/:projectId/analysis', (request, response) => {
  const {project} = getOwnedAutoProject(request);
  if (!project) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '鏈壘鍒伴」鐩€?')); return; }
  response.json({projectId: project.id, transcripts: project.transcripts, screenshots: project.screenshotAnalyses, assets: project.assetAnalyses});
});

app.get('/api/projects/:projectId/edit-plan', (request, response) => {
  const {project} = getOwnedAutoProject(request);
  if (!project?.editPlan) { sendAutoVideoError(response, 404, autoVideoError('EDIT_PLAN_INVALID', '椤圭洰灏氭湭鐢熸垚缂栨帓璁″垝銆?')); return; }
  response.json(project.editPlan);
});

app.get('/api/projects/:projectId/timeline', (request, response) => {
  const {project} = getOwnedAutoProject(request);
  if (!project?.timeline) { sendAutoVideoError(response, 404, autoVideoError('TIMELINE_INVALID', '椤圭洰灏氭湭鐢熸垚鏃堕棿绾裤€?')); return; }
  response.json(project.timeline);
});

app.post('/api/projects/:projectId/render', (request, response) => {
  const {project} = getOwnedAutoProject(request);
  if (!project) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '鏈壘鍒伴」鐩€?')); return; }
  sendAutoVideoError(response, 410, autoVideoError('TIMELINE_INVALID', '娓叉煋宸插寘鍚湪鐢熸垚鐗堟湰涓紱璇峰垱寤烘垨鏌ョ湅 /generations銆?'));
});

app.get('/api/render-jobs/:renderJobId', (request, response) => {
  const auth = authFromRequest(request);
  const project = store.getAutoVideoProject(request.params.renderJobId, auth.tenantId);
  if (!project || !canReadAutoProject(auth, project)) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '鏈壘鍒版覆鏌撲换鍔°€?')); return; }
  response.json({renderJobId: project.id, status: project.status, progress: project.progress, error: project.error});
});

app.get('/api/projects/:projectId/output', (request, response) => {
  const {auth, project} = getOwnedAutoProject(request);
  if (!project) { sendAutoVideoError(response, 404, autoVideoError('INVALID_UPLOAD', '鏈壘鍒伴」鐩€?')); return; }
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
  response.setHeader('content-disposition', 'inline; filename="output.mp4"; filename*=UTF-8' + "''" + encodeURIComponent(displayName));
  response.type('video/mp4').sendFile(autoVideoGenerationArtifactPath(project.id, generation.generationId, 'output.mp4'));
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
  response.setHeader('content-disposition', 'inline; filename="output.mp4"; filename*=UTF-8' + "''" + encodeURIComponent(displayName));
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
    if (!canMutate(auth)) { sendTransportError(response, 403, context, genericError('forbidden', 'video_upload', '褰撳墠瑙掕壊鏃犳潈涓婁紶骞跺垎鏋愯棰戙€?')); return; }
    if (!file) { sendTransportError(response, 400, context, genericError('video_file_required', 'video_upload', '璇烽€夋嫨涓€涓棰戞枃浠躲€?')); return; }
    const prompt = typeof request.body.prompt === 'string' && request.body.prompt.trim() ? request.body.prompt.trim().slice(0, 4_000) : '鎻愬彇瀛楀箷锛屽苟鎸夋椂闂磋酱鎬荤粨鍏抽敭鍔ㄤ綔';
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
    if (!canMutate(auth)) { sendTransportError(response, 403, context, genericError('forbidden', 'video_upload', '褰撳墠瑙掕壊鏃犳潈鍒涘缓涓婁紶浼氳瘽銆?')); return; }
    const parsed = videoUploadCreateSchema.parse({...request.body, idempotency_key: request.body?.idempotency_key ?? request.headers['x-idempotency-key']});
    const session = createVideoUploadSession(store, auth, context.projectId, parsed);
    sendEnvelope(response, 201, createTransportEnvelope(context, {
      type: 'video-upload.created', schema: 'video-upload-session.v1', data: session, producer: 'business-api', idempotencyKey: parsed.idempotency_key ?? `${session.upload_id}:create`,
    }));
  } catch (error) {
    sendTransportError(response, 400, context, genericError('video_upload_invalid', 'video_upload', '涓婁紶浼氳瘽鍙傛暟鏃犳晥銆?', false, error instanceof Error ? error.message : 'unknown_error'));
  }
});

app.put('/api/v1/video/uploads/:uploadId/parts/:partNumber', videoPartBody, async (request, response) => {
  const context = contextFromHeaders(request.headers);
  try {
    const auth = authFromRequest(request);
    if (!canMutate(auth)) { sendTransportError(response, 403, context, genericError('forbidden', 'video_upload', '褰撳墠瑙掕壊鏃犳潈涓婁紶鍒嗙墖銆?')); return; }
    const session = store.getVideoUpload(request.params.uploadId, auth.tenantId, auth.role === 'admin' ? undefined : auth.userId);
    if (!session) { sendTransportError(response, 404, context, genericError('upload_not_found', 'video_upload', '鏈壘鍒颁笂浼犱細璇濄€?')); return; }
    if (!Buffer.isBuffer(request.body)) throw new Error('upload_part_body_required');
    const nextSession = await saveVideoUploadPart(store, session, Number(request.params.partNumber), request.body, String(request.headers['content-range'] ?? ''), String(request.headers['x-part-sha256'] ?? ''));
    sendEnvelope(response, 200, createTransportEnvelope(context, {
      type: 'video-upload.part-completed', schema: 'video-upload-session.v1', data: nextSession, producer: 'business-api', idempotencyKey: `${session.upload_id}:part:${request.params.partNumber}:${request.headers['x-part-sha256']}`,
    }));
  } catch (error) {
    sendTransportError(response, 400, context, genericError(error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : 'upload_part_failed', 'video_upload', '瑙嗛鍒嗙墖鏍￠獙澶辫触銆?', false, error instanceof Error ? error.message : 'unknown_error'));
  }
});

app.get('/api/v1/video/uploads/:uploadId', (request, response) => {
  const context = contextFromHeaders(request.headers);
  const auth = authFromRequest(request);
  const session = store.getVideoUpload(request.params.uploadId, auth.tenantId, auth.role === 'admin' ? undefined : auth.userId);
  if (!session) { sendTransportError(response, 404, context, genericError('upload_not_found', 'video_upload', '鏈壘鍒颁笂浼犱細璇濄€?')); return; }
  sendEnvelope(response, 200, createTransportEnvelope(context, {
    type: 'video-upload.fetched', schema: 'video-upload-session.v1', data: session, producer: 'business-api', idempotencyKey: `${session.upload_id}:fetch:${session.updated_at}`,
  }));
});

app.post('/api/v1/video/uploads/:uploadId/complete', async (request, response) => {
  const context = contextFromHeaders(request.headers);
  try {
    const auth = authFromRequest(request);
    if (!canMutate(auth)) { sendTransportError(response, 403, context, genericError('forbidden', 'video_upload', '褰撳墠瑙掕壊鏃犳潈瀹屾垚涓婁紶銆?')); return; }
    const session = store.getVideoUpload(request.params.uploadId, auth.tenantId, auth.role === 'admin' ? undefined : auth.userId);
    if (!session) { sendTransportError(response, 404, context, genericError('upload_not_found', 'video_upload', '鏈壘鍒颁笂浼犱細璇濄€?')); return; }
    const task = await createTaskForUpload(store, session, auth, context.traceId);
    store.audit(auth.tenantId, auth.userId, 'video.analysis.created', 'video-analysis-task', task.task_id, {uploadId: session.upload_id, source: 'multipart-parts'});
    videoAnalysisWorker.enqueue(task.task_id);
    sendEnvelope(response, 202, createTransportEnvelope(context, {
      type: 'video-analysis.accepted', schema: 'video-analysis-task.v1', data: task, producer: 'business-api', idempotencyKey: `${session.upload_id}:complete`,
    }));
  } catch (error) {
    sendTransportError(response, 400, context, genericError(error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : 'upload_complete_failed', 'video_upload', '涓婁紶灏氭湭婊¤冻瀹屾垚鏉′欢銆?', false, error instanceof Error ? error.message : 'unknown_error'));
  }
});

app.post('/api/v1/video/analyze-url', async (request, response) => {
  const context = contextFromHeaders(request.headers);
  try {
    const auth = authFromRequest(request);
    if (!canMutate(auth)) { sendTransportError(response, 403, context, genericError('forbidden', 'video_url_import', '褰撳墠瑙掕壊鏃犳潈瀵煎叆瑙嗛 URL銆?')); return; }
    const parsed = videoUrlImportSchema.parse({...request.body, idempotency_key: request.body?.idempotency_key ?? request.headers['x-idempotency-key']});
    const task = await createTaskForUrl(store, parsed, auth, context.projectId, context.traceId);
    store.audit(auth.tenantId, auth.userId, 'video.analysis.created', 'video-analysis-task', task.task_id, {source: 'url', host: new URL(parsed.video_url).host});
    videoAnalysisWorker.enqueue(task.task_id);
    sendEnvelope(response, 202, createTransportEnvelope(context, {
      type: 'video-analysis.accepted', schema: 'video-analysis-task.v1', data: task, producer: 'business-api', idempotencyKey: parsed.idempotency_key ?? `${task.task_id}:create`,
    }));
  } catch (error) {
    sendTransportError(response, 400, context, genericError(error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : 'video_url_invalid', 'video_url_import', '瑙嗛 URL 鏈€氳繃鏍煎紡鎴栧畨鍏ㄦ牎楠屻€?', false, error instanceof Error ? error.message : 'unknown_error'));
  }
});

app.get('/api/v1/video/tasks/:taskId', (request, response) => {
  const context = contextFromHeaders(request.headers);
  const auth = authFromRequest(request);
  const task = store.getVideoAnalysisTask(request.params.taskId, auth.tenantId);
  if (!task || (auth.role !== 'admin' && task.owner_id !== auth.userId)) { sendTransportError(response, 404, context, genericError('video_task_not_found', 'video_analysis', '鏈壘鍒板垎鏋愪换鍔°€?')); return; }
  sendEnvelope(response, 200, createTransportEnvelope(context, {
    type: 'video-analysis.fetched', schema: 'video-analysis-task.v1', data: task, producer: 'business-api', idempotencyKey: `${task.task_id}:fetch:${task.updated_at}`,
  }));
});

app.post('/api/v1/video/tasks/:taskId/cancel', (request, response) => {
  const context = contextFromHeaders(request.headers);
  const auth = authFromRequest(request);
  const task = store.getVideoAnalysisTask(request.params.taskId, auth.tenantId);
  if (!task || (auth.role !== 'admin' && task.owner_id !== auth.userId)) { sendTransportError(response, 404, context, genericError('video_task_not_found', 'video_analysis', '鏈壘鍒板垎鏋愪换鍔°€?')); return; }
  if (!canMutate(auth) || ['completed', 'failed', 'cancelled'].includes(task.status)) { sendTransportError(response, 409, context, genericError('video_task_not_cancellable', 'video_analysis', '褰撳墠浠诲姟鐘舵€佷笉鍙彇娑堛€?')); return; }
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
  if (!task || (auth.role !== 'admin' && task.owner_id !== auth.userId)) { sendTransportError(response, 404, context, genericError('video_task_not_found', 'video_analysis', '鏈壘鍒板垎鏋愪换鍔°€?')); return; }
  if (!canMutate(auth) || task.status !== 'failed' || task.error?.retryable === false) { sendTransportError(response, 409, context, genericError('video_task_not_retryable', 'video_analysis', '褰撳墠浠诲姟涓嶅彲閲嶈瘯銆?')); return; }
  const next = videoAnalysisTaskSchema.parse({...task, status: 'queued', current_stage: 'queued', progress: 0, result: undefined, error: undefined, updated_at: new Date().toISOString()});
  store.clearVideoAnalysisCancel(task.task_id);
  store.saveVideoAnalysisTask(next);
  videoAnalysisWorker.enqueue(task.task_id);
  sendEnvelope(response, 202, createTransportEnvelope(context, {
    type: 'video-analysis.retry-accepted', schema: 'video-analysis-task.v1', data: next, producer: 'business-api', idempotencyKey: `${task.task_id}:retry:${next.updated_at}`,
  }));
});

app.post('/api/system/shutdown', (request, response) => {
  const auth = authFromRequest(request);
  const context = contextFromHeaders(request.headers);
  const remoteAddress = request.socket.remoteAddress ?? '';
  const localRequest = remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1';
  if (!localRequest || !canMutate(auth)) {
    sendTransportError(response, 403, context, genericError('forbidden', 'system_control', '浠呮湰鏈烘湁鏉冮檺鐨勭敤鎴峰彲浠ュ叧闂▼搴忋€?'));
    return;
  }
  if (!shutdownScheduled) {
    shutdownScheduled = true;
    console.log('[washcut] Local shutdown requested from the web app.');
    response.once('finish', () => setTimeout(closeLocalProgram, 100).unref());
  }
  sendEnvelope(response, 202, createTransportEnvelope(context, {
    type: 'system.shutdown-accepted', schema: 'command-result.v1', data: {accepted: true}, producer: 'business-api',
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
  if (!canMutate(auth)) { sendTransportError(response, 403, context, genericError('forbidden', 'key_management', '褰撳墠瑙掕壊鏃犳潈娣诲姞 Key銆?')); return; }
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
  if (!canMutate(auth)) { sendTransportError(response, 403, context, genericError('forbidden', 'key_management', '褰撳墠瑙掕壊鏃犳潈鑾峰彇妯″瀷鍒楄〃銆?')); return; }
  const input = relayModelDiscoveryInputSchema.parse(request.body);
  const stored = input.keyId ? store.getRelayKey(input.keyId, auth.tenantId) : undefined;
  if (input.keyId && !stored) { sendTransportError(response, 404, context, genericError('relay_key_not_found', 'key_management', '鏈壘鍒版寚瀹?Key銆?')); return; }
  const apiKey = input.apiKey ?? stored?.apiKey;
  if (!apiKey) { sendTransportError(response, 400, context, genericError('relay_api_key_required', 'key_management', '璇峰厛濉啓 API Key銆?')); return; }
  try {
    const models = await new RelayClient({baseUrl: assertRelayBaseUrl(input.baseUrl), apiKey, model: stored?.model ?? 'model-discovery', timeoutMs: 30_000}).listModels();
    store.audit(auth.tenantId, auth.userId, 'relay-key.models-fetched', 'relay-key', input.keyId ?? 'unsaved', {baseUrl: input.baseUrl, modelCount: models.length});
    sendEnvelope(response, 200, createTransportEnvelope(context, {
      type: 'relay-models.fetched', schema: 'relay-model-list.v1', data: {models}, producer: 'business-api',
      idempotencyKey: `${context.jobId}:relay-models:${input.keyId ?? 'unsaved'}:${Date.now()}`,
    }));
  } catch (error) {
    const code = error instanceof RelayError ? error.code : 'relay_models_failed';
    const message = error instanceof RelayError ? error.message : '鑾峰彇涓婃父妯″瀷澶辫触銆?';
    sendTransportError(response, 502, context, genericError(code, 'key_management', message, error instanceof RelayError && error.retryable));
  }
});

app.patch('/api/keys/:keyId', (request, response) => {
  const auth = authFromRequest(request);
  const context = contextFromHeaders(request.headers);
  if (!canMutate(auth)) { sendTransportError(response, 403, context, genericError('forbidden', 'key_management', '褰撳墠瑙掕壊鏃犳潈淇敼 Key銆?')); return; }
  const existing = store.getRelayKey(request.params.keyId, auth.tenantId);
  if (!existing) { sendTransportError(response, 404, context, genericError('relay_key_not_found', 'key_management', '鏈壘鍒版寚瀹?Key銆?')); return; }
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
  if (!canMutate(auth)) { sendTransportError(response, 403, context, genericError('forbidden', 'key_management', '褰撳墠瑙掕壊鏃犳潈鍚敤 Key銆?')); return; }
  const stored = store.activateRelayKey(request.params.keyId, auth.tenantId, new Date().toISOString());
  if (!stored) { sendTransportError(response, 404, context, genericError('relay_key_not_found', 'key_management', '鏈壘鍒版寚瀹?Key銆?')); return; }
  const key = store.relayKeySummary(stored);
  store.audit(auth.tenantId, auth.userId, 'relay-key.activated', 'relay-key', key.keyId, {name: key.name, model: key.model});
  sendEnvelope(response, 200, createTransportEnvelope(context, {
    type: 'relay-key.activated', schema: 'relay-key.v1', data: key, producer: 'business-api', idempotencyKey: `${context.jobId}:relay-key:activate:${key.updatedAt}`,
  }));
});

app.post('/api/keys/:keyId/test', async (request, response) => {
  const auth = authFromRequest(request);
  const context = contextFromHeaders(request.headers);
  if (!canMutate(auth)) { sendTransportError(response, 403, context, genericError('forbidden', 'key_management', '褰撳墠瑙掕壊鏃犳潈娴嬭瘯 Key銆?')); return; }
  const key = store.getRelayKey(request.params.keyId, auth.tenantId);
  if (!key) { sendTransportError(response, 404, context, genericError('relay_key_not_found', 'key_management', '鏈壘鍒版寚瀹?Key銆?')); return; }
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
  chat_messages_invalid: '瀵硅瘽娑堟伅鏍煎紡鏃犳晥銆?',
  chat_image_count_exceeded: '鍗曟鏈€澶氶€夋嫨 10 寮犲浘鐗囥€?',
  chat_image_too_large: '鍗曞紶鍥剧墖涓嶈兘瓒呰繃 15 MiB銆?',
  chat_images_too_large: '鏈鍥剧墖鍚堣涓嶈兘瓒呰繃 60 MiB銆?',
  chat_image_type_invalid: '浠呮敮鎸?JPEG銆丳NG銆乄ebP銆丟IF 鍥剧墖銆?',
};

app.post('/api/keys/:keyId/chat', chatTestUpload.array('images', 10), async (request, response) => {
  const auth = authFromRequest(request);
  const context = contextFromHeaders(request.headers);
  const files = (request.files ?? []) as Express.Multer.File[];
  try {
    if (!canMutate(auth)) { sendTransportError(response, 403, context, genericError('forbidden', 'key_chat', '褰撳墠瑙掕壊鏃犳潈杩涜瀵硅瘽娴嬭瘯銆?')); return; }
    const keyId = request.params.keyId;
    if (typeof keyId !== 'string') throw new Error('relay_key_not_found');
    const key = store.getRelayKey(keyId, auth.tenantId);
    if (!key) { sendTransportError(response, 404, context, genericError('relay_key_not_found', 'key_chat', '鏈壘鍒版寚瀹?Key銆?')); return; }
    const rawMessages = typeof request.body.messages === 'string' ? JSON.parse(request.body.messages) : request.body.messages;
    const input = relayChatInputSchema.safeParse({messages: rawMessages});
    if (!input.success) throw new Error('chat_messages_invalid');
    const media = await prepareChatTestImages(files.map((file) => ({path: file.path, sizeBytes: file.size, fileName: decodeMultipartFilename(file.originalname)})));
    const started = Date.now();
    const reply = await createLoggedRelay({baseUrl: key.baseUrl, apiKey: key.apiKey, model: key.model, timeoutMs: 60_000}, auth.tenantId, key.keyId)
      .requestChat(input.data.messages, media.imageUrls, undefined, {
        ownerId: auth.userId,
        projectId: context.projectId,
        jobId: context.jobId,
        source: 'relay.chat-test',
      });
    const latencyMs = Date.now() - started;
    store.audit(auth.tenantId, auth.userId, 'relay-key.chat-tested', 'relay-key', key.keyId, {model: key.model, latencyMs, messageCount: input.data.messages.length, uploadedImageCount: media.uploadedImageCount});
    sendEnvelope(response, 200, createTransportEnvelope(context, {
      type: 'relay-chat.completed', schema: 'relay-chat-result.v1', data: {reply, model: key.model, latencyMs},
      producer: 'business-api', idempotencyKey: `${context.jobId}:relay-chat:${key.keyId}:${Date.now()}`,
    }));
  } catch (error) {
    const code = error instanceof RelayError ? error.code : error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : 'relay_chat_failed';
    const message = error instanceof RelayError ? error.message : chatTestErrorMessages[code] ?? '妯″瀷瀵硅瘽澶辫触銆?';
    const status = error instanceof RelayError ? 502 : code.startsWith('chat_') ? 400 : 500;
    sendTransportError(response, status, context, genericError(code, 'key_chat', message, error instanceof RelayError && error.retryable));
  } finally {
    await Promise.all(files.map((file) => rm(file.path, {force: true}).catch(() => undefined)));
  }
});

const protocolTestErrorMessages: Record<string, string> = {
  protocol_prompt_required: '璇峰厛杈撳叆娴嬭瘯娑堟伅銆?',
  protocol_prompt_too_long: '娴嬭瘯娑堟伅鏈€澶?8,000 涓瓧绗︺€?',
  protocol_files_limit: '鍗曟鏈€澶氶€夋嫨 10 涓浘鐗囨垨瑙嗛鏂囦欢銆?',
  protocol_image_count_exceeded: '鍥剧墖鍜岃棰戞娊鍙栧嚭鐨勫叧閿抚鍚堣鏈€澶?10 寮犮€傝鍑忓皯鏂囦欢鎴栬棰戞暟閲忋€?',
  protocol_image_too_large: '鍗曞紶鍥剧墖鍘熷鏁版嵁涓嶈兘瓒呰繃 15 MiB銆?',
  protocol_images_too_large: '鏈鍙戦€佺殑鍥剧墖鍘熷鏁版嵁鍚堣涓嶈兘瓒呰繃 60 MiB銆?',
  protocol_video_too_large: '鍗曚釜瑙嗛涓嶈兘瓒呰繃 250 MiB銆?',
  protocol_videos_too_large: '鏈瑙嗛鍚堣涓嶈兘瓒呰繃 250 MiB銆?',
  protocol_image_type_invalid: '浠呮敮鎸?JPEG銆丳NG銆乄ebP銆丟IF 鍥剧墖銆?',
  protocol_media_type_invalid: '浠呮敮鎸?JPEG銆丳NG銆乄ebP銆丟IF銆丮P4銆乄ebM 鏂囦欢銆?',
  protocol_video_stream_missing: '瑙嗛涓病鏈夊彲璇诲彇鐨勮棰戣建閬撱€?',
};

app.post('/api/keys/:keyId/protocol-test', protocolTestUpload.array('files', 10), async (request, response) => {
  const auth = authFromRequest(request);
  const context = contextFromHeaders(request.headers);
  const files = (request.files ?? []) as Express.Multer.File[];
  try {
    if (!canMutate(auth)) { sendTransportError(response, 403, context, genericError('forbidden', 'relay_protocol_test', '褰撳墠瑙掕壊鏃犳潈杩涜閫氫俊娴嬭瘯銆?')); return; }
    const keyId = request.params.keyId;
    if (typeof keyId !== 'string') throw new Error('relay_key_not_found');
    const key = store.getRelayKey(keyId, auth.tenantId);
    if (!key) { sendTransportError(response, 404, context, genericError('relay_key_not_found', 'relay_protocol_test', '鏈壘鍒版寚瀹?Key銆?')); return; }
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
    const message = error instanceof RelayError ? error.message : protocolTestErrorMessages[code] ?? '鏃犳硶澶勭悊涓婁紶濯掍綋锛岃妫€鏌ユ枃浠舵牸寮忓悗閲嶈瘯銆?';
    const status = error instanceof RelayError ? 502 : code.startsWith('protocol_') ? 400 : 500;
    sendTransportError(response, status, context, genericError(code, 'relay_protocol_test', message, error instanceof RelayError && error.retryable));
  } finally {
    await Promise.all(files.map((file) => rm(file.path, {force: true}).catch(() => undefined)));
  }
});

app.delete('/api/keys/:keyId', (request, response) => {
  const auth = authFromRequest(request);
  const context = contextFromHeaders(request.headers);
  if (!canMutate(auth)) { sendTransportError(response, 403, context, genericError('forbidden', 'key_management', '褰撳墠瑙掕壊鏃犳潈鍒犻櫎 Key銆?')); return; }
  if (!store.deleteRelayKey(request.params.keyId, auth.tenantId)) { sendTransportError(response, 404, context, genericError('relay_key_not_found', 'key_management', '鏈壘鍒版寚瀹?Key銆?')); return; }
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
  const status = request.query.status === 'completed' || request.query.status === 'failed' ? request.query.status : undefined;
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
  if (!conversation) { response.status(404).json({error: {message: '鏈壘鍒版ā鍨嬪璇濊褰曘€?'}}); return; }
  response.json(conversation);
});

app.post('/api/assets', upload.array('files', 20), async (request, response, next) => {
  const context = contextFromHeaders(request.headers);
  const files = (request.files ?? []) as Express.Multer.File[];
  try {
    const auth = authFromRequest(request);
    if (!canMutate(auth)) { sendTransportError(response, 403, context, genericError('forbidden', 'asset_upload', '褰撳墠瑙掕壊鏃犳潈涓婁紶绱犳潗銆?')); return; }
    if (auth.tenantId !== context.tenantId) throw new Error('tenant_context_mismatch');
    if (!files.length) { sendTransportError(response, 400, context, genericError('asset_files_required', 'asset_upload', '鑷冲皯闇€瑕佷笂浼犱竴涓獟浣撴枃浠躲€?')); return; }
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
    if (!canMutate(auth)) { sendTransportError(response, 403, fallbackContext, genericError('forbidden', 'business_api', '褰撳墠瑙掕壊鏃犳潈鍒涘缓浠诲姟銆?')); return; }
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
    sendTransportError(response, 400, fallbackContext, genericError('invalid_transport_message', 'business_api', '璇锋眰鏈€氳繃韬唤銆佸綊灞炴垨 Schema 鏍￠獙銆?', false, error instanceof Error ? error.message : 'unknown_error'), outer.success ? outer.data.eventId : undefined);
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
  if (!job || !canReadJob(auth, job)) { sendTransportError(response, 404, context, genericError('job_not_found', 'business_api', '鏈壘鍒版寚瀹氫换鍔°€?')); return; }
  sendEnvelope(response, 200, createTransportEnvelope(context, {
    type: 'render-job.fetched', schema: 'render-job.v1', data: refreshJobLinks(job), producer: 'business-api', idempotencyKey: `${job.jobId}:fetch:${job.updatedAt}`,
  }));
});

app.get('/api/jobs/:jobId/events', (request, response) => {
  const auth = authFromRequest(request);
  const job = store.getJob(request.params.jobId);
  const context = job ? contextForJob(job) : contextFromHeaders(request.headers);
  if (!job || !canReadJob(auth, job)) { sendTransportError(response, 404, context, genericError('job_not_found', 'business_api', '鏈壘鍒版寚瀹氫换鍔°€?')); return; }
  const events = store.getEvents(job.jobId);
  sendEnvelope(response, 200, createTransportEnvelope(context, {
    type: 'event-batch.fetched', schema: 'event-batch.v1', data: {events}, producer: 'business-api', idempotencyKey: `${job.jobId}:events:${events.length}`,
  }));
});

app.delete('/api/jobs/:jobId', (request, response) => {
  const auth = authFromRequest(request);
  const job = store.getJob(request.params.jobId);
  const context = job ? contextForJob(job) : contextFromHeaders(request.headers);
  if (!job || !canReadJob(auth, job)) { sendTransportError(response, 404, context, genericError('job_not_found', 'business_api', '鏈壘鍒版寚瀹氫换鍔°€?')); return; }
  if (!canMutate(auth)) { sendTransportError(response, 403, context, genericError('forbidden', 'business_api', '褰撳墠瑙掕壊鏃犳潈鍙栨秷浠诲姟銆?')); return; }
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
  if (!job || !canReadJob(auth, job)) { sendTransportError(response, 404, context, genericError('job_not_found', 'business_api', '鏈壘鍒版寚瀹氫换鍔°€?')); return; }
  if (!canMutate(auth) || job.status !== 'failed') { sendTransportError(response, 409, context, genericError('job_not_retryable', 'business_api', '褰撳墠浠诲姟鐘舵€佷笉鍙噸璇曘€?')); return; }
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
  if (!job || !canReadJob(auth, job)) { sendTransportError(response, 404, context, genericError('job_not_found', 'business_api', '鏈壘鍒版寚瀹氫换鍔°€?')); return; }
  const status = request.body?.status === 'approved' ? 'approved' : request.body?.status === 'returned' ? 'returned' : undefined;
  if (!canMutate(auth) || !status) { sendTransportError(response, 400, context, genericError('invalid_review', 'business_api', '澶嶆牳鐘舵€佸繀椤绘槸 approved 鎴?returned銆?')); return; }
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
  const message = error instanceof Error ? error.message : '璇锋眰澶勭悊澶辫触銆?';
  const code = /^[a-z0-9_]+$/.test(message) ? message : 'request_failed';
  sendTransportError(response, 400, context, genericError(code, 'business_api', '璇锋眰澶勭悊澶辫触锛屾枃浠舵湭杩涘叆椤圭洰銆?', false, message.slice(0, 800)));
});

app.listen(port, '127.0.0.1', () => {
  console.log(`[washcut] API ready on http://127.0.0.1:${port} (automatic orchestration + sqlite storage)`);
  worker.recover();
  videoAnalysisWorker.recover();
  autoVideoWorker.recover();
});

