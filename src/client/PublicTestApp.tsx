import {useCallback, useEffect, useRef, useState} from 'react';
import './public-test.css';
import {
  derivePublicUploadView,
  formatElapsedTime,
  type PublicUploadItemStatus,
  type PublicUploadPhase,
} from './public-upload-state.js';

type PublicTask = {
  taskId: string;
  assetCount: number;
  status: string;
  statusLabel: string;
  progress: number;
  steps: Array<{
    name: string;
    status: string;
    progress: number;
    note?: string;
    errorCode?: string;
    errorMessage?: string;
  }>;
  outputReady: boolean;
  captionedOutputReady: boolean;
  canRetry: boolean;
  error?: {code: string; message: string; retryable: boolean; details?: unknown};
  updatedAt?: string;
};

type UiError = {code?: string; message: string; retryable?: boolean; details?: unknown};
type PageState = 'checking' | 'locked' | 'ready';
type UploadItem = {id: string; file: File; status: PublicUploadItemStatus; uploadedBytes: number; error?: UiError};

const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'needs_attention']);
const preGenerationStatuses = new Set(['created', 'uploaded']);
const taskStorageKey = 'washcut-public-test-task-v1';
const maxFileCount = 50;
const maxFileBytes = 250 * 1024 * 1024;
const maxBatchBytes = 1_000 * 1024 * 1024;

const stepLabels: Record<string, string> = {
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

const formatBytes = (bytes: number) => {
  if (bytes <= 0) return '0 KB';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
};

const uploadItemId = (file: File) => typeof crypto !== 'undefined' && 'randomUUID' in crypto
  ? crypto.randomUUID()
  : `${file.name}:${file.size}:${file.lastModified}:${Math.random().toString(36).slice(2)}`;

const uploadItemKey = (file: File) => `${file.name}:${file.size}:${file.lastModified}`;

const formatErrorDetails = (details: unknown) => typeof details === 'string' ? details : JSON.stringify(details, null, 2);

function ErrorNotice({error, fallback}: {error: UiError; fallback: string}) {
  return <div className="test-alert" role="alert">
    <strong>{error.code ?? fallback}</strong>
    <span>{error.message}</span>
    {error.details ? <details><summary>查看原始错误</summary><pre>{formatErrorDetails(error.details)}</pre></details> : null}
  </div>;
}

const readResponseBody = <Value,>(status: number, statusText: string, raw: string): Value => {
  let body: unknown;
  try { body = raw ? JSON.parse(raw) : undefined; } catch { body = undefined; }
  if (status < 200 || status >= 300) {
    const source = body && typeof body === 'object' && 'error' in body
      ? (body as {error?: Record<string, unknown>}).error
      : undefined;
    if (typeof source?.message === 'string') {
      throw {
        code: typeof source.code === 'string' ? source.code : undefined,
        message: source.message,
        retryable: source.retryable === true,
        details: source.details,
      } satisfies UiError;
    }
    const cloudflareCode = raw.match(/Error code\s*(\d{3})/i)?.[1];
    const displayStatus = cloudflareCode ?? String(status);
    throw {
      code: `HTTP_${displayStatus}`,
      message: cloudflareCode === '524'
        ? '公网中转站等待本机处理超时。该素材尚未保存，可以删除后稍后重试。'
        : `上传请求失败（HTTP ${displayStatus}）。`,
      retryable: status >= 500 || cloudflareCode === '524',
      // Preserve the intermediary's original body for diagnosis without
      // flooding the main error message with an HTML error page.
      details: raw || statusText,
    } satisfies UiError;
  }
  return body as Value;
};

const readResponse = async <Value,>(response: Response): Promise<Value> =>
  readResponseBody<Value>(response.status, response.statusText, await response.text());

const uploadFile = (taskId: string, item: UploadItem, onProgress: (loadedBytes: number) => void) =>
  new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    const form = new FormData();
    form.append('files', item.file);
    request.open('POST', `/api/test/tasks/${encodeURIComponent(taskId)}/assets`);
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress(Math.min(event.loaded, item.file.size));
    });
    request.addEventListener('load', () => {
      try {
        readResponseBody(request.status, request.statusText, request.responseText);
        onProgress(item.file.size);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    request.addEventListener('error', () => reject({
      code: 'TEST_UPLOAD_NETWORK_ERROR',
      message: '上传网络连接中断，请检查网络后重试。',
      retryable: true,
    } satisfies UiError));
    request.addEventListener('abort', () => reject({
      code: 'TEST_UPLOAD_ABORTED',
      message: '上传已中断。',
      retryable: true,
    } satisfies UiError));
    request.send(form);
  });

const toUiError = (error: unknown): UiError => {
  if (error && typeof error === 'object' && 'message' in error) {
    const source = error as Record<string, unknown>;
    return {
      code: typeof source.code === 'string' ? source.code : undefined,
      message: typeof source.message === 'string' ? source.message : '请求失败。',
      retryable: source.retryable === true,
      details: source.details,
    };
  }
  return {message: String(error)};
};

const fileValidationError = (files: File[]) => {
  if (!files.length) return '请先选择视频片段。';
  if (files.length > maxFileCount) return `一次最多上传 ${maxFileCount} 段视频。`;
  const oversized = files.find((file) => file.size > maxFileBytes);
  if (oversized) return `“${oversized.name}”超过单段 250 MB 限制。`;
  const invalid = files.find((file) => !/\.(mp4|mov|webm)$/i.test(file.name));
  if (invalid) return `“${invalid.name}”不是支持的 MP4、MOV 或 WebM 视频。`;
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > maxBatchBytes) return '本批视频总大小超过 1000 MB。';
  return undefined;
};

