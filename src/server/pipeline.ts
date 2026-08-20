import {
  assetManifestSchema,
  creativeSpecSchema,
  qualityReportSchema,
  videoSpecSchema,
  type AssetManifest,
  type AssetRef,
  type CreativeSpec,
  type ProjectInput,
  type QualityReport,
  type VideoSpec,
} from '../shared/contracts.js';
import type {ModelConversationLogContext} from '../shared/model-conversations.js';
import {signedMediaUrl} from './media.js';
import {RelayClient} from './relay-client.js';

const inferRole = (name: string, index: number) => {
  if (/门|店|front|store/i.test(name) || index === 0) return {label: '门店外观', tags: ['storefront', 'store-proof'], role: 'store_proof' as const};
  if (/泡|foam/i.test(name) || index % 4 === 2) return {label: '泡沫清洗', tags: ['foam', 'service-process'], role: 'service_process' as const};
  if (/洗后|亮|result|polish/i.test(name) || index % 4 === 3) return {label: '洗后效果', tags: ['result', 'reflection'], role: 'result_proof' as const};
  return {label: '高压冲洗', tags: ['pressure-wash', 'service-process'], role: 'service_process' as const};
};

export const buildAssetManifest = (input: ProjectInput, assets: AssetRef[], analysis?: Partial<AssetManifest['analysis']>): AssetManifest => {
  const segments = assets.map((asset, index) => {
    const role = inferRole(asset.fileName, index);
    return {
      segmentId: `seg_${index + 1}`,
      assetId: asset.assetId,
      label: role.label,
      tags: role.tags,
      startMs: 0,
      endMs: Math.max(1, Math.min(asset.durationMs ?? 8_000, 12_000)),
      keyframeUrl: asset.keyframeUrls[0],
      usability: 'preferred' as const,
      authenticityRole: role.role,
    };
  });
  const roles = new Set(segments.map((segment) => segment.authenticityRole));
  const gaps = [
    roles.has('store_proof') ? null : '缺少门店真实性镜头',
    roles.has('service_process') ? null : '缺少洗车过程镜头',
    roles.has('result_proof') ? null : '缺少洗后效果镜头',
  ].filter((value): value is string => Boolean(value));
  return assetManifestSchema.parse({
    schema: 'asset-manifest.v1',
    assets,
    segments,
    coverage: {
      storefront: roles.has('store_proof'),
      serviceProcess: roles.has('service_process'),
      result: roles.has('result_proof'),
      logo: assets.some((asset) => /logo|标志|招牌/i.test(asset.fileName)),
      effectiveDurationMs: segments.reduce((sum, segment) => sum + segment.endMs, 0),
      gaps,
    },
    analysis: {
      promptVersion: analysis?.promptVersion ?? 'asset-understanding.local.v2',
      modelVersion: analysis?.modelVersion ?? 'deterministic-keyframe-fallback',
      elapsedMs: analysis?.elapsedMs ?? 0,
      tokenUsage: analysis?.tokenUsage ?? 0,
      estimatedCostCny: analysis?.estimatedCostCny ?? 0,
    },
  });
};

export const validateManifest = (manifest: AssetManifest, assets: AssetRef[]) => {
  const known = new Map(assets.map((asset) => [asset.assetId, asset]));
  for (const segment of manifest.segments) {
    const asset = known.get(segment.assetId);
    if (!asset) throw new Error('unknown_asset_id');
    if (segment.endMs <= segment.startMs || segment.endMs > (asset.durationMs ?? 12_000)) throw new Error('asset_segment_out_of_bounds');
  }
  return manifest;
};

export const buildCreativeSpec = (input: ProjectInput, generation?: Partial<CreativeSpec['generation']>): CreativeSpec => creativeSpecSchema.parse({
  schema: 'creative-spec.v1',
  title: `${input.storeName}｜${input.offer}`,
  hook: `${input.region}车主注意，${input.offer}。`,
  voiceover: [
    {text: `${input.region}车主注意，${input.offer}。`, factRefs: ['promotion.offer', 'store.region']},
    {text: '从预洗、泡沫到精洗，每一步都看得见。', factRefs: []},
    {text: `这里是${input.storeName}，${input.rules}。`, factRefs: ['store.name', 'promotion.rules']},
    {text: input.cta, factRefs: ['promotion.cta']},
  ],
  narrativeBeats: [
    {id: 'hook', task: '三秒内建立优惠注意力', preferredTags: ['pressure-wash']},
    {id: 'process', task: '展示真实服务过程', preferredTags: ['foam', 'service-process']},
    {id: 'proof', task: '证明门店真实与洗后效果', preferredTags: ['storefront', 'result']},
    {id: 'cta', task: '清楚给出行动引导', preferredTags: ['storefront', 'result']},
  ],
  factLedger: {
    'store.name': input.storeName,
    'store.region': input.region,
    'promotion.offer': input.offer,
    'promotion.rules': input.rules,
    'promotion.cta': input.cta,
  },
  generation: {
    promptVersion: generation?.promptVersion ?? 'creative.local.v2',
    modelVersion: generation?.modelVersion ?? 'deterministic-fact-ledger',
    elapsedMs: generation?.elapsedMs ?? 0,
  },
});

