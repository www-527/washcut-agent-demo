import {Blob} from 'node:buffer';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {
  normalizedTranscriptSchema,
  type NormalizedTranscript,
  type TranscriptSegment,
  type TranscriptWord,
  type TranscriptionProviderStatus,
} from '../shared/auto-video-contracts.js';
import {
  TranscriptionProviderError,
  toProviderError,
  type TranscriptionInput,
  type TranscriptionProvider,
  type TranscriptionProviderStopResult,
  type TranscriptionResult,
} from './transcription-provider.js';

type SpeachesWord = {word?: unknown; text?: unknown; start?: unknown; end?: unknown; probability?: unknown; confidence?: unknown};
type SpeachesSegment = {text?: unknown; start?: unknown; end?: unknown; avg_logprob?: unknown; probability?: unknown; confidence?: unknown};
type SpeachesResponse = {text?: unknown; language?: unknown; words?: unknown; segments?: unknown};

export type {TranscriptionInput, TranscriptionProvider, TranscriptionResult} from './transcription-provider.js';
export type TranscriptionStatus = TranscriptionProviderStatus;

const asConfidence = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
const asFiniteNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN;
const normalizeText = (value: unknown) => typeof value === 'string' ? value.trim() : '';

const normalizeRange = (startSeconds: unknown, endSeconds: unknown, durationMs: number) => {
  const start = asFiniteNumber(startSeconds);
  const end = asFiniteNumber(endSeconds);
  if (start < 0 || end <= start || !Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  const boundedStart = Math.max(0, Math.min(durationMs, Math.round(start * 1_000)));
  const boundedEnd = Math.max(0, Math.min(durationMs, Math.round(end * 1_000)));
  return boundedStart < boundedEnd ? {startMs: boundedStart, endMs: boundedEnd} : undefined;
};

export const emptyNormalizedTranscript = (
  assetId: string,
  durationMs: number,
  model: string,
  language = 'zh',
  provider: 'speaches-whisper' | 'qwen3-asr' = 'speaches-whisper',
) => normalizedTranscriptSchema.parse({
  assetId,
  language,
  durationMs,
  text: '',
  words: [],
  segments: [],
  provider,
  model,
});

export const normalizeSpeachesResponse = (raw: unknown, input: {assetId: string; durationMs: number; model: string; language?: string}) => {
  if (!raw || typeof raw !== 'object') throw new TranscriptionProviderError('Speaches returned an invalid transcription payload.', 'SPEACHES_INVALID_RESPONSE', false);
  const response = raw as SpeachesResponse;
  const words: TranscriptWord[] = Array.isArray(response.words) ? response.words.flatMap((value) => {
    const word = value as SpeachesWord;
    const text = normalizeText(word.word ?? word.text);
    const range = normalizeRange(word.start, word.end, input.durationMs);
    return text && range ? [{text, ...range, confidence: asConfidence(word.confidence ?? word.probability)}] : [];
  }) : [];
  const segments: TranscriptSegment[] = Array.isArray(response.segments) ? response.segments.flatMap((value) => {
    const segment = value as SpeachesSegment;
    const text = normalizeText(segment.text);
    const range = normalizeRange(segment.start, segment.end, input.durationMs);
    return text && range ? [{text, ...range, confidence: asConfidence(segment.confidence ?? segment.probability)}] : [];
  }) : [];
  const text = normalizeText(response.text) || segments.map((segment) => segment.text).join('');
  return normalizedTranscriptSchema.parse({
    assetId: input.assetId,
    language: typeof response.language === 'string' && response.language.trim() ? response.language.trim() : input.language,
    durationMs: input.durationMs,
    text,
    words,
    segments,
    provider: 'speaches-whisper',
    model: input.model,
  });
};

const toBaseUrl = (value: string) => value.endsWith('/') ? value : `${value}/`;
const retryDelay = (attempt: number) => new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt));
const combinedSignal = (signal: AbortSignal | undefined, timeoutMs: number) => signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);

