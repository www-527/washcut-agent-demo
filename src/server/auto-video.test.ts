import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import sharp from 'sharp';
import {
  autoVideoProjectSchema,
  autoVideoGenerationSchema,
  autoVideoGenerationCreateSchema,
  type AutoVideoAssetCheckpoint,
  makeInitialProcessingSteps,
  type StoredAutoVideoAsset,
} from '../shared/auto-video-contracts.js';
import {AutoVideoAiProvider, assetVisualAnalysisSchema, normalizeVisualModelValue, toAssetAnalysis, validateAutoEditPlan} from './auto-video-ai.js';
import {captionsToWebVtt, globalizeCaptions, transcriptToCaptions} from './auto-video-captions.js';
import {balancedScreenshotTimestamps, createContactSheet, screenshotTimestamps} from './auto-video-media.js';
import {normalizeSpeachesResponse, emptyNormalizedTranscript} from './speaches.js';
import {compileAutoVideoTimeline, validateAutoTimeline} from './auto-video-timeline.js';
import {SqliteStore} from './store.js';
import {AUTO_VIDEO_RETRY_DELAY_MS, toAutoVideoError} from './auto-video-worker.js';
import {RelayClient, RelayError} from './relay-client.js';

const now = new Date().toISOString();
const project = autoVideoProjectSchema.parse({
  id: 'project_auto_test', tenantId: 'tenant_test', ownerId: 'user_test', name: '测试编排',
  status: 'draft', progress: 0, canvas: {width: 1080, height: 1920, fps: 30}, assetIds: ['asset_a', 'asset_b'],
  steps: makeInitialProcessingSteps(), transcripts: [], screenshotAnalyses: [], assetAnalyses: [], createdAt: now, updatedAt: now,
});

const asset = (id: string, durationMs: number): StoredAutoVideoAsset => ({
  id, tenantId: project.tenantId, ownerId: project.ownerId, projectId: project.id, originalName: `${id}.mp4`,
  mimeType: 'video/mp4', fileSize: 100, checksum: id === 'asset_a' ? 'a'.repeat(64) : 'b'.repeat(64), status: 'ready',
  originalPath: `C:/tmp/${id}.mp4`, screenshots: [], createdAt: now,
  metadata: {assetId: id, durationMs, width: 1080, height: 1920, fps: 30, videoCodec: 'h264', hasAudio: id === 'asset_a', orientation: 'portrait'},
});

test('Speaches verbose response is normalized from seconds to bounded milliseconds', () => {
  const transcript = normalizeSpeachesResponse({
    language: 'zh', text: '你好，世界。',
    words: [{word: '你好', start: 0.125, end: 0.75, probability: 0.9}, {word: '', start: 1, end: 2}],
    segments: [{text: '你好，世界。', start: 0.1, end: 1.25, confidence: 0.8}, {text: '越界', start: 1, end: 99}],
  }, {assetId: 'asset_a', durationMs: 2_000, model: 'test-speaches'});
  assert.equal(transcript.words[0]?.startMs, 125);
  assert.equal(transcript.words[0]?.endMs, 750);
  assert.equal(transcript.segments.length, 2);
  assert.equal(transcript.segments[0]?.endMs, 1_250);
  assert.equal(transcript.segments[1]?.endMs, 2_000);
  assert.equal(transcript.text, '你好，世界。');
});

test('no-audio assets produce a valid empty transcript and empty caption track', () => {
  const transcript = emptyNormalizedTranscript('asset_b', 1_000, 'no-audio');
  assert.equal(transcript.text, '');
  assert.deepEqual(transcriptToCaptions('asset_b', transcript).captions, []);
});

test('word timestamps split a long transcript segment into short timed captions', () => {
  const transcript = normalizeSpeachesResponse({
    words: [
      {word: '洗车界的', start: 0, end: 0.3}, {word: '扛把子', start: 0.3, end: 0.6}, {word: '我敢说', start: 0.6, end: 0.9},
      {word: '没有我', start: 0.9, end: 1.2}, {word: '洗不干净的车', start: 1.2, end: 1.7}, {word: '不信就来体验下吧', start: 1.7, end: 2.3},
    ],
    segments: [{text: '洗车界的扛把子我敢说没有我洗不干净的车不信就来体验下吧', start: 0, end: 2.3}],
  }, {assetId: 'asset_a', durationMs: 3_000, model: 'test-speaches'});
  const captions = transcriptToCaptions('asset_a', transcript).captions;
  assert.deepEqual(captions.map((caption) => caption.text), ['洗车界的扛把子我敢说没有我', '洗不干净的车不信就来体验下吧']);
  assert.deepEqual(captions.map((caption) => [caption.startMs, caption.endMs]), [[0, 1_200], [1_200, 2_300]]);
});

