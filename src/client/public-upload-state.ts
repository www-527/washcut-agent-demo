export type PublicUploadPhase = 'idle' | 'creating' | 'uploading' | 'starting';
export type PublicUploadItemStatus = 'pending' | 'uploading' | 'uploaded' | 'failed';

export type PublicUploadProgressItem = {
  file: {name: string; size: number};
  status: PublicUploadItemStatus;
  uploadedBytes: number;
};

export type PublicUploadStage =
  | 'selecting'
  | 'creating'
  | 'transferring'
  | 'saving'
  | 'starting'
  | 'paused'
  | 'start_unconfirmed';

export type PublicUploadView = {
  stage: PublicUploadStage;
  totalBytes: number;
  transferredBytes: number;
  uploadedCount: number;
  remainingCount: number;
  progress: number;
  currentItem?: PublicUploadProgressItem;
  currentItemNumber?: number;
  allSaved: boolean;
  elapsedSeconds?: number;
  activityAgeSeconds?: number;
  stalled: boolean;
};

type PublicUploadViewInput = {
  phase: PublicUploadPhase;
  items: PublicUploadProgressItem[];
  taskStatus?: string;
  now: number;
  startedAt?: number;
  lastActivityAt?: number;
};

const elapsedSeconds = (now: number, since: number | undefined) => since === undefined
  ? undefined
  : Math.max(0, Math.floor((now - since) / 1_000));

export const formatElapsedTime = (seconds: number) => {
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes} 分 ${remainder} 秒` : `${minutes} 分钟`;
};

export const derivePublicUploadView = ({
  phase,
  items,
  taskStatus,
  now,
  startedAt,
  lastActivityAt,
}: PublicUploadViewInput): PublicUploadView => {
  const totalBytes = items.reduce((sum, item) => sum + item.file.size, 0);
  const transferredBytes = items.reduce(
    (sum, item) => sum + Math.min(Math.max(item.uploadedBytes, 0), item.file.size),
    0,
  );
  const uploadedCount = items.filter((item) => item.status === 'uploaded').length;
  const currentItem = items.find((item) => item.status === 'uploading');
  const currentItemIndex = currentItem ? items.indexOf(currentItem) : -1;
  const allSaved = items.length > 0 && uploadedCount === items.length;
  const progress = totalBytes > 0 ? Math.min(100, Math.round((transferredBytes / totalBytes) * 100)) : 0;
  const waitSeconds = elapsedSeconds(now, startedAt);
  const activityAgeSeconds = elapsedSeconds(now, lastActivityAt);

  let stage: PublicUploadStage = 'selecting';
  if (phase === 'creating') stage = 'creating';
  else if (phase === 'uploading' && currentItem) {
    stage = currentItem.uploadedBytes >= currentItem.file.size ? 'saving' : 'transferring';
  } else if (phase === 'starting') stage = 'starting';
  else if (phase === 'idle' && allSaved && (taskStatus === 'created' || taskStatus === 'uploaded')) stage = 'start_unconfirmed';
  else if (phase === 'idle' && items.some((item) => item.status === 'failed')) stage = 'paused';

  return {
    stage,
    totalBytes,
    transferredBytes,
    uploadedCount,
    remainingCount: Math.max(0, items.length - uploadedCount),
    progress,
    currentItem,
    currentItemNumber: currentItemIndex >= 0 ? currentItemIndex + 1 : undefined,
    allSaved,
    elapsedSeconds: waitSeconds,
    activityAgeSeconds,
    stalled: stage === 'transferring' && (activityAgeSeconds ?? 0) >= 15,
  };
};
