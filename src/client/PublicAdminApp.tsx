import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import type {
  ModelConversationRecord,
  ModelConversationSummary,
  PublicAdminRetryResult,
  PublicAdminSnapshot,
  PublicAdminTask,
  RelayKeyTestResult,
} from '../shared/public-admin';
import './public-admin.css';

type UiError = {code?: string; message: string; retryable?: boolean; details?: unknown};

const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'needs_attention']);
const sourceLabels: Record<string, string> = {
  'auto-video.screenshot-analysis': '截图视觉分析',
  'auto-video.visual-repair': '视觉结果修复',
  'auto-video.asset-understanding': '素材综合理解',
  'auto-video.marketing-role-batch': '营销作用标注',
  'auto-video.edit-planning': '智能编排',
  'relay.connection-test': '连接测试',
};
const stepStatusLabels: Record<string, string> = {
  pending: '待开始',
  running: '进行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  retry_waiting: '等待自动重试',
};
const readableConnectionMessage = (message: string) => ({
  'Model connection was tested and is ready for asset understanding and sequencing.': '模型连接已测试，可用于素材理解和智能编排。',
  'Model connection is saved and ready for asset understanding and sequencing.': '模型连接已保存，可用于素材理解和智能编排。',
  'Connection succeeded and returned response.completed.': '连接成功，已收到完整响应。',
}[message] ?? message);
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

const formatTime = (value?: string) => value
  ? new Date(value).toLocaleString('zh-CN', {hour12: false})
  : '—';
const formatLatency = (value: number) => value >= 1_000 ? `${(value / 1_000).toFixed(1)} 秒` : `${value} ms`;
const sourceLabel = (source: string) => sourceLabels[source] ?? source;

const toUiError = (caught: unknown): UiError => {
  if (caught && typeof caught === 'object' && 'message' in caught) {
    const source = caught as Record<string, unknown>;
    return {
      ...(typeof source.code === 'string' ? {code: source.code} : {}),
      message: typeof source.message === 'string' ? source.message : '请求失败。',
      ...(typeof source.retryable === 'boolean' ? {retryable: source.retryable} : {}),
      ...(source.details === undefined ? {} : {details: source.details}),
    };
  }
  return {message: String(caught)};
};

const readJson = async <Value,>(response: Response): Promise<Value> => {
  const raw = await response.text();
  let body: unknown;
  try { body = raw ? JSON.parse(raw) : undefined; } catch { body = undefined; }
  if (!response.ok) {
    const error = body && typeof body === 'object' && 'error' in body
      ? (body as {error?: UiError}).error
      : undefined;
    throw error ?? {code: `HTTP_${response.status}`, message: raw || response.statusText, retryable: response.status >= 500};
  }
  return body as Value;
};

const adminPost = async <Value,>(url: string, body?: unknown) => readJson<Value>(await fetch(url, {
  method: 'POST',
  headers: {
    'x-washcut-admin-request': '1',
    ...(body === undefined ? {} : {'content-type': 'application/json'}),
  },
  ...(body === undefined ? {} : {body: JSON.stringify(body)}),
}));

function StatusBadge({status}: {status: string}) {
  const label = ({
    created: '待上传', uploaded: '待开始',
    queued: '排队中', analyzing: '分析中', retry_waiting: '自动重试', planning: '编排中', rendering: '渲染中',
    completed: '已完成', failed: '失败', cancelled: '已取消', needs_attention: '待处理', streaming: '接收中',
  } as Record<string, string>)[status] ?? status;
  return <span className={`admin-status ${status}`}><i aria-hidden="true" />{label}</span>;
}

function EmptyState({title, detail}: {title: string; detail: string}) {
  return <div className="admin-empty"><strong>{title}</strong><span>{detail}</span></div>;
}

