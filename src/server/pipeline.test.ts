import assert from 'node:assert/strict';
import {statSync} from 'node:fs';
import {createServer} from 'node:http';
import path from 'node:path';
import test from 'node:test';
import type {AssetRef, ProjectInput} from '../shared/contracts.js';
import type {ModelConversationRecord} from '../shared/model-conversations.js';
import {prepareProtocolTestMedia} from './media.js';
import {analyzeAssets, buildAssetManifest, buildCreativeSpec, buildQualityReport, buildVideoSpec, validateVideoSpec} from './pipeline.js';
import {RelayClient, RelayError, isRetryableRelayFailureMessage, normalizeModelsUrl, normalizeResponsesUrl, parseModelJson, parseModelList, parseSseText} from './relay-client.js';

const assets: AssetRef[] = [
  {assetId: 'a1', fileName: '门店.jpg', sha256: '11111111', contentType: 'image/jpeg', sizeBytes: 100, width: 1080, height: 1920, sourceType: 'user_upload', status: 'ready', keyframeUrls: ['http://example.test/a1.jpg']},
  {assetId: 'a2', fileName: '高压冲洗.mp4', sha256: '22222222', contentType: 'video/mp4', sizeBytes: 200, durationMs: 12_000, width: 1080, height: 1920, fps: 30, hasAudio: true, sourceType: 'user_upload', status: 'ready', keyframeUrls: ['http://example.test/a2.jpg']},
  {assetId: 'a3', fileName: '泡沫.jpg', sha256: '33333333', contentType: 'image/jpeg', sizeBytes: 100, width: 1080, height: 1920, sourceType: 'user_upload', status: 'ready', keyframeUrls: ['http://example.test/a3.jpg']},
  {assetId: 'a4', fileName: '洗后效果.jpg', sha256: '44444444', contentType: 'image/jpeg', sizeBytes: 100, width: 1080, height: 1920, sourceType: 'user_upload', status: 'ready', keyframeUrls: ['http://example.test/a4.jpg']},
];

const input: ProjectInput = {
  projectId: 'project_test', storeName: '蓝鲸精洗', region: '上海浦东', offer: '49元6次洗车卡',
  rules: '到店核销，每车限购1张', cta: '现在下单，到店即洗', durationMs: 30_000,
  tone: 'direct', allowLibrary: false, assetIds: assets.map((asset) => asset.assetId),
};

test('deterministic pipeline preserves facts, references and exact transition timeline', () => {
  const manifest = buildAssetManifest(input, assets);
  const creative = buildCreativeSpec(input);
  const video = validateVideoSpec(buildVideoSpec(input, manifest, creative), manifest, creative);
  const quality = buildQualityReport(input, manifest, video, {durationDeltaMs: 0, width: 1080, height: 1920, hasAudio: true, blackDurationMs: 0});
  assert.equal(video.durationMs, 30_000);
  assert.equal(Math.max(...video.scenes.map((scene) => scene.timelineStartMs + scene.durationMs)), 30_000);
  assert.ok(video.scenes.every((scene) => input.assetIds.includes(scene.assetId)));
  assert.equal(quality.decision, 'passed');
});

test('duration changes narrative density', () => {
  const manifest = buildAssetManifest(input, assets);
  const creative = buildCreativeSpec(input);
  const shortVideo = buildVideoSpec({...input, durationMs: 15_000}, manifest, creative);
  const longVideo = buildVideoSpec({...input, durationMs: 180_000}, manifest, creative);
  assert.equal(shortVideo.scenes.length, 4);
  assert.equal(longVideo.scenes.length, 12);
});

test('blocking media failure derives a failed quality decision', () => {
  const manifest = buildAssetManifest(input, assets);
  const video = buildVideoSpec(input, manifest, buildCreativeSpec(input));
  const quality = buildQualityReport(input, manifest, video, {durationDeltaMs: 0, width: 1080, height: 1920, hasAudio: false, blackDurationMs: 0});
  assert.equal(quality.decision, 'failed');
  assert.equal(quality.checks.find((check) => check.key === 'audio')?.passed, false);
});

test('relay URL normalizes to one responses path', () => {
  assert.equal(normalizeResponsesUrl('https://relay.example.com'), 'https://relay.example.com/v1/responses');
  assert.equal(normalizeResponsesUrl('https://relay.example.com/api/'), 'https://relay.example.com/api/v1/responses');
  assert.equal(normalizeResponsesUrl('https://relay.example.com/v1/'), 'https://relay.example.com/v1/responses');
  assert.equal(normalizeResponsesUrl('https://relay.example.com/v1/responses'), 'https://relay.example.com/v1/responses');
  assert.equal(normalizeResponsesUrl('https://relay.example.com/v1/responses/?ignored=1'), 'https://relay.example.com/v1/responses');
});

