import {createHash, createHmac, randomUUID} from 'node:crypto';
import {lookup} from 'node:dns/promises';
import {createReadStream} from 'node:fs';
import {mkdir, open, rm, stat, writeFile} from 'node:fs/promises';
import {isIP} from 'node:net';
import path from 'node:path';
import {
  videoAnalysisResultSchema,
  videoAnalysisTaskSchema,
  videoUploadSessionSchema,
  type TransportError,
  type VideoAnalysisResult,
  type VideoAnalysisTask,
  type VideoUploadCreate,
  type VideoUploadSession,
  type VideoUrlImport,
} from '../shared/contracts.js';
import type {AuthContext} from './auth.js';
import {processUploadedMedia, readInlineAnalysisImages} from './media.js';
import {RelayClient} from './relay-client.js';
import {SqliteStore, type StoredAsset} from './store.js';

const dataRoot = path.resolve(process.env.DATA_ROOT ?? path.join(process.cwd(), 'data'));
const partRoot = path.join(dataRoot, 'video-upload-parts');
const tempRoot = path.join(dataRoot, 'tmp');
const maxRemoteBytes = Number(process.env.VIDEO_IMPORT_MAX_BYTES ?? 250 * 1024 * 1024);
const webhookSecret = process.env.WEBHOOK_SIGNING_SECRET ?? process.env.MEDIA_SIGNING_SECRET ?? 'washcut-local-webhook-signing-secret';
export const videoPartSizeBytes = Number(process.env.VIDEO_PART_SIZE_BYTES ?? 8 * 1024 * 1024);

const taskError = (code: string, stage: string, message: string, retryable = false, details?: unknown): TransportError => ({code, stage, message, retryable, details});

const isPrivateAddress = (address: string) => {
  if (isIP(address) === 4) {
    const octets = address.split('.').map(Number);
    const [a, b] = octets;
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    return normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd')
      || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')
      || normalized.startsWith('ff') || normalized.startsWith('::ffff:127.') || normalized.startsWith('::ffff:10.')
      || normalized.startsWith('::ffff:192.168.');
  }
  return true;
};

export const assertPublicHttpsUrl = async (value: string) => {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('video_url_not_allowed');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) throw new Error('video_url_not_allowed');
  const addresses = isIP(hostname) ? [{address: hostname}] : await lookup(hostname, {all: true, verbatim: true});
  if (!addresses.length || addresses.some(({address}) => isPrivateAddress(address))) throw new Error('video_url_not_allowed');
  return url;
};

const uploadPartDirectory = (session: VideoUploadSession) => path.join(partRoot, session.tenant_id, session.upload_id);

export const createVideoUploadSession = (store: SqliteStore, auth: AuthContext, projectId: string, input: VideoUploadCreate) => {
  if (input.idempotency_key) {
    const existing = store.getVideoUploadByIdempotency(auth.tenantId, input.idempotency_key);
    if (existing) return existing;
  }
  const now = new Date();
  const session = videoUploadSessionSchema.parse({
    upload_id: `upl_${randomUUID()}`,
    tenant_id: auth.tenantId,
    owner_id: auth.userId,
    project_id: projectId,
    filename: path.basename(input.filename),
    mime_type: input.mime_type,
    size_bytes: input.size_bytes,
    sha256: input.sha256.toLowerCase(),
    part_size_bytes: videoPartSizeBytes,
    total_parts: Math.ceil(input.size_bytes / videoPartSizeBytes),
    part_upload_url_template: `/api/v1/video/uploads/{upload_id}/parts/{part_number}`,
    completed_part_numbers: [],
    status: 'created',
    prompt: input.prompt,
    language: input.language,
    callback_url: input.callback_url,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
  });
  store.saveVideoUpload(session, input.idempotency_key);
  return session;
};

