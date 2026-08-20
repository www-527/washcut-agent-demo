import assert from 'node:assert/strict';
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {normalizeQwenAlignedResponse, Qwen3AsrTranscriptionProvider} from './qwen3-asr.js';
import {TranscriptionProviderError} from './transcription-provider.js';

const snapshot = {
  providerId: 'qwen3-asr' as const,
  model: 'Qwen/Qwen3-ASR-1.7B',
  alignmentModel: 'Qwen/Qwen3-ForcedAligner-0.6B',
  language: 'zh' as const,
  vocabularyProfile: 'car-wash-zh-v1' as const,
  audioProfile: 'mono-16khz-pcm-s16le-v1' as const,
  chunkingProfile: 'vad-overlap-30s-v1' as const,
};

const listen = async (handler: (request: IncomingMessage, response: ServerResponse) => void) => {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test_server_address_missing');
  return {server, baseUrl: `http://127.0.0.1:${address.port}/`};
};

const close = (server: ReturnType<typeof createServer>) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

test('Qwen provider is explicitly unavailable without its private gateway configuration', async () => {
  const provider = new Qwen3AsrTranscriptionProvider({});
  const status = await provider.status();
  assert.equal(status.ready, false);
  assert.equal(status.error?.code, 'QWEN_ASR_NOT_CONFIGURED');
  assert.equal(status.supportsWordTimestamps, false);
});

test('Qwen aligned transcript requires real word and segment timestamps', () => {
  const transcript = normalizeQwenAlignedResponse(
    {text: '到店洗车立减二十元', language: 'zh'},
    {
      words: [{word: '到店', startMs: 0, endMs: 320, confidence: 0.98}, {word: '洗车', startMs: 320, endMs: 650, confidence: 0.96}],
      segments: [{text: '到店洗车立减二十元', startMs: 0, endMs: 1_100, confidence: 0.97}],
    },
    {assetId: 'asset_qwen', durationMs: 2_000, model: snapshot.model, alignmentModel: snapshot.alignmentModel},
  );
  assert.equal(transcript.provider, 'qwen3-asr');
  assert.equal(transcript.words.length, 2);
  assert.equal(transcript.segments[0]?.endMs, 1_100);
  assert.throws(() => normalizeQwenAlignedResponse(
    {text: '有文本'}, {words: [], segments: []},
    {assetId: 'asset_qwen', durationMs: 2_000, model: snapshot.model, alignmentModel: snapshot.alignmentModel},
  ), (error: unknown) => error instanceof TranscriptionProviderError && error.code === 'QWEN_ALIGN_TIMESTAMPS_MISSING');
});

test('Qwen provider calls ASR then aligner and preserves alignment upstream errors', async () => {
  let failAlignment = false;
  let loaded = false;
  const {server, baseUrl} = await listen((request, response) => {
    const url = new URL(request.url ?? '/', baseUrl);
    if (url.pathname === '/internal/asr/qwen3/health') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({asr: {ready: loaded, model: snapshot.model, serviceVersion: 'asr-test'}, aligner: {ready: loaded, model: snapshot.alignmentModel, serviceVersion: 'align-test'}}));
      return;
    }
    if (url.pathname === '/internal/asr/qwen3/load') {
      loaded = true;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ready: true}));
      return;
    }
    if (url.pathname === '/internal/asr/qwen3/unload') {
      loaded = false;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ready: false, gpuMemoryReleased: true, gpuMemory: {allocatedBytes: 0, reservedBytes: 0}}));
      return;
    }
    if (url.pathname === '/internal/asr/qwen3/transcribe') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({text: '精洗套餐今天优惠', language: 'zh', serviceVersion: 'asr-test'}));
      return;
    }
    if (url.pathname === '/internal/asr/qwen3/align') {
      response.setHeader('content-type', 'application/json');
      if (failAlignment) {
        response.statusCode = 503;
        response.end(JSON.stringify({error: {code: 'ALIGNER_BUSY', message: 'aligner queue is full', retryable: true}}));
      } else {
        response.end(JSON.stringify({words: [{word: '精洗', startMs: 0, endMs: 240}, {word: '套餐', startMs: 240, endMs: 520}], segments: [{text: '精洗套餐今天优惠', startMs: 0, endMs: 1_000}], alignmentModel: snapshot.alignmentModel, serviceVersion: 'align-test'}));
      }
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  const directory = await mkdtemp(path.join(tmpdir(), 'washcut-qwen-test-'));
  const audioPath = path.join(directory, 'audio.wav');
  try {
    await writeFile(audioPath, Buffer.from('RIFF----WAVEfmt '));
    const provider = new Qwen3AsrTranscriptionProvider({baseUrl, timeoutMs: 5_000, maxRetries: 0});
    assert.equal((await provider.status()).ready, false);
    const status = await provider.start();
    assert.equal(status.ready, true);
    assert.equal(status.providerServiceVersion, 'asr=asr-test;aligner=align-test');
    const result = await provider.transcribeWithRaw({assetId: 'asset_qwen', filePath: audioPath, durationMs: 2_000, snapshot});
    assert.equal(result.transcript.text, '精洗套餐今天优惠');
    assert.deepEqual(Object.keys(result.raw as object), ['transcribe', 'align']);
    failAlignment = true;
    await assert.rejects(
      provider.transcribeWithRaw({assetId: 'asset_qwen', filePath: audioPath, durationMs: 2_000, snapshot}),
      (error: unknown) => error instanceof TranscriptionProviderError && error.code === 'ALIGNER_BUSY' && error.message === 'aligner queue is full' && error.retryable === true,
    );
    const stopped = await provider.stop();
    assert.equal(stopped.gpuMemoryReleased, true);
    assert.equal((await provider.status()).ready, false);
  } finally {
    await close(server);
    await rm(directory, {recursive: true, force: true});
  }
});
