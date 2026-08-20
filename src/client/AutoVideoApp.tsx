import {lazy, Suspense, useCallback, useEffect, useRef, useState} from 'react';
import {AUTO_VIDEO_VISUAL_CONCURRENCY_OPTIONS, type AutoVideoGeneration, type AutoVideoProjectStatus, type ProcessingStep, type TranscriptionProviderId} from '../shared/auto-video-contracts';
import {
  activateTranscriptionProvider,
  cancelAutoVideoGeneration,
  createAutoVideoGeneration,
  createAutoVideoProject,
  deleteAutoVideoAsset,
  deleteAutoVideoGeneration,
  duplicateAutoVideoProject,
  getAutoVideoGeneration,
  getAutoVideoProject,
  getModelConnectionStatus,
  getTranscriptionProviders,
  listAutoVideoGenerations,
  listAutoVideoProjects,
  retryAutoVideoGeneration,
  resumeAutoVideoGeneration,
  uploadAutoVideoAssets,
  type AutoVideoGenerationView,
  type AutoVideoProjectDetail,
  type AutoVideoGenerationSummary,
  type AutoVideoProjectSummary,
  type ModelConnectionStatus,
  type TranscriptionProviderStatusResponse,
} from './auto-video-api';
import {createClientContext} from './api';
import {BracketsIcon, ShieldIcon} from './components/Icons';
import {OutputPreview} from './components/OutputPreview';

const ModelConversationLog = lazy(async () => {
  const module = await import('./components/ModelConversationLog');
  return {default: module.ModelConversationLog};
});

const KeyManager = lazy(async () => {
  const module = await import('./components/KeyManager');
  return {default: module.KeyManager};
});

type GenerationMode = 'ai' | 'local';

const projectStatusLabel: Record<AutoVideoProjectStatus, string> = {
  draft: '草稿',
  ready: '可生成版本',
  archived: '已归档',
};

const generationStatusLabel: Record<AutoVideoGeneration['status'], string> = {
  queued: '等待处理',
  analyzing: '正在分析',
  retry_waiting: '等待自动重试',
  planning: '正在编排',
  rendering: '正在渲染',
  completed: '已完成',
  failed: '处理失败',
  cancelled: '已取消',
  needs_attention: '需要处理',
};

const aiStepLabels: Record<string, string> = {
  probe: '媒体检测',
  extract_audio: '临时音频',
  transcription: '语音转写',
  screenshots: '截图采样',
  visual_analysis: '三段关键画面联合理解',
  asset_understanding: '整理素材结论',
  planning: '智能编排',
  timeline: '确定性时间线',
  captions: '生成字幕',
  render: '渲染成片',
};

const localStepLabels: Record<string, string> = {
  local_prepare: '检查素材',
  local_timeline: '按上传顺序生成时间线',
  captions: '生成空字幕轨',
  render: '渲染完整合成',
};

const activeGenerationStatuses = new Set<AutoVideoGeneration['status']>(['queued', 'analyzing', 'retry_waiting', 'planning', 'rendering']);
const transcriptionProviderIds: TranscriptionProviderId[] = ['speaches-whisper', 'qwen3-asr'];

