import {z} from 'zod';

export const sourceTypeSchema = z.enum(['user_upload', 'licensed_library', 'system_generated']);
export type SourceType = z.infer<typeof sourceTypeSchema>;

export const assetRefSchema = z.object({
  assetId: z.string().min(1),
  fileName: z.string().min(1),
  sha256: z.string().min(8),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fps: z.number().positive().optional(),
  hasAudio: z.boolean().optional(),
  sourceType: sourceTypeSchema,
  status: z.enum(['processing', 'ready', 'rejected']),
  previewUrl: z.string().optional(),
  thumbnailUrl: z.string().optional(),
  keyframeUrls: z.array(z.string()).default([]),
  license: z.object({
    recordId: z.string(),
    label: z.string(),
    expiresAt: z.string().datetime({offset: true}).nullable(),
  }).optional(),
}).strict();
export type AssetRef = z.infer<typeof assetRefSchema>;

export const projectInputSchema = z.object({
  projectId: z.string().min(1),
  storeName: z.string().min(2).max(40),
  region: z.string().min(2).max(40),
  offer: z.string().min(2).max(80),
  rules: z.string().min(2).max(160),
  cta: z.string().min(2).max(60),
  durationMs: z.union([z.literal(15_000), z.literal(30_000), z.literal(45_000), z.literal(60_000), z.literal(90_000), z.literal(120_000), z.literal(180_000)]),
  tone: z.enum(['direct', 'real', 'professional', 'relaxed']),
  allowLibrary: z.boolean(),
  assetIds: z.array(z.string().min(1)).min(1).max(20),
}).strict();
export type ProjectInput = z.infer<typeof projectInputSchema>;

export const assetSegmentSchema = z.object({
  segmentId: z.string(),
  assetId: z.string(),
  label: z.string(),
  tags: z.array(z.string()),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  keyframeUrl: z.string().optional(),
  usability: z.enum(['preferred', 'usable', 'limited']),
  authenticityRole: z.enum(['store_proof', 'service_process', 'result_proof', 'generic_only']),
}).strict();

export const assetManifestSchema = z.object({
  schema: z.literal('asset-manifest.v1'),
  assets: z.array(assetRefSchema),
  segments: z.array(assetSegmentSchema),
  coverage: z.object({
    storefront: z.boolean(),
    serviceProcess: z.boolean(),
    result: z.boolean(),
    logo: z.boolean(),
    effectiveDurationMs: z.number().int().nonnegative(),
    gaps: z.array(z.string()),
  }),
  analysis: z.object({
    promptVersion: z.string(),
    modelVersion: z.string(),
    elapsedMs: z.number().int().nonnegative(),
    tokenUsage: z.number().int().nonnegative(),
    estimatedCostCny: z.number().nonnegative(),
  }),
}).strict();
export type AssetManifest = z.infer<typeof assetManifestSchema>;

export const creativeSpecSchema = z.object({
  schema: z.literal('creative-spec.v1'),
  title: z.string(),
  hook: z.string(),
  voiceover: z.array(z.object({
    text: z.string(),
    factRefs: z.array(z.string()),
  })),
  narrativeBeats: z.array(z.object({
    id: z.string(),
    task: z.string(),
    preferredTags: z.array(z.string()),
  })),
  factLedger: z.record(z.string(), z.string()),
  generation: z.object({
    promptVersion: z.string(),
    modelVersion: z.string(),
    elapsedMs: z.number().int().nonnegative(),
  }),
}).strict();
export type CreativeSpec = z.infer<typeof creativeSpecSchema>;

export const mediaSourceSchema = z.object({
  assetId: z.string(),
  url: z.string(),
  contentType: z.string(),
  durationMs: z.number().int().nonnegative().optional(),
  sha256: z.string().min(8),
}).strict();

export const sceneSchema = z.object({
  sceneId: z.string(),
  narrativeTask: z.string(),
  assetId: z.string(),
  sourceType: sourceTypeSchema,
  media: mediaSourceSchema,
  sourceStartMs: z.number().int().nonnegative(),
  timelineStartMs: z.number().int().nonnegative(),
  durationMs: z.number().int().positive(),
  crop: z.object({x: z.number().min(0).max(1), y: z.number().min(0).max(1), scale: z.number().min(1).max(2)}),
  transition: z.enum(['cut', 'fade', 'slide']),
  headline: z.string(),
  subtitle: z.string(),
  captionPosition: z.enum(['upper', 'center', 'lower']),
  factRefs: z.array(z.string()),
  visualKey: z.enum(['storefront', 'pressure', 'foam', 'result']),
}).strict();

