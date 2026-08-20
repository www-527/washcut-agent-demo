import {makeEnvelope, type VideoSpec} from '../shared/contracts';

const demoSha = 'demo000000000000000000000000000000000000000000000000000000000000';
const demoMedia = (assetId: string) => ({assetId, url: '/media/carwash-contact-sheet.png', contentType: 'image/png', sha256: demoSha});

export const defaultVideoSpec: VideoSpec = {
  schema: 'video-spec.v1', version: 'render.v2', width: 1080, height: 1920, fps: 30, durationMs: 30_000,
  storeName: '蓝鲸精洗', region: '上海浦东', offer: '49元6次洗车卡', cta: '现在下单，到店即洗',
  scenes: [
    {sceneId: 's1', narrativeTask: '优惠钩子', assetId: 'demo1', sourceType: 'user_upload', media: demoMedia('demo1'), sourceStartMs: 0, timelineStartMs: 0, durationMs: 7_875, crop: {x: .5, y: .5, scale: 1.08}, transition: 'cut', headline: '浦东车主注意', subtitle: '49元6次洗车卡', captionPosition: 'lower', factRefs: ['promotion.offer'], visualKey: 'pressure'},
    {sceneId: 's2', narrativeTask: '过程证明', assetId: 'demo2', sourceType: 'user_upload', media: demoMedia('demo2'), sourceStartMs: 0, timelineStartMs: 7_375, durationMs: 7_875, crop: {x: .5, y: .5, scale: 1.12}, transition: 'fade', headline: '过程看得见', subtitle: '预洗 · 泡沫 · 精洗', captionPosition: 'upper', factRefs: [], visualKey: 'foam'},
    {sceneId: 's3', narrativeTask: '门店证明', assetId: 'demo3', sourceType: 'user_upload', media: demoMedia('demo3'), sourceStartMs: 0, timelineStartMs: 14_750, durationMs: 7_875, crop: {x: .5, y: .5, scale: 1.08}, transition: 'slide', headline: '蓝鲸精洗', subtitle: '上海浦东真实门店', captionPosition: 'lower', factRefs: ['store.name'], visualKey: 'storefront'},
    {sceneId: 's4', narrativeTask: '行动引导', assetId: 'demo4', sourceType: 'user_upload', media: demoMedia('demo4'), sourceStartMs: 0, timelineStartMs: 22_125, durationMs: 7_875, crop: {x: .5, y: .5, scale: 1.12}, transition: 'fade', headline: '现在下单，到店即洗', subtitle: '到店核销，每车限购1张', captionPosition: 'lower', factRefs: ['promotion.cta'], visualKey: 'result'},
  ],
  captions: [
    {text: '浦东车主注意', startMs: 0, endMs: 7_375, timestampMs: null, confidence: 1},
    {text: '过程看得见', startMs: 7_375, endMs: 14_750, timestampMs: null, confidence: 1},
    {text: '真实门店，真实素材', startMs: 14_750, endMs: 22_125, timestampMs: null, confidence: 1},
    {text: '现在下单，到店即洗', startMs: 22_125, endMs: 30_000, timestampMs: null, confidence: 1},
  ],
  audio: {duckingDb: -12},
  provenance: ['demo1', 'demo2', 'demo3', 'demo4'].map((assetId) => ({assetId, sourceType: 'user_upload', sha256: demoSha, licenseRecordId: `license_${assetId}`})),
};

export const defaultRenderMessage = makeEnvelope({
  type: 'render.requested',
  eventId: 'evt_00000000-0000-4000-8000-000000000001',
  occurredAt: '2026-08-12T00:00:00.000Z',
  traceId: 'trc_00000000-0000-4000-8000-000000000001',
  tenantId: 'tenant_demo',
  projectId: 'project_00000000-0000-4000-8000-000000000001',
  jobId: 'job_00000000-0000-4000-8000-000000000001',
  producer: 'washcut-orchestrator',
  idempotencyKey: 'job_demo:render-requested:video-spec.v1',
  schema: 'video-spec.v1',
  data: defaultVideoSpec,
});
