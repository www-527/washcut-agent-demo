import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {makeEnvelope, renderJobSchema} from '../shared/contracts.js';
import {
  autoVideoProjectSchema,
  makeInitialLocalProcessingSteps,
  type AutoVideoGeneration,
} from '../shared/auto-video-contracts.js';
import {SqliteStore, type StoredAsset} from './store.js';

test('model conversation progress updates keep one readable row', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'washcut-conversation-upsert-'));
  const database = path.join(directory, 'test.sqlite');
  const now = new Date().toISOString();
  const store = new SqliteStore(database, 'test-only-encryption-secret');
  const base = {
    id: 'mdl_upsert_test', tenantId: 'tenant_a', ownerId: 'user_a', source: 'relay.chat-test',
    model: 'gpt-5.6-terra', endpoint: 'https://relay.example.com/v1/responses', startedAt: now,
    completedAt: now, attempts: 1, requestMessages: [{role: 'user' as const, content: 'hello'}],
  };
  store.saveModelConversation({...base, latencyMs: 1, status: 'streaming' as const, responseText: 'part 1'});
  store.saveModelConversation({...base, latencyMs: 2, status: 'streaming' as const, responseText: 'part 1 part 2'});
  assert.equal(store.listModelConversations('tenant_a', 'user_a', 'producer').length, 1);
  assert.equal(store.getModelConversation(base.id, 'tenant_a', 'user_a', 'producer')?.responseText, 'part 1 part 2');
  store.close();
  rmSync(directory, {recursive: true, force: true});
});

test('SQLite persists jobs, events and idempotency while enforcing tenant asset scope', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'washcut-store-'));
  const database = path.join(directory, 'test.sqlite');
  const now = new Date().toISOString();
  const asset: StoredAsset = {
    assetId: 'ast_store_test', tenantId: 'tenant_a', projectId: 'project_store_test', ownerId: 'user_a',
    originalPath: path.join(directory, 'original.jpg'), proxyPath: path.join(directory, 'original.jpg'),
    thumbnailPath: path.join(directory, 'thumb.jpg'), keyframePaths: [], createdAt: now,
    fileName: '门店.jpg', sha256: '12345678', contentType: 'image/jpeg', sizeBytes: 100,
    width: 1080, height: 1920, sourceType: 'user_upload', status: 'ready', keyframeUrls: [],
  };
  const job = renderJobSchema.parse({
    schema: 'render-job.v1', jobId: 'job_store_test', tenantId: 'tenant_a', ownerId: 'user_a',
    projectId: 'project_store_test', traceId: 'trace_store_test', status: 'queued', progress: 2,
    mode: 'local', attempt: 1, createdAt: now, updatedAt: now,
    input: {projectId: 'project_store_test', storeName: '测试门店', region: '上海浦东', offer: '精洗优惠', rules: '到店核销', cta: '现在下单', durationMs: 15_000, tone: 'direct', allowLibrary: false, assetIds: [asset.assetId]},
    artifacts: [],
  });
  const event = makeEnvelope({
    type: 'render-job.accepted', eventId: 'evt_store_test', occurredAt: now, traceId: job.traceId,
    tenantId: job.tenantId, projectId: job.projectId, jobId: job.jobId, producer: 'business-api',
    idempotencyKey: 'job_store_test:create:v1', schema: 'render-job.v1', data: job,
  });
  const first = new SqliteStore(database, 'test-only-encryption-secret');
  first.saveAsset(asset);
  first.saveJob(job);
  first.appendEvent(job.jobId, event);
  first.saveIdempotent(job.tenantId, event.idempotencyKey, event);
  const firstKey = first.saveRelayKey({
    keyId: 'key_store_a', tenantId: 'tenant_a', name: '主中转站', baseUrl: 'https://relay.example.com',
    apiKey: 'sk-sensitive-primary', model: 'gpt-5.6-terra', active: false, createdAt: now, updatedAt: now,
  });
  assert.equal(firstKey.active, true);
  assert.equal(first.listRelayKeys('tenant_a')[0]?.maskedKey, '••••••••mary');
  assert.equal(first.listRelayKeys('tenant_b').length, 0);
  first.saveRelayKey({
    keyId: 'key_store_b', tenantId: 'tenant_a', name: '备用中转站', baseUrl: 'https://backup.example.com',
    apiKey: 'sk-sensitive-backup', model: 'gpt-5.6-terra', active: true, createdAt: now, updatedAt: now,
  });
  assert.equal(first.getActiveRelayKey('tenant_a')?.keyId, 'key_store_b');
  assert.equal(first.deleteRelayKey('key_store_b', 'tenant_a'), true);
  assert.equal(first.getActiveRelayKey('tenant_a')?.keyId, 'key_store_a');
  first.saveModelConversation({
    id: 'mdl_store_test', tenantId: 'tenant_a', ownerId: 'user_a', relayKeyId: 'key_store_a',
    projectId: job.projectId, jobId: job.jobId, source: 'relay.chat-test', model: 'gpt-5.6-terra', endpoint: 'https://relay.example.com/v1/responses',
    startedAt: now, completedAt: now, latencyMs: 42, attempts: 1, status: 'completed',
    requestMessages: [{role: 'program', label: '系统指令', content: '请回答用户问题。'}, {role: 'user', content: '你好'}],
    responseText: '你好，我是模型。',
  });
  assert.equal(first.listModelConversations('tenant_a', 'user_a', 'producer')[0]?.requestPreview, '请回答用户问题。 你好');
  assert.equal(first.getModelConversation('mdl_store_test', 'tenant_a', 'user_a', 'producer')?.responseText, '你好，我是模型。');
  assert.throws(() => first.resolveAssets([asset.assetId], 'tenant_b', job.projectId), /asset_not_owned/);
  first.close();

  const reopened = new SqliteStore(database, 'test-only-encryption-secret');
  assert.equal(reopened.getJob(job.jobId, 'tenant_a')?.status, 'queued');
  assert.equal(reopened.getEvents(job.jobId).length, 1);
  assert.equal(reopened.getIdempotent('tenant_a', event.idempotencyKey)?.eventId, event.eventId);
  assert.equal(reopened.getJob(job.jobId, 'tenant_b'), undefined);
  assert.equal(reopened.getRelayKey('key_store_a', 'tenant_a')?.apiKey, 'sk-sensitive-primary');
  assert.equal(reopened.getModelConversation('mdl_store_test', 'tenant_a', 'user_a', 'producer')?.model, 'gpt-5.6-terra');
  reopened.close();
  assert.equal(readFileSync(database).includes(Buffer.from('sk-sensitive-primary')), false);
  rmSync(directory, {recursive: true, force: true});
});

