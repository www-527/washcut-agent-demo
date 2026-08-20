import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assetRefSchema,
  makeEnvelope,
  parseEnvelope,
  parseRegisteredEnvelope,
  projectInputSchema,
  type ProjectInput,
} from '../shared/contracts.js';
import {createTransportEnvelope} from './transport.js';

const asset = {
  assetId: 'ast_00000000-0000-4000-8000-000000000001', fileName: '门店.jpg', sha256: '12345678',
  contentType: 'image/jpeg', sizeBytes: 100, width: 1080, height: 1920, sourceType: 'user_upload' as const,
  status: 'ready' as const, keyframeUrls: [],
};

const input: ProjectInput = {
  projectId: 'project_00000000-0000-4000-8000-000000000001', storeName: '蓝鲸精洗', region: '上海浦东',
  offer: '49元6次洗车卡', rules: '到店核销，每车限购1张', cta: '现在下单，到店即洗',
  durationMs: 30_000, tone: 'direct', allowLibrary: false, assetIds: [asset.assetId],
};

const context = {
  tenantId: 'tenant_demo', projectId: input.projectId,
  jobId: 'job_00000000-0000-4000-8000-000000000001', traceId: 'trc_00000000-0000-4000-8000-000000000001',
};

test('registered payload is validated inside the common envelope', () => {
  const command = createTransportEnvelope(context, {type: 'render-job.create-requested', schema: 'project-input.v1', data: input, producer: 'web-app', idempotencyKey: `${context.jobId}:create:v1`});
  const parsed = parseEnvelope<ProjectInput>(command, {type: 'render-job.create-requested', schema: 'project-input.v1'});
  assert.equal(parsed.payload.data.durationMs, 30_000);
  assert.equal(parsed.traceId, context.traceId);
});

test('legacy durationSec, embedded asset objects and bare JSON are rejected', () => {
  assert.throws(() => projectInputSchema.parse({...input, durationMs: undefined, durationSec: 30}));
  assert.throws(() => projectInputSchema.parse({...input, assetIds: undefined, assets: [asset]}));
  assert.throws(() => parseEnvelope(input, {schema: 'project-input.v1'}));
});

test('public asset references cannot embed storage keys or media bytes', () => {
  assert.throws(() => assetRefSchema.parse({...asset, storageKey: 'uploads/private.jpg'}));
  assert.throws(() => assetRefSchema.parse({...asset, dataUrl: 'data:image/jpeg;base64,AAAA'}));
});

test('wrong payload schema and unknown envelope fields are rejected', () => {
  const valid = makeEnvelope({...context, type: 'render-job.create-requested', eventId: 'evt_00000000-0000-4000-8000-000000000001', occurredAt: '2026-08-12T00:00:00.000Z', producer: 'web-app', idempotencyKey: `${context.jobId}:create:v1`, schema: 'project-input.v1', data: input});
  assert.throws(() => parseEnvelope(valid, {schema: 'video-spec.v1'}), /Schema/);
  assert.throws(() => parseEnvelope({...valid, apiKey: 'must-not-pass'}, {schema: 'project-input.v1'}));
  assert.throws(() => parseRegisteredEnvelope({...valid, payload: {schema: 'unknown.v1', data: {}}}), /未注册/);
});

test('causationId links consecutive events without mixing payload metadata', () => {
  const first = createTransportEnvelope(context, {type: 'asset-analysis.requested', schema: 'project-input.v1', data: input, producer: 'washcut-orchestrator', idempotencyKey: `${context.jobId}:analysis:v1`});
  const second = createTransportEnvelope(context, {
    type: 'asset-manifest.created', schema: 'asset-manifest.v1',
    data: {schema: 'asset-manifest.v1', assets: [asset], segments: [], coverage: {storefront: false, serviceProcess: false, result: false, logo: false, effectiveDurationMs: 0, gaps: []}, analysis: {promptVersion: 'test', modelVersion: 'test', elapsedMs: 0, tokenUsage: 0, estimatedCostCny: 0}},
    producer: 'asset-understanding-agent', idempotencyKey: `${context.jobId}:manifest:v1`, causationId: first.eventId,
  });
  assert.equal(second.causationId, first.eventId);
  assert.equal(Object.hasOwn(second.payload.data as object, 'traceId'), false);
});