test('relay models URL follows the configured responses base path', () => {
  assert.equal(normalizeModelsUrl('https://relay.example.com'), 'https://relay.example.com/v1/models');
  assert.equal(normalizeModelsUrl('https://relay.example.com/v1/'), 'https://relay.example.com/v1/models');
  assert.equal(normalizeModelsUrl('https://relay.example.com/v1/responses'), 'https://relay.example.com/v1/models');
  assert.equal(normalizeModelsUrl('https://relay.example.com/api/'), 'https://relay.example.com/api/v1/models');
});

test('relay model list accepts OpenAI data objects, removes duplicates and sorts ids', () => {
  assert.deepEqual(parseModelList({object: 'list', data: [{id: 'gpt-z'}, {id: 'gpt-a'}, {id: 'gpt-z'}]}), ['gpt-a', 'gpt-z']);
  assert.deepEqual(parseModelList({models: ['model-b', {id: 'model-a'}]}), ['model-a', 'model-b']);
  assert.throws(() => parseModelList({data: []}), /没有返回可用模型/);
});

test('SSE parser requires response.completed', () => {
  const complete = 'data: {"type":"response.output_text.delta","delta":"{\\"ok\\":true}"}\n\ndata: {"type":"response.completed"}\n\ndata: [DONE]\n\n';
  assert.equal(parseSseText(complete), '{"ok":true}');
  assert.throws(() => parseSseText('data: [DONE]\n\n'), /response.completed/);
});

test('SSE stream_timeout remains relay_failed but is classified as retryable', () => {
  assert.equal(isRetryableRelayFailureMessage('stream_timeout'), true);
  assert.equal(isRetryableRelayFailureMessage('invalid_request_error'), false);
  assert.throws(
    () => parseSseText('data: {"type":"response.failed","response":{"error":{"message":"stream_timeout"}}}\n\n'),
    (error) => error instanceof RelayError && error.code === 'relay_failed' && error.message === 'stream_timeout' && error.retryable,
  );
});

test('SSE parser supports CRLF and multiline data frames', () => {
  const body = 'data: {"type":"response.output_text.delta",\r\ndata: "delta":"pong"}\r\n\r\ndata: {"type":"response.completed"}\r\n\r\n';
  assert.equal(parseSseText(body), 'pong');
});

test('model JSON parser ignores only leading invisible formatting noise', () => {
  assert.deepEqual(parseModelJson('\u200B\u2060{\"ok\":true}'), {ok: true});
  assert.throws(() => parseModelJson('模型回复：{\"ok\":true}'), SyntaxError);
});