export const captionSchema = z.object({
  text: z.string(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  timestampMs: z.number().int().nullable(),
  confidence: z.number().nullable(),
}).strict();
export type Caption = z.infer<typeof captionSchema>;

export const audioAssetSchema = z.object({
  assetId: z.string(),
  url: z.string(),
  contentType: z.string(),
  provider: z.string(),
  license: z.string(),
  durationMs: z.number().int().positive().optional(),
}).strict();

export const videoSpecSchema = z.object({
  schema: z.literal('video-spec.v1'),
  version: z.string(),
  width: z.literal(1080),
  height: z.literal(1920),
  fps: z.literal(30),
  durationMs: z.number().int().positive(),
  storeName: z.string(),
  region: z.string(),
  offer: z.string(),
  cta: z.string(),
  scenes: z.array(sceneSchema).min(1),
  captions: z.array(captionSchema),
  audio: z.object({
    voice: audioAssetSchema.optional(),
    bgm: audioAssetSchema.optional(),
    duckingDb: z.number(),
  }),
  provenance: z.array(z.object({
    assetId: z.string(),
    sourceType: sourceTypeSchema,
    sha256: z.string().min(8),
    licenseRecordId: z.string().nullable(),
  })),
}).strict();
export type VideoSpec = z.infer<typeof videoSpecSchema>;

export const qualityReportSchema = z.object({
  schema: z.literal('quality-report.v1'),
  decision: z.enum(['passed', 'replan', 'failed']),
  checks: z.array(z.object({
    key: z.string(),
    label: z.string(),
    passed: z.boolean(),
    blocking: z.boolean(),
    detail: z.string(),
  })),
}).strict();
export type QualityReport = z.infer<typeof qualityReportSchema>;

export const artifactSchema = z.object({
  artifactId: z.string(),
  kind: z.enum(['video', 'cover', 'captions', 'provenance']),
  fileName: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().min(8),
  durationMs: z.number().int().nonnegative().optional(),
  downloadUrl: z.string().optional(),
}).strict();
export type Artifact = z.infer<typeof artifactSchema>;

export const jobStageSchema = z.enum([
  'queued',
  'asset_analysis',
  'creative_direction',
  'visual_direction',
  'audio_production',
  'rendering',
  'quality_check',
  'awaiting_review',
  'completed',
  'failed',
  'cancelled',
]);
export type JobStage = z.infer<typeof jobStageSchema>;

export const transportErrorSchema = z.object({
  // Preserve native, upstream, and tool-specific codes verbatim. Validation
  // errors may still use the conventional lowercase machine-readable form.
  code: z.string().min(1).max(2_000),
  stage: z.string().regex(/^[a-z0-9_]+$/),
  retryable: z.boolean(),
  message: z.string(),
  details: z.unknown().optional(),
}).strict();
export type TransportError = z.infer<typeof transportErrorSchema>;

export const relayKeySummarySchema = z.object({
  keyId: z.string().regex(/^key_[a-zA-Z0-9_-]+$/),
  name: z.string().min(1).max(40),
  baseUrl: z.url(),
  model: z.string().min(1).max(80),
  maskedKey: z.string().min(4),
  active: z.boolean(),
  createdAt: z.string().datetime({offset: true}),
  updatedAt: z.string().datetime({offset: true}),
}).strict();
export type RelayKeySummary = z.infer<typeof relayKeySummarySchema>;

export const relayKeyInputSchema = z.object({
  name: z.string().trim().min(1).max(40),
  baseUrl: z.url(),
  apiKey: z.string().trim().min(8).max(500),
  model: z.string().trim().min(1).max(80),
  active: z.boolean().optional(),
}).strict();
export type RelayKeyInput = z.infer<typeof relayKeyInputSchema>;

export const relayKeyUpdateSchema = relayKeyInputSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  {message: '至少需要更新一个字段'},
);
export type RelayKeyUpdate = z.infer<typeof relayKeyUpdateSchema>;

export const relayKeyBatchSchema = z.object({keys: z.array(relayKeySummarySchema)}).strict();
export const relayKeyTestResultSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().int().nonnegative(),
  message: z.string(),
}).strict();
export type RelayKeyTestResult = z.infer<typeof relayKeyTestResultSchema>;

export const relayModelDiscoveryInputSchema = z.object({
  keyId: z.string().regex(/^key_[a-zA-Z0-9_-]+$/).optional(),
  baseUrl: z.url(),
  apiKey: z.string().trim().min(8).max(500).optional(),
}).strict();
export type RelayModelDiscoveryInput = z.infer<typeof relayModelDiscoveryInputSchema>;

