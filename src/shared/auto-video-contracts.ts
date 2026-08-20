import {z} from 'zod';
import type {Caption as RemotionCaption} from '@remotion/captions';

export const AUTO_VIDEO_AI_STEP_NAMES = [
  'probe',
  'extract_audio',
  'transcription',
  'screenshots',
  'visual_analysis',
  'asset_understanding',
  'planning',
  'timeline',
  'captions',
  'render',
] as const;

export const AUTO_VIDEO_LOCAL_STEP_NAMES = [
  'local_prepare',
  'local_timeline',
  'captions',
  'render',
] as const;

export const AUTO_VIDEO_STEP_NAMES = [
  ...AUTO_VIDEO_AI_STEP_NAMES,
  'local_prepare',
  'local_timeline',
] as const;

export const AUTO_VIDEO_VISUAL_CONCURRENCY_OPTIONS = [1, 2, 3, 4] as const;

export type AutoVideoAiStepName = typeof AUTO_VIDEO_AI_STEP_NAMES[number];
export type AutoVideoLocalStepName = typeof AUTO_VIDEO_LOCAL_STEP_NAMES[number];
export type AutoVideoStepName = AutoVideoAiStepName | AutoVideoLocalStepName;

export const autoVideoProjectStatusSchema = z.enum([
  'draft',
  'ready',
  'archived',
]);
export type AutoVideoProjectStatus = z.infer<typeof autoVideoProjectStatusSchema>;

export const processingStepStatusSchema = z.enum(['pending', 'running', 'completed', 'failed']);
export const processingStepSchema = z.object({
  name: z.enum(AUTO_VIDEO_STEP_NAMES),
  status: processingStepStatusSchema,
  progress: z.number().int().min(0).max(100),
  attempts: z.number().int().nonnegative(),
  startedAt: z.string().datetime({offset: true}).optional(),
  completedAt: z.string().datetime({offset: true}).optional(),
  note: z.string().min(1).max(1_000).optional(),
  errorCode: z.string().optional(),
  errorMessage: z.string().max(1_000).optional(),
}).strict();
export type ProcessingStep = z.infer<typeof processingStepSchema>;

export const generationStatusSchema = z.enum([
  'queued',
  'analyzing',
  'retry_waiting',
  'planning',
  'rendering',
  'completed',
  'failed',
  'cancelled',
  'needs_attention',
]);
export type GenerationStatus = z.infer<typeof generationStatusSchema>;

export const generationTerminalStatuses = ['completed', 'failed', 'cancelled', 'needs_attention'] as const;

export const aiModeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('connected'),
    connectionId: z.string().min(1),
    model: z.string().min(1).max(160),
  }).strict(),
  z.object({
    kind: z.literal('local'),
    reason: z.enum(['no_model_connection', 'user_selected_local']),
  }).strict(),
  z.object({
    kind: z.literal('blocked'),
    reason: z.enum(['connection_test_failed', 'transcription_unavailable']),
  }).strict(),
]);
export type AiMode = z.infer<typeof aiModeSchema>;

export const autoVideoErrorSchema = z.object({
  // Error codes are deliberately open: upstream services and local tools must
  // reach callers unchanged instead of being collapsed into a product bucket.
  code: z.string().min(1).max(2_000),
  message: z.string().min(1).max(10_000),
  retryable: z.boolean(),
  details: z.string().max(10_000).optional(),
}).strict();
export type AutoVideoError = z.infer<typeof autoVideoErrorSchema>;

export const autoVideoRetryStateSchema = z.object({
  status: z.enum(['none', 'waiting', 'paused_by_user', 'needs_attention']),
  stage: z.enum(['visual_analysis', 'planning', 'render']).optional(),
  nextRetryAt: z.string().datetime({offset: true}).optional(),
  totalAttempts: z.number().int().nonnegative(),
  lastError: autoVideoErrorSchema.optional(),
  updatedAt: z.string().datetime({offset: true}),
}).strict();
export type AutoVideoRetryState = z.infer<typeof autoVideoRetryStateSchema>;

