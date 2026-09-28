import {
  makeEnvelope,
  parseEnvelope,
  parseRegisteredEnvelope,
  type AssetRef,
  type Envelope,
  type EnvelopeContext,
  type ProjectInput,
  type RelayKeyInput,
  type RelayKeySummary,
  type RelayKeyTestResult,
  type RelayKeyUpdate,
  type RelayChatMessage,
  type RelayChatResult,
  type RelayProtocolTestResult,
  type RelayModelDiscoveryInput,
  type RenderJob,
  type TransportError,
} from '../shared/contracts.js';

export const createClientContext = (projectId = `project_${crypto.randomUUID()}`): EnvelopeContext => ({
  tenantId: 'tenant_demo',
  projectId,
  jobId: `job_${crypto.randomUUID()}`,
  traceId: `trc_${crypto.randomUUID()}`,
});

const createClientEnvelope = <T>(context: EnvelopeContext, args: {
  type: string;
  schema: Parameters<typeof makeEnvelope>[0]['schema'];
  data: T;
  idempotencyKey: string;
}) => makeEnvelope({...context, ...args, producer: 'web-app', eventId: `evt_${crypto.randomUUID()}`, occurredAt: new Date().toISOString()});

export const nativeResponseErrorText = (rawBody: string, statusText = '') => {
  try {
    const payload = JSON.parse(rawBody) as {payload?: {data?: {details?: unknown}}};
    const details = payload?.payload?.data?.details;
    if (typeof details === 'string') return details;
    if (details !== undefined) return JSON.stringify(details, null, 2);
  } catch {
    // Non-JSON responses (for example a proxy or browser server error page) are
    // intentionally returned byte-for-byte as decoded response text.
  }
  return rawBody || statusText;
};

const requestEnvelope = async <T>(url: string, expected: {type: string; schema: Parameters<typeof parseEnvelope>[1]['schema']}, init?: RequestInit, nativeError = false): Promise<Envelope<T>> => {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new Error('本地服务连接中断。请确认开发服务仍在运行后重试；若仅在对话测试发生，请检查模型中转地址是否可访问。');
  }
  const rawBody = await response.text();
  if (!response.ok) {
    if (nativeError) throw new Error(nativeResponseErrorText(rawBody, response.statusText));
    let payload: unknown = null;
    try { payload = rawBody ? JSON.parse(rawBody) : null; } catch { throw new Error(rawBody || response.statusText); }
    let failure: Envelope<TransportError> | undefined;
    try { failure = parseEnvelope<TransportError>(payload, {type: 'request.failed', schema: 'error.v1'}); } catch { /* The proxy may return a non-envelope error response. */ }
    if (failure) throw new Error(failure.payload.data.message);
    throw new Error(`请求失败（${response.status}）。请稍后重试；若持续出现，请检查本地服务与模型中转地址。`);
  }
  const payload: unknown = JSON.parse(rawBody);
  return parseEnvelope<T>(payload, expected);
};

const contextHeaders = (context: EnvelopeContext) => ({
  'x-tenant-id': context.tenantId,
  'x-user-id': 'user_demo',
  'x-role': 'producer',
  'x-project-id': context.projectId,
  'x-job-id': context.jobId,
  'x-trace-id': context.traceId,
});

export const uploadAssets = async (files: File[], context: EnvelopeContext) => {
  const form = new FormData();
  files.forEach((file) => form.append('files', file));
  const response = await requestEnvelope<{assets: AssetRef[]}>('/api/assets', {type: 'asset-upload.completed', schema: 'asset-batch.v1'}, {
    method: 'POST', headers: contextHeaders(context), body: form,
  }, true);
  return response.payload.data.assets;
};

export const createJob = async (input: ProjectInput, context: EnvelopeContext) => {
  const command = createClientEnvelope(context, {
    type: 'render-job.create-requested', schema: 'project-input.v1', data: input,
    idempotencyKey: `${context.jobId}:render-job:create:v1`,
  });
  const response = await requestEnvelope<RenderJob>('/api/jobs', {type: 'render-job.accepted', schema: 'render-job.v1'}, {
    method: 'POST', headers: {...contextHeaders(context), 'content-type': 'application/json; charset=utf-8'}, body: JSON.stringify(command),
  });
  return response.payload.data;
};