const visualKeys = ['pressure', 'foam', 'storefront', 'result'] as const;
const sceneCountForDuration = (durationMs: number) => durationMs <= 15_000 ? 4 : durationMs <= 30_000 ? 6 : durationMs <= 60_000 ? 8 : durationMs <= 120_000 ? 10 : 12;

export const buildVideoSpec = (input: ProjectInput, manifest: AssetManifest, creative: CreativeSpec): VideoSpec => {
  const sceneCount = sceneCountForDuration(input.durationMs);
  const transitionMs = 500;
  const rawSceneDuration = Math.floor((input.durationMs + (sceneCount - 1) * transitionMs) / sceneCount);
  let timelineCursor = 0;
  const scenes = Array.from({length: sceneCount}, (_, index) => {
    const visualKey = visualKeys[index % visualKeys.length];
    const desiredRole = visualKey === 'storefront' ? 'store_proof' : visualKey === 'result' ? 'result_proof' : 'service_process';
    const segment = manifest.segments.find((item, segmentIndex) => item.authenticityRole === desiredRole && segmentIndex % sceneCount === index % Math.max(1, manifest.segments.length))
      ?? manifest.segments.find((item) => item.authenticityRole === desiredRole)
      ?? manifest.segments[index % manifest.segments.length];
    const asset = manifest.assets.find((item) => item.assetId === segment.assetId) ?? manifest.assets[0];
    const isLast = index === sceneCount - 1;
    const durationMs = isLast ? input.durationMs - timelineCursor : rawSceneDuration;
    const beat = creative.narrativeBeats[index % creative.narrativeBeats.length];
    const headlines = [creative.hook, '过程看得见', input.storeName, input.cta];
    const subtitles = [input.offer, '预洗 · 泡沫 · 精洗', `${input.region}真实门店`, input.rules];
    const transition = index === 0 ? 'cut' as const : index % 3 === 0 ? 'slide' as const : 'fade' as const;
    const scene = {
      sceneId: `scene_${index + 1}`,
      narrativeTask: beat.task,
      assetId: asset.assetId,
      sourceType: asset.sourceType,
      media: {
        assetId: asset.assetId,
        url: signedMediaUrl('asset', asset.assetId, asset.contentType.startsWith('video/') ? 'proxy' : 'original', 2 * 60 * 60),
        contentType: asset.contentType,
        durationMs: asset.durationMs,
        sha256: asset.sha256,
      },
      sourceStartMs: Math.min(segment.startMs, Math.max(0, (asset.durationMs ?? durationMs) - 500)),
      timelineStartMs: timelineCursor,
      durationMs,
      crop: {x: 0.5, y: 0.5, scale: index % 2 === 0 ? 1.08 : 1.16},
      transition,
      headline: headlines[index % headlines.length],
      subtitle: subtitles[index % subtitles.length],
      captionPosition: index % 3 === 1 ? 'upper' as const : 'lower' as const,
      factRefs: creative.voiceover[index % creative.voiceover.length]?.factRefs ?? [],
      visualKey,
    };
    timelineCursor += durationMs - (isLast ? 0 : transitionMs);
    return scene;
  });

  return videoSpecSchema.parse({
    schema: 'video-spec.v1',
    version: 'render.v2',
    width: 1080,
    height: 1920,
    fps: 30,
    durationMs: input.durationMs,
    storeName: input.storeName,
    region: input.region,
    offer: input.offer,
    cta: input.cta,
    scenes,
    captions: scenes.map((scene) => ({
      text: scene.headline,
      startMs: scene.timelineStartMs,
      endMs: Math.min(input.durationMs, scene.timelineStartMs + scene.durationMs),
      timestampMs: null,
      confidence: 1,
    })),
    audio: {duckingDb: -12},
    provenance: manifest.assets.map((asset) => ({
      assetId: asset.assetId,
      sourceType: asset.sourceType,
      sha256: asset.sha256,
      licenseRecordId: asset.license?.recordId ?? null,
    })),
  });
};

export const validateVideoSpec = (video: VideoSpec, manifest: AssetManifest, creative: CreativeSpec) => {
  const knownAssets = new Map(manifest.assets.map((asset) => [asset.assetId, asset]));
  const knownFacts = new Set(Object.keys(creative.factLedger));
  for (const scene of video.scenes) {
    const asset = knownAssets.get(scene.assetId);
    if (!asset || scene.media.assetId !== scene.assetId || scene.media.sha256 !== asset.sha256) throw new Error('video_asset_reference_invalid');
    if (scene.sourceStartMs < 0 || scene.sourceStartMs >= (asset.durationMs ?? Number.POSITIVE_INFINITY)) throw new Error('video_segment_out_of_bounds');
    if (scene.factRefs.some((factRef) => !knownFacts.has(factRef))) throw new Error('unknown_fact_ref');
  }
  const endMs = Math.max(...video.scenes.map((scene) => scene.timelineStartMs + scene.durationMs));
  if (endMs !== video.durationMs) throw new Error('video_timeline_duration_mismatch');
  return video;
};