export const assetMetadataSchema = z.object({
  assetId: z.string().min(1),
  durationMs: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().positive(),
  videoCodec: z.string().min(1),
  hasAudio: z.boolean(),
  audioCodec: z.string().min(1).optional(),
  sampleRate: z.number().int().positive().optional(),
  channels: z.number().int().positive().optional(),
  orientation: z.enum(['landscape', 'portrait', 'square']),
}).strict();
export type AssetMetadata = z.infer<typeof assetMetadataSchema>;

export const autoVideoAssetStatusSchema = z.enum(['uploaded', 'processing', 'ready', 'failed', 'unsupported_asset']);

export const autoVideoAssetSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  originalName: z.string().min(1).max(255),
  mimeType: z.string().min(1),
  fileSize: z.number().int().positive(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/i),
  status: autoVideoAssetStatusSchema,
  metadata: assetMetadataSchema.optional(),
  error: autoVideoErrorSchema.optional(),
  createdAt: z.string().datetime({offset: true}),
}).strict();
export type AutoVideoAsset = z.infer<typeof autoVideoAssetSchema>;

export const videoScreenshotSchema = z.object({
  id: z.string().min(1),
  assetId: z.string().min(1),
  timestampMs: z.number().int().nonnegative(),
}).strict();
export type VideoScreenshot = z.infer<typeof videoScreenshotSchema>;

export const storedVideoScreenshotSchema = videoScreenshotSchema.extend({
  filePath: z.string().min(1),
}).strict();
export type StoredVideoScreenshot = z.infer<typeof storedVideoScreenshotSchema>;

export const storedAutoVideoAssetSchema = autoVideoAssetSchema.extend({
  tenantId: z.string().min(1),
  ownerId: z.string().min(1),
  originalPath: z.string().min(1),
  // A duplicated project may safely reference an existing immutable original.
  sourceAssetId: z.string().min(1).optional(),
  rawTranscriptionPath: z.string().min(1).optional(),
  temporaryAudioPath: z.string().min(1).optional(),
  screenshots: z.array(storedVideoScreenshotSchema).default([]),
  contactSheetPath: z.string().min(1).optional(),
}).strict();
export type StoredAutoVideoAsset = z.infer<typeof storedAutoVideoAssetSchema>;

export const transcriptWordSchema = z.object({
  text: z.string().min(1),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  confidence: z.number().min(0).max(1).nullable(),
}).strict().refine((word) => word.startMs < word.endMs, {message: 'word_time_invalid'});
export type TranscriptWord = z.infer<typeof transcriptWordSchema>;

export const transcriptSegmentSchema = z.object({
  text: z.string().min(1),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  confidence: z.number().min(0).max(1).nullable(),
}).strict().refine((segment) => segment.startMs < segment.endMs, {message: 'segment_time_invalid'});
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;

export const transcriptionProviderIdSchema = z.enum(['speaches-whisper', 'qwen3-asr']);
export type TranscriptionProviderId = z.infer<typeof transcriptionProviderIdSchema>;

export const transcriptionProviderStatusSchema = z.object({
  id: transcriptionProviderIdSchema,
  label: z.string().min(1),
  model: z.string().min(1),
  alignmentModel: z.string().min(1).optional(),
  providerServiceVersion: z.string().min(1).optional(),
  configured: z.boolean(),
  reachable: z.boolean(),
  ready: z.boolean(),
  supportsWordTimestamps: z.boolean(),
  supportsSegmentTimestamps: z.boolean(),
  message: z.string().min(1),
  error: autoVideoErrorSchema.optional(),
}).strict();
export type TranscriptionProviderStatus = z.infer<typeof transcriptionProviderStatusSchema>;

