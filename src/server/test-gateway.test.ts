import assert from 'node:assert/strict';
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {once} from 'node:events';
import test from 'node:test';
import {createTestGateway} from './test-gateway.js';

const listen = async (server: ReturnType<typeof createServer>) => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server_address_unavailable');
  return `http://127.0.0.1:${address.port}`;
};

const readBody = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

const json = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, {'content-type': 'application/json'});
  response.end(JSON.stringify(body));
};

const responseJson = <Value,>(response: Response) => response.json() as Promise<Value>;

test('test gateway exposes only session-scoped upload, status and download routes', async (context) => {
  const seen: Array<{method?: string; url?: string; tenant?: string; user?: string; role?: string; body?: Buffer}> = [];
  let internalBaseUrl = '';
  const project = {
    id: 'project_public_test',
    updatedAt: '2026-09-02T06:00:00.000Z',
    assets: [{id: 'asset_1'}],
    latestGeneration: {
      generationId: 'generation_public_test',
      status: 'completed',
      progress: 100,
      updatedAt: '2026-09-02T06:01:00.000Z',
      steps: [{name: 'render', status: 'completed', progress: 100}],
      output: {status: 'ready', videoUrl: '', captionedVideoUrl: ''},
    },
  };
  const internalServer = createServer(async (request, response) => {
    const body = await readBody(request);
    seen.push({
      method: request.method,
      url: request.url,
      tenant: request.headers['x-tenant-id'] as string | undefined,
      user: request.headers['x-user-id'] as string | undefined,
      role: request.headers['x-role'] as string | undefined,
      body,
    });
    if (request.method === 'POST' && request.url === '/api/projects') { json(response, 201, project); return; }
    if (request.method === 'POST' && request.url === '/api/projects/project_public_test/assets') { json(response, 201, {assets: [{id: 'asset_1'}]}); return; }
    if (request.method === 'POST' && request.url === '/api/projects/project_public_test/generations') { json(response, 202, {generation: project.latestGeneration}); return; }
    if (request.method === 'POST' && /^\/api\/projects\/project_public_test\/generations\/generation_public_test\/(?:retry|resume)$/.test(request.url ?? '')) {
      project.latestGeneration.status = 'queued';
      delete (project.latestGeneration as typeof project.latestGeneration & {error?: unknown}).error;
      json(response, 202, {accepted: true, generation: project.latestGeneration});
      return;
    }
    if (request.method === 'GET' && request.url === '/api/projects/project_public_test') { json(response, 200, project); return; }
    if (request.method === 'POST' && request.url === '/api/projects/project_public_test/generations/generation_public_test/output-captioned') {
      json(response, 200, {videoUrl: `${internalBaseUrl}/file-captioned`});
      return;
    }
    if (request.method === 'GET' && (request.url === '/file-plain' || request.url === '/file-captioned')) {
      const payload = Buffer.from(request.url === '/file-plain' ? 'plain-video' : 'captioned-video');
      response.writeHead(200, {'content-type': 'video/mp4', 'content-length': String(payload.length)});
      response.end(payload);
      return;
    }
    json(response, 404, {error: {code: 'NOT_FOUND', message: 'not found', retryable: false}});
  });
  internalBaseUrl = await listen(internalServer);
  project.latestGeneration.output.videoUrl = `${internalBaseUrl}/file-plain`;
  project.latestGeneration.output.captionedVideoUrl = `${internalBaseUrl}/file-captioned`;

  const gatewayServer = createServer(createTestGateway({
    accessCode: 'safe-test-code',
    internalBaseUrl,
    staticDir: 'dist',
    maxUploadBytes: 1024 * 1024,
    visualConcurrency: 7,
    consoleMonitor: false,
  }));
  const gatewayBaseUrl = await listen(gatewayServer);
  context.after(() => {
    gatewayServer.close();
    internalServer.close();
  });

  const unauthenticated = await fetch(`${gatewayBaseUrl}/api/test/session`);
  assert.equal(unauthenticated.status, 401);
  assert.equal((await responseJson<{error: {code: string}}>(unauthenticated)).error.code, 'TEST_SESSION_REQUIRED');

  const invalidLogin = await fetch(`${gatewayBaseUrl}/api/test/login`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({accessCode: 'wrong'}),
  });
  assert.equal(invalidLogin.status, 401);

  const malformedLogin = await fetch(`${gatewayBaseUrl}/api/test/login`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: '{not-json',
  });
  assert.equal(malformedLogin.status, 400);
  assert.match(malformedLogin.headers.get('content-type') ?? '', /^application\/json/);
  const malformedBody = await responseJson<{error: {code: string; message: string}}>(malformedLogin);
  assert.equal(malformedBody.error.code, 'entity.parse.failed');
  assert.doesNotMatch(malformedBody.error.message, /node_modules|test-gateway\.ts/i);

  const login = await fetch(`${gatewayBaseUrl}/api/test/login`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({accessCode: 'safe-test-code'}),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie?.startsWith('washcut_test_session='));

  const deniedManagement = await fetch(`${gatewayBaseUrl}/api/system/shutdown`, {method: 'POST', headers: {cookie}});
  assert.equal(deniedManagement.status, 404);
  assert.equal((await responseJson<{error: {code: string}}>(deniedManagement)).error.code, 'TEST_ROUTE_NOT_FOUND');

  const created = await fetch(`${gatewayBaseUrl}/api/test/tasks`, {
    method: 'POST',
    headers: {'content-type': 'application/json', cookie},
    body: '{}',
  });
  assert.equal(created.status, 201);
  assert.equal((await responseJson<{taskId: string}>(created)).taskId, 'project_public_test');
  assert.equal(seen[0].tenant, 'tenant_demo');
  assert.equal(seen[0].role, 'producer');
  assert.match(seen[0].user ?? '', /^user_external_[a-z0-9]+$/);

  const form = new FormData();
  form.append('files', new Blob([Buffer.from('video-bytes')], {type: 'video/mp4'}), 'clip.mp4');
  const uploaded = await fetch(`${gatewayBaseUrl}/api/test/tasks/project_public_test/assets`, {method: 'POST', headers: {cookie}, body: form});
  assert.equal(uploaded.status, 201);
  assert.equal((await responseJson<{assetCount: number}>(uploaded)).assetCount, 1);
  assert.ok(seen.at(-1)?.body?.includes(Buffer.from('video-bytes')));

  const started = await fetch(`${gatewayBaseUrl}/api/test/tasks/project_public_test/start`, {
    method: 'POST',
    headers: {'content-type': 'application/json', cookie},
    body: '{}',
  });
  assert.equal(started.status, 202);
  assert.equal((await responseJson<{generationId: string}>(started)).generationId, 'generation_public_test');
  const generationRequest = seen.find((request) => request.method === 'POST' && request.url === '/api/projects/project_public_test/generations');
  assert.equal(JSON.parse(generationRequest?.body?.toString('utf8') ?? '{}').visualConcurrency, 7);

  const status = await fetch(`${gatewayBaseUrl}/api/test/tasks/project_public_test`, {headers: {cookie}});
  assert.equal(status.status, 200);
  const publicStatus = await responseJson<{status: string; outputReady: boolean; steps: unknown[]}>(status);
  assert.equal(publicStatus.status, 'completed');
  assert.equal(publicStatus.outputReady, true);
  assert.deepEqual(publicStatus.steps, [{name: 'render', status: 'completed', progress: 100}]);

  const plain = await fetch(`${gatewayBaseUrl}/api/test/tasks/project_public_test/download/plain`, {headers: {cookie}});
  assert.equal(plain.status, 200);
  assert.equal(plain.headers.get('content-type'), 'video/mp4');
  assert.equal(await plain.text(), 'plain-video');

  const captioned = await fetch(`${gatewayBaseUrl}/api/test/tasks/project_public_test/download/captioned`, {headers: {cookie}});
  assert.equal(captioned.status, 200);
  assert.equal(await captioned.text(), 'captioned-video');

  const completedRetry = await fetch(`${gatewayBaseUrl}/api/test/tasks/project_public_test/retry`, {method: 'POST', headers: {cookie}});
  assert.equal(completedRetry.status, 403);
  assert.equal((await responseJson<{error: {code: string}}>(completedRetry)).error.code, 'TEST_ADMIN_RETRY_REQUIRED');

  Object.assign(project.latestGeneration, {
    status: 'needs_attention',
    error: {code: 'MODEL_SERVICE_UNAVAILABLE', message: 'service unavailable', retryable: true},
  });
  const retryableStatus = await fetch(`${gatewayBaseUrl}/api/test/tasks/project_public_test`, {headers: {cookie}});
  assert.equal(retryableStatus.status, 200);
  assert.equal((await responseJson<{canRetry: boolean}>(retryableStatus)).canRetry, false);

  const secondLogin = await fetch(`${gatewayBaseUrl}/api/test/login`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({accessCode: 'safe-test-code'}),
  });
  const secondCookie = secondLogin.headers.get('set-cookie')?.split(';')[0];
  const isolated = await fetch(`${gatewayBaseUrl}/api/test/tasks/project_public_test`, {headers: {cookie: secondCookie ?? ''}});
  assert.equal(isolated.status, 404);
  assert.equal((await responseJson<{error: {code: string}}>(isolated)).error.code, 'TEST_TASK_NOT_FOUND');
  const isolatedRetry = await fetch(`${gatewayBaseUrl}/api/test/tasks/project_public_test/retry`, {method: 'POST', headers: {cookie: secondCookie ?? ''}});
  assert.equal(isolatedRetry.status, 404);

  const resumed = await fetch(`${gatewayBaseUrl}/api/test/tasks/project_public_test/retry`, {method: 'POST', headers: {cookie}});
  assert.equal(resumed.status, 403);
  assert.equal((await responseJson<{error: {code: string}}>(resumed)).error.code, 'TEST_ADMIN_RETRY_REQUIRED');

  Object.assign(project.latestGeneration, {
    status: 'failed',
    error: {code: 'RENDER_FAILED', message: 'render failed', retryable: true},
  });
  const retried = await fetch(`${gatewayBaseUrl}/api/test/tasks/project_public_test/retry`, {method: 'POST', headers: {cookie}});
  assert.equal(retried.status, 403);
  assert.equal((await responseJson<{error: {code: string}}>(retried)).error.code, 'TEST_ADMIN_RETRY_REQUIRED');
});

