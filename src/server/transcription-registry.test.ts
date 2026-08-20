import assert from 'node:assert/strict';
import test from 'node:test';
import type {NormalizedTranscript, TranscriptionProviderId, TranscriptionProviderStatus} from '../shared/auto-video-contracts.js';
import {TranscriptionProviderRegistry} from './transcription-registry.js';
import {TranscriptionProviderError, type TranscriptionInput, type TranscriptionProvider} from './transcription-provider.js';

class FakeProvider implements TranscriptionProvider {
  ready: boolean;

  constructor(
    readonly id: TranscriptionProviderId,
    ready: boolean,
    private readonly events: string[],
    private readonly releasesMemory = true,
  ) {
    this.ready = ready;
  }

  async status(): Promise<TranscriptionProviderStatus> {
    return {
      id: this.id,
      label: this.id,
      configured: true,
      reachable: true,
      ready: this.ready,
      model: `${this.id}-model`,
      supportsWordTimestamps: this.ready,
      supportsSegmentTimestamps: this.ready,
      message: this.ready ? 'ready' : 'stopped',
    };
  }

  async start() {
    this.events.push(`start:${this.id}`);
    this.ready = true;
    return this.status();
  }

  async stop() {
    this.events.push(`stop:${this.id}`);
    if (this.releasesMemory) this.ready = false;
    return {providerId: this.id, stopped: this.releasesMemory, gpuMemoryReleased: this.releasesMemory, message: this.releasesMemory ? 'released' : 'still allocated'};
  }

  async transcribe(_input: TranscriptionInput): Promise<NormalizedTranscript> {
    throw new Error('not used');
  }
}

test('registry stops and verifies the previous model before starting the selected model', async () => {
  const events: string[] = [];
  const whisper = new FakeProvider('speaches-whisper', true, events);
  const qwen = new FakeProvider('qwen3-asr', false, events);
  const registry = new TranscriptionProviderRegistry([whisper, qwen]);

  const qwenResult = await registry.activate('qwen3-asr');
  assert.equal(qwenResult.activeProviderId, 'qwen3-asr');
  assert.deepEqual(events, ['stop:speaches-whisper', 'start:qwen3-asr']);

  const whisperResult = await registry.activate('speaches-whisper');
  assert.equal(whisperResult.activeProviderId, 'speaches-whisper');
  assert.deepEqual(events, ['stop:speaches-whisper', 'start:qwen3-asr', 'stop:qwen3-asr', 'start:speaches-whisper']);
});

test('registry refuses to start another model when GPU release is not confirmed', async () => {
  const events: string[] = [];
  const whisper = new FakeProvider('speaches-whisper', true, events, false);
  const qwen = new FakeProvider('qwen3-asr', false, events);
  const registry = new TranscriptionProviderRegistry([whisper, qwen]);

  await assert.rejects(
    registry.activate('qwen3-asr'),
    (error: unknown) => error instanceof TranscriptionProviderError && error.code === 'TRANSCRIPTION_GPU_MEMORY_RELEASE_FAILED',
  );
  assert.deepEqual(events, ['stop:speaches-whisper']);
  assert.equal(qwen.ready, false);
});