const formatDate = (value: string) => new Date(value).toLocaleString('zh-CN', {hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'});
const formatDuration = (value?: number) => value ? `${Math.floor(value / 60_000)} 分 ${Math.round(value % 60_000 / 1_000)} 秒` : '—';
const formatBytes = (value: number) => value >= 1_048_576 ? `${(value / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(value / 1024))} KB`;
const idempotencyKey = () => typeof crypto !== 'undefined' && 'randomUUID' in crypto ? `generation:${crypto.randomUUID()}` : `generation:${Date.now()}:${Math.random().toString(36).slice(2)}`;

const generationSummary = (generation: AutoVideoGenerationView): AutoVideoGenerationSummary => ({
  generationId: generation.generationId,
  projectId: generation.projectId,
  versionNumber: generation.versionNumber,
  status: generation.status,
  progress: generation.progress,
  aiMode: generation.aiMode,
  connectionId: generation.connectionId,
  model: generation.model,
  createdAt: generation.createdAt,
  startedAt: generation.startedAt,
  completedAt: generation.completedAt,
  updatedAt: generation.updatedAt,
});

const projectSummary = (project: AutoVideoProjectDetail): AutoVideoProjectSummary => ({
  id: project.id,
  name: project.name,
  status: project.status,
  generationCount: project.generationCount,
  latestGeneration: project.latestGeneration ? generationSummary(project.latestGeneration) : undefined,
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
});

const sortGenerations = (items: AutoVideoGenerationSummary[]) => [...items].sort((left, right) => right.versionNumber - left.versionNumber);
const upsertProject = (projects: AutoVideoProjectSummary[], next: AutoVideoProjectSummary) => [next, ...projects.filter((project) => project.id !== next.id)];
const upsertGeneration = (items: AutoVideoGenerationSummary[], next: AutoVideoGenerationSummary) => sortGenerations([next, ...items.filter((item) => item.generationId !== next.generationId)]);

function ProjectNavigation({projects, activeProjectId, onSelect, onCreate}: {
  projects: AutoVideoProjectSummary[];
  activeProjectId?: string;
  onSelect: (projectId: string) => void;
  onCreate: () => void;
}) {
  return (
    <aside className="auto-project-nav" aria-label="我的项目">
      <div className="auto-nav-heading"><span>我的项目</span><button type="button" onClick={onCreate} aria-label="新建视频">+</button></div>
      <div className="auto-project-list">
        {projects.map((item) => (
          <button type="button" key={item.id} className={item.id === activeProjectId ? 'selected' : ''} onClick={() => onSelect(item.id)}>
            <span className={`auto-nav-status ${item.status}`} aria-hidden="true" />
            <span><strong>{item.name}</strong><small>{item.generationCount} 个版本 · {formatDate(item.updatedAt)}</small></span>
          </button>
        ))}
        {!projects.length ? <div className="auto-nav-empty">还没有视频项目。<br />从右上角新建一条开始。</div> : null}
      </div>
    </aside>
  );
}

function ModelStatusCard({status, onOpenSettings}: {status?: ModelConnectionStatus; onOpenSettings: () => void}) {
  if (!status) return <section className="auto-model-status loading">正在读取模型状态…</section>;
  const connected = status.mode === 'connected';
  const blocked = status.mode === 'blocked';
  return (
    <section className={`auto-model-status ${status.mode}`}>
      <span className="auto-model-status-icon"><ShieldIcon /></span>
      <div>
        <strong>{connected ? '已连接模型' : blocked ? '模型连接异常' : '未连接模型'}</strong>
        <p>{status.message}</p>
        {status.activeConnection ? <small>{status.activeConnection.name} · {status.activeConnection.model}</small> : null}
      </div>
      {!connected ? <button type="button" onClick={onOpenSettings}>前往模型设置</button> : null}
    </section>
  );
}

function TranscriptionProviderSelector({providers, selectedId, activatingId, standalone = false, onChange}: {
  providers?: TranscriptionProviderStatusResponse;
  selectedId: TranscriptionProviderId;
  activatingId?: TranscriptionProviderId;
  standalone?: boolean;
  onChange: (providerId: TranscriptionProviderId) => void;
}) {
  const qwen = providers?.providers.find((provider) => provider.id === 'qwen3-asr');
  const busy = providers?.switching || Boolean(activatingId);
  return (
    <fieldset className={`auto-transcription-selector${standalone ? ' standalone' : ''}`} disabled={busy}>
      <legend>转文字模型</legend>
      <div className="auto-transcription-options" aria-label="转文字模型">
        {transcriptionProviderIds.map((id) => {
          const provider = providers?.providers.find((item) => item.id === id);
          const active = providers?.activeProviderId === id;
          const unavailable = provider ? !provider.configured : true;
          return <button key={id} type="button" aria-pressed={active} className={`auto-transcription-option${active ? ' selected' : selectedId === id ? ' pending' : ''}`} disabled={busy || unavailable || active} onClick={() => onChange(id)}>
            <span><strong>{provider?.label ?? (id === 'qwen3-asr' ? 'Qwen3-ASR-1.7B（中文增强）' : 'Whisper large-v3')}</strong><small>{provider?.model ?? '正在读取服务状态…'}</small></span>
            <b>{activatingId === id ? '切换中…' : active ? '已启用' : unavailable ? '未配置' : '启用'}</b>
          </button>;
        })}
      </div>
      <p>同一时间只启用一个模型。切换时先停止另一个模型并确认显存已释放，再加载所选模型。</p>
      {qwen && qwen.configured && !qwen.reachable ? <div className="auto-transcription-unavailable" role="status"><strong>Qwen 网关未运行</strong><span><code>{qwen.error?.code ?? 'QWEN_NOT_READY'}</code>：{qwen.error?.message ?? qwen.message}</span><small>先启动轻量网关进程；健康检查本身不会加载模型。</small></div> : null}
    </fieldset>
  );
}

function GenerationSteps({generation}: {generation: AutoVideoGenerationView}) {
  const labels = generation.aiMode.kind === 'local' ? localStepLabels : aiStepLabels;
  return (
    <ol className="auto-steps generation-steps">
      {generation.steps.map((step: ProcessingStep) => (
        <li className={`auto-step ${step.status}`} key={step.name}>
          <span>{step.status === 'completed' ? '✓' : step.status === 'failed' ? '!' : step.status === 'running' ? '●' : '○'}</span>
          <div><strong>{labels[step.name] ?? step.name}</strong><small>{step.status === 'failed' ? step.errorMessage : step.status === 'running' ? `${step.progress}% · 第 ${step.attempts} 次` : step.status === 'completed' ? step.note ?? '已完成' : '等待中'}</small>{step.status === 'failed' && generation.error?.details ? <small className="auto-step-detail">原因：{generation.error.details}</small> : null}</div>
        </li>
      ))}
    </ol>
  );
}

function VersionDetail({project, generation, onNewVideo, onDuplicateProject, duplicating, onRecompose, onRetry, onCancel, onResume, cancelling}: {
  project: AutoVideoProjectDetail;
  generation?: AutoVideoGenerationView;
  onNewVideo: () => void;
  onDuplicateProject: () => void;
  duplicating: boolean;
  onRecompose: (generation?: AutoVideoGenerationView) => void;
  onRetry: (generation: AutoVideoGenerationView) => void;
  onCancel: (generation: AutoVideoGenerationView) => void;
  onResume: (generation: AutoVideoGenerationView) => void;
  cancelling: boolean;
}) {
  if (!generation) return <section className="auto-empty-workspace"><strong>还没有生成版本</strong><span>上传素材后，选择智能编排或按上传顺序合成。</span><button className="auto-primary" type="button" onClick={() => onRecompose()}>创建第一个版本</button></section>;
  const local = generation.aiMode.kind === 'local';
  const processing = activeGenerationStatuses.has(generation.status);
  const hasRunningStep = generation.steps.some((step) => step.status === 'running');
  const canInterrupt = processing || hasRunningStep;
  const canResume = generation.status === 'cancelled' || generation.status === 'needs_attention';
  const clips = generation.editPlan?.clips ?? [];
  const checkpoints = generation.assetCheckpoints ?? [];
  const visualConcurrency = generation.analysisProfile?.name === 'balanced-v1'
    ? generation.analysisProfile.visualConcurrency ?? 1
    : 1;
  // The generation snapshot is the complete, immutable set of source clips.
  // Checkpoints are created lazily while assets are processed, so using their
  // count would make the progress denominator grow during the run.
  const totalAssetCount = generation.assetIds.length;
  const completedCheckpoints = checkpoints.filter((checkpoint) => checkpoint.visualAnalysis.status === 'completed').length;
  const waitingCheckpoint = checkpoints.find((checkpoint) => checkpoint.visualAnalysis.status === 'retry_waiting');
  return (
    <>
      <section className="auto-version-heading">
        <div><span className="auto-eyebrow">当前版本</span><h2>V{generation.versionNumber}</h2><p>{local ? generation.localSummary ?? '未调用模型；按上传顺序完整合成。' : `${generation.model ?? '已连接模型'} · ${generation.analysisProfile?.name === 'balanced-v1' ? '平衡理解模式' : '旧版分析策略'} · 画面理解 ${visualConcurrency} 路并发 · 本次要求已锁定为快照`}</p>{generation.transcriptionSnapshot ? <small className="auto-transcription-snapshot">转写：{generation.transcriptionSnapshot.providerId === 'qwen3-asr' ? 'Qwen3-ASR-1.7B' : 'Whisper large-v3'} · {generation.transcriptionSnapshot.model}{generation.transcriptionSnapshot.alignmentModel ? ` · 对齐：${generation.transcriptionSnapshot.alignmentModel}` : ''}</small> : null}</div>
        <div className={`auto-status auto-status-${generation.status}`}><i />{generationStatusLabel[generation.status]}<small>{generation.progress}%</small></div>
      </section>

      <section className="auto-process-card">
        <div className="auto-section-heading"><div><span className="auto-eyebrow">处理任务</span><h2>{local ? '本地顺序合成' : '素材理解与版本编排'}</h2><p>{local ? '未调用模型，也不会声称理解素材内容。系统将按上传顺序让每段有效素材完整播放一次。' : generation.analysisProfile?.name === 'balanced-v1' ? '正在进行三段关键画面联合理解；可见的人、物和动作是内容判断的最高依据，语音转写只作辅助。程序负责校验顺序与计算时间线。' : '模型会参考转写、截图结构化分析和媒体元数据；画面行为优先于口播和字幕，程序负责校验顺序与计算时间线。'}</p></div></div>
        <div className="auto-process-actions">
          {generation.status === 'failed' ? <button type="button" className="auto-secondary" onClick={() => onRetry(generation)}>从失败步骤重试</button> : null}
          {canInterrupt ? <button type="button" className="auto-secondary" disabled={cancelling} onClick={() => onCancel(generation)}>{cancelling ? '正在中断…' : '中断任务'}</button> : null}
          {canResume ? <button type="button" className="auto-primary" onClick={() => onResume(generation)}>从已保存断点继续</button> : null}
          {!canInterrupt && !canResume ? <button type="button" className="auto-primary" onClick={() => onRecompose(generation)}>基于此重新编排</button> : null}
        </div>
        {!local && totalAssetCount ? <div className="auto-checkpoint-progress">
          <strong>画面理解：已完成 {completedCheckpoints} / {totalAssetCount} 个素材</strong>
          {generation.status === 'cancelled' ? <small>任务已中断。已保留 {completedCheckpoints} / {totalAssetCount} 个素材的理解结果。</small> : null}
          {waitingCheckpoint ? <small>正在等待重试：{project.assets.find((asset) => asset.id === waitingCheckpoint.assetId)?.originalName ?? waitingCheckpoint.assetId} · 第 {waitingCheckpoint.visualAnalysis.attempts} 次尝试失败：{waitingCheckpoint.visualAnalysis.lastError?.message ?? '上游错误'} · 将在 {waitingCheckpoint.visualAnalysis.nextRetryAt ? formatDate(waitingCheckpoint.visualAnalysis.nextRetryAt) : '稍后'} 自动重试</small> : null}
          {checkpoints.length >= 2 ? <ul>{checkpoints.map((checkpoint) => <li key={checkpoint.assetId}>{project.assets.find((asset) => asset.id === checkpoint.assetId)?.originalName ?? checkpoint.assetId}：{checkpoint.visualAnalysis.status === 'completed' ? '已完成' : checkpoint.visualAnalysis.status === 'retry_waiting' ? '等待重试' : checkpoint.visualAnalysis.status === 'running' ? '正在理解' : '等待中'}</li>)}</ul> : null}
        </div> : null}
        <GenerationSteps generation={generation} />
      </section>

      {clips.length ? <section className="auto-plan-card"><div className="auto-section-heading"><div><span className="auto-eyebrow">{local ? '顺序合成结果' : '编排结果'}</span><h2>{local ? '按上传顺序完整拼接' : '系统将按此顺序完整拼接'}</h2><p>{generation.editPlan?.overallReason}</p></div><span>只读快照</span></div><ol className="auto-plan-list">{clips.map((clip) => { const asset = project.assets.find((candidate) => candidate.id === clip.assetId); return <li key={clip.assetId}><b>{clip.order}</b><div><strong>{asset?.originalName ?? clip.assetId}</strong><span>{clip.reason}</span></div></li>; })}</ol></section> : null}

      {!local && generation.assetAnalyses.length ? <details className="auto-analysis"><summary>查看本版本的素材理解结果（{generation.assetAnalyses.length} 个）</summary><div>{generation.assetAnalyses.map((analysis) => <article key={analysis.assetId}><strong>{project.assets.find((asset) => asset.id === analysis.assetId)?.originalName ?? analysis.assetId}</strong><p>{analysis.combinedSummary}</p></article>)}</div></details> : null}

      {generation.output?.status === 'ready' && generation.output.videoUrl ? <>
        <OutputPreview videoUrl={generation.output.videoUrl} subtitleUrl={generation.output.subtitleUrl} durationMs={generation.output.durationMs} />
        <section className="auto-complete-actions"><div><strong>这个版本已保留</strong><span>新版本永远不会覆盖 V{generation.versionNumber} 的 MP4、字幕、时间线或模型对话。</span></div><div><button className="auto-secondary" type="button" onClick={onNewVideo}>新建一条视频</button><button className="auto-secondary" type="button" disabled={duplicating} onClick={onDuplicateProject}>{duplicating ? '正在复制…' : '复制为新项目'}</button><button className="auto-primary" type="button" onClick={() => onRecompose(generation)}>基于此重新编排</button><a href={generation.output.videoUrl} download>下载 MP4</a></div></section>
      </> : null}
    </>
  );
}

export default function AutoVideoApp() {
  const fileInput = useRef<HTMLInputElement>(null);
  const [projectName, setProjectName] = useState('我的视频项目');
  const [projectInstruction, setProjectInstruction] = useState('请依据内容自然衔接全部素材，优先保持叙事时间顺序。');
  const [project, setProject] = useState<AutoVideoProjectDetail>();
  const [projects, setProjects] = useState<AutoVideoProjectSummary[]>([]);
  const [generations, setGenerations] = useState<AutoVideoGenerationSummary[]>([]);
  const [selectedGenerationId, setSelectedGenerationId] = useState<string>();
  const [selectedGeneration, setSelectedGeneration] = useState<AutoVideoGenerationView>();
  const [connectionStatus, setConnectionStatus] = useState<ModelConnectionStatus>();
  const [transcriptionProviders, setTranscriptionProviders] = useState<TranscriptionProviderStatusResponse>();
  const [transcriptionProviderId, setTranscriptionProviderId] = useState<TranscriptionProviderId>('speaches-whisper');
  const [activatingTranscriptionProviderId, setActivatingTranscriptionProviderId] = useState<TranscriptionProviderId>();
  const [creating, setCreating] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deletingAssetId, setDeletingAssetId] = useState<string>();
  const [starting, setStarting] = useState(false);
  const [cancellingGenerationId, setCancellingGenerationId] = useState<string>();
  const [deletingGenerationId, setDeletingGenerationId] = useState<string>();
  const [composerOpen, setComposerOpen] = useState(false);
  const [generationInstruction, setGenerationInstruction] = useState('');
  const [generationMode, setGenerationMode] = useState<GenerationMode>('ai');
  const [visualConcurrency, setVisualConcurrency] = useState<number>(AUTO_VIDEO_VISUAL_CONCURRENCY_OPTIONS[0]);
  const [error, setError] = useState('');
  const [modelLogOpen, setModelLogOpen] = useState(false);
  const [keyManagerOpen, setKeyManagerOpen] = useState(false);
  const [protocolTesterContext] = useState(() => createClientContext());
  const lastProgressLogKey = useRef<string | undefined>(undefined);

  const projectHasActiveGeneration = generations.some((generation) => activeGenerationStatuses.has(generation.status));
  const selectedGenerationNeedsPolling = Boolean(selectedGeneration && (activeGenerationStatuses.has(selectedGeneration.status) || selectedGeneration.steps.some((step) => step.status === 'running')));
  const assetControlsDisabled = !project || project.status === 'archived' || projectHasActiveGeneration || uploading || Boolean(deletingAssetId);
  const progressLogKey = selectedGeneration ? [
    selectedGeneration.generationId,
    selectedGeneration.status,
    selectedGeneration.progress,
    selectedGeneration.steps.map((step) => `${step.name}:${step.status}:${step.progress}:${step.attempts}`).join('|'),
    selectedGeneration.retryState?.nextRetryAt ?? '',
    (selectedGeneration.assetCheckpoints ?? []).map((checkpoint) => `${checkpoint.assetId}:${checkpoint.visualAnalysis.status}:${checkpoint.visualAnalysis.attempts}`).join('|'),
  ].join('~') : '';

  const refreshConnection = useCallback(async () => {
    try { setConnectionStatus(await getModelConnectionStatus()); }
    catch (caught) { setError(caught instanceof Error ? caught.message : '无法读取模型连接状态。'); }
  }, []);

  const activateProvider = async (providerId: TranscriptionProviderId) => {
    if (activatingTranscriptionProviderId || transcriptionProviders?.switching || transcriptionProviders?.activeProviderId === providerId) return;
    setActivatingTranscriptionProviderId(providerId); setError('');
    try {
      const providers = await activateTranscriptionProvider(providerId);
      setTranscriptionProviders(providers);
      setTranscriptionProviderId(providers.activeProviderId ?? providerId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '无法切换转文字模型。');
      try { setTranscriptionProviders(await getTranscriptionProviders()); } catch { /* keep the original switch error */ }
    } finally { setActivatingTranscriptionProviderId(undefined); }
  };

  const refreshProject = useCallback(async (projectId: string, preferGenerationId?: string) => {
    const [detail, versionList] = await Promise.all([getAutoVideoProject(projectId), listAutoVideoGenerations(projectId)]);
    setProject(detail);
    setProjects((current) => upsertProject(current, projectSummary(detail)));
    setGenerations(sortGenerations(versionList));
    const generationId = preferGenerationId ?? versionList[0]?.generationId;
    setSelectedGenerationId(generationId);
    if (generationId) {
      const generation = await getAutoVideoGeneration(projectId, generationId);
      setSelectedGeneration(generation);
      setGenerations((current) => upsertGeneration(current, generationSummary(generation)));
    } else {
      setSelectedGeneration(undefined);
    }
    return {detail, versionList};
  }, []);

  useEffect(() => {
    let disposed = false;
    void Promise.all([listAutoVideoProjects(), getModelConnectionStatus(), getTranscriptionProviders()]).then(([items, status, providers]) => {
      if (disposed) return;
      setProjects(items);
      setConnectionStatus(status);
      setTranscriptionProviders(providers);
      if (providers.activeProviderId) setTranscriptionProviderId(providers.activeProviderId);
      const savedId = window.localStorage.getItem('auto-video.active-project');
      const initial = items.find((item) => item.id === savedId) ?? items[0];
      if (initial) void refreshProject(initial.id).catch((caught: unknown) => { if (!disposed) setError(caught instanceof Error ? caught.message : '无法打开项目。'); });
    }).catch((caught: unknown) => { if (!disposed) setError(caught instanceof Error ? caught.message : '无法读取工作台。'); });
    return () => { disposed = true; };
  }, [refreshProject]);

  useEffect(() => {
    if (project) window.localStorage.setItem('auto-video.active-project', project.id);
  }, [project?.id]);

  useEffect(() => {
    if (!selectedGeneration || lastProgressLogKey.current === progressLogKey) return;
    lastProgressLogKey.current = progressLogKey;
    const currentStep = selectedGeneration.steps.find((step) => step.status === 'running')
      ?? selectedGeneration.steps.find((step) => step.status === 'failed');
    const checkpoints = selectedGeneration.assetCheckpoints ?? [];
    console.info('[auto-video] 当前任务进度', JSON.stringify({
      generationId: selectedGeneration.generationId,
      status: selectedGeneration.status,
      progress: selectedGeneration.progress,
      currentStep: currentStep ? {
        name: currentStep.name,
        status: currentStep.status,
        progress: currentStep.progress,
        attempts: currentStep.attempts,
      } : undefined,
      retryAt: selectedGeneration.retryState?.nextRetryAt,
      completedAssets: checkpoints.filter((checkpoint) => checkpoint.visualAnalysis.status === 'completed').length,
      totalAssets: checkpoints.length,
      checkpoints: checkpoints.map((checkpoint) => ({
        assetId: checkpoint.assetId,
        status: checkpoint.visualAnalysis.status,
        attempts: checkpoint.visualAnalysis.attempts,
        nextRetryAt: checkpoint.visualAnalysis.nextRetryAt,
      })),
    }));
  }, [progressLogKey, selectedGeneration]);

  useEffect(() => {
    if (!project || !selectedGeneration || !selectedGenerationNeedsPolling) return;
    let disposed = false;
    let timer: number | undefined;
    const poll = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const next = await getAutoVideoGeneration(project.id, selectedGeneration.generationId);
        if (disposed) return;
        setSelectedGeneration(next);
        setGenerations((current) => upsertGeneration(current, generationSummary(next)));
        const detail = await getAutoVideoProject(project.id);
        if (!disposed) {
          setProject(detail);
          setProjects((current) => upsertProject(current, projectSummary(detail)));
          setError('');
        }
      } catch (caught) {
        if (!disposed) setError(caught instanceof Error ? caught.message : '生成版本状态查询失败。');
      }
    };
    const start = () => {
      window.clearInterval(timer);
      if (document.visibilityState === 'visible') { void poll(); timer = window.setInterval(() => void poll(), 1_200); }
    };
    const onVisibility = () => start();
    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { disposed = true; window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisibility); };
  }, [project?.id, selectedGeneration?.generationId, selectedGenerationNeedsPolling]);

  const newVideo = () => {
    setProject(undefined); setGenerations([]); setSelectedGenerationId(undefined); setSelectedGeneration(undefined); setComposerOpen(false); setError('');
    window.scrollTo({top: 0, behavior: 'smooth'});
  };

  const createProject = async () => {
    if (creating) return;
    setCreating(true); setError('');
    try {
      const next = await createAutoVideoProject({name: projectName, userInstruction: projectInstruction});
      setProject(next); setProjects((current) => upsertProject(current, projectSummary(next))); setGenerations([]); setSelectedGenerationId(undefined); setSelectedGeneration(undefined);
    } catch (caught) { setError(caught instanceof Error ? caught.message : '创建项目失败。'); }
    finally { setCreating(false); }
  };

  const selectProject = async (projectId: string) => {
    setError('');
    setSelectedGeneration(undefined);
    try { await refreshProject(projectId); }
    catch (caught) { setError(caught instanceof Error ? caught.message : '无法打开项目。'); }
  };

  const selectGeneration = async (generationId: string) => {
    if (!project) return;
    setSelectedGenerationId(generationId);
    setSelectedGeneration(undefined);
    setError('');
    try {
      const generation = await getAutoVideoGeneration(project.id, generationId);
      setSelectedGeneration(generation);
      setGenerations((current) => upsertGeneration(current, generationSummary(generation)));
    } catch (caught) { setError(caught instanceof Error ? caught.message : '无法读取生成版本。'); }
  };

  const duplicateProject = async () => {
    if (!project || duplicating) return;
    if (!window.confirm('复制会新建一个视频项目，并安全复用当前项目的不可变原片引用。确定继续吗？')) return;
    setDuplicating(true); setError('');
    try {
      const duplicate = await duplicateAutoVideoProject(project.id);
      setProject(duplicate);
      setProjects((current) => upsertProject(current, projectSummary(duplicate)));
      setGenerations([]);
      setSelectedGenerationId(undefined);
      setSelectedGeneration(undefined);
    } catch (caught) { setError(caught instanceof Error ? caught.message : '复制项目失败。'); }
    finally { setDuplicating(false); }
  };

  const uploadFiles = async (files: File[]) => {
    if (!project || !files.length || assetControlsDisabled) return;
    setUploading(true); setError('');
    try {
      const result = await uploadAutoVideoAssets(project.id, files);
      setProject(result.project); setProjects((current) => upsertProject(current, projectSummary(result.project)));
    } catch (caught) { setError(caught instanceof Error ? caught.message : '上传失败。'); }
    finally { setUploading(false); if (fileInput.current) fileInput.current.value = ''; }
  };

  const removeAsset = async (assetId: string, originalName: string) => {
    if (!project || assetControlsDisabled) return;
    if (!window.confirm(`确定从当前项目移除“${originalName}”吗？已经被版本引用的素材会受到保护。`)) return;
    setDeletingAssetId(assetId); setError('');
    try {
      const result = await deleteAutoVideoAsset(project.id, assetId);
      setProject(result.project); setProjects((current) => upsertProject(current, projectSummary(result.project)));
    } catch (caught) { setError(caught instanceof Error ? caught.message : '移除素材失败。'); }
    finally { setDeletingAssetId(undefined); }
  };

  const openComposer = (source?: AutoVideoGenerationView) => {
    if (!project) return;
    setGenerationInstruction(source?.instructionSnapshot ?? project.userInstruction ?? '');
    setGenerationMode(connectionStatus?.mode === 'connected' ? 'ai' : 'local');
    setVisualConcurrency(source?.analysisProfile?.name === 'balanced-v1' ? source.analysisProfile.visualConcurrency ?? AUTO_VIDEO_VISUAL_CONCURRENCY_OPTIONS[0] : AUTO_VIDEO_VISUAL_CONCURRENCY_OPTIONS[0]);
    setTranscriptionProviderId(source?.transcriptionSnapshot?.providerId ?? transcriptionProviders?.activeProviderId ?? 'speaches-whisper');
    setComposerOpen(true); setError('');
  };

  const startGeneration = async () => {
    if (!project || starting || !project.assets.length || projectHasActiveGeneration) return;
    if (generationMode === 'ai' && connectionStatus?.mode !== 'connected') { setKeyManagerOpen(true); return; }
    if (generationMode === 'ai' && transcriptionProviders?.activeProviderId !== transcriptionProviderId) {
      setError('请先启用要使用的转文字模型，再开始智能编排。');
      return;
    }
    if (generationMode === 'local' && !window.confirm('本地顺序合成不会调用模型，也不会理解画面、语音或叙事。系统将按上传顺序完整合成所有有效素材。是否继续？')) return;
    setStarting(true); setError('');
    try {
      const result = await createAutoVideoGeneration(project.id, {mode: generationMode, userInstruction: generationInstruction, ...(generationMode === 'ai' ? {visualConcurrency, transcriptionSelection: {providerId: transcriptionProviderId}} : {})}, idempotencyKey());
      setGenerations((current) => upsertGeneration(current, generationSummary(result.generation)));
      setSelectedGenerationId(result.generation.generationId);
      setSelectedGeneration(result.generation);
      setComposerOpen(false);
      await refreshProject(project.id, result.generation.generationId);
    } catch (caught) { setError(caught instanceof Error ? caught.message : '无法创建生成版本。'); }
    finally { setStarting(false); }
  };

  const retryGeneration = async (generation: AutoVideoGenerationView) => {
    if (!project) return;
    setError('');
    try {
      const result = await retryAutoVideoGeneration(project.id, generation.generationId);
      setGenerations((current) => upsertGeneration(current, generationSummary(result.generation)));
      setSelectedGenerationId(result.generation.generationId);
      setSelectedGeneration(result.generation);
    } catch (caught) { setError(caught instanceof Error ? caught.message : '重试任务创建失败。'); }
  };

  const cancelGeneration = async (generation: AutoVideoGenerationView) => {
    if (!project || !window.confirm('中断后将停止当前模型调用和后续自动重试。\n已完成的素材理解会保留，可随时从断点继续。确定中断吗？')) return;
    setCancellingGenerationId(generation.generationId);
    setError('');
    try {
      const result = await cancelAutoVideoGeneration(project.id, generation.generationId);
      if (result.generation) {
        setSelectedGeneration(result.generation);
        setGenerations((current) => upsertGeneration(current, generationSummary(result.generation!)));
      }
    }
    catch (caught) { setError(caught instanceof Error ? caught.message : '取消请求失败。'); }
    finally { setCancellingGenerationId(undefined); }
  };

  const removeGeneration = async (generation: AutoVideoGenerationSummary) => {
    if (!project || deletingGenerationId || !['completed', 'failed', 'cancelled', 'needs_attention'].includes(generation.status)) return;
    if (!window.confirm(`确定删除 V${generation.versionNumber} 吗？\n该版本的编排结果、字幕、导出成片和处理记录将无法恢复。`)) return;
    setDeletingGenerationId(generation.generationId);
    setError('');
    try {
      const result = await deleteAutoVideoGeneration(project.id, generation.generationId);
      const remaining = generations.filter((item) => item.generationId !== generation.generationId);
      setProject(result.project);
      setProjects((current) => upsertProject(current, projectSummary(result.project)));
      setGenerations(remaining);
      if (selectedGenerationId === generation.generationId) {
        const nextSelected = remaining[0];
        setSelectedGenerationId(nextSelected?.generationId);
        setSelectedGeneration(undefined);
        if (nextSelected) await selectGeneration(nextSelected.generationId);
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : '删除生成版本失败。'); }
    finally { setDeletingGenerationId(undefined); }
  };

  const resumeGeneration = async (generation: AutoVideoGenerationView) => {
    if (!project) return;
    setError('');
    try {
      const result = await resumeAutoVideoGeneration(project.id, generation.generationId);
      setSelectedGeneration(result.generation);
      setGenerations((current) => upsertGeneration(current, generationSummary(result.generation)));
    } catch (caught) { setError(caught instanceof Error ? caught.message : '无法从断点继续。'); }
  };

  return (
    <div className="auto-app">
      <header className="auto-topbar">
        <a href="#top" className="auto-brand"><span aria-hidden="true">✦</span>编排台</a>
        <div className="auto-topbar-note">多项目 · 多版本 · 原片不可变</div>
        <div className="auto-topbar-actions">
          <button type="button" className="auto-new-project" onClick={newVideo}>+ 新建视频</button>
          <button type="button" className="auto-model-log" onClick={() => setKeyManagerOpen(true)}><ShieldIcon />模型设置</button>
          <button type="button" className="auto-model-log" onClick={() => setModelLogOpen(true)}><BracketsIcon />模型对话</button>
        </div>
      </header>

      <main id="top" className="auto-main auto-workbench-shell">
        {error ? <div className="auto-error" role="alert">{error}</div> : null}
        <TranscriptionProviderSelector providers={transcriptionProviders} selectedId={transcriptionProviderId} activatingId={activatingTranscriptionProviderId} standalone onChange={(id) => void activateProvider(id)} />
        <div className="auto-workbench">
          <ProjectNavigation projects={projects} activeProjectId={project?.id} onSelect={(id) => void selectProject(id)} onCreate={newVideo} />
          <section className="auto-workspace">
            {!project ? <section className="auto-create-card"><div><span className="auto-eyebrow">新建视频项目</span><h2>从一组不可变原片开始</h2><p>项目保存素材集合和默认要求。每次生成都是独立版本，旧成片不会被覆盖。</p></div><form onSubmit={(event) => { event.preventDefault(); void createProject(); }}><label>项目名称<input value={projectName} maxLength={80} onChange={(event) => setProjectName(event.target.value)} required /></label><label>默认编排要求（可选）<textarea value={projectInstruction} maxLength={2_000} onChange={(event) => setProjectInstruction(event.target.value)} /></label><button type="submit" className="auto-primary" disabled={creating}>{creating ? '正在创建…' : '创建并上传素材'}</button></form></section> : <>
              <section className="auto-project-heading"><div><span className="auto-eyebrow">视频项目</span><h2>{project.name}</h2><p>{project.userInstruction || '尚未填写默认编排要求。'}</p></div><div className={`auto-status auto-project-status-${project.status}`}><i />{projectStatusLabel[project.status]}<small>{project.generationCount} 个版本</small></div></section>
              <ModelStatusCard status={connectionStatus} onOpenSettings={() => setKeyManagerOpen(true)} />
              <section className="auto-upload-card" aria-labelledby="auto-upload-title"><div className="auto-section-heading"><div><span className="auto-eyebrow">素材</span><h2 id="auto-upload-title">不可变视频素材</h2><p>MP4、WebM 或 MOV。上传后仅读取元数据并保存原始文件；所有版本都引用这一批受保护的素材。</p></div><span>{project.assets.length}/20 个素材</span></div><button type="button" className="auto-dropzone" disabled={assetControlsDisabled} onClick={() => fileInput.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void uploadFiles(Array.from(event.dataTransfer.files)); }}><b>{uploading ? '正在保存原片并检测媒体信息…' : assetControlsDisabled ? '运行中的版本结束后可修改素材' : '点击选择或拖入多个视频'}</b><span>最大 250 MB / 文件；不会转码、裁剪或覆盖原片</span></button><input ref={fileInput} className="sr-only" type="file" multiple accept="video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov" disabled={assetControlsDisabled} onChange={(event) => void uploadFiles(Array.from(event.target.files ?? []))} /><div className="auto-assets">{project.assets.length ? project.assets.map((asset) => <article className={`auto-asset auto-asset-${asset.status}`} key={asset.id}><video src={asset.originalUrl} muted preload="metadata" /><div><strong title={asset.originalName}>{asset.originalName}</strong><small>{asset.mimeType.toUpperCase()} · {formatBytes(asset.fileSize)}</small><span>{asset.status === 'ready' ? `${asset.metadata?.width}×${asset.metadata?.height} · ${formatDuration(asset.metadata?.durationMs)}` : asset.error?.message ?? asset.status}</span></div><button type="button" className="auto-asset-remove" disabled={assetControlsDisabled} title={assetControlsDisabled ? '版本处理期间或归档后不能修改素材' : '移除素材'} onClick={() => void removeAsset(asset.id, asset.originalName)}><span>{deletingAssetId === asset.id ? '…' : '×'}</span></button></article>) : <div className="auto-empty-assets">尚未上传素材。上传后即可创建第一个独立版本。</div>}</div></section>

              <section className="auto-version-panel"><div className="auto-section-heading"><div><span className="auto-eyebrow">生成版本</span><h2>保留每一次编排尝试</h2><p>V1、V2… 各自保存处理进度、模型、要求、结果、字幕和输出。</p></div><button type="button" className="auto-primary" disabled={!project.assets.length || project.status === 'archived' || projectHasActiveGeneration} onClick={() => openComposer()}>{projectHasActiveGeneration ? '当前版本处理中…' : '创建新版本'}</button></div><div className="auto-version-list">{generations.length ? generations.map((generation) => <article className={`auto-version-card${generation.generationId === selectedGenerationId ? ' selected' : ''}`} key={generation.generationId}><button type="button" className="auto-version-select" onClick={() => void selectGeneration(generation.generationId)}><strong>V{generation.versionNumber}</strong><span>{generationStatusLabel[generation.status]}</span><small>{generation.aiMode.kind === 'local' ? '本地顺序合成' : generation.model ?? '模型'} · {formatDate(generation.createdAt)}</small></button>{['completed', 'failed', 'cancelled', 'needs_attention'].includes(generation.status) ? <button type="button" className="auto-version-remove" disabled={deletingGenerationId === generation.generationId} title={`删除 V${generation.versionNumber}`} aria-label={`删除 V${generation.versionNumber}`} onClick={() => void removeGeneration(generation)}>{deletingGenerationId === generation.generationId ? '…' : '×'}</button> : null}</article>) : <span className="auto-version-empty">还没有版本</span>}</div></section>

              <VersionDetail project={project} generation={selectedGeneration} onNewVideo={newVideo} onDuplicateProject={() => void duplicateProject()} duplicating={duplicating} onRecompose={openComposer} onRetry={(generation) => void retryGeneration(generation)} onCancel={(generation) => void cancelGeneration(generation)} onResume={(generation) => void resumeGeneration(generation)} cancelling={cancellingGenerationId === selectedGeneration?.generationId} />
            </>}
          </section>
        </div>
      </main>

      {composerOpen && project ? <div className="auto-composer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setComposerOpen(false); }}>
        <section className="auto-composer" role="dialog" aria-modal="true" aria-labelledby="generation-composer-title">
          <header><div><span className="auto-eyebrow">新生成版本</span><h2 id="generation-composer-title">创建 V{project.generationCount + 1}</h2><p>这会创建独立快照，不会覆盖此前版本。</p></div><button type="button" onClick={() => setComposerOpen(false)} aria-label="关闭">×</button></header>
          <label>本次编排要求<textarea value={generationInstruction} maxLength={2_000} onChange={(event) => setGenerationInstruction(event.target.value)} placeholder="例如：强调开场节奏，并将结果镜头放在结尾" /></label>
          <fieldset><legend>处理方式</legend><label><input type="radio" checked={generationMode === 'ai'} disabled={connectionStatus?.mode !== 'connected'} onChange={() => setGenerationMode('ai')} /> 智能编排 {connectionStatus?.activeConnection ? `（${connectionStatus.activeConnection.model}）` : ''}</label><label><input type="radio" checked={generationMode === 'local'} onChange={() => setGenerationMode('local')} /> 按上传顺序合成</label></fieldset>
          {generationMode === 'ai' ? <><label className="auto-visual-concurrency">画面理解并发<select value={visualConcurrency} onChange={(event) => setVisualConcurrency(Number(event.target.value))}>{AUTO_VIDEO_VISUAL_CONCURRENCY_OPTIONS.map((option) => <option key={option} value={option}>{option} 路并发</option>)}</select><small>默认 1 路。并发越高越快，也更可能触发模型限流或网关错误。</small></label><TranscriptionProviderSelector providers={transcriptionProviders} selectedId={transcriptionProviderId} activatingId={activatingTranscriptionProviderId} onChange={(id) => void activateProvider(id)} /></> : null}
          {generationMode === 'local' ? <p className="auto-local-notice">不会调用模型，也不会理解画面、语音或叙事。输出会明确标记为本地顺序合成。</p> : null}
          <footer><button type="button" className="auto-secondary" onClick={() => setComposerOpen(false)}>取消</button>{connectionStatus?.mode === 'blocked' && generationMode === 'ai' ? <button type="button" className="auto-primary" onClick={() => setKeyManagerOpen(true)}>前往模型设置</button> : <button type="button" className="auto-primary" disabled={starting || (generationMode === 'ai' && (Boolean(activatingTranscriptionProviderId) || transcriptionProviders?.switching || transcriptionProviders?.activeProviderId !== transcriptionProviderId))} onClick={() => void startGeneration()}>{starting ? '正在创建…' : generationMode === 'local' ? '按上传顺序合成' : '开始智能编排'}</button>}</footer>
        </section>
      </div> : null}
      {keyManagerOpen ? <Suspense fallback={null}><KeyManager context={protocolTesterContext} onClose={() => setKeyManagerOpen(false)} onActiveKeyChange={refreshConnection} /></Suspense> : null}
      {modelLogOpen ? <Suspense fallback={null}><ModelConversationLog currentProjectId={project?.id} currentGenerationId={selectedGeneration?.generationId} onClose={() => setModelLogOpen(false)} /></Suspense> : null}
    </div>
  );
}