const assertUploadMutable = (session: VideoUploadSession) => {
  if (Date.parse(session.expires_at) <= Date.now()) throw new Error('upload_expired');
  if (!['created', 'uploading'].includes(session.status)) throw new Error('upload_not_mutable');
};

export const saveVideoUploadPart = async (store: SqliteStore, session: VideoUploadSession, partNumber: number, bytes: Buffer, contentRange: string, claimedSha256: string) => {
  assertUploadMutable(session);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > session.total_parts) throw new Error('upload_part_number_invalid');
  const start = (partNumber - 1) * session.part_size_bytes;
  const expectedSize = Math.min(session.part_size_bytes, session.size_bytes - start);
  const end = start + expectedSize - 1;
  if (contentRange !== `bytes ${start}-${end}/${session.size_bytes}` || bytes.length !== expectedSize) throw new Error('upload_content_range_invalid');
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (!/^[a-f0-9]{64}$/i.test(claimedSha256) || digest !== claimedSha256.toLowerCase()) throw new Error('upload_part_sha256_mismatch');
  const existing = store.listVideoUploadParts(session.upload_id).find((part) => part.part_number === partNumber);
  if (existing) {
    if (existing.sha256 !== digest || existing.size_bytes !== bytes.length) throw new Error('upload_part_conflict');
    return videoUploadSessionSchema.parse({...session, status: 'uploading', completed_part_numbers: store.listVideoUploadParts(session.upload_id).map((part) => part.part_number), updated_at: new Date().toISOString()});
  }
  const directory = uploadPartDirectory(session);
  await mkdir(directory, {recursive: true});
  const filePath = path.join(directory, `${String(partNumber).padStart(8, '0')}.part`);
  await writeFile(filePath, bytes);
  store.saveVideoUploadPart({uploadId: session.upload_id, partNumber, sizeBytes: bytes.length, sha256: digest, filePath});
  const completed = store.listVideoUploadParts(session.upload_id).map((part) => part.part_number).sort((a, b) => a - b);
  // `video_upload_parts` is authoritative. The session field is only a
  // response/cache projection and is intentionally never written here, so
  // concurrent part uploads cannot overwrite each other's progress.
  return videoUploadSessionSchema.parse({...session, status: 'uploading', completed_part_numbers: completed, updated_at: new Date().toISOString()});
};

export const assembleVideoUpload = async (store: SqliteStore, session: VideoUploadSession) => {
  const parts = store.listVideoUploadParts(session.upload_id);
  if (parts.length !== session.total_parts || parts.some((part, index) => part.part_number !== index + 1)) throw new Error('upload_parts_incomplete');
  await mkdir(tempRoot, {recursive: true});
  const outputPath = path.join(tempRoot, `${session.upload_id}.upload`);
  const output = await open(outputPath, 'w');
  const hash = createHash('sha256');
  let offset = 0;
  try {
    for (const part of parts) {
      const partHash = createHash('sha256');
      let partOffset = 0;
      for await (const chunk of createReadStream(part.file_path)) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        partHash.update(bytes);
        hash.update(bytes);
        await output.write(bytes, 0, bytes.length, offset);
        offset += bytes.length;
        partOffset += bytes.length;
      }
      if (partOffset !== part.size_bytes || partHash.digest('hex') !== part.sha256) throw new Error('upload_part_corrupted');
    }
  } finally {
    await output.close();
  }
  if (offset !== session.size_bytes || hash.digest('hex') !== session.sha256) {
    await rm(outputPath, {force: true});
    throw new Error('upload_sha256_mismatch');
  }
  return outputPath;
};

