import {createHash, randomUUID, timingSafeEqual} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import path from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import express, {type NextFunction, type Request, type Response} from 'express';
import {
  AUTO_VIDEO_VISUAL_CONCURRENCY_DEFAULT,
  AUTO_VIDEO_VISUAL_CONCURRENCY_MAX,
  AUTO_VIDEO_VISUAL_CONCURRENCY_MIN,
} from '../shared/auto-video-contracts.js';

const SESSION_COOKIE = 'washcut_test_session';
const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_UPLOAD_BYTES = 1_000 * 1024 * 1024;
const MONITOR_TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'needs_attention']);
const MONITOR_INTERVAL_MS = 2_500;
const MODEL_LOG_TEXT_LIMIT = 6_000;
const STEP_LABELS: Record<string, string> = {
  probe: '媒体检测',
  extract_audio: '音频提取',
  transcription: '语音转写',
  screenshots: '关键画面采样',
  visual_analysis: '画面分析',
  asset_understanding: '整理素材结论',
  planning: '智能编排',
  timeline: '确定时间线',
  captions: '生成字幕',
  render: '渲染成片',
};
const MODEL_SOURCE_LABELS: Record<string, string> = {
  'auto-video.screenshot-analysis': '截图视觉分析',
  'auto-video.visual-repair': '视觉结果修复',
  'auto-video.asset-understanding': '素材综合理解',
  'auto-video.marketing-role-batch': '营销作用标注',
  'auto-video.edit-planning': '自动编排',
};

type TestSession = {
  userId: string;
  expiresAt: number;
  projectIds: Set<string>;
};

type UpstreamResult = {
  status: number;
  body: unknown;
};

export type TestGatewayOptions = {
  accessCode: string;
  internalBaseUrl?: string;
  staticDir?: string;
  sessionTtlMs?: number;
  maxUploadBytes?: number;
  visualConcurrency?: number;
  consoleMonitor?: boolean;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  now?: () => number;
};

type AuthenticatedRequest = Request & {testSession?: TestSession};

type ModelConversationSummary = {
  id: string;
  source?: string;
  model?: string;
  status?: string;
  requestPreview?: string;
  responsePreview?: string;
  completedAt?: string;
};

const redactConsoleText = (value: unknown) => String(value ?? '')
  .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, '$1[已隐藏]')
  .replace(/((?:api[_-]?key|access[_-]?code|cookie)\s*[:=]\s*)[^\s,;]+/gi, '$1[已隐藏]')
  .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/g, '[已隐藏]');

const oneLine = (value: unknown, limit = 900) => {
  const text = redactConsoleText(value).replace(/\s+/g, ' ').trim();
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
};

const modelText = (value: unknown) => {
  const text = redactConsoleText(value).trim();
  return text.length <= MODEL_LOG_TEXT_LIMIT
    ? text
    : `${text.slice(0, MODEL_LOG_TEXT_LIMIT)}\n…（命令行已截断，完整内容可在本机“模型对话记录”中查看）`;
};

const parseCookies = (value: string | undefined) => Object.fromEntries(
  (value ?? '').split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const separator = part.indexOf('=');
    return separator < 0
      ? [decodeURIComponent(part), '']
      : [decodeURIComponent(part.slice(0, separator)), decodeURIComponent(part.slice(separator + 1))];
  }),
);

const sameSecret = (left: string, right: string) => {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
};

const publicError = (response: Response, status: number, code: string, message: string, retryable = false, details?: unknown) => {
  response.status(status).json({error: {code, message, retryable, ...(details === undefined ? {} : {details})}});
};

const readJsonBody = async (response: globalThis.Response): Promise<unknown> => {
  const raw = await response.text();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {error: {code: 'UPSTREAM_INVALID_RESPONSE', message: raw, retryable: response.status >= 500}};
  }
};

const upstreamFailure = (response: Response, result: UpstreamResult) => {
  response.status(result.status).json(result.body ?? {
    error: {code: 'UPSTREAM_EMPTY_RESPONSE', message: '本机制作服务返回了空响应。', retryable: result.status >= 500},
  });
};

