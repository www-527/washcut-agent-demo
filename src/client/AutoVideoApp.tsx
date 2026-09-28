import {lazy, Suspense, useCallback, useEffect, useRef, useState} from 'react';
import {AUTO_VIDEO_MAX_ASSET_COUNT, AUTO_VIDEO_VISUAL_CONCURRENCY_DEFAULT, AUTO_VIDEO_VISUAL_CONCURRENCY_OPTIONS, type AutoVideoGeneration, type ProcessingStep, type ReasoningEffort} from '../shared/auto-video-contracts';
import {countAnalyzedAutoVideoAssets} from '../shared/auto-video-progress';
import {
  activateTranscriptionProvider,
  cancelAutoVideoGeneration,
  createAutoVideoGeneration,
  createAutoVideoProject,
  deleteAutoVideoProject,
  deleteAutoVideoAsset,
  deleteAutoVideoGeneration,
  getAutoVideoGeneration,
  getAutoVideoGenerationProgress,
  getAutoVideoProject,
  getModelConnectionStatus,
  getTranscriptionProviders,
  deactivateTranscriptionProvider,
  listAutoVideoGenerations,
  listAutoVideoProjects,
  prepareCaptionedAutoVideoOutput,
  resumeAutoVideoGeneration,
  uploadAutoVideoAssets,
  type AutoVideoGenerationView,
  type AutoVideoProjectDetail,
  type AutoVideoGenerationSummary,
  type AutoVideoProjectSummary,
  type ModelConnectionStatus,
  type TranscriptionProviderStatusResponse,
} from './auto-video-api';
import {createClientContext, fetchRelayModels, listRelayKeys, shutdownApp, type SystemShutdownResult} from './api';
import {BracketsIcon, ShieldIcon} from './components/Icons';
import {OutputPreview} from './components/OutputPreview';
import {useStableMediaUrl} from './use-stable-media-url';

const ModelConversationLog = lazy(async () => {
  const module = await import('./components/ModelConversationLog');
  return {default: module.ModelConversationLog};
});

const KeyManager = lazy(async () => {
  const module = await import('./components/KeyManager');
  return {default: module.KeyManager};
});

type GenerationMode = 'ai' | 'local';