test('asset analysis keeps visible behaviour ahead of an optional transcript', () => {
  const transcript = normalizeSpeachesResponse({text: '这里是全城最低价洗车', segments: [{text: '这里是全城最低价洗车', start: 0, end: 0.8}]}, {assetId: 'asset_a', durationMs: 1_000, model: 'test'});
  const analysis = toAssetAnalysis(assetVisualAnalysisSchema.parse({
    assetId: 'asset_a', visualSummary: '工作人员正用高压水枪冲洗车身', people: ['工作人员'], objects: ['高压水枪'], actions: ['冲洗车身'], scenes: ['洗车工位'], screenTexts: [], chronologicalHints: [], confidence: 0.9, needsDetail: false,
  }), transcript);
  assert.equal(analysis.combinedSummary, '画面行为：工作人员正用高压水枪冲洗车身。语音/字幕（仅辅助）：这里是全城最低价洗车');
});

test('automatic-video errors preserve an upstream relay code and message without a business-code wrapper', () => {
  const source = new RelayError('中转站请求超时', 'relay_timeout', true);
  assert.deepEqual(toAutoVideoError(source), {
    code: 'relay_timeout', message: '中转站请求超时', retryable: true, details: '中转站请求超时',
  });
});

test('generation creation limits visual-analysis concurrency to the supported choices', () => {
  assert.equal(autoVideoGenerationCreateSchema.parse({visualConcurrency: 1}).visualConcurrency, 1);
  assert.equal(autoVideoGenerationCreateSchema.parse({visualConcurrency: 4}).visualConcurrency, 4);
  assert.throws(() => autoVideoGenerationCreateSchema.parse({visualConcurrency: 0}));
  assert.throws(() => autoVideoGenerationCreateSchema.parse({visualConcurrency: 5}));
  assert.throws(() => autoVideoGenerationCreateSchema.parse({visualConcurrency: 1.5}));
});

test('captions are shifted from local clip time to final timeline and exported as WebVTT', () => {
  const transcript = normalizeSpeachesResponse({segments: [{text: '第二段对白', start: 0.2, end: 0.8}]}, {assetId: 'asset_b', durationMs: 1_000, model: 'test'});
  const plan = validateAutoEditPlan({
    projectId: project.id,
    clips: [{assetId: 'asset_a', order: 1, reason: '开场'}, {assetId: 'asset_b', order: 2, reason: '结尾'}],
    excludedAssets: [], overallReason: '完整播放',
  }, project.id, project.assetIds);
  const timeline = compileAutoVideoTimeline(project, [asset('asset_a', 1_500), asset('asset_b', 1_000)], plan);
  const captions = globalizeCaptions([transcriptToCaptions('asset_b', transcript)], timeline);
  assert.equal(captions[0]?.startMs, 1_700);
  assert.equal(captions[0]?.endMs, 2_300);
  assert.match(captionsToWebVtt(captions), /00:00:01\.700 --> 00:00:02\.300/);
  assert.match(captionsToWebVtt(captions), /^WEBVTT/m);
});

test('timeline keeps every valid asset once with contiguous frames and no gaps', () => {
  const assets = [asset('asset_a', 1_500), asset('asset_b', 1_000)];
  const plan = validateAutoEditPlan({
    projectId: project.id,
    clips: [{assetId: 'asset_b', order: 1, reason: '先展示结果'}, {assetId: 'asset_a', order: 2, reason: '再给出过程'}],
    excludedAssets: [], overallReason: '测试自动顺序',
  }, project.id, project.assetIds);
  const timeline = compileAutoVideoTimeline(project, assets, plan);
  assert.equal(timeline.clips[0]?.assetId, 'asset_b');
  assert.equal(timeline.clips[0]?.durationInFrames, 30);
  assert.equal(timeline.clips[1]?.fromFrame, 30);
  assert.equal(timeline.clips[1]?.durationInFrames, 45);
  assert.equal(timeline.durationInFrames, 75);
  assert.equal(timeline.durationMs, 2_500);
  assert.equal(validateAutoTimeline(timeline, project.assetIds).clips.length, 2);
});