const downloadRemoteVideo = async (source: string, expectedSha256: string | undefined, signal: AbortSignal) => {
  await mkdir(tempRoot, {recursive: true});
  const outputPath = path.join(tempRoot, `url_${randomUUID()}.upload`);
  let current = await assertPublicHttpsUrl(source);
  let response: Response | undefined;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    response = await fetch(current, {redirect: 'manual', signal, headers: {'user-agent': 'washcut-video-import/1.0', accept: 'video/mp4,video/webm'}});
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    if (!location || redirects === 3) throw new Error('video_url_redirect_invalid');
    current = await assertPublicHttpsUrl(new URL(location, current).toString());
  }
  if (!response?.ok || !response.body) throw new Error(`video_url_http_${response?.status ?? 0}`);
  const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!['video/mp4', 'video/webm'].includes(contentType)) throw new Error('video_url_content_type_invalid');
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (declaredLength > maxRemoteBytes) throw new Error('video_url_too_large');
  const handle = await open(outputPath, 'w');
  const hash = createHash('sha256');
  let sizeBytes = 0;
  try {
    const reader = response.body.getReader();
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      if (signal.aborted) throw new Error('cancelled');
      sizeBytes += value.byteLength;
      if (sizeBytes > maxRemoteBytes) throw new Error('video_url_too_large');
      hash.update(value);
      await handle.write(value);
    }
  } catch (error) {
    await handle.close();
    await rm(outputPath, {force: true});
    throw error;
  }
  await handle.close();
  const sha256 = hash.digest('hex');
  if (expectedSha256 && sha256 !== expectedSha256.toLowerCase()) {
    await rm(outputPath, {force: true});
    throw new Error('video_url_sha256_mismatch');
  }
  const fileName = path.basename(decodeURIComponent(current.pathname)) || `remote${contentType === 'video/webm' ? '.webm' : '.mp4'}`;
  return {tempPath: outputPath, fileName, contentType, sizeBytes, sourceUrl: current.toString()};
};

type CreateTaskArgs = {
  auth: AuthContext;
  projectId: string;
  traceId: string;
  assetId: string;
  prompt: string;
  language: string;
  callbackUrl?: string;
  uploadId?: string;
  sourceUrl?: string;
  sourceSha256?: string;
  idempotencyKey?: string;
};

export const createVideoAnalysisTask = async (store: SqliteStore, args: CreateTaskArgs) => {
  if (args.idempotencyKey) {
    const existing = store.getVideoAnalysisTaskByIdempotency(args.auth.tenantId, args.idempotencyKey);
    if (existing) return existing;
  }
  if (args.callbackUrl) await assertPublicHttpsUrl(args.callbackUrl);
  const now = new Date().toISOString();
  const task = videoAnalysisTaskSchema.parse({
    task_id: `task_vid_${randomUUID()}`,
    tenant_id: args.auth.tenantId,
    owner_id: args.auth.userId,
    project_id: args.projectId,
    trace_id: args.traceId,
    upload_id: args.uploadId,
    asset_id: args.assetId,
    source_url: args.sourceUrl,
    source_sha256: args.sourceSha256,
    prompt: args.prompt,
    language: args.language,
    callback_url: args.callbackUrl,
    status: 'queued',
    progress: 0,
    current_stage: 'queued',
    created_at: now,
    updated_at: now,
  });
  store.saveVideoAnalysisTask(task, args.idempotencyKey);
  return task;
};

export const createTaskForUpload = async (store: SqliteStore, session: VideoUploadSession, auth: AuthContext, traceId: string) => {
  if (session.task_id) {
    const existing = store.getVideoAnalysisTask(session.task_id, auth.tenantId);
    if (existing) return existing;
  }
  const completedParts = store.listVideoUploadParts(session.upload_id);
  if (completedParts.length !== session.total_parts || completedParts.some((part, index) => part.part_number !== index + 1)) throw new Error('upload_parts_incomplete');
  const task = await createVideoAnalysisTask(store, {
    auth, projectId: session.project_id, traceId, assetId: `ast_${randomUUID()}`,
    prompt: session.prompt, language: session.language, callbackUrl: session.callback_url, uploadId: session.upload_id,
    idempotencyKey: `${session.upload_id}:complete`,
  });
  const next = videoUploadSessionSchema.parse({...session, status: 'completed', task_id: task.task_id, updated_at: new Date().toISOString()});
  store.saveVideoUpload(next);
  return task;
};