export const transcriptionProviderStatusResponseSchema = z.object({
  providers: z.array(transcriptionProviderStatusSchema),
  activeProviderId: transcriptionProviderIdSchema.optional(),
  switching: z.boolean(),
}).strict();
export type TranscriptionProviderStatusResponse = z.infer<typeof transcriptionProviderStatusResponseSchema>;

export const transcriptionProviderActivationSchema = z.object({
  providerId: transcriptionProviderIdSchema,
}).strict();
export type TranscriptionProviderActivation = z.infer<typeof transcriptionProviderActivationSchema>;

// 'speaches' is retained only for read compatibility with existing SQLite payloads.
export const normalizedTranscriptSchema = z.object({
  assetId: z.string().min(1),
  language: z.string().min(1).optional(),
  durationMs: z.number().int().nonnegative(),
  text: z.string(),
  words: z.array(transcriptWordSchema),
  segments: z.array(transcriptSegmentSchema),
  provider: z.union([transcriptionProviderIdSchema, z.literal('speaches')]).transform((provider) => provider === 'speaches' ? 'speaches-whisper' : provider),
  model: z.string().min(1),
}).strict();
export type NormalizedTranscript = z.infer<typeof normalizedTranscriptSchema>;

export const screenshotAnalysisSchema = z.object({
  screenshotId: z.string().min(1),
  assetId: z.string().min(1),
  timestampMs: z.number().int().nonnegative(),
  description: z.string().min(1),
  people: z.array(z.string()),
  objects: z.array(z.string()),
  actions: z.array(z.string()),
  scene: z.string().min(1),
  ocrText: z.array(z.string()),
  qualityIssues: z.array(z.string()),
}).strict();
export type ScreenshotAnalysis = z.infer<typeof screenshotAnalysisSchema>;

export const assetAnalysisSchema = z.object({
  assetId: z.string().min(1),
  audioSummary: z.string().min(1).optional(),
  visualSummary: z.string().min(1),
  combinedSummary: z.string().min(1),
  topics: z.array(z.string()),
  people: z.array(z.string()),
  scenes: z.array(z.string()),
  screenTexts: z.array(z.string()),
  chronologicalHints: z.array(z.string()),
  duplicateWithAssetIds: z.array(z.string()),
  confidence: z.number().min(0).max(1),
}).strict();
export type AssetAnalysis = z.infer<typeof assetAnalysisSchema>;

// This is intentionally a generation-scoped result. It is not attached to an
// uploaded asset because the connection, prompt snapshot and user instruction
// can change for every generation.
export const assetVisualAnalysisSchema = z.object({
  assetId: z.string().min(1),
  visualSummary: z.string().trim().min(1).max(1_500),
  people: z.array(z.string().trim().min(1).max(120)).max(30),
  objects: z.array(z.string().trim().min(1).max(120)).max(40),
  actions: z.array(z.string().trim().min(1).max(160)).max(30),
  scenes: z.array(z.string().trim().min(1).max(300)).max(20),
  screenTexts: z.array(z.string().trim().min(1).max(300)).max(30),
  chronologicalHints: z.array(z.string().trim().min(1).max(300)).max(20),
  confidence: z.number().min(0).max(1),
  needsDetail: z.boolean(),
  detailReason: z.string().trim().min(1).max(300).optional(),
  detailTimestampMs: z.number().int().nonnegative().optional(),
}).strict();
export type AssetVisualAnalysis = z.infer<typeof assetVisualAnalysisSchema>;

export const checkpointStatusSchema = z.enum(['pending', 'running', 'retry_waiting', 'completed', 'failed']);
export type CheckpointStatus = z.infer<typeof checkpointStatusSchema>;