test('test gateway console monitor reports actions, progress, model dialogue, and redacts secrets', async (context) => {
  const output: string[] = [];
  const generation = {
    generationId: 'generation_monitor_test',
    status: 'completed',
    progress: 100,
    updatedAt: new Date().toISOString(),
    steps: [{name: 'render', status: 'completed', progress: 100}],
    output: {status: 'ready'},
  };
  const project = {id: 'project_monitor_test', updatedAt: new Date().toISOString(), assets: [{id: 'asset_monitor_test'}], latestGeneration: generation};
  const internalServer = createServer(async (request, response) => {
    await readBody(request);
    if (request.method === 'POST' && request.url === '/api/projects') { json(response, 201, project); return; }
    if (request.method === 'POST' && request.url === '/api/projects/project_monitor_test/generations') { json(response, 202, {generation}); return; }
    if (request.method === 'GET' && request.url === '/api/projects/project_monitor_test') { json(response, 200, project); return; }
    if (request.method === 'GET' && request.url?.startsWith('/api/model-conversations?projectId=project_monitor_test')) {
      json(response, 200, {conversations: [{
        id: 'mdl_monitor_test', source: 'auto-video.edit-planning', model: 'test-model', status: 'completed',
        requestPreview: '程序发出的测试提示', responsePreview: '模型返回的测试结果', completedAt: new Date().toISOString(),
      }]});
      return;
    }
    if (request.method === 'GET' && request.url === '/api/model-conversations/mdl_monitor_test') {
      json(response, 200, {
        id: 'mdl_monitor_test', source: 'auto-video.edit-planning', model: 'test-model', status: 'completed', latencyMs: 123, attempts: 1,
        requestMessages: [{role: 'program', content: '程序发出的测试提示 authorization: Bearer sk-super-secret'}],
        responseText: '模型返回的测试结果 api_key=sk-super-secret',
      });
      return;
    }
    json(response, 404, {error: {code: 'NOT_FOUND', message: 'not found', retryable: false}});
  });
  const internalBaseUrl = await listen(internalServer);
  const gatewayServer = createServer(createTestGateway({
    accessCode: 'monitor-secret-code',
    internalBaseUrl,
    staticDir: 'dist',
    consoleMonitor: true,
    logger: {log: (value) => output.push(String(value)), warn: (value) => output.push(String(value)), error: (value) => output.push(String(value))},
  }));
  const gatewayBaseUrl = await listen(gatewayServer);
  context.after(() => {
    gatewayServer.close();
    internalServer.close();
  });

  const login = await fetch(`${gatewayBaseUrl}/api/test/login`, {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({accessCode: 'monitor-secret-code'}),
  });
  const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  const created = await fetch(`${gatewayBaseUrl}/api/test/tasks`, {method: 'POST', headers: {'content-type': 'application/json', cookie}, body: '{}'});
  assert.equal(created.status, 201);
  const started = await fetch(`${gatewayBaseUrl}/api/test/tasks/project_monitor_test/start`, {method: 'POST', headers: {'content-type': 'application/json', cookie}, body: '{}'});
  assert.equal(started.status, 202);
  await new Promise((resolve) => setTimeout(resolve, 200));

  const joined = output.join('\n');
  assert.match(joined, /测试人员登录成功/);
  assert.match(joined, /新建视频制作任务/);
  assert.match(joined, /点击开始制作/);
  assert.match(joined, /\[进度\] 制作完成 100%/);
  assert.match(joined, /程序发出的测试提示/);
  assert.match(joined, /模型返回的测试结果/);
  assert.doesNotMatch(joined, /monitor-secret-code|sk-super-secret/);
  assert.match(joined, /\[已隐藏\]/);
});

test('test gateway rejects an invalid visual concurrency at startup', () => {
  assert.throws(
    () => createTestGateway({accessCode: 'safe-test-code', visualConcurrency: 31}),
    /WASHCUT_TEST_VISUAL_CONCURRENCY must be an integer between 1 and 30/,
  );
});
