import type {
  ModelConversationRecord,
  ModelConversationStatus,
  ModelConversationSummary,
} from '../shared/model-conversations';

type ConversationFilters = {
  projectId?: string;
  generationId?: string;
  status?: ModelConversationStatus;
  source?: string;
  limit?: number;
};

const headers = () => ({
  'x-tenant-id': 'tenant_demo',
  'x-user-id': 'user_demo',
  'x-role': 'producer',
});

const readJson = async <Value>(response: Response): Promise<Value> => {
  const raw = await response.text();
  let body: unknown;
  try { body = raw ? JSON.parse(raw) : undefined; } catch { body = undefined; }
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'error' in body
      && (body as {error?: {message?: unknown}}).error?.message;
    throw new Error(typeof message === 'string' ? message : raw || response.statusText);
  }
  return body as Value;
};

export const listModelConversations = async (filters: ConversationFilters = {}, signal?: AbortSignal) => {
  const query = new URLSearchParams();
  if (filters.projectId) query.set('projectId', filters.projectId);
  if (filters.generationId) query.set('generationId', filters.generationId);
  if (filters.status) query.set('status', filters.status);
  if (filters.source) query.set('source', filters.source);
  if (filters.limit) query.set('limit', String(filters.limit));
  const suffix = query.size ? `?${query.toString()}` : '';
  const response = await readJson<{conversations: ModelConversationSummary[]}>(await fetch(`/api/model-conversations${suffix}`, {headers: headers(), signal}));
  return response.conversations;
};

export const getModelConversation = async (conversationId: string, signal?: AbortSignal) => readJson<ModelConversationRecord>(await fetch(
  `/api/model-conversations/${encodeURIComponent(conversationId)}`,
  {headers: headers(), signal},
));