export default function PublicTestApp() {
  const [pageState, setPageState] = useState<PageState>('checking');
  const [accessCode, setAccessCode] = useState('');
  const [uploadItems, setUploadItems] = useState<UploadItem[]>([]);
  const [task, setTask] = useState<PublicTask>();
  const [phase, setPhase] = useState<PublicUploadPhase>('idle');
  const [error, setError] = useState<UiError>();
  const [dragging, setDragging] = useState(false);
  const [uploadStartedAt, setUploadStartedAt] = useState<number>();
  const [lastUploadActivityAt, setLastUploadActivityAt] = useState<number>();
  const [uploadClock, setUploadClock] = useState(() => Date.now());
  const inputRef = useRef<HTMLInputElement>(null);
  const taskCardRef = useRef<HTMLElement>(null);
  const files = uploadItems.map((item) => item.file);

  const loadTask = useCallback(async (taskId: string) => {
    try {
      const next = await readResponse<PublicTask>(await fetch(`/api/test/tasks/${encodeURIComponent(taskId)}`, {cache: 'no-store'}));
      setTask(next);
      if (next.status === 'completed') setError(undefined);
      return next;
    } catch (caught) {
      const nextError = toUiError(caught);
      if (nextError.code === 'TEST_TASK_NOT_FOUND') {
        localStorage.removeItem(taskStorageKey);
        setTask(undefined);
      } else if (nextError.code === 'TEST_SESSION_REQUIRED') {
        setPageState('locked');
      } else {
        setError(nextError);
      }
      return undefined;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await readResponse(await fetch('/api/test/session', {cache: 'no-store'}));
        if (cancelled) return;
        setPageState('ready');
        const storedTaskId = localStorage.getItem(taskStorageKey);
        if (storedTaskId) await loadTask(storedTaskId);
      } catch {
        if (!cancelled) setPageState('locked');
      }
    })();
    return () => { cancelled = true; };
  }, [loadTask]);

  useEffect(() => {
    if (!task || terminalStatuses.has(task.status)) return;
    const timer = window.setInterval(() => void loadTask(task.taskId), 2_500);
    return () => window.clearInterval(timer);
  }, [loadTask, task]);

  useEffect(() => {
    if (phase === 'idle') return;
    setUploadClock(Date.now());
    const timer = window.setInterval(() => setUploadClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [phase]);

  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!accessCode.trim()) return;
    setError(undefined);
    try {
      await readResponse(await fetch('/api/test/login', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({accessCode: accessCode.trim()}),
      }));
      setAccessCode('');
      setPageState('ready');
    } catch (caught) {
      setError(toUiError(caught));
    }
  };

  const selectFiles = (nextFiles: File[]) => {
    if (!nextFiles.length) return;
    const existingKeys = new Set(uploadItems.map((item) => uploadItemKey(item.file)));
    const additions = nextFiles.filter((file) => !existingKeys.has(uploadItemKey(file)));
    if (!additions.length) {
      setError({message: '所选视频已经在列表中，无需重复添加。'});
      return;
    }
    const combinedFiles = [...files, ...additions];
    const nextError = fileValidationError(combinedFiles);
    setError(nextError ? {message: nextError} : undefined);
    if (!nextError) {
      if (!uploadItems.length) {
        setUploadStartedAt(undefined);
        setLastUploadActivityAt(undefined);
      }
      setUploadItems((current) => [
        ...current,
        ...additions.map((file) => ({id: uploadItemId(file), file, status: 'pending' as const, uploadedBytes: 0})),
      ]);
    }
  };

  const updateUploadItem = (itemId: string, patch: Partial<UploadItem>) => {
    setUploadItems((current) => current.map((item) => item.id === itemId ? {...item, ...patch} : item));
  };

  const removeUploadItem = (itemId: string) => {
    if (phase !== 'idle') return;
    setUploadItems((current) => current.filter((item) => item.id !== itemId));
    setError(undefined);
    if (inputRef.current) inputRef.current.value = '';
  };

  const uploadPendingItems = async (taskId: string) => {
    for (const item of uploadItems) {
      if (item.status === 'uploaded') continue;
      setLastUploadActivityAt(Date.now());
      updateUploadItem(item.id, {status: 'uploading', uploadedBytes: 0, error: undefined});
      try {
        await uploadFile(taskId, item, (uploadedBytes) => {
          updateUploadItem(item.id, {uploadedBytes});
          setLastUploadActivityAt(Date.now());
        });
        updateUploadItem(item.id, {status: 'uploaded', uploadedBytes: item.file.size});
        setLastUploadActivityAt(Date.now());
        setTask((current) => current?.taskId === taskId ? {...current, assetCount: current.assetCount + 1} : current);
      } catch (caught) {
        const uploadError = toUiError(caught);
        const materialError = {...uploadError, message: `素材“${item.file.name}”上传失败：${uploadError.message}`};
        updateUploadItem(item.id, {status: 'failed', error: uploadError});
        setError(materialError);
        return false;
      }
    }
    return true;
  };

  const start = async () => {
    const validationError = fileValidationError(files);
    if (validationError || phase !== 'idle') {
      if (validationError) setError({message: validationError});
      return;
    }
    setError(undefined);
    const startedAt = Date.now();
    setUploadStartedAt(startedAt);
    setLastUploadActivityAt(undefined);
    setUploadClock(startedAt);
    try {
      let taskId = task && preGenerationStatuses.has(task.status) ? task.taskId : undefined;
      if (!taskId) {
        setPhase('creating');
        const created = await readResponse<{taskId: string}>(await fetch('/api/test/tasks', {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: '{}',
        }));
        taskId = created.taskId;
        localStorage.setItem(taskStorageKey, taskId);
        setTask({taskId, assetCount: 0, status: 'created', statusLabel: '准备上传', progress: 0, steps: [], outputReady: false, captionedOutputReady: false, canRetry: false});
      }

      setPhase('uploading');
      if (!await uploadPendingItems(taskId)) return;

      setPhase('starting');
      await readResponse(await fetch(`/api/test/tasks/${encodeURIComponent(taskId)}/start`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: '{}',
      }));
      setUploadItems([]);
      if (inputRef.current) inputRef.current.value = '';
      const nextTask = await loadTask(taskId);
      if (nextTask) {
        window.requestAnimationFrame(() => {
          taskCardRef.current?.focus({preventScroll: true});
          taskCardRef.current?.scrollIntoView({block: 'start'});
        });
      }
      setUploadStartedAt(undefined);
      setLastUploadActivityAt(undefined);
    } catch (caught) {
      setError(toUiError(caught));
    } finally {
      setPhase('idle');
    }
  };

  const newTask = () => {
    localStorage.removeItem(taskStorageKey);
    setTask(undefined);
    setUploadItems([]);
    setError(undefined);
    setUploadStartedAt(undefined);
    setLastUploadActivityAt(undefined);
    if (inputRef.current) inputRef.current.value = '';
  };

  if (pageState === 'checking') {
    return <main className="test-shell test-centered" aria-live="polite"><div className="test-loader" /><p>正在连接本机制作服务…</p></main>;
  }

  if (pageState === 'locked') {
    return <main className="test-shell test-login">
      <section className="test-login-card" aria-labelledby="test-login-title">
        <div className="test-mark" aria-hidden="true">洗</div>
        <p className="test-kicker">洗车短视频内测</p>
        <h1 id="test-login-title">上传片段，等待成片</h1>
        <p className="test-intro">输入访问码，免费体验自动成片。</p>
        <form onSubmit={login}>
          <label htmlFor="test-access-code">测试访问码</label>
          <div className="test-code-row">
            <input id="test-access-code" type="password" autoComplete="one-time-code" value={accessCode} onChange={(event) => setAccessCode(event.target.value)} placeholder="请输入访问码" autoFocus />
            <button type="submit" disabled={!accessCode.trim()}>进入测试</button>
          </div>
        </form>
        {error ? <ErrorNotice error={error} fallback="无法进入" /> : null}
      </section>
    </main>;
  }

  const uploadView = derivePublicUploadView({
    phase,
    items: uploadItems,
    taskStatus: task?.status,
    now: uploadClock,
    startedAt: uploadStartedAt,
    lastActivityAt: lastUploadActivityAt,
  });
  const uploadProgressLabel = (() => {
    switch (uploadView.stage) {
      case 'creating': return '正在创建安全上传任务';
      case 'transferring': return `正在上传第 ${uploadView.currentItemNumber} / ${uploadItems.length} 段：${uploadView.currentItem?.file.name}`;
      case 'saving': return `第 ${uploadView.currentItemNumber} / ${uploadItems.length} 段已传输，正在本机保存`;
      case 'starting': return `全部 ${uploadItems.length} 段已保存，正在启动制作`;
      case 'paused': return `上传暂停，已保存 ${uploadView.uploadedCount} / ${uploadItems.length} 段`;
      case 'start_unconfirmed': return `全部 ${uploadItems.length} 段已保存，等待重新启动制作`;
      default: return '等待开始上传';
    }
  })();
  const uploadStageIndex = ({
    creating: 0,
    transferring: 1,
    paused: 1,
    saving: 2,
    starting: 3,
    start_unconfirmed: 3,
    selecting: 0,
  } as const)[uploadView.stage];
  const uploadStages = ['创建任务', '上传传输', '本机保存', '启动制作'];
  const uploadActivityText = uploadView.activityAgeSeconds === undefined
    ? undefined
    : uploadView.activityAgeSeconds < 5
      ? '最近进度刚刚更新'
      : `最近进度 ${formatElapsedTime(uploadView.activityAgeSeconds)}前更新`;
  const submitLabel = phase === 'creating'
    ? '正在创建任务…'
    : phase === 'uploading'
      ? '正在上传视频…'
      : phase === 'starting'
        ? '正在启动制作…'
        : uploadView.stage === 'start_unconfirmed'
          ? '重新尝试启动制作'
          : uploadView.stage === 'paused'
            ? `继续上传剩余 ${uploadView.remainingCount} 段并开始制作`
            : '上传并开始制作';
  const working = phase !== 'idle';
  const hasActiveTask = Boolean(task && !terminalStatuses.has(task.status) && !preGenerationStatuses.has(task.status));

  return <main className="test-shell">
    <header className="test-header">
      <div><span className="test-mark small" aria-hidden="true">洗</span><strong>洗车短视频</strong></div>
      <span className="test-local-pill">免费内测</span>
    </header>

    <section className="test-hero" aria-labelledby="test-page-title">
      <h1 id="test-page-title">洗车片段，自动成片</h1>
      <p>保留全部原片，自动编排顺序。</p>
      <ol aria-label="制作流程"><li><b>1</b><span>上传</span></li><li><b>2</b><span>制作</span></li><li><b>3</b><span>下载</span></li></ol>
    </section>

    {task ? <section ref={taskCardRef} className="test-task-card" aria-live="polite" tabIndex={-1}>
      <div className="test-task-heading">
        <div><h2>{task.statusLabel}</h2></div>
        <strong className="test-progress-number">{task.progress}%</strong>
      </div>
      <div className="test-progress-track" role="progressbar" aria-label="制作进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={task.progress}><i style={{width: `${task.progress}%`}} /></div>
      <p className="test-task-meta">已接收 {task.assetCount} 段视频{task.updatedAt ? ` · ${new Date(task.updatedAt).toLocaleString('zh-CN', {hour12: false})} 更新` : ''}</p>

      {task.steps.length ? <ol className="test-steps">
        {task.steps.map((step) => <li className={step.status} key={step.name}>
          <span aria-hidden="true">{step.status === 'completed' ? '✓' : step.status === 'running' ? '·' : step.status === 'failed' ? '!' : ''}</span>
          <div><strong>{stepLabels[step.name] ?? step.name}</strong><small>{step.status === 'running' ? `${step.progress}%` : step.note ?? step.errorMessage ?? ''}</small></div>
        </li>)}
      </ol> : null}

      {task.error ? <div className="test-alert" role="alert"><strong>{task.error.code}</strong><span>{task.error.message}</span>{task.error.retryable || task.status === 'needs_attention' ? <small>进度已保留，请等待管理员处理，无需重复上传。</small> : null}</div> : null}

      {task.outputReady ? <div className="test-downloads">
        <div><span className="test-success-icon" aria-hidden="true">✓</span><strong>成片已就绪</strong></div>
        <a className="test-primary" href={`/api/test/tasks/${encodeURIComponent(task.taskId)}/download/plain`}>下载无字幕成片</a>
        <a className="test-secondary" href={`/api/test/tasks/${encodeURIComponent(task.taskId)}/download/captioned`}>{task.captionedOutputReady ? '下载带字幕成片' : '生成并下载字幕版'}</a>
      </div> : null}

      {terminalStatuses.has(task.status) ? <div className="test-task-actions">
        <button type="button" className="test-new-task" onClick={newTask}>开始新的测试</button>
      </div> : null}
    </section> : null}

    {!task || preGenerationStatuses.has(task.status) ? <section className="test-upload-card" aria-labelledby="test-upload-title">
      <div className="test-section-heading"><h2 id="test-upload-title">添加视频</h2></div>
      <button type="button" className={`test-dropzone${dragging ? ' dragging' : ''}`} onClick={() => inputRef.current?.click()} onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); selectFiles(Array.from(event.dataTransfer.files)); }}>
        <span className="test-upload-icon" aria-hidden="true">↑</span>
        <strong>{files.length ? `继续添加（已选 ${files.length} 段）` : '点击或拖入视频'}</strong>
        <small>MP4 / MOV / WebM · 可多次添加<br />最多 50 段 · 单段 ≤ 250 MB · 总计 ≤ 1000 MB</small>
      </button>
      <input ref={inputRef} className="test-file-input" type="file" aria-label="选择视频文件，可分多次添加" tabIndex={-1} accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm" multiple onChange={(event) => { selectFiles(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ''; }} />

       {uploadItems.length ? <div className="test-file-summary">
         <div className="test-file-summary-heading"><strong>{uploadItems.length} 段视频</strong><span>{formatBytes(uploadView.totalBytes)}</span></div>
         {uploadView.stage !== 'selecting' || uploadView.uploadedCount > 0 ? <ol className="test-upload-stages" aria-label="上传阶段">
           {uploadStages.map((stage, index) => {
             const isCurrent = index === uploadStageIndex;
             const className = index < uploadStageIndex
               ? 'completed'
               : isCurrent && uploadView.stage === 'start_unconfirmed'
                 ? 'attention'
                 : isCurrent && uploadView.stage === 'paused'
                   ? 'paused'
                   : isCurrent && working
                     ? 'current'
                     : '';
             return <li className={className} key={stage}><span aria-hidden="true">{index < uploadStageIndex ? '✓' : index + 1}</span><small>{stage}</small></li>;
           })}
         </ol> : null}
         <div className={`test-upload-progress${uploadView.stalled ? ' stalled' : ''}`}>
           <div className="test-upload-progress-heading" role="status" aria-live="polite" aria-atomic="true"><strong>{uploadProgressLabel}</strong><span>{uploadView.progress}%</span></div>
           <div className="test-upload-progress-track" role="progressbar" aria-label="视频上传传输进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={uploadView.progress} aria-valuetext={`${formatBytes(uploadView.transferredBytes)} / ${formatBytes(uploadView.totalBytes)}，已保存 ${uploadView.uploadedCount} / ${uploadItems.length} 段`}><i style={{width: `${uploadView.progress}%`}} /></div>
           <div className="test-upload-metrics">
             <span>{formatBytes(uploadView.transferredBytes)} / {formatBytes(uploadView.totalBytes)}</span>
             <span>已保存 {uploadView.uploadedCount} / {uploadItems.length} 段</span>
             {uploadView.elapsedSeconds === undefined ? null : <span>已等待 {formatElapsedTime(uploadView.elapsedSeconds)}</span>}
             {uploadActivityText ? <span>{uploadActivityText}</span> : null}
           </div>
           {uploadView.stalled ? <p className="test-upload-slow" role="status"><strong>15 秒无新进度，仍在上传</strong><span>请保持页面打开；超过 1 分钟无变化时，请检查网络。</span></p> : null}
         </div>
         {uploadView.stage === 'starting' || uploadView.stage === 'start_unconfirmed' ? <div className="test-upload-confirmation" role="status">
           <span className="test-success-icon" aria-hidden="true">✓</span>
           <div><strong>素材已保存</strong><small>{uploadView.stage === 'starting' ? '正在启动制作，启动后可离开页面。' : '启动未确认，请点击下方按钮重试，无需重新上传。'}</small></div>
         </div> : null}
         <ul>{uploadItems.map((item) => <li className={`test-upload-item ${item.status}`} key={item.id}><div><span title={item.file.name}>{item.file.name}</span>{item.error ? <small className="test-file-error">{item.error.code ?? '上传失败'} · {item.error.message}</small> : <small className="test-file-status">{item.status === 'uploading' ? item.uploadedBytes >= item.file.size ? '网络传输完成，正在制作方电脑保存…' : `正在上传 ${Math.round((item.uploadedBytes / item.file.size) * 100)}% · ${formatBytes(item.uploadedBytes)} / ${formatBytes(item.file.size)}` : item.status === 'uploaded' ? '已保存到制作方电脑' : item.status === 'failed' ? '上传失败' : '等待上传'}</small>}</div><small>{formatBytes(item.file.size)}</small><button type="button" className="test-file-remove" disabled={working || item.status === 'uploaded'} title={item.status === 'uploaded' ? '已保存到本机的素材不能在公网测试页删除' : `删除 ${item.file.name}`} aria-label={`删除 ${item.file.name}`} onClick={() => removeUploadItem(item.id)}>删除</button></li>)}</ul>
       </div> : null}

       {error ? <ErrorNotice error={error} fallback={uploadView.stage === 'start_unconfirmed' ? '启动制作请求未确认' : '请检查素材'} /> : null}

      <button type="button" className="test-primary test-submit" disabled={!files.length || working} onClick={() => void start()}>
        {submitLabel}
      </button>
      <div className={`test-upload-guidance${working ? ' active' : ''}`} role="note">
        <span>{working ? '上传中请勿锁屏、切网或关闭页面。' : '上传时请保持页面打开，制作启动后可离开。'}</span>
      </div>
    </section> : null}

    {hasActiveTask && error ? <div className="test-alert test-page-alert" role="alert"><strong>{error.code ?? '状态更新失败'}</strong><span>{error.message}</span><small>任务不会因此重复创建；页面会继续尝试读取当前状态。</small></div> : null}

  </main>;
}
