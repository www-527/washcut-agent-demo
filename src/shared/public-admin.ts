import type {AutoVideoError, AutoVideoRetryState} from './auto-video-contracts.js';
import type {RelayKeySummary, RelayKeyTestResult} from './contracts.js';
import type {ModelConversationRecord, ModelConversationSummary} from './model-conversations.js';

export type PublicAdminStep = {
  name: string;
  status: string;
  progress: number;
  note?: string;
  errorCode?: string;
  errorMessage?: string;
};

export type PublicAdminTask = {
  taskId: string;
  testerId: string;
  name: string;
  assetCount: number;
  status: string;
  statusLabel: string;
  progress: number;
  steps: PublicAdminStep[];
  generationId?: string;
  connectionId?: string;
  model?: string;
  retryState?: AutoVideoRetryState;
  error?: AutoVideoError;
  canRetry: boolean;
  outputReady: boolean;
  createdAt: string;
  updatedAt: string;
};

export type PublicAdminConnectionStatus = {
  mode: 'local' | 'connected' | 'blocked';
  message: string;
  activeConnection?: {connectionId: string; name: string; model: string};
};

export type PublicAdminSnapshot = {
  tasks: PublicAdminTask[];
  keys: RelayKeySummary[];
  connectionStatus: PublicAdminConnectionStatus;
  refreshedAt: string;
};

export type PublicAdminConversationList = {
  conversations: ModelConversationSummary[];
};

export type PublicAdminRetryResult = {
  accepted: true;
  action: 'retry' | 'resume';
  connectionChanged: boolean;
  generationId: string;
};

export type {
  ModelConversationRecord,
  ModelConversationSummary,
  RelayKeySummary,
  RelayKeyTestResult,
};
