import {randomUUID} from 'node:crypto';
import type {
  ModelConversationLogContext,
  ModelConversationMessage,
  ModelConversationRecord,
} from '../shared/model-conversations.js';
import type {ReasoningEffort} from '../shared/auto-video-contracts.js';

export type RelayConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  /** Legacy alias: applies the same limit to first-byte, idle and total timeouts. */
  timeoutMs?: number;
  /** Maximum time until the first response body byte arrives. */
  firstByteTimeoutMs?: number;
  /** Maximum gap between response body chunks after the first byte. */
  idleTimeoutMs?: number;
  /** Maximum duration for one complete SSE response. */
  totalTimeoutMs?: number;
  // Long-lived orchestration retries are persisted by AutoVideoWorker. Other
  // interactive callers can retain the existing bounded relay retry behavior.
  retryAttempts?: number;
  /** Hard cap for one streamed response. Defaults to 16 MiB. */
  maxResponseBytes?: number;
};

export type RelayConversationAudit = {
  tenantId: string;
  relayKeyId?: string;
  onRecord: (record: ModelConversationRecord) => void;
  /** Receives the same conversation id while an SSE response is still arriving. */
  onProgress?: (record: ModelConversationRecord) => void;
};

export type RelayChatMessage = {role: 'user' | 'assistant'; content: string};
export type RelayJsonSchema = {name: string; schema: Record<string, unknown>};

export type RelayRequestMetrics = {
  latencyMs: number;
  timeToFirstByteMs?: number;
  timeToFirstEventMs?: number;
  timeoutPhase?: 'first_byte' | 'idle' | 'total';
};

type RelayResponse = {text: string; metrics: RelayRequestMetrics};

export class RelayError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly metrics?: RelayRequestMetrics,
  ) {
    super(message);
  }
}

const retryableStatuses = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const retryableRelayFailure = /\b(?:stream[_ -]?timeout|upstream[_ -]?timeout|server[_ -]?error|rate[_ -]?limit(?:ed|_exceeded)?|overloaded|temporarily[_ -]?unavailable)\b/i;
const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 120_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

const positiveTimeout = (value: number | undefined, fallback: number) => Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value!) : fallback;
const environmentTimeout = (name: string, fallback: number) => positiveTimeout(Number(process.env[name]), fallback);
const responseLimitFor = (schemaName: string | undefined, configured?: number) => {
  if (configured && configured > 0) return Math.floor(configured);
  const envName = schemaName?.includes('edit-plan') ? 'RELAY_MAX_PLAN_BYTES'
    : schemaName?.includes('asset') ? 'RELAY_MAX_ASSET_BYTES'
      : schemaName?.includes('screenshot') ? 'RELAY_MAX_SCREENSHOT_BYTES' : 'RELAY_MAX_RESPONSE_BYTES';
  const fallback = schemaName?.includes('edit-plan') ? 16 * 1024 * 1024
    : schemaName?.includes('asset') ? 8 * 1024 * 1024
      : schemaName?.includes('screenshot') ? 4 * 1024 * 1024 : DEFAULT_MAX_RESPONSE_BYTES;
  return positiveTimeout(Number(process.env[envName]), fallback);
};

const logLimit = 100_000;
const leadingJsonFormatNoise = /^[\u200B-\u200D\u2060\uFEFF]+/u;

/**
 * Some OpenAI-compatible relays prefix otherwise valid model JSON with an
 * invisible Unicode formatting character. Remove only a leading run of those
 * characters; JSON content and all other malformed replies remain untouched.
 */
export const parseModelJson = (text: string): unknown => JSON.parse(text.replace(leadingJsonFormatNoise, ''));

export const isRetryableRelayFailureMessage = (message: string) => retryableRelayFailure.test(message);

const truncateForLog = (value: string, limit = logLimit) => {
  if (value.length <= limit) return value;
  const suffix = '\n…（内容已截断）';
  return `${value.slice(0, Math.max(0, limit - suffix.length))}${suffix}`;
};

const jsonForLog = (value: unknown) => {
  try {
    return truncateForLog(JSON.stringify(value, null, 2));
  } catch {
    return '[无法序列化本次结构化输入]';
  }
};