const AssetPreview = ({asset}: {asset: AutoVideoProjectDetail['assets'][number]}) => {
  const stableOriginalUrl = useStableMediaUrl(`asset:${asset.id}`, asset.originalUrl);
  return <video src={stableOriginalUrl} muted preload="metadata" aria-hidden="true" tabIndex={-1} />;
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

const generationStatusLabelFor = (generation: AutoVideoGenerationView) =>
  generation.status === 'retry_waiting' && generation.retryState?.status === 'waiting_for_service'
    ? '等待服务恢复（自动检测）'
    : generationStatusLabel[generation.status];

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

const marketingRoleLabels: Record<string, string> = {
  hook: '吸引注意',
  problem: '痛点问题',
  service: '服务介绍',
  process: '洗车过程',
  detail: '服务细节',
  result: '洗后效果',
  offer: '优惠信息',
  cta: '到店引导',
  transition: '衔接过渡',
};

const activeGenerationStatuses = new Set<AutoVideoGeneration['status']>(['queued', 'analyzing', 'retry_waiting', 'planning', 'rendering']);
const qwenTranscriptionProviderId = 'qwen3-asr' as const;

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
  reasoningEffort: generation.reasoningEffort,
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

const workflowSteps = [
  {id: 'project', label: '项目'},
  {id: 'assets', label: '素材'},
  {id: 'compose', label: '编排'},
  {id: 'result', label: '成片'},
] as const;

function WorkflowGuide({project, generation}: {project?: AutoVideoProjectDetail; generation?: AutoVideoGenerationView}) {
  const currentIndex = !project ? 0 : !project.assets.length ? 1 : generation?.status === 'completed' ? 3 : 2;
  return (
    <nav className="auto-flow-guide" aria-label="制作流程">
      <div className="auto-flow-intro"><strong>制作流程</strong></div>
      <ol>
        {workflowSteps.map((step, index) => {
          const state = index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'upcoming';
          return <li className={`auto-flow-step ${state}`} key={step.id}><span>{index < currentIndex ? '✓' : index + 1}</span><div><strong>{step.label}</strong></div>{index < workflowSteps.length - 1 ? <i aria-hidden="true" /> : null}</li>;
        })}
      </ol>
    </nav>
  );
}

function ProjectNavigation({projects, activeProjectId, onSelect, onCreate, onDelete}: {
  projects: AutoVideoProjectSummary[];
  activeProjectId?: string;
  onSelect: (projectId: string) => void;
  onCreate: () => void;
  onDelete: (project: AutoVideoProjectSummary) => void;
}) {
  return (
    <aside className="auto-project-nav" aria-label="我的项目">
      <div className="auto-nav-heading"><span>我的项目</span><button type="button" onClick={onCreate} aria-label="新建项目">+</button></div>
      <div className="auto-project-list">
        {projects.map((item) => (
          <div className={`auto-project-nav-item${item.id === activeProjectId ? ' selected' : ''}`} key={item.id}>
            <button type="button" className="auto-project-select" aria-current={item.id === activeProjectId ? 'page' : undefined} onClick={() => onSelect(item.id)}>
              <span className={`auto-nav-status ${item.status}`} aria-hidden="true" />
              <span><strong>{item.name}</strong><small>{item.generationCount} 个版本</small></span>
            </button>
            <button type="button" className="auto-project-remove" title={`删除${item.name}`} aria-label={`删除${item.name}`} onClick={() => onDelete(item)}><span>×</span></button>
          </div>
        ))}
        {!projects.length ? <div className="auto-nav-empty">还没有项目</div> : null}
      </div>
    </aside>
  );
}

function WorkbenchContextRail({project, generation}: {project?: AutoVideoProjectDetail; generation?: AutoVideoGenerationView}) {
  const readyAssets = project?.assets.filter((asset) => asset.status === 'ready').length ?? 0;
  const active = generation ? activeGenerationStatuses.has(generation.status) : false;
  const phase = !project
    ? '新建项目'
    : !project.assets.length
      ? '上传素材'
      : active
        ? '正在编排'
        : generation?.status === 'completed'
          ? '查看成片'
          : '开始编排';

  const jumpTo = (id: string) => {
    const target = id === 'auto-upload-section' ? document.querySelector<HTMLElement>('.auto-upload-card') : document.querySelector<HTMLElement>('.auto-version-panel');
    target?.scrollIntoView({behavior: 'smooth', block: 'start'});
  };

  return (
    <aside className="auto-context-rail" aria-label="任务上下文">
      <section className="auto-context-focus">
        <strong>{phase}</strong>
      </section>
      <section className="auto-context-section">
        <div className="auto-context-heading"><span>任务概览</span></div>
        <dl className="auto-context-stats">
          <div><dt>素材</dt><dd>{project?.assets.length ?? 0}</dd></div>
          <div><dt>就绪</dt><dd>{readyAssets}</dd></div>
          <div><dt>版本</dt><dd>{project?.generationCount ?? 0}</dd></div>
        </dl>
      </section>
      <section className="auto-context-section">
        <div className="auto-context-heading"><span>快速定位</span></div>
        <div className="auto-context-links">
          <button type="button" onClick={() => jumpTo('auto-upload-section')} disabled={!project}><span>素材</span></button>
          <button type="button" onClick={() => jumpTo('auto-versions-section')} disabled={!project}><span>版本</span></button>
        </div>
      </section>
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

function LlmModelSelector({status, selectedModel, models, loading, onRefresh, onChange}: {
  status?: ModelConnectionStatus;
  selectedModel: string;
  models: string[];
  loading: boolean;
  onRefresh: () => void;
  onChange: (model: string) => void;
}) {
  const connected = status?.mode === 'connected';
  const defaultModel = status?.activeConnection?.model ?? '';
  const options = [...new Set([selectedModel, defaultModel, ...models].filter(Boolean))];
  return (
    <section className="auto-llm-selector" aria-label="LLM 模型选择">
      <div className="auto-llm-heading"><div><strong>LLM 模型</strong><small>用于画面理解、素材归类和智能编排</small></div><button type="button" className="auto-llm-refresh" disabled={!connected || loading} onClick={onRefresh}>{loading ? '读取中…' : '刷新列表'}</button></div>
      <label><span>本次默认模型</span><select value={selectedModel || defaultModel} disabled={!connected || loading || !options.length} onChange={(event) => onChange(event.target.value)}>{options.length ? options.map((model) => <option value={model} key={model}>{model}{model === defaultModel ? '（连接默认）' : ''}</option>) : <option value="">{connected ? '暂无可用模型' : '请先配置模型连接'}</option>}</select></label>
      <small className="auto-llm-note">{connected ? models.length ? '选择后会作为后续智能编排的默认模型；生成弹窗仍可单独覆盖。' : '暂未读取到模型列表，将使用当前连接默认模型。' : '模型连接不可用时只能使用本地顺序合成。'}</small>
    </section>
  );
}

const reasoningEffortOptions: Array<{value: ReasoningEffort; label: string; note: string}> = [
  {value: 'low', label: '低 · 更快', note: '适合快速预览和素材较少的任务'},
  {value: 'medium', label: '中 · 平衡', note: '在速度和复杂素材理解之间平衡'},
  {value: 'high', label: '高 · 更仔细', note: '适合素材多、叙事关系复杂的任务'},
];

function ReasoningEffortSelector({value, onChange, standalone = false}: {value: ReasoningEffort; onChange: (value: ReasoningEffort) => void; standalone?: boolean}) {
  const selected = reasoningEffortOptions.find((option) => option.value === value) ?? reasoningEffortOptions[0];
  return <section className={`auto-reasoning-selector${standalone ? ' standalone' : ''}`} aria-label="推理强度">
    <label><span>推理强度</span><select value={value} onChange={(event) => onChange(event.target.value as ReasoningEffort)}>{reasoningEffortOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
    <small>{selected.note}。每个生成版本会锁定本次选择。</small>
  </section>;
}

function TranscriptionProviderSelector({providers, selectedId, activatingId, deactivatingId, standalone = false, onChange, onDeactivate}: {
  providers?: TranscriptionProviderStatusResponse;
  selectedId: typeof qwenTranscriptionProviderId;
  activatingId?: typeof qwenTranscriptionProviderId;
  deactivatingId?: typeof qwenTranscriptionProviderId;
  standalone?: boolean;
  onChange: (providerId: typeof qwenTranscriptionProviderId) => void;
  onDeactivate: (providerId: typeof qwenTranscriptionProviderId) => void;
}) {
  const qwen = providers?.providers.find((provider) => provider.id === 'qwen3-asr');
  const busy = providers?.switching || Boolean(activatingId) || Boolean(deactivatingId);
  const active = providers?.activeProviderId === qwenTranscriptionProviderId;
  const unavailable = !qwen?.configured;
  return (
    <fieldset className={`auto-transcription-selector${standalone ? ' standalone' : ''}`} disabled={busy}>
      <legend>转文字模型</legend>
      <div className="auto-transcription-options" aria-label="转文字模型">
        <div className={`auto-transcription-option-wrap${active ? ' active' : ''}`}>
          <button type="button" aria-pressed={active} className={`auto-transcription-option${active ? ' selected' : selectedId === qwenTranscriptionProviderId ? ' pending' : ''}`} disabled={busy || unavailable || active} onClick={() => onChange(qwenTranscriptionProviderId)}>
            <span><strong>{qwen?.label ?? 'Qwen3-ASR-1.7B（中文增强）'}</strong><small>{qwen?.model ?? '正在读取服务状态…'}</small></span>
            <b>{activatingId === qwenTranscriptionProviderId ? '加载中…' : active ? '已启用' : !qwen?.configured ? '未配置' : !qwen.reachable ? '重新加载' : '启用'}</b>
          </button>
          {active ? <button type="button" className="auto-transcription-close" disabled={busy} onClick={() => onDeactivate(qwenTranscriptionProviderId)}>{deactivatingId === qwenTranscriptionProviderId ? '关闭中…' : '关闭'}</button> : null}
        </div>
      </div>
      <p>程序启动时会检测 Docker，并在环境可用时自动启动 Qwen 网关和加载模型。</p>
      {qwen && !qwen.ready ? <div className="auto-transcription-unavailable" role="alert"><strong>Qwen 自动加载失败</strong><span><code>{qwen.error?.code ?? 'QWEN_NOT_READY'}</code>：{qwen.error?.message ?? qwen.message}</span><small>请确认 Docker Desktop 已启动；修复后点击“重新加载”。</small></div> : null}
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

function VersionDetail({project, generation, onCancel, onResume, cancelling, diagnosticsOnly = false}: {
  project: AutoVideoProjectDetail;
  generation?: AutoVideoGenerationView;
  onCancel: (generation: AutoVideoGenerationView) => void;
  onResume: (generation: AutoVideoGenerationView) => void;
  cancelling: boolean;
  diagnosticsOnly?: boolean;
}) {
  if (!generation) return diagnosticsOnly ? null : <section className="auto-empty-workspace"><strong>还没有生成版本</strong><span>上传素材后，在“编排版本”区域新建版本。</span></section>;
  const local = generation.aiMode.kind === 'local';
  const processing = activeGenerationStatuses.has(generation.status);
  const hasRunningStep = generation.steps.some((step) => step.status === 'running');
  const canInterrupt = processing || hasRunningStep;
  const canResume = generation.status === 'failed' || generation.status === 'cancelled' || generation.status === 'needs_attention';
  const clips = generation.editPlan?.clips ?? [];
  const checkpoints = generation.assetCheckpoints ?? [];
  // The generation snapshot is the complete, immutable set of source clips.
  // Checkpoints are created lazily while assets are processed, so using their
  // count would make the progress denominator grow during the run.
  const totalAssetCount = generation.assetIds.length;
  const completedAnalysisCount = countAnalyzedAutoVideoAssets(generation);
  const waitingCheckpoint = checkpoints.find((checkpoint) => checkpoint.visualAnalysis.status === 'retry_waiting');
  const waitingForService = generation.retryState?.status === 'waiting_for_service';
  const serviceRecoveryNeedsAttention = generation.status === 'needs_attention' && generation.retryState?.status === 'needs_attention' && generation.retryState.recoveryAttempts > 0;
  const outputReady = generation.output?.status === 'ready' && Boolean(generation.output.videoUrl);
  return (
    <div className="auto-version-detail">
      {!diagnosticsOnly ? <>
      {!outputReady ? <section className="auto-version-heading">
        <div className="auto-version-summary">
          <h2>V{generation.versionNumber}</h2>
          <div className={`auto-status auto-status-${generation.status}`}><i />{generationStatusLabelFor(generation)}<small>{generation.progress}%</small></div>
        </div>
      </section> : null}

      {generation.output?.status === 'ready' && generation.output.videoUrl ? <>
        <OutputPreview
          mediaRevision={`${generation.generationId}:plain:${generation.output.renderedAt ?? ''}:${generation.output.fileSize ?? ''}`}
          captionedMediaRevision={`${generation.generationId}:captioned:${generation.output.renderedAt ?? ''}:${generation.output.captionedFileSize ?? ''}`}
          versionNumber={generation.versionNumber}
          status={generation.status}
          statusLabel={generationStatusLabelFor(generation)}
          progress={generation.progress}
          videoWidth={generation.output.width ?? generation.canvas.width}
          videoHeight={generation.output.height ?? generation.canvas.height}
          videoUrl={generation.output.videoUrl}
          captionedVideoUrl={generation.output.captionedVideoUrl}
          subtitleUrl={generation.output.subtitleUrl}
          durationMs={generation.output.durationMs}
          onPrepareCaptionedDownload={async () => (await prepareCaptionedAutoVideoOutput(generation.projectId, generation.generationId)).videoUrl}
        />
      </> : null}

      </> : null}

      {diagnosticsOnly || !outputReady ? <section className="auto-process-card">
        <div className="auto-section-heading"><div><h2>{local ? '合成进度' : '编排进度'}</h2></div></div>
        <div className="auto-process-actions">
          {canInterrupt ? <button type="button" className="auto-secondary" disabled={cancelling} onClick={() => onCancel(generation)}>{cancelling ? '正在中断…' : '中断任务'}</button> : null}
          {canResume ? <button type="button" className="auto-primary" onClick={() => onResume(generation)}>继续生成成片</button> : null}
        </div>
        {!local && totalAssetCount ? <div className="auto-checkpoint-progress">
          <strong>已分析 {completedAnalysisCount} / {totalAssetCount} 段</strong>
          {generation.status === 'cancelled' ? <small>任务已中断。已保留 {completedAnalysisCount} / {totalAssetCount} 个素材的理解结果。</small> : null}
          {waitingForService ? <div className="auto-service-recovery-notice" role="status" aria-live="polite"><strong>正在等待服务恢复，无需再次点击</strong><span>后台只做低频服务检测；恢复后会自动从已保存断点继续，直到成片完成或你中断任务。已检测 {generation.retryState?.recoveryAttempts ?? 0} 次{generation.retryState?.nextRetryAt ? `；下次检测：${formatDate(generation.retryState.nextRetryAt)}` : ''}。</span></div> : serviceRecoveryNeedsAttention ? <div className="auto-service-recovery-notice is-attention" role="alert"><strong>这个历史任务已停止自动尝试</strong><span>已保留完成进度和原始错误。点击“继续生成成片”一次后，将按新的持续等待机制从断点恢复。</span></div> : waitingCheckpoint ? <small>正在等待重试：{project.assets.find((asset) => asset.id === waitingCheckpoint.assetId)?.originalName ?? waitingCheckpoint.assetId} · 第 {waitingCheckpoint.visualAnalysis.attempts} 次尝试失败：{waitingCheckpoint.visualAnalysis.lastError?.message ?? '上游错误'} · 将在 {waitingCheckpoint.visualAnalysis.nextRetryAt ? formatDate(waitingCheckpoint.visualAnalysis.nextRetryAt) : '稍后'} 自动重试</small> : null}
        </div> : null}
        <GenerationSteps generation={generation} />
      </section> : null}

      {diagnosticsOnly && clips.length ? <section className="auto-plan-card"><div className="auto-section-heading"><div><span className="auto-eyebrow">{local ? '顺序合成结果' : '编排结果'}</span><h2>{local ? '按上传顺序完整拼接' : '系统将按此顺序完整拼接'}</h2><p>{generation.editPlan?.overallReason}</p></div><span>只读快照</span></div><ol className="auto-plan-list">{clips.map((clip) => { const asset = project.assets.find((candidate) => candidate.id === clip.assetId); return <li key={clip.assetId}><b>{clip.order}</b><div><strong>{asset?.originalName ?? clip.assetId}</strong><span>{clip.reason}</span></div></li>; })}</ol></section> : null}

      {diagnosticsOnly && !local && generation.assetAnalyses.length ? <details className="auto-analysis"><summary>查看本版本的素材理解结果（{generation.assetAnalyses.length} 个）</summary><div>{generation.assetAnalyses.map((analysis) => <article key={analysis.assetId}><strong>{project.assets.find((asset) => asset.id === analysis.assetId)?.originalName ?? analysis.assetId}</strong><small>广告作用：{marketingRoleLabels[analysis.marketingRole] ?? analysis.marketingRole}</small><p>{analysis.combinedSummary}</p></article>)}</div></details> : null}

    </div>
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
  const [transcriptionProviderId, setTranscriptionProviderId] = useState<typeof qwenTranscriptionProviderId>(qwenTranscriptionProviderId);
  const [activatingTranscriptionProviderId, setActivatingTranscriptionProviderId] = useState<typeof qwenTranscriptionProviderId>();
  const [deactivatingTranscriptionProviderId, setDeactivatingTranscriptionProviderId] = useState<typeof qwenTranscriptionProviderId>();
  const [creating, setCreating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deletingAssetId, setDeletingAssetId] = useState<string>();
  const [deletingProjectId, setDeletingProjectId] = useState<string>();
  const [starting, setStarting] = useState(false);
  const [cancellingGenerationId, setCancellingGenerationId] = useState<string>();
  const [deletingGenerationId, setDeletingGenerationId] = useState<string>();
  const [composerOpen, setComposerOpen] = useState(false);
  const [generationInstruction, setGenerationInstruction] = useState('');
  const [generationMode, setGenerationMode] = useState<GenerationMode>('ai');
  const [preferredModel, setPreferredModel] = useState('');
  const [preferredReasoningEffort, setPreferredReasoningEffort] = useState<ReasoningEffort>('low');
  const [availableRelayModels, setAvailableRelayModels] = useState<string[]>([]);
  const [loadingRelayModels, setLoadingRelayModels] = useState(false);
  const [visualConcurrency, setVisualConcurrency] = useState<number>(AUTO_VIDEO_VISUAL_CONCURRENCY_DEFAULT);
  const [error, setError] = useState('');
  const [modelLogOpen, setModelLogOpen] = useState(false);
  const [keyManagerOpen, setKeyManagerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [closingProgram, setClosingProgram] = useState(false);
  const [shutdownResult, setShutdownResult] = useState<SystemShutdownResult>();
  const [expandedAssetProjectId, setExpandedAssetProjectId] = useState<string>();
  const [expandedVersionProjectId, setExpandedVersionProjectId] = useState<string>();
  const [protocolTesterContext] = useState(() => createClientContext());
  const lastProgressLogKey = useRef<string | undefined>(undefined);

  const projectHasActiveGeneration = generations.some((generation) => activeGenerationStatuses.has(generation.status));
  const shutdownHasWarnings = Boolean(shutdownResult && Object.values(shutdownResult.services).some((service) => service.status === 'warning'));
  const readyAssetCount = project?.assets.filter((asset) => asset.status === 'ready').length ?? 0;
  const projectDisplayName = project && /^\d+$/.test(project.name.trim()) ? `项目 ${project.name.trim()}` : project?.name;
  const selectedGenerationNeedsPolling = Boolean(selectedGeneration && (activeGenerationStatuses.has(selectedGeneration.status) || selectedGeneration.steps.some((step) => step.status === 'running')));
  const assetControlsDisabled = !project || project.status === 'archived' || projectHasActiveGeneration || uploading || Boolean(deletingAssetId);
  const assetLimitReached = Boolean(project && project.assets.length >= AUTO_VIDEO_MAX_ASSET_COUNT);
  const assetUploadDisabled = assetControlsDisabled || assetLimitReached;
  const assetsExpanded = Boolean(project && expandedAssetProjectId === project.id);
  const versionsExpanded = Boolean(project && expandedVersionProjectId === project.id);
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

  const relayConnectionId = connectionStatus?.activeConnection?.connectionId;
  const relayDefaultModel = connectionStatus?.activeConnection?.model ?? '';
  const preferredModelStorageKey = relayConnectionId ? `auto-video.preferred-model.v1:${relayConnectionId}` : '';
  const preferredReasoningStorageKey = relayConnectionId ? `auto-video.reasoning-effort.v1:${relayConnectionId}` : '';

  useEffect(() => {
    if (!preferredModelStorageKey) return;
    const savedModel = window.localStorage.getItem(preferredModelStorageKey);
    if (savedModel) {
      setPreferredModel(savedModel);
    }
  }, [preferredModelStorageKey]);

  useEffect(() => {
    if (preferredModelStorageKey && preferredModel) window.localStorage.setItem(preferredModelStorageKey, preferredModel);
  }, [preferredModel, preferredModelStorageKey]);

  useEffect(() => {
    if (!preferredReasoningStorageKey) return;
    const saved = window.localStorage.getItem(preferredReasoningStorageKey);
    if (saved === 'low' || saved === 'medium' || saved === 'high') {
      setPreferredReasoningEffort(saved);
    }
  }, [preferredReasoningStorageKey]);

  useEffect(() => {
    if (preferredReasoningStorageKey) window.localStorage.setItem(preferredReasoningStorageKey, preferredReasoningEffort);
  }, [preferredReasoningEffort, preferredReasoningStorageKey]);

  const refreshRelayModels = useCallback(async () => {
    if (!relayConnectionId || relayConnectionId === 'environment') {
      setAvailableRelayModels([]);
      return;
    }
    setLoadingRelayModels(true);
    try {
      const keys = await listRelayKeys(protocolTesterContext);
      const key = keys.find((item) => item.keyId === relayConnectionId);
      const models = key ? await fetchRelayModels({keyId: key.keyId, baseUrl: key.baseUrl}, protocolTesterContext) : [];
      setAvailableRelayModels(models);
      setPreferredModel((current) => current || relayDefaultModel || models[0] || '');
    } catch {
      // The saved connection default remains usable when model discovery is unavailable.
      setAvailableRelayModels([]);
    } finally {
      setLoadingRelayModels(false);
    }
  }, [protocolTesterContext, relayConnectionId, relayDefaultModel]);

  const activateProvider = async (providerId: typeof qwenTranscriptionProviderId) => {
    if (activatingTranscriptionProviderId || deactivatingTranscriptionProviderId || transcriptionProviders?.switching || transcriptionProviders?.activeProviderId === providerId) return;
    setActivatingTranscriptionProviderId(providerId); setError('');
    try {
      const providers = await activateTranscriptionProvider(providerId);
      setTranscriptionProviders(providers);
      setTranscriptionProviderId(qwenTranscriptionProviderId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '无法切换转文字模型。');
      try { setTranscriptionProviders(await getTranscriptionProviders()); } catch { /* keep the original switch error */ }
    } finally { setActivatingTranscriptionProviderId(undefined); }
  };

  const deactivateProvider = async (providerId: typeof qwenTranscriptionProviderId) => {
    if (activatingTranscriptionProviderId || deactivatingTranscriptionProviderId || transcriptionProviders?.switching || transcriptionProviders?.activeProviderId !== providerId) return;
    setDeactivatingTranscriptionProviderId(providerId); setError('');
    try {
      const providers = await deactivateTranscriptionProvider(providerId);
      setTranscriptionProviders(providers);
      setTranscriptionProviderId(qwenTranscriptionProviderId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '无法关闭转文字模型。');
      try { setTranscriptionProviders(await getTranscriptionProviders()); } catch { /* keep the original close error */ }
    } finally { setDeactivatingTranscriptionProviderId(undefined); }
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
      if (providers.activeProviderId === qwenTranscriptionProviderId) setTranscriptionProviderId(providers.activeProviderId);
      const savedId = window.localStorage.getItem('auto-video.active-project');
      const initial = items.find((item) => item.id === savedId) ?? items[0];
      if (initial) void refreshProject(initial.id).catch((caught: unknown) => { if (!disposed) setError(caught instanceof Error ? caught.message : '无法打开项目。'); });
    }).catch((caught: unknown) => { if (!disposed) setError(caught instanceof Error ? caught.message : '无法读取工作台。'); });
    return () => { disposed = true; };
  }, [refreshProject]);

  useEffect(() => {
    if (connectionStatus?.mode !== 'connected' || !relayConnectionId || relayConnectionId === 'environment') {
      setAvailableRelayModels([]);
      return;
    }
    void refreshRelayModels();
  }, [connectionStatus?.mode, relayConnectionId, refreshRelayModels]);

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
    let polling = false;
    const poll = async () => {
      if (disposed || polling || document.visibilityState !== 'visible') return;
      polling = true;
      try {
        const progress = await getAutoVideoGenerationProgress(project.id, selectedGeneration.generationId);
        if (disposed) return;
        setSelectedGeneration((current) => current ? {...current, ...progress} : current);
        setGenerations((current) => current.map((item) => item.generationId === progress.generationId ? {...item, status: progress.status, progress: progress.progress, updatedAt: progress.updatedAt} : item));
        if (['completed', 'failed', 'cancelled', 'needs_attention'].includes(progress.status)) {
          const [detail, full] = await Promise.all([
            getAutoVideoProject(project.id),
            getAutoVideoGeneration(project.id, selectedGeneration.generationId),
          ]);
          if (!disposed) {
            setProject(detail);
            setProjects((current) => upsertProject(current, projectSummary(detail)));
            setSelectedGeneration(full);
            setGenerations((current) => upsertGeneration(current, generationSummary(full)));
          }
        }
        setError('');
      } catch (caught) {
        if (!disposed) setError(caught instanceof Error ? caught.message : '生成版本状态查询失败。');
      } finally {
        polling = false;
        if (!disposed && document.visibilityState === 'visible') {
          const nextDelay = selectedGeneration?.status === 'retry_waiting' && selectedGeneration.retryState?.nextRetryAt
            ? Math.max(1_200, Date.parse(selectedGeneration.retryState.nextRetryAt) - Date.now()) : 1_200;
          timer = window.setTimeout(() => void poll(), Math.min(nextDelay, 15_000));
        }
      }
    };
    const start = () => {
      window.clearTimeout(timer);
      if (document.visibilityState === 'visible') void poll();
    };
    const onVisibility = () => start();
    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { disposed = true; window.clearTimeout(timer); document.removeEventListener('visibilitychange', onVisibility); };
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

  /*
  const removeProject = async (candidate: AutoVideoProjectSummary) => {
    if (deletingProjectId) return;
    if (!window.confirm(`确认删除项目“${candidate.name}”吗？\n\n项目中的原始视频、版本和成片将一并删除，无法恢复。`)) return;
    setDeletingProjectId(candidate.id); setError('');
    try {
      await deleteAutoVideoProject(candidate.id);
      setProjects((current) => current.filter((item) => item.id !== candidate.id));
      if (project?.id === candidate.id) {
        setProject(undefined); setGenerations([]); setSelectedGenerationId(undefined); setSelectedGeneration(undefined); setComposerOpen(false);
        window.localStorage.removeItem('auto-video.active-project');
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : '删除项目失败。'); }
    finally { setDeletingProjectId(undefined); }
  };

  */

  const removeProject = async (candidate: AutoVideoProjectSummary) => {
    if (deletingProjectId) return;
    if (!window.confirm(`确认删除项目“${candidate.name}”吗？\n\n项目中的原始视频、版本和成片将一并删除，无法恢复。`)) return;
    setDeletingProjectId(candidate.id); setError('');
    try {
      await deleteAutoVideoProject(candidate.id);
      setProjects((current) => current.filter((item) => item.id !== candidate.id));
      if (project?.id === candidate.id) {
        setProject(undefined); setGenerations([]); setSelectedGenerationId(undefined); setSelectedGeneration(undefined); setComposerOpen(false);
        window.localStorage.removeItem('auto-video.active-project');
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : '删除项目失败。'); }
    finally { setDeletingProjectId(undefined); }
  };

  const selectProject = async (projectId: string) => {
    setError('');
    if (project?.id !== projectId) setSelectedGeneration(undefined);
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


  const uploadFiles = async (files: File[]) => {
    if (!project || !files.length || assetUploadDisabled) return;
    const remainingAssetCount = AUTO_VIDEO_MAX_ASSET_COUNT - project.assets.length;
    if (files.length > remainingAssetCount) {
      setError(`每个项目最多上传 ${AUTO_VIDEO_MAX_ASSET_COUNT} 个素材，当前还可添加 ${remainingAssetCount} 个。`);
      if (fileInput.current) fileInput.current.value = '';
      return;
    }
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

  const openSettings = () => {
    setComposerOpen(false);
    setSettingsOpen(true);
    setError('');
    if (relayConnectionId && relayConnectionId !== 'environment' && !availableRelayModels.length) void refreshRelayModels();
  };

  const openComposer = () => {
    if (!project) return;
    setGenerationInstruction(project.userInstruction ?? '');
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
      const result = await createAutoVideoGeneration(project.id, {
        mode: generationMode,
        ...(generationInstruction.trim() ? {userInstruction: generationInstruction.trim()} : {}),
        ...(generationMode === 'ai' ? {
          ...(preferredModel.trim() ? {model: preferredModel.trim()} : {}),
          reasoningEffort: preferredReasoningEffort,
          visualConcurrency,
          transcriptionSelection: {providerId: transcriptionProviderId},
        } : {}),
      }, idempotencyKey());
      setGenerations((current) => upsertGeneration(current, generationSummary(result.generation)));
      setSelectedGenerationId(result.generation.generationId);
      setSelectedGeneration(result.generation);
      setComposerOpen(false);
      await refreshProject(project.id, result.generation.generationId);
    } catch (caught) { setError(caught instanceof Error ? caught.message : '无法创建生成版本。'); }
    finally { setStarting(false); }
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

  const shutdownProgram = async () => {
    if (closingProgram) return;
    const warning = projectHasActiveGeneration
      ? '当前成片任务仍在运行。安全关闭会保存现有检查点，下次启动后自动继续。\n\n确定关闭前端、后端、Qwen 模型与网关，以及本项目的 Docker 服务吗？'
      : '确定安全关闭前端、后端、Qwen 模型与网关，以及本项目的 Docker 服务吗？';
    if (!window.confirm(warning)) return;
    setSettingsOpen(false);
    setClosingProgram(true);
    setError('');
    try {
      setShutdownResult(await shutdownApp(protocolTesterContext));
    } catch (caught) {
      setClosingProgram(false);
      setError(caught instanceof Error ? caught.message : '安全关闭程序失败。');
    }
  };

  return (
    <div className="auto-app">
      {closingProgram ? <div className="auto-shutdown-screen" role="status" aria-live="assertive"><div>
        <span aria-hidden="true">{shutdownResult ? shutdownHasWarnings ? '!' : '✓' : '…'}</span>
        <h1>{shutdownResult ? shutdownHasWarnings ? '程序已关闭，但部分服务需要检查' : '程序已安全关闭' : '正在安全关闭程序'}</h1>
        <p>{shutdownResult
          ? shutdownHasWarnings
            ? '前后端正在退出。下方服务未确认完全停止，请保留错误信息并在下次启动后检查。'
            : shutdownResult.activeTasksWillResume
              ? '现有任务检查点已保留，下次启动后会自动继续。现在可以关闭此页面。'
              : '前后端正在退出，现在可以关闭此页面。'
          : '正在释放模型显存、停止 Qwen 网关并关闭项目服务，请稍候。'}</p>
        {shutdownResult ? <ul><li>Qwen：{shutdownResult.services.qwen.message}</li><li>Docker：{shutdownResult.services.docker.message}</li></ul> : null}
      </div></div> : null}
      <header className="auto-topbar">
        <a href="#top" className="auto-brand"><span aria-hidden="true">✦</span>编排台</a>
        <div className="auto-topbar-actions">
          <button type="button" className="auto-settings-trigger" onClick={openSettings} aria-expanded={settingsOpen} aria-controls="auto-settings-drawer"><ShieldIcon />设置</button>
        </div>
      </header>

      <a className="auto-skip-link" href="#top">跳到主要内容</a>
      <main id="top" className="auto-main auto-workbench-shell">
        {error ? <div className="auto-error" role="alert">{error}</div> : null}
        {!project ? <WorkflowGuide project={project} generation={selectedGeneration} /> : null}
        <div className="auto-workbench">
          <ProjectNavigation projects={projects} activeProjectId={project?.id} onSelect={(id) => void selectProject(id)} onCreate={newVideo} onDelete={(item) => void removeProject(item)} />
          <section className="auto-workspace">
            {!project ? <section className="auto-create-card"><div><span className="auto-eyebrow">第 1 步 · 新建项目</span><h2>先建立一组素材集合</h2><p>项目只负责保存原片和默认要求。创建后进入上传步骤，每次编排都会生成独立版本，旧成片不会被覆盖。</p></div><form onSubmit={(event) => { event.preventDefault(); void createProject(); }}><label>项目名称<input id="project-name" name="projectName" autoComplete="off" value={projectName} maxLength={80} onChange={(event) => setProjectName(event.target.value)} required /></label><label>默认编排要求（可选）<textarea id="project-instruction" name="projectInstruction" autoComplete="off" value={projectInstruction} maxLength={2_000} onChange={(event) => setProjectInstruction(event.target.value)} /></label><button type="submit" className="auto-primary" disabled={creating}>{creating ? '正在创建…' : '创建项目，继续上传素材'}</button></form></section> : <>
              <section className="auto-project-heading">
                <div className="auto-project-heading-copy">
                  <h2>{projectDisplayName}</h2>
                  <p>{project.assets.length ? `${readyAssetCount}/${project.assets.length} 段素材已就绪` : '还没有素材'}{project.userInstruction ? ` · ${project.userInstruction}` : ''}</p>
                </div>
                <button type="button" className="auto-primary auto-project-new-version" disabled={!project.assets.length || project.status === 'archived' || projectHasActiveGeneration} onClick={() => void startGeneration()}>{projectHasActiveGeneration ? '处理中…' : '一键生成成片'}</button>
                <WorkflowGuide project={project} generation={selectedGeneration} />
              </section>
              <section className={`auto-upload-card ${project.assets.length ? 'has-assets' : 'is-empty'}`} aria-labelledby="auto-upload-title">
                <div className="auto-section-heading">
                  <div><h2 id="auto-upload-title">素材 <small>{project.assets.length}</small></h2><p>每段原片都会保留并使用一次。</p></div>
                  {project.assets.length > 2 ? <div className={`auto-section-heading-side auto-asset-disclosure${project.assets.length <= 4 ? ' mobile-only' : ''}`}><button type="button" className="auto-secondary auto-list-toggle" aria-expanded={assetsExpanded} aria-controls="auto-asset-list" onClick={() => setExpandedAssetProjectId((current) => current === project.id ? undefined : project.id)}>{assetsExpanded ? '收起素材' : `查看全部 ${project.assets.length} 段`}</button></div> : null}
                </div>
                <button type="button" className="auto-dropzone" disabled={assetUploadDisabled} onClick={() => fileInput.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void uploadFiles(Array.from(event.dataTransfer.files)); }}>
                  <b>{uploading ? '正在保存原片并检测媒体信息…' : assetLimitReached ? `已达到 ${AUTO_VIDEO_MAX_ASSET_COUNT} 个素材上限` : assetControlsDisabled ? '运行中的版本结束后可修改素材' : project.assets.length ? '添加视频' : '选择或拖入视频文件'}</b>
                  <span>{project.assets.length ? `还可添加 ${Math.max(0, AUTO_VIDEO_MAX_ASSET_COUNT - project.assets.length)} 个；最大 250 MB / 文件` : '支持 MP4、WebM 和 MOV；最大 250 MB / 文件'}</span>
                </button>
                <input ref={fileInput} className="sr-only" type="file" multiple accept="video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov" disabled={assetUploadDisabled} onChange={(event) => void uploadFiles(Array.from(event.target.files ?? []))} />
                {project.assets.length ? <>
                  <div id="auto-asset-list" className={`auto-assets ${assetsExpanded ? 'is-expanded' : 'is-collapsed'}`}>{project.assets.map((asset) => <article className={`auto-asset auto-asset-${asset.status}`} key={asset.id}><AssetPreview asset={asset} /><div className="auto-asset-copy"><strong title={asset.originalName}>{asset.originalName}</strong><span className="auto-asset-meta"><small>{formatBytes(asset.fileSize)}</small><i aria-hidden="true">·</i><small>{asset.status === 'ready' ? formatDuration(asset.metadata?.durationMs) : asset.error?.message ?? asset.status}</small></span></div><button type="button" className="auto-asset-remove" disabled={assetControlsDisabled} title={assetControlsDisabled ? '版本处理期间或归档后不能修改素材' : '移除素材'} aria-label={`移除 ${asset.originalName}`} onClick={() => void removeAsset(asset.id, asset.originalName)}><span>{deletingAssetId === asset.id ? '…' : '×'}</span></button></article>)}</div>
                </> : null}
                {!generations.length ? <div className="auto-upload-start"><span>素材已就绪，系统将完整使用全部素材</span><button type="button" className="auto-primary" disabled={!project.assets.length || project.status === 'archived' || projectHasActiveGeneration} onClick={() => void startGeneration()}>{projectHasActiveGeneration ? '处理中…' : '一键生成成片'}</button></div> : null}
              </section>

              <section className="auto-version-panel"><div className="auto-section-heading"><div><h2>编排版本</h2></div></div><div id="auto-version-list" className={`auto-version-list ${versionsExpanded ? 'is-expanded' : 'is-collapsed'}`}>{generations.length ? generations.map((generation) => <article className={`auto-version-card${generation.generationId === selectedGenerationId ? ' selected' : ''}`} key={generation.generationId}><button type="button" className="auto-version-select" onClick={() => void selectGeneration(generation.generationId)}><strong>V{generation.versionNumber}</strong><span>{generationStatusLabel[generation.status]}</span><small>{formatDate(generation.createdAt)}</small></button>{['completed', 'failed', 'cancelled', 'needs_attention'].includes(generation.status) ? <button type="button" className="auto-version-remove" disabled={deletingGenerationId === generation.generationId} title={`删除 V${generation.versionNumber}`} aria-label={`删除 V${generation.versionNumber}`} onClick={() => void removeGeneration(generation)}>{deletingGenerationId === generation.generationId ? '…' : '×'}</button> : null}</article>) : <span className="auto-version-empty">还没有版本</span>}</div>{generations.length > 3 ? <div className={`auto-list-disclosure${generations.length <= 4 ? ' mobile-only' : ''}`}><button type="button" className="auto-secondary auto-list-toggle" aria-expanded={versionsExpanded} aria-controls="auto-version-list" onClick={() => setExpandedVersionProjectId((current) => current === project.id ? undefined : project.id)}>{versionsExpanded ? '收起版本' : `查看全部 ${generations.length} 个版本`}</button></div> : null}</section>

              <VersionDetail project={project} generation={selectedGeneration} onCancel={(generation) => void cancelGeneration(generation)} onResume={(generation) => void resumeGeneration(generation)} cancelling={cancellingGenerationId === selectedGeneration?.generationId} />
            </>}
          </section>
          <WorkbenchContextRail project={project} generation={selectedGeneration} />
        </div>
      </main>

      {settingsOpen ? <div className="auto-settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}>
        <aside id="auto-settings-drawer" className="auto-settings-drawer" role="dialog" aria-modal="true" aria-labelledby="auto-settings-title">
          <header className="auto-settings-drawer-header"><div><span className="auto-eyebrow">工作台设置</span><h2 id="auto-settings-title">设置</h2><p>模型、测试与现有高级选项集中在这里。</p></div><button type="button" className="auto-settings-close" onClick={() => setSettingsOpen(false)} aria-label="关闭设置">×</button></header>
          <div className="auto-settings-drawer-body">
            <button type="button" className="auto-settings-entry" onClick={() => { setSettingsOpen(false); setKeyManagerOpen(true); }}><span className="auto-settings-entry-icon"><ShieldIcon /></span><span><strong>模型设置</strong><small>管理模型连接、模型列表和转写服务</small></span><b aria-hidden="true">→</b></button>
            <button type="button" className="auto-settings-entry" onClick={() => { setSettingsOpen(false); setModelLogOpen(true); }}><span className="auto-settings-entry-icon"><BracketsIcon /></span><span><strong>模型对话测试</strong><small>查看现有模型请求、回复和失败记录</small></span><b aria-hidden="true">→</b></button>
            <section className="auto-settings-drawer-section" aria-labelledby="auto-project-settings-title">
              <div className="auto-settings-drawer-section-heading"><span><strong id="auto-project-settings-title">编排设置</strong><small>新建版本时统一使用这里的当前配置。</small></span></div>
              <fieldset className="auto-generation-mode">
                <legend>处理方式</legend>
                <label><input type="radio" checked={generationMode === 'ai'} disabled={connectionStatus?.mode !== 'connected'} onChange={() => setGenerationMode('ai')} /> 智能编排</label>
                <label><input type="radio" checked={generationMode === 'local'} onChange={() => setGenerationMode('local')} /> 按上传顺序合成</label>
              </fieldset>
              {generationMode === 'ai' ? <>
                <ModelStatusCard status={connectionStatus} onOpenSettings={() => { setSettingsOpen(false); setKeyManagerOpen(true); }} />
                <label className="auto-visual-concurrency">画面理解并发<select value={visualConcurrency} onChange={(event) => setVisualConcurrency(Number(event.target.value))}>{AUTO_VIDEO_VISUAL_CONCURRENCY_OPTIONS.map((option) => <option key={option} value={option}>{option} 路并发</option>)}</select><small>默认 1 路。5 路以上会增加模型限流和网关压力；实际并发还受服务端全局模型上限控制。</small></label>
                <LlmModelSelector status={connectionStatus} selectedModel={preferredModel} models={availableRelayModels} loading={loadingRelayModels} onRefresh={() => void refreshRelayModels()} onChange={setPreferredModel} />
                <ReasoningEffortSelector value={preferredReasoningEffort} onChange={setPreferredReasoningEffort} standalone />
                <TranscriptionProviderSelector providers={transcriptionProviders} selectedId={transcriptionProviderId} activatingId={activatingTranscriptionProviderId} deactivatingId={deactivatingTranscriptionProviderId} standalone onChange={(id) => void activateProvider(id)} onDeactivate={(id) => void deactivateProvider(id)} />
              </> : <p className="auto-local-notice">不会调用模型，也不会理解画面、语音或叙事。新版本将按上传顺序完整合成素材。</p>}
            </section>
            <section className="auto-settings-drawer-section auto-settings-diagnostics" aria-labelledby="auto-diagnostics-title"><div className="auto-settings-drawer-section-heading"><span><strong id="auto-diagnostics-title">专业诊断</strong><small>观察当前版本的处理步骤、编排结果和素材理解。</small></span></div>{project && selectedGeneration ? <VersionDetail project={project} generation={selectedGeneration} onCancel={(generation) => void cancelGeneration(generation)} onResume={(generation) => void resumeGeneration(generation)} cancelling={cancellingGenerationId === selectedGeneration.generationId} diagnosticsOnly /> : <div className="auto-settings-diagnostics-empty"><strong>暂无可观察版本</strong><span>创建并运行一个版本后，这里会显示现有处理详情。</span></div>}</section>
            <section className="auto-settings-drawer-section auto-settings-shutdown" aria-labelledby="auto-shutdown-title"><div className="auto-settings-drawer-section-heading"><span><strong id="auto-shutdown-title">程序</strong><small>停止本项目占用的端口、模型、网关和 Docker 服务。</small></span></div><button type="button" className="auto-shutdown-button" disabled={closingProgram} onClick={() => void shutdownProgram()}><strong>{closingProgram ? '正在安全关闭…' : '安全关闭程序'}</strong><small>运行中的成片任务会保留检查点，下次启动自动继续。</small></button></section>
          </div>
        </aside>
      </div> : null}

      {composerOpen && project ? <div className="auto-composer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setComposerOpen(false); }}>
        <section className="auto-composer" role="dialog" aria-modal="true" aria-labelledby="generation-composer-title">
          <header><div><span className="auto-eyebrow">新生成版本</span><h2 id="generation-composer-title">创建 V{project.generationCount + 1}</h2><p>使用设置中的当前编排配置，并创建独立版本快照。</p></div><button type="button" onClick={() => setComposerOpen(false)} aria-label="关闭">×</button></header>
          <label>本次编排要求<textarea value={generationInstruction} maxLength={2_000} onChange={(event) => setGenerationInstruction(event.target.value)} placeholder="例如：强调开场节奏，并将结果镜头放在结尾" /></label>
          <p className="auto-composer-settings-note">处理方式、画面理解并发、转文字模型、模型和推理强度均在“设置”中管理。</p>
          <footer><button type="button" className="auto-secondary" onClick={() => setComposerOpen(false)}>取消</button>{connectionStatus?.mode === 'blocked' && generationMode === 'ai' ? <button type="button" className="auto-primary" onClick={openSettings}>检查设置</button> : <button type="button" className="auto-primary" disabled={starting || (generationMode === 'ai' && (Boolean(activatingTranscriptionProviderId) || transcriptionProviders?.switching || transcriptionProviders?.activeProviderId !== transcriptionProviderId))} onClick={() => void startGeneration()}>{starting ? '正在创建…' : generationMode === 'local' ? '按上传顺序合成' : '开始智能编排'}</button>}</footer>
        </section>
      </div> : null}
      {keyManagerOpen ? <Suspense fallback={null}><KeyManager context={protocolTesterContext} onClose={() => setKeyManagerOpen(false)} onActiveKeyChange={refreshConnection} /></Suspense> : null}
      {modelLogOpen ? <Suspense fallback={null}><ModelConversationLog currentProjectId={project?.id} currentGenerationId={selectedGeneration?.generationId} onClose={() => setModelLogOpen(false)} /></Suspense> : null}
    </div>
  );
}
