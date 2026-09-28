import {Blob} from 'node:buffer';
import {spawn, type ChildProcess} from 'node:child_process';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {
  normalizedTranscriptSchema,
  type TranscriptSegment,
  type TranscriptWord,
  type TranscriptionProviderStatus,
  type TranscriptionRunSnapshot,
} from '../shared/auto-video-contracts.js';
import {
  TranscriptionProviderError,
  type TranscriptionInput,
  type TranscriptionProvider,
  type TranscriptionProviderStopResult,
  type TranscriptionResult,
} from './transcription-provider.js';

type GatewayError = {code?: unknown; message?: unknown; retryable?: unknown; details?: unknown};
type GatewayHealthComponent = {ready?: unknown; model?: unknown; serviceVersion?: unknown};
type GatewayHealth = {asr?: GatewayHealthComponent; aligner?: GatewayHealthComponent; ready?: unknown; model?: unknown; serviceVersion?: unknown};
type TimedToken = {text?: unknown; word?: unknown; startMs?: unknown; endMs?: unknown; confidence?: unknown};
type QwenTranscribeResponse = {text?: unknown; language?: unknown; detectedLanguage?: unknown; serviceVersion?: unknown};
type QwenAlignResponse = {words?: unknown; segments?: unknown; alignmentModel?: unknown; serviceVersion?: unknown};
type QwenUnloadResponse = {ready?: unknown; gpuMemoryReleased?: unknown; gpuMemory?: {allocatedBytes?: unknown; reservedBytes?: unknown}};
type QwenVocabularyProfile = TranscriptionRunSnapshot['vocabularyProfile'];

export const QWEN_ASR_DEFAULT_VOCABULARY_PROFILE: QwenVocabularyProfile = 'car-wash-ad-zh-v2';

export const parseQwenVocabularyProfile = (value: string | undefined): QwenVocabularyProfile => {
  const profile = value?.trim() || QWEN_ASR_DEFAULT_VOCABULARY_PROFILE;
  if (profile === 'car-wash-zh-v1' || profile === 'car-wash-ad-zh-v2') return profile;
  throw new TranscriptionProviderError(
    `Unsupported Qwen vocabulary profile: ${profile}`,
    'QWEN_ASR_VOCABULARY_PROFILE_UNSUPPORTED',
    false,
  );
};

const asText = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const asConfidence = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
const asMs = (value: unknown, durationMs: number) => typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0 && value <= durationMs ? value : undefined;
const retryDelay = (attempt: number) => new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt));
const startupDelay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const isRetryableHttpStatus = (status: number) => status === 408 || status === 425 || status === 429 || status >= 500;
const withTimeout = (signal: AbortSignal | undefined, timeoutMs: number) => signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
const normalizedBaseUrl = (value: string) => value.endsWith('/') ? value : `${value}/`;
const errorFromBody = (raw: unknown, fallback: {code: string; message: string; retryable: boolean}) => {
  const candidate = raw && typeof raw === 'object' && 'error' in raw ? (raw as {error?: unknown}).error : raw;
  if (candidate && typeof candidate === 'object') {
    const error = candidate as GatewayError;
    if (typeof error.code === 'string' && typeof error.message === 'string' && typeof error.retryable === 'boolean') {
      return new TranscriptionProviderError(error.message, error.code, error.retryable, typeof error.details === 'string' ? error.details : undefined);
    }
  }
  return new TranscriptionProviderError(fallback.message, fallback.code, fallback.retryable);
};

const parseJson = async (response: Response, fallback: {code: string; message: string; retryable: boolean}) => {
  const body = await response.text();
  let parsed: unknown;
  try { parsed = body ? JSON.parse(body) : undefined; } catch {
    if (!response.ok) throw new TranscriptionProviderError(`${fallback.message}: ${body.slice(0, 8_000) || response.statusText}`, fallback.code, isRetryableHttpStatus(response.status));
    throw new TranscriptionProviderError(`${fallback.message}: gateway returned non-JSON.`, `${fallback.code}_INVALID_JSON`, false);
  }
  if (!response.ok) throw errorFromBody(parsed, {...fallback, retryable: isRetryableHttpStatus(response.status)});
  return parsed;
};