export const relayModelListSchema = z.object({
  models: z.array(z.string().min(1).max(80)).min(1),
}).strict();
export type RelayModelList = z.infer<typeof relayModelListSchema>;

export const relayChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(8_000),
}).strict();
export type RelayChatMessage = z.infer<typeof relayChatMessageSchema>;

export const relayChatInputSchema = z.object({
  messages: z.array(relayChatMessageSchema).min(1).max(12),
}).strict();
export type RelayChatInput = z.infer<typeof relayChatInputSchema>;

export const relayChatResultSchema = z.object({
  reply: z.string().min(1),
  model: z.string().min(1).max(80),
  latencyMs: z.number().int().nonnegative(),
}).strict();
export type RelayChatResult = z.infer<typeof relayChatResultSchema>;

export const relayProtocolTestResultSchema = z.object({
  reply: z.string().min(1),
  model: z.string().min(1).max(80),
  latencyMs: z.number().int().nonnegative(),
  inputImageCount: z.number().int().nonnegative().max(10),
  uploadedImageCount: z.number().int().nonnegative().max(10),
  uploadedVideoCount: z.number().int().nonnegative().max(10),
}).strict();
export type RelayProtocolTestResult = z.infer<typeof relayProtocolTestResultSchema>;

export const videoUploadStatusSchema = z.enum(['created', 'uploading', 'uploaded', 'completed', 'expired', 'failed']);
export type VideoUploadStatus = z.infer<typeof videoUploadStatusSchema>;

