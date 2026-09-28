import {randomUUID} from 'node:crypto';
import {access, rm} from 'node:fs/promises';
import {
  AUTO_VIDEO_VISUAL_CONCURRENCY_DEFAULT,
  AUTO_VIDEO_VISUAL_CONCURRENCY_MAX,
  AUTO_VIDEO_VISUAL_CONCURRENCY_MIN,
  autoVideoErrorSchema,
  autoVideoOutputSchema,
  marketingRoleBatchInputSchema,
  type AutoCaption,
  type AutoVideoError,
  type AutoVideoAssetCheckpoint,
  type AutoVideoRetryState,
  type AutoVideoGeneration,
  type AutoVideoStepName,
  type AnalysisMetrics,
  type AssetAnalysis,
  type NormalizedTranscript,
  type ProcessingStep,
  type ScreenshotAnalysis,
  type StoredAutoVideoAsset,
  type StoredVideoScreenshot,
} from '../shared/auto-video-contracts.js';
import {AutoVideoAiProvider, mergeAssetVisualAnalysis, toAssetAnalysis, type AssetVisualAnalysis, validateAutoEditPlan} from './auto-video-ai.js';
import {
  cleanupAssetAnalysisFiles,
  createContactSheet,
  extractDetailScreenshot,
  extractAnalysisAudio,
  extractScreenshots,
  inspectAutoVideoGenerationOutput,
  renderAutoVideoGenerationPlain,
  renderAutoVideoGenerationCaptioned,
  screenshotAsDataUrl,
  writeGenerationJson,
  writeGenerationRawTranscription,
} from './auto-video-media.js';
import {
  globalizeCaptions,
  transcriptToCaptions,
  writeAutoVideoGenerationCaptionJson,
  writeAutoVideoGenerationVtt,
} from './auto-video-captions.js';
import {compileAutoVideoGenerationTimeline} from './auto-video-timeline.js';
import {createTranscriptionProviderRegistry, type TranscriptionProviderRegistry} from './transcription-registry.js';
import {emptyNormalizedTranscript, TranscriptionProviderError, type TranscriptionProvider, type TranscriptionResult} from './transcription-provider.js';
import {RelayClient} from './relay-client.js';
import {SqliteStore} from './store.js';

type RelayResolver = (tenantId: string, connectionId?: string, model?: string, reasoningEffort?: AutoVideoGeneration['reasoningEffort']) => RelayClient | undefined;
type RawCapableProvider = TranscriptionProvider;
type TranscriptionRunResult = {transcript: NormalizedTranscript; temporarilyDisabled: boolean};
type AssetBranchResult = {asset: StoredAutoVideoAsset; transcript: NormalizedTranscript; transcriptionTemporarilyDisabled: boolean; visual?: AssetVisualAnalysis; screenshotAnalyses: ScreenshotAnalysis[]; normalizedFields: number};

export const AUTO_VIDEO_RETRY_DELAYS_MS = [5_000, 15_000, 30_000] as const;
export const AUTO_VIDEO_RETRY_DELAY_MS = AUTO_VIDEO_RETRY_DELAYS_MS[0];
export const AUTO_VIDEO_MAX_RETRIES_PER_KEY = 3;
export const AUTO_VIDEO_MAX_TOTAL_RETRIES = 20;
export const AUTO_VIDEO_RECOVERY_PROBE_DELAYS_MS = [60_000, 300_000, 900_000] as const;
export const MAX_AUTO_VIDEO_VISUAL_CONCURRENCY = AUTO_VIDEO_VISUAL_CONCURRENCY_MAX;