test('edit plan rejects duplicate or omitted asset IDs', () => {
  assert.throws(() => validateAutoEditPlan({
    projectId: project.id,
    clips: [{assetId: 'asset_a', order: 1, reason: '重复'}, {assetId: 'asset_a', order: 2, reason: '重复'}],
    excludedAssets: [], overallReason: '错误计划',
  }, project.id, project.assetIds), /EDIT_PLAN_INVALID/);
});

test('local planning preserves the uploaded asset order without position guesses', async () => {
  const provider = new AutoVideoAiProvider();
  const plan = await provider.plan({
    projectId: project.id,
    analyses: ['asset_a', 'asset_b'].map((assetId) => ({
      assetId, visualSummary: `${assetId} 的画面`, combinedSummary: `${assetId} 的综合说明`, topics: ['洗车'], people: [], scenes: ['洗车店'], screenTexts: [], chronologicalHints: [], duplicateWithAssetIds: [], confidence: 0.8,
    })),
    assetDurations: [{assetId: 'asset_b', durationMs: 1_000}, {assetId: 'asset_a', durationMs: 1_500}],
    canvas: project.canvas,
  });
  assert.deepEqual(plan.clips.map((clip) => clip.assetId), ['asset_b', 'asset_a']);
  assert.match(plan.overallReason, /上传顺序/);
});

test('auto-video asset records can be removed from a project store', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'washcut-auto-video-delete-'));
  const store = new SqliteStore(path.join(directory, 'washcut.sqlite'), 'test-secret');
  try {
    store.saveAutoVideoProject(project);
    store.saveAutoVideoAsset(asset('asset_a', 1_500));
    store.saveAutoVideoAsset(asset('asset_b', 1_000));

    assert.equal(store.deleteAutoVideoAsset('asset_a', project.tenantId, project.id), true);
    assert.deepEqual(store.listAutoVideoAssets(project.tenantId, project.id).map((item) => item.id), ['asset_b']);
    assert.equal(store.deleteAutoVideoAsset('asset_a', project.tenantId, project.id), false);
  } finally {
    store.close();
    rmSync(directory, {recursive: true, force: true});
  }
});

test('terminal generation deletion removes its checkpoints and leaves other versions intact', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'washcut-auto-video-generation-delete-'));
  const store = new SqliteStore(path.join(directory, 'washcut.sqlite'), 'test-secret');
  try {
    store.saveAutoVideoProject(project);
    const generation = store.createAutoVideoGeneration(autoVideoGenerationSchema.parse({
      generationId: 'generation_delete_test', projectId: project.id, tenantId: project.tenantId, ownerId: project.ownerId, versionNumber: 1,
      status: 'completed', progress: 100, aiMode: {kind: 'local', reason: 'user_selected_local'}, instructionSnapshot: '', canvas: project.canvas, assetIds: ['asset_a'],
      steps: makeInitialProcessingSteps(), transcripts: [], screenshotAnalyses: [], assetAnalyses: [], artifactStorage: 'generation', createdAt: now, updatedAt: now,
    }));
    store.saveAutoVideoAssetCheckpoint({
      generationId: generation.generationId, assetId: 'asset_a', sourceChecksum: 'a'.repeat(64),
      transcript: {status: 'pending'}, screenshots: {status: 'pending', screenshotIds: []}, visualAnalysis: {status: 'pending', attempts: 0}, updatedAt: now,
    });
    assert.equal(store.deleteAutoVideoGeneration(generation.generationId, project.tenantId, project.id), true);
    assert.equal(store.getAutoVideoGeneration(generation.generationId, project.tenantId), undefined);
    assert.deepEqual(store.listAutoVideoAssetCheckpoints(generation.generationId, project.tenantId), []);
    assert.equal(store.deleteAutoVideoGeneration(generation.generationId, project.tenantId, project.id), false);
  } finally {
    store.close();
    rmSync(directory, {recursive: true, force: true});
  }
});

