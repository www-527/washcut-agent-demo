import type {
  AiMode,
  AutoVideoAsset,
  AutoVideoGeneration,
  AutoVideoGenerationCreate,
  AutoVideoAssetCheckpointSummary,
  AutoVideoOutput,
  AutoVideoProjectCreate,
  AutoVideoProjectStatus,
  TranscriptionProviderStatus,
  TranscriptionProviderStatusResponse,
} from '../shared/auto-video-contracts';

export type AutoVideoAssetView = AutoVideoAsset & {originalUrl: string; duplicateOfAssetId?: string};
export type AutoVideoOutputView = AutoVideoOutput & {videoUrl?: string; subtitleUrl?: string};
export type AutoVideoGenerationView = Omit<AutoVideoGeneration, 'output'> & {output?: AutoVideoOutputView; assetCheckpoints?: AutoVideoAssetCheckpointSummary[]};
export type AutoVideoGenerationSummary = Pick<AutoVideoGeneration,
  'generationId' | 'projectId' | 'versionNumber' | 'status' | 'progress' | 'aiMode' |
  'connectionId' | 'model' | 'createdAt' | 'startedAt' | 'completedAt' | 'updatedAt'
>;

export type AutoVideoProjectDetail = {
  id: string;
  tenantId: string;
  ownerId: string;
  name: string;
  userInstruction?: string;
  status: AutoVideoProjectStatus;
  canvas: {width: number; height: number; fps: number};
  assetIds: string[];
  assets: AutoVideoAssetView[];
  generationCount: number;
  latestGeneration?: AutoVideoGenerationView;
  createdAt: string;
  updatedAt: string;
};

export type AutoVideoProjectSummary = Pick<AutoVideoProjectDetail,
  'id' | 'name' | 'status' | 'generationCount' | 'createdAt' | 'updatedAt'
> & {latestGeneration?: AutoVideoGenerationSummary};

export type ModelConnectionStatus = {
  mode: 'connected' | 'local' | 'blocked';
  reason?: 'no_model_connection' | 'connection_test_failed' | 'transcription_unavailable';
  transcriptionAvailable: boolean;
  activeConnection?: {connectionId: string; name: string; model: string};
  message: string;
};

export type TranscriptionStatus = TranscriptionProviderStatus;
export type {TranscriptionProviderStatusResponse};


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

export const createAutoVideoProject = async (input: AutoVideoProjectCreate) => readJson<AutoVideoProjectDetail>(await fetch('/api/projects', {
  method: 'POST', headers: {...headers(), 'content-type': 'application/json'}, body: JSON.stringify(input),
}));

export const listAutoVideoProjects = async () => {
  const response = await readJson<{projects: AutoVideoProjectSummary[]}>(await fetch('/api/projects', {headers: headers()}));
  return response.projects;
};

export const getAutoVideoProject = async (projectId: string) => readJson<AutoVideoProjectDetail>(await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {headers: headers()}));

export const duplicateAutoVideoProject = async (projectId: string) => readJson<AutoVideoProjectDetail>(await fetch(`/api/projects/${encodeURIComponent(projectId)}/duplicate`, {
  method: 'POST', headers: headers(),
}));

export const uploadAutoVideoAssets = async (projectId: string, files: File[]) => {
  const form = new FormData();
  for (const file of files) form.append('files', file);
  return readJson<{assets: AutoVideoAssetView[]; project: AutoVideoProjectDetail}>(await fetch(`/api/projects/${encodeURIComponent(projectId)}/assets`, {
    method: 'POST', headers: headers(), body: form,
  }));
};

export const deleteAutoVideoAsset = async (projectId: string, assetId: string) => readJson<{accepted: boolean; project: AutoVideoProjectDetail}>(await fetch(`/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}`, {
  method: 'DELETE', headers: headers(),
}));

export const getModelConnectionStatus = async () => readJson<ModelConnectionStatus>(await fetch('/api/model-connection/status', {headers: headers()}));

export const getTranscriptionStatus = async () => readJson<TranscriptionStatus>(await fetch('/api/transcription/status', {headers: headers()}));

export const getTranscriptionProviders = async () => readJson<TranscriptionProviderStatusResponse>(await fetch('/api/transcription/providers', {headers: headers()}));

export const activateTranscriptionProvider = async (providerId: 'speaches-whisper' | 'qwen3-asr') => readJson<TranscriptionProviderStatusResponse>(await fetch('/api/transcription/activate', {
  method: 'POST',
  headers: {...headers(), 'content-type': 'application/json'},
  body: JSON.stringify({providerId}),
}));

export const startTranscription = async () => readJson<TranscriptionStatus>(await fetch('/api/transcription/start', {
  method: 'POST', headers: headers(),
}));

export const createAutoVideoGeneration = async (projectId: string, input: AutoVideoGenerationCreate, idempotencyKey: string) => readJson<{accepted: boolean; generation: AutoVideoGenerationView}>(await fetch(`/api/projects/${encodeURIComponent(projectId)}/generations`, {
  method: 'POST',
  headers: {...headers(), 'content-type': 'application/json', 'x-idempotency-key': idempotencyKey},
  body: JSON.stringify(input),
}));

export const listAutoVideoGenerations = async (projectId: string) => {
  const response = await readJson<{generations: AutoVideoGenerationSummary[]}>(await fetch(`/api/projects/${encodeURIComponent(projectId)}/generations`, {headers: headers()}));
  return response.generations;
};

export const getAutoVideoGeneration = async (projectId: string, generationId: string) => readJson<AutoVideoGenerationView>(await fetch(`/api/projects/${encodeURIComponent(projectId)}/generations/${encodeURIComponent(generationId)}`, {headers: headers()}));

export const deleteAutoVideoGeneration = async (projectId: string, generationId: string) => readJson<{accepted: boolean; project: AutoVideoProjectDetail}>(await fetch(`/api/projects/${encodeURIComponent(projectId)}/generations/${encodeURIComponent(generationId)}`, {
  method: 'DELETE', headers: headers(),
}));

export const retryAutoVideoGeneration = async (projectId: string, generationId: string) => readJson<{accepted: boolean; generation: AutoVideoGenerationView}>(await fetch(`/api/projects/${encodeURIComponent(projectId)}/generations/${encodeURIComponent(generationId)}/retry`, {
  method: 'POST', headers: headers(),
}));

export const cancelAutoVideoGeneration = async (projectId: string, generationId: string) => readJson<{accepted: boolean; generation?: AutoVideoGenerationView}>(await fetch(`/api/projects/${encodeURIComponent(projectId)}/generations/${encodeURIComponent(generationId)}/cancel`, {
  method: 'POST', headers: headers(),
}));

export const resumeAutoVideoGeneration = async (projectId: string, generationId: string) => readJson<{accepted: boolean; generation: AutoVideoGenerationView}>(await fetch(`/api/projects/${encodeURIComponent(projectId)}/generations/${encodeURIComponent(generationId)}/resume`, {
  method: 'POST', headers: headers(),
}));