const checkpointVisualAnalysisSchema = z.object({
  status: checkpointStatusSchema,
  value: assetVisualAnalysisSchema.optional(),
  attempts: z.number().int().nonnegative(),
  lastError: autoVideoErrorSchema.optional(),
  nextRetryAt: z.string().datetime({offset: true}).optional(),
  completedAt: z.string().datetime({offset: true}).optional(),
}).strict().superRefine((visual, context) => {
  if (visual.status === 'completed' && (!visual.value || !visual.completedAt || visual.nextRetryAt)) {
    context.addIssue({code: 'custom', message: 'completed_visual_checkpoint_invalid'});
  }
  if (visual.status === 'retry_waiting' && (!visual.lastError?.retryable || !visual.nextRetryAt)) {
    context.addIssue({code: 'custom', message: 'retry_waiting_visual_checkpoint_invalid'});
  }
});

export const autoVideoAssetCheckpointSchema = z.object({
  generationId: z.string().min(1),
  assetId: z.string().min(1),
  sourceChecksum: z.string().regex(/^[a-f0-9]{64}$/i),
  transcript: z.object({
    status: z.enum(['pending', 'completed', 'skipped']),
    value: normalizedTranscriptSchema.optional(),
    completedAt: z.string().datetime({offset: true}).optional(),
  }).strict(),
  screenshots: z.object({
    status: z.enum(['pending', 'completed']),
    screenshotIds: z.array(z.string().min(1)),
    contactSheetPath: z.string().min(1).optional(),
    completedAt: z.string().datetime({offset: true}).optional(),
  }).strict(),
  visualAnalysis: checkpointVisualAnalysisSchema,
  updatedAt: z.string().datetime({offset: true}),
}).strict();
export type AutoVideoAssetCheckpoint = z.infer<typeof autoVideoAssetCheckpointSchema>;

export const autoVideoAssetCheckpointSummarySchema = z.object({
  assetId: z.string().min(1),
  visualAnalysis: z.object({
    status: checkpointStatusSchema,
    attempts: z.number().int().nonnegative(),
    nextRetryAt: z.string().datetime({offset: true}).optional(),
    lastError: autoVideoErrorSchema.pick({code: true, message: true, retryable: true}).optional(),
    completedAt: z.string().datetime({offset: true}).optional(),
  }).strict(),
}).strict();
export type AutoVideoAssetCheckpointSummary = z.infer<typeof autoVideoAssetCheckpointSummarySchema>;

export const analysisProfileSchema = z.discriminatedUnion('name', [
  z.object({
    name: z.literal('balanced-v1'),
    sampledFramesPerAsset: z.literal(3),
    detailBudget: z.number().int().min(0).max(20),
    modelConcurrency: z.number().int().min(1).max(20),
    // Optional so historical generation snapshots remain readable. New
    // connected generations always record the selected value.
    visualConcurrency: z.number().int().min(1).max(4).optional(),
  }).strict(),
  z.object({name: z.literal('legacy-v1')}).strict(),
]);
export type AnalysisProfile = z.infer<typeof analysisProfileSchema>;

export const analysisMetricsSchema = z.object({
  analysisProfile: z.enum(['balanced-v1', 'legacy-v1']),
  assetCount: z.number().int().nonnegative(),
  baseVisualCalls: z.number().int().nonnegative(),
  detailVisualCalls: z.number().int().nonnegative(),
  normalizedModelFields: z.number().int().nonnegative(),
  invalidModelResponses: z.number().int().nonnegative(),
  modelQueueWaitMs: z.number().int().nonnegative(),
  modelRequestMs: z.number().int().nonnegative(),
  mediaPreparationMs: z.number().int().nonnegative(),
  renderMs: z.number().int().nonnegative().optional(),
}).strict();
export type AnalysisMetrics = z.infer<typeof analysisMetricsSchema>;

export const autoCaptionSchema = z.object({
  text: z.string().min(1),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  timestampMs: z.number().int().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
}).strict().refine((caption) => caption.startMs < caption.endMs, {message: 'caption_time_invalid'});
export type AutoCaption = z.infer<typeof autoCaptionSchema> & RemotionCaption;

export const assetCaptionTrackSchema = z.object({
  assetId: z.string().min(1),
  captions: z.array(autoCaptionSchema),
}).strict();
export type AssetCaptionTrack = z.infer<typeof assetCaptionTrackSchema>;

