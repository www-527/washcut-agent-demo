import {spawn} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import express, {type NextFunction, type Request, type Response} from 'express';
import type {
  PublicAdminConnectionStatus,
  PublicAdminSnapshot,
  PublicAdminStep,
  PublicAdminTask,
  RelayKeySummary,
} from '../shared/public-admin.js';

const RETRYABLE_STATUSES = new Set(['failed', 'cancelled', 'needs_attention']);
const EXTERNAL_OWNER_PREFIX = 'user_external_';
const MAX_PUBLIC_TASKS = 50;

type UpstreamResult = {status: number; body: unknown};

export type TestAdminOptions = {
  internalBaseUrl?: string;
  staticDir?: string;
  adminPort?: number;
  now?: () => number;
  uploadsRoot?: string;
  openDirectory?: (directory: string) => Promise<void>;
};

const openLocalDirectory = async (directory: string) => {
  await mkdir(directory, {recursive: true});
  const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [directory], {detached: true, stdio: 'ignore', windowsHide: false});
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object');

const errorPayload = (code: string, message: string, retryable = false, details?: unknown) => ({
  error: {code, message, retryable, ...(details === undefined ? {} : {details})},
});

const sendUpstream = (response: Response, result: UpstreamResult) => {
  response.status(result.status).json(result.body ?? errorPayload('UPSTREAM_EMPTY_RESPONSE', '本机制作服务返回了空响应。', result.status >= 500));
};

const envelopeData = (body: unknown) => {
  if (!isRecord(body) || !isRecord(body.payload) || !isRecord(body.payload.data)) return undefined;
  return body.payload.data;
};

const taskStatusLabel = (status: string) => ({
  queued: '等待处理',
  analyzing: '正在理解素材',
  retry_waiting: '自动重试等待中',
  planning: '正在智能编排',
  rendering: '正在渲染成片',
  completed: '制作完成',
  failed: '制作失败',
  cancelled: '已取消',
  needs_attention: '需要管理员处理',
}[status] ?? '等待上传');

const toAdminTask = (project: Record<string, unknown>): PublicAdminTask => {
  const generation = isRecord(project.latestGeneration) ? project.latestGeneration : undefined;
  const output = generation && isRecord(generation.output) ? generation.output : undefined;
  const status = typeof generation?.status === 'string'
    ? generation.status
    : Array.isArray(project.assets) && project.assets.length
      ? 'uploaded'
      : 'created';
  const steps: PublicAdminStep[] = Array.isArray(generation?.steps)
    ? generation.steps.map((item) => {
        const step = isRecord(item) ? item : {};
        return {
          name: typeof step.name === 'string' ? step.name : 'unknown',
          status: typeof step.status === 'string' ? step.status : 'pending',
          progress: typeof step.progress === 'number' ? step.progress : 0,
          ...(typeof step.note === 'string' ? {note: step.note} : {}),
          ...(typeof step.errorCode === 'string' ? {errorCode: step.errorCode} : {}),
          ...(typeof step.errorMessage === 'string' ? {errorMessage: step.errorMessage} : {}),
        };
      })
    : [];
  const ownerId = typeof project.ownerId === 'string' ? project.ownerId : '';
  return {
    taskId: String(project.id ?? ''),
    testerId: typeof project.testerId === 'string' ? project.testerId : ownerId.slice(-8) || 'unknown',
    name: typeof project.name === 'string' ? project.name : '公网测试任务',
    assetCount: typeof project.assetCount === 'number' ? project.assetCount : Array.isArray(project.assets) ? project.assets.length : 0,
    status,
    statusLabel: taskStatusLabel(status),
    progress: typeof generation?.progress === 'number' ? generation.progress : 0,
    steps,
    ...(typeof generation?.generationId === 'string' ? {generationId: generation.generationId} : {}),
    ...(typeof generation?.connectionId === 'string' ? {connectionId: generation.connectionId} : {}),
    ...(typeof generation?.model === 'string' ? {model: generation.model} : {}),
    ...(isRecord(generation?.retryState) ? {retryState: generation.retryState as PublicAdminTask['retryState']} : {}),
    ...(isRecord(generation?.error) ? {error: generation.error as PublicAdminTask['error']} : {}),
    canRetry: Boolean(generation?.generationId && RETRYABLE_STATUSES.has(status)),
    outputReady: output?.status === 'ready',
    createdAt: typeof project.createdAt === 'string' ? project.createdAt : new Date(0).toISOString(),
    updatedAt: typeof generation?.updatedAt === 'string'
      ? generation.updatedAt
      : typeof project.updatedAt === 'string'
        ? project.updatedAt
        : new Date(0).toISOString(),
  };
};

const isLoopback = (address: string | undefined) => address === '127.0.0.1'
  || address === '::1'
  || address === '::ffff:127.0.0.1';

