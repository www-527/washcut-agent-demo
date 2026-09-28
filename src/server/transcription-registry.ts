import {
  transcriptionProviderStatusResponseSchema,
  transcriptionRunSnapshotSchema,
  type TranscriptionProviderId,
  type TranscriptionProviderStatus,
  type TranscriptionProviderStatusResponse,
  type TranscriptionRunSnapshot,
} from '../shared/auto-video-contracts.js';
import {createQwen3AsrTranscriptionProvider} from './qwen3-asr.js';
import {TranscriptionProviderError, type TranscriptionProvider} from './transcription-provider.js';

export class TranscriptionProviderRegistry {
  private readonly transcriptionProvider: TranscriptionProvider;
  private activeProviderId: TranscriptionProviderId | undefined;
  private switching = false;
  private transitionTail: Promise<void> = Promise.resolve();

  constructor(provider: TranscriptionProvider = createQwen3AsrTranscriptionProvider()) {
    if (provider.id !== 'qwen3-asr') throw new Error('unsupported_transcription_provider');
    this.transcriptionProvider = provider;
  }

  provider(id: TranscriptionProviderId) {
    if (id !== this.transcriptionProvider.id) {
      throw new TranscriptionProviderError(
        `Transcription provider ${id} is not configured in this application.`,
        'TRANSCRIPTION_PROVIDER_UNKNOWN',
        false,
      );
    }
    return this.transcriptionProvider;
  }

  async listStatuses(): Promise<TranscriptionProviderStatus[]> {
    return [await this.transcriptionProvider.status()];
  }

  async statusResponse(): Promise<TranscriptionProviderStatusResponse> {
    return transcriptionProviderStatusResponseSchema.parse({
      providers: await this.listStatuses(),
      activeProviderId: this.activeProviderId,
      switching: this.switching,
    });
  }

  activate(providerId: TranscriptionProviderId): Promise<TranscriptionProviderStatusResponse> {
    return this.queueTransition(() => this.activateExclusive(providerId));
  }

  deactivate(providerId: TranscriptionProviderId): Promise<TranscriptionProviderStatusResponse> {
    return this.queueTransition(() => this.deactivateExclusive(providerId));
  }

  shutdownServices() {
    return this.queueTransition(() => this.shutdownServicesExclusive());
  }

  private queueTransition<Result>(transition: () => Promise<Result>) {
    const run = this.transitionTail.then(transition, transition);
    this.transitionTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async shutdownServicesExclusive() {
    this.switching = true;
    try {
      const result = this.transcriptionProvider.shutdownService
        ? await this.transcriptionProvider.shutdownService()
        : await this.transcriptionProvider.stop();
      this.assertMemoryReleased(result);
      this.activeProviderId = undefined;
      return result;
    } finally {
      this.switching = false;
    }
  }

  private async activateExclusive(providerId: TranscriptionProviderId): Promise<TranscriptionProviderStatusResponse> {
    this.switching = true;
    try {
      if (this.activeProviderId === providerId) return this.statusResponse();
      const status = await this.provider(providerId).start();
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

  private async deactivateExclusive(providerId: TranscriptionProviderId): Promise<TranscriptionProviderStatusResponse> {
    this.switching = true;
    try {
      if (this.activeProviderId !== providerId) return this.statusResponse();
      const stopped = await this.provider(providerId).stop();
      this.assertMemoryReleased(stopped);
      this.activeProviderId = undefined;
      return this.statusResponse();
    } finally {
      this.switching = false;
    }
  }

  private assertMemoryReleased(result: {stopped: boolean; gpuMemoryReleased: boolean; message: string}) {
    if (!result.stopped || !result.gpuMemoryReleased) {
      throw new TranscriptionProviderError(result.message, 'TRANSCRIPTION_GPU_MEMORY_RELEASE_FAILED', false);
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

  async createSnapshot(selection: {providerId: TranscriptionProviderId} = {providerId: 'qwen3-asr'}): Promise<TranscriptionRunSnapshot> {
    const provider = this.provider(selection.providerId);
    const status = await provider.status();
    if (!status.ready) {
      const error = status.error;
      throw new TranscriptionProviderError(
        error?.message ?? status.message,
        error?.code ?? 'QWEN_NOT_READY',
        error?.retryable ?? true,
        error?.details,
      );
    }
    return transcriptionRunSnapshotSchema.parse(provider.createSnapshot?.(status) ?? {
      providerId: provider.id,
      model: status.model,
      language: 'zh',
      vocabularyProfile: 'car-wash-ad-zh-v2',
      audioProfile: 'mono-16khz-pcm-s16le-v1',
      ...(status.providerServiceVersion ? {providerServiceVersion: status.providerServiceVersion} : {}),
    });
  }

  resolve(snapshot: TranscriptionRunSnapshot) {
    return this.provider(snapshot.providerId);
  }

  ensureReadyForSnapshot(snapshot: TranscriptionRunSnapshot): Promise<boolean> {
    return this.queueTransition(() => this.ensureReadyForSnapshotExclusive(snapshot));
  }

  private async ensureReadyForSnapshotExclusive(snapshot: TranscriptionRunSnapshot) {
    const provider = this.resolve(snapshot);
    const current = await provider.status();
    if (current.ready) {
      this.activeProviderId = snapshot.providerId;
      return true;
    }
    const recovered = await provider.start();
    if (!recovered.ready) return false;
    this.activeProviderId = snapshot.providerId;
    return true;
  }
}

export const createTranscriptionProviderRegistry = () => new TranscriptionProviderRegistry();