test('asset analysis sends inline keyframe bytes instead of local signed URLs', async () => {
  let requestBody: {input?: Array<{content?: Array<{type: string; text?: string; image_url?: string}>}>} | undefined;
  const manifest = buildAssetManifest(input, assets);
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      response.writeHead(200, {'content-type': 'text/event-stream'});
      response.end(`data: ${JSON.stringify({type: 'response.output_text.delta', delta: JSON.stringify(manifest)})}\n\ndata: ${JSON.stringify({type: 'response.completed'})}\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('mock_server_address_invalid');
    const relay = new RelayClient({baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'test-key', model: 'vision-test'});
    await analyzeAssets(input, assets, relay, undefined, ['data:image/jpeg;base64,aGVsbG8=']);
    const content = requestBody?.input?.[0]?.content ?? [];
    assert.equal(content[1]?.type, 'input_image');
    assert.equal(content[1]?.image_url, 'data:image/jpeg;base64,aGVsbG8=');
    assert.equal(content[0]?.text?.includes('http://example.test/'), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('relay chat sends recent user and assistant messages using Responses content types', async () => {
  let requestBody: Record<string, unknown> | undefined;
  let authorization = '';
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      authorization = String(request.headers.authorization ?? '');
      requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      response.writeHead(200, {'content-type': 'text/event-stream'});
      response.end('data: {"type":"response.output_text.delta","delta":"pong"}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('mock_server_address_invalid');
    const deltas: string[] = [];
    const reply = await new RelayClient({baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'test-chat-key', model: 'test-chat-model'})
      .requestChat([{role: 'user', content: 'ping'}, {role: 'assistant', content: 'previous'}, {role: 'user', content: 'again'}], [], undefined, undefined, (delta) => deltas.push(delta));
    assert.equal(reply, 'pong');
    assert.deepEqual(deltas, ['pong']);
    assert.equal(authorization, 'Bearer test-chat-key');
    assert.equal(requestBody?.model, 'test-chat-model');
    assert.equal(requestBody?.stream, true);
    assert.equal(requestBody?.store, false);
    const inputItems = requestBody?.input as Array<{role: string; content: Array<{type: string; text: string}>}>;
    assert.deepEqual(inputItems.map((item) => [item.role, item.content[0]?.type]), [
      ['user', 'input_text'], ['assistant', 'output_text'], ['user', 'input_text'],
    ]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('relay chat attaches images only to the latest user message', async () => {
  let requestBody: Record<string, unknown> | undefined;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      response.writeHead(200, {'content-type': 'text/event-stream'});
      response.end('data: {"type":"response.output_text.delta","delta":"看到了图片"}\n\ndata: {"type":"response.completed"}\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('mock_server_address_invalid');
    await new RelayClient({baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'test-chat-key', model: 'test-chat-model'})
      .requestChat([{role: 'user', content: '先前问题'}, {role: 'assistant', content: '先前回答'}, {role: 'user', content: '请看图片'}], ['data:image/png;base64,aW1hZ2U=']);
    const inputItems = requestBody?.input as Array<{role: string; content: Array<{type: string; text?: string; image_url?: string}>}>;
    assert.deepEqual(inputItems[0]?.content, [{type: 'input_text', text: '先前问题'}]);
    assert.deepEqual(inputItems[1]?.content, [{type: 'output_text', text: '先前回答'}]);
    assert.deepEqual(inputItems[2]?.content, [
      {type: 'input_text', text: '请看图片'},
      {type: 'input_image', image_url: 'data:image/png;base64,aW1hZ2U='},
    ]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('protocol tester sends text and visual frames only as Responses image inputs', async () => {
  let requestBody: Record<string, unknown> | undefined;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      response.writeHead(200, {'content-type': 'text/event-stream'});
      response.end('data: {"type":"response.output_text.delta","delta":"看到了图片"}\n\ndata: {"type":"response.completed"}\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('mock_server_address_invalid');
    const reply = await new RelayClient({baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'test-protocol-key', model: 'test-vision-model'})
      .requestMultimodalText('请描述媒体', ['data:image/png;base64,aW1hZ2U=']);
    assert.equal(reply, '看到了图片');
    const requestInput = requestBody?.input as Array<{role: string; content: Array<{type: string; text?: string; image_url?: string}>}>;
    assert.equal(requestBody?.stream, true);
    assert.equal(requestBody?.store, false);
    assert.equal(requestInput.length, 1);
    assert.equal(requestInput[0]?.role, 'user');
    assert.deepEqual(requestInput[0]?.content, [
      {type: 'input_text', text: '请描述媒体'},
      {type: 'input_image', image_url: 'data:image/png;base64,aW1hZ2U='},
    ]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('relay conversation audit stores the complete text exchange without embedding media bytes', async () => {
  const records: ModelConversationRecord[] = [];
  const server = createServer((_request, response) => {
    response.writeHead(200, {'content-type': 'text/event-stream'});
    response.end('data: {"type":"response.output_text.delta","delta":"已收到图片"}\n\ndata: {"type":"response.completed"}\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('mock_server_address_invalid');
    const relay = new RelayClient(
      {baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'test-audit-key', model: 'test-audit-model'},
      {tenantId: 'tenant_test', relayKeyId: 'key_audit', onRecord: (record) => records.push(record)},
    );
    await relay.requestMultimodalText('请描述媒体', ['data:image/png;base64,aW1hZ2U='], undefined, {
      ownerId: 'user_test', projectId: 'project_test', source: 'relay.protocol-test',
    });
    assert.equal(records.length, 1);
    const record = records[0]!;
    assert.equal(record.status, 'completed');
    assert.equal(record.ownerId, 'user_test');
    assert.equal(record.responseText, '已收到图片');
    assert.ok(record.requestMessages.some((message) => message.role === 'media' && message.content.includes('image/png')));
    assert.equal(JSON.stringify(record).includes('aW1hZ2U='), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('relay reads SSE incrementally and records first-byte and first-event metrics', async () => {
  const records: ModelConversationRecord[] = [];
  const server = createServer((_request, response) => {
    response.writeHead(200, {'content-type': 'text/event-stream'});
    setTimeout(() => {
      response.write('data: {"type":"response.output_text.delta","delta":"chunked"}\n\n');
      setTimeout(() => response.end('data: {"type":"response.completed"}\n\n'), 10);
    }, 20);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('mock_server_address_invalid');
    const relay = new RelayClient(
      {baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'test-stream-key', model: 'test-stream-model', firstByteTimeoutMs: 500, idleTimeoutMs: 500, totalTimeoutMs: 1_000},
      {tenantId: 'tenant_test', onRecord: (record) => records.push(record)},
    );
    assert.equal(await relay.requestMultimodalText('stream', []), 'chunked');
    assert.equal(records.length, 1);
    assert.ok(records[0]!.timeToFirstByteMs !== undefined);
    assert.ok(records[0]!.timeToFirstEventMs !== undefined);
    assert.ok(records[0]!.latencyMs >= records[0]!.timeToFirstEventMs!);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('relay conversation audit forwards SSE text deltas to one streaming record', async () => {
  const progress: ModelConversationRecord[] = [];
  const final: ModelConversationRecord[] = [];
  const server = createServer((_request, response) => {
    response.writeHead(200, {'content-type': 'text/event-stream'});
    response.write('data: {"type":"response.output_text.delta","delta":"part-a"}\n\n');
    setTimeout(() => response.end('data: {"type":"response.output_text.delta","delta":"part-b"}\n\ndata: {"type":"response.completed"}\n\n'), 10);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('mock_server_address_invalid');
    const relay = new RelayClient(
      {baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'test-stream-audit-key', model: 'test-stream-audit-model'},
      {tenantId: 'tenant_test', onRecord: (record) => final.push(record), onProgress: (record) => progress.push(record)},
    );
    assert.equal(await relay.requestMultimodalText('stream audit', []), 'part-apart-b');
    assert.ok(progress.length >= 2);
    assert.ok(progress.every((record) => record.status === 'streaming'));
    assert.equal(new Set(progress.map((record) => record.id)).size, 1);
    assert.equal(progress.at(-1)?.responseText, 'part-apart-b');
    assert.equal(final.length, 1);
    assert.equal(final[0]?.id, progress[0]?.id);
    assert.equal(final[0]?.responseText, 'part-apart-b');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('relay timeout phase distinguishes first byte, idle gap and total duration', async () => {
  const runTimeoutCase = async (writeResponse: (response: import('node:http').ServerResponse) => void, config: {firstByteTimeoutMs: number; idleTimeoutMs: number; totalTimeoutMs: number}, expectedCode: string, expectedPhase: 'first_byte' | 'idle' | 'total') => {
    const server = createServer((_request, response) => {
      response.on('error', () => undefined);
      writeResponse(response);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('mock_server_address_invalid');
      const relay = new RelayClient({baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'test-timeout-key', model: 'test-timeout-model', ...config});
      await assert.rejects(() => relay.requestMultimodalText('timeout', []), (error: unknown) => error instanceof RelayError && error.code === expectedCode && error.metrics?.timeoutPhase === expectedPhase);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
  await runTimeoutCase((response) => setTimeout(() => response.end('data: [DONE]\n\n'), 80), {firstByteTimeoutMs: 20, idleTimeoutMs: 200, totalTimeoutMs: 300}, 'relay_first_byte_timeout', 'first_byte');
  await runTimeoutCase((response) => {
    response.writeHead(200, {'content-type': 'text/event-stream'});
    response.write('data: {"type":"response.output_text.delta","delta":"x"}\n\n');
    setTimeout(() => response.end('data: {"type":"response.completed"}\n\n'), 80);
  }, {firstByteTimeoutMs: 200, idleTimeoutMs: 20, totalTimeoutMs: 300}, 'relay_idle_timeout', 'idle');
  await runTimeoutCase((response) => {
    response.writeHead(200, {'content-type': 'text/event-stream'});
    response.write('data: {"type":"response.output_text.delta","delta":"x"}\n\n');
    setTimeout(() => response.end('data: {"type":"response.completed"}\n\n'), 80);
  }, {firstByteTimeoutMs: 200, idleTimeoutMs: 200, totalTimeoutMs: 20}, 'relay_total_timeout', 'total');
});

test('protocol tester samples the reported Pexels MP4 into three JPEG image inputs', async () => {
  const videoPath = path.join(process.cwd(), '素材_洗车可商用', '10_泡沫冲洗_Pexels.mp4');
  const media = await prepareProtocolTestMedia([{
    path: videoPath,
    sizeBytes: statSync(videoPath).size,
    fileName: '10_泡沫冲洗_Pexels.mp4',
  }]);
  assert.equal(media.uploadedImageCount, 0);
  assert.equal(media.uploadedVideoCount, 1);
  assert.equal(media.imageUrls.length, 3);
  assert.ok(media.imageUrls.every((imageUrl) => imageUrl.startsWith('data:image/jpeg;base64,')));
});

test('protocol tester makes one request and exposes a safe relay HTTP error', async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(502, {'content-type': 'application/json'});
    response.end(JSON.stringify({error: {message: 'vision input temporarily unavailable'}}));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('mock_server_address_invalid');
    const relay = new RelayClient({baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'test-protocol-key', model: 'test-vision-model'});
    await assert.rejects(() => relay.requestMultimodalText('检查视频关键帧', ['data:image/jpeg;base64,aGVsbG8=']), /中转站 HTTP 502：vision input temporarily unavailable/);
    assert.equal(requests, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