const describeMediaInputs = (imageUrls: string[]) => imageUrls.map((imageUrl, index) => {
  const mimeType = /^data:([^;,]+)/i.exec(imageUrl)?.[1] ?? 'image/*';
  const byteCount = imageUrl.startsWith('data:') ? Math.max(0, Math.floor((imageUrl.length - imageUrl.indexOf(',') - 1) * 0.75)) : undefined;
  return `视觉输入 ${index + 1}：${mimeType}${byteCount ? `，约 ${byteCount.toLocaleString('en-US')} bytes` : ''}；图片内容不写入对话日志。`;
});

const safeEndpointForLog = (value: string) => {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return value.slice(0, 2_000);
  }
};

const relayHttpMessage = (body: string) => {
  const limited = body.slice(0, 2_000);
  try {
    const parsed = JSON.parse(limited) as {error?: {message?: unknown}; message?: unknown};
    const message = parsed.error?.message ?? parsed.message;
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 500);
  } catch {
    // Some relays return plain text or HTML. Do not expose a full response body.
  }
  return '';
};

export const normalizeResponsesUrl = (baseUrl: string) => {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path || '/';
  if (!/\/responses$/i.test(path)) url.pathname = /\/v1$/i.test(path) ? `${path}/responses` : `${path}/v1/responses`;
  url.search = '';
  url.hash = '';
  return url.toString();
};

export const normalizeModelsUrl = (baseUrl: string) => {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, '');
  if (/\/models$/i.test(path)) url.pathname = path;
  else if (/\/responses$/i.test(path)) url.pathname = path.replace(/\/responses$/i, '/models');
  else if (/\/v1$/i.test(path)) url.pathname = `${path}/models`;
  else url.pathname = `${path}/v1/models`;
  url.search = '';
  url.hash = '';
  return url.toString();
};

export const parseModelList = (payload: unknown) => {
  if (!payload || typeof payload !== 'object') throw new RelayError('上游模型列表格式无效', 'relay_models_invalid', false);
  const candidate = payload as {data?: unknown; models?: unknown};
  const items = Array.isArray(candidate.data) ? candidate.data : Array.isArray(candidate.models) ? candidate.models : undefined;
  if (!items) throw new RelayError('上游未返回模型列表', 'relay_models_invalid', false);
  const models = [...new Set(items.flatMap((item) => {
    if (typeof item === 'string') return item.length <= 80 ? [item] : [];
    if (!item || typeof item !== 'object') return [];
    const id = (item as {id?: unknown}).id;
    return typeof id === 'string' && id.length > 0 && id.length <= 80 ? [id] : [];
  }))].sort((left, right) => left.localeCompare(right));
  if (!models.length) throw new RelayError('上游没有返回可用模型', 'relay_models_empty', false);
  return models;
};

export const parseSseText = (body: string) => {
  let output = '';
  let completed = false;
  const frames = body.replace(/\r\n/g, '\n').split('\n\n');
  for (const frame of frames) {
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') continue;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      throw new RelayError('中转站返回了非法 SSE JSON', 'relay_invalid_json', false);
    }
    if (!event || typeof event !== 'object') continue;
    const typed = event as {type?: string; delta?: string; message?: string; error?: {message?: string}; response?: {error?: {message?: string}}};
    if (typed.type === 'response.output_text.delta' && typeof typed.delta === 'string') output += typed.delta;
    if (typed.type === 'response.completed') completed = true;
    if (typed.type === 'response.failed' || typed.type === 'error') {
      const message = typed.response?.error?.message ?? typed.error?.message ?? typed.message ?? '中转站模型调用失败';
      throw new RelayError(message, 'relay_failed', isRetryableRelayFailureMessage(message));
    }
  }
  if (!completed) throw new RelayError('SSE 在 response.completed 前结束', 'relay_incomplete', true);
  return output;
};

const parseSseFrameDelta = (frame: string) => {
  const data = frame
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!data || data === '[DONE]') return '';
  let event: unknown;
  try {
    event = JSON.parse(data);
  } catch {
    throw new RelayError('涓浆绔欒繑鍥炰簡闈炴硶 SSE JSON', 'relay_invalid_json', false);
  }
  if (!event || typeof event !== 'object') return '';
  const typed = event as {type?: string; delta?: string; message?: string; error?: {message?: string}; response?: {error?: {message?: string}}};
  if (typed.type === 'response.failed' || typed.type === 'error') {
    const message = typed.response?.error?.message ?? typed.error?.message ?? typed.message ?? 'relay model request failed';
    throw new RelayError(message, 'relay_failed', isRetryableRelayFailureMessage(message));
  }
  return typed.type === 'response.output_text.delta' && typeof typed.delta === 'string' ? typed.delta : '';
};