const statusLabel = (status: string | undefined) => ({
  queued: '等待处理',
  analyzing: '正在理解素材',
  retry_waiting: '等待本机服务恢复',
  planning: '正在智能编排',
  rendering: '正在渲染成片',
  completed: '制作完成',
  failed: '制作失败',
  cancelled: '已取消',
  needs_attention: '需要本机管理员处理',
}[status ?? ''] ?? '等待上传');

const publicTask = (project: Record<string, unknown>) => {
  const assets = Array.isArray(project.assets) ? project.assets : [];
  const generation = project.latestGeneration && typeof project.latestGeneration === 'object'
    ? project.latestGeneration as Record<string, unknown>
    : undefined;
  const output = generation?.output && typeof generation.output === 'object'
    ? generation.output as Record<string, unknown>
    : undefined;
  const steps = Array.isArray(generation?.steps)
    ? generation.steps.map((step) => {
      const value = step && typeof step === 'object' ? step as Record<string, unknown> : {};
      return {
        name: typeof value.name === 'string' ? value.name : 'unknown',
        status: typeof value.status === 'string' ? value.status : 'pending',
        progress: typeof value.progress === 'number' ? value.progress : 0,
        note: typeof value.note === 'string' ? value.note : undefined,
        errorCode: typeof value.errorCode === 'string' ? value.errorCode : undefined,
        errorMessage: typeof value.errorMessage === 'string' ? value.errorMessage : undefined,
      };
    })
    : [];
  const error = generation?.error && typeof generation.error === 'object'
    ? generation.error as Record<string, unknown>
    : undefined;

  return {
    taskId: String(project.id ?? ''),
    assetCount: assets.length,
    status: typeof generation?.status === 'string' ? generation.status : assets.length ? 'uploaded' : 'created',
    statusLabel: statusLabel(typeof generation?.status === 'string' ? generation.status : undefined),
    progress: typeof generation?.progress === 'number' ? generation.progress : 0,
    steps,
    outputReady: output?.status === 'ready' && typeof output.videoUrl === 'string',
    captionedOutputReady: output?.status === 'ready' && typeof output.captionedVideoUrl === 'string',
    // Retry is an administrator-only action on the separate loopback dashboard.
    canRetry: false,
    error: error ? {
      code: typeof error.code === 'string' ? error.code : 'UNKNOWN_ERROR',
      message: typeof error.message === 'string' ? error.message : '制作失败。',
      retryable: error.retryable === true,
      details: error.details,
    } : undefined,
    updatedAt: typeof generation?.updatedAt === 'string' ? generation.updatedAt : project.updatedAt,
  };
};