export const videoUploadCreateSchema = z.object({
  filename: z.string().trim().min(1).max(240),
  mime_type: z.enum(['video/mp4', 'video/webm']),
  size_bytes: z.number().int().positive().max(2 * 1024 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  prompt: z.string().trim().min(1).max(4_000).default('提取字幕，并按时间轴总结关键动作'),
  language: z.string().trim().min(2).max(32).default('zh-CN'),
  callback_url: z.url().optional(),
  idempotency_key: z.string().trim().min(8).max(160).optional(),
}).strict();
export type VideoUploadCreate = z.infer<typeof videoUploadCreateSchema>;

export const videoUploadSessionSchema = z.object({
  upload_id: z.string().regex(/^upl_[a-zA-Z0-9_-]+$/),
  tenant_id: z.string().min(3),
  owner_id: z.string().min(3),
  project_id: z.string().min(8),
  filename: z.string().min(1),
  mime_type: z.string().min(1),
  size_bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  part_size_bytes: z.number().int().positive(),
  total_parts: z.number().int().positive(),
  part_upload_url_template: z.string().min(1),
  completed_part_numbers: z.array(z.number().int().positive()),
  status: videoUploadStatusSchema,
  prompt: z.string(),
  language: z.string(),
  callback_url: z.url().optional(),
  task_id: z.string().optional(),
  created_at: z.string().datetime({offset: true}),
  updated_at: z.string().datetime({offset: true}),
  expires_at: z.string().datetime({offset: true}),
  error: transportErrorSchema.optional(),
}).strict();
export type VideoUploadSession = z.infer<typeof videoUploadSessionSchema>;

export const videoUrlImportSchema = z.object({
  video_url: z.url(),
  prompt: z.string().trim().min(1).max(4_000).default('提取字幕，并按时间轴总结关键动作'),
  language: z.string().trim().min(2).max(32).default('zh-CN'),
  callback_url: z.url().optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  idempotency_key: z.string().trim().min(8).max(160).optional(),
}).strict();
export type VideoUrlImport = z.infer<typeof videoUrlImportSchema>;

export const videoTranscriptItemSchema = z.object({
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  text: z.string(),
}).strict().refine((item) => item.end >= item.start, {message: 'transcript_end_before_start'});

export const videoTimelineItemSchema = z.object({
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  description: z.string(),
  tags: z.array(z.string()),
}).strict().refine((item) => item.end >= item.start, {message: 'timeline_end_before_start'});

export const videoAnalysisResultSchema = z.object({
  summary: z.string(),
  transcript: z.array(videoTranscriptItemSchema),
  timeline: z.array(videoTimelineItemSchema),
  entities: z.array(z.object({
    type: z.string(),
    label: z.string(),
    appearances: z.array(z.object({start: z.number().nonnegative(), end: z.number().nonnegative()}).strict()),
  }).strict()),
  metadata: z.object({
    duration_seconds: z.number().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().nonnegative(),
    has_audio: z.boolean(),
    source_sha256: z.string().regex(/^[a-f0-9]{64}$/i),
    model_version: z.string(),
    prompt: z.string(),
    language: z.string(),
    warnings: z.array(z.string()),
  }).strict(),
}).strict();
export type VideoAnalysisResult = z.infer<typeof videoAnalysisResultSchema>;

export const videoAnalysisTaskStatusSchema = z.enum(['queued', 'processing', 'completed', 'failed', 'cancelled']);
export const videoAnalysisTaskSchema = z.object({
  task_id: z.string().regex(/^task_vid_[a-zA-Z0-9_-]+$/),
  tenant_id: z.string().min(3),
  owner_id: z.string().min(3),
  project_id: z.string().min(8),
  trace_id: z.string().min(8),
  upload_id: z.string().optional(),
  asset_id: z.string().min(1),
  source_url: z.url().optional(),
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  prompt: z.string().min(1),
  language: z.string().min(2),
  callback_url: z.url().optional(),
  status: videoAnalysisTaskStatusSchema,
  progress: z.number().min(0).max(100),
  current_stage: z.enum(['queued', 'validating', 'metadata', 'transcription', 'visual_analysis', 'merging', 'callback', 'completed', 'failed', 'cancelled']),
  created_at: z.string().datetime({offset: true}),
  updated_at: z.string().datetime({offset: true}),
  result: videoAnalysisResultSchema.optional(),
  error: transportErrorSchema.optional(),
}).strict();
export type VideoAnalysisTask = z.infer<typeof videoAnalysisTaskSchema>;

export const renderJobSchema = z.object({
  schema: z.literal('render-job.v1'),
  jobId: z.string(),
  tenantId: z.string(),
  ownerId: z.string(),
  projectId: z.string(),
  traceId: z.string(),
  status: jobStageSchema,
  progress: z.number().min(0).max(100),
  mode: z.enum(['local', 'relay']),
  relayKeyId: z.string().regex(/^key_[a-zA-Z0-9_-]+$/).optional(),
  attempt: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
  input: projectInputSchema,
  assetManifest: assetManifestSchema.optional(),
  creativeSpec: creativeSpecSchema.optional(),
  videoSpec: videoSpecSchema.optional(),
  qualityReport: qualityReportSchema.optional(),
  artifacts: z.array(artifactSchema).default([]),
  review: z.object({
    status: z.enum(['pending', 'approved', 'returned']),
    reason: z.string().optional(),
    reviewedAt: z.string().optional(),
  }).optional(),
  error: transportErrorSchema.optional(),
}).strict();
export type RenderJob = z.infer<typeof renderJobSchema>;

export const envelopeSchema = z.object({
  version: z.literal('1.0'),
  type: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/),
  eventId: z.string().min(8),
  occurredAt: z.string().datetime({offset: true}),
  traceId: z.string().min(8),
  causationId: z.string().min(8).optional(),
  tenantId: z.string().min(3),
  projectId: z.string().min(8),
  jobId: z.string().min(8),
  producer: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  idempotencyKey: z.string().min(8),
  payload: z.object({
    schema: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*\.v[1-9][0-9]*$/),
    data: z.unknown(),
  }).strict(),
}).strict();

export type Envelope<T = unknown> = Omit<z.infer<typeof envelopeSchema>, 'payload'> & {
  payload: {schema: string; data: T};
};

export const assetBatchSchema = z.object({assets: z.array(assetRefSchema)}).strict();
export const uploadRequestSchema = z.object({fileNames: z.array(z.string().min(1)).min(1).max(20), fileCount: z.number().int().min(1).max(20)}).strict();
export const commandResultSchema = z.object({accepted: z.boolean()}).strict();
export const eventBatchSchema = z.object({events: z.array(envelopeSchema)}).strict();
export const jobBatchSchema = z.object({jobs: z.array(renderJobSchema)}).strict();
export const healthStatusSchema = z.object({
  ok: z.boolean(),
  mode: z.enum(['local', 'relay']),
  service: z.literal('washcut-agent-demo'),
  storage: z.literal('sqlite'),
}).strict();
export const creativeDirectionRequestSchema = z.object({input: projectInputSchema, manifest: assetManifestSchema}).strict();
export const visualDirectionRequestSchema = z.object({input: projectInputSchema, manifest: assetManifestSchema, creative: creativeSpecSchema}).strict();
export const qualityCheckRequestSchema = z.object({input: projectInputSchema, manifest: assetManifestSchema, video: videoSpecSchema}).strict();

