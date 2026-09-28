import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import sharp from 'sharp';
import {
  AUTO_VIDEO_MAX_ASSET_COUNT,
  AUTO_VIDEO_VISUAL_CONCURRENCY_DEFAULT,
  AUTO_VIDEO_VISUAL_CONCURRENCY_MAX,
  AUTO_VIDEO_VISUAL_CONCURRENCY_OPTIONS,
  autoVideoProjectSchema,
  autoVideoGenerationSchema,
  autoVideoGenerationCreateSchema,
  assetAnalysisSchema,
  marketingRoleBatchInputSchema,
  normalizedTranscriptSchema,
  type AutoVideoAssetCheckpoint,
  makeInitialProcessingSteps,
  type StoredAutoVideoAsset,
} from '../shared/auto-video-contracts.js';
import {getShortVideoCaptionLayout} from '../shared/auto-video-caption.js';
import {countAnalyzedAutoVideoAssets} from '../shared/auto-video-progress.js';
import {AutoVideoAiProvider, assetVisualAnalysisSchema, normalizeVisualModelValue, toAssetAnalysis, validateAutoEditPlan, validateMarketingRoleBatchResult, validateModelEditPlanCandidate} from './auto-video-ai.js';
import {captionsToWebVtt, globalizeCaptions, transcriptToCaptions} from './auto-video-captions.js';
import {balancedScreenshotTimestamps, createContactSheet, screenshotTimestamps, signedAutoVideoGenerationUrl, verifyAutoVideoGenerationSignature} from './auto-video-media.js';
import {emptyNormalizedTranscript} from './transcription-provider.js';
import {compileAutoVideoTimeline, resolveAutoVideoCanvas, validateAutoTimeline} from './auto-video-timeline.js';
import {SqliteStore} from './store.js';
import {AbortableSemaphore, AutoVideoWorker, AUTO_VIDEO_MAX_RETRIES_PER_KEY, AUTO_VIDEO_RECOVERY_PROBE_DELAYS_MS, AUTO_VIDEO_RETRY_DELAY_MS, AUTO_VIDEO_RETRY_DELAYS_MS, MAX_AUTO_VIDEO_VISUAL_CONCURRENCY, asksForChronologicalSequence, autoVideoGenerationProgress, autoVideoRecoveryProbeDelay, hasCompleteAssetAnalyses, mapWithConcurrency, parseAutoVideoConcurrencyLimit, toAutoVideoError} from './auto-video-worker.js';
import {createModelAssetReferenceMap, toAssetId, toModelClipRef} from './model-asset-reference.js';
import {RelayClient, RelayError} from './relay-client.js';

const now = new Date().toISOString();
const project = autoVideoProjectSchema.parse({
  id: 'project_auto_test', tenantId: 'tenant_test', ownerId: 'user_test', name: '测试编排',
  status: 'draft', progress: 0, canvas: {width: 1080, height: 1920, fps: 30}, assetIds: ['asset_a', 'asset_b'],
  steps: makeInitialProcessingSteps(), transcripts: [], screenshotAnalyses: [], assetAnalyses: [], createdAt: now, updatedAt: now,
});

test('completed generation progress is always 100 while active progress remains step-derived', () => {
  const steps = makeInitialProcessingSteps();
  steps[0] = {...steps[0]!, status: 'completed', progress: 100, completedAt: now};
  assert.equal(autoVideoGenerationProgress(steps, 'analyzing'), 10);
  assert.equal(autoVideoGenerationProgress(steps, 'completed'), 100);
});

test('analysis progress uses the completed stage or persisted results when checkpoint summaries are missing', () => {
  const assetIds = ['asset_a', 'asset_b', 'asset_c'];
  const steps = makeInitialProcessingSteps();
  assert.equal(countAnalyzedAutoVideoAssets({
    assetIds,
    steps: steps.map((step) => step.name === 'visual_analysis' ? {...step, status: 'completed', progress: 100} : step),
    assetAnalyses: [],
    assetCheckpoints: [],
  }), 3);
  assert.equal(countAnalyzedAutoVideoAssets({
    assetIds,
    steps,
    assetAnalyses: [{assetId: 'asset_a'}, {assetId: 'asset_foreign'}],
    assetCheckpoints: [
      {assetId: 'asset_a', visualAnalysis: {status: 'completed'}},
      {assetId: 'asset_b', visualAnalysis: {status: 'completed'}},
      {assetId: 'asset_foreign', visualAnalysis: {status: 'completed'}},
    ],
  }), 2);
});

const asset = (id: string, durationMs: number): StoredAutoVideoAsset => ({
  id, tenantId: project.tenantId, ownerId: project.ownerId, projectId: project.id, originalName: `${id}.mp4`,
  mimeType: 'video/mp4', fileSize: 100, checksum: id === 'asset_a' ? 'a'.repeat(64) : 'b'.repeat(64), status: 'ready',
  originalPath: `C:/tmp/${id}.mp4`, screenshots: [], createdAt: now,
  metadata: {assetId: id, durationMs, width: 1080, height: 1920, fps: 30, videoCodec: 'h264', hasAudio: id === 'asset_a', orientation: 'portrait'},
});

const qwenTranscript = (input: {
  assetId?: string;
  durationMs: number;
  text?: string;
  words?: Array<{text: string; startMs: number; endMs: number; confidence?: number | null}>;
  segments?: Array<{text: string; startMs: number; endMs: number; confidence?: number | null}>;
}) => normalizedTranscriptSchema.parse({
  assetId: input.assetId ?? 'asset_a',
  language: 'zh',
  durationMs: input.durationMs,
  text: input.text ?? '',
  words: (input.words ?? []).map((word) => ({...word, confidence: word.confidence ?? null})),
  segments: (input.segments ?? []).map((segment) => ({...segment, confidence: segment.confidence ?? null})),
  provider: 'qwen3-asr',
  model: 'test-qwen3-asr',
});

const batchRoleInput = () => marketingRoleBatchInputSchema.parse({
  schema: 'auto-video-marketing-role-batch-input.v1',
  projectId: project.id,
  assets: [
    {
      assetId: 'asset_a', durationMs: 1_000, transcript: '你的车多久没彻底洗过了？',
      visualSummary: '工作人员用水枪冲洗车身', actions: ['冲洗车身'], scenes: ['洗车工位'], screenTexts: [], chronologicalHints: [],
    },
    {
      assetId: 'asset_b', durationMs: 1_500, transcript: '点击导航到店体验',
      visualSummary: '工作人员擦拭汽车玻璃', actions: ['擦拭玻璃'], scenes: ['洗车工位'], screenTexts: [], chronologicalHints: [],
    },
  ],
  userInstruction: '请自然衔接全部素材',
});