export default function PublicAdminApp() {
  const [snapshot, setSnapshot] = useState<PublicAdminSnapshot>();
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [conversations, setConversations] = useState<ModelConversationSummary[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string>();
  const [conversation, setConversation] = useState<ModelConversationRecord>();
  const [selectedKeyId, setSelectedKeyId] = useState('');
  const [loading, setLoading] = useState(true);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [busyAction, setBusyAction] = useState('');
  const [error, setError] = useState<UiError>();
  const [notice, setNotice] = useState('');
  const [keyTest, setKeyTest] = useState<RelayKeyTestResult>();
  const mounted = useRef(true);

  const refreshSnapshot = useCallback(async () => {
    try {
      const next = await readJson<PublicAdminSnapshot>(await fetch('/api/admin/snapshot', {cache: 'no-store'}));
      if (!mounted.current) return;
      setSnapshot(next);
      setSelectedTaskId((current) => current && next.tasks.some((task) => task.taskId === current)
        ? current
        : next.tasks[0]?.taskId);
      setSelectedKeyId((current) => current && next.keys.some((key) => key.keyId === current)
        ? current
        : next.keys.find((key) => key.active)?.keyId ?? next.keys[0]?.keyId ?? '');
      setError(undefined);
    } catch (caught) {
      if (mounted.current) setError(toUiError(caught));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    let timer = 0;
    const poll = async () => {
      await refreshSnapshot();
      if (mounted.current) timer = window.setTimeout(poll, 2_500);
    };
    void poll();
    return () => { mounted.current = false; window.clearTimeout(timer); };
  }, [refreshSnapshot]);

  const refreshConversations = useCallback(async (taskId: string) => {
    try {
      const next = await readJson<{conversations: ModelConversationSummary[]}>(await fetch(
        `/api/admin/tasks/${encodeURIComponent(taskId)}/conversations?limit=100`,
        {cache: 'no-store'},
      ));
      if (!mounted.current || selectedTaskId !== taskId) return;
      setConversations(next.conversations);
      setSelectedConversationId((current) => current && next.conversations.some((item) => item.id === current)
        ? current
        : next.conversations[0]?.id);
    } catch (caught) {
      if (mounted.current) setError(toUiError(caught));
    }
  }, [selectedTaskId]);

  useEffect(() => {
    setConversations([]);
    setSelectedConversationId(undefined);
    setConversation(undefined);
    if (!selectedTaskId) return;
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      await refreshConversations(selectedTaskId);
      if (!cancelled) timer = window.setTimeout(poll, 2_500);
    };
    void poll();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [refreshConversations, selectedTaskId]);

  useEffect(() => {
    if (!selectedConversationId) { setConversation(undefined); return; }
    let cancelled = false;
    setConversationLoading(true);
    void fetch(`/api/admin/conversations/${encodeURIComponent(selectedConversationId)}`, {cache: 'no-store'})
      .then((response) => readJson<ModelConversationRecord>(response))
      .then((next) => { if (!cancelled) setConversation(next); })
      .catch((caught) => { if (!cancelled) setError(toUiError(caught)); })
      .finally(() => { if (!cancelled) setConversationLoading(false); });
    return () => { cancelled = true; };
  }, [selectedConversationId, conversations.find((item) => item.id === selectedConversationId)?.status]);

  const selectedTask = snapshot?.tasks.find((task) => task.taskId === selectedTaskId);
  const selectedKey = snapshot?.keys.find((key) => key.keyId === selectedKeyId);
  const activeKey = snapshot?.keys.find((key) => key.active);
  const stats = useMemo(() => {
    const tasks = snapshot?.tasks ?? [];
    return {
      total: tasks.length,
      active: tasks.filter((task) => !terminalStatuses.has(task.status) && !['created', 'uploaded'].includes(task.status)).length,
      attention: tasks.filter((task) => task.status === 'needs_attention' || task.status === 'failed').length,
      completed: tasks.filter((task) => task.status === 'completed').length,
    };
  }, [snapshot]);

  const activateKey = async () => {
    if (!selectedKey || selectedKey.active || busyAction) return;
    setBusyAction('activate-key'); setError(undefined); setNotice(''); setKeyTest(undefined);
    try {
      await adminPost(`/api/admin/keys/${encodeURIComponent(selectedKey.keyId)}/activate`);
      setNotice(`已切换到“${selectedKey.name}”。新任务会使用该 Key；人工重试时也会按当前选择重新绑定。`);
      await refreshSnapshot();
    } catch (caught) { setError(toUiError(caught)); }
    finally { setBusyAction(''); }
  };

  const testKey = async () => {
    if (!selectedKey || busyAction) return;
    setBusyAction('test-key'); setError(undefined); setNotice(''); setKeyTest(undefined);
    try { setKeyTest(await adminPost<RelayKeyTestResult>(`/api/admin/keys/${encodeURIComponent(selectedKey.keyId)}/test`)); }
    catch (caught) { setError(toUiError(caught)); }
    finally { setBusyAction(''); }
  };

  const openUploadsFolder = async () => {
    if (busyAction) return;
    setBusyAction('open-uploads'); setError(undefined); setNotice('');
    try {
      await adminPost<{opened: true}>('/api/admin/uploads/open');
      setNotice('已在本机打开用户上传素材文件夹。');
    } catch (caught) { setError(toUiError(caught)); }
    finally { setBusyAction(''); }
  };

  const retryTask = async () => {
    if (!selectedTask?.canRetry || busyAction) return;
    const keyName = selectedKey ? `“${selectedKey.name}”` : '该任务原有连接';
    if (!window.confirm(`确认从已保存的检查点恢复这个任务？本次将使用 ${keyName}，并可能产生新的模型调用。`)) return;
    setBusyAction('retry-task'); setError(undefined); setNotice('');
    try {
      const result = await adminPost<PublicAdminRetryResult>(
        `/api/admin/tasks/${encodeURIComponent(selectedTask.taskId)}/retry`,
        selectedKey ? {connectionId: selectedKey.keyId} : {},
      );
      setNotice(`已提交人工${result.action === 'resume' ? '恢复' : '重试'}${result.connectionChanged ? '，并切换到所选 Key' : ''}。已完成步骤会继续保留。`);
      await refreshSnapshot();
    } catch (caught) { setError(toUiError(caught)); }
    finally { setBusyAction(''); }
  };

  return <main className="admin-shell">
    <header className="admin-topbar">
      <div className="admin-brand"><span aria-hidden="true">洗</span><div><small>本机管理工具</small><strong>公网测试 · 管理面板</strong></div></div>
      <div className="admin-topbar-actions">
        <span className="admin-local-badge"><i aria-hidden="true" />仅本机 127.0.0.1</span>
        <button type="button" onClick={() => void openUploadsFolder()} disabled={Boolean(busyAction)}>{busyAction === 'open-uploads' ? '正在打开…' : '打开素材文件夹'}</button>
        <button type="button" onClick={() => void refreshSnapshot()} disabled={loading || Boolean(busyAction)}>{loading ? '连接中…' : '立即刷新'}</button>
      </div>
    </header>

    <section className="admin-overview" aria-labelledby="overview-title">
      <div><p className="admin-eyebrow">运行总览</p><h1 id="overview-title">公网测试运行概览</h1><p>每 2.5 秒自动刷新。查看任务进度、中转站往返，并在需要时执行人工恢复；完整 API Key 始终留在服务端。</p></div>
      <dl className="admin-metrics">
        <div><dt>公网任务</dt><dd>{stats.total}</dd></div>
        <div><dt>运行中</dt><dd>{stats.active}</dd></div>
        <div className={stats.attention ? 'danger' : ''}><dt>待处理</dt><dd>{stats.attention}</dd></div>
        <div><dt>已完成</dt><dd>{stats.completed}</dd></div>
      </dl>
    </section>

    {error ? <section className="admin-alert" role="alert"><strong>{error.code ?? '操作失败'}</strong><span>{error.message}</span>{error.details ? <details><summary>查看原始详情</summary><pre>{typeof error.details === 'string' ? error.details : JSON.stringify(error.details, null, 2)}</pre></details> : null}</section> : null}
    {notice ? <div className="admin-notice" role="status">{notice}</div> : null}

    <section className="admin-grid">
      <aside className="admin-panel admin-task-list" aria-labelledby="task-list-title">
        <div className="admin-panel-heading"><div><p className="admin-eyebrow">队列</p><h2 id="task-list-title">公网测试任务</h2></div><span>{snapshot ? formatTime(snapshot.refreshedAt) : '读取中'}</span></div>
        {!snapshot && loading ? <EmptyState title="正在连接本机制作服务" detail="首次读取可能需要几秒。" /> : null}
        {snapshot && !snapshot.tasks.length ? <EmptyState title="还没有公网测试任务" detail="测试者创建任务后会自动出现在这里。" /> : null}
        <div className="admin-task-buttons">
          {snapshot?.tasks.map((task) => <button type="button" className={task.taskId === selectedTaskId ? 'selected' : ''} key={task.taskId} onClick={() => setSelectedTaskId(task.taskId)}>
            <span><StatusBadge status={task.status} /><time>{formatTime(task.updatedAt)}</time></span>
            <strong>{task.statusLabel}</strong>
            <small>{task.assetCount} 段素材 · {task.progress}% · 测试者 {task.testerId}</small>
          </button>)}
        </div>
      </aside>

      <section className="admin-panel admin-task-detail" aria-labelledby="task-detail-title">
        <div className="admin-panel-heading"><div><p className="admin-eyebrow">流程</p><h2 id="task-detail-title">任务执行进度</h2></div>{selectedTask ? <StatusBadge status={selectedTask.status} /> : null}</div>
        {!selectedTask ? <EmptyState title="选择一个任务" detail="查看批量进度、自动重试次数和原始错误。" /> : <>
          <div className="admin-task-summary">
            <div><strong>{selectedTask.progress}%</strong><span>{selectedTask.statusLabel}</span></div>
            <dl><div><dt>任务</dt><dd>{selectedTask.taskId}</dd></div><div><dt>模型</dt><dd>{selectedTask.model ?? '—'}</dd></div><div><dt>连接</dt><dd>{selectedTask.connectionId ?? '—'}</dd></div></dl>
          </div>
          <progress className="admin-progress" aria-label="任务进度" max={100} value={selectedTask.progress}>{selectedTask.progress}%</progress>
          {selectedTask.steps.length ? <ol className="admin-steps">{selectedTask.steps.map((step, index) => <li className={step.status} key={`${step.name}:${index}`}>
            <span aria-hidden="true">{step.status === 'completed' ? '✓' : step.status === 'failed' ? '!' : index + 1}</span>
            <div><strong>{stepLabels[step.name] ?? step.name}</strong><small>{step.status === 'running' ? `进行中 · ${step.progress}%` : step.status === 'retry_waiting' ? `等待自动重试 · ${step.progress}%` : step.errorMessage ?? step.note ?? stepStatusLabels[step.status] ?? step.status}</small></div>
          </li>)}</ol> : <EmptyState title="尚未开始制作" detail="等待测试者完成素材上传。" />}
          {selectedTask.retryState ? <section className="admin-retry-state"><div><strong>自动恢复记录</strong><span>总尝试 {selectedTask.retryState.totalAttempts} 次 · 服务恢复 {selectedTask.retryState.recoveryAttempts} 次</span></div>{selectedTask.retryState.nextRetryAt ? <small>下次自动尝试：{formatTime(selectedTask.retryState.nextRetryAt)}</small> : null}</section> : null}
          {selectedTask.error ? <section className="admin-task-error" role="alert"><strong>{selectedTask.error.code}</strong><p>{selectedTask.error.message}</p>{selectedTask.error.details ? <pre>{selectedTask.error.details}</pre> : null}</section> : null}
          {selectedTask.canRetry ? <section className="admin-manual-retry"><div><strong>需要管理员决定</strong><p>自动重试已经停止。确认 Key 可用后，可从已完成检查点继续，不会重新上传素材。</p><small>本次重试连接：{selectedKey ? `${selectedKey.name} · ${selectedKey.model}` : '沿用任务原连接'}</small></div><button type="button" onClick={() => void retryTask()} disabled={Boolean(busyAction)}>{busyAction === 'retry-task' ? '正在提交…' : '人工从断点重试'}</button></section> : null}
        </>}
      </section>

      <aside className="admin-panel admin-key-panel" aria-labelledby="key-panel-title">
        <div className="admin-panel-heading"><div><p className="admin-eyebrow">模型连接</p><h2 id="key-panel-title">API Key 切换</h2></div>{activeKey ? <span className="admin-active-dot">当前可用</span> : null}</div>
        <p className="admin-connection-message">{snapshot ? readableConnectionMessage(snapshot.connectionStatus.message) : '正在读取连接状态…'}</p>
        {snapshot?.keys.length ? <>
          <label htmlFor="admin-key-select">选择已加密保存的连接</label>
          <select id="admin-key-select" value={selectedKeyId} onChange={(event) => {setSelectedKeyId(event.target.value); setKeyTest(undefined);}}>
            {snapshot.keys.map((key) => <option value={key.keyId} key={key.keyId}>{key.active ? '当前 · ' : ''}{key.name} · {key.model}</option>)}
          </select>
          {selectedKey ? <dl className="admin-key-meta"><div><dt>掩码</dt><dd>{selectedKey.maskedKey}</dd></div><div><dt>模型</dt><dd>{selectedKey.model}</dd></div><div><dt>地址</dt><dd>{selectedKey.baseUrl}</dd></div></dl> : null}
          {keyTest ? <div className={`admin-key-test ${keyTest.ok ? 'ok' : 'failed'}`} role="status"><strong>{keyTest.ok ? '连接测试通过' : '连接测试失败'}</strong><span>{readableConnectionMessage(keyTest.message)} · {formatLatency(keyTest.latencyMs)}</span></div> : null}
          <div className="admin-key-actions"><button type="button" onClick={() => void testKey()} disabled={!selectedKey || Boolean(busyAction)}>{busyAction === 'test-key' ? '测试中…' : '测试连接'}</button><button className="primary" type="button" onClick={() => void activateKey()} disabled={!selectedKey || selectedKey.active || Boolean(busyAction)}>{selectedKey?.active ? '正在使用' : busyAction === 'activate-key' ? '切换中…' : '设为当前 Key'}</button></div>
          <small className="admin-key-note">切换会影响后续新任务；对待处理任务点击“人工从断点重试”时，会显式改用这里选中的 Key。</small>
        </> : <EmptyState title="还没有已保存的 Key" detail="请先在本机主程序的“模型设置”中添加连接。" />}
      </aside>
    </section>

    <section className="admin-panel admin-conversations" aria-labelledby="conversation-title">
      <div className="admin-panel-heading"><div><p className="admin-eyebrow">中转站</p><h2 id="conversation-title">真实输入 / 输出与重试链路</h2></div><span>{conversations.length} 条调用</span></div>
      {!selectedTask ? <EmptyState title="先选择一个任务" detail="这里按真实调用顺序显示程序发送内容、中转站返回和失败原因。" /> : !conversations.length ? <EmptyState title="还没有中转站调用" detail="进入画面分析或智能编排后，调用会自动出现在这里。" /> : <div className="admin-conversation-layout">
        <nav className="admin-conversation-list" aria-label="中转站调用列表">{conversations.map((item) => <button type="button" className={item.id === selectedConversationId ? 'selected' : ''} key={item.id} onClick={() => setSelectedConversationId(item.id)}>
          <span><StatusBadge status={item.status} /><time>{formatTime(item.completedAt)}</time></span><strong>{sourceLabel(item.source)}</strong><small>{item.model} · {formatLatency(item.latencyMs)}{item.attempts > 1 ? ` · 自动重试 ${item.attempts - 1} 次` : ''}</small><p>{item.requestPreview || '无文本输入摘要'}</p>
        </button>)}</nav>
        <article className="admin-conversation-detail" aria-live="polite">
          {conversationLoading && !conversation ? <EmptyState title="正在读取完整往返" detail="请稍候。" /> : null}
          {!conversationLoading && !conversation ? <EmptyState title="选择一条调用" detail="查看程序输入、中转站返回和原始错误。" /> : null}
          {conversation ? <>
            <header><div><StatusBadge status={conversation.status} /><h3>{sourceLabel(conversation.source)}</h3><p>{conversation.model} · {formatLatency(conversation.latencyMs)} · 共 {conversation.attempts} 次请求</p></div><code>{conversation.endpoint}</code></header>
            <dl className="admin-conversation-metrics"><div><dt>开始</dt><dd>{formatTime(conversation.startedAt)}</dd></div><div><dt>首字节</dt><dd>{conversation.timeToFirstByteMs === undefined ? '—' : formatLatency(conversation.timeToFirstByteMs)}</dd></div><div><dt>首事件</dt><dd>{conversation.timeToFirstEventMs === undefined ? '—' : formatLatency(conversation.timeToFirstEventMs)}</dd></div><div><dt>超时阶段</dt><dd>{conversation.timeoutPhase ?? '—'}</dd></div></dl>
            <section className="admin-io-block request"><h4>程序 → 中转站（输入）</h4>{conversation.requestMessages.map((message, index) => <div key={`${message.role}:${index}`}><span>{message.label ?? message.role}</span><pre>{message.content}</pre></div>)}</section>
            {conversation.status === 'failed' ? <section className="admin-io-block failed"><h4>中转站调用失败</h4><div><span>{conversation.errorCode ?? 'unknown_error'}</span><pre>{conversation.errorMessage ?? '调用未完成。'}</pre></div></section> : <section className="admin-io-block response"><h4>中转站 → 程序（输出）</h4><div><span>{conversation.status === 'streaming' ? '正在接收' : '完整返回'}</span><pre>{conversation.responseText ?? '（尚未收到文本）'}</pre></div></section>}
          </> : null}
        </article>
      </div>}
    </section>
  </main>;
}