const responseError = async (response: Response, fallbackCode: string) => {
  const body = await response.text();
  let parsed: unknown;
  try { parsed = body ? JSON.parse(body) : undefined; } catch { parsed = undefined; }
  const candidate = parsed && typeof parsed === 'object' && 'error' in parsed
    ? (parsed as {error?: unknown}).error
    : parsed;
  if (candidate && typeof candidate === 'object') {
    const record = candidate as {code?: unknown; message?: unknown; retryable?: unknown; details?: unknown};
    if (typeof record.code === 'string' && typeof record.message === 'string' && typeof record.retryable === 'boolean') {
      return new TranscriptionProviderError(record.message, record.code, record.retryable, typeof record.details === 'string' ? record.details : undefined);
    }
  }
  return new TranscriptionProviderError(
    `Speaches HTTP ${response.status}: ${body.slice(0, 8_000) || response.statusText}`,
    fallbackCode,
    response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500,
  );
};

export class SpeachesTranscriptionProvider implements TranscriptionProvider {
  readonly id = 'speaches-whisper' as const;
  private readonly baseUrl: string;
  private readonly processUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(private readonly config: {baseUrl: string; apiKey?: string; model: string; timeoutMs?: number; maxRetries?: number}) {
    this.baseUrl = toBaseUrl(config.baseUrl);
    this.processUrl = new URL('../api/ps', this.baseUrl).toString();
    this.timeoutMs = config.timeoutMs ?? 600_000;
    this.maxRetries = config.maxRetries ?? 2;
  }

  private headers() { return this.config.apiKey ? {authorization: `Bearer ${this.config.apiKey}`} : undefined; }

  async healthCheck() {
    try {
      const response = await fetch(new URL('models', this.baseUrl), {headers: this.headers(), signal: AbortSignal.timeout(Math.min(this.timeoutMs, 15_000))});
      return response.ok;
    } catch { return false; }
  }

  private async listModels() {
    const response = await fetch(new URL('models', this.baseUrl), {headers: this.headers(), signal: AbortSignal.timeout(Math.min(this.timeoutMs, 15_000))});
    if (!response.ok) throw await responseError(response, 'SPEACHES_MODELS_FAILED');
    const raw = await response.json() as {data?: Array<{id?: unknown}>};
    return Array.isArray(raw.data) ? raw.data.flatMap((item) => typeof item?.id === 'string' ? [item.id] : []) : [];
  }