export const getJob = async (jobId: string, context: EnvelopeContext) => {
  const response = await requestEnvelope<RenderJob>(`/api/jobs/${jobId}`, {type: 'render-job.fetched', schema: 'render-job.v1'}, {headers: contextHeaders(context)});
  return response.payload.data;
};

export const listJobs = async (context: EnvelopeContext) => {
  const response = await requestEnvelope<{jobs: RenderJob[]}>('/api/jobs', {type: 'render-jobs.fetched', schema: 'job-batch.v1'}, {headers: contextHeaders(context)});
  return response.payload.data.jobs;
};

export const getJobEvents = async (jobId: string, context: EnvelopeContext) => {
  const response = await requestEnvelope<{events: Envelope[]}>(`/api/jobs/${jobId}/events`, {type: 'event-batch.fetched', schema: 'event-batch.v1'}, {headers: contextHeaders(context)});
  return response.payload.data.events.map((event) => parseRegisteredEnvelope(event));
};

export const cancelJob = async (jobId: string, context: EnvelopeContext) => {
  const response = await requestEnvelope<{accepted: boolean}>(`/api/jobs/${jobId}`, {type: 'render-job.cancel-accepted', schema: 'command-result.v1'}, {method: 'DELETE', headers: contextHeaders(context)});
  return response.payload.data;
};

export const retryJob = async (jobId: string, context: EnvelopeContext) => {
  const response = await requestEnvelope<{accepted: boolean}>(`/api/jobs/${jobId}/retry`, {type: 'render-job.retry-accepted', schema: 'command-result.v1'}, {method: 'POST', headers: contextHeaders(context)});
  return response.payload.data;
};

export type SystemShutdownServiceReport = {
  status: 'stopped' | 'skipped' | 'warning';
  message: string;
  code?: string;
  retryable?: boolean;
  details?: string;
};

export type SystemShutdownResult = {
  accepted: boolean;
  activeTasksWillResume: boolean;
  services: {qwen: SystemShutdownServiceReport; docker: SystemShutdownServiceReport};
};

export const shutdownApp = async (context: EnvelopeContext) => {
  const response = await requestEnvelope<SystemShutdownResult>('/api/system/shutdown', {type: 'system.shutdown-accepted', schema: 'command-result.v1'}, {
    method: 'POST', headers: contextHeaders(context),
  });
  return response.payload.data;
};

export const reviewJob = async (jobId: string, status: 'approved' | 'returned', reason: string, context: EnvelopeContext) => {
  const response = await requestEnvelope<RenderJob>(`/api/jobs/${jobId}/review`, {type: 'render-job.reviewed', schema: 'render-job.v1'}, {
    method: 'POST', headers: {...contextHeaders(context), 'content-type': 'application/json'}, body: JSON.stringify({status, reason}),
  });
  return response.payload.data;
};

export const listRelayKeys = async (context: EnvelopeContext) => {
  const response = await requestEnvelope<{keys: RelayKeySummary[]}>('/api/keys', {type: 'relay-keys.fetched', schema: 'relay-key-batch.v1'}, {headers: contextHeaders(context)});
  return response.payload.data.keys;
};

export const createRelayKey = async (input: RelayKeyInput, context: EnvelopeContext) => {
  const response = await requestEnvelope<RelayKeySummary>('/api/keys', {type: 'relay-key.created', schema: 'relay-key.v1'}, {
    method: 'POST', headers: {...contextHeaders(context), 'content-type': 'application/json'}, body: JSON.stringify(input),
  });
  return response.payload.data;
};

export const updateRelayKey = async (keyId: string, input: RelayKeyUpdate, context: EnvelopeContext) => {
  const response = await requestEnvelope<RelayKeySummary>(`/api/keys/${keyId}`, {type: 'relay-key.updated', schema: 'relay-key.v1'}, {
    method: 'PATCH', headers: {...contextHeaders(context), 'content-type': 'application/json'}, body: JSON.stringify(input),
  });
  return response.payload.data;
};

export const activateRelayKey = async (keyId: string, context: EnvelopeContext) => {
  const response = await requestEnvelope<RelayKeySummary>(`/api/keys/${keyId}/activate`, {type: 'relay-key.activated', schema: 'relay-key.v1'}, {
    method: 'POST', headers: contextHeaders(context),
  });
  return response.payload.data;
};

