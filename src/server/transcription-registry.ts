import {
  transcriptionProviderStatusResponseSchema,
  transcriptionRunSnapshotSchema,
  type TranscriptionProviderId,
  type TranscriptionProviderStatus,
  type TranscriptionProviderStatusResponse,
  type TranscriptionRunSnapshot,
} from '../shared/auto-video-contracts.js';
import {createQwen3AsrTranscriptionProvider} from './qwen3-asr.js';
import {createTranscriptionProvider} from './speaches.js';
import {TranscriptionProviderError, type TranscriptionProvider} from './transcription-provider.js';

export class TranscriptionProviderRegistry {
  private readonly providers: ReadonlyMap<TranscriptionProviderId, TranscriptionProvider>;
  private activeProviderId: TranscriptionProviderId | undefined;
  private switching = false;
  private transitionTail: Promise<void> = Promise.resolve();

  constructor(providers: TranscriptionProvider[] = [createTranscriptionProvider(), createQwen3AsrTranscriptionProvider()]) {
    const entries = providers.map((provider) => [provider.id, provider] as const);
    if (new Set(entries.map(([id]) => id)).size !== entries.length) throw new Error('duplicate_transcription_provider_id');
    this.providers = new Map(entries);
  }

  provider(id: TranscriptionProviderId) {
    const provider = this.providers.get(id);
    if (!provider) throw new TranscriptionProviderError(`Transcription provider ${id} is not configured in this application.`, 'TRANSCRIPTION_PROVIDER_UNKNOWN', false);
    return provider;
  }

  whisper() { return this.provider('speaches-whisper'); }

  async listStatuses(): Promise<TranscriptionProviderStatus[]> {
    return Promise.all([...this.providers.values()].map((provider) => provider.status()));
  }

  async statusResponse(): Promise<TranscriptionProviderStatusResponse> {
    return transcriptionProviderStatusResponseSchema.parse({
      providers: await this.listStatuses(),
      activeProviderId: this.activeProviderId,
      switching: this.switching,
    });
  }

  activate(providerId: TranscriptionProviderId): Promise<TranscriptionProviderStatusResponse> {
    const run = this.transitionTail.then(
      () => this.activateExclusive(providerId),
      () => this.activateExclusive(providerId),
    );
    this.transitionTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async activateExclusive(providerId: TranscriptionProviderId): Promise<TranscriptionProviderStatusResponse> {
    this.switching = true;
    try {
      if (this.activeProviderId === providerId) return this.statusResponse();
      const target = this.provider(providerId);
      for (const provider of this.providers.values()) {
        if (provider.id === providerId) continue;
        const status = await provider.status();
        if (!status.ready && this.activeProviderId !== provider.id) continue;
        const stopped = await provider.stop();
        if (!stopped.stopped || !stopped.gpuMemoryReleased) {
          throw new TranscriptionProviderError(stopped.message, 'TRANSCRIPTION_GPU_MEMORY_RELEASE_FAILED', false);
        }
      }
      this.activeProviderId = undefined;
      const status = await target.start();
      if (!status.ready) {
        throw new TranscriptionProviderError(
          status.error?.message ?? status.message,
          status.error?.code ?? 'TRANSCRIPTION_PROVIDER_NOT_READY',
          status.error?.retryable ?? true,
          status.error?.details,
        );
      }
      this.activeProviderId = providerId;
      return this.statusResponse();
    } finally {
      this.switching = false;
    }
  }

  requireActive(providerId: TranscriptionProviderId) {
    if (this.activeProviderId !== providerId) {
      throw new TranscriptionProviderError(
        `Transcription provider ${providerId} is not active. Activate it before creating a generation.`,
        'TRANSCRIPTION_PROVIDER_NOT_ACTIVE',
        false,
      );
    }
  }

  async createSnapshot(selection: {providerId: TranscriptionProviderId} = {providerId: 'speaches-whisper'}): Promise<TranscriptionRunSnapshot> {
    const provider = this.provider(selection.providerId);
    const status = await provider.status();
    if (selection.providerId === 'qwen3-asr' && !status.ready) {
      const error = status.error;
      throw new TranscriptionProviderError(
        error?.message ?? status.message,
        error?.code ?? 'QWEN_NOT_READY',
        error?.retryable ?? true,
        error?.details,
      );
    }
    const snapshot = provider.createSnapshot?.(status) ?? {
      providerId: provider.id,
      model: status.model,
      language: 'zh' as const,
      vocabularyProfile: 'car-wash-zh-v1' as const,
      audioProfile: 'mono-16khz-pcm-s16le-v1' as const,
      ...(status.providerServiceVersion ? {providerServiceVersion: status.providerServiceVersion} : {}),
    };
    return transcriptionRunSnapshotSchema.parse(snapshot);
  }

  legacyWhisperSnapshot(): TranscriptionRunSnapshot {
    const provider = this.whisper();
    const model = process.env.SPEACHES_MODEL ?? (provider as {config?: {model?: string}}).config?.model ?? 'Systran/faster-whisper-large-v3';
    return transcriptionRunSnapshotSchema.parse({
      providerId: 'speaches-whisper',
      model,
      language: 'zh',
      vocabularyProfile: 'car-wash-zh-v1',
      audioProfile: 'mono-16khz-pcm-s16le-v1',
    });
  }

  resolve(snapshot: TranscriptionRunSnapshot) {
    return this.provider(snapshot.providerId);
  }
}

export const createTranscriptionProviderRegistry = () => new TranscriptionProviderRegistry();