  private async listLoadedModels() {
    const response = await fetch(this.processUrl, {headers: this.headers(), signal: AbortSignal.timeout(Math.min(this.timeoutMs, 15_000))});
    if (!response.ok) throw await responseError(response, 'SPEACHES_RUNNING_MODELS_FAILED');
    const raw: unknown = await response.json();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new TranscriptionProviderError('Speaches returned an invalid loaded-model payload.', 'SPEACHES_RUNNING_MODELS_INVALID_RESPONSE', false);
    }
    const groups = Object.values(raw);
    if (groups.some((group) => !Array.isArray(group) || group.some((model) => typeof model !== 'string'))) {
      throw new TranscriptionProviderError('Speaches returned an invalid loaded-model payload.', 'SPEACHES_RUNNING_MODELS_INVALID_RESPONSE', false);
    }
    return groups.flat() as string[];
  }

  private modelProcessUrl() {
    return new URL(`../api/ps/${encodeURIComponent(this.config.model)}`, this.baseUrl);
  }

  private async unloadModel() {
    const controller = new AbortController();
    let controlError: TranscriptionProviderError | undefined;
    const fallback = {code: 'SPEACHES_MODEL_STOP_FAILED', message: 'Speaches model unload failed.', retryable: false};
    const controlRequest = fetch(this.modelProcessUrl(), {
      method: 'DELETE',
      headers: this.headers(),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(this.timeoutMs)]),
    }).then(async (response) => {
      if (!response.ok) throw await responseError(response, fallback.code);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) controlError = toProviderError(error, fallback);
    });
    const deadline = Date.now() + this.timeoutMs;
    try {
      while (Date.now() < deadline) {
        if (controlError) {
          const loaded = (await this.listLoadedModels()).includes(this.config.model);
          if (!loaded) return;
          throw controlError;
        }
        const loaded = (await this.listLoadedModels()).includes(this.config.model);
        if (!loaded) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new TranscriptionProviderError(
        `Speaches did not confirm that model ${this.config.model} was unloaded before the control timeout.`,
        'SPEACHES_MODEL_UNLOAD_NOT_CONFIRMED',
        false,
      );
    } finally {
      controller.abort();
      await controlRequest;
    }
  }

  async status(): Promise<TranscriptionProviderStatus> {
    try {
      const [models] = await Promise.all([this.listModels(), this.listLoadedModels()]);
      const installed = models.includes(this.config.model);
      const ready = installed;
      const error = installed ? undefined : new TranscriptionProviderError(`Speaches model ${this.config.model} is not installed.`, 'SPEACHES_MODEL_NOT_INSTALLED', true);
      return {
        id: this.id,
        label: 'Whisper large-v3（默认）',
        configured: true,
        reachable: true,
        ready,
        model: this.config.model,
        supportsWordTimestamps: ready,
        supportsSegmentTimestamps: ready,
        message: ready ? 'Speaches 已连接，Whisper 字幕转写模型可用；首次转写时按需加载。' : error!.message,
        ...(error ? {error: {code: error.code, message: error.message, retryable: error.retryable}} : {}),
      };
    } catch (error) {
      const source = error instanceof TranscriptionProviderError ? error : new TranscriptionProviderError(error instanceof Error ? error.message : 'Speaches is unreachable.', 'SPEACHES_UNREACHABLE', true);
      return {
        id: this.id,
        label: 'Whisper large-v3（默认）',
        configured: true,
        reachable: false,
        ready: false,
        model: this.config.model,
        supportsWordTimestamps: false,
        supportsSegmentTimestamps: false,
        message: source.message,
        error: {code: source.code, message: source.message, retryable: source.retryable, ...(source.details ? {details: source.details} : {})},
      };
    }
  }

  async start(): Promise<TranscriptionProviderStatus> {
    const current = await this.status();
    if (!current.reachable || current.ready) return current;
    try {
      if (current.error?.code === 'SPEACHES_MODEL_NOT_INSTALLED') {
        const download = await fetch(new URL(`models/${encodeURIComponent(this.config.model)}`, this.baseUrl), {
          method: 'POST', headers: this.headers(), signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!download.ok) throw await responseError(download, 'SPEACHES_MODEL_DOWNLOAD_FAILED');
      }
      return await this.status();
    } catch (error) {
      const source = error instanceof TranscriptionProviderError ? error : new TranscriptionProviderError(error instanceof Error ? error.message : 'Speaches model start failed.', 'SPEACHES_MODEL_START_FAILED', true);
      return {...current, message: source.message, error: {code: source.code, message: source.message, retryable: source.retryable, ...(source.details ? {details: source.details} : {})}};
    }
  }

  async stop(): Promise<TranscriptionProviderStopResult> {
    const loadedBefore = await this.listLoadedModels();
    if (!loadedBefore.includes(this.config.model)) {
      return {
        providerId: this.id,
        stopped: true,
        gpuMemoryReleased: true,
        message: `Speaches model ${this.config.model} was already unloaded.`,
      };
    }
    await this.unloadModel();
    const loadedAfter = await this.listLoadedModels();
    if (loadedAfter.includes(this.config.model)) {
      throw new TranscriptionProviderError(
        `Speaches still reports model ${this.config.model} as loaded after the unload request.`,
        'SPEACHES_MODEL_UNLOAD_NOT_CONFIRMED',
        false,
      );
    }
    return {
      providerId: this.id,
      stopped: true,
      gpuMemoryReleased: true,
      message: `Speaches confirmed model ${this.config.model} is no longer loaded.`,
    };
  }

  async transcribe(input: TranscriptionInput) { return (await this.transcribeWithRaw(input)).transcript; }

  async transcribeWithRaw(input: TranscriptionInput): Promise<TranscriptionResult> {
    const model = input.snapshot?.model ?? this.config.model;
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        if (input.signal?.aborted) throw new Error('cancelled');
        const audio = await readFile(input.filePath);
        const form = new FormData();
        form.set('file', new Blob([audio], {type: 'audio/wav'}), path.basename(input.filePath));
        form.set('model', model);
        form.set('response_format', 'verbose_json');
        form.append('timestamp_granularities[]', 'segment');
        form.append('timestamp_granularities[]', 'word');
        form.set('temperature', '0');
        form.set('language', input.language ?? 'zh');
        const response = await fetch(new URL('audio/transcriptions', this.baseUrl), {
          method: 'POST', headers: this.headers(), body: form, signal: combinedSignal(input.signal, this.timeoutMs),
        });
        if (!response.ok) throw await responseError(response, 'SPEACHES_TRANSCRIPTION_FAILED');
        const raw = await response.json();
        return {transcript: normalizeSpeachesResponse(raw, {...input, model}), raw};
      } catch (error) {
        if (input.signal?.aborted || (error instanceof Error && error.message === 'cancelled')) throw new Error('cancelled');
        lastError = error;
        const retryable = error instanceof TranscriptionProviderError ? error.retryable : true;
        if (!retryable || attempt >= this.maxRetries) break;
        await retryDelay(attempt);
      }
    }
    if (lastError instanceof TranscriptionProviderError) throw lastError;
    throw new TranscriptionProviderError(lastError instanceof Error ? lastError.message : 'Speaches transcription failed.', 'SPEACHES_TRANSCRIPTION_FAILED', true);
  }
}