test('auto-video projects accept 50 assets and reject a 51st asset', () => {
  const assetIds = Array.from({length: AUTO_VIDEO_MAX_ASSET_COUNT}, (_, index) => `asset_${index + 1}`);
  assert.equal(autoVideoProjectSchema.safeParse({...project, assetIds}).success, true);
  assert.equal(autoVideoProjectSchema.safeParse({...project, assetIds: [...assetIds, 'asset_51']}).success, false);
});

test('model asset references are stable for 17 and 50 assets and map back to authoritative IDs', () => {
  const seventeen = Array.from({length: 17}, (_, index) => `authoritative_asset_${index + 1}`);
  const seventeenReferences = createModelAssetReferenceMap(seventeen);
  assert.deepEqual([...seventeenReferences.byClipRef.keys()], Array.from({length: 17}, (_, index) => `clip_${String(index + 1).padStart(3, '0')}`));
  assert.equal(toModelClipRef(seventeenReferences, 'authoritative_asset_17'), 'clip_017');
  assert.equal(toAssetId(seventeenReferences, 'clip_017'), 'authoritative_asset_17');

  const fifty = Array.from({length: 50}, (_, index) => `asset_${index + 1}`);
  const fiftyReferences = createModelAssetReferenceMap(fifty);
  assert.equal(toModelClipRef(fiftyReferences, 'asset_50'), 'clip_050');
  assert.equal(toAssetId(fiftyReferences, 'clip_050'), 'asset_50');
});

test('model asset references reject empty, duplicate, oversized, and unknown identities', () => {
  assert.throws(() => createModelAssetReferenceMap([]), /must not be empty/);
  assert.throws(() => createModelAssetReferenceMap(['asset_a', 'asset_a']), /duplicate assetId: asset_a/);
  assert.throws(() => createModelAssetReferenceMap(['asset_a', '   ']), /empty assetId/);
  assert.throws(() => createModelAssetReferenceMap(Array.from({length: 51}, (_, index) => `asset_${index}`)), /exceeds 50/);
  const references = createModelAssetReferenceMap(['asset_a']);
  assert.throws(() => toAssetId(references, 'clip_999'), /unknown clipRef: clip_999/);
  assert.throws(() => toModelClipRef(references, 'asset_x'), /unknown assetId: asset_x/);
});

test('generation canvas follows the first uploaded source ratio', () => {
  const fallback = {width: 1080, height: 1920, fps: 30};
  assert.deepEqual(resolveAutoVideoCanvas(fallback, [
    {metadata: {...asset('asset_a', 1_000).metadata!, width: 1920, height: 1080, orientation: 'landscape'}},
    {metadata: asset('asset_b', 1_000).metadata!},
  ]), {width: 1920, height: 1080, fps: 30});
  assert.deepEqual(resolveAutoVideoCanvas(fallback, [{metadata: undefined}]), fallback);
});

test('no-audio assets produce a valid empty transcript and empty caption track', () => {
  const transcript = emptyNormalizedTranscript('asset_b', 1_000, 'no-audio');
  assert.equal(transcript.text, '');
  assert.deepEqual(transcriptToCaptions('asset_b', transcript).captions, []);
});

test('word timestamps split a long transcript segment into short timed captions', () => {
  const transcript = qwenTranscript({
    durationMs: 3_000,
    words: [
      {text: '洗车界的', startMs: 0, endMs: 300}, {text: '扛把子', startMs: 300, endMs: 600}, {text: '我敢说', startMs: 600, endMs: 900},
      {text: '没有我', startMs: 900, endMs: 1_200}, {text: '洗不干净的车', startMs: 1_200, endMs: 1_700}, {text: '不信就来体验下吧', startMs: 1_700, endMs: 2_300},
    ],
    segments: [{text: '洗车界的扛把子我敢说没有我洗不干净的车不信就来体验下吧', startMs: 0, endMs: 2_300}],
  });
  const captions = transcriptToCaptions('asset_a', transcript).captions;
  assert.deepEqual(captions.map((caption) => caption.text), ['洗车界的扛把子我敢说没有我', '洗不干净的车不信就来体验下吧']);
  assert.deepEqual(captions.map((caption) => [caption.startMs, caption.endMs]), [[0, 1_200], [1_200, 2_300]]);
});

test('word timestamps merge a short trailing orphan when the caption only slightly exceeds the duration target', () => {
  const transcript = qwenTranscript({
    durationMs: 4_000,
    text: '先用泡沫软化车身表面的灰尘和污渍。',
    words: [
      {text: '先用泡沫软化车', startMs: 0, endMs: 1_760},
      {text: '身', startMs: 1_760, endMs: 1_920},
      {text: '表面灰尘和污', startMs: 1_920, endMs: 3_360},
      {text: '渍', startMs: 3_360, endMs: 3_600},
    ],
    segments: [{text: '先用泡沫软化车身表面的灰尘和污渍', startMs: 0, endMs: 3_600}],
  });
  const captions = transcriptToCaptions('asset_a', transcript).captions;
  assert.deepEqual(captions.map((caption) => caption.text), ['先用泡沫软化车', '身表面灰尘和污渍']);
  assert.deepEqual(captions.map((caption) => [caption.startMs, caption.endMs]), [[0, 1_760], [1_760, 3_600]]);
});

test('word timestamps rebalance a character-limit orphan without exceeding the single-line limit', () => {
  const words = Array.from('一二三四五六七八九十甲乙丙丁戊').map((text, index) => ({
    text,
    startMs: index * 100,
    endMs: (index + 1) * 100,
  }));
  const transcript = qwenTranscript({
    durationMs: 2_000,
    text: '一二三四五六七八九十甲乙丙丁戊',
    words,
    segments: [{text: '一二三四五六七八九十甲乙丙丁戊', startMs: 0, endMs: 1_500}],
  });
  const captions = transcriptToCaptions('asset_a', transcript).captions;
  assert.deepEqual(captions.map((caption) => caption.text), ['一二三四五六七八九十甲乙', '丙丁戊']);
  assert.deepEqual(captions.map((caption) => [caption.startMs, caption.endMs]), [[0, 1_200], [1_200, 1_500]]);
});

