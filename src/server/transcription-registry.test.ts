import assert from 'node:assert/strict';
import test from 'node:test';
import {
  transcriptionProviderActivationSchema,
  type NormalizedTranscript,
  type TranscriptionProviderStatus,
} from '../shared/auto-video-contracts.js';
import {TranscriptionProviderRegistry} from './transcription-registry.js';
import {TranscriptionProviderError, type TranscriptionInput, type TranscriptionProvider} from './transcription-provider.js';

class FakeQwenProvider implements TranscriptionProvider {
  readonly id = 'qwen3-asr' as const;

  constructor(
    public ready: boolean,
    private readonly events: string[],
    private readonly releasesMemory = true,
  ) {}

  async status(): Promise<TranscriptionProviderStatus> {
    return {
      id: this.id,
      label: 'Qwen3-ASR-1.7B',
      configured: true,
      reachable: true,
      ready: this.ready,
      model: 'qwen3-asr-model',
      supportsWordTimestamps: this.ready,
      supportsSegmentTimestamps: this.ready,
      message: this.ready ? 'ready' : 'stopped',
    };
  }

  async start() {
    this.events.push('start:qwen3-asr');
    this.ready = true;
    return this.status();
  }

  async stop() {
    this.events.push('stop:qwen3-asr');
    if (this.releasesMemory) this.ready = false;
    return {
      providerId: this.id,
      stopped: this.releasesMemory,
      gpuMemoryReleased: this.releasesMemory,
      message: this.releasesMemory ? 'released' : 'still allocated',
    };
  }

  async shutdownService() {
    this.events.push('shutdown:qwen3-asr');
    if (this.releasesMemory) this.ready = false;
    return {
      providerId: this.id,
      stopped: this.releasesMemory,
      gpuMemoryReleased: this.releasesMemory,
      message: this.releasesMemory ? 'service stopped' : 'still allocated',
    };
  }

  async transcribe(_input: TranscriptionInput): Promise<NormalizedTranscript> {
    throw new Error('not used');
  }
}

test('public model contract accepts Qwen only', async () => {
  const registry = new TranscriptionProviderRegistry(new FakeQwenProvider(false, []));

  const response = await registry.statusResponse();
  assert.deepEqual(response.providers.map((provider) => provider.id), ['qwen3-asr']);
  assert.equal(transcriptionProviderActivationSchema.safeParse({providerId: 'qwen3-asr'}).success, true);
  assert.equal(transcriptionProviderActivationSchema.safeParse({providerId: 'legacy-provider'}).success, false);
});

test('registry starts and deactivates Qwen', async () => {
  const events: string[] = [];
  const qwen = new FakeQwenProvider(false, events);
  const registry = new TranscriptionProviderRegistry(qwen);

  assert.equal((await registry.activate('qwen3-asr')).activeProviderId, 'qwen3-asr');
  assert.equal((await registry.deactivate('qwen3-asr')).activeProviderId, undefined);
  assert.deepEqual(events, ['start:qwen3-asr', 'stop:qwen3-asr']);
  assert.equal(qwen.ready, false);
});

test('registry refuses to close Qwen when GPU release is not confirmed', async () => {
  const events: string[] = [];
  const registry = new TranscriptionProviderRegistry(new FakeQwenProvider(true, events, false));
  await registry.ensureReadyForSnapshot({
    providerId: 'qwen3-asr', model: 'qwen3-asr-model', alignmentModel: 'qwen-align-model', language: 'zh',
    vocabularyProfile: 'car-wash-zh-v1', audioProfile: 'mono-16khz-pcm-s16le-v1', chunkingProfile: 'vad-overlap-30s-v1',
  });

  await assert.rejects(
    registry.deactivate('qwen3-asr'),
    (error: unknown) => error instanceof TranscriptionProviderError && error.code === 'TRANSCRIPTION_GPU_MEMORY_RELEASE_FAILED',
  );
  assert.deepEqual(events, ['stop:qwen3-asr']);
});

test('registry shutdown stops the owned Qwen service and clears the active selection', async () => {
  const events: string[] = [];
  const registry = new TranscriptionProviderRegistry(new FakeQwenProvider(false, events));

  await registry.activate('qwen3-asr');
  const result = await registry.shutdownServices();

  assert.equal(result.providerId, 'qwen3-asr');
  assert.equal(result.stopped, true);
  assert.equal(result.gpuMemoryReleased, true);
  assert.deepEqual(events, ['start:qwen3-asr', 'shutdown:qwen3-asr']);
  assert.equal((await registry.statusResponse()).activeProviderId, undefined);
});

test('registry restarts Qwen when a running generation loses ASR', async () => {
  const events: string[] = [];
  const qwen = new FakeQwenProvider(false, events);
  const registry = new TranscriptionProviderRegistry(qwen);
  const snapshot = {
    providerId: 'qwen3-asr' as const, model: 'qwen3-asr-model', alignmentModel: 'qwen-align-model', language: 'zh' as const,
    vocabularyProfile: 'car-wash-zh-v1' as const, audioProfile: 'mono-16khz-pcm-s16le-v1' as const, chunkingProfile: 'vad-overlap-30s-v1' as const,
  };

  assert.equal(await registry.ensureReadyForSnapshot(snapshot), true);
  qwen.ready = false;
  assert.equal(await registry.ensureReadyForSnapshot(snapshot), true);
  assert.deepEqual(events, ['start:qwen3-asr', 'start:qwen3-asr']);
});