const normalizeTokens = (value: unknown, durationMs: number, kind: 'word' | 'segment') => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const token = entry as TimedToken;
    const text = asText(kind === 'word' ? token.word ?? token.text : token.text);
    const startMs = asMs(token.startMs, durationMs);
    const endMs = asMs(token.endMs, durationMs);
    return text && startMs !== undefined && endMs !== undefined && startMs < endMs
      ? [{text, startMs, endMs, confidence: asConfidence(token.confidence)}]
      : [];
  });
};

export const normalizeQwenAlignedResponse = (
  transcribed: unknown,
  aligned: unknown,
  input: {assetId: string; durationMs: number; model: string; alignmentModel: string; language?: string},
) => {
  if (!transcribed || typeof transcribed !== 'object') throw new TranscriptionProviderError('Qwen ASR returned an invalid transcription payload.', 'QWEN_ASR_INVALID_RESPONSE', false);
  if (!aligned || typeof aligned !== 'object') throw new TranscriptionProviderError('Qwen forced aligner returned an invalid alignment payload.', 'QWEN_ALIGN_INVALID_RESPONSE', false);
  const asr = transcribed as QwenTranscribeResponse;
  const alignment = aligned as QwenAlignResponse;
  const text = asText(asr.text);
  const words = normalizeTokens(alignment.words, input.durationMs, 'word') as TranscriptWord[];
  const segments = normalizeTokens(alignment.segments, input.durationMs, 'segment') as TranscriptSegment[];
  if (text && (!words.length || !segments.length)) {
    throw new TranscriptionProviderError('Qwen forced aligner returned no valid word and segment timestamps for non-empty text.', 'QWEN_ALIGN_TIMESTAMPS_MISSING', false);
  }
  return normalizedTranscriptSchema.parse({
    assetId: input.assetId,
    language: asText(asr.detectedLanguage ?? asr.language) || input.language || 'zh',
    durationMs: input.durationMs,
    text,
    words,
    segments,
    provider: 'qwen3-asr',
    model: input.model,
  });
};

export class Qwen3AsrTranscriptionProvider implements TranscriptionProvider {
  readonly id = 'qwen3-asr' as const;
  private readonly asrBaseUrl?: string;
  private readonly alignBaseUrl?: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly model: string;
  private readonly alignmentModel: string;
  private readonly vocabularyProfile: QwenVocabularyProfile;
  private readonly apiKey?: string;
  private gatewayProcess?: ChildProcess;
  private gatewayProcessError?: Error;

  constructor(config: {baseUrl?: string; alignBaseUrl?: string; apiKey?: string; model?: string; alignmentModel?: string; vocabularyProfile?: string; timeoutMs?: number; maxRetries?: number}) {
    this.asrBaseUrl = config.baseUrl ? normalizedBaseUrl(config.baseUrl) : undefined;
    this.alignBaseUrl = (config.alignBaseUrl ?? config.baseUrl) ? normalizedBaseUrl(config.alignBaseUrl ?? config.baseUrl!) : undefined;
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'Qwen/Qwen3-ASR-1.7B';
    this.alignmentModel = config.alignmentModel ?? 'Qwen/Qwen3-ForcedAligner-0.6B';
    this.vocabularyProfile = parseQwenVocabularyProfile(config.vocabularyProfile);
    this.timeoutMs = config.timeoutMs ?? 600_000;
    this.maxRetries = config.maxRetries ?? 2;
  }