test('word timestamps do not rebalance an orphan across a real long pause', () => {
  const transcript = qwenTranscript({
    durationMs: 3_000,
    text: '清洗完成了',
    words: [
      {text: '清洗完成', startMs: 0, endMs: 1_000},
      {text: '了', startMs: 1_600, endMs: 1_800},
    ],
    segments: [{text: '清洗完成了', startMs: 0, endMs: 1_800}],
  });
  const captions = transcriptToCaptions('asset_a', transcript).captions;
  assert.deepEqual(captions.map((caption) => caption.text), ['清洗完成', '了']);
  assert.deepEqual(captions.map((caption) => [caption.startMs, caption.endMs]), [[0, 1_000], [1_600, 1_800]]);
});

test('segment-only transcripts are split into single-line caption-sized chunks', () => {
  const transcript = qwenTranscript({
    durationMs: 3_000,
    text: '脚踏板也是用刷子刷干净把地垫拆下来再清洗一遍',
    segments: [{text: '脚踏板也是用刷子刷干净把地垫拆下来再清洗一遍', startMs: 0, endMs: 2_200}],
  });
  const captions = transcriptToCaptions('asset_a', transcript).captions;
  assert.deepEqual(captions.map((caption) => caption.text), ['脚踏板也是用刷子刷干净把地垫', '拆下来再清洗一遍']);
  assert.deepEqual(captions.map((caption) => [caption.startMs, caption.endMs]), [[0, 1_400], [1_400, 2_200]]);
});

test('segment-only transcripts rebalance a trailing single-character caption', () => {
  const transcript = qwenTranscript({
    durationMs: 2_000,
    text: '一二三四五六七八九十甲乙丙丁戊',
    segments: [{text: '一二三四五六七八九十甲乙丙丁戊', startMs: 0, endMs: 1_500}],
  });
  const captions = transcriptToCaptions('asset_a', transcript).captions;
  assert.deepEqual(captions.map((caption) => caption.text), ['一二三四五六七八九十甲乙', '丙丁戊']);
  assert.deepEqual(captions.map((caption) => [caption.startMs, caption.endMs]), [[0, 1_200], [1_200, 1_500]]);
});

test('short-video captions scale from the actual canvas and stay in the lower reading area', () => {
  const layout = getShortVideoCaptionLayout(608, 1_080, '脚踏板也是用刷子刷干净');
  assert.equal(layout.bottomPx, 292);
  assert.ok(layout.fontSizePx > 26 && layout.fontSizePx < 28);
  assert.ok(layout.maxWidthPx > 535 && layout.maxWidthPx < 537);
  assert.ok(getShortVideoCaptionLayout(608, 1_080, '这是一条用于验证旧版超长字幕也能保持单行显示的特别长字幕').fontSizePx < layout.fontSizePx);
});

test('asset analysis persists the batch role and keeps narration ahead of objective visuals', () => {
  const transcript = qwenTranscript({durationMs: 1_000, text: '这里是全城最低价洗车', segments: [{text: '这里是全城最低价洗车', startMs: 0, endMs: 800}]});
  const analysis = toAssetAnalysis(assetVisualAnalysisSchema.parse({
    assetId: 'asset_a', visualSummary: '工作人员正用高压水枪冲洗车身', people: ['工作人员'], objects: ['高压水枪'], actions: ['冲洗车身'], scenes: ['洗车工位'], screenTexts: [], chronologicalHints: [], confidence: 0.9, needsDetail: false,
  }), transcript, {assetId: 'asset_a', marketingRole: 'offer', roleReason: '口播明确给出价格利益点。'});
  assert.equal(analysis.marketingRole, 'offer');
  assert.equal(analysis.roleReason, '口播明确给出价格利益点。');
  assert.equal(analysis.combinedSummary, '口播内容：这里是全城最低价洗车。客观画面：工作人员正用高压水枪冲洗车身');
});

