import type {
  NormalizedTranscript,
  TranscriptionProviderId,
  TranscriptionProviderStatus,
  TranscriptionRunSnapshot,
} from '../shared/auto-video-contracts.js';

export type TranscriptionInput = {
  assetId: string;
  filePath: string;
  durationMs: number;
  language?: string;
  snapshot?: TranscriptionRunSnapshot;
  signal?: AbortSignal;
};

export type TranscriptionResult = {transcript: NormalizedTranscript; raw: unknown};

export type TranscriptionProviderStopResult = {
  providerId: TranscriptionProviderId;
  stopped: boolean;
  gpuMemoryReleased: boolean;
  message: string;
};

export interface TranscriptionProvider {
  readonly id: TranscriptionProviderId;
  status(): Promise<TranscriptionProviderStatus>;
  start(): Promise<TranscriptionProviderStatus>;
  stop(): Promise<TranscriptionProviderStopResult>;
  createSnapshot?(status?: TranscriptionProviderStatus): TranscriptionRunSnapshot;
  transcribe(input: TranscriptionInput): Promise<NormalizedTranscript>;
  transcribeWithRaw?(input: TranscriptionInput): Promise<TranscriptionResult>;
}

/**
 * Keeps an upstream transcription failure inspectable by the worker and HTTP API.
 * Its code, message and retryable flag must never be replaced by a product bucket.
 */
export class TranscriptionProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly details?: string,
  ) {
    super(message);
    this.name = 'TranscriptionProviderError';
  }
}

export const isTranscriptionProviderError = (error: unknown): error is TranscriptionProviderError =>
  error instanceof TranscriptionProviderError
  || (error instanceof Error && typeof (error as Error & {code?: unknown}).code === 'string'
    && typeof (error as Error & {retryable?: unknown}).retryable === 'boolean');

export const toProviderError = (error: unknown, fallback: {code: string; message: string; retryable: boolean}) => {
  if (isTranscriptionProviderError(error)) {
    const source = error as Error & {code: string; retryable: boolean; details?: unknown};
    return new TranscriptionProviderError(
      source.message,
      source.code,
      source.retryable,
      typeof source.details === 'string' ? source.details : undefined,
    );
  }
  return new TranscriptionProviderError(
    error instanceof Error && error.message ? error.message : fallback.message,
    fallback.code,
    fallback.retryable,
  );
};