export const editPlanSchema = z.object({
  projectId: z.string().min(1),
  clips: z.array(z.object({
    assetId: z.string().min(1),
    order: z.number().int().positive(),
    reason: z.string().min(1).max(500),
  }).strict()).min(1),
  excludedAssets: z.array(z.object({
    assetId: z.string().min(1),
    reason: z.string().min(1).max(500),
  }).strict()),
  overallReason: z.string().min(1).max(2_000),
}).strict();
export type EditPlan = z.infer<typeof editPlanSchema>;

export const timelineClipSchema = z.object({
  assetId: z.string().min(1),
  src: z.string().min(1),
  order: z.number().int().positive(),
  startMs: z.number().int().nonnegative(),
  durationMs: z.number().int().positive(),
  fromFrame: z.number().int().nonnegative(),
  durationInFrames: z.number().int().positive(),
  volume: z.number().min(0).max(1),
  fit: z.literal('contain'),
}).strict();
export type TimelineClip = z.infer<typeof timelineClipSchema>;

export const videoTimelineSchema = z.object({
  projectId: z.string().min(1),
  fps: z.number().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  durationInFrames: z.number().int().positive(),
  durationMs: z.number().int().positive(),
  clips: z.array(timelineClipSchema).min(1),
}).strict();
export type VideoTimeline = z.infer<typeof videoTimelineSchema>;

export const autoVideoOutputSchema = z.object({
  status: z.enum(['pending', 'rendering', 'ready', 'failed']),
  durationMs: z.number().int().positive().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fileSize: z.number().int().nonnegative().optional(),
  renderedAt: z.string().datetime({offset: true}).optional(),
}).strict();
export type AutoVideoOutput = z.infer<typeof autoVideoOutputSchema>;

export const transcriptionSelectionSchema = z.object({
  providerId: transcriptionProviderIdSchema,
}).strict();
export type TranscriptionSelection = z.infer<typeof transcriptionSelectionSchema>;

export const transcriptionRunSnapshotSchema = z.object({
  providerId: transcriptionProviderIdSchema,
  model: z.string().min(1),
  alignmentModel: z.string().min(1).optional(),
  language: z.literal('zh'),
  vocabularyProfile: z.literal('car-wash-zh-v1'),
  audioProfile: z.literal('mono-16khz-pcm-s16le-v1'),
  chunkingProfile: z.literal('vad-overlap-30s-v1').optional(),
  providerServiceVersion: z.string().min(1).optional(),
}).strict();
export type TranscriptionRunSnapshot = z.infer<typeof transcriptionRunSnapshotSchema>;
export const autoVideoGenerationSchema = z.object({
  generationId: z.string().min(1),
  projectId: z.string().min(1),
  tenantId: z.string().min(1),
  ownerId: z.string().min(1),
  versionNumber: z.number().int().positive(),
  status: generationStatusSchema,
  progress: z.number().int().min(0).max(100),
  aiMode: aiModeSchema,
  // Absent means a historical generation and intentionally selects legacy-v1.
  analysisProfile: analysisProfileSchema.optional(),
  analysisMetrics: analysisMetricsSchema.optional(),
  connectionId: z.string().min(1).optional(),
  model: z.string().min(1).max(160).optional(),
  transcriptionSnapshot: transcriptionRunSnapshotSchema.optional(),
  instructionSnapshot: z.string().max(2_000),
  canvas: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().positive(),
  }).strict(),
  // Historical empty drafts are represented as cancelled V1 records during
  // migration; the generation creation API separately requires a ready asset.
  assetIds: z.array(z.string().min(1)).max(20),
  steps: z.array(processingStepSchema).min(1),
  transcripts: z.array(normalizedTranscriptSchema).default([]),
  screenshotAnalyses: z.array(screenshotAnalysisSchema).default([]),
  assetAnalyses: z.array(assetAnalysisSchema).default([]),
  editPlan: editPlanSchema.optional(),
  timeline: videoTimelineSchema.optional(),
  output: autoVideoOutputSchema.optional(),
  localSummary: z.string().min(1).max(500).optional(),
  artifactStorage: z.enum(['generation', 'legacy_project']).default('generation'),
  retryState: autoVideoRetryStateSchema.optional(),
  error: autoVideoErrorSchema.optional(),
  createdAt: z.string().datetime({offset: true}),
  startedAt: z.string().datetime({offset: true}).optional(),
  completedAt: z.string().datetime({offset: true}).optional(),
  updatedAt: z.string().datetime({offset: true}),
}).strict();
export type AutoVideoGeneration = z.infer<typeof autoVideoGenerationSchema>;

