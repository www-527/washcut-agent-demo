import {useCallback, useDeferredValue, useEffect, useMemo, useRef, useState} from 'react';
import type {
  ModelConversationMessageRole,
  ModelConversationRecord,
  ModelConversationStatus,
  ModelConversationSummary,
} from '../../shared/model-conversations';
import {getModelConversation, listModelConversations} from '../model-conversations-api';
import {BracketsIcon, ShieldIcon, SparkIcon} from './Icons';

type ModelConversationLogProps = {
  currentProjectId?: string;
  currentGenerationId?: string;
  onClose: () => void;
};

type ScopeFilter = 'all' | 'project' | 'generation';
type StatusFilter = 'all' | ModelConversationStatus;

const sourceLabels: Record<string, string> = {
  'auto-video.screenshot-analysis': '截图视觉分析',
  'auto-video.asset-understanding': '素材综合理解',
  'auto-video.edit-planning': '自动编排',
  'video-analysis.visual-analysis': '视频视觉分析',
  'legacy-video.asset-analysis': '旧链路素材理解',
  'legacy-video.creative-direction': '旧链路创意导演',
  'relay.connection-test': '模型连接测试',
  'relay.chat-test': '文本对话测试',
  'relay.protocol-test': '多模态协议测试',
};

const roleLabels: Record<ModelConversationMessageRole, string> = {
  program: '程序 → 模型',
  user: '用户 → 模型',
  model: '模型上下文',
  media: '视觉输入说明',
};

const sourceLabel = (source: string) => sourceLabels[source] ?? source;
const formatTime = (value: string) => new Date(value).toLocaleString('zh-CN', {hour12: false});
const formatLatency = (value: number) => value >= 1_000 ? `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2)} 秒` : `${value.toLocaleString('zh-CN')} ms`;

const includesQuery = (item: ModelConversationSummary, query: string) => {
  if (!query) return true;
  const haystack = [item.model, item.source, item.requestPreview, item.responsePreview, item.projectId, item.generationId, item.assetId].filter(Boolean).join('\n').toLocaleLowerCase();
  return haystack.includes(query.toLocaleLowerCase());
};