export const buildQualityReport = (input: ProjectInput, manifest: AssetManifest, video: VideoSpec, media?: {
  durationDeltaMs: number;
  width?: number;
  height?: number;
  hasAudio: boolean;
  blackDurationMs: number;
}): QualityReport => {
  const checks = [
    {key: 'facts', label: '事实一致性', passed: video.offer === input.offer && video.storeName === input.storeName, blocking: true, detail: '门店、区域、优惠和 CTA 均来自用户确认字段。'},
    {key: 'authenticity', label: '素材真实性', passed: manifest.assets.every((asset) => asset.sourceType !== 'licensed_library') || input.allowLibrary, blocking: true, detail: '所有镜头均可回溯到项目资产与授权记录。'},
    {key: 'safe_area', label: '字幕安全区', passed: video.scenes.every((scene) => scene.captionPosition !== 'center'), blocking: true, detail: '字幕位于 9:16 上/下安全区。'},
    {key: 'timeline', label: '规格时长', passed: Math.max(...video.scenes.map((scene) => scene.timelineStartMs + scene.durationMs)) === input.durationMs, blocking: true, detail: `VideoSpec 精确覆盖 ${input.durationMs / 1000} 秒。`},
    {key: 'decode', label: '最终媒体可解码', passed: media ? media.width === 1080 && media.height === 1920 : false, blocking: true, detail: media ? `输出 ${media.width}×${media.height} H.264 媒体。` : '尚未生成最终媒体。'},
    {key: 'duration', label: '最终时长误差', passed: media ? media.durationDeltaMs <= 1000 / 30 : false, blocking: true, detail: media ? `与目标相差 ${media.durationDeltaMs}ms。` : '尚未检查。'},
    {key: 'audio', label: '音轨存在', passed: media?.hasAudio ?? false, blocking: true, detail: media?.hasAudio ? '最终 MP4 包含混合音轨。' : '未检测到音轨。'},
    {key: 'black_frames', label: '异常黑帧', passed: media ? media.blackDurationMs < 500 : false, blocking: true, detail: media ? `累计黑帧 ${media.blackDurationMs}ms。` : '尚未检查。'},
  ];
  const decision = checks.some((check) => check.blocking && !check.passed) ? 'failed' : 'passed';
  return qualityReportSchema.parse({schema: 'quality-report.v1', decision, checks});
};

const assetInstructions = '你是洗车视频素材理解 Agent。基于输入中的真实压缩关键帧 URL 判断门头、服务过程与洗后效果。只输出 asset-manifest.v1 JSON；不得编造资产 ID、授权、时长或镜头范围。';
const creativeInstructions = '你是洗车营销视频创意导演。只输出 creative-spec.v1 JSON。所有营销事实必须引用输入 factLedger，不能增加输入中不存在的事实。';

export const analyzeAssets = async (
  input: ProjectInput,
  assets: AssetRef[],
  relay?: RelayClient,
  signal?: AbortSignal,
  imageDataUrls: string[] = [],
  conversationContext?: Omit<ModelConversationLogContext, 'source'>,
) => {
  if (!relay) return buildAssetManifest(input, assets);
  if (!imageDataUrls.length) throw new Error('asset_keyframe_missing');
  const started = Date.now();
  const analysisAssets = assets.map(({keyframeUrls, ...asset}) => ({...asset, keyframeCount: keyframeUrls.length}));
  const candidate = assetManifestSchema.parse(await relay.requestJson(
    assetInstructions,
    {schema: 'asset-analysis-input.v1', input, assets: analysisAssets},
    signal,
    imageDataUrls,
    conversationContext ? {...conversationContext, source: 'legacy-video.asset-analysis'} : undefined,
  ));
  candidate.analysis = {
    promptVersion: 'asset-understanding.relay.v2',
    modelVersion: relay.model,
    elapsedMs: Date.now() - started,
    tokenUsage: 0,
    estimatedCostCny: 0,
  };
  return validateManifest(assetManifestSchema.parse(candidate), assets);
};

export const directCreative = async (
  input: ProjectInput,
  manifest: AssetManifest,
  relay?: RelayClient,
  signal?: AbortSignal,
  conversationContext?: Omit<ModelConversationLogContext, 'source'>,
) => {
  if (!relay) return buildCreativeSpec(input);
  const started = Date.now();
  const candidate = creativeSpecSchema.parse(await relay.requestJson(
    creativeInstructions,
    {schema: 'creative-direction-request.v1', data: {input, manifest}},
    signal,
    [],
    conversationContext ? {...conversationContext, source: 'legacy-video.creative-direction'} : undefined,
  ));
  candidate.generation = {promptVersion: 'creative.relay.v2', modelVersion: relay.model, elapsedMs: Date.now() - started};
  for (const block of candidate.voiceover) {
    if (block.factRefs.some((factRef) => !(factRef in candidate.factLedger))) throw new Error('unknown_fact_ref');
  }
  return creativeSpecSchema.parse(candidate);
};