export const createTestGateway = (options: TestGatewayOptions) => {
  if (!options.accessCode.trim()) throw new Error('WASHCUT_TEST_ACCESS_CODE is required');
  const internalBaseUrl = (options.internalBaseUrl ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
  const staticDir = path.resolve(options.staticDir ?? path.join(process.cwd(), 'dist'));
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const maxUploadBytes = options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  const visualConcurrency = options.visualConcurrency ?? AUTO_VIDEO_VISUAL_CONCURRENCY_DEFAULT;
  if (!Number.isSafeInteger(visualConcurrency)
    || visualConcurrency < AUTO_VIDEO_VISUAL_CONCURRENCY_MIN
    || visualConcurrency > AUTO_VIDEO_VISUAL_CONCURRENCY_MAX) {
    throw new Error(`WASHCUT_TEST_VISUAL_CONCURRENCY must be an integer between ${AUTO_VIDEO_VISUAL_CONCURRENCY_MIN} and ${AUTO_VIDEO_VISUAL_CONCURRENCY_MAX}`);
  }
  const now = options.now ?? Date.now;
  const consoleMonitor = options.consoleMonitor ?? true;
  const logger = options.logger ?? console;
  const sessions = new Map<string, TestSession>();
  const loginAttempts = new Map<string, {startedAt: number; failures: number}>();
  const taskSnapshots = new Map<string, string>();
  const modelConversationStates = new Map<string, string>();
  const taskMonitors = new Map<string, ReturnType<typeof setInterval>>();
  const taskMonitorInFlight = new Set<string>();
  const app = express();

  const sessionTag = (session: TestSession) => session.userId.slice(-8);
  const monitorKey = (session: TestSession, projectId: string) => `${session.userId}:${projectId}`;
  const writeMonitor = (level: 'log' | 'warn' | 'error', category: string, message: string, fields: Record<string, unknown> = {}) => {
    if (!consoleMonitor) return;
    const details = Object.entries(fields)
      .filter(([, value]) => value !== undefined && value !== '')
      .map(([key, value]) => `${key}=${oneLine(value)}`)
      .join(' | ');
    logger[level](`[washcut-test ${new Date(now()).toLocaleTimeString('zh-CN', {hour12: false})}] [${category}] ${message}${details ? ` | ${details}` : ''}`);
  };

  const writeModelConversation = (session: TestSession, projectId: string, detail: Record<string, unknown>) => {
    if (!consoleMonitor) return;
    const messages = Array.isArray(detail.requestMessages) ? detail.requestMessages : [];
    const requestText = messages.map((message) => {
      const value = message && typeof message === 'object' ? message as Record<string, unknown> : {};
      const role = typeof value.role === 'string' ? value.role : 'unknown';
      const label = typeof value.label === 'string' ? ` ${value.label}` : '';
      return `[${role}${label}]\n${modelText(value.content)}`;
    }).join('\n\n');
    const source = typeof detail.source === 'string' ? detail.source : 'model';
    const status = typeof detail.status === 'string' ? detail.status : 'unknown';
    const header = `[washcut-test ${new Date(now()).toLocaleTimeString('zh-CN', {hour12: false})}] [模型对话] ${MODEL_SOURCE_LABELS[source] ?? source} | 测试者=${sessionTag(session)} | 任务=${projectId} | 模型=${oneLine(detail.model)} | 状态=${status} | 耗时=${typeof detail.latencyMs === 'number' ? `${detail.latencyMs}ms` : '-'} | 尝试=${typeof detail.attempts === 'number' ? detail.attempts : '-'}`;
    const responseText = status === 'failed'
      ? `[调用错误 ${oneLine(detail.errorCode ?? 'unknown_error')}]\n${modelText(detail.errorMessage ?? '模型调用未完成')}`
      : `[模型 → 程序]\n${modelText(detail.responseText ?? '（模型没有返回文本）')}`;
    logger[status === 'failed' ? 'error' : 'log'](`${header}\n--- 程序发送 ---\n${requestText || '（没有可展示的文本输入）'}\n--- 模型返回 ---\n${responseText}\n--- 对话结束 ---`);
  };

  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');

  const internalHeaders = (session: TestSession, extra?: Record<string, string>) => ({
    'x-tenant-id': 'tenant_demo',
    'x-user-id': session.userId,
    'x-role': 'producer',
    ...extra,
  });

  const callInternal = async (session: TestSession, pathname: string, init?: RequestInit): Promise<UpstreamResult> => {
    try {
      const response = await fetch(`${internalBaseUrl}${pathname}`, {
        ...init,
        headers: {...internalHeaders(session), ...(init?.headers ?? {})},
      });
      const body = await readJsonBody(response);
      if (response.status >= 400) {
        const upstreamError = body && typeof body === 'object' && 'error' in body && body.error && typeof body.error === 'object'
          ? body.error as Record<string, unknown>
          : undefined;
        writeMonitor('error', '问题', '本机制作服务返回错误', {
          测试者: sessionTag(session), 接口: pathname, HTTP: response.status,
          错误码: upstreamError?.code, 错误: upstreamError?.message,
          可重试: upstreamError?.retryable,
        });
      }
      return {status: response.status, body};
    } catch (error) {
      writeMonitor('error', '问题', '本机制作服务连接失败', {测试者: sessionTag(session), 接口: pathname, 错误: error instanceof Error ? error.message : String(error)});
      return {
        status: 503,
        body: {error: {
          code: error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'LOCAL_SERVICE_UNAVAILABLE',
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        }},
      };
    }
  };

  const observeModelConversations = async (session: TestSession, projectId: string) => {
    if (!consoleMonitor) return;
    const listResult = await callInternal(session, `/api/model-conversations?projectId=${encodeURIComponent(projectId)}&limit=50`);
    if (listResult.status >= 400) {
      writeMonitor('warn', '模型对话', '暂时无法读取本机模型对话记录', {测试者: sessionTag(session), 任务: projectId, HTTP: listResult.status});
      return;
    }
    const payload = listResult.body && typeof listResult.body === 'object' ? listResult.body as Record<string, unknown> : {};
    const conversations = Array.isArray(payload.conversations) ? payload.conversations as ModelConversationSummary[] : [];
    for (const summary of [...conversations].reverse()) {
      if (!summary || typeof summary.id !== 'string') continue;
      const key = `${session.userId}:${summary.id}`;
      const state = `${summary.status ?? 'unknown'}:${summary.completedAt ?? ''}`;
      if (modelConversationStates.get(key) === state) continue;
      modelConversationStates.set(key, state);
      if (summary.status === 'streaming') {
        writeMonitor('log', '模型请求', MODEL_SOURCE_LABELS[summary.source ?? ''] ?? summary.source ?? '模型调用', {
          测试者: sessionTag(session), 任务: projectId, 模型: summary.model, 发送摘要: summary.requestPreview,
        });
        continue;
      }
      const detailResult = await callInternal(session, `/api/model-conversations/${encodeURIComponent(summary.id)}`);
      if (detailResult.status >= 400 || !detailResult.body || typeof detailResult.body !== 'object') {
        writeMonitor('warn', '模型对话', '对话详情读取失败', {任务: projectId, 对话: summary.id, HTTP: detailResult.status});
        continue;
      }
      writeModelConversation(session, projectId, detailResult.body as Record<string, unknown>);
    }
    while (modelConversationStates.size > 2_000) {
      const oldest = modelConversationStates.keys().next().value;
      if (typeof oldest !== 'string') break;
      modelConversationStates.delete(oldest);
    }
  };

  const recordTaskProgress = (session: TestSession, task: ReturnType<typeof publicTask>) => {
    if (!consoleMonitor) return;
    const key = monitorKey(session, task.taskId);
    const signature = JSON.stringify([
      task.status,
      task.progress,
      task.steps.map((step) => [step.name, step.status, step.progress, step.errorCode, step.errorMessage]),
      task.error?.code,
      task.error?.message,
    ]);
    if (taskSnapshots.get(key) === signature) return;
    taskSnapshots.set(key, signature);
    const activeSteps = task.steps
      .filter((step) => step.status !== 'pending')
      .map((step) => `${STEP_LABELS[step.name] ?? step.name}:${step.status}${step.status === 'running' || step.status === 'retry_waiting' ? ` ${step.progress}%` : ''}`)
      .join(', ');
    writeMonitor(task.error ? 'error' : 'log', task.error ? '问题' : '进度', `${task.statusLabel} ${task.progress}%`, {
      测试者: sessionTag(session), 任务: task.taskId, 素材: task.assetCount, 环节: activeSteps,
      错误码: task.error?.code, 错误: task.error?.message, 可重试: task.error?.retryable,
    });
  };

  const stopTaskMonitor = (session: TestSession, projectId: string) => {
    const key = monitorKey(session, projectId);
    const timer = taskMonitors.get(key);
    if (timer) clearInterval(timer);
    taskMonitors.delete(key);
  };

  const monitorTaskOnce = async (session: TestSession, projectId: string) => {
    const key = monitorKey(session, projectId);
    if (taskMonitorInFlight.has(key)) return;
    taskMonitorInFlight.add(key);
    try {
      const result = await callInternal(session, `/api/projects/${encodeURIComponent(projectId)}`);
      if (result.status >= 400 || !result.body || typeof result.body !== 'object') {
        writeMonitor('warn', '进度', '任务状态读取失败', {测试者: sessionTag(session), 任务: projectId, HTTP: result.status});
        return;
      }
      const task = publicTask(result.body as Record<string, unknown>);
      recordTaskProgress(session, task);
      await observeModelConversations(session, projectId);
      if (MONITOR_TERMINAL_STATUSES.has(task.status)) stopTaskMonitor(session, projectId);
    } finally {
      taskMonitorInFlight.delete(key);
    }
  };

  const ensureTaskMonitor = (session: TestSession, projectId: string) => {
    if (!consoleMonitor) return;
    const key = monitorKey(session, projectId);
    if (taskMonitors.has(key)) return;
    const timer = setInterval(() => {
      void monitorTaskOnce(session, projectId).catch((error) => writeMonitor('error', '问题', '任务监控失败', {任务: projectId, 错误: error instanceof Error ? error.message : String(error)}));
    }, MONITOR_INTERVAL_MS);
    timer.unref();
    taskMonitors.set(key, timer);
    void monitorTaskOnce(session, projectId).catch((error) => writeMonitor('error', '问题', '任务监控失败', {任务: projectId, 错误: error instanceof Error ? error.message : String(error)}));
  };

  const requireSession = (request: AuthenticatedRequest, response: Response, next: NextFunction) => {
    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    const session = token ? sessions.get(token) : undefined;
    if (!session || session.expiresAt <= now()) {
      if (token) sessions.delete(token);
      if (request.method !== 'GET' || request.path !== '/session') writeMonitor('warn', '访问', '未登录请求已拒绝', {操作: `${request.method} ${request.path}`});
      publicError(response, 401, 'TEST_SESSION_REQUIRED', '请输入测试访问码后继续。');
      return;
    }
    request.testSession = session;
    next();
  };

  const requireTask = (request: AuthenticatedRequest, response: Response, next: NextFunction) => {
    if (!request.testSession?.projectIds.has(String(request.params.taskId))) {
      writeMonitor('warn', '安全', '跨会话任务操作已拒绝', {测试者: request.testSession ? sessionTag(request.testSession) : undefined, 任务: String(request.params.taskId), 操作: `${request.method} ${request.path}`});
      publicError(response, 404, 'TEST_TASK_NOT_FOUND', '未找到这个测试任务。');
      return;
    }
    next();
  };

  app.use('/api/test', (request, response, next) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    next();
  });

  app.post('/api/test/login', express.json({limit: '2kb'}), (request, response) => {
    const address = request.ip || request.socket.remoteAddress || 'unknown';
    const attempt = loginAttempts.get(address);
    const current = !attempt || now() - attempt.startedAt > 10 * 60_000
      ? {startedAt: now(), failures: 0}
      : attempt;
    if (current.failures >= 10) {
      writeMonitor('warn', '访问', '访问码尝试次数过多，已限流');
      publicError(response, 429, 'TEST_LOGIN_RATE_LIMITED', '访问码尝试次数过多，请十分钟后再试。', true);
      return;
    }
    const accessCode = typeof request.body?.accessCode === 'string' ? request.body.accessCode : '';
    if (!sameSecret(accessCode, options.accessCode)) {
      current.failures += 1;
      loginAttempts.set(address, current);
      writeMonitor('warn', '访问', '访问码错误', {本轮失败次数: current.failures});
      publicError(response, 401, 'TEST_ACCESS_CODE_INVALID', '测试访问码不正确。');
      return;
    }
    loginAttempts.delete(address);
    const token = randomUUID().replaceAll('-', '');
    const session: TestSession = {
      userId: `user_external_${randomUUID().replaceAll('-', '')}`,
      expiresAt: now() + sessionTtlMs,
      projectIds: new Set(),
    };
    sessions.set(token, session);
    writeMonitor('log', '访问', '测试人员登录成功', {测试者: sessionTag(session), 会话有效至: new Date(session.expiresAt).toLocaleString('zh-CN', {hour12: false})});
    const secure = request.secure || request.headers['x-forwarded-proto'] === 'https';
    response.setHeader('set-cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(sessionTtlMs / 1_000)}${secure ? '; Secure' : ''}`);
    response.json({authenticated: true, expiresAt: new Date(session.expiresAt).toISOString()});
  });

  app.get('/api/test/session', requireSession, (request: AuthenticatedRequest, response) => {
    response.json({authenticated: true, expiresAt: new Date(request.testSession!.expiresAt).toISOString()});
  });

  app.delete('/api/test/session', requireSession, (request, response) => {
    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    const session = token ? sessions.get(token) : undefined;
    if (session) {
      for (const projectId of session.projectIds) stopTaskMonitor(session, projectId);
      writeMonitor('log', '访问', '测试人员退出', {测试者: sessionTag(session)});
    }
    if (token) sessions.delete(token);
    response.setHeader('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    response.json({authenticated: false});
  });

  app.post('/api/test/tasks', requireSession, express.json({limit: '4kb'}), async (request: AuthenticatedRequest, response) => {
    const instruction = typeof request.body?.instruction === 'string' ? request.body.instruction.trim().slice(0, 2_000) : '';
    const result = await callInternal(request.testSession!, '/api/projects', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        name: `外部测试 ${new Date(now()).toLocaleString('zh-CN', {hour12: false})}`,
        ...(instruction ? {userInstruction: instruction} : {}),
      }),
    });
    if (result.status >= 400) { upstreamFailure(response, result); return; }
    const project = result.body && typeof result.body === 'object' ? result.body as Record<string, unknown> : undefined;
    const projectId = typeof project?.id === 'string' ? project.id : undefined;
    if (!projectId) { publicError(response, 502, 'UPSTREAM_INVALID_RESPONSE', '本机制作服务没有返回任务编号。', true); return; }
    request.testSession!.projectIds.add(projectId);
    writeMonitor('log', '操作', '新建视频制作任务', {测试者: sessionTag(request.testSession!), 任务: projectId, 包含补充说明: Boolean(instruction)});
    response.status(201).json({taskId: projectId});
  });

  app.post('/api/test/tasks/:taskId/assets', requireSession, requireTask, (request: AuthenticatedRequest, response) => {
    const contentType = request.headers['content-type'];
    if (!contentType?.startsWith('multipart/form-data')) {
      publicError(response, 415, 'TEST_MULTIPART_REQUIRED', '上传请求必须使用 multipart/form-data。');
      return;
    }
    const announcedLength = Number(request.headers['content-length']);
    if (Number.isFinite(announcedLength) && announcedLength > maxUploadBytes) {
      publicError(response, 413, 'TEST_UPLOAD_TOO_LARGE', `单次上传总大小不能超过 ${Math.floor(maxUploadBytes / 1024 / 1024)} MB。`);
      return;
    }
    writeMonitor('log', '操作', '开始上传素材', {测试者: sessionTag(request.testSession!), 任务: String(request.params.taskId), 声明大小: Number.isFinite(announcedLength) ? `${(announcedLength / 1024 / 1024).toFixed(1)} MB` : '未知'});

    const target = new URL(`${internalBaseUrl}/api/projects/${encodeURIComponent(String(request.params.taskId))}/assets`);
    let received = 0;
    let settled = false;
    const finishFailure = (status: number, code: string, message: string, retryable = false) => {
      if (settled) return;
      settled = true;
      writeMonitor('error', '问题', '素材上传失败', {测试者: sessionTag(request.testSession!), 任务: String(request.params.taskId), 错误码: code, 错误: message, 可重试: retryable});
      publicError(response, status, code, message, retryable);
    };
    const upstream = httpRequest(target, {
      method: 'POST',
      headers: {
        ...internalHeaders(request.testSession!),
        'content-type': contentType,
        ...(request.headers['content-length'] ? {'content-length': request.headers['content-length']} : {}),
      },
    }, (upstreamResponse) => {
      const chunks: Buffer[] = [];
      upstreamResponse.on('data', (chunk: Buffer) => chunks.push(chunk));
      upstreamResponse.on('end', () => {
        if (settled) return;
        settled = true;
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: unknown;
        try { body = raw ? JSON.parse(raw) : undefined; } catch { body = undefined; }
        const status = upstreamResponse.statusCode ?? 502;
        if (status >= 400) {
          const upstreamError = body && typeof body === 'object' && 'error' in body && body.error && typeof body.error === 'object' ? body.error as Record<string, unknown> : undefined;
          writeMonitor('error', '问题', '本机制作服务拒绝素材上传', {测试者: sessionTag(request.testSession!), 任务: String(request.params.taskId), HTTP: status, 错误码: upstreamError?.code, 错误: upstreamError?.message ?? raw});
          response.status(status).json(body ?? {error: {code: 'UPSTREAM_INVALID_RESPONSE', message: raw || '上传失败。', retryable: status >= 500}});
          return;
        }
        const payload = body && typeof body === 'object' ? body as Record<string, unknown> : undefined;
        const assets = Array.isArray(payload?.assets) ? payload.assets : [];
        writeMonitor('log', '操作', '素材上传完成', {测试者: sessionTag(request.testSession!), 任务: String(request.params.taskId), 素材数: assets.length, 接收大小: `${(received / 1024 / 1024).toFixed(1)} MB`});
        response.status(201).json({assetCount: assets.length});
      });
    });
    upstream.on('error', (error: NodeJS.ErrnoException) => finishFailure(503, error.code ?? 'LOCAL_SERVICE_UNAVAILABLE', error.message, true));
    request.on('data', (chunk: Buffer) => {
      if (settled) return;
      received += chunk.length;
      if (received > maxUploadBytes) {
        upstream.destroy();
        request.resume();
        finishFailure(413, 'TEST_UPLOAD_TOO_LARGE', `单次上传总大小不能超过 ${Math.floor(maxUploadBytes / 1024 / 1024)} MB。`);
        return;
      }
      if (!upstream.write(chunk)) {
        request.pause();
        upstream.once('drain', () => request.resume());
      }
    });
    request.on('end', () => { if (!settled) upstream.end(); });
    request.on('aborted', () => { upstream.destroy(); finishFailure(499, 'TEST_UPLOAD_ABORTED', '上传已中断。', true); });
    request.on('error', (error: NodeJS.ErrnoException) => { upstream.destroy(); finishFailure(400, error.code ?? 'TEST_UPLOAD_FAILED', error.message, true); });
  });

  app.post('/api/test/tasks/:taskId/start', requireSession, requireTask, express.json({limit: '2kb'}), async (request: AuthenticatedRequest, response) => {
    const projectId = String(request.params.taskId);
    const result = await callInternal(request.testSession!, `/api/projects/${encodeURIComponent(projectId)}/generations`, {
      method: 'POST',
      headers: {'content-type': 'application/json', 'x-idempotency-key': `external-test:${projectId}`},
      body: JSON.stringify({
        mode: 'ai',
        reasoningEffort: 'low',
        visualConcurrency,
        transcriptionSelection: {providerId: 'qwen3-asr'},
      }),
    });
    if (result.status >= 400) { upstreamFailure(response, result); return; }
    const payload = result.body && typeof result.body === 'object' ? result.body as Record<string, unknown> : {};
    const generation = payload.generation && typeof payload.generation === 'object' ? payload.generation as Record<string, unknown> : {};
    writeMonitor('log', '操作', '点击开始制作', {测试者: sessionTag(request.testSession!), 任务: projectId, 制作轮次: generation.generationId, 画面并发: visualConcurrency});
    ensureTaskMonitor(request.testSession!, projectId);
    response.status(202).json({taskId: projectId, generationId: generation.generationId});
  });

  app.get('/api/test/tasks/:taskId', requireSession, requireTask, async (request: AuthenticatedRequest, response) => {
    const result = await callInternal(request.testSession!, `/api/projects/${encodeURIComponent(String(request.params.taskId))}`);
    if (result.status >= 400) { upstreamFailure(response, result); return; }
    const project = result.body && typeof result.body === 'object' ? result.body as Record<string, unknown> : undefined;
    if (!project) { publicError(response, 502, 'UPSTREAM_INVALID_RESPONSE', '本机制作服务没有返回任务状态。', true); return; }
    const task = publicTask(project);
    recordTaskProgress(request.testSession!, task);
    response.json(task);
  });

  app.post('/api/test/tasks/:taskId/retry', requireSession, requireTask, (_request, response) => {
    publicError(response, 403, 'TEST_ADMIN_RETRY_REQUIRED', '任务重试由制作方管理员在本机监控面板处理。');
  });

  app.get('/api/test/tasks/:taskId/download/:variant', requireSession, requireTask, async (request: AuthenticatedRequest, response) => {
    const projectId = String(request.params.taskId);
    writeMonitor('log', '操作', '点击下载成片', {测试者: sessionTag(request.testSession!), 任务: projectId, 版本: request.params.variant});
    const projectResult = await callInternal(request.testSession!, `/api/projects/${encodeURIComponent(projectId)}`);
    if (projectResult.status >= 400) { upstreamFailure(response, projectResult); return; }
    const project = projectResult.body && typeof projectResult.body === 'object' ? projectResult.body as Record<string, unknown> : {};
    const generation = project.latestGeneration && typeof project.latestGeneration === 'object'
      ? project.latestGeneration as Record<string, unknown>
      : undefined;
    const generationId = typeof generation?.generationId === 'string' ? generation.generationId : undefined;
    if (!generationId || generation?.status !== 'completed') {
      publicError(response, 409, 'TEST_OUTPUT_NOT_READY', '成片尚未完成，请稍后再试。', true);
      return;
    }

    let signedUrl: string | undefined;
    if (request.params.variant === 'plain') {
      const output = generation.output && typeof generation.output === 'object' ? generation.output as Record<string, unknown> : {};
      signedUrl = typeof output.videoUrl === 'string' ? output.videoUrl : undefined;
    } else if (request.params.variant === 'captioned') {
      const result = await callInternal(request.testSession!, `/api/projects/${encodeURIComponent(projectId)}/generations/${encodeURIComponent(generationId)}/output-captioned`, {method: 'POST'});
      if (result.status >= 400) { upstreamFailure(response, result); return; }
      const payload = result.body && typeof result.body === 'object' ? result.body as Record<string, unknown> : {};
      signedUrl = typeof payload.videoUrl === 'string' ? payload.videoUrl : undefined;
    } else {
      publicError(response, 404, 'TEST_DOWNLOAD_VARIANT_NOT_FOUND', '不支持这个下载版本。');
      return;
    }
    if (!signedUrl) { publicError(response, 409, 'TEST_OUTPUT_NOT_READY', '成片尚未准备好。', true); return; }

    try {
      const fileResponse = await fetch(signedUrl);
      if (!fileResponse.ok || !fileResponse.body) {
        publicError(response, fileResponse.status || 502, 'TEST_DOWNLOAD_FAILED', `本机成片读取失败：${fileResponse.status} ${fileResponse.statusText}`, fileResponse.status >= 500);
        return;
      }
      response.status(200);
      response.setHeader('content-type', fileResponse.headers.get('content-type') ?? 'video/mp4');
      const length = fileResponse.headers.get('content-length');
      if (length) response.setHeader('content-length', length);
      response.setHeader('content-disposition', `attachment; filename="washcut-${request.params.variant}.mp4"`);
      response.setHeader('cache-control', 'private, no-store');
      await pipeline(Readable.fromWeb(fileResponse.body as never), response);
      writeMonitor('log', '操作', '成片下载传输完成', {测试者: sessionTag(request.testSession!), 任务: projectId, 版本: request.params.variant, 字节: length});
    } catch (error) {
      writeMonitor('error', '问题', '成片下载失败', {测试者: sessionTag(request.testSession!), 任务: projectId, 版本: request.params.variant, 错误: error instanceof Error ? error.message : String(error)});
      if (!response.headersSent) publicError(response, 503, error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'TEST_DOWNLOAD_FAILED', error instanceof Error ? error.message : String(error), true);
      else response.destroy(error instanceof Error ? error : undefined);
    }
  });

  app.use('/assets', express.static(path.join(staticDir, 'assets'), {fallthrough: false, immutable: true, maxAge: '1y'}));
  app.get('/', (_request, response) => response.redirect(302, '/test'));
  app.get('/test', (_request, response) => response.sendFile(path.join(staticDir, 'index.html')));
  app.get('/favicon.ico', (_request, response) => response.sendStatus(204));
  app.use((request, response) => {
    if (request.path.startsWith('/api/')) writeMonitor('warn', '安全', '未开放的测试接口已拒绝', {操作: `${request.method} ${request.path}`});
    publicError(response, 404, 'TEST_ROUTE_NOT_FOUND', '这个测试页面或接口不存在。');
  });
  app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
    const source = error && typeof error === 'object' ? error as Record<string, unknown> : undefined;
    const rawStatus = typeof source?.status === 'number' ? source.status : typeof source?.statusCode === 'number' ? source.statusCode : 500;
    const status = rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 500;
    const code = typeof source?.code === 'string'
      ? source.code
      : typeof source?.type === 'string'
        ? source.type
        : 'TEST_GATEWAY_ERROR';
    const message = error instanceof Error ? error.message : String(error);
    writeMonitor('error', '问题', '测试网关请求处理失败', {操作: `${request.method} ${request.path}`, 错误码: code, 错误: message, 可重试: status >= 500});
    publicError(response, status, code, message, status >= 500);
  });

  return app;
};