test('batch role input contains every semantic field but no original media reference', () => {
  const input = batchRoleInput();
  assert.deepEqual(input.assets.map((item) => item.assetId), ['asset_a', 'asset_b']);
  assert.equal(input.assets[0]?.transcript, '你的车多久没彻底洗过了？');
  assert.equal(input.assets[0]?.visualSummary, '工作人员用水枪冲洗车身');
  const serialized = JSON.stringify(input);
  assert.doesNotMatch(serialized, /originalPath|temporaryAudioPath|\.mp4|data:video|file:\/\//i);
});

test('batch role validation accepts reordered complete results and rejects every set invariant violation', () => {
  const valid = validateMarketingRoleBatchResult({
    projectId: project.id,
    assets: [
      {assetId: 'asset_b', marketingRole: 'cta', roleReason: '口播明确引导到店。'},
      {assetId: 'asset_a', marketingRole: 'hook', roleReason: '提问式口播吸引注意。'},
    ],
  }, project.id, ['asset_a', 'asset_b']);
  assert.deepEqual(valid.assets.map((item) => item.assetId), ['asset_b', 'asset_a']);

  const invalidCases: Array<[unknown, RegExp]> = [
    [{projectId: project.id, assets: [{assetId: 'asset_a', marketingRole: 'hook', roleReason: '提问开场'}]}, /missing assetId: asset_b/],
    [{projectId: project.id, assets: [{assetId: 'asset_a', marketingRole: 'hook', roleReason: '提问开场'}, {assetId: 'asset_a', marketingRole: 'hook', roleReason: '重复'}]}, /duplicate assetId: asset_a/],
    [{projectId: project.id, assets: [{assetId: 'asset_a', marketingRole: 'hook', roleReason: '提问开场'}, {assetId: 'asset_x', marketingRole: 'cta', roleReason: '未知'}]}, /unknown assetId: asset_x/],
    [{projectId: project.id, assets: [{assetId: 'asset_a', marketingRole: 'opening', roleReason: '非法角色'}, {assetId: 'asset_b', marketingRole: 'cta', roleReason: '到店'}]}, /invalid marketingRole: asset_a/],
    [{projectId: project.id, assets: [{assetId: 'asset_a', marketingRole: 'hook', roleReason: '   '}, {assetId: 'asset_b', marketingRole: 'cta', roleReason: '到店'}]}, /empty roleReason: asset_a/],
  ];
  for (const [candidate, expectedMessage] of invalidCases) {
    assert.throws(() => validateMarketingRoleBatchResult(candidate, project.id, ['asset_a', 'asset_b']), expectedMessage);
  }
});

test('only complete set-matching role analyses are reusable after recovery', () => {
  const analyses = ['asset_a', 'asset_b'].map((assetId, index) => assetAnalysisSchema.parse({
    assetId,
    marketingRole: index === 0 ? 'hook' : 'cta',
    roleReason: index === 0 ? '提问开场' : '引导到店',
    visualSummary: '洗车画面', combinedSummary: '口播与洗车画面', topics: [], people: [], scenes: [], screenTexts: [], chronologicalHints: [], duplicateWithAssetIds: [], confidence: 0.9,
  }));
  assert.equal(hasCompleteAssetAnalyses(analyses, ['asset_a', 'asset_b']), true);
  assert.equal(hasCompleteAssetAnalyses([analyses[0]!, analyses[0]!], ['asset_a', 'asset_b']), false);
  assert.equal(hasCompleteAssetAnalyses(analyses.slice(0, 1), ['asset_a', 'asset_b']), false);
  const historical = analyses.map(({roleReason: _roleReason, ...analysis}) => assetAnalysisSchema.parse(analysis));
  assert.equal(hasCompleteAssetAnalyses(historical, ['asset_a', 'asset_b']), false);
  assert.equal(hasCompleteAssetAnalyses(historical, ['asset_a', 'asset_b'], false), true);
});

test('automatic-video errors preserve an upstream relay code and message without a business-code wrapper', () => {
  const source = new RelayError('中转站请求超时', 'relay_timeout', true);
  assert.deepEqual(toAutoVideoError(source), {
    code: 'relay_timeout', message: '中转站请求超时', retryable: true, details: '中转站请求超时',
  });
});

test('Chinese sequence instructions request chronological evidence', () => {
  assert.equal(asksForChronologicalSequence('请按时间顺序排列这些素材'), true);
  assert.equal(asksForChronologicalSequence('编排时注意先后顺序'), true);
  assert.equal(asksForChronologicalSequence('突出洗车效果和到店优惠'), false);
});

test('generation creation limits visual-analysis concurrency to the supported choices', () => {
  assert.equal(autoVideoGenerationCreateSchema.parse({visualConcurrency: 1}).visualConcurrency, 1);
  assert.equal(autoVideoGenerationCreateSchema.parse({visualConcurrency: 30}).visualConcurrency, 30);
  assert.equal(autoVideoGenerationCreateSchema.parse({model: 'vision-pro'}).model, 'vision-pro');
  assert.throws(() => autoVideoGenerationCreateSchema.parse({visualConcurrency: 0}));
  assert.throws(() => autoVideoGenerationCreateSchema.parse({visualConcurrency: 31}));
  assert.throws(() => autoVideoGenerationCreateSchema.parse({visualConcurrency: 1.5}));
  assert.throws(() => autoVideoGenerationCreateSchema.parse({visualConcurrency: '30'}));
  assert.throws(() => autoVideoGenerationCreateSchema.parse({visualConcurrency: Number.NaN}));
  assert.equal(AUTO_VIDEO_VISUAL_CONCURRENCY_DEFAULT, 1);
  assert.equal(AUTO_VIDEO_VISUAL_CONCURRENCY_MAX, 30);
  assert.equal(MAX_AUTO_VIDEO_VISUAL_CONCURRENCY, 30);
  assert.deepEqual(AUTO_VIDEO_VISUAL_CONCURRENCY_OPTIONS, Array.from({length: 30}, (_, index) => index + 1));
});

test('captions are shifted from local clip time to final timeline and exported as WebVTT', () => {
  const transcript = qwenTranscript({assetId: 'asset_b', durationMs: 1_000, segments: [{text: '第二段对白', startMs: 200, endMs: 800}]});
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

test('captioned generation downloads use their own signed media resource', () => {
  const signed = new URL(signedAutoVideoGenerationUrl(project.id, 'generation_test', 'captioned-output'));
  assert.match(signed.pathname, /\/generations\/generation_test\/output-captioned\.mp4$/);
  assert.equal(verifyAutoVideoGenerationSignature(
    project.id,
    'generation_test',
    'captioned-output',
    signed.searchParams.get('expires'),
    signed.searchParams.get('signature'),
  ), true);
  assert.equal(verifyAutoVideoGenerationSignature(
    project.id,
    'generation_test',
    'output',
    signed.searchParams.get('expires'),
    signed.searchParams.get('signature'),
  ), false);
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

test('model edit plans require every exact short reference once in array order', () => {
  const references = createModelAssetReferenceMap(['real_asset_a', 'real_asset_b']);
  const valid = validateModelEditPlanCandidate({
    clips: [
      {clipRef: 'clip_002', order: 1, reason: '先展示结果'},
      {clipRef: 'clip_001', order: 2, reason: '再展示过程'},
    ],
    overallReason: '完整使用全部片段',
  }, references);
  assert.deepEqual(valid.clips.map((clip) => clip.clipRef), ['clip_002', 'clip_001']);

  const invalidCases: Array<[unknown, RegExp]> = [
    [{clips: [{clipRef: 'clip_001', order: 1, reason: '遗漏'}], overallReason: '错误'}, /missing clipRef: clip_002/],
    [{clips: [{clipRef: 'clip_001', order: 1, reason: '重复'}, {clipRef: 'clip_001', order: 2, reason: '重复'}], overallReason: '错误'}, /duplicate clipRef: clip_001/],
    [{clips: [{clipRef: 'clip_001', order: 1, reason: '正常'}, {clipRef: 'clip_999', order: 2, reason: '未知'}], overallReason: '错误'}, /unexpected clipRef: clip_999/],
    [{clips: [{clipRef: 'clip_001', order: 1, reason: '正常'}, {clipRef: 'clip_00１', order: 2, reason: 'Unicode 混入'}], overallReason: '错误'}, /unexpected clipRef: clip_00１/],
    [{clips: [{clipRef: 'clip_001', order: 2, reason: '顺序错误'}, {clipRef: 'clip_002', order: 1, reason: '顺序错误'}], overallReason: '错误'}, /invalid order for clipRef clip_001/],
  ];
  for (const [candidate, message] of invalidCases) {
    assert.throws(() => validateModelEditPlanCandidate(candidate, references), message);
  }
});

test('local planning preserves the uploaded asset order without position guesses', async () => {
  const provider = new AutoVideoAiProvider();
  const plan = await provider.plan({
    projectId: project.id,
    analyses: ['asset_a', 'asset_b'].map((assetId) => ({
      assetId, marketingRole: 'transition' as const, visualSummary: `${assetId} 的画面`, combinedSummary: `${assetId} 的综合说明`, topics: ['洗车'], people: [], scenes: ['洗车店'], screenTexts: [], chronologicalHints: [], duplicateWithAssetIds: [], confidence: 0.8,
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

test('historical generations remain readable without roleReason and strip retired visual fields', () => {
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
    database.prepare('UPDATE auto_video_asset_checkpoints SET payload_json = ? WHERE generation_id = ? AND asset_id = ?').run(JSON.stringify({...checkpoint, visualAnalysis: {...checkpoint.visualAnalysis, value: {...checkpoint.visualAnalysis.value!, marketingRole: 'process', suggestedPosition: 'middle'}}}), generation.generationId, checkpoint.assetId);
    database.close();

    const reopened = new SqliteStore(databasePath, 'test-secret');
    try {
      assert.equal(reopened.getAutoVideoGeneration(generation.generationId, project.tenantId)?.assetAnalyses[0]?.assetId, 'asset_a');
      const reopenedVisual = reopened.getAutoVideoAssetCheckpoint(generation.generationId, 'asset_a', project.tenantId)?.visualAnalysis.value ?? {};
      assert.equal('suggestedPosition' in reopenedVisual, false);
      assert.equal('marketingRole' in reopenedVisual, false);
    } finally {
      reopened.close();
    }
  } finally {
    try { store.close(); } catch { /* already closed for the compatibility read */ }
    rmSync(directory, {recursive: true, force: true});
  }
});

test('auto-video retries use bounded request bursts followed by indefinitely capped service probes', () => {
  assert.equal(AUTO_VIDEO_RETRY_DELAY_MS, 5_000);
  assert.deepEqual(AUTO_VIDEO_RETRY_DELAYS_MS, [5_000, 15_000, 30_000]);
  assert.equal(AUTO_VIDEO_MAX_RETRIES_PER_KEY, 3);
  assert.deepEqual(AUTO_VIDEO_RECOVERY_PROBE_DELAYS_MS, [60_000, 300_000, 900_000]);
  assert.equal(autoVideoRecoveryProbeDelay(0), 60_000);
  assert.equal(autoVideoRecoveryProbeDelay(1), 300_000);
  assert.equal(autoVideoRecoveryProbeDelay(2), 900_000);
  assert.equal(autoVideoRecoveryProbeDelay(10_000), 900_000);
});

test('a worker failure outside the generation error path is contained and persisted without an unhandled rejection', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'washcut-auto-video-worker-containment-'));
  const store = new SqliteStore(path.join(directory, 'washcut.sqlite'), 'test-secret');
  const generationId = 'generation_worker_containment_test';
  const originalGet = store.getAutoVideoGeneration.bind(store);
  const originalConsoleError = console.error;
  const logged: string[] = [];
  let throwOnNextRead = true;
  let unhandled: unknown;
  const onUnhandled = (error: unknown) => { unhandled = error; };
  try {
    store.saveAutoVideoProject(project);
    store.createAutoVideoGeneration(autoVideoGenerationSchema.parse({
      generationId, projectId: project.id, tenantId: project.tenantId, ownerId: project.ownerId, versionNumber: 1,
      status: 'queued', progress: 0, aiMode: {kind: 'local', reason: 'user_selected_local'}, instructionSnapshot: '', canvas: project.canvas, assetIds: ['asset_a'],
      steps: makeInitialProcessingSteps(), transcripts: [], screenshotAnalyses: [], assetAnalyses: [], artifactStorage: 'generation', createdAt: now, updatedAt: now,
    }));
    store.getAutoVideoGeneration = ((...args: Parameters<SqliteStore['getAutoVideoGeneration']>) => {
      if (throwOnNextRead) {
        throwOnNextRead = false;
        const error = new Error('checkpoint_concurrent_update') as Error & {code: string; retryable: boolean};
        error.code = 'checkpoint_concurrent_update';
        error.retryable = false;
        throw error;
      }
      return originalGet(...args);
    }) as SqliteStore['getAutoVideoGeneration'];
    console.error = (...values: unknown[]) => { logged.push(values.map(String).join(' ')); };
    process.once('unhandledRejection', onUnhandled);

    new AutoVideoWorker(store).enqueue(generationId);
    for (let attempt = 0; attempt < 40 && originalGet(generationId)?.status !== 'needs_attention'; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    const failed = originalGet(generationId);
    assert.equal(unhandled, undefined);
    assert.equal(failed?.status, 'needs_attention');
    assert.equal(failed?.error?.code, 'checkpoint_concurrent_update');
    assert.equal(failed?.error?.message, 'checkpoint_concurrent_update');
    assert.equal(failed?.error?.retryable, false);
    assert.ok(logged.some((entry) => entry.includes('auto_video.worker_unhandled')));
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
    console.error = originalConsoleError;
    store.close();
    rmSync(directory, {recursive: true, force: true});
  }
});

test('cancelled semaphore waiters never start a new request', async () => {
  const semaphore = new AbortableSemaphore(1);
  const activeController = new AbortController();
  const queuedController = new AbortController();
  let releaseActive!: () => void;
  let queuedStarted = false;
  const active = semaphore.use(activeController.signal, () => new Promise<void>((resolve) => {
    releaseActive = resolve;
  }));
  const queued = semaphore.use(queuedController.signal, async () => {
    queuedStarted = true;
  });
  queuedController.abort();
  await assert.rejects(queued, /cancelled/);
  releaseActive();
  await active;
  assert.equal(queuedStarted, false);
});

test('visual concurrency can reach the selected peak of 30', async () => {
  let active = 0;
  let peak = 0;
  const releases: Array<() => void> = [];
  const running = mapWithConcurrency(Array.from({length: 30}, (_, index) => index), 30, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => releases.push(resolve));
    active -= 1;
  });
  while (releases.length < 30) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(peak, 30);
  releases.splice(0).forEach((release) => release());
  await running;
});

test('one process-wide model semaphore caps concurrent work across generations', async () => {
  const semaphore = new AbortableSemaphore(4);
  const controller = new AbortController();
  let active = 0;
  let peak = 0;
  const runGeneration = (prefix: string) => mapWithConcurrency(
    Array.from({length: 12}, (_, index) => `${prefix}_${index}`),
    12,
    async () => semaphore.use(controller.signal, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 4));
      active -= 1;
    }),
  );
  await Promise.all([runGeneration('generation_a'), runGeneration('generation_b')]);
  assert.equal(peak, 4);
});

test('process concurrency environment values are strict integers from 1 to 30', () => {
  assert.equal(parseAutoVideoConcurrencyLimit(undefined, 'TEST_LIMIT'), 30);
  assert.equal(parseAutoVideoConcurrencyLimit('1', 'TEST_LIMIT'), 1);
  assert.equal(parseAutoVideoConcurrencyLimit('30', 'TEST_LIMIT'), 30);
  for (const invalid of ['0', '31', '1.5', 'NaN', '  ']) {
    if (invalid.trim() === '') {
      assert.equal(parseAutoVideoConcurrencyLimit(invalid, 'TEST_LIMIT'), 30);
    } else {
      assert.throws(() => parseAutoVideoConcurrencyLimit(invalid, 'TEST_LIMIT'), /integer between 1 and 30/);
    }
  }
});

test('a failed concurrent branch aborts siblings before queued assets can start', async () => {
  const controller = new AbortController();
  let secondStarted = false;
  let thirdStarted = false;
  await assert.rejects(
    mapWithConcurrency([1, 2, 3], 2, async (item) => {
      if (item === 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        throw new Error('first_branch_failed');
      }
      if (item === 2) {
        secondStarted = true;
        await new Promise<void>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(new Error('sibling_aborted')), {once: true}));
        return item;
      }
      thirdStarted = true;
      return item;
    }, () => controller.abort()),
    /first_branch_failed/,
  );
  assert.equal(secondStarted, true);
  assert.equal(thirdStarted, false);
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

test('batch role assignment makes one whole-project call with narration-first instructions', async () => {
  let requestBody: Record<string, unknown> | undefined;
  let requestCount = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requestCount += 1;
      requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      const result = {
        clips: [
          {clipRef: 'clip_002', marketingRole: 'cta', roleReason: '口播引导点击导航到店；擦玻璃画面可作为洗车 B-roll。'},
          {clipRef: 'clip_001', marketingRole: 'hook', roleReason: '提问式口播吸引车主注意；冲洗画面不改变开场作用。'},
        ],
      };
      response.writeHead(200, {'content-type': 'text/event-stream'});
      response.end(`data: ${JSON.stringify({type: 'response.output_text.delta', delta: JSON.stringify(result)})}\n\ndata: ${JSON.stringify({type: 'response.completed'})}\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('mock_server_address_invalid');
    const provider = new AutoVideoAiProvider(new RelayClient({baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'test-key', model: 'role-test'}));
    const result = await provider.assignMarketingRolesBatch(batchRoleInput());
    assert.equal(requestCount, 1);
    assert.deepEqual(result.assets.map((item) => [item.assetId, item.marketingRole]), [['asset_b', 'cta'], ['asset_a', 'hook']]);
    assert.match(String(requestBody?.instructions ?? ''), /有效口播的营销意图优先/);
    assert.match(String(requestBody?.instructions ?? ''), /B-roll/);
    const format = (requestBody?.text as {format?: {name?: string}} | undefined)?.format;
    assert.equal(format?.name, 'auto-video-marketing-role-batch-result-v2');
    const requestInput = requestBody?.input as Array<{content: Array<{type: string; text?: string}>}>;
    const structured = JSON.parse(requestInput[0]?.content[0]?.text ?? '{}') as Record<string, unknown>;
    assert.equal(structured.schema, 'auto-video-marketing-role-batch-input.v2');
    assert.deepEqual((structured.clips as Array<{clipRef: string}>).map((item) => item.clipRef), ['clip_001', 'clip_002']);
    assert.doesNotMatch(JSON.stringify(structured), new RegExp(`${project.id}|asset_a|asset_b|projectId|assetId|originalPath|temporaryAudioPath|\\.mp4|file:\\/\\/`, 'i'));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('batch role assignment repair receives the previous concrete validation error', async () => {
  const requestInputs: unknown[] = [];
  let requestCount = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requestCount += 1;
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {input: Array<{content: Array<{text?: string}>}>};
      requestInputs.push(JSON.parse(body.input[0]?.content[0]?.text ?? '{}'));
      const result = requestCount === 1
        ? {clips: [{clipRef: 'clip_001', marketingRole: 'hook', roleReason: '提问开场'}]}
        : {clips: [{clipRef: 'clip_001', marketingRole: 'hook', roleReason: '提问开场'}, {clipRef: 'clip_002', marketingRole: 'cta', roleReason: '引导到店'}]};
      response.writeHead(200, {'content-type': 'text/event-stream'});
      response.end(`data: ${JSON.stringify({type: 'response.output_text.delta', delta: JSON.stringify(result)})}\n\ndata: ${JSON.stringify({type: 'response.completed'})}\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('mock_server_address_invalid');
    const provider = new AutoVideoAiProvider(new RelayClient({baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'test-key', model: 'role-test'}));
    const result = await provider.assignMarketingRolesBatch(batchRoleInput());
    assert.equal(requestCount, 2);
    assert.equal(result.assets.length, 2);
    const repair = requestInputs[1] as {schema?: string; validationErrors?: string};
    assert.equal(repair.schema, 'auto-video-marketing-role-batch-repair.v2');
    assert.match(repair.validationErrors ?? '', /missing clipRef: clip_002/);
    assert.doesNotMatch(JSON.stringify(repair), new RegExp(`${project.id}|asset_a|asset_b|projectId|assetId`, 'i'));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('batch role assignment stops after three invalid model responses', async () => {
  let requestCount = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      requestCount += 1;
      const result = {clips: [{clipRef: 'clip_001', marketingRole: 'hook', roleReason: '提问开场'}]};
      response.writeHead(200, {'content-type': 'text/event-stream'});
      response.end(`data: ${JSON.stringify({type: 'response.output_text.delta', delta: JSON.stringify(result)})}\n\ndata: ${JSON.stringify({type: 'response.completed'})}\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('mock_server_address_invalid');
    const provider = new AutoVideoAiProvider(new RelayClient({baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'test-key', model: 'role-test'}));
    await assert.rejects(provider.assignMarketingRolesBatch(batchRoleInput()), (error: unknown) => {
      assert.equal((error as {code?: string}).code, 'MARKETING_ROLE_ASSIGNMENT_INVALID');
      assert.match((error as Error).message, /missing clipRef: clip_002/);
      return true;
    });
    assert.equal(requestCount, 3);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('connected planning receives final role reasons and uses narration-first ordering rules', async () => {
  let requestBody: Record<string, unknown> | undefined;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      const result = {
        clips: [{clipRef: 'clip_001', order: 1, reason: '提问口播先吸引注意，冲洗画面建立洗车场景。'}, {clipRef: 'clip_002', order: 2, reason: '到店口播收束行动，擦玻璃画面延续服务氛围。'}],
        overallReason: '按口播叙事从吸引注意到行动引导。',
      };
      response.writeHead(200, {'content-type': 'text/event-stream'});
      response.end(`data: ${JSON.stringify({type: 'response.output_text.delta', delta: JSON.stringify(result)})}\n\ndata: ${JSON.stringify({type: 'response.completed'})}\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('mock_server_address_invalid');
    const provider = new AutoVideoAiProvider(new RelayClient({baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'test-key', model: 'planning-test'}));
    const analyses = [
      {assetId: 'asset_a', marketingRole: 'hook' as const, roleReason: '提问口播吸引注意', audioSummary: '你的车多久没洗了？'},
      {assetId: 'asset_b', marketingRole: 'cta' as const, roleReason: '口播引导点击导航', audioSummary: '点击导航到店体验'},
    ].map((item) => assetAnalysisSchema.parse({...item, visualSummary: '普通洗车画面', combinedSummary: '口播与普通洗车画面', topics: [], people: [], scenes: [], screenTexts: [], chronologicalHints: [], duplicateWithAssetIds: [], confidence: 0.9}));
    const plan = await provider.plan({projectId: project.id, analyses, assetDurations: [{assetId: 'asset_a', durationMs: 1_000}, {assetId: 'asset_b', durationMs: 1_500}], canvas: project.canvas});
    assert.deepEqual(plan.clips.map((clip) => clip.assetId), ['asset_a', 'asset_b']);
    assert.equal(plan.projectId, project.id);
    assert.deepEqual(plan.excludedAssets, []);
    assert.match(String(requestBody?.instructions ?? ''), /marketingRole 和 roleReason/);
    assert.match(String(requestBody?.instructions ?? ''), /普通音画动作不完全一致可作为 B-roll/);
    assert.doesNotMatch(String(requestBody?.instructions ?? ''), /冲突，以画面行为为准|转写不得推翻画面行为/);
    const requestInput = requestBody?.input as Array<{content: Array<{text?: string}>}>;
    const structured = JSON.parse(requestInput[0]?.content[0]?.text ?? '{}') as {schema?: string; clips?: Array<{clipRef?: string; roleReason?: string}>};
    assert.equal(structured.schema, 'auto-video-edit-plan-input.v2');
    assert.equal(structured.clips?.[0]?.clipRef, 'clip_001');
    assert.equal(structured.clips?.[0]?.roleReason, '提问口播吸引注意');
    assert.doesNotMatch(JSON.stringify(structured), new RegExp(`${project.id}|asset_a|asset_b|projectId|assetId`, 'i'));
    const format = (requestBody?.text as {format?: {name?: string}} | undefined)?.format;
    assert.equal(format?.name, 'auto-video-edit-plan-result-v2');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('planning repair reuses one short-reference map and carries the concrete validation error', async () => {
  const requestInputs: unknown[] = [];
  let requestCount = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requestCount += 1;
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {input: Array<{content: Array<{text?: string}>}>};
      requestInputs.push(JSON.parse(body.input[0]?.content[0]?.text ?? '{}'));
      const result = requestCount === 1
        ? {clips: [{clipRef: 'clip_001', order: 1, reason: '遗漏一段'}], overallReason: '不完整'}
        : {clips: [{clipRef: 'clip_002', order: 1, reason: '先展示结果'}, {clipRef: 'clip_001', order: 2, reason: '再说明过程'}], overallReason: '完整编排'};
      response.writeHead(200, {'content-type': 'text/event-stream'});
      response.end(`data: ${JSON.stringify({type: 'response.output_text.delta', delta: JSON.stringify(result)})}\n\ndata: ${JSON.stringify({type: 'response.completed'})}\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('mock_server_address_invalid');
    const provider = new AutoVideoAiProvider(new RelayClient({baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'test-key', model: 'planning-test'}));
    const analyses = ['asset_a', 'asset_b'].map((assetId) => assetAnalysisSchema.parse({
      assetId, marketingRole: 'process', roleReason: '洗车过程', visualSummary: '洗车画面', combinedSummary: '洗车过程', topics: [], people: [], scenes: [], screenTexts: [], chronologicalHints: [], duplicateWithAssetIds: [], confidence: 0.9,
    }));
    const plan = await provider.plan({projectId: project.id, analyses, assetDurations: [{assetId: 'asset_a', durationMs: 1_000}, {assetId: 'asset_b', durationMs: 1_500}], canvas: project.canvas});
    assert.equal(requestCount, 2);
    assert.deepEqual(plan.clips.map((clip) => clip.assetId), ['asset_b', 'asset_a']);
    const initial = requestInputs[0] as {clips: Array<{clipRef: string}>};
    const repair = requestInputs[1] as {schema: string; originalInput: {clips: Array<{clipRef: string}>}; validationErrors: string};
    assert.deepEqual(initial.clips.map((clip) => clip.clipRef), ['clip_001', 'clip_002']);
    assert.deepEqual(repair.originalInput.clips.map((clip) => clip.clipRef), ['clip_001', 'clip_002']);
    assert.match(repair.validationErrors, /missing clipRef: clip_002/);
    assert.doesNotMatch(JSON.stringify(requestInputs), new RegExp(`${project.id}|asset_a|asset_b|projectId|assetId`, 'i'));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('planning throws the last concrete validation error after three invalid responses', async () => {
  let requestCount = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      requestCount += 1;
      const result = {clips: [{clipRef: 'clip_001', order: 1, reason: '遗漏'}], overallReason: '不完整'};
      response.writeHead(200, {'content-type': 'text/event-stream'});
      response.end(`data: ${JSON.stringify({type: 'response.output_text.delta', delta: JSON.stringify(result)})}\n\ndata: ${JSON.stringify({type: 'response.completed'})}\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('mock_server_address_invalid');
    const provider = new AutoVideoAiProvider(new RelayClient({baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'test-key', model: 'planning-test'}));
    const analyses = ['asset_a', 'asset_b'].map((assetId) => assetAnalysisSchema.parse({
      assetId, marketingRole: 'process', roleReason: '洗车过程', visualSummary: '洗车画面', combinedSummary: '洗车过程', topics: [], people: [], scenes: [], screenTexts: [], chronologicalHints: [], duplicateWithAssetIds: [], confidence: 0.9,
    }));
    await assert.rejects(
      provider.plan({projectId: project.id, analyses, assetDurations: [{assetId: 'asset_a', durationMs: 1_000}, {assetId: 'asset_b', durationMs: 1_500}], canvas: project.canvas}),
      (error: unknown) => {
        assert.equal((error as {code?: string}).code, 'EDIT_PLAN_INVALID');
        assert.equal((error as {retryable?: boolean}).retryable, false);
        assert.match((error as Error).message, /missing clipRef: clip_002/);
        return true;
      },
    );
    assert.equal(requestCount, 3);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('planning preserves upstream 429 errors instead of converting them to edit validation errors', async () => {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(429, {'content-type': 'text/plain', 'retry-after': '1'});
      response.end('rate limited');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('mock_server_address_invalid');
    const provider = new AutoVideoAiProvider(new RelayClient({baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'test-key', model: 'planning-test', retryAttempts: 1}));
    const analysis = assetAnalysisSchema.parse({assetId: 'asset_a', marketingRole: 'hook', roleReason: '开场', visualSummary: '洗车画面', combinedSummary: '开场', topics: [], people: [], scenes: [], screenTexts: [], chronologicalHints: [], duplicateWithAssetIds: [], confidence: 0.9});
    await assert.rejects(
      provider.plan({projectId: project.id, analyses: [analysis], assetDurations: [{assetId: 'asset_a', durationMs: 1_000}], canvas: project.canvas}),
      (error: unknown) => {
        assert.equal((error as {code?: string}).code, 'relay_http_429');
        assert.match((error as Error).message, /HTTP 429/);
        return true;
      },
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
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
        visualSummary: '门店内讲解洗车服务', people: ['服务人员'], objects: ['产品货架'], actions: ['面对镜头讲解'], scenes: ['洗车门店'], screenTexts: [], chronologicalHints: ['A 到 C 持续讲解'], confidence: 0.9, needsDetail: false,
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
    assert.equal('marketingRole' in result.analysis, false);
    assert.equal(requestCount, 1);
    assert.equal((requestBody?.text as {format?: unknown} | undefined)?.format, undefined);
    assert.match(String(requestBody?.instructions ?? ''), /视频素材客观画面理解模块/);
    assert.doesNotMatch(String(requestBody?.instructions ?? ''), /验证中转站连接/);
    const requestInput = requestBody?.input as Array<{role: string; content: Array<{type: string; text?: string; image_url?: string}>}>;
    assert.deepEqual(requestInput[0]?.content.map((item) => item.type), ['input_text', 'input_image']);
    assert.match(requestInput[0]?.content[0]?.text ?? '', /视频素材客观画面理解模块/);
    assert.match(requestInput[0]?.content[0]?.text ?? '', /画面中可见的人、物与动作是唯一的内容判断依据/);
    assert.match(requestInput[0]?.content[0]?.text ?? '', /不得返回素材 ID、项目 ID、marketingRole/);
    assert.doesNotMatch(requestInput[0]?.content[0]?.text ?? '', /字幕说这是洗后效果/);
    assert.doesNotMatch(requestInput[0]?.content[0]?.text ?? '', /asset_a|assetId|projectId/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('single-asset understanding sends no real identity and hydrates the authoritative asset ID', async () => {
  let requestBody: Record<string, unknown> | undefined;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      const result = {
        audioSummary: '点击导航到店体验',
        visualSummary: '工作人员擦拭汽车玻璃',
        combinedSummary: '口播引导到店，画面为玻璃清洁',
        topics: ['到店', '玻璃清洁'], people: ['工作人员'], scenes: ['洗车工位'], screenTexts: [], chronologicalHints: [], confidence: 0.9,
      };
      response.writeHead(200, {'content-type': 'text/event-stream'});
      response.end(`data: ${JSON.stringify({type: 'response.output_text.delta', delta: JSON.stringify(result)})}\n\ndata: ${JSON.stringify({type: 'response.completed'})}\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('mock_server_address_invalid');
    const provider = new AutoVideoAiProvider(new RelayClient({baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'test-key', model: 'understanding-test'}));
    const result = await provider.understandAsset({
      assetId: 'asset_authoritative_long_id',
      metadata: {...asset('asset_a', 1_000).metadata!, assetId: 'asset_authoritative_long_id'},
      transcript: qwenTranscript({assetId: 'asset_authoritative_long_id', durationMs: 1_000, text: '点击导航到店体验'}),
      screenshots: [{screenshotId: 'shot_real_id', assetId: 'asset_authoritative_long_id', timestampMs: 500, description: '擦拭玻璃', people: ['工作人员'], objects: ['玻璃'], actions: ['擦拭'], scene: '洗车工位', ocrText: [], qualityIssues: []}],
    });
    assert.equal(result.assetId, 'asset_authoritative_long_id');
    assert.deepEqual(result.duplicateWithAssetIds, []);
    const requestInput = requestBody?.input as Array<{content: Array<{text?: string}>}>;
    const structuredText = requestInput[0]?.content[0]?.text ?? '';
    assert.doesNotMatch(structuredText, /asset_authoritative_long_id|shot_real_id|assetId|screenshotId|projectId/);
    const format = (requestBody?.text as {format?: {name?: string}} | undefined)?.format;
    assert.equal(format?.name, 'auto-video-asset-understanding-content-v2');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