export const autoVideoGenerationCreateSchema = z.object({
  userInstruction: z.string().trim().max(2_000).optional(),
  mode: z.enum(['ai', 'local']).optional(),
  connectionId: z.string().min(1).max(180).optional(),
  visualConcurrency: z.number().int().min(1).max(4).optional(),
  transcriptionSelection: transcriptionSelectionSchema.optional(),
}).strict();
export type AutoVideoGenerationCreate = z.infer<typeof autoVideoGenerationCreateSchema>;

export const autoVideoProjectSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  ownerId: z.string().min(1),
  name: z.string().min(1).max(80),
  userInstruction: z.string().max(2_000).optional(),
  status: autoVideoProjectStatusSchema,
  progress: z.number().int().min(0).max(100),
  canvas: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().positive(),
  }).strict(),
  assetIds: z.array(z.string().min(1)).max(20),
  // These fields are retained only to make old SQLite payloads readable during
  // the one-time migration. New work is always stored on a generation.
  steps: z.array(processingStepSchema).default([]),
  transcripts: z.array(normalizedTranscriptSchema).default([]),
  screenshotAnalyses: z.array(screenshotAnalysisSchema).default([]),
  assetAnalyses: z.array(assetAnalysisSchema).default([]),
  editPlan: editPlanSchema.optional(),
  timeline: videoTimelineSchema.optional(),
  output: autoVideoOutputSchema.optional(),
  error: autoVideoErrorSchema.optional(),
  createdAt: z.string().datetime({offset: true}),
  updatedAt: z.string().datetime({offset: true}),
}).strict();
export type AutoVideoProject = z.infer<typeof autoVideoProjectSchema>;

export const autoVideoProjectCreateSchema = z.object({
  name: z.string().trim().min(1).max(80).default('?????????'),
  userInstruction: z.string().trim().max(2_000).optional(),
  canvas: z.object({
    width: z.number().int().min(320).max(3840).default(1080),
    height: z.number().int().min(320).max(3840).default(1920),
    fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(50), z.literal(60)]).default(30),
  }).strict().optional(),
}).strict();
export type AutoVideoProjectCreate = z.infer<typeof autoVideoProjectCreateSchema>;

export const autoVideoProjectPatchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  userInstruction: z.string().trim().max(2_000).optional(),
  canvas: z.object({
    width: z.number().int().min(320).max(3840),
    height: z.number().int().min(320).max(3840),
    fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(50), z.literal(60)]),
  }).strict().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {message: 'project_patch_empty'});
export type AutoVideoProjectPatch = z.infer<typeof autoVideoProjectPatchSchema>;

const makeSteps = (names: readonly AutoVideoStepName[]): ProcessingStep[] => names.map((name) => ({
  name,
  status: 'pending',
  progress: 0,
  attempts: 0,
}));

export const makeInitialProcessingSteps = (): ProcessingStep[] => makeSteps(AUTO_VIDEO_AI_STEP_NAMES);

export const makeInitialLocalProcessingSteps = (): ProcessingStep[] => makeSteps(AUTO_VIDEO_LOCAL_STEP_NAMES);