export class RelayClient {
  private readonly installationId = randomUUID();
  private readonly url: string;
  private structuredOutputSupported: boolean | undefined;

  constructor(private readonly config: RelayConfig, private readonly conversationAudit?: RelayConversationAudit) {
    this.url = normalizeResponsesUrl(config.baseUrl);
  }

  get model() {
    return this.config.model;
  }

  async listModels(signal?: AbortSignal) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 30_000);
    signal?.addEventListener('abort', () => controller.abort(), {once: true});
    try {
      const response = await fetch(normalizeModelsUrl(this.config.baseUrl), {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
          originator: 'codex_cli_rs',
          'user-agent': 'codex_cli_rs/0.0.0 (Windows; x86_64)',
        },
        signal: controller.signal,
      });
      const body = await response.text();
      if (!response.ok) throw new RelayError(`上游模型接口 HTTP ${response.status}`, `relay_models_http_${response.status}`, retryableStatuses.has(response.status));
      if (body.length > 1_000_000) throw new RelayError('上游模型列表响应过大', 'relay_models_too_large', false);
      try {
        return parseModelList(JSON.parse(body));
      } catch (error) {
        if (error instanceof RelayError) throw error;
        throw new RelayError('上游模型列表不是合法 JSON', 'relay_models_invalid_json', false);
      }
    } catch (error) {
      if (error instanceof RelayError) throw error;
      if (controller.signal.aborted) throw new RelayError('获取上游模型超时或被取消', 'relay_models_timeout', true);
      throw new RelayError('无法连接上游模型接口', 'relay_models_network', true);
    } finally {
      clearTimeout(timeout);
    }
  }

  async requestJson(instructions: string, input: unknown, signal?: AbortSignal, imageUrls: string[] = [], logContext?: ModelConversationLogContext, jsonSchema?: RelayJsonSchema): Promise<unknown> {
    const responsesInput = [{
      type: 'message',
      role: 'user',
      content: [
        {type: 'input_text', text: JSON.stringify(input)},
        ...imageUrls.slice(0, 10).map((imageUrl) => ({type: 'input_image', image_url: imageUrl})),
      ],
    }];
    const text = await this.requestWithConversationLog(
      [
        {role: 'program', label: '系统指令', content: instructions},
        {role: 'program', label: '结构化输入', content: jsonForLog(input)},
        ...describeMediaInputs(imageUrls.slice(0, 10)).map((content) => ({role: 'media' as const, label: '视觉输入', content})),
      ],
      logContext,
      async (onAttempt, onTextDelta) => {
        const format = jsonSchema && this.structuredOutputSupported !== false ? jsonSchema : undefined;
        try {
          const output = await this.requestWithRetries(instructions, responsesInput, signal, onAttempt, format, onTextDelta);
          if (format) this.structuredOutputSupported = true;
          return output;
        } catch (error) {
          // Some OpenAI-compatible relays reject text.format. A clearly
          // unsupported 4xx falls back once to the strict prompt, while model
          // content failures never trigger a looser second request.
          const unsupported = format && error instanceof RelayError && /^relay_http_(400|404|405|422)$/.test(error.code)
            && /(text\.format|json[_ -]?schema|structured|format|unsupported|不支持)/i.test(error.message);
          if (!unsupported) throw error;
          this.structuredOutputSupported = false;
          return this.requestWithRetries(instructions, responsesInput, signal, onAttempt, undefined, onTextDelta);
        }
      },
    );
    try {
      return parseModelJson(text);
    } catch {
      throw new RelayError('模型输出不是合法 JSON', 'model_invalid_json', false);
    }
  }

  async requestChat(messages: RelayChatMessage[], imageUrls: string[] = [], signal?: AbortSignal, logContext?: ModelConversationLogContext, onTextDelta?: (delta: string) => void) {
    const recentMessages = messages.slice(-12);
    if (imageUrls.length > 10) throw new RelayError('单次消息最多传递 10 张图片', 'relay_image_count_exceeded', false);
    const latestUserIndex = recentMessages.map((message) => message.role).lastIndexOf('user');
    if (imageUrls.length && latestUserIndex < 0) throw new RelayError('图片必须随一条用户消息发送', 'relay_image_without_user_message', false);
    const responsesInput = recentMessages.map((message, index) => ({
      type: 'message',
      role: message.role,
      content: [
        {type: message.role === 'assistant' ? 'output_text' : 'input_text', text: message.content},
        ...(index === latestUserIndex ? imageUrls.map((imageUrl) => ({type: 'input_image', image_url: imageUrl})) : []),
      ],
    }));
    const instructions = '你是用于验证中转站连接的简洁中文助手。直接回答用户问题；如果当前用户消息附带图片，只基于实际图片内容回答，不调用工具。';
    const text = await this.requestWithConversationLog(
      [
        {role: 'program', label: '系统指令', content: instructions},
        ...recentMessages.map((message) => ({
          role: message.role === 'assistant' ? 'model' as const : 'user' as const,
          label: message.role === 'assistant' ? '模型历史回复' : '用户消息',
          content: message.content,
        })),
        ...describeMediaInputs(imageUrls).map((content) => ({role: 'media' as const, label: '当前消息图片', content})),
      ],
      logContext,
      (onAttempt, streamTextDelta) => this.requestWithRetries(instructions, responsesInput, signal, onAttempt, undefined, (delta) => {
        onTextDelta?.(delta);
        streamTextDelta(delta);
      }),
    );
    if (!text.trim()) throw new RelayError('模型返回了空回复', 'model_empty_output', false);
    return text;
  }

  /**
   * Use the exact ordinary multimodal chat transport exposed by the model
   * conversation tester, then apply JSON parsing locally. This deliberately
   * does not send Responses text.format/json_schema, because some compatible
   * relays accept image chat but reject that stricter combination.
   */
  async requestChatJson(messages: RelayChatMessage[], imageUrls: string[] = [], signal?: AbortSignal, logContext?: ModelConversationLogContext): Promise<unknown> {
    const text = await this.requestChat(messages, imageUrls, signal, logContext);
    try {
      return parseModelJson(text);
    } catch {
      throw new RelayError('模型输出不是合法 JSON', 'model_invalid_json', false);
    }
  }

  async requestMultimodalText(prompt: string, imageUrls: string[], signal?: AbortSignal, logContext?: ModelConversationLogContext) {
    const text = prompt.trim();
    if (!text) throw new RelayError('测试消息不能为空', 'relay_prompt_required', false);
    if (imageUrls.length > 10) throw new RelayError('单次消息最多传递 10 张图片', 'relay_image_count_exceeded', false);
    const responsesInput = [{
      type: 'message',
      role: 'user',
      content: [
        {type: 'input_text', text},
        ...imageUrls.map((imageUrl) => ({type: 'input_image', image_url: imageUrl})),
      ],
    }];
    // This is a protocol probe, not a business request: preserve one observable
    // HTTP/SSE exchange so the returned error identifies the actual upstream response.
    const instructions = '你是中转站多模态通信测试助手。请根据用户文本和图片直接回答，说明你实际观察到的内容；不要声称看到了未提供的文件。';
    const output = await this.requestWithConversationLog(
      [
        {role: 'program', label: '系统指令', content: instructions},
        {role: 'user', label: '用户消息', content: text},
        ...describeMediaInputs(imageUrls).map((content) => ({role: 'media' as const, label: '视觉输入', content})),
      ],
      logContext,
      // This is a protocol probe: preserve its single observable HTTP/SSE exchange.
      async (onAttempt, onTextDelta) => {
        onAttempt();
        return this.requestTextOnce(instructions, responsesInput, signal, undefined, onTextDelta);
      },
    );
    if (!output.trim()) throw new RelayError('模型返回了空回复', 'model_empty_output', false);
    return output;
  }

  private async requestWithConversationLog(
    requestMessages: ModelConversationMessage[],
    logContext: ModelConversationLogContext | undefined,
    execute: (onAttempt: () => void, onTextDelta: (delta: string) => void) => Promise<RelayResponse>,
  ) {
    if (!this.conversationAudit) return (await execute(() => undefined, () => undefined)).text;
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const conversationId = `mdl_${randomUUID()}`;
    let attempts = 0;
    let attemptText = '';
    let lastProgressWriteMs = 0;
    const context = logContext ?? {ownerId: 'user_system', source: 'relay.unknown'};
    const commonRecord = () => ({
      id: conversationId,
      tenantId: this.conversationAudit!.tenantId,
      ownerId: context.ownerId,
      relayKeyId: this.conversationAudit!.relayKeyId,
      projectId: context.projectId,
      generationId: context.generationId,
      jobId: context.jobId,
      taskId: context.taskId,
      assetId: context.assetId,
      source: context.source,
      model: this.config.model,
      endpoint: safeEndpointForLog(this.url),
      startedAt,
      requestMessages,
    });
    const writeProgress = (force = false) => {
      const nowMs = Date.now();
      if (!force && nowMs - lastProgressWriteMs < 150) return;
      lastProgressWriteMs = nowMs;
      return this.writeConversationProgress({
      ...commonRecord(),
      completedAt: new Date().toISOString(),
      latencyMs: Math.max(0, Date.now() - startedMs),
      attempts: Math.max(1, attempts),
      status: 'streaming',
      ...(attemptText ? {responseText: truncateForLog(attemptText)} : {}),
      });
    };
    writeProgress(true);
    try {
      const result = await execute(
        () => { attempts += 1; attemptText = ''; writeProgress(true); },
        (delta) => { attemptText += delta; writeProgress(); },
      );
      writeProgress(true);
      this.writeConversationRecord({
        ...commonRecord(),
        startedAt,
        completedAt: new Date().toISOString(),
        latencyMs: result.metrics.latencyMs,
        ...(result.metrics.timeToFirstByteMs !== undefined ? {timeToFirstByteMs: result.metrics.timeToFirstByteMs} : {}),
        ...(result.metrics.timeToFirstEventMs !== undefined ? {timeToFirstEventMs: result.metrics.timeToFirstEventMs} : {}),
        attempts: Math.max(1, attempts),
        status: 'completed',
        responseText: truncateForLog(result.text),
      });
      return result.text;
    } catch (error) {
      const metrics = error instanceof RelayError ? error.metrics : undefined;
      this.writeConversationRecord({
        ...commonRecord(),
        startedAt,
        completedAt: new Date().toISOString(),
        latencyMs: metrics?.latencyMs ?? Math.max(0, Date.now() - startedMs),
        ...(metrics?.timeToFirstByteMs !== undefined ? {timeToFirstByteMs: metrics.timeToFirstByteMs} : {}),
        ...(metrics?.timeToFirstEventMs !== undefined ? {timeToFirstEventMs: metrics.timeToFirstEventMs} : {}),
        ...(metrics?.timeoutPhase ? {timeoutPhase: metrics.timeoutPhase} : {}),
        attempts: Math.max(1, attempts),
        status: 'failed',
        ...(attemptText ? {responseText: truncateForLog(attemptText)} : {}),
        errorCode: error instanceof RelayError ? error.code : 'relay_unexpected_error',
        errorMessage: truncateForLog(error instanceof Error ? error.message : '未知模型调用错误', 2_000),
      });
      throw error;
    }
  }

  private writeConversationRecord(record: ModelConversationRecord) {
    try {
      this.conversationAudit?.onRecord(record);
    } catch (error) {
      // Conversation observability must never make a model request fail.
      console.error('[washcut] Failed to persist model conversation:', error instanceof Error ? error.message : error);
    }
  }

  private writeConversationProgress(record: ModelConversationRecord) {
    try {
      this.conversationAudit?.onProgress?.(record);
    } catch (error) {
      console.error('[washcut] Failed to persist streaming model conversation:', error instanceof Error ? error.message : error);
    }
  }

  private async requestWithRetries(instructions: string, input: unknown[], signal?: AbortSignal, onAttempt?: () => void, jsonSchema?: RelayJsonSchema, onTextDelta?: (delta: string) => void) {
    // Upstream 502/503 responses are common while a multimodal worker warms
    // up. Use a bounded, configurable backoff instead of immediately issuing
    // another burst of the same vision request.
    const attempts = Math.max(1, Math.min(6, this.config.retryAttempts ?? Number(process.env.RELAY_RETRY_ATTEMPTS ?? 4)));
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        onAttempt?.();
        return await this.requestTextOnce(instructions, input, signal, jsonSchema, onTextDelta);
      } catch (error) {
        lastError = error;
        const retryable = error instanceof RelayError && error.retryable;
        if (!retryable || attempt === attempts - 1 || signal?.aborted) throw error;
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 1_000 * 2 ** attempt);
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new RelayError('用户取消了模型调用', 'cancelled', false));
          }, {once: true});
        });
      }
    }
    throw lastError;
  }

  private async requestTextOnce(instructions: string, input: unknown[], signal?: AbortSignal, jsonSchema?: RelayJsonSchema, onTextDelta?: (delta: string) => void) {
    const controller = new AbortController();
    let timedOut = false;
    const startedMs = Date.now();
    const legacyTimeoutMs = positiveTimeout(this.config.timeoutMs, 0);
    const firstByteTimeoutMs = positiveTimeout(this.config.firstByteTimeoutMs, environmentTimeout('RELAY_FIRST_BYTE_TIMEOUT_MS', legacyTimeoutMs || DEFAULT_FIRST_BYTE_TIMEOUT_MS));
    const idleTimeoutMs = positiveTimeout(this.config.idleTimeoutMs, environmentTimeout('RELAY_IDLE_TIMEOUT_MS', DEFAULT_IDLE_TIMEOUT_MS));
    const totalTimeoutMs = positiveTimeout(this.config.totalTimeoutMs, environmentTimeout('RELAY_TOTAL_TIMEOUT_MS', legacyTimeoutMs || DEFAULT_TOTAL_TIMEOUT_MS));
    let timeoutPhase: RelayRequestMetrics['timeoutPhase'];
    let timeToFirstByteMs: number | undefined;
    let timeToFirstEventMs: number | undefined;
    const maxResponseBytes = responseLimitFor(jsonSchema?.name, this.config.maxResponseBytes);
    let responseBytes = 0;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const metrics = (): RelayRequestMetrics => ({
      latencyMs: Math.max(0, Date.now() - startedMs),
      ...(timeToFirstByteMs !== undefined ? {timeToFirstByteMs} : {}),
      ...(timeToFirstEventMs !== undefined ? {timeToFirstEventMs} : {}),
      ...(timeoutPhase ? {timeoutPhase} : {}),
    });
    const abortForPhase = (phase: RelayRequestMetrics['timeoutPhase']) => {
      timedOut = true;
      timeoutPhase = phase;
      controller.abort();
    };
    const abortForCaller = () => controller.abort();
    const firstByteTimer = setTimeout(() => abortForPhase('first_byte'), firstByteTimeoutMs);
    const totalTimer = setTimeout(() => abortForPhase('total'), totalTimeoutMs);
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => abortForPhase('idle'), idleTimeoutMs);
    };
    const clearTimers = () => {
      clearTimeout(firstByteTimer);
      clearTimeout(totalTimer);
      if (idleTimer) clearTimeout(idleTimer);
    };
    signal?.addEventListener('abort', abortForCaller, {once: true});
    try {
      const sessionId = randomUUID();
      const threadId = randomUUID();
      const turnId = randomUUID();
      const windowId = `${threadId}:0`;
      const turnMetadata = JSON.stringify({
        installation_id: this.installationId,
        session_id: sessionId,
        thread_id: threadId,
        turn_id: turnId,
        window_id: windowId,
        request_kind: 'turn',
        turn_started_at_unix_ms: Date.now(),
      });
      const response = await fetch(this.url, {
        method: 'POST',
        headers: {
          accept: 'text/event-stream',
          authorization: `Bearer ${this.config.apiKey}`,
          'content-type': 'application/json',
          originator: 'codex_cli_rs',
          'user-agent': 'codex_cli_rs/0.0.0 (Windows; x86_64)',
          'session-id': sessionId,
          'thread-id': threadId,
          'x-client-request-id': threadId,
          'x-codex-installation-id': this.installationId,
          'x-codex-window-id': windowId,
          'x-codex-turn-metadata': turnMetadata,
        },
        body: JSON.stringify({
          model: this.config.model,
          instructions,
          input,
          stream: true,
          store: false,
          tools: [],
          tool_choice: 'auto',
          parallel_tool_calls: false,
          reasoning: {effort: this.config.reasoningEffort ?? 'low', summary: 'auto'},
          include: ['reasoning.encrypted_content'],
          prompt_cache_key: sessionId,
          text: jsonSchema ? {verbosity: 'medium', format: {type: 'json_schema', name: jsonSchema.name, strict: true, schema: jsonSchema.schema}} : {verbosity: 'medium'},
          client_metadata: {
            'x-codex-installation-id': this.installationId,
            session_id: sessionId,
            thread_id: threadId,
            turn_id: turnId,
            'x-codex-window-id': windowId,
            'x-codex-turn-metadata': turnMetadata,
          },
        }),
        signal: controller.signal,
      });
      let body = '';
      const reader = response.body?.getReader();
      if (!reader) {
        body = await response.text();
        responseBytes = new TextEncoder().encode(body).byteLength;
        if (responseBytes > maxResponseBytes) throw new RelayError('中转站响应超过允许大小上限', 'relay_response_too_large', false, metrics());
        if (body.length > 0) {
          timeToFirstByteMs = Math.max(0, Date.now() - startedMs);
          clearTimeout(firstByteTimer);
        }
        for (const frame of body.replace(/\r\n/g, '\n').split('\n\n')) {
          const delta = parseSseFrameDelta(frame);
          if (delta) onTextDelta?.(delta);
        }
      } else {
        const decoder = new TextDecoder();
        let frameBuffer = '';
        const consumeChunk = (chunk: string) => {
          frameBuffer += chunk;
          const frames = frameBuffer.replace(/\r\n/g, '\n').split('\n\n');
          frameBuffer = frames.pop() ?? '';
          for (const frame of frames) {
            const delta = parseSseFrameDelta(frame);
            if (delta) onTextDelta?.(delta);
          }
        };
        while (true) {
          const {done, value} = await reader.read();
          if (done) {
            break;
          }
          if (!value?.byteLength) continue;
          responseBytes += value.byteLength;
          if (responseBytes > maxResponseBytes) {
            controller.abort();
            throw new RelayError('中转站响应超过允许大小上限', 'relay_response_too_large', false, metrics());
          }
          if (timeToFirstByteMs === undefined) {
            timeToFirstByteMs = Math.max(0, Date.now() - startedMs);
            clearTimeout(firstByteTimer);
          }
          resetIdleTimer();
          const chunk = decoder.decode(value, {stream: true});
          body += chunk;
          consumeChunk(chunk);
          if (timeToFirstEventMs === undefined) {
            const hasEvent = body.replace(/\r\n/g, '\n').split('\n\n').some((frame) => frame.split('\n').some((line) => {
              const data = line.startsWith('data:') ? line.slice(5).trim() : '';
              return Boolean(data) && data !== '[DONE]';
            }));
            if (hasEvent) timeToFirstEventMs = Math.max(0, Date.now() - startedMs);
          }
        }
        const tail = decoder.decode();
        responseBytes += new TextEncoder().encode(tail).byteLength;
        if (responseBytes > maxResponseBytes) throw new RelayError('中转站响应超过允许大小上限', 'relay_response_too_large', false, metrics());
        body += tail;
        consumeChunk(tail);
        if (frameBuffer.trim()) {
          const delta = parseSseFrameDelta(frameBuffer);
          if (delta) onTextDelta?.(delta);
        }
      }
      if (!response.ok) {
        const detail = relayHttpMessage(body);
        throw new RelayError(`中转站 HTTP ${response.status}${detail ? `：${detail}` : ''}`, `relay_http_${response.status}`, retryableStatuses.has(response.status));
      }
      return {text: parseSseText(body), metrics: metrics()};
    } catch (error) {
      if (error instanceof RelayError && !error.metrics) throw new RelayError(error.message, error.code, error.retryable, metrics());
      if (timeoutPhase === 'first_byte') throw new RelayError('\u4e2d\u8f6c\u7ad9\u9996\u5b57\u8282\u8d85\u65f6', 'relay_first_byte_timeout', true, metrics());
      if (timeoutPhase === 'idle') throw new RelayError('\u4e2d\u8f6c\u7ad9\u6d41\u5f0f\u54cd\u5e94\u7a7a\u95f2\u8d85\u65f6', 'relay_idle_timeout', true, metrics());
      if (timeoutPhase === 'total') throw new RelayError('\u4e2d\u8f6c\u7ad9\u54cd\u5e94\u603b\u65f6\u957f\u8d85\u65f6', 'relay_total_timeout', true, metrics());
      if (error instanceof RelayError) throw error;
      if (signal?.aborted) throw new RelayError('中转站请求已取消', 'cancelled', false);
      if (timedOut) throw new RelayError('中转站请求超时', 'relay_timeout', true);
      throw new RelayError('中转站网络故障', 'relay_network', true);
    } finally {
      clearTimers();
      signal?.removeEventListener('abort', abortForCaller);
    }
  }
}