export const parseAutoVideoConcurrencyLimit = (
  value: string | undefined,
  environmentName: string,
  fallback = AUTO_VIDEO_VISUAL_CONCURRENCY_MAX,
) => {
  if (value === undefined || value.trim() === '') return fallback;
  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`${environmentName} must be an integer between ${AUTO_VIDEO_VISUAL_CONCURRENCY_MIN} and ${AUTO_VIDEO_VISUAL_CONCURRENCY_MAX}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < AUTO_VIDEO_VISUAL_CONCURRENCY_MIN || parsed > AUTO_VIDEO_VISUAL_CONCURRENCY_MAX) {
    throw new Error(`${environmentName} must be an integer between ${AUTO_VIDEO_VISUAL_CONCURRENCY_MIN} and ${AUTO_VIDEO_VISUAL_CONCURRENCY_MAX}`);
  }
  return parsed;
};

export const autoVideoModelConcurrencyLimit = () => parseAutoVideoConcurrencyLimit(
  process.env.AUTO_VIDEO_MODEL_CONCURRENCY,
  'AUTO_VIDEO_MODEL_CONCURRENCY',
);

export const autoVideoVisualGlobalConcurrencyLimit = () => parseAutoVideoConcurrencyLimit(
  process.env.AUTO_VIDEO_VISUAL_GLOBAL_CONCURRENCY,
  'AUTO_VIDEO_VISUAL_GLOBAL_CONCURRENCY',
);

export const autoVideoRecoveryProbeDelay = (recoveryAttempts: number) =>
  AUTO_VIDEO_RECOVERY_PROBE_DELAYS_MS[Math.min(Math.max(0, recoveryAttempts), AUTO_VIDEO_RECOVERY_PROBE_DELAYS_MS.length - 1)]!;

export const asksForChronologicalSequence = (instruction: string) => /时间顺序|先后|顺序/.test(instruction);

// A persisted batch result is reusable only when it proves the full asset-set
// invariant; array length alone cannot detect duplicate or foreign IDs.
export const hasCompleteAssetAnalyses = (
  analyses: AssetAnalysis[],
  expectedAssetIds: string[],
  requireRoleReason = true,
) => {
  if (analyses.length !== expectedAssetIds.length) return false;
  const expected = new Set(expectedAssetIds);
  const seen = new Set<string>();
  for (const analysis of analyses) {
    if (!expected.has(analysis.assetId) || seen.has(analysis.assetId)) return false;
    if (requireRoleReason && !analysis.roleReason?.trim()) return false;
    seen.add(analysis.assetId);
  }
  return seen.size === expected.size;
};

export const mapWithConcurrency = async <Input, Output>(
  items: Input[],
  limit: number,
  work: (item: Input, index: number) => Promise<Output>,
  onFirstError?: (error: unknown) => void,
) => {
  const output: Output[] = new Array(items.length);
  let cursor = 0;
  let firstError: unknown;
  const worker = async () => {
    while (true) {
      if (firstError !== undefined) return;
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        output[index] = await work(items[index]!, index);
      } catch (error) {
        if (firstError === undefined) {
          firstError = error;
          onFirstError?.(error);
        }
        return;
      }
    }
  };
  await Promise.allSettled(Array.from({length: Math.max(1, Math.min(limit, items.length))}, worker));
  if (firstError !== undefined) throw firstError;
  return output;
};

export class AbortableSemaphore {
  private active = 0;
  private readonly waiting: Array<{
    signal: AbortSignal;
    resolve: () => void;
    reject: (error: Error) => void;
    onAbort: () => void;
  }> = [];
  constructor(private readonly limit: number) {}

  async use<Value>(signal: AbortSignal, work: () => Promise<Value>): Promise<{value: Value; waitMs: number; requestMs: number}> {
    const queuedAt = Date.now();
    if (signal.aborted) throw new Error('cancelled');
    if (this.active < this.limit) {
      this.active += 1;
    } else {
      await new Promise<void>((resolve, reject) => {
        const entry = {
          signal,
          resolve,
          reject,
          onAbort: () => {
            const index = this.waiting.indexOf(entry);
            if (index >= 0) this.waiting.splice(index, 1);
            reject(new Error('cancelled'));
          },
        };
        this.waiting.push(entry);
        signal.addEventListener('abort', entry.onAbort, {once: true});
        if (signal.aborted) entry.onAbort();
      });
    }
    const startedAt = Date.now();
    try {
      return {value: await work(), waitMs: startedAt - queuedAt, requestMs: Date.now() - startedAt};
    } finally {
      this.active -= 1;
      while (this.waiting.length) {
        const next = this.waiting.shift()!;
        next.signal.removeEventListener('abort', next.onAbort);
        if (next.signal.aborted) {
          next.reject(new Error('cancelled'));
          continue;
        }
        this.active += 1;
        next.resolve();
        break;
      }
    }
  }
}

export const autoVideoGenerationProgress = (steps: ProcessingStep[], status?: AutoVideoGeneration['status']) => status === 'completed'
  ? 100
  : Math.round(steps.reduce((sum, step) => sum + step.progress, 0) / Math.max(1, steps.length));
const filesExist = async (paths: string[]) => Boolean(paths.length) && (await Promise.all(paths.map((filePath) => access(filePath).then(() => true).catch(() => false)))).every(Boolean);

type RetryStage = NonNullable<AutoVideoRetryState['stage']>;
type CodedError = Error & {code?: unknown; retryable?: unknown; assetId?: unknown; retryStage?: RetryStage};

export const toAutoVideoError = (error: unknown): AutoVideoError => {
  const source = error instanceof Error ? error as CodedError : undefined;
  const message = source?.message || String(error ?? 'unknown_error');
  const code = typeof source?.code === 'string' && source.code.trim() ? source.code : message;
  const retryableStatus = /(?:HTTP|relay_http_)(?:\s|_)?(408|425|429|500|502|503|504)\b/i.test(message);
  const transientNetwork = /(?:upstream gateway error|gateway|timeout|timed out|network|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|connection reset|relay_(?:(?:first_byte|idle|total)_timeout|incomplete|timeout|network)|response\.completed)/i.test(message);
  const retryable = typeof source?.retryable === 'boolean' ? source.retryable : retryableStatus || transientNetwork;
  return autoVideoErrorSchema.parse({
    code,
    message,
    retryable,
    details: message,
    ...(source?.retryStage ? {stage: source.retryStage} : {}),
  });
};

const withAssetId = (error: unknown, assetId: string): CodedError => {
  const source = error instanceof Error ? error as CodedError : new Error(String(error ?? 'unknown_error')) as CodedError;
  source.assetId = assetId;
  return source;
};

const withStage = (error: unknown, retryStage: RetryStage): CodedError => {
  const source = error instanceof Error ? error as CodedError : new Error(String(error ?? 'unknown_error')) as CodedError;
  source.retryStage = retryStage;
  return source;
};

const withAssetStage = (error: unknown, assetId: string, retryStage: RetryStage): CodedError => {
  return withStage(withAssetId(error, assetId), retryStage);
};

const stepForError = (error: AutoVideoError, fallback: AutoVideoStepName): AutoVideoStepName => {
  switch (error.code) {
    case 'INVALID_UPLOAD':
    case 'UNSUPPORTED_ASSET':
    case 'MEDIA_PROBE_FAILED':
    case 'NO_VIDEO_STREAM':
      return fallback === 'local_prepare' ? fallback : 'probe';
    case 'AUDIO_EXTRACTION_FAILED': return 'extract_audio';
    case 'TRANSCRIPTION_FAILED': return 'transcription';
    case 'SCREENSHOT_EXTRACTION_FAILED': return 'screenshots';
    case 'VISUAL_ANALYSIS_FAILED': return 'visual_analysis';
    case 'INVALID_MODEL_RESPONSE': return fallback === 'asset_understanding' || fallback === 'planning' ? fallback : 'visual_analysis';
    case 'MARKETING_ROLE_ASSIGNMENT_INVALID': return 'asset_understanding';
    case 'EDIT_PLAN_INVALID': return fallback === 'local_timeline' ? fallback : 'planning';
    case 'TIMELINE_INVALID': return fallback === 'local_timeline' ? fallback : 'timeline';
    case 'CAPTION_GENERATION_FAILED': return 'captions';
    case 'RENDER_FAILED': return 'render';
    case 'OUTPUT_UPLOAD_FAILED': return fallback;
    default: return fallback;
  }
};

export class AutoVideoWorker {
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private readonly running = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private activeWorkers = 0;
  private readonly concurrency = Math.max(1, Number(process.env.AUTO_VIDEO_WORKER_CONCURRENCY ?? 1));
  private readonly assetConcurrency = Math.max(1, Number(process.env.AUTO_VIDEO_ASSET_CONCURRENCY ?? 2));
  private readonly mediaSemaphore = new AbortableSemaphore(Math.max(1, Number(process.env.AUTO_VIDEO_MEDIA_CONCURRENCY ?? 3)));
  // Qwen stays on the existing asset-level budget even when visual analysis is
  // raised to 30. This prevents a visual setting from multiplying ASR calls.
  private readonly transcriptionSemaphore = new AbortableSemaphore(this.assetConcurrency);
  private readonly modelSemaphore = new AbortableSemaphore(autoVideoModelConcurrencyLimit());
  // A generation selects one to thirty concurrent visual requests. This shared
  // semaphore still caps the process total when several projects run together.
  private readonly visualSemaphore = new AbortableSemaphore(autoVideoVisualGlobalConcurrencyLimit());
  private readonly metrics = new Map<string, AnalysisMetrics>();
  private readonly transcriptionRegistry: TranscriptionProviderRegistry;
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly recoveryProbes = new Set<string>();

  constructor(private readonly store: SqliteStore, private readonly resolveRelay?: RelayResolver, transcriptionRegistry?: TranscriptionProviderRegistry) {
    this.transcriptionRegistry = transcriptionRegistry ?? createTranscriptionProviderRegistry();
  }

  recover() {
    for (const generation of this.store.listRecoverableAutoVideoGenerations()) {
      if (generation.status === 'retry_waiting' && generation.retryState?.nextRetryAt) {
        this.scheduleGenerationRetry(generation.generationId, generation.retryState.nextRetryAt);
      } else {
        this.enqueue(generation.generationId);
      }
    }
  }

  enqueue(generationId: string) {
    if (this.store.isAutoVideoGenerationCancelRequested(generationId)) return;
    if (this.queued.has(generationId) || this.running.has(generationId)) return;
    this.queue.push(generationId);
    this.queued.add(generationId);
    this.drain();
  }

  cancel(generationId: string) {
    this.cancelScheduledGenerationRetry(generationId);
    if (this.queued.delete(generationId)) {
      for (let index = this.queue.length - 1; index >= 0; index -= 1) {
        if (this.queue[index] === generationId) this.queue.splice(index, 1);
      }
    }
    this.controllers.get(generationId)?.abort();
  }

  scheduleGenerationRetry(generationId: string, nextRetryAt: string) {
    this.cancelScheduledGenerationRetry(generationId);
    const delay = Math.max(0, new Date(nextRetryAt).getTime() - Date.now());
    const timer = setTimeout(() => {
      this.retryTimers.delete(generationId);
      const generation = this.store.getAutoVideoGeneration(generationId);
      if (!generation || generation.status !== 'retry_waiting' || this.store.isAutoVideoGenerationCancelRequested(generationId)) return;
      const dueAt = generation.retryState?.nextRetryAt;
      if (!dueAt) return;
      if (new Date(dueAt).getTime() > Date.now()) {
        this.scheduleGenerationRetry(generationId, dueAt);
        return;
      }
      if (generation.retryState?.status === 'waiting_for_service') {
        void this.probeServiceAndResume(generationId);
        return;
      }
      const next = this.store.saveAutoVideoGeneration({
        ...generation,
        status: 'queued',
        error: undefined,
        retryState: {...generation.retryState, status: 'none', totalAttempts: generation.retryState?.totalAttempts ?? 0, attemptsByKey: generation.retryState?.attemptsByKey ?? {}, nextRetryAt: undefined, recoveryAttempts: generation.retryState?.recoveryAttempts ?? 0, updatedAt: new Date().toISOString()},
      });
      this.enqueue(next.generationId);
    }, Math.min(delay, 2_147_000_000));
    this.retryTimers.set(generationId, timer);
  }

  private async serviceReady(generation: AutoVideoGeneration) {
    try {
      if (generation.retryState?.stage === 'transcription') {
        const snapshot = generation.transcriptionSnapshot;
        if (!snapshot) return true;
        return this.transcriptionRegistry.ensureReadyForSnapshot(snapshot);
      }
      if (generation.retryState?.stage === 'visual_analysis' || generation.retryState?.stage === 'asset_understanding' || generation.retryState?.stage === 'planning') {
        const relay = this.resolveRelay?.(generation.tenantId, generation.connectionId, generation.model, generation.reasoningEffort);
        if (!relay) return false;
        const models = await relay.listModels();
        return models.length > 0;
      }
      return true;
    } catch (error) {
      console.warn(JSON.stringify({level: 'warn', event: 'auto_video.service_probe_failed', generationId: generation.generationId, stage: generation.retryState?.stage, error: error instanceof Error ? error.message : 'unknown'}));
      return false;
    }
  }

  private async probeServiceAndResume(generationId: string) {
    if (this.recoveryProbes.has(generationId)) return;
    this.recoveryProbes.add(generationId);
    try {
      const generation = this.store.getAutoVideoGeneration(generationId);
      if (!generation || generation.status !== 'retry_waiting' || generation.retryState?.status !== 'waiting_for_service' || this.store.isAutoVideoGenerationCancelRequested(generationId)) return;
      const retryState = generation.retryState;
      const recoveryAttempts = (retryState.recoveryAttempts ?? 0) + 1;
      if (await this.serviceReady(generation)) {
        const next = this.store.saveAutoVideoGeneration({
          ...generation,
          status: 'queued',
          error: undefined,
          retryState: {
            ...retryState,
            status: 'none',
            nextRetryAt: undefined,
            // Do not reset retry budgets based only on a health probe. They
            // reset after the actual generation completes, or when the user
            // explicitly starts a new recovery round.
            recoveryAttempts,
            updatedAt: new Date().toISOString(),
          },
        });
        console.info(JSON.stringify({level: 'info', event: 'auto_video.service_recovered', generationId: next.generationId, stage: retryState.stage, assetId: retryState.assetId}));
        this.enqueue(next.generationId);
        return;
      }
      const delay = this.recoveryDelay(recoveryAttempts);
      const nextRetryAt = new Date(Date.now() + delay).toISOString();
      const next = this.store.saveAutoVideoGeneration({
        ...generation,
        status: 'retry_waiting',
        retryState: {...generation.retryState, status: 'waiting_for_service', nextRetryAt, recoveryAttempts, updatedAt: new Date().toISOString()},
      });
      console.warn(JSON.stringify({level: 'warn', event: 'auto_video.service_still_unavailable', generationId: next.generationId, stage: next.retryState?.stage, assetId: next.retryState?.assetId, nextRetryAt}));
      this.scheduleGenerationRetry(next.generationId, nextRetryAt);
    } finally {
      this.recoveryProbes.delete(generationId);
    }
  }

  cancelScheduledGenerationRetry(generationId: string) {
    const timer = this.retryTimers.get(generationId);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(generationId);
  }

  private containUnexpectedRunFailure(generationId: string, caught: unknown) {
    const error = toAutoVideoError(caught);
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      event: 'auto_video.worker_unhandled',
      generationId,
      error,
    }));
    try {
      this.cancelScheduledGenerationRetry(generationId);
      const latest = this.store.getAutoVideoGeneration(generationId);
      if (!latest || ['completed', 'failed', 'cancelled', 'needs_attention'].includes(latest.status) || this.store.isAutoVideoGenerationCancelRequested(generationId)) return;
      const failureStep = latest.steps.find((step) => step.status === 'running')
        ?? latest.steps.find((step) => step.status === 'pending');
      const steps = latest.steps.map((step) => {
        if (step.name === failureStep?.name) {
          return {...step, status: 'failed' as const, errorCode: error.code, errorMessage: error.message};
        }
        return step.status === 'running'
          ? {...step, status: 'pending' as const, progress: 0, startedAt: undefined, completedAt: undefined, errorCode: undefined, errorMessage: undefined}
          : step;
      });
      const updatedAt = new Date().toISOString();
      this.store.saveAutoVideoGeneration({
        ...latest,
        status: 'needs_attention',
        steps,
        progress: autoVideoGenerationProgress(steps, 'needs_attention'),
        error,
        completedAt: updatedAt,
        retryState: {
          status: 'needs_attention',
          stage: this.retryStage(failureStep?.name ?? (latest.aiMode.kind === 'local' ? 'local_prepare' : 'probe')),
          totalAttempts: latest.retryState?.totalAttempts ?? 0,
          attemptsByKey: latest.retryState?.attemptsByKey ?? {},
          recoveryAttempts: latest.retryState?.recoveryAttempts ?? 0,
          lastError: error,
          updatedAt,
        },
        updatedAt,
      });
    } catch (persistenceError) {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'error',
        event: 'auto_video.worker_unhandled_persist_failed',
        generationId,
        originalError: error,
        persistenceError: toAutoVideoError(persistenceError),
      }));
    }
  }

  private retryKey(stage?: RetryStage, assetId?: string) {
    if (!stage) return undefined;
    return `${stage}:${assetId ?? 'generation'}`;
  }

  private recoveryDelay(recoveryAttempts: number) {
    return autoVideoRecoveryProbeDelay(recoveryAttempts);
  }

  private drain() {
    while (this.activeWorkers < this.concurrency && this.queue.length) {
      const generationId = this.queue.shift();
      if (!generationId) return;
      this.queued.delete(generationId);
      if (this.store.isAutoVideoGenerationCancelRequested(generationId)) continue;
      this.running.add(generationId);
      this.activeWorkers += 1;
      void this.run(generationId).catch((caught) => {
        // run() handles ordinary media/model/cancellation failures itself. This
        // boundary protects the API process if storage or recovery handling
        // throws outside that inner error path.
        this.containUnexpectedRunFailure(generationId, caught);
      }).finally(() => {
        this.activeWorkers -= 1;
        this.running.delete(generationId);
        this.controllers.delete(generationId);
        try {
          this.drain();
        } catch (caught) {
          this.containUnexpectedRunFailure(generationId, caught);
        }
      });
    }
  }

  private save(generation: AutoVideoGeneration, patch: Partial<AutoVideoGeneration> = {}) {
    const steps = patch.steps ?? generation.steps;
    const status = patch.status ?? generation.status;
    const next = this.store.saveAutoVideoGeneration({
      ...generation,
      ...patch,
      steps,
      progress: autoVideoGenerationProgress(steps, status),
      updatedAt: new Date().toISOString(),
    });
    console.log(JSON.stringify({
      timestamp: next.updatedAt,
      level: 'info',
      event: 'auto_video.generation_updated',
      generationId: next.generationId,
      projectId: next.projectId,
      tenantId: next.tenantId,
      status: next.status,
      progress: next.progress,
    }));
    return next;
  }

  private setStep(generation: AutoVideoGeneration, name: AutoVideoStepName, patch: Partial<ProcessingStep>) {
    const step = generation.steps.find((candidate) => candidate.name === name);
    if (!step) throw new Error('OUTPUT_UPLOAD_FAILED');
    return this.save(generation, {steps: generation.steps.map((candidate) => candidate.name === name ? {...candidate, ...patch} : candidate)});
  }

  private beginStep(generation: AutoVideoGeneration, name: AutoVideoStepName) {
    const step = generation.steps.find((candidate) => candidate.name === name);
    if (!step || step.status === 'completed') return generation;
    return this.setStep(generation, name, {
      status: 'running',
      progress: Math.max(step.progress, 5),
      attempts: step.status === 'running' ? step.attempts : step.attempts + 1,
      startedAt: step.startedAt ?? new Date().toISOString(),
      completedAt: undefined,
      errorCode: undefined,
      errorMessage: undefined,
    });
  }

  private completeStep(generation: AutoVideoGeneration, name: AutoVideoStepName, note?: string) {
    const step = generation.steps.find((candidate) => candidate.name === name);
    if (!step || step.status === 'completed') return generation;
    return this.setStep(generation, name, {status: 'completed', progress: 100, completedAt: new Date().toISOString(), note, errorCode: undefined, errorMessage: undefined});
  }

  private failStep(generation: AutoVideoGeneration, name: AutoVideoStepName, error: AutoVideoError) {
    return this.setStep(generation, name, {status: 'failed', errorCode: error.code, errorMessage: error.message});
  }

  private throwIfCancelled(generationId: string, controller: AbortController) {
    if (controller.signal.aborted || this.store.isAutoVideoGenerationCancelRequested(generationId)) throw new Error('cancelled');
  }

  private startMetrics(generation: AutoVideoGeneration, assetCount: number) {
    const profile = generation.analysisProfile?.name ?? 'legacy-v1';
    const metrics: AnalysisMetrics = {analysisProfile: profile, assetCount, baseVisualCalls: 0, detailVisualCalls: 0, normalizedModelFields: 0, invalidModelResponses: 0, modelQueueWaitMs: 0, modelRequestMs: 0, mediaPreparationMs: 0};
    this.metrics.set(generation.generationId, metrics);
    return metrics;
  }

  private currentMetrics(generation: AutoVideoGeneration) {
    return this.metrics.get(generation.generationId) ?? this.startMetrics(generation, generation.assetIds.length);
  }

  private visualConcurrencyFor(generation: AutoVideoGeneration) {
    const selected = generation.analysisProfile?.name === 'balanced-v1'
      ? generation.analysisProfile.visualConcurrency
      : undefined;
    return selected ?? AUTO_VIDEO_VISUAL_CONCURRENCY_DEFAULT;
  }

  private async useMedia<Value>(generation: AutoVideoGeneration, controller: AbortController, work: () => Promise<Value>) {
    const result = await this.mediaSemaphore.use(controller.signal, work);
    this.currentMetrics(generation).mediaPreparationMs += result.requestMs;
    return result.value;
  }

  private async useModel<Value>(generation: AutoVideoGeneration, controller: AbortController, kind: 'base' | 'detail' | 'understanding' | 'planning', work: () => Promise<Value>) {
    const result = await this.modelSemaphore.use(controller.signal, work);
    const metrics = this.currentMetrics(generation);
    metrics.modelQueueWaitMs += result.waitMs;
    metrics.modelRequestMs += result.requestMs;
    if (kind === 'base') metrics.baseVisualCalls += 1;
    if (kind === 'detail') metrics.detailVisualCalls += 1;
    return result.value;
  }

  private async useVisualModel<Value>(generation: AutoVideoGeneration, controller: AbortController, kind: 'base' | 'detail', work: () => Promise<Value>) {
    const result = await this.visualSemaphore.use(controller.signal, () => this.useModel(generation, controller, kind, work));
    this.currentMetrics(generation).modelQueueWaitMs += result.waitMs;
    return result.value;
  }

  private checkpointFor(generation: AutoVideoGeneration, asset: StoredAutoVideoAsset): AutoVideoAssetCheckpoint {
    const existing = this.store.getAutoVideoAssetCheckpoint(generation.generationId, asset.id, generation.tenantId);
    if (existing) {
      if (existing.sourceChecksum !== asset.checksum) throw new Error('checkpoint_source_checksum_mismatch');
      return existing;
    }
    const now = new Date().toISOString();
    return {
      generationId: generation.generationId,
      assetId: asset.id,
      sourceChecksum: asset.checksum,
      transcript: {status: 'pending'},
      screenshots: {status: 'pending', screenshotIds: []},
      visualAnalysis: {status: 'pending', attempts: 0},
      updatedAt: now,
    };
  }

  private saveCheckpoint(checkpoint: AutoVideoAssetCheckpoint, expectedUpdatedAt?: string) {
    return this.store.saveAutoVideoAssetCheckpoint(checkpoint, expectedUpdatedAt);
  }

  private retryStage(step: AutoVideoStepName): RetryStage {
    if (step === 'transcription' || step === 'extract_audio') return 'transcription';
    if (step === 'asset_understanding') return 'asset_understanding';
    return step === 'planning' ? 'planning' : step === 'render' ? 'render' : 'visual_analysis';
  }

  private scheduleRetry(generation: AutoVideoGeneration, error: AutoVideoError, stage: RetryStage, checkpoint?: AutoVideoAssetCheckpoint) {
    if (this.store.isAutoVideoGenerationCancelRequested(generation.generationId)) return generation;
    const assetId = checkpoint?.assetId ?? generation.retryState?.assetId;
    const key = this.retryKey(stage, assetId)!;
    const previousRetryCount = generation.retryState?.attemptsByKey?.[key] ?? 0;
    const retryCount = previousRetryCount + 1;
    const totalAttempts = (generation.retryState?.totalAttempts ?? 0) + 1;
    const attemptsByKey = {...(generation.retryState?.attemptsByKey ?? {}), [key]: retryCount};
    const shouldWaitForService = previousRetryCount >= AUTO_VIDEO_MAX_RETRIES_PER_KEY || totalAttempts > AUTO_VIDEO_MAX_TOTAL_RETRIES;
    const recoveryAttempts = generation.retryState?.recoveryAttempts ?? 0;
    const nextRetryAt = shouldWaitForService
      ? new Date(Date.now() + this.recoveryDelay(recoveryAttempts)).toISOString()
      : new Date(Date.now() + AUTO_VIDEO_RETRY_DELAYS_MS[retryCount - 1]!).toISOString();
    if (checkpoint && stage === 'visual_analysis') {
      const attempts = checkpoint.visualAnalysis.attempts;
      this.saveCheckpoint({
        ...checkpoint,
        visualAnalysis: {
          ...checkpoint.visualAnalysis,
          status: 'retry_waiting',
          attempts,
          value: undefined,
          completedAt: undefined,
          lastError: error,
          nextRetryAt,
        },
      }, checkpoint.updatedAt);
    }
    const next = this.save(generation, {
      status: 'retry_waiting',
      error,
      completedAt: undefined,
      retryState: {
        status: shouldWaitForService ? 'waiting_for_service' : 'waiting',
        stage,
        ...(assetId ? {assetId} : {}),
        nextRetryAt,
        totalAttempts,
        attemptsByKey,
        recoveryAttempts,
        lastError: error,
        updatedAt: new Date().toISOString(),
      },
    });
    console.warn(JSON.stringify({timestamp: next.updatedAt, level: 'warn', event: shouldWaitForService ? 'auto_video.retry_paused_for_service' : 'auto_video.retry_scheduled', generationId: next.generationId, assetId, stage, retryCount, totalAttempts, errorCode: error.code, retryable: error.retryable, nextRetryAt}));
    this.scheduleGenerationRetry(next.generationId, nextRetryAt);
    return next;
  }

  private async runTranscription(asset: StoredAutoVideoAsset, generation: AutoVideoGeneration, existing: NormalizedTranscript | undefined, controller: AbortController): Promise<TranscriptionRunResult> {
    if (existing) return {transcript: existing, temporarilyDisabled: existing.model === 'transcription-temporarily-disabled'};
    if (!asset.metadata) throw new Error('MEDIA_PROBE_FAILED');
    const snapshot = generation.transcriptionSnapshot;
    if (!snapshot) {
      throw new TranscriptionProviderError(
        `Generation ${generation.generationId} does not contain a Qwen transcription snapshot.`,
        'QWEN_SNAPSHOT_REQUIRED',
        false,
      );
    }
    if (!asset.metadata.hasAudio) return {transcript: emptyNormalizedTranscript(asset.id, asset.metadata.durationMs, snapshot.model, snapshot.language), temporarilyDisabled: false};
    let working = asset;
    if (!working.temporaryAudioPath || !await filesExist([working.temporaryAudioPath])) {
      const temporaryAudioPath = await this.useMedia(generation, controller, () => extractAnalysisAudio(working, controller.signal));
      working = {...(this.store.getAutoVideoAsset(asset.id, asset.tenantId) ?? working), temporaryAudioPath};
      this.store.saveAutoVideoAsset(working);
    }
    if (!working.temporaryAudioPath) throw new Error('AUDIO_EXTRACTION_FAILED');
    const metadata = working.metadata;
    if (!metadata) throw new Error('MEDIA_PROBE_FAILED');
    this.throwIfCancelled(generation.generationId, controller);
    const provider = this.transcriptionRegistry.resolve(snapshot) as RawCapableProvider;
    try {
      const result = await this.transcriptionSemaphore.use(controller.signal, async () => {
        if (typeof provider.transcribeWithRaw === 'function') {
          const transcription = await provider.transcribeWithRaw({assetId: working.id, filePath: working.temporaryAudioPath!, durationMs: metadata.durationMs, language: snapshot.language, snapshot, signal: controller.signal});
          const rawTranscriptionPath = await writeGenerationRawTranscription(generation.projectId, generation.generationId, working.id, transcription.raw);
          this.store.saveAutoVideoAsset({...((this.store.getAutoVideoAsset(asset.id, asset.tenantId) ?? working)), rawTranscriptionPath});
          return {transcript: transcription.transcript, temporarilyDisabled: false};
        }
        return {transcript: await provider.transcribe({assetId: working.id, filePath: working.temporaryAudioPath!, durationMs: metadata.durationMs, language: snapshot.language, snapshot, signal: controller.signal}), temporarilyDisabled: false};
      });
      return result.value;
    } catch (error) {
      throw withAssetStage(error, working.id, 'transcription');
    }
  }

  private async runLegacyVisualAnalysis(asset: StoredAutoVideoAsset, generation: AutoVideoGeneration, relay: RelayClient, existing: ScreenshotAnalysis[], controller: AbortController): Promise<ScreenshotAnalysis[]> {
    if (existing.length) return existing;
    let working = asset;
    if (!await filesExist(working.screenshots.map((screenshot) => screenshot.filePath))) {
      const screenshots = await this.useMedia(generation, controller, () => extractScreenshots(working, controller.signal, 'legacy'));
      working = {...(this.store.getAutoVideoAsset(asset.id, asset.tenantId) ?? working), screenshots};
      this.store.saveAutoVideoAsset(working);
    }
    const ai = new AutoVideoAiProvider(relay, {
      ownerId: generation.ownerId,
      projectId: generation.projectId,
      generationId: generation.generationId,
      assetId: working.id,
    });
    try {
      const analyses = await mapWithConcurrency(working.screenshots, 3, async (screenshot) => {
        this.throwIfCancelled(generation.generationId, controller);
        return this.useVisualModel(generation, controller, 'base', async () => ai.analyzeScreenshot({screenshot, imageDataUrl: await screenshotAsDataUrl(screenshot), signal: controller.signal}));
      }, () => controller.abort());
      return analyses;
    } catch (error) { throw error; }
  }

  private async runLegacyAssetBranches(asset: StoredAutoVideoAsset, generation: AutoVideoGeneration, relay: RelayClient, controller: AbortController): Promise<AssetBranchResult> {
    const existingTranscript = generation.transcripts.find((transcript) => transcript.assetId === asset.id);
    const existingScreenshots = generation.screenshotAnalyses.filter((analysis) => analysis.assetId === asset.id);
    const [transcription, screenshotAnalyses] = await Promise.all([
      this.runTranscription(asset, generation, existingTranscript, controller),
      this.runLegacyVisualAnalysis(asset, generation, relay, existingScreenshots, controller).catch((error) => {
        throw withAssetStage(error, asset.id, 'visual_analysis');
      }),
    ]);
    const latest = this.store.getAutoVideoAsset(asset.id, asset.tenantId) ?? asset;
    return {asset: latest, transcript: transcription.transcript, transcriptionTemporarilyDisabled: transcription.temporarilyDisabled, screenshotAnalyses, normalizedFields: 0};
  }

  private async runBalancedAssetBranches(asset: StoredAutoVideoAsset, generation: AutoVideoGeneration, relay: RelayClient, controller: AbortController): Promise<AssetBranchResult> {
    let working = this.store.getAutoVideoAsset(asset.id, asset.tenantId) ?? asset;
    let checkpoint = this.checkpointFor(generation, working);
    this.throwIfCancelled(generation.generationId, controller);

    let transcription: TranscriptionRunResult;
    if (checkpoint.transcript.status !== 'pending' && checkpoint.transcript.value) {
      transcription = {transcript: checkpoint.transcript.value, temporarilyDisabled: checkpoint.transcript.value.model === 'transcription-temporarily-disabled'};
    } else {
      transcription = await this.runTranscription(working, generation, generation.transcripts.find((item) => item.assetId === asset.id), controller);
      checkpoint = this.saveCheckpoint({...checkpoint, transcript: {
        status: transcription.temporarilyDisabled ? 'skipped' : 'completed',
        value: transcription.transcript,
        completedAt: new Date().toISOString(),
      }}, checkpoint.updatedAt);
    }

    this.throwIfCancelled(generation.generationId, controller);
    let screenshots = working.screenshots.filter((screenshot) => checkpoint.screenshots.screenshotIds.includes(screenshot.id));
    if (checkpoint.screenshots.status !== 'completed' || !await filesExist(screenshots.map((screenshot) => screenshot.filePath))) {
      screenshots = await this.useMedia(generation, controller, () => extractScreenshots(working, controller.signal, 'balanced'));
      working = {...(this.store.getAutoVideoAsset(asset.id, asset.tenantId) ?? working), screenshots};
      this.store.saveAutoVideoAsset(working);
      checkpoint = this.saveCheckpoint({...checkpoint, screenshots: {
        status: 'completed', screenshotIds: screenshots.map((screenshot) => screenshot.id), completedAt: new Date().toISOString(),
      }}, checkpoint.updatedAt);
    }

    this.throwIfCancelled(generation.generationId, controller);
    let contactSheet = checkpoint.screenshots.contactSheetPath && await filesExist([checkpoint.screenshots.contactSheetPath])
      ? {filePath: checkpoint.screenshots.contactSheetPath, panels: screenshots.map((screenshot, index) => ({id: (['A', 'B', 'C'] as const)[index]!, timestampMs: screenshot.timestampMs}))}
      : undefined;
    if (!contactSheet) {
      contactSheet = await this.useMedia(generation, controller, () => createContactSheet(screenshots, controller.signal));
      working = {...(this.store.getAutoVideoAsset(asset.id, asset.tenantId) ?? working), screenshots, contactSheetPath: contactSheet.filePath};
      this.store.saveAutoVideoAsset(working);
      checkpoint = this.saveCheckpoint({...checkpoint, screenshots: {...checkpoint.screenshots, contactSheetPath: contactSheet.filePath}}, checkpoint.updatedAt);
    }

    if (checkpoint.visualAnalysis.status === 'completed' && checkpoint.visualAnalysis.value) {
      return {asset: working, transcript: transcription.transcript, transcriptionTemporarilyDisabled: transcription.temporarilyDisabled, visual: checkpoint.visualAnalysis.value, screenshotAnalyses: [], normalizedFields: 0};
    }

    checkpoint = this.saveCheckpoint({...checkpoint, visualAnalysis: {
      ...checkpoint.visualAnalysis,
      status: 'running',
      attempts: checkpoint.visualAnalysis.attempts + 1,
      value: undefined,
      completedAt: undefined,
      lastError: undefined,
      nextRetryAt: undefined,
    }}, checkpoint.updatedAt);
    const ai = new AutoVideoAiProvider(relay, {ownerId: generation.ownerId, projectId: generation.projectId, generationId: generation.generationId, assetId: working.id});
    try {
      const contactSheetDataUrls = [await screenshotAsDataUrl({id: `contact_${working.id}`, assetId: working.id, timestampMs: 0, filePath: contactSheet.filePath})];
      this.throwIfCancelled(generation.generationId, controller);
      const result = await this.useVisualModel(generation, controller, 'base', () => ai.analyzeAssetVisualSummary({
        assetId: working.id, metadata: working.metadata!, contactSheetDataUrls, panels: contactSheet.panels, userInstruction: generation.instructionSnapshot, signal: controller.signal,
      }));
      checkpoint = this.saveCheckpoint({...checkpoint, visualAnalysis: {
        ...checkpoint.visualAnalysis, status: 'completed', value: result.analysis, completedAt: new Date().toISOString(), lastError: undefined, nextRetryAt: undefined,
      }}, checkpoint.updatedAt);
      return {asset: working, transcript: transcription.transcript, transcriptionTemporarilyDisabled: transcription.temporarilyDisabled, visual: checkpoint.visualAnalysis.value!, screenshotAnalyses: [], normalizedFields: result.diagnostics.normalizedFields.length};
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('INVALID_MODEL_RESPONSE')) this.currentMetrics(generation).invalidModelResponses += 1;
      throw withAssetStage(error, working.id, 'visual_analysis');
    }
  }

  // Each generation persists its selected limit. Per-asset checkpoints make
  // concurrent preparation and recovery safe; the shared visual semaphore
  // keeps all active generations within the process-wide cap.
  private async runBalancedBranches(assets: StoredAutoVideoAsset[], generation: AutoVideoGeneration, relay: RelayClient, controller: AbortController) {
    return mapWithConcurrency(assets, this.visualConcurrencyFor(generation), async (asset) => {
      this.throwIfCancelled(generation.generationId, controller);
      return this.runBalancedAssetBranches(asset, generation, relay, controller);
    }, () => controller.abort());
  }

  private async renderCompletedGeneration(generation: AutoVideoGeneration, captions: AutoCaption[], controller: AbortController) {
    let next = generation;
    let output = autoVideoOutputSchema.parse(next.output ?? {status: 'pending'});
    const captionsCompleted = next.steps.find((step) => step.name === 'captions')?.status === 'completed';
    if (!captionsCompleted) {
      next = this.beginStep(next, 'captions');
      await writeAutoVideoGenerationCaptionJson(next.projectId, next.generationId, captions);
      await writeAutoVideoGenerationVtt(next.projectId, next.generationId, captions);
      this.throwIfCancelled(next.generationId, controller);
      next = this.completeStep(next, 'captions');
      output = {...output, captions: 'ready'};
      next = this.save(next, {output});
    }

    if (output.plainRender !== 'ready') {
      next = this.beginStep(next, 'render');
      output = {...output, status: 'rendering', plainRender: 'rendering'};
      next = this.save(next, {status: 'rendering', output});
      try {
        await renderAutoVideoGenerationPlain(next.projectId, next.generationId, next.timeline!, captions, controller.signal);
        output = {...output, plainRender: 'ready'};
        next = this.save(next, {output});
      } catch (error) {
        output = {...output, status: 'failed', plainRender: 'failed'};
        next = this.save(next, {output});
        throw error;
      }
    }
    if (output.captionedRender !== 'ready') {
      output = {...output, status: 'rendering', captionedRender: 'rendering'};
      next = this.save(next, {status: 'rendering', output});
      try {
        await renderAutoVideoGenerationCaptioned(next.projectId, next.generationId, next.timeline!, captions, controller.signal);
        output = {...output, captionedRender: 'ready'};
        next = this.save(next, {output});
      } catch (error) {
        output = {...output, status: 'failed', captionedRender: 'failed'};
        next = this.save(next, {output});
        throw error;
      }
    }
    const inspected = await inspectAutoVideoGenerationOutput(next.projectId, next.generationId);
    output = {...output, status: 'ready', inspection: 'ready'};
    next = this.completeStep(next, 'render');
    return this.save(next, {
      status: 'completed',
      output: {
        status: 'ready',
        captions: output.captions,
        plainRender: output.plainRender,
        captionedRender: output.captionedRender,
        inspection: output.inspection,
        durationMs: inspected.metadata.durationMs,
        width: inspected.metadata.width,
        height: inspected.metadata.height,
        fileSize: inspected.fileSize,
        captionedFileSize: inspected.captionedFileSize,
        renderedAt: new Date().toISOString(),
      },
      error: undefined,
      completedAt: new Date().toISOString(),
    });
  }

  private async runLocal(generation: AutoVideoGeneration, assets: StoredAutoVideoAsset[], controller: AbortController) {
    let next = this.save(generation, {status: 'analyzing', startedAt: generation.startedAt ?? new Date().toISOString(), error: undefined});
    if (next.steps.find((step) => step.name === 'local_prepare')?.status !== 'completed') {
      next = this.beginStep(next, 'local_prepare');
      for (const asset of assets) if (!asset.metadata) throw new Error('MEDIA_PROBE_FAILED');
      this.throwIfCancelled(next.generationId, controller);
      next = this.completeStep(next, 'local_prepare');
    }
    next = this.save(next, {status: 'planning'});
    if (next.steps.find((step) => step.name === 'local_timeline')?.status !== 'completed' || !next.timeline) {
      next = this.beginStep(next, 'local_timeline');
      const plan = next.editPlan ?? validateAutoEditPlan({
        projectId: next.projectId,
        clips: assets.map((asset, index) => ({assetId: asset.id, order: index + 1, reason: 'Local sequential composition.'})),
        excludedAssets: [],
        overallReason: 'No model call; composed in upload order.',
      }, next.projectId, next.assetIds);
      const timeline = next.timeline ?? compileAutoVideoGenerationTimeline(next, assets, plan);
      await Promise.all([
        writeGenerationJson(next.projectId, next.generationId, 'edit-plan.json', plan),
        writeGenerationJson(next.projectId, next.generationId, 'timeline.json', timeline),
      ]);
      next = this.save(next, {
        editPlan: plan,
        timeline,
        localSummary: 'No model call; composed in upload order.',
      });
      next = this.completeStep(next, 'local_timeline');
    }
    return this.renderCompletedGeneration(next, [], controller);
  }

  private async runConnected(generation: AutoVideoGeneration, assets: StoredAutoVideoAsset[], relay: RelayClient, controller: AbortController) {
    let next = this.save(generation, {status: 'analyzing', startedAt: generation.startedAt ?? new Date().toISOString(), error: undefined});
    if (next.steps.find((step) => step.name === 'probe')?.status !== 'completed') {
      next = this.beginStep(next, 'probe');
      for (const asset of assets) if (!asset.metadata) throw new Error('MEDIA_PROBE_FAILED');
      next = this.completeStep(next, 'probe');
    }

    const legacy = generation.analysisProfile?.name !== 'balanced-v1';
    const branchSteps: AutoVideoStepName[] = ['extract_audio', 'transcription', 'screenshots', 'visual_analysis'];
    let branchResults: AssetBranchResult[] = [];
    if (branchSteps.some((name) => next.steps.find((step) => step.name === name)?.status !== 'completed')) {
      for (const name of branchSteps) next = this.beginStep(next, name);
      branchResults = legacy
        ? await mapWithConcurrency(assets, this.assetConcurrency, (asset) => this.runLegacyAssetBranches(asset, next, relay, controller), () => controller.abort())
        : await this.runBalancedBranches(assets, next, relay, controller);
      next = this.save(next, {
        transcripts: branchResults.map((result) => result.transcript),
        screenshotAnalyses: branchResults.flatMap((result) => result.screenshotAnalyses),
      });
      for (const name of branchSteps) {
        const transcriptionTemporarilyDisabled = name === 'transcription' && branchResults.some((result) => result.transcriptionTemporarilyDisabled);
        next = this.completeStep(next, name, transcriptionTemporarilyDisabled ? 'Transcription service temporarily unavailable; skipped audio analysis.' : undefined);
      }
    }

    next = this.save(next, {status: 'planning'});
    const expectedAssetIds = assets.map((asset) => asset.id);
    const reusableAnalyses = hasCompleteAssetAnalyses(next.assetAnalyses, expectedAssetIds, !legacy);
    if (!reusableAnalyses) {
      next = this.beginStep(next, 'asset_understanding');
      const ai = new AutoVideoAiProvider(relay, {
        ownerId: next.ownerId,
        projectId: next.projectId,
        generationId: next.generationId,
      });
      let analyses: AssetAnalysis[];
      if (legacy) {
        analyses = await mapWithConcurrency(assets, this.assetConcurrency, async (asset) => this.useModel(next, controller, 'understanding', () => ai.understandAsset({
          assetId: asset.id,
          metadata: asset.metadata!,
          transcript: next.transcripts.find((transcript) => transcript.assetId === asset.id) ?? null,
          screenshots: next.screenshotAnalyses.filter((analysis) => analysis.assetId === asset.id),
          userInstruction: next.instructionSnapshot,
          signal: controller.signal,
        })), () => controller.abort());
      } else {
        if (!branchResults.length) {
          branchResults = await this.runBalancedBranches(assets, next, relay, controller);
        }
        // Contact-sheet analysis remains objective visual evidence. One batch
        // request now combines every transcript and visual result to assign
        // the final advertising role for the complete generation.
        const baseById = new Map(branchResults.map((result) => [result.asset.id, result]));
        const detailBudget = generation.analysisProfile?.name === 'balanced-v1' ? generation.analysisProfile.detailBudget : 0;
        const confidenceThreshold = Math.max(0, Math.min(1, Number(process.env.AUTO_VIDEO_VISUAL_DETAIL_CONFIDENCE ?? 0.65)));
        const asksForSequence = asksForChronologicalSequence(next.instructionSnapshot);
        const detailCandidates = branchResults.flatMap((result) => {
          const visual = result.visual;
          if (!visual) return [];
          const needsDetail = visual.confidence < confidenceThreshold
            || (visual.needsDetail && visual.detailTimestampMs !== undefined)
            || (asksForSequence && !visual.chronologicalHints.length);
          return needsDetail ? [{result, visual, timestampMs: visual.detailTimestampMs ?? Math.round(result.asset.metadata!.durationMs / 2)}] : [];
        }).sort((left, right) => left.visual.confidence - right.visual.confidence).slice(0, detailBudget);
        await mapWithConcurrency(detailCandidates, this.visualConcurrencyFor(next), async ({result, visual, timestampMs}) => {
          let detail: StoredVideoScreenshot | undefined;
          try {
            const detailScreenshot = await this.useMedia(next, controller, () => extractDetailScreenshot(result.asset, timestampMs, controller.signal));
            detail = detailScreenshot;
            const imageDataUrl = await screenshotAsDataUrl(detailScreenshot);
            const provider = new AutoVideoAiProvider(relay, {ownerId: next.ownerId, projectId: next.projectId, generationId: next.generationId, assetId: result.asset.id});
            const refined = await this.useVisualModel(next, controller, 'detail', () => provider.analyzeAssetVisualDetail({
              assetId: result.asset.id, metadata: result.asset.metadata!, timestampMs: detailScreenshot.timestampMs, imageDataUrl, baseAnalysis: visual, userInstruction: next.instructionSnapshot, signal: controller.signal,
            }));
            result.visual = mergeAssetVisualAnalysis(visual, refined.analysis);
            const checkpoint = this.store.getAutoVideoAssetCheckpoint(next.generationId, result.asset.id, next.tenantId);
            if (checkpoint?.visualAnalysis.status === 'completed') {
              this.saveCheckpoint({...checkpoint, visualAnalysis: {...checkpoint.visualAnalysis, value: result.visual}}, checkpoint.updatedAt);
            }
            result.normalizedFields += refined.diagnostics.normalizedFields.length;
          } catch (error) {
            // An optional detail pass never discards a valid base understanding.
            console.warn(JSON.stringify({level: 'warn', event: 'auto_video.visual_detail_failed', generationId: next.generationId, assetId: result.asset.id, error: error instanceof Error ? error.message : 'unknown'}));
          } finally {
            if (detail) await rm(detail.filePath, {force: true}).catch(() => undefined);
          }
        });
        const metrics = this.currentMetrics(next);
        metrics.normalizedModelFields += branchResults.reduce((total, result) => total + result.normalizedFields, 0);
        const roleInput = marketingRoleBatchInputSchema.parse({
          schema: 'auto-video-marketing-role-batch-input.v1',
          projectId: next.projectId,
          assets: assets.map((asset) => {
            const result = baseById.get(asset.id);
            if (!result?.visual) throw new Error('VISUAL_ANALYSIS_FAILED');
            return {
              assetId: asset.id,
              durationMs: asset.metadata!.durationMs,
              transcript: result.transcript.text.trim(),
              visualSummary: result.visual.visualSummary,
              actions: result.visual.actions,
              scenes: result.visual.scenes,
              screenTexts: result.visual.screenTexts,
              chronologicalHints: result.visual.chronologicalHints,
            };
          }),
          userInstruction: next.instructionSnapshot,
        });
        this.throwIfCancelled(next.generationId, controller);
        const roleResult = await this.useModel(next, controller, 'understanding', () => ai.assignMarketingRolesBatch({...roleInput, signal: controller.signal}))
          .catch((error) => { throw withStage(error, 'asset_understanding'); });
        const assignmentById = new Map(roleResult.assets.map((assignment) => [assignment.assetId, assignment]));
        analyses = assets.map((asset) => {
          const result = baseById.get(asset.id);
          if (!result?.visual) throw new Error('VISUAL_ANALYSIS_FAILED');
          const assignment = assignmentById.get(asset.id);
          if (!assignment) {
            const error = new Error(`MARKETING_ROLE_ASSIGNMENT_INVALID: missing assetId: ${asset.id}`) as CodedError;
            error.code = 'MARKETING_ROLE_ASSIGNMENT_INVALID';
            error.retryable = false;
            throw withStage(error, 'asset_understanding');
          }
          return toAssetAnalysis(result.visual, result.transcript, assignment);
        });
      }
      next = this.save(next, {assetAnalyses: analyses});
      next = this.completeStep(next, 'asset_understanding');
    } else if (next.steps.find((step) => step.name === 'asset_understanding')?.status !== 'completed') {
      next = this.completeStep(next, 'asset_understanding');
    }

    if (!next.editPlan) {
      next = this.beginStep(next, 'planning');
      const ai = new AutoVideoAiProvider(relay, {
        ownerId: next.ownerId,
        projectId: next.projectId,
        generationId: next.generationId,
      });
      const editPlan = await this.useModel(next, controller, 'planning', () => ai.plan({
        projectId: next.projectId,
        analyses: next.assetAnalyses,
        assetDurations: assets.map((asset) => ({assetId: asset.id, durationMs: asset.metadata!.durationMs})),
        canvas: next.canvas,
        userInstruction: next.instructionSnapshot, signal: controller.signal,
      }));
      next = this.save(next, {editPlan});
      await writeGenerationJson(next.projectId, next.generationId, 'edit-plan.json', editPlan);
      next = this.completeStep(next, 'planning');
    }

    if (next.steps.find((step) => step.name === 'timeline')?.status !== 'completed' || !next.timeline) {
      next = this.beginStep(next, 'timeline');
      const timeline = next.timeline ?? compileAutoVideoGenerationTimeline(next, assets, next.editPlan!);
      await writeGenerationJson(next.projectId, next.generationId, 'timeline.json', timeline);
      next = this.save(next, {timeline});
      next = this.completeStep(next, 'timeline');
    }
    const captions = globalizeCaptions(
      assets.map((asset) => transcriptToCaptions(asset.id, next.transcripts.find((transcript) => transcript.assetId === asset.id) ?? null)),
      next.timeline!,
    );
    return this.renderCompletedGeneration(next, captions, controller);
  }

  private async cleanupGenerationTemporaryFiles(generation: AutoVideoGeneration) {
    try {
      const assets = this.store.resolveAutoVideoAssets(generation.assetIds, generation.tenantId, generation.projectId);
      await Promise.all(assets.map(async (asset) => {
        const latest = this.store.getAutoVideoAsset(asset.id, asset.tenantId) ?? asset;
        this.store.saveAutoVideoAsset(await cleanupAssetAnalysisFiles(latest));
      }));
    } catch (error) {
      console.warn(JSON.stringify({level: 'warn', event: 'auto_video.cleanup_failed', generationId: generation.generationId, error: error instanceof Error ? error.message : 'unknown'}));
    }
  }

  private async run(generationId: string) {
    const controller = new AbortController();
    this.controllers.set(generationId, controller);
    let generation = this.store.getAutoVideoGeneration(generationId);
    if (!generation || ['completed', 'failed', 'cancelled', 'needs_attention'].includes(generation.status) || this.store.isAutoVideoGenerationCancelRequested(generationId)) return;
    let currentStep: AutoVideoStepName = generation.aiMode.kind === 'local' ? 'local_prepare' : 'probe';
    try {
      this.throwIfCancelled(generationId, controller);
      const assets = this.store.resolveAutoVideoAssets(generation.assetIds, generation.tenantId, generation.projectId);
      if (!assets.length) throw new Error('INVALID_UPLOAD');
      this.startMetrics(generation, assets.length);
      if (generation.aiMode.kind === 'local') {
        currentStep = 'local_prepare';
        generation = await this.runLocal(generation, assets, controller);
      } else {
        if (generation.aiMode.kind !== 'connected') throw new Error('VISUAL_ANALYSIS_FAILED');
        const relay = this.resolveRelay?.(generation.tenantId, generation.connectionId, generation.model, generation.reasoningEffort);
        if (!relay) throw new Error('VISUAL_ANALYSIS_FAILED');
        currentStep = 'probe';
        generation = await this.runConnected(generation, assets, relay, controller);
      }
      generation = this.save(generation, {analysisMetrics: this.currentMetrics(generation), retryState: {status: 'none', totalAttempts: 0, attemptsByKey: {}, recoveryAttempts: 0, updatedAt: new Date().toISOString()}});
      await this.cleanupGenerationTemporaryFiles(generation);
      this.store.audit(generation.tenantId, 'auto-video-worker', 'auto-video.generation.completed', 'auto-video-generation', generation.generationId, {
        timelineId: `timeline_${randomUUID()}`,
        clipCount: generation.timeline?.clips.length ?? 0,
      });
    } catch (caught) {
      const latest = this.store.getAutoVideoGeneration(generationId);
      if (!latest) return;
      if (this.store.isAutoVideoGenerationCancelRequested(generationId) || (caught instanceof Error && caught.message === 'cancelled')) {
        this.cancelScheduledGenerationRetry(generationId);
        generation = this.save(latest, {
          status: 'cancelled',
          completedAt: new Date().toISOString(),
          error: undefined,
          retryState: {status: 'paused_by_user', totalAttempts: latest.retryState?.totalAttempts ?? 0, attemptsByKey: latest.retryState?.attemptsByKey ?? {}, recoveryAttempts: latest.retryState?.recoveryAttempts ?? 0, lastError: latest.retryState?.lastError, updatedAt: new Date().toISOString()},
        });
        this.store.audit(generation.tenantId, 'auto-video-worker', 'auto-video.generation.cancelled', 'auto-video-generation', generation.generationId);
        return;
      }
      // Any non-user failure stops the complete attempt before scheduling the
      // next one. This prevents late sibling media/model calls from racing a
      // persisted retry of the same generation.
      controller.abort();
      if (caught instanceof Error && typeof (caught as CodedError).assetId === 'string') {
        const error = toAutoVideoError(caught);
        const checkpoint = this.store.getAutoVideoAssetCheckpoint(latest.generationId, (caught as CodedError).assetId as string, latest.tenantId);
        if (error.retryable && checkpoint) {
          this.scheduleRetry(latest, error, (caught as CodedError).retryStage ?? 'visual_analysis', checkpoint);
          return;
        }
      }
      const error = toAutoVideoError(caught);
      if (error.retryable) {
        const runningStep = latest.steps.find((step) => step.status === 'running')?.name as AutoVideoStepName | undefined;
        this.scheduleRetry(latest, error, (caught as CodedError).retryStage ?? this.retryStage(runningStep ?? currentStep));
        return;
      }
      const runningStep = latest.steps.find((step) => step.status === 'running')?.name as AutoVideoStepName | undefined;
      const failed = this.failStep(latest, stepForError(error, runningStep ?? currentStep), error);
      generation = this.save(failed, {
        status: 'needs_attention',
        error,
        retryState: {status: 'needs_attention', stage: this.retryStage(runningStep ?? currentStep), totalAttempts: latest.retryState?.totalAttempts ?? 0, attemptsByKey: latest.retryState?.attemptsByKey ?? {}, recoveryAttempts: latest.retryState?.recoveryAttempts ?? 0, lastError: error, updatedAt: new Date().toISOString()},
        analysisMetrics: this.currentMetrics(latest),
        completedAt: new Date().toISOString(),
        output: latest.output?.status === 'rendering' ? autoVideoOutputSchema.parse({...latest.output, status: 'failed'}) : latest.output,
      });
      this.store.audit(generation.tenantId, 'auto-video-worker', 'auto-video.generation.failed', 'auto-video-generation', generation.generationId, {error});
      console.error(JSON.stringify({timestamp: generation.updatedAt, level: 'error', event: 'auto_video.generation_failed', generationId: generation.generationId, error}));
    }
  }
}