export const createTestAdmin = (options: TestAdminOptions = {}) => {
  const internalBaseUrl = (options.internalBaseUrl ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
  const staticDir = path.resolve(options.staticDir ?? path.join(process.cwd(), 'dist'));
  const adminPort = options.adminPort ?? 8791;
  const now = options.now ?? Date.now;
  const uploadsRoot = path.resolve(options.uploadsRoot ?? path.join(process.env.DATA_ROOT ?? path.join(process.cwd(), 'data'), 'auto-video', 'originals'));
  const openDirectory = options.openDirectory ?? openLocalDirectory;
  const app = express();

  const internalHeaders = (extra?: Record<string, string>) => ({
    'x-tenant-id': 'tenant_demo',
    'x-user-id': 'user_admin_public_test',
    'x-role': 'admin',
    ...extra,
  });

  const callInternal = async (pathname: string, init?: RequestInit): Promise<UpstreamResult> => {
    try {
      const result = await fetch(`${internalBaseUrl}${pathname}`, {
        ...init,
        headers: {...internalHeaders(), ...(init?.headers ?? {})},
        signal: init?.signal ?? AbortSignal.timeout(60_000),
      });
      const raw = await result.text();
      let body: unknown;
      try { body = raw ? JSON.parse(raw) : undefined; } catch { body = errorPayload('UPSTREAM_INVALID_RESPONSE', raw || result.statusText, result.status >= 500); }
      return {status: result.status, body};
    } catch (error) {
      const source = error instanceof Error ? error as Error & {code?: unknown} : undefined;
      return {
        status: 503,
        body: errorPayload(
          typeof source?.code === 'string' ? source.code : 'LOCAL_SERVICE_UNAVAILABLE',
          source?.message ?? String(error),
          true,
        ),
      };
    }
  };

  const getExternalProject = async (taskId: string) => {
    const result = await callInternal(`/api/projects/${encodeURIComponent(taskId)}`);
    if (result.status >= 400 || !isRecord(result.body)) return {result};
    const ownerId = typeof result.body.ownerId === 'string' ? result.body.ownerId : '';
    if (!ownerId.startsWith(EXTERNAL_OWNER_PREFIX)) {
      return {result: {status: 404, body: errorPayload('ADMIN_PUBLIC_TASK_NOT_FOUND', '未找到这个公网测试任务。')}};
    }
    return {result, project: result.body};
  };

  app.disable('x-powered-by');
  app.use((request, response, next) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('x-frame-options', 'DENY');
    response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (!isLoopback(request.socket.remoteAddress)) {
      response.status(403).json(errorPayload('ADMIN_LOCAL_ONLY', '管理员监控面板只能从本机访问。'));
      return;
    }
    const origin = request.headers.origin;
    if (origin) {
      try {
        const parsed = new URL(origin);
        if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.port !== String(adminPort)) {
          response.status(403).json(errorPayload('ADMIN_ORIGIN_REJECTED', '管理员操作来源无效。'));
          return;
        }
      } catch {
        response.status(403).json(errorPayload('ADMIN_ORIGIN_REJECTED', '管理员操作来源无效。'));
        return;
      }
    }
    next();
  });

  const requireAdminMutation = (request: Request, response: Response, next: NextFunction) => {
    if (request.headers['x-washcut-admin-request'] !== '1') {
      response.status(403).json(errorPayload('ADMIN_CONFIRMATION_HEADER_REQUIRED', '管理员操作缺少本机确认标识。'));
      return;
    }
    next();
  };

  app.get('/api/admin/snapshot', async (_request, response) => {
    const [projectsResult, keysResult, connectionResult] = await Promise.all([
      callInternal(`/api/admin/public-test/projects?limit=${MAX_PUBLIC_TASKS}`),
      callInternal('/api/keys'),
      callInternal('/api/model-connection/status'),
    ]);
    const failed = [projectsResult, keysResult, connectionResult].find((result) => result.status >= 400);
    if (failed) { sendUpstream(response, failed); return; }
    const projectsBody = isRecord(projectsResult.body) ? projectsResult.body : {};
    const summaries = Array.isArray(projectsBody.projects) ? projectsBody.projects.filter(isRecord) : [];
    const tasks = summaries.map(toAdminTask);
    const keyData = envelopeData(keysResult.body);
    const keys = Array.isArray(keyData?.keys) ? keyData.keys as RelayKeySummary[] : [];
    const connectionStatus = isRecord(connectionResult.body)
      ? connectionResult.body as PublicAdminConnectionStatus
      : {mode: 'local' as const, message: '未读取到模型连接状态。'};
    const snapshot: PublicAdminSnapshot = {tasks, keys, connectionStatus, refreshedAt: new Date(now()).toISOString()};
    response.json(snapshot);
  });

  app.get('/api/admin/tasks/:taskId/conversations', async (request, response) => {
    const owned = await getExternalProject(String(request.params.taskId));
    if (!owned.project) { sendUpstream(response, owned.result); return; }
    const limit = Math.max(1, Math.min(200, Number(request.query.limit) || 100));
    const result = await callInternal(`/api/model-conversations?projectId=${encodeURIComponent(String(request.params.taskId))}&limit=${limit}`);
    if (result.status >= 400) { sendUpstream(response, result); return; }
    response.json(result.body);
  });

  app.get('/api/admin/conversations/:conversationId', async (request, response) => {
    const result = await callInternal(`/api/model-conversations/${encodeURIComponent(String(request.params.conversationId))}`);
    if (result.status >= 400 || !isRecord(result.body)) { sendUpstream(response, result); return; }
    if (!String(result.body.ownerId ?? '').startsWith(EXTERNAL_OWNER_PREFIX)) {
      response.status(404).json(errorPayload('ADMIN_PUBLIC_CONVERSATION_NOT_FOUND', '未找到这条公网测试模型记录。'));
      return;
    }
    response.json(result.body);
  });

  app.post('/api/admin/keys/:keyId/activate', requireAdminMutation, async (request, response) => {
    const result = await callInternal(`/api/keys/${encodeURIComponent(String(request.params.keyId))}/activate`, {method: 'POST'});
    if (result.status >= 400) { sendUpstream(response, result); return; }
    response.json(envelopeData(result.body) ?? result.body);
  });

  app.post('/api/admin/keys/:keyId/test', requireAdminMutation, async (request, response) => {
    const result = await callInternal(`/api/keys/${encodeURIComponent(String(request.params.keyId))}/test`, {method: 'POST'});
    if (result.status >= 400) { sendUpstream(response, result); return; }
    response.json(envelopeData(result.body) ?? result.body);
  });

  app.post('/api/admin/uploads/open', requireAdminMutation, async (_request, response) => {
    try {
      await openDirectory(uploadsRoot);
      response.status(202).json({opened: true});
    } catch (error) {
      const source = error instanceof Error ? error as Error & {code?: unknown} : undefined;
      response.status(500).json(errorPayload(
        typeof source?.code === 'string' ? source.code : 'OPEN_UPLOADS_FOLDER_FAILED',
        source?.message ?? String(error),
        false,
      ));
    }
  });

  app.post('/api/admin/tasks/:taskId/retry', requireAdminMutation, express.json({limit: '2kb'}), async (request, response) => {
    const taskId = String(request.params.taskId);
    const owned = await getExternalProject(taskId);
    if (!owned.project) { sendUpstream(response, owned.result); return; }
    const generation = isRecord(owned.project.latestGeneration) ? owned.project.latestGeneration : undefined;
    const generationId = typeof generation?.generationId === 'string' ? generation.generationId : undefined;
    const status = typeof generation?.status === 'string' ? generation.status : undefined;
    if (!generationId || !status || !RETRYABLE_STATUSES.has(status)) {
      response.status(409).json(errorPayload('ADMIN_TASK_NOT_RETRYABLE', '当前任务不需要或不能人工重试。'));
      return;
    }
    const requestedConnectionId = typeof request.body?.connectionId === 'string' ? request.body.connectionId : undefined;
    let connectionChanged = false;
    if (requestedConnectionId && requestedConnectionId !== generation?.connectionId) {
      const switchResult = await callInternal(
        `/api/projects/${encodeURIComponent(taskId)}/generations/${encodeURIComponent(generationId)}/model-connection`,
        {method: 'PATCH', headers: {'content-type': 'application/json'}, body: JSON.stringify({connectionId: requestedConnectionId})},
      );
      if (switchResult.status >= 400) { sendUpstream(response, switchResult); return; }
      connectionChanged = true;
    }
    const action = status === 'failed' ? 'retry' : 'resume';
    const retryResult = await callInternal(
      `/api/projects/${encodeURIComponent(taskId)}/generations/${encodeURIComponent(generationId)}/${action}`,
      {method: 'POST'},
    );
    if (retryResult.status >= 400) { sendUpstream(response, retryResult); return; }
    response.status(202).json({accepted: true, action, connectionChanged, generationId});
  });

  app.use('/assets', express.static(path.join(staticDir, 'assets'), {fallthrough: false, immutable: true, maxAge: '1y'}));
  app.get('/', (_request, response) => response.redirect(302, '/admin'));
  app.get('/admin', (_request, response) => response.sendFile(path.join(staticDir, 'index.html')));
  app.get('/favicon.ico', (_request, response) => response.sendStatus(204));
  app.use((request, response) => response.status(404).json(errorPayload('ADMIN_ROUTE_NOT_FOUND', `本机管理员接口不存在：${request.method} ${request.path}`)));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const source = isRecord(error) ? error : {};
    const status = typeof source.status === 'number' && source.status >= 400 && source.status <= 599 ? source.status : 500;
    const code = typeof source.code === 'string' ? source.code : 'ADMIN_DASHBOARD_ERROR';
    response.status(status).json(errorPayload(code, error instanceof Error ? error.message : String(error), status >= 500));
  });

  return app;
};