test('versioned generations are idempotent, ordered, and repair incomplete historical snapshots', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'washcut-generation-store-'));
  const database = path.join(directory, 'test.sqlite');
  const now = new Date().toISOString();
  const project = autoVideoProjectSchema.parse({
    id: 'project_generation_test', tenantId: 'tenant_a', ownerId: 'user_a', name: '版本化测试',
    status: 'ready', progress: 0, canvas: {width: 1080, height: 1920, fps: 30}, assetIds: ['asset_generation_test'],
    steps: [], transcripts: [], screenshotAnalyses: [], assetAnalyses: [], createdAt: now, updatedAt: now,
  });
  const generation = (generationId: string, instructionSnapshot: string): Omit<AutoVideoGeneration, 'versionNumber'> => ({
    generationId,
    projectId: project.id,
    tenantId: project.tenantId,
    ownerId: project.ownerId,
    status: 'queued',
    progress: 0,
    aiMode: {kind: 'local', reason: 'user_selected_local'},
    instructionSnapshot,
    canvas: project.canvas,
    assetIds: project.assetIds,
    steps: makeInitialLocalProcessingSteps(),
    transcripts: [],
    screenshotAnalyses: [],
    assetAnalyses: [],
    artifactStorage: 'generation',
    createdAt: now,
    updatedAt: now,
  });

  const first = new SqliteStore(database, 'test-only-encryption-secret');
  first.saveAutoVideoProject(project);
  const v1 = first.createAutoVideoGeneration(generation('generation_v1', '第一版'), 'generation-create-v1');
  const idempotent = first.createAutoVideoGeneration(generation('generation_v1_duplicate', '不应新建'), 'generation-create-v1');
  const v2 = first.createAutoVideoGeneration(generation('generation_v2', '第二版'), 'generation-create-v2');
  assert.equal(v1.versionNumber, 1);
  assert.equal(idempotent.generationId, v1.generationId);
  assert.equal(v2.versionNumber, 2);
  assert.equal(first.getLatestAutoVideoGeneration(project.tenantId, project.ownerId, 'producer', project.id)?.generationId, v2.generationId);
  assert.equal(first.isAutoVideoAssetReferencedByGeneration(project.tenantId, project.id, project.assetIds[0]!), true);
  first.close();

  // Simulate a pre-blueprint V1 that was written without the now-required
  // snapshot fields. Reopening the store must repair it without discarding V2.
  const databaseHandle = new DatabaseSync(database);
  const malformed = {...v1} as Record<string, unknown>;
  delete malformed.progress;
  delete malformed.canvas;
  databaseHandle.prepare('UPDATE auto_video_generations SET payload_json = ? WHERE generation_id = ?').run(JSON.stringify(malformed), v1.generationId);
  const staleCompleted = {
    ...v2,
    status: 'completed',
    progress: 91,
    localSummary: 'preserve-completed-payload',
    completedAt: now,
  };
  databaseHandle.prepare('UPDATE auto_video_generations SET status = ?, payload_json = ? WHERE generation_id = ?')
    .run('completed', JSON.stringify(staleCompleted), v2.generationId);
  databaseHandle.close();

  const reopened = new SqliteStore(database, 'test-only-encryption-secret');
  const repaired = reopened.getAutoVideoGeneration(v1.generationId, project.tenantId);
  assert.equal(repaired?.progress, 0);
  assert.deepEqual(repaired?.canvas, project.canvas);
  assert.equal(reopened.getLatestAutoVideoGeneration(project.tenantId, project.ownerId, 'producer', project.id)?.generationId, v2.generationId);
  const repairedCompleted = reopened.getAutoVideoGeneration(v2.generationId, project.tenantId);
  assert.equal(repairedCompleted?.progress, 100);
  assert.equal(repairedCompleted?.localSummary, 'preserve-completed-payload');
  assert.deepEqual(repairedCompleted?.steps, v2.steps);
  reopened.close();
  rmSync(directory, {recursive: true, force: true});
});

