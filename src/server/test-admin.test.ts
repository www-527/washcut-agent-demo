import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import path from 'node:path';
import test from 'node:test';
import {createTestAdmin} from './test-admin.js';

const listen = async (server: ReturnType<typeof createServer>) => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server_address_unavailable');
  return {baseUrl: `http://127.0.0.1:${address.port}`, port: address.port};
};

const readBody = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
};

const json = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, {'content-type': 'application/json'});
  response.end(JSON.stringify(body));
};

const envelope = (data: unknown) => ({payload: {data}});

test('local administrator dashboard exposes public tasks, model I/O, key switching, and checkpoint retry', async (context) => {
  const seen: Array<{method?: string; url?: string; tenantId?: string; userId?: string; role?: string; body: string}> = [];
  const openedDirectories: string[] = [];
  const uploadsRoot = path.resolve('test-user-uploads');
  const generation = {
    generationId: 'generation_external',
    status: 'needs_attention',
    progress: 42,
    connectionId: 'key_old',
    model: 'old-model',
    steps: [{name: 'visual_analysis', status: 'failed', progress: 42, errorCode: 'relay_timeout', errorMessage: 'timeout'}],
    retryState: {
      status: 'needs_attention', stage: 'visual_analysis', totalAttempts: 4, attemptsByKey: {'visual_analysis:asset_1': 4},
      recoveryAttempts: 2, updatedAt: '2026-09-07T03:00:00.000Z',
    },
    error: {code: 'relay_timeout', message: 'timeout', retryable: true},
    updatedAt: '2026-09-07T03:00:00.000Z',
  };
  const externalProject = {
    id: 'project_external', ownerId: 'user_external_12345678', name: '外部测试 2026/9/7 11:00:00',
    assets: [{id: 'asset_1'}], latestGeneration: generation,
    createdAt: '2026-09-07T02:00:00.000Z', updatedAt: '2026-09-07T03:00:00.000Z',
  };
  const keys = [
    {keyId: 'key_old', name: '旧连接', baseUrl: 'https://old.example.com/', model: 'old-model', maskedKey: '••••old1', active: true, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z'},
    {keyId: 'key_new', name: '备用连接', baseUrl: 'https://new.example.com/', model: 'new-model', maskedKey: '••••new1', active: false, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z'},
  ];
  const conversation = {
    id: 'mdl_external', tenantId: 'tenant_demo', ownerId: 'user_external_12345678', projectId: 'project_external',
    source: 'auto-video.edit-planning', model: 'old-model', endpoint: 'https://old.example.com/v1/responses',
    startedAt: '2026-09-07T02:59:00.000Z', completedAt: '2026-09-07T03:00:00.000Z', latencyMs: 60_000,
    attempts: 4, status: 'failed', requestMessages: [{role: 'program', content: 'arrange all clips'}],
    errorCode: 'relay_timeout', errorMessage: 'timeout',
  };

  const internalServer = createServer(async (request, response) => {
    const body = await readBody(request);
    seen.push({
      method: request.method,
      url: request.url,
      tenantId: request.headers['x-tenant-id'] as string | undefined,
      userId: request.headers['x-user-id'] as string | undefined,
      role: request.headers['x-role'] as string | undefined,
      body,
    });
    if (request.method === 'GET' && request.url === '/api/admin/public-test/projects?limit=50') {
      json(response, 200, {projects: [
        {id: externalProject.id, testerId: '12345678', name: externalProject.name, assetCount: 1, latestGeneration: externalProject.latestGeneration, createdAt: externalProject.createdAt, updatedAt: externalProject.updatedAt},
      ]}); return;
    }
    if (request.method === 'GET' && request.url === '/api/projects/project_external') { json(response, 200, externalProject); return; }
    if (request.method === 'GET' && request.url === '/api/keys') { json(response, 200, envelope({keys})); return; }
    if (request.method === 'GET' && request.url === '/api/model-connection/status') {
      json(response, 200, {mode: 'connected', message: 'ready', activeConnection: {connectionId: 'key_old', name: '旧连接', model: 'old-model'}}); return;
    }
    if (request.method === 'GET' && request.url?.startsWith('/api/model-conversations?projectId=project_external')) {
      json(response, 200, {conversations: [{...conversation, requestPreview: 'arrange all clips', messageCount: 1}]}); return;
    }
    if (request.method === 'GET' && request.url === '/api/model-conversations/mdl_external') { json(response, 200, conversation); return; }
    if (request.method === 'POST' && request.url === '/api/keys/key_new/test') {
      json(response, 200, envelope({ok: true, latencyMs: 88, message: 'ok'})); return;
    }
    if (request.method === 'POST' && request.url === '/api/keys/key_new/activate') {
      keys[0].active = false; keys[1].active = true;
      json(response, 200, envelope(keys[1])); return;
    }
    if (request.method === 'PATCH' && request.url === '/api/projects/project_external/generations/generation_external/model-connection') {
      const input = JSON.parse(body) as {connectionId: string};
      generation.connectionId = input.connectionId;
      generation.model = 'new-model';
      json(response, 200, {accepted: true, generation}); return;
    }
    if (request.method === 'POST' && request.url === '/api/projects/project_external/generations/generation_external/resume') {
      generation.status = 'queued';
      json(response, 202, {accepted: true, generation}); return;
    }
    json(response, 404, {error: {code: 'NOT_FOUND', message: 'not found', retryable: false}});
  });
  const internal = await listen(internalServer);
  const adminServer = createServer(createTestAdmin({
    internalBaseUrl: internal.baseUrl,
    staticDir: 'dist',
    uploadsRoot,
    openDirectory: async (directory) => { openedDirectories.push(directory); },
  }));
  const admin = await listen(adminServer);
  context.after(() => { adminServer.close(); internalServer.close(); });

  const snapshotResponse = await fetch(`${admin.baseUrl}/api/admin/snapshot`);
  assert.equal(snapshotResponse.status, 200);
  assert.equal(snapshotResponse.headers.get('x-frame-options'), 'DENY');
  const snapshot = await snapshotResponse.json() as {tasks: Array<{taskId: string; canRetry: boolean; retryState: {totalAttempts: number}}>; keys: typeof keys};
  assert.deepEqual(snapshot.tasks.map((task) => task.taskId), ['project_external']);
  assert.equal(snapshot.tasks[0].canRetry, true);
  assert.equal(snapshot.tasks[0].retryState.totalAttempts, 4);
  assert.equal(snapshot.keys[0].maskedKey, '••••old1');
  assert.ok(seen.every((request) => request.tenantId === 'tenant_demo'));
  assert.ok(seen.every((request) => request.userId === 'user_admin_public_test'));
  assert.ok(seen.every((request) => request.role === 'admin'));

  const rejectedOrigin = await fetch(`${admin.baseUrl}/api/admin/snapshot`, {headers: {origin: 'https://attacker.example'}});
  assert.equal(rejectedOrigin.status, 403);
  assert.equal((await rejectedOrigin.json() as {error: {code: string}}).error.code, 'ADMIN_ORIGIN_REJECTED');

  const missingConfirmation = await fetch(`${admin.baseUrl}/api/admin/keys/key_new/activate`, {method: 'POST'});
  assert.equal(missingConfirmation.status, 403);
  assert.equal((await missingConfirmation.json() as {error: {code: string}}).error.code, 'ADMIN_CONFIRMATION_HEADER_REQUIRED');

  const rejectedFolderOpen = await fetch(`${admin.baseUrl}/api/admin/uploads/open`, {method: 'POST'});
  assert.equal(rejectedFolderOpen.status, 403);
  assert.deepEqual(openedDirectories, []);

  const folderOpen = await fetch(`${admin.baseUrl}/api/admin/uploads/open`, {method: 'POST', headers: {'x-washcut-admin-request': '1'}});
  assert.equal(folderOpen.status, 202);
  assert.deepEqual(await folderOpen.json(), {opened: true});
  assert.deepEqual(openedDirectories, [uploadsRoot]);

  const testResult = await fetch(`${admin.baseUrl}/api/admin/keys/key_new/test`, {method: 'POST', headers: {'x-washcut-admin-request': '1'}});
  assert.equal(testResult.status, 200);
  assert.deepEqual(await testResult.json(), {ok: true, latencyMs: 88, message: 'ok'});

  const activated = await fetch(`${admin.baseUrl}/api/admin/keys/key_new/activate`, {method: 'POST', headers: {'x-washcut-admin-request': '1'}});
  assert.equal(activated.status, 200);
  assert.equal((await activated.json() as {keyId: string}).keyId, 'key_new');

  const list = await fetch(`${admin.baseUrl}/api/admin/tasks/project_external/conversations`);
  assert.equal(list.status, 200);
  assert.equal((await list.json() as {conversations: Array<{id: string}>}).conversations[0].id, 'mdl_external');
  const detail = await fetch(`${admin.baseUrl}/api/admin/conversations/mdl_external`);
  assert.equal(detail.status, 200);
  assert.equal((await detail.json() as {attempts: number}).attempts, 4);

  const retry = await fetch(`${admin.baseUrl}/api/admin/tasks/project_external/retry`, {
    method: 'POST',
    headers: {'content-type': 'application/json', 'x-washcut-admin-request': '1'},
    body: JSON.stringify({connectionId: 'key_new'}),
  });
  assert.equal(retry.status, 202);
  assert.deepEqual(await retry.json(), {accepted: true, action: 'resume', connectionChanged: true, generationId: 'generation_external'});
  const switchRequest = seen.find((request) => request.method === 'PATCH' && request.url?.endsWith('/model-connection'));
  assert.deepEqual(JSON.parse(switchRequest?.body ?? '{}'), {connectionId: 'key_new'});
  assert.ok(seen.some((request) => request.method === 'POST' && request.url?.endsWith('/resume')));
});