export function ModelConversationLog({currentProjectId, currentGenerationId, onClose}: ModelConversationLogProps) {
  const [scope, setScope] = useState<ScopeFilter>(() => currentGenerationId ? 'generation' : currentProjectId ? 'project' : 'all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [source, setSource] = useState('all');
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [conversations, setConversations] = useState<ModelConversationSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [selected, setSelected] = useState<ModelConversationRecord>();
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');
  const [copyState, setCopyState] = useState('');
  const requestVersion = useRef(0);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setError('');
    try {
      const next = await listModelConversations({
        projectId: scope === 'project' || scope === 'generation' ? currentProjectId : undefined,
        generationId: scope === 'generation' ? currentGenerationId : undefined,
        status: status === 'all' ? undefined : status,
        source: source === 'all' ? undefined : source,
        limit: 100,
      }, signal);
      if (!signal?.aborted) setConversations(next);
    } catch (caught) {
      if (!signal?.aborted) setError(caught instanceof Error ? caught.message : '读取模型对话记录失败。');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [currentGenerationId, currentProjectId, scope, source, status]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void refresh(controller.signal);
    return () => {
      controller.abort();
    };
  }, [refresh]);

  // A model request is persisted under one id and replaced in SQLite as each
  // SSE delta arrives. Poll only while the list contains an active stream so
  // completed logs keep the same quiet, on-demand behaviour as before.
  useEffect(() => {
    if (!conversations.some((conversation) => conversation.status === 'streaming')) return;
    const timer = window.setInterval(() => { void refresh(); }, 1_000);
    return () => window.clearInterval(timer);
  }, [conversations, refresh]);

  useEffect(() => {
    if (!selectedId || selected?.status !== 'streaming') return;
    const timer = window.setInterval(() => {
      void getModelConversation(selectedId).then((detail) => {
        if (requestVersion.current && selectedId) setSelected(detail);
      }).catch(() => undefined);
    }, 500);
    return () => window.clearInterval(timer);
  }, [selected, selectedId]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  const visibleConversations = useMemo(
    () => conversations.filter((conversation) => includesQuery(conversation, deferredQuery.trim())),
    [conversations, deferredQuery],
  );

  const sourceOptions = useMemo(() => {
    const values = new Set(conversations.map((conversation) => conversation.source));
    if (source !== 'all') values.add(source);
    return Array.from(values).sort((left, right) => sourceLabel(left).localeCompare(sourceLabel(right), 'zh-CN'));
  }, [conversations, source]);

  const selectConversation = async (conversationId: string) => {
    const version = requestVersion.current + 1;
    requestVersion.current = version;
    setSelectedId(conversationId);
    setSelected(undefined);
    setDetailLoading(true);
    setCopyState('');
    try {
      const detail = await getModelConversation(conversationId);
      if (requestVersion.current === version) setSelected(detail);
    } catch (caught) {
      if (requestVersion.current === version) setError(caught instanceof Error ? caught.message : '读取完整对话失败。');
    } finally {
      if (requestVersion.current === version) setDetailLoading(false);
    }
  };

  const copyConversation = async () => {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(selected, null, 2));
      setCopyState('已复制 JSON');
    } catch {
      setCopyState('复制失败，请在详情中手动选择文本。');
    }
  };

  return (
    <div className="model-log-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="model-log-dialog" role="dialog" aria-modal="true" aria-labelledby="model-log-title">
        <header className="model-log-header">
          <div>
            <span className="model-log-icon"><BracketsIcon /></span>
            <span><h2 id="model-log-title">模型对话记录</h2><p>保存在本机 SQLite：程序请求、模型回复、失败原因和调用上下文都会留档。</p></span>
          </div>
          <button type="button" className="key-dialog-close" onClick={onClose} aria-label="关闭模型对话记录">×</button>
        </header>

        <div className="model-log-security"><ShieldIcon /><span>日志由模型连接统一记录，不保存 API Key，也不会写入图片或视频的 base64 内容；视觉输入只记录数量与类型说明。</span></div>

        <div className="model-log-toolbar">
          <label>范围<select value={scope} onChange={(event) => setScope(event.target.value as ScopeFilter)} disabled={!currentProjectId}><option value="generation" disabled={!currentGenerationId}>当前版本</option><option value="project">当前项目</option><option value="all">全部项目</option></select></label>
          <label>状态<select value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)}><option value="all">全部状态</option><option value="streaming">流式接收中</option><option value="completed">已回复</option><option value="failed">调用失败</option></select></label>
          <label>类型<select value={source} onChange={(event) => setSource(event.target.value)}><option value="all">全部类型</option>{sourceOptions.map((item) => <option value={item} key={item}>{sourceLabel(item)}</option>)}</select></label>
          <label className="model-log-search"><span className="sr-only">搜索对话</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型、内容或项目" /></label>
          <button type="button" className="model-log-refresh" onClick={() => void refresh()} disabled={loading}>{loading ? '正在读取…' : '刷新'}</button>
        </div>

        {error ? <div className="model-log-error" role="alert">{error}</div> : null}

        <div className="model-log-layout">
          <aside className="model-log-list" aria-label="模型对话列表">
            {loading && !conversations.length ? <div className="model-log-list-state">正在读取本机记录…</div> : null}
            {!loading && !visibleConversations.length ? <div className="model-log-list-state"><SparkIcon /><strong>还没有可显示的模型对话</strong><span>完成一次真实模型调用后，程序和模型之间的往返会自动出现在这里。</span></div> : null}
            {visibleConversations.map((conversation) => (
              <button
                className={`model-log-row${selectedId === conversation.id ? ' selected' : ''}`}
                type="button"
                key={conversation.id}
                onClick={() => void selectConversation(conversation.id)}
              >
                <span className={`model-log-status ${conversation.status}`}><i />{conversation.status === 'streaming' ? '流式接收中' : conversation.status === 'completed' ? '已回复' : '失败'}</span>
                <strong>{sourceLabel(conversation.source)}</strong>
                <small>{conversation.model} · {formatTime(conversation.startedAt)}</small>
                <p>{conversation.requestPreview || '（没有可展示的文本输入）'}</p>
                <em>{formatLatency(conversation.latencyMs)}{conversation.attempts > 1 ? ` · 重试 ${conversation.attempts - 1} 次` : ''}</em>
              </button>
            ))}
          </aside>

          <section className="model-log-detail" aria-live="polite">
            {detailLoading ? <div className="model-log-detail-state">正在读取完整对话…</div> : null}
            {!detailLoading && !selected ? <div className="model-log-detail-state"><BracketsIcon /><strong>选择一条记录查看完整往返</strong><span>此处会按真实顺序展示程序发送内容与模型原样回复。</span></div> : null}
            {selected ? <>
              <div className="model-log-detail-header">
                <div><span className={`model-log-status ${selected.status}`}><i />{selected.status === 'streaming' ? '流式接收中' : selected.status === 'completed' ? '模型已回复' : '调用失败'}</span><h3>{sourceLabel(selected.source)}</h3><p>{selected.model} · {formatTime(selected.startedAt)} · {formatLatency(selected.latencyMs)}{selected.attempts > 1 ? ` · 共 ${selected.attempts} 次请求` : ''}</p></div>
                <button type="button" className="model-log-copy" onClick={() => void copyConversation()}>复制 JSON</button>
              </div>
              <dl className="model-log-meta">
                <div><dt>项目</dt><dd>{selected.projectId ?? '未绑定项目'}</dd></div>
                {selected.generationId ? <div><dt>生成版本</dt><dd>{selected.generationId}</dd></div> : null}
                <div><dt>模型端点</dt><dd>{selected.endpoint}</dd></div>
                {selected.assetId ? <div><dt>素材</dt><dd>{selected.assetId}</dd></div> : null}
                {selected.taskId || selected.jobId ? <div><dt>任务</dt><dd>{selected.taskId ?? selected.jobId}</dd></div> : null}
                {selected.timeToFirstByteMs !== undefined ? <div><dt>TTFB</dt><dd>{formatLatency(selected.timeToFirstByteMs)}</dd></div> : null}
                {selected.timeToFirstEventMs !== undefined ? <div><dt>First event</dt><dd>{formatLatency(selected.timeToFirstEventMs)}</dd></div> : null}
                {selected.timeoutPhase ? <div><dt>Timeout phase</dt><dd>{selected.timeoutPhase}</dd></div> : null}
              </dl>
              {copyState ? <div className="model-log-copy-state">{copyState}</div> : null}
              <div className="model-log-messages">
                {selected.requestMessages.map((message, index) => (
                  <article className={`model-log-message ${message.role}`} key={`${message.role}:${index}`}>
                    <span>{message.label ?? roleLabels[message.role]}</span>
                    <pre>{message.content}</pre>
                  </article>
                ))}
                {selected.status === 'completed' || selected.status === 'streaming' ? <article className="model-log-message response"><span>{selected.status === 'streaming' ? '模型 → 程序（流式）' : '模型 → 程序'}</span><pre>{selected.responseText ?? (selected.status === 'streaming' ? '等待模型首个文本片段…' : '（模型没有返回文本）')}</pre></article> : <article className="model-log-message failed"><span>调用错误 · {selected.errorCode ?? 'unknown_error'}</span><pre>{selected.errorMessage ?? '模型调用未完成。'}</pre></article>}
              </div>
            </> : null}
          </section>
        </div>
      </section>
    </div>
  );
}