export const createTaskForUrl = async (store: SqliteStore, input: VideoUrlImport, auth: AuthContext, projectId: string, traceId: string) => {
  await assertPublicHttpsUrl(input.video_url);
  return createVideoAnalysisTask(store, {
    auth, projectId, traceId, assetId: `ast_${randomUUID()}`, prompt: input.prompt, language: input.language,
    callbackUrl: input.callback_url, sourceUrl: input.video_url, sourceSha256: input.sha256, idempotencyKey: input.idempotency_key,
  });
};

const localAnalysis = (task: VideoAnalysisTask, asset: StoredAsset): VideoAnalysisResult => {
  const duration = (asset.durationMs ?? 0) / 1000;
  const segmentCount = Math.max(1, Math.min(3, asset.keyframePaths.length || 1));
  const timeline = Array.from({length: segmentCount}, (_, index) => {
    const start = Number((duration * index / segmentCount).toFixed(3));
    const end = Number((duration * (index + 1) / segmentCount).toFixed(3));
    return {start, end, description: index === 0 ? '视频开场画面' : index === segmentCount - 1 ? '视频结束画面' : '视频中段画面', tags: ['keyframe']};
  });
  const warnings = ['当前为本地确定性分析，仅描述媒体结构和采样位置，不臆测画面内容。'];
  if (asset.hasAudio) warnings.push('未配置语音识别服务，音轨存在但 transcript 暂为空。');
  return videoAnalysisResultSchema.parse({
    summary: `已按“${task.prompt}”完成媒体探测与关键帧采样。视频时长 ${duration.toFixed(1)} 秒，${asset.width}×${asset.height}，共生成 ${segmentCount} 个时间轴片段。`,
    transcript: [],
    timeline,
    entities: [],
    metadata: {
      duration_seconds: duration, width: asset.width, height: asset.height, fps: asset.fps ?? 0,
      has_audio: asset.hasAudio ?? false, source_sha256: asset.sha256, model_version: 'local-keyframe-analysis.v1',
      prompt: task.prompt, language: task.language, warnings,
    },
  });
};

const relayAnalysis = async (task: VideoAnalysisTask, asset: StoredAsset, relay: RelayClient, signal: AbortSignal) => {
  const images = await readInlineAnalysisImages([asset]);
  const duration = (asset.durationMs ?? 0) / 1000;
  const candidate = videoAnalysisResultSchema.parse(await relay.requestJson(
    '你是视频分析 Agent。根据按时间顺序提供的关键帧和可信媒体元数据，输出严格的 video-analysis-result.v1 JSON。不得臆造对白；没有语音识别证据时 transcript 必须为空。timeline 时间必须在视频时长内，summary 应直接回应 prompt。',
    {schema: 'video-analysis-input.v1', prompt: task.prompt, language: task.language, metadata: {duration_seconds: duration, width: asset.width, height: asset.height, fps: asset.fps ?? 0, has_audio: asset.hasAudio ?? false}},
    signal,
    images,
    {
      ownerId: task.owner_id,
      projectId: task.project_id,
      taskId: task.task_id,
      assetId: asset.assetId,
      source: 'video-analysis.visual-analysis',
    },
  ));
  if (candidate.timeline.some((item) => item.end > duration + 0.05)) throw new Error('video_analysis_timeline_out_of_bounds');
  return videoAnalysisResultSchema.parse({
    ...candidate,
    metadata: {
      ...candidate.metadata,
      duration_seconds: duration, width: asset.width, height: asset.height, fps: asset.fps ?? 0,
      has_audio: asset.hasAudio ?? false, source_sha256: asset.sha256, model_version: relay.model,
      prompt: task.prompt, language: task.language,
    },
  });
};