test('generation-scoped checkpoints persist completed visual work and protect it from stale retry writes', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'washcut-auto-video-checkpoint-'));
  const store = new SqliteStore(path.join(directory, 'washcut.sqlite'), 'test-secret');
  try {
    store.saveAutoVideoProject(project);
    const generation = store.createAutoVideoGeneration(autoVideoGenerationSchema.parse({
      generationId: 'generation_checkpoint_test', projectId: project.id, tenantId: project.tenantId, ownerId: project.ownerId, versionNumber: 1,
      status: 'retry_waiting', progress: 20, aiMode: {kind: 'connected', connectionId: 'connection_test', model: 'test-model'},
      connectionId: 'connection_test', model: 'test-model', instructionSnapshot: '', canvas: project.canvas, assetIds: ['asset_a'],
      steps: makeInitialProcessingSteps(), transcripts: [], screenshotAnalyses: [], assetAnalyses: [], artifactStorage: 'generation',
      retryState: {status: 'waiting', stage: 'visual_analysis', nextRetryAt: new Date(Date.now() - 1_000).toISOString(), totalAttempts: 1, lastError: {code: 'VISUAL_ANALYSIS_FAILED', message: 'temporary upstream error', retryable: true}, updatedAt: now},
      createdAt: now, updatedAt: now,
    }));
    const pending: AutoVideoAssetCheckpoint = {
      generationId: generation.generationId, assetId: 'asset_a', sourceChecksum: 'a'.repeat(64),
      transcript: {status: 'completed', value: emptyNormalizedTranscript('asset_a', 1_000, 'no-audio'), completedAt: now},
      screenshots: {status: 'completed', screenshotIds: ['shot_a'], completedAt: now},
      visualAnalysis: {status: 'pending', attempts: 0}, updatedAt: now,
    };
    const first = store.saveAutoVideoAssetCheckpoint(pending);
    const completed = store.saveAutoVideoAssetCheckpoint({...first, visualAnalysis: {
      status: 'completed', attempts: 1, value: {
        assetId: 'asset_a', visualSummary: '车辆冲洗', people: [], objects: ['水枪'], actions: ['冲洗'], scenes: ['洗车店'], screenTexts: [], chronologicalHints: [], confidence: 0.9, needsDetail: false,
      }, completedAt: now,
    }}, first.updatedAt);
    const protectedCheckpoint = store.saveAutoVideoAssetCheckpoint({...first, visualAnalysis: {status: 'retry_waiting', attempts: 2, lastError: {code: 'VISUAL_ANALYSIS_FAILED', message: 'stale', retryable: true}, nextRetryAt: now}}, first.updatedAt);
    assert.equal(completed.visualAnalysis.status, 'completed');
    assert.equal(protectedCheckpoint.visualAnalysis.status, 'completed');
    assert.equal(store.listDueAutoVideoGenerationRetries(new Date().toISOString()).map((item) => item.generationId).includes(generation.generationId), true);
  } finally {
    store.close();
    rmSync(directory, {recursive: true, force: true});
  }
});