export const testRelayKey = async (keyId: string, context: EnvelopeContext) => {
  const response = await requestEnvelope<RelayKeyTestResult>(`/api/keys/${keyId}/test`, {type: 'relay-key.tested', schema: 'relay-key-test.v1'}, {
    method: 'POST', headers: contextHeaders(context),
  });
  return response.payload.data;
};

export const deleteRelayKey = async (keyId: string, context: EnvelopeContext) => {
  const response = await requestEnvelope<{accepted: boolean}>(`/api/keys/${keyId}`, {type: 'relay-key.deleted', schema: 'command-result.v1'}, {
    method: 'DELETE', headers: contextHeaders(context),
  });
  return response.payload.data;
};

export const fetchRelayModels = async (input: RelayModelDiscoveryInput, context: EnvelopeContext) => {
  const response = await requestEnvelope<{models: string[]}>('/api/keys/models', {type: 'relay-models.fetched', schema: 'relay-model-list.v1'}, {
    method: 'POST', headers: {...contextHeaders(context), 'content-type': 'application/json'}, body: JSON.stringify(input),
  });
  return response.payload.data.models;
};

export const chatWithRelayKey = async (keyId: string, messages: RelayChatMessage[], images: File[], context: EnvelopeContext) => {
  const form = new FormData();
  form.append('messages', JSON.stringify(messages));
  images.forEach((image) => form.append('images', image));
  const response = await requestEnvelope<RelayChatResult>(`/api/keys/${keyId}/chat`, {type: 'relay-chat.completed', schema: 'relay-chat-result.v1'}, {
    method: 'POST', headers: contextHeaders(context), body: form,
  });
  return response.payload.data;
};

export const streamChatWithRelayKey = async (
  keyId: string,
  messages: RelayChatMessage[],
  images: File[],
  context: EnvelopeContext,
  onDelta: (delta: string) => void,
  signal?: AbortSignal,
) => {
  const form = new FormData();
  form.append('messages', JSON.stringify(messages));
  images.forEach((image) => form.append('images', image));
  const response = await fetch(`/api/keys/${encodeURIComponent(keyId)}/chat?stream=1`, {
    method: 'POST',
    headers: {...contextHeaders(context), accept: 'text/event-stream'},
    body: form,
    signal,
  });
  const rawError = response.ok ? '' : await response.text();
  if (!response.ok) throw new Error(nativeResponseErrorText(rawError, response.statusText));
  const reader = response.body?.getReader();
  if (!reader) throw new Error('流式对话响应没有可读取的响应体');
  const decoder = new TextDecoder();
  let buffer = '';
  let completed: RelayChatResult | undefined;
  const consume = (chunk: string) => {
    buffer += chunk;
    const frames = buffer.replace(/\r\n/g, '\n').split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') continue;
      const event = JSON.parse(data) as {type?: string; delta?: string; code?: string; message?: string; retryable?: boolean; reply?: string; model?: string; latencyMs?: number};
      if (event.type === 'delta' && typeof event.delta === 'string') onDelta(event.delta);
      if (event.type === 'error') throw new Error(`${event.message ?? '模型对话失败'}${event.code ? ` (${event.code})` : ''}`);
      if (event.type === 'completed' && typeof event.reply === 'string' && typeof event.model === 'string' && typeof event.latencyMs === 'number') {
        completed = {reply: event.reply, model: event.model, latencyMs: event.latencyMs};
      }
    }
  };
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    if (value?.byteLength) consume(decoder.decode(value, {stream: true}));
  }
  consume(decoder.decode());
  if (buffer.trim()) {
    const tail = buffer;
    buffer = '';
    consume(`${tail}\n\n`);
  }
  if (!completed) throw new Error('流式对话未收到完成事件');
  return completed;
};

export const testRelayProtocol = async (keyId: string, prompt: string, files: File[], context: EnvelopeContext) => {
  const form = new FormData();
  form.append('prompt', prompt);
  files.forEach((file) => form.append('files', file));
  const response = await requestEnvelope<RelayProtocolTestResult>(`/api/keys/${keyId}/protocol-test`, {type: 'relay-protocol-test.completed', schema: 'relay-protocol-test-result.v1'}, {
    method: 'POST', headers: contextHeaders(context), body: form,
  });
  return response.payload.data;
};