const webhookPayload = (task: VideoAnalysisTask, eventId: string) => ({
  event: task.status === 'completed' ? 'video.analysis.completed' : 'video.analysis.failed',
  event_id: eventId,
  task_id: task.task_id,
  status: task.status,
  result_url: `${process.env.PUBLIC_API_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`}/api/v1/video/tasks/${task.task_id}`,
});

const deliverWebhook = async (store: SqliteStore, task: VideoAnalysisTask, attempt = 1, eventId = `evt_${randomUUID()}`): Promise<void> => {
  if (!task.callback_url) return;
  try {
    await assertPublicHttpsUrl(task.callback_url);
    const body = JSON.stringify(webhookPayload(task, eventId));
    const signature = createHmac('sha256', webhookSecret).update(body).digest('hex');
    const response = await fetch(task.callback_url, {method: 'POST', headers: {'content-type': 'application/json', 'x-signature': signature, 'x-event-id': eventId}, body, signal: AbortSignal.timeout(10_000)});
    if (!response.ok) throw new Error(`webhook_http_${response.status}`);
    store.saveWebhookDelivery({eventId, taskId: task.task_id, targetUrl: task.callback_url, attempt, status: 'completed'});
  } catch (error) {
    store.saveWebhookDelivery({eventId, taskId: task.task_id, targetUrl: task.callback_url, attempt, status: 'failed', error: error instanceof Error ? error.message : 'unknown_error'});
    const delays = [60_000, 5 * 60_000, 30 * 60_000];
    const delay = delays[attempt - 1];
    if (delay) setTimeout(() => void deliverWebhook(store, task, attempt + 1, eventId), delay).unref();
  }
};

type RelayResolver = (tenantId: string) => RelayClient | undefined;

export class VideoAnalysisWorker {
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private running = 0;
  private readonly concurrency = Math.max(1, Number(process.env.VIDEO_ANALYSIS_CONCURRENCY ?? 1));

  constructor(private readonly store: SqliteStore, private readonly resolveRelay?: RelayResolver) {}

  recover() {
    for (const task of this.store.listRecoverableVideoAnalysisTasks()) this.enqueue(task.task_id);
  }

  enqueue(taskId: string) {
    if (this.queued.has(taskId) || this.controllers.has(taskId)) return;
    this.queue.push(taskId);
    this.queued.add(taskId);
    this.drain();
  }

  cancel(taskId: string) {
    this.controllers.get(taskId)?.abort();
  }

  private drain() {
    while (this.running < this.concurrency && this.queue.length) {
      const taskId = this.queue.shift();
      if (!taskId) return;
      this.queued.delete(taskId);
      this.running += 1;
      void this.run(taskId).finally(() => {
        this.running -= 1;
        this.controllers.delete(taskId);
        this.drain();
      });
    }
  }

  private update(task: VideoAnalysisTask, patch: Partial<VideoAnalysisTask>) {
    const next = videoAnalysisTaskSchema.parse({...task, ...patch, updated_at: new Date().toISOString()});
    this.store.saveVideoAnalysisTask(next);
    console.log(JSON.stringify({timestamp: next.updated_at, level: 'info', event: 'video_analysis.stage_changed', taskId: next.task_id, traceId: next.trace_id, tenantId: next.tenant_id, stage: next.current_stage, progress: next.progress}));
    return next;
  }

  private assertActive(task: VideoAnalysisTask, signal: AbortSignal) {
    if (signal.aborted || this.store.isVideoAnalysisCancelRequested(task.task_id)) throw new Error('cancelled');
  }

  private async materializeAsset(task: VideoAnalysisTask, signal: AbortSignal) {
    const existing = this.store.getAsset(task.asset_id, task.tenant_id);
    if (existing) return existing;
    let upload: {tempPath: string; fileName: string; contentType: string; sizeBytes: number};
    if (task.upload_id) {
      const session = this.store.getVideoUpload(task.upload_id, task.tenant_id, task.owner_id);
      if (!session) throw new Error('upload_not_found');
      upload = {tempPath: await assembleVideoUpload(this.store, session), fileName: session.filename, contentType: session.mime_type, sizeBytes: session.size_bytes};
    } else if (task.source_url) {
      upload = await downloadRemoteVideo(task.source_url, task.source_sha256, signal);
    } else {
      throw new Error('video_source_missing');
    }
    const asset = await processUploadedMedia({
      tempPath: upload.tempPath, originalName: upload.fileName, claimedType: upload.contentType, sizeBytes: upload.sizeBytes,
      tenantId: task.tenant_id, projectId: task.project_id, ownerId: task.owner_id, assetId: task.asset_id,
    });
    this.store.saveAsset(asset);
    if (task.upload_id) {
      const session = this.store.getVideoUpload(task.upload_id, task.tenant_id, task.owner_id);
      if (session) await rm(uploadPartDirectory(session), {recursive: true, force: true});
    }
    return asset;
  }

  private async run(taskId: string) {
    const controller = new AbortController();
    this.controllers.set(taskId, controller);
    let task = this.store.getVideoAnalysisTask(taskId);
    if (!task || ['completed', 'failed', 'cancelled'].includes(task.status)) return;
    try {
      task = this.update(task, {status: 'processing', current_stage: 'validating', progress: 5, error: undefined});
      this.assertActive(task, controller.signal);
      const asset = await this.materializeAsset(task, controller.signal);
      task = this.update(task, {current_stage: 'metadata', progress: 30});
      this.assertActive(task, controller.signal);
      task = this.update(task, {current_stage: 'transcription', progress: 55});
      this.assertActive(task, controller.signal);
      task = this.update(task, {current_stage: 'visual_analysis', progress: 75});
      const relay = this.resolveRelay?.(task.tenant_id);
      const result = relay ? await relayAnalysis(task, asset, relay, controller.signal) : localAnalysis(task, asset);
      this.assertActive(task, controller.signal);
      task = this.update(task, {current_stage: 'merging', progress: 90});
      task = this.update(task, {status: 'completed', current_stage: 'completed', progress: 100, result, error: undefined});
      this.store.audit(task.tenant_id, 'video-analysis-worker', 'video.analysis.completed', 'video-analysis-task', task.task_id, {assetId: task.asset_id, model: result.metadata.model_version});
      void deliverWebhook(this.store, task);
    } catch (error) {
      const latest = this.store.getVideoAnalysisTask(taskId);
      if (!latest) return;
      const source = error instanceof Error ? error as Error & {code?: unknown; retryable?: unknown} : undefined;
      const message = source?.message || String(error ?? 'unknown_error');
      const code = typeof source?.code === 'string' && source.code.trim() ? source.code : message;
      if (code === 'cancelled') {
        const cancelled = this.update(latest, {status: 'cancelled', current_stage: 'cancelled', error: undefined});
        void deliverWebhook(this.store, cancelled);
        return;
      }
      const failed = this.update(latest, {status: 'failed', current_stage: 'failed', error: taskError(
        code,
        latest.current_stage,
        message,
        typeof source?.retryable === 'boolean' ? source.retryable : !['video_url_not_allowed', 'upload_sha256_mismatch', 'asset_magic_mime_mismatch'].includes(code),
        message,
      )});
      this.store.audit(failed.tenant_id, 'video-analysis-worker', 'video.analysis.failed', 'video-analysis-task', failed.task_id, {error: failed.error});
      void deliverWebhook(this.store, failed);
    }
  }
}

export const validateUploadedFileSha256 = async (filePath: string, expected?: string) => {
  if (!expected) return;
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  if (hash.digest('hex') !== expected.toLowerCase()) throw new Error('upload_sha256_mismatch');
};

export const safeFileSize = async (filePath: string) => (await stat(filePath)).size;