/** A deliberately empty, explicitly labelled development fallback. */
export class DemoTranscriptionProvider implements TranscriptionProvider {
  readonly id = 'speaches-whisper' as const;
  async healthCheck() { return false; }
  async status(): Promise<TranscriptionProviderStatus> {
    return {id: this.id, label: 'Whisper large-v3（默认）', configured: false, reachable: false, ready: false, model: 'demo-no-speaches', supportsWordTimestamps: false, supportsSegmentTimestamps: false, message: '当前未配置 Speaches 转写服务；演示模式将生成空字幕轨。', error: {code: 'SPEACHES_NOT_CONFIGURED', message: 'Speaches is not configured in demo mode.', retryable: false}};
  }
  async start() { return this.status(); }
  async stop(): Promise<TranscriptionProviderStopResult> { return {providerId: this.id, stopped: true, gpuMemoryReleased: true, message: 'Demo transcription does not allocate GPU memory.'}; }
  async transcribe(input: TranscriptionInput) { return emptyNormalizedTranscript(input.assetId, input.durationMs, input.snapshot?.model ?? 'demo-no-speaches', input.language ?? 'zh'); }
  async transcribeWithRaw(input: TranscriptionInput): Promise<TranscriptionResult> { return {transcript: await this.transcribe(input), raw: {mode: 'demo-no-speaches'}}; }
}

export class UnavailableTranscriptionProvider implements TranscriptionProvider {
  readonly id = 'speaches-whisper' as const;
  async healthCheck() { return false; }
  async status(): Promise<TranscriptionProviderStatus> {
    return {id: this.id, label: 'Whisper large-v3（默认）', configured: false, reachable: false, ready: false, model: 'unavailable', supportsWordTimestamps: false, supportsSegmentTimestamps: false, message: '当前未配置 Speaches 转写服务。', error: {code: 'SPEACHES_NOT_CONFIGURED', message: 'Speaches is not configured.', retryable: false}};
  }
  async start() { return this.status(); }
  async stop(): Promise<TranscriptionProviderStopResult> { return {providerId: this.id, stopped: true, gpuMemoryReleased: true, message: 'Unavailable transcription does not allocate GPU memory.'}; }
  async transcribe(): Promise<NormalizedTranscript> { throw new TranscriptionProviderError('Speaches is not configured.', 'SPEACHES_NOT_CONFIGURED', false); }
}

export const createTranscriptionProvider = (): TranscriptionProvider => {
  const baseUrl = process.env.SPEACHES_BASE_URL;
  if (baseUrl) return new SpeachesTranscriptionProvider({
    baseUrl,
    apiKey: process.env.SPEACHES_API_KEY,
    model: process.env.SPEACHES_MODEL ?? 'Systran/faster-whisper-large-v3',
    timeoutMs: Number(process.env.SPEACHES_TIMEOUT_MS ?? 600_000),
    maxRetries: Number(process.env.SPEACHES_MAX_RETRIES ?? 2),
  });
  if (process.env.DEMO_MODE !== 'false') return new DemoTranscriptionProvider();
  return new UnavailableTranscriptionProvider();
};