test('historical generation analyses and checkpoints ignore the retired position field when read', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'washcut-auto-video-legacy-position-'));
  const databasePath = path.join(directory, 'washcut.sqlite');
  const store = new SqliteStore(databasePath, 'test-secret');
  try {
    store.saveAutoVideoProject(project);
    const generation = store.createAutoVideoGeneration(autoVideoGenerationSchema.parse({
      generationId: 'generation_legacy_position_test', projectId: project.id, tenantId: project.tenantId, ownerId: project.ownerId, versionNumber: 1,
      status: 'completed', progress: 100, aiMode: {kind: 'local', reason: 'no_model_connection'}, instructionSnapshot: '', canvas: project.canvas, assetIds: ['asset_a'],
      steps: makeInitialProcessingSteps().map((step) => ({...step, status: 'completed', progress: 100})), transcripts: [], screenshotAnalyses: [], assetAnalyses: [], artifactStorage: 'generation', createdAt: now, startedAt: now, completedAt: now, updatedAt: now,
    }));
    const checkpoint = store.saveAutoVideoAssetCheckpoint({
      generationId: generation.generationId, assetId: 'asset_a', sourceChecksum: 'a'.repeat(64),
      transcript: {status: 'completed', value: emptyNormalizedTranscript('asset_a', 1_000, 'no-audio'), completedAt: now},
      screenshots: {status: 'completed', screenshotIds: ['shot_a'], completedAt: now},
      visualAnalysis: {status: 'completed', attempts: 1, value: {assetId: 'asset_a', visualSummary: '冲洗车辆', people: [], objects: [], actions: ['冲洗'], scenes: ['洗车店'], screenTexts: [], chronologicalHints: [], confidence: 0.9, needsDetail: false}, completedAt: now},
      updatedAt: now,
    });
    store.close();

    const database = new DatabaseSync(databasePath);
    database.prepare('UPDATE auto_video_generations SET payload_json = ? WHERE generation_id = ?').run(JSON.stringify({...generation, assetAnalyses: [{assetId: 'asset_a', visualSummary: '冲洗车辆', combinedSummary: '冲洗车辆', topics: ['冲洗'], people: [], scenes: ['洗车店'], screenTexts: [], chronologicalHints: [], suggestedPosition: 'middle', duplicateWithAssetIds: [], confidence: 0.9}]}), generation.generationId);
    database.prepare('UPDATE auto_video_asset_checkpoints SET payload_json = ? WHERE generation_id = ? AND asset_id = ?').run(JSON.stringify({...checkpoint, visualAnalysis: {...checkpoint.visualAnalysis, value: {...checkpoint.visualAnalysis.value!, suggestedPosition: 'middle'}}}), generation.generationId, checkpoint.assetId);
    database.close();

    const reopened = new SqliteStore(databasePath, 'test-secret');
    try {
      assert.equal(reopened.getAutoVideoGeneration(generation.generationId, project.tenantId)?.assetAnalyses[0]?.assetId, 'asset_a');
      assert.equal('suggestedPosition' in (reopened.getAutoVideoAssetCheckpoint(generation.generationId, 'asset_a', project.tenantId)?.visualAnalysis.value ?? {}), false);
    } finally {
      reopened.close();
    }
  } finally {
    try { store.close(); } catch { /* already closed for the compatibility read */ }
    rmSync(directory, {recursive: true, force: true});
  }
});

test('recoverable auto-video retries always wait five seconds', () => {
  assert.equal(AUTO_VIDEO_RETRY_DELAY_MS, 5_000);
});

test('screenshot strategy always contains an early, middle and late sample', () => {
  const timestamps = screenshotTimestamps(40_000);
  assert.ok(timestamps.length >= 3);
  assert.ok(timestamps.some((timestamp) => timestamp < 1_000));
  assert.ok(timestamps.some((timestamp) => timestamp >= 19_000 && timestamp <= 21_000));
  assert.ok(timestamps.some((timestamp) => timestamp > 39_000));
});

test('balanced screenshot strategy samples early, middle and late without duplicates', () => {
  assert.deepEqual(balancedScreenshotTimestamps(100), [0, 2, 50]);
  assert.deepEqual(balancedScreenshotTimestamps(1), [0]);
  const points = balancedScreenshotTimestamps(4_300);
  assert.equal(points.length, 3);
  assert.equal(points[1], 2_150);
});

test('contact sheet locally combines ordered frames into one labeled image', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'washcut-contact-sheet-'));
  const screenshotDir = path.join(directory, 'screenshots');
  mkdirSync(screenshotDir);
  try {
    const frames = await Promise.all(['#dc2626', '#16a34a', '#2563eb'].map(async (background, index) => {
      const filePath = path.join(screenshotDir, `${index + 1}.jpg`);
      await sharp({create: {width: 608, height: 1080, channels: 3, background}}).jpeg().toFile(filePath);
      return {id: `shot_${index + 1}`, assetId: 'asset_a', timestampMs: [49, 1_234, 2_167][index]!, filePath};
    }));
    const sheet = await createContactSheet(frames);
    const metadata = await sharp(sheet.filePath).metadata();
    assert.deepEqual(sheet.panels, [{id: 'A', timestampMs: 49}, {id: 'B', timestampMs: 1_234}, {id: 'C', timestampMs: 2_167}]);
    assert.equal(metadata.width, 1_536);
    assert.equal(metadata.height, 974);
    assert.equal(metadata.format, 'jpeg');
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});