export const schemaRegistry = {
  'project-input.v1': projectInputSchema,
  'asset-upload-request.v1': uploadRequestSchema,
  'asset-batch.v1': assetBatchSchema,
  'asset-manifest.v1': assetManifestSchema,
  'creative-spec.v1': creativeSpecSchema,
  'video-spec.v1': videoSpecSchema,
  'quality-report.v1': qualityReportSchema,
  'render-job.v1': renderJobSchema,
  'job-batch.v1': jobBatchSchema,
  'command-result.v1': commandResultSchema,
  'event-batch.v1': eventBatchSchema,
  'relay-key.v1': relayKeySummarySchema,
  'relay-key-batch.v1': relayKeyBatchSchema,
  'relay-key-test.v1': relayKeyTestResultSchema,
  'relay-model-list.v1': relayModelListSchema,
  'relay-chat-result.v1': relayChatResultSchema,
  'relay-protocol-test-result.v1': relayProtocolTestResultSchema,
  'video-upload-session.v1': videoUploadSessionSchema,
  'video-analysis-task.v1': videoAnalysisTaskSchema,
  'video-analysis-result.v1': videoAnalysisResultSchema,
  'health-status.v1': healthStatusSchema,
  'creative-direction-request.v1': creativeDirectionRequestSchema,
  'visual-direction-request.v1': visualDirectionRequestSchema,
  'quality-check-request.v1': qualityCheckRequestSchema,
  'error.v1': transportErrorSchema,
} as const;

export type RegisteredSchema = keyof typeof schemaRegistry;

export const parseRegisteredEnvelope = <T = unknown>(value: unknown): Envelope<T> => {
  const envelope = envelopeSchema.parse(value);
  if (!(envelope.payload.schema in schemaRegistry)) throw new Error(`未注册的 Payload Schema：${envelope.payload.schema}`);
  const schema = envelope.payload.schema as RegisteredSchema;
  const data = schemaRegistry[schema].parse(envelope.payload.data) as T;
  return {...envelope, payload: {...envelope.payload, data}};
};

export const parseEnvelope = <T>(value: unknown, expected: {type?: string; schema: RegisteredSchema}): Envelope<T> => {
  const envelope = parseRegisteredEnvelope<T>(value);
  if (expected.type && envelope.type !== expected.type) throw new Error(`消息类型不匹配：期望 ${expected.type}，收到 ${envelope.type}`);
  if (envelope.payload.schema !== expected.schema) throw new Error(`Payload Schema 不匹配：期望 ${expected.schema}，收到 ${envelope.payload.schema}`);
  return envelope;
};

export type EnvelopeContext = Pick<Envelope, 'tenantId' | 'projectId' | 'jobId' | 'traceId'>;

export const makeEnvelope = <T>(args: EnvelopeContext & {
  type: string;
  eventId: string;
  occurredAt: string;
  producer: string;
  idempotencyKey: string;
  schema: RegisteredSchema;
  data: T;
  causationId?: string;
}): Envelope<T> => envelopeSchema.parse({
  version: '1.0', type: args.type, eventId: args.eventId, occurredAt: args.occurredAt,
  traceId: args.traceId, causationId: args.causationId, tenantId: args.tenantId,
  projectId: args.projectId, jobId: args.jobId, producer: args.producer,
  idempotencyKey: args.idempotencyKey,
  payload: {schema: args.schema, data: schemaRegistry[args.schema].parse(args.data)},
}) as Envelope<T>;

export const STAGE_LABELS: Record<JobStage, {title: string; detail: string}> = {
  queued: {title: '任务排队', detail: '等待媒体 Worker'},
  asset_analysis: {title: '素材理解', detail: '读取关键帧与真实元数据'},
  creative_direction: {title: '创意导演', detail: '确定脚本、事实与节奏'},
  visual_direction: {title: '视觉编导', detail: '选镜、裁切与转场'},
  audio_production: {title: '音频生产', detail: '中文配音、字幕与 BGM'},
  rendering: {title: '真实出片', detail: 'Remotion 渲染 MP4 与封面'},
  quality_check: {title: '媒体质检', detail: '解码、音画、时长与来源'},
  awaiting_review: {title: '等待复核', detail: '人工确认发布'},
  completed: {title: '已完成', detail: '产物可下载与追溯'},
  failed: {title: '生成失败', detail: '可从失败阶段重试'},
  cancelled: {title: '已取消', detail: '任务已安全停止'},
};