test('legacy project payloads migrate once into a readable V1 without touching source records', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'washcut-legacy-project-'));
  const database = path.join(directory, 'test.sqlite');
  const now = new Date().toISOString();
  const projectId = 'project_legacy_migration_test';
  const seed = new SqliteStore(database, 'test-only-encryption-secret');
  seed.close();

  const legacyPayload = {
    id: projectId,
    tenantId: 'tenant_legacy',
    ownerId: 'user_legacy',
    name: '历史视频项目',
    userInstruction: '保留原片顺序',
    status: 'completed',
    assetIds: ['asset_legacy_1'],
    steps: makeInitialLocalProcessingSteps(),
    transcripts: [],
    screenshotAnalyses: [],
    assetAnalyses: [],
    output: {status: 'ready'},
    createdAt: now,
    updatedAt: now,
  };
  const databaseHandle = new DatabaseSync(database);
  databaseHandle.prepare(`INSERT INTO auto_video_projects(project_id, tenant_id, owner_id, status, payload_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(projectId, 'tenant_legacy', 'user_legacy', 'completed', JSON.stringify(legacyPayload), now, now);
  databaseHandle.close();

  const migrated = new SqliteStore(database, 'test-only-encryption-secret');
  const project = migrated.getAutoVideoProject(projectId, 'tenant_legacy');
  const versions = migrated.listAutoVideoGenerations('tenant_legacy', 'user_legacy', 'producer', projectId);
  assert.equal(project?.status, 'ready');
  assert.equal(project?.progress, 0);
  assert.deepEqual(project?.canvas, {width: 1080, height: 1920, fps: 30});
  assert.equal(versions.length, 1);
  assert.equal(versions[0]?.versionNumber, 1);
  assert.equal(versions[0]?.progress, 100);
  assert.equal(versions[0]?.artifactStorage, 'legacy_project');
  migrated.close();

  const reopened = new SqliteStore(database, 'test-only-encryption-secret');
  assert.equal(reopened.countAutoVideoGenerations('tenant_legacy', projectId), 1);
  reopened.close();
  rmSync(directory, {recursive: true, force: true});
});