test('object-shaped visual fields are normalized into safe string arrays', () => {
  const normalized = normalizeVisualModelValue({
    assetId: 'asset_a', visualSummary: '洗车过程',
    people: [{name: '洗车工作人员'}], objects: [{description: '高压水枪'}], actions: [{action: '冲洗车身'}],
    scene: {location: '洗车店', lighting: '明亮'}, ocrText: [{text: '精洗'}], chronologicalHints: [{details: '车辆进入工位'}],
    suggestedPosition: '按原始顺序作为外观精洗流程片段。', confidence: 0.8, needsDetail: false,
  });
  const parsed = assetVisualAnalysisSchema.parse(normalized.value);
  assert.deepEqual(parsed.people, ['洗车工作人员']);
  assert.deepEqual(parsed.objects, ['高压水枪']);
  assert.deepEqual(parsed.actions, ['冲洗车身']);
  assert.deepEqual(parsed.scenes, ['洗车店；明亮']);
  assert.deepEqual(parsed.screenTexts, ['精洗']);
  assert.equal('suggestedPosition' in parsed, false);
  assert.ok(normalized.diagnostics.normalizedFields.length >= 5);
});

test('unrecoverable visual values surface a safe field diagnostic', () => {
  const normalized = normalizeVisualModelValue({people: [42]});
  assert.deepEqual(normalized.diagnostics.droppedItems, ['people[0]']);
  assert.equal(assetVisualAnalysisSchema.safeParse(normalized.value).success, false);
});

test('contact-sheet visual analysis sends its business instruction with ordinary image inputs', async () => {
  let requestBody: Record<string, unknown> | undefined;
  let requestCount = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requestCount += 1;
      requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      const result = {
        assetId: 'asset_a', visualSummary: '门店内讲解洗车服务', people: ['服务人员'], objects: ['产品货架'], actions: ['面对镜头讲解'], scenes: ['洗车门店'], screenTexts: [], chronologicalHints: ['A 到 C 持续讲解'], suggestedPosition: '适合作为服务介绍之后的连续镜头。', confidence: 0.9, needsDetail: false,
      };
      response.writeHead(200, {'content-type': 'text/event-stream'});
      response.end(`data: ${JSON.stringify({type: 'response.output_text.delta', delta: `\u200B${JSON.stringify(result)}`})}\n\ndata: ${JSON.stringify({type: 'response.completed'})}\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('mock_server_address_invalid');
    const provider = new AutoVideoAiProvider(new RelayClient({baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'test-key', model: 'vision-test'}));
    const result = await provider.analyzeAssetVisualSummary({
      assetId: 'asset_a', metadata: asset('asset_a', 1_000).metadata!,
      contactSheetDataUrls: ['data:image/jpeg;base64,aGVsbG8='], panels: [{id: 'A', timestampMs: 0}, {id: 'B', timestampMs: 500}, {id: 'C', timestampMs: 900}],
    });
    assert.equal(result.analysis.assetId, 'asset_a');
    assert.equal(requestCount, 1);
    assert.equal((requestBody?.text as {format?: unknown} | undefined)?.format, undefined);
    assert.match(String(requestBody?.instructions ?? ''), /视频素材联合理解模块/);
    assert.doesNotMatch(String(requestBody?.instructions ?? ''), /验证中转站连接/);
    const requestInput = requestBody?.input as Array<{role: string; content: Array<{type: string; text?: string; image_url?: string}>}>;
    assert.deepEqual(requestInput[0]?.content.map((item) => item.type), ['input_text', 'input_image']);
    assert.match(requestInput[0]?.content[0]?.text ?? '', /视频素材联合理解模块/);
    assert.match(requestInput[0]?.content[0]?.text ?? '', /画面中可见的人、物与动作是唯一的内容判断依据/);
    assert.doesNotMatch(requestInput[0]?.content[0]?.text ?? '', /字幕说这是洗后效果/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