  private headers() { return this.apiKey ? {authorization: `Bearer ${this.apiKey}`} : undefined; }
  private configured() { return Boolean(this.asrBaseUrl && this.alignBaseUrl); }
  private localGatewayConfig() {
    if (!this.asrBaseUrl || !this.alignBaseUrl) return undefined;
    let asr: URL;
    let aligner: URL;
    try {
      asr = new URL(this.asrBaseUrl);
      aligner = new URL(this.alignBaseUrl);
    } catch { return undefined; }
    const localHosts = new Set(['127.0.0.1', 'localhost', '::1']);
    if (!localHosts.has(asr.hostname) || asr.origin !== aligner.origin) return undefined;
    const gatewayDir = path.resolve(process.env.QWEN_GATEWAY_DIR ?? path.join(process.cwd(), 'qwen3-asr-gateway'));
    const configuredPython = process.env.QWEN_GATEWAY_PYTHON?.trim();
    const candidates = [
      configuredPython,
      path.join(gatewayDir, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python'),
    ].filter((candidate): candidate is string => Boolean(candidate));
    const python = candidates.find((candidate) => path.isAbsolute(candidate) && existsSync(candidate)) ?? (configuredPython || (process.platform === 'win32' ? 'python.exe' : 'python3'));
    return {gatewayDir, python, host: asr.hostname, port: asr.port || '8010'};
  }
  private async ensureGatewayStarted(options: {elevated?: boolean} = {}) {
    const gateway = this.localGatewayConfig();
    if (!gateway) return;
    if (this.gatewayProcess && this.gatewayProcess.exitCode === null && !this.gatewayProcess.killed) return;
    this.gatewayProcessError = undefined;
    const gatewayArgs = ['-m', 'uvicorn', 'app:app', '--host', gateway.host, '--port', gateway.port];
    const elevationScript = path.join(gateway.gatewayDir, 'start-qwen-gateway.ps1');
    const child = options.elevated && process.platform === 'win32'
      ? existsSync(elevationScript)
        ? spawn('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', elevationScript,
          '-PythonPath', gateway.python,
          '-GatewayDir', gateway.gatewayDir,
          '-BindHost', gateway.host,
          '-Port', gateway.port,
        ], {windowsHide: true, stdio: ['ignore', 'ignore', 'pipe']})
        : (() => {
          throw new TranscriptionProviderError(
            `Qwen elevation helper was not found: ${elevationScript}`,
            'QWEN_GATEWAY_ELEVATION_SCRIPT_MISSING',
            false,
          );
        })()
      : spawn(gateway.python, gatewayArgs, {
        cwd: gateway.gatewayDir,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    this.gatewayProcess = child;
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-8_000); });
    child.once('error', (error) => { this.gatewayProcessError = error; });
    child.once('exit', (code) => {
      if (code !== 0) this.gatewayProcessError = new Error(stderr.trim() || `Qwen gateway exited with code ${code ?? 'unknown'}.`);
      this.gatewayProcess = undefined;
    });
    await startupDelay(100);
    const processErrorText = this.gatewayProcessError ? String(this.gatewayProcessError) : undefined;
    if (processErrorText) {
      throw new TranscriptionProviderError(processErrorText, 'QWEN_GATEWAY_START_FAILED', true, stderr || undefined);
    }
  }
  private async restartGatewayElevated() {
    if (process.platform !== 'win32') return false;
    const managed = this.gatewayProcess;
    if (managed && managed.exitCode === null && !managed.killed) {
      managed.kill();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await startupDelay(250);
        try {
          const status = await this.status();
          if (!status.reachable) break;
        } catch {
          break;
        }
      }
      this.gatewayProcess = undefined;
    }
    await this.ensureGatewayStarted({elevated: true});
    return true;
  }
  private async waitForGateway() {
    const startedAt = Date.now();
    const timeoutMs = Math.min(this.timeoutMs, Number(process.env.QWEN_GATEWAY_START_TIMEOUT_MS ?? 30_000));
    let status = await this.status();
    if (status.reachable) return;
    if (!this.localGatewayConfig()) {
      throw new TranscriptionProviderError(status.error?.message ?? 'Qwen gateway is unreachable.', status.error?.code ?? 'QWEN_ASR_UNREACHABLE', status.error?.retryable ?? true, status.error?.details);
    }
    await this.ensureGatewayStarted();
    while (Date.now() - startedAt < timeoutMs) {
      await startupDelay(500);
      status = await this.status();
      if (status.reachable) return;
      const processErrorText = this.gatewayProcessError ? String(this.gatewayProcessError) : undefined;
      if (processErrorText) throw new TranscriptionProviderError(processErrorText, 'QWEN_GATEWAY_START_FAILED', true);
    }
    throw new TranscriptionProviderError(status.error?.message ?? 'Qwen gateway did not become reachable before the startup timeout.', status.error?.code ?? 'QWEN_GATEWAY_START_TIMEOUT', true, status.error?.details);
  }
  private unavailableStatus(error: TranscriptionProviderError): TranscriptionProviderStatus {
    return {
      id: this.id,
      label: 'Qwen3-ASR-1.7B（中文增强）',
      model: this.model,
      alignmentModel: this.alignmentModel,
      configured: this.configured(),
      reachable: false,
      ready: false,
      supportsWordTimestamps: false,
      supportsSegmentTimestamps: false,
      message: error.message,
      error: {code: error.code, message: error.message, retryable: error.retryable, ...(error.details ? {details: error.details} : {})},
    };
  }

  private async health(baseUrl: string, component: 'asr' | 'aligner') {
    const response = await fetch(new URL('internal/asr/qwen3/health', baseUrl), {headers: this.headers(), signal: AbortSignal.timeout(Math.min(this.timeoutMs, 15_000))});
    const raw = await parseJson(response, {code: component === 'asr' ? 'QWEN_ASR_HEALTH_FAILED' : 'QWEN_ALIGN_HEALTH_FAILED', message: `${component === 'asr' ? 'Qwen ASR' : 'Qwen forced aligner'} health check failed.`, retryable: true});
    if (!raw || typeof raw !== 'object') throw new TranscriptionProviderError('Qwen health endpoint returned an invalid payload.', 'QWEN_HEALTH_INVALID_RESPONSE', false);
    const health = raw as GatewayHealth;
    const candidate = (health[component] ?? health) as GatewayHealthComponent;
    const ready = candidate.ready === true;
    const model = asText(candidate.model);
    const serviceVersion = asText(candidate.serviceVersion);
    if (!model) throw new TranscriptionProviderError('Qwen health endpoint did not include the loaded model name.', 'QWEN_HEALTH_INVALID_RESPONSE', false);
    return {ready, model, serviceVersion};
  }

  async status(): Promise<TranscriptionProviderStatus> {
    if (!this.configured()) return this.unavailableStatus(new TranscriptionProviderError('Qwen ASR gateway is not configured. Set QWEN_ASR_BASE_URL before enabling Qwen.', 'QWEN_ASR_NOT_CONFIGURED', false));
    try {
      const [asr, aligner] = await Promise.all([
        this.health(this.asrBaseUrl!, 'asr'),
        this.health(this.alignBaseUrl!, 'aligner'),
      ]);
      const asrModelMatches = asr.model === this.model;
      const alignerModelMatches = aligner.model === this.alignmentModel;
      const ready = asr.ready && aligner.ready && asrModelMatches && alignerModelMatches;
      const error = !asr.ready ? new TranscriptionProviderError('Qwen ASR model is not ready.', 'QWEN_ASR_NOT_READY', true)
        : !aligner.ready ? new TranscriptionProviderError('Qwen forced aligner model is not ready.', 'QWEN_ALIGN_NOT_READY', true)
          : !asrModelMatches ? new TranscriptionProviderError(`Qwen ASR gateway loaded ${asr.model}, expected ${this.model}.`, 'QWEN_ASR_MODEL_MISMATCH', false)
            : !alignerModelMatches ? new TranscriptionProviderError(`Qwen aligner gateway loaded ${aligner.model}, expected ${this.alignmentModel}.`, 'QWEN_ALIGN_MODEL_MISMATCH', false)
              : undefined;
      return {
        id: this.id,
        label: 'Qwen3-ASR-1.7B（中文增强）',
        model: this.model,
        alignmentModel: this.alignmentModel,
        providerServiceVersion: [asr.serviceVersion && `asr=${asr.serviceVersion}`, aligner.serviceVersion && `aligner=${aligner.serviceVersion}`].filter(Boolean).join(';') || undefined,
        configured: true,
        reachable: true,
        ready,
        supportsWordTimestamps: ready,
        supportsSegmentTimestamps: ready,
        message: ready ? 'Qwen ASR 与强制对齐服务均已就绪。' : error!.message,
        ...(error ? {error: {code: error.code, message: error.message, retryable: error.retryable}} : {}),
      };
    } catch (caught) {
      const error = caught instanceof TranscriptionProviderError
        ? caught
        : new TranscriptionProviderError(caught instanceof Error ? caught.message : 'Qwen ASR gateway is unreachable.', 'QWEN_ASR_UNREACHABLE', true);
      return this.unavailableStatus(error);
    }
  }

  private async control(baseUrl: string, endpoint: 'load' | 'unload' | 'shutdown') {
    const response = await fetch(new URL(`internal/asr/qwen3/${endpoint}`, baseUrl), {
      method: 'POST',
      headers: this.headers(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    return parseJson(response, {
      code: endpoint === 'load' ? 'QWEN_MODEL_LOAD_FAILED' : endpoint === 'shutdown' ? 'QWEN_GATEWAY_SHUTDOWN_FAILED' : 'QWEN_MODEL_UNLOAD_FAILED',
      message: endpoint === 'load' ? 'Qwen models failed to load.' : endpoint === 'shutdown' ? 'Qwen gateway failed to stop.' : 'Qwen models failed to unload.',
      retryable: endpoint !== 'unload',
    });
  }

  async start() {
    if (!this.asrBaseUrl || !this.alignBaseUrl) return this.status();
    await this.waitForGateway();
    try {
      for (const baseUrl of new Set([this.asrBaseUrl, this.alignBaseUrl])) await this.control(baseUrl, 'load');
    } catch (caught) {
      const diagnostic = caught instanceof TranscriptionProviderError
        ? `${caught.message}\n${caught.details ?? ''}`
        : String(caught);
      const canElevate = process.platform === 'win32'
        && caught instanceof TranscriptionProviderError
        && caught.code === 'QWEN_MODEL_LOAD_FAILED'
        && /WinError 5|PermissionError|拒绝访问|torch_python\.dll/i.test(diagnostic);
      if (!canElevate || !this.localGatewayConfig()) throw caught;
      try {
        await this.restartGatewayElevated();
      } catch (elevatedCaught) {
        const elevatedError = elevatedCaught instanceof TranscriptionProviderError
          ? elevatedCaught
          : new TranscriptionProviderError(String(elevatedCaught), 'QWEN_GATEWAY_ELEVATION_FAILED', true);
        const originalError = caught instanceof TranscriptionProviderError ? caught : undefined;
        throw new TranscriptionProviderError(
          `Qwen model loading failed and automatic administrator startup failed: ${elevatedError.message}`,
          'QWEN_GATEWAY_ELEVATION_FAILED',
          elevatedError.retryable,
          [
            originalError ? `Original load error (${originalError.code}): ${originalError.message}` : undefined,
            originalError?.details,
            elevatedError.details,
          ].filter(Boolean).join('\n'),
        );
      }
      await this.waitForGateway();
      for (const baseUrl of new Set([this.asrBaseUrl, this.alignBaseUrl])) await this.control(baseUrl, 'load');
    }
    return this.status();
  }

  async stop(): Promise<TranscriptionProviderStopResult> {
    if (!this.asrBaseUrl || !this.alignBaseUrl) {
      return {providerId: this.id, stopped: true, gpuMemoryReleased: true, message: 'Qwen gateway is not configured and holds no managed GPU model.'};
    }
    let allocatedBytes = 0;
    let reservedBytes = 0;
    for (const baseUrl of new Set([this.asrBaseUrl, this.alignBaseUrl])) {
      const raw = await this.control(baseUrl, 'unload') as QwenUnloadResponse;
      if (raw.ready !== false || raw.gpuMemoryReleased !== true) {
        throw new TranscriptionProviderError(
          'Qwen gateway did not confirm that GPU model memory was released.',
          'QWEN_GPU_MEMORY_RELEASE_FAILED',
          false,
          JSON.stringify(raw),
        );
      }
      allocatedBytes += typeof raw.gpuMemory?.allocatedBytes === 'number' ? raw.gpuMemory.allocatedBytes : 0;
      reservedBytes += typeof raw.gpuMemory?.reservedBytes === 'number' ? raw.gpuMemory.reservedBytes : 0;
    }
    return {
      providerId: this.id,
      stopped: true,
      gpuMemoryReleased: allocatedBytes === 0 && reservedBytes === 0,
      message: `Qwen models unloaded; allocated=${allocatedBytes} bytes, reserved=${reservedBytes} bytes.`,
    };
  }

  async shutdownService(): Promise<TranscriptionProviderStopResult> {
    if (!this.asrBaseUrl || !this.alignBaseUrl) {
      return {providerId: this.id, stopped: true, gpuMemoryReleased: true, message: 'Qwen gateway is not configured and holds no managed GPU model.'};
    }
    const before = await this.status();
    if (!before.reachable) {
      return {providerId: this.id, stopped: true, gpuMemoryReleased: true, message: 'Qwen gateway is already stopped.'};
    }
    // A remote/shared gateway must not be terminated by this local app. It is
    // still asked to unload the model selected by this application.
    if (!this.localGatewayConfig()) return this.stop();
    for (const baseUrl of new Set([this.asrBaseUrl, this.alignBaseUrl])) {
      const accepted = await this.control(baseUrl, 'shutdown') as {accepted?: unknown};
      if (accepted.accepted !== true) {
        throw new TranscriptionProviderError('Qwen gateway did not accept the shutdown request.', 'QWEN_GATEWAY_SHUTDOWN_NOT_ACCEPTED', false, JSON.stringify(accepted));
      }
    }
    for (let attempt = 0; attempt < 80; attempt += 1) {
      await startupDelay(250);
      if (!(await this.status()).reachable) {
        this.gatewayProcess = undefined;
        return {providerId: this.id, stopped: true, gpuMemoryReleased: true, message: 'Qwen models unloaded and the local gateway stopped.'};
      }
    }
    throw new TranscriptionProviderError('Qwen gateway remained reachable after the shutdown deadline.', 'QWEN_GATEWAY_SHUTDOWN_TIMEOUT', true);
  }

  createSnapshot(status?: TranscriptionProviderStatus): TranscriptionRunSnapshot {
    return {
      providerId: this.id,
      model: this.model,
      alignmentModel: this.alignmentModel,
      language: 'zh',
      vocabularyProfile: this.vocabularyProfile,
      audioProfile: 'mono-16khz-pcm-s16le-v1',
      chunkingProfile: 'vad-overlap-30s-v1',
      ...(status?.providerServiceVersion ? {providerServiceVersion: status.providerServiceVersion} : {}),
    };
  }

  private assertSnapshot(snapshot: TranscriptionRunSnapshot | undefined) {
    if (!snapshot || snapshot.providerId !== this.id) throw new TranscriptionProviderError('Qwen transcription requires a Qwen generation snapshot.', 'QWEN_SNAPSHOT_REQUIRED', false);
    if (snapshot.model !== this.model || snapshot.alignmentModel !== this.alignmentModel) {
      throw new TranscriptionProviderError('The Qwen service configuration does not match this generation snapshot.', 'QWEN_SNAPSHOT_UNAVAILABLE', false);
    }
  }

  private async requestMultipart(baseUrl: string, endpoint: string, form: FormData, input: TranscriptionInput, fallback: {code: string; message: string}) {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        if (input.signal?.aborted) throw new Error('cancelled');
        const response = await fetch(new URL(endpoint, baseUrl), {method: 'POST', headers: this.headers(), body: form, signal: withTimeout(input.signal, this.timeoutMs)});
        return await parseJson(response, {code: fallback.code, message: fallback.message, retryable: true});
      } catch (error) {
        if (input.signal?.aborted || (error instanceof Error && error.message === 'cancelled')) throw new Error('cancelled');
        lastError = error;
        const retryable = error instanceof TranscriptionProviderError ? error.retryable : true;
        if (!retryable || attempt >= this.maxRetries) break;
        await retryDelay(attempt);
      }
    }
    if (lastError instanceof TranscriptionProviderError) throw lastError;
    throw new TranscriptionProviderError(lastError instanceof Error ? lastError.message : fallback.message, fallback.code, true);
  }

  async transcribe(input: TranscriptionInput) { return (await this.transcribeWithRaw(input)).transcript; }

  async transcribeWithRaw(input: TranscriptionInput): Promise<TranscriptionResult> {
    this.assertSnapshot(input.snapshot);
    if (!this.asrBaseUrl || !this.alignBaseUrl) throw new TranscriptionProviderError('Qwen ASR gateway is not configured.', 'QWEN_ASR_NOT_CONFIGURED', false);
    const audio = await readFile(input.filePath);
    const requestId = `asset:${input.assetId}`;
    const asrForm = new FormData();
    asrForm.set('audio', new Blob([audio], {type: 'audio/wav'}), path.basename(input.filePath));
    asrForm.set('language', input.snapshot!.language);
    asrForm.set('model', input.snapshot!.model);
    asrForm.set('vocabularyProfile', input.snapshot!.vocabularyProfile);
    asrForm.set('chunkingProfile', input.snapshot!.chunkingProfile ?? 'vad-overlap-30s-v1');
    asrForm.set('requestId', requestId);
    const transcribed = await this.requestMultipart(this.asrBaseUrl, 'internal/asr/qwen3/transcribe', asrForm, input, {code: 'QWEN_ASR_TRANSCRIBE_FAILED', message: 'Qwen ASR transcription failed.'});
    const transcript = asText((transcribed as QwenTranscribeResponse)?.text);
    const alignForm = new FormData();
    alignForm.set('audio', new Blob([audio], {type: 'audio/wav'}), path.basename(input.filePath));
    alignForm.set('transcript', transcript);
    alignForm.set('language', input.snapshot!.language);
    alignForm.set('model', input.snapshot!.alignmentModel!);
    alignForm.set('requestId', requestId);
    const aligned = await this.requestMultipart(this.alignBaseUrl, 'internal/asr/qwen3/align', alignForm, input, {code: 'QWEN_ALIGN_FAILED', message: 'Qwen forced alignment failed.'});
    return {
      transcript: normalizeQwenAlignedResponse(transcribed, aligned, {
        assetId: input.assetId,
        durationMs: input.durationMs,
        model: input.snapshot!.model,
        alignmentModel: input.snapshot!.alignmentModel!,
        language: input.snapshot!.language,
      }),
      raw: {transcribe: transcribed, align: aligned},
    };
  }
}

export const createQwen3AsrTranscriptionProvider = () => new Qwen3AsrTranscriptionProvider({
  baseUrl: process.env.QWEN_ASR_BASE_URL,
  alignBaseUrl: process.env.QWEN_ALIGN_BASE_URL,
  apiKey: process.env.QWEN_ASR_API_KEY,
  model: process.env.QWEN_ASR_MODEL ?? 'Qwen/Qwen3-ASR-1.7B',
  alignmentModel: process.env.QWEN_ALIGN_MODEL ?? 'Qwen/Qwen3-ForcedAligner-0.6B',
  vocabularyProfile: process.env.QWEN_ASR_VOCABULARY_PROFILE,
  timeoutMs: Number(process.env.QWEN_ASR_TIMEOUT_MS ?? 600_000),
  maxRetries: Number(process.env.QWEN_ASR_MAX_RETRIES ?? 2),
});
