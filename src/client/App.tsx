import {lazy, Suspense, useEffect, useMemo, useState} from 'react';
import type {AssetRef, Envelope, ProjectInput, RelayKeySummary, RenderJob} from '../shared/contracts';
import {cancelJob, createClientContext, createJob, getJob, getJobEvents, listJobs, listRelayKeys, retryJob, shutdownApp, uploadAssets} from './api';
import {AssetWorkbench} from './components/AssetWorkbench';
import {ChevronIcon, ShieldIcon, SparkIcon} from './components/Icons';
import {KeyManager} from './components/KeyManager';
import {PipelineProgress} from './components/PipelinePanel';
import {ProjectForm} from './components/ProjectForm';
import {RelayProtocolTester} from './components/RelayProtocolTester';

const ResultPanel = lazy(() => import('./components/ResultPanel'));

const initialForm: Omit<ProjectInput, 'projectId' | 'assetIds'> = {
  storeName: '蓝鲸精洗',
  region: '上海浦东',
  offer: '49元6次洗车卡',
  rules: '到店核销，每车限购1张，有效期30天',
  cta: '现在下单，到店即洗',
  durationMs: 30_000,
  tone: 'direct',
  allowLibrary: false,
};

const terminalStages = new Set(['completed', 'failed', 'cancelled', 'awaiting_review']);

export default function App() {
  const [transportContext, setTransportContext] = useState(() => createClientContext());
  const [form, setForm] = useState(initialForm);
  const [assets, setAssets] = useState<AssetRef[]>([]);
  const [job, setJob] = useState<RenderJob>();
  const [history, setHistory] = useState<RenderJob[]>([]);
  const [transportEvents, setTransportEvents] = useState<Envelope[]>([]);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [keyManagerOpen, setKeyManagerOpen] = useState(false);
  const [protocolTesterOpen, setProtocolTesterOpen] = useState(false);
  const [activeRelayKey, setActiveRelayKey] = useState<RelayKeySummary>();
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState('');
  const running = job && !terminalStages.has(job.status);

  useEffect(() => {
    void Promise.allSettled([listJobs(transportContext), listRelayKeys(transportContext)]).then(([jobsResult, keysResult]) => {
      if (jobsResult.status === 'fulfilled') {
        setHistory(jobsResult.value);
        const activeId = window.localStorage.getItem('washcut.activeJobId');
        const active = jobsResult.value.find((candidate) => candidate.jobId === activeId && !terminalStages.has(candidate.status));
        if (active) setJob(active);
      }
      if (keysResult.status === 'fulfilled') setActiveRelayKey(keysResult.value.find((key) => key.active));
    });
  }, [transportContext]);

  useEffect(() => {
    if (!running || !job) return;
    let cancelled = false;
    let delay = 800;
    let timer = 0;
    const poll = async () => {
      try {
        const next = await getJob(job.jobId, transportContext);
        if (cancelled) return;
        setJob(next);
        setHistory((current) => [next, ...current.filter((item) => item.jobId !== next.jobId)]);
        delay = next.progress < 75 ? 1000 : 1800;
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : '任务查询失败');
        delay = Math.min(delay * 2, 8000);
      }
      if (!cancelled) timer = window.setTimeout(poll, delay);
    };
    timer = window.setTimeout(poll, delay);
    return () => {cancelled = true; window.clearTimeout(timer);};
  }, [job?.jobId, running, transportContext]);

  useEffect(() => {
    if (!job) return;
    if (terminalStages.has(job.status)) window.localStorage.removeItem('washcut.activeJobId');
    else window.localStorage.setItem('washcut.activeJobId', job.jobId);
    if (job.status !== 'completed') return;
    void getJobEvents(job.jobId, transportContext).then(setTransportEvents).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : '事件查询失败'));
  }, [job?.jobId, job?.status, transportContext]);

  const canSubmit = useMemo(() => assets.length > 0 && assets.every((asset) => asset.status === 'ready') && Object.values({
    storeName: form.storeName, region: form.region, offer: form.offer, rules: form.rules, cta: form.cta,
  }).every((value) => value.trim().length >= 2), [assets, form]);

  const handleUpload = async (files: File[]) => {
    setUploading(true); setError('');
    try {
      const uploaded = await uploadAssets(files, transportContext);
      setAssets((current) => [...current, ...uploaded]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally { setUploading(false); }
  };

  const handleGenerate = async () => {
    if (!canSubmit || submitting) return;
    setSubmitting(true); setError('');
    try {
      const nextJob = await createJob({...form, projectId: transportContext.projectId, assetIds: assets.map((asset) => asset.assetId)}, transportContext);
      setJob(nextJob);
      setHistory((current) => [nextJob, ...current]);
      window.localStorage.setItem('washcut.activeJobId', nextJob.jobId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '创建任务失败');
    } finally { setSubmitting(false); }
  };

  const handleCancel = async () => {
    if (!job) return;
    await cancelJob(job.jobId, transportContext);
  };

  const handleRetry = async () => {
    if (!job) return;
    setError('');
    await retryJob(job.jobId, transportContext);
    const next = await getJob(job.jobId, transportContext);
    setJob(next);
  };

  const handleShutdown = async () => {
    const message = running
      ? '当前任务正在运行，关闭程序会中断它。任务可在下次启动后恢复。确定关闭吗？'
      : '确定关闭洗车片场吗？';
    if (!window.confirm(message)) return;
    setClosing(true);
    setError('');
    try {
      await shutdownApp(transportContext);
    } catch (caught) {
      setClosing(false);
      setError(caught instanceof Error ? caught.message : '关闭程序失败');
    }
  };

  const openHistoryJob = async (selected: RenderJob) => {
    setError('');
    const latest = await getJob(selected.jobId, transportContext);
    setJob(latest);
    if (latest.status === 'completed') setTransportEvents(await getJobEvents(latest.jobId, transportContext));
    window.scrollTo({top: document.getElementById('progress')?.offsetTop ?? 0, behavior: 'smooth'});
  };

  const reset = () => {
    setJob(undefined); setTransportEvents([]); setAssets([]); setError(''); setTransportContext(createClientContext());
    window.localStorage.removeItem('washcut.activeJobId'); window.scrollTo({top: 0, behavior: 'smooth'});
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="洗车片场首页"><span className="brand-mark"><i/><i/><i/></span>洗车片场</a>
        <nav aria-label="主导航"><a className="active" href="#top">新建项目</a><a href="#history">项目记录</a><a href="#assets">授权素材库</a></nav>
        <div className="topbar-actions">
          <button className="key-manager-trigger" type="button" onClick={() => setKeyManagerOpen(true)}><ShieldIcon />Key 管理</button>
          <div className={`system-status${activeRelayKey ? ' relay' : ''}`}><i />{activeRelayKey ? activeRelayKey.name : '本地生产链'} <span>{activeRelayKey ? activeRelayKey.model : 'SQLite + Worker'}</span></div>
          <button className="shutdown-button" type="button" onClick={() => void handleShutdown()} disabled={closing}>{closing ? '正在关闭…' : '关闭程序'}</button>
        </div>
      </header>

      <main id="top">
        <div className="workspace">
          <AssetWorkbench assets={assets} uploading={uploading} onUpload={handleUpload} onRemove={(assetId) => setAssets((current) => current.filter((asset) => asset.assetId !== assetId))} />
          <ProjectForm value={form} onChange={setForm} />
        </div>

        <section className="action-rail">
          <div className="workflow-signature">
            {['素材探测', '事实确认', 'Agent 编导', '真实出片'].map((label, index) => <div key={label} className={index < 2 || running || job?.status === 'completed' ? 'reached' : ''}><span>{index + 1}</span><strong>{label}</strong>{index < 3 ? <ChevronIcon /> : null}</div>)}
          </div>
          <div className="truth-note"><ShieldIcon /><span><strong>素材只走签名媒体链路，模型不能伪造资产</strong><small>上传后自动校验、探测、代理转码、抽帧并绑定当前项目</small></span></div>
          <div className="action-buttons">
            {running ? <button className="cancel-button" type="button" onClick={handleCancel}>取消</button> : null}
            <button className="generate-button" type="button" disabled={!canSubmit || Boolean(running) || submitting} onClick={handleGenerate}><SparkIcon />{running ? 'Worker 正在制作' : submitting ? '正在创建任务' : '生成真实营销视频'}<small>{running ? `${job.progress}% · 可刷新恢复` : '输出 MP4 / 封面 / SRT / 来源清单'}</small></button>
          </div>
        </section>

        {error ? <pre className="error-banner" role="alert">{error}</pre> : null}
        <div id="progress"><PipelineProgress job={job} /></div>
        {job?.status === 'failed' ? <section className="failure-panel"><h2>任务停在“{job.error?.stage}”阶段</h2><p>{job.error?.message}</p><button type="button" className="secondary-button" onClick={handleRetry}>从检查点重试</button></section> : null}
        {job?.status === 'cancelled' ? <section className="failure-panel"><h2>任务已安全取消</h2><p>规格和已完成阶段保留在 SQLite，可在项目记录中查看。</p><button type="button" className="secondary-button" onClick={reset}>新建项目</button></section> : null}
        {job?.status === 'completed' ? <Suspense fallback={<div className="result-loading">正在载入成片预览…</div>}><ResultPanel job={job} events={transportEvents} context={transportContext} onJobChange={setJob} onReset={reset} /></Suspense> : null}

        <section className="project-history" id="history" aria-labelledby="history-title">
          <div className="pipeline-title"><h2 id="history-title">项目记录</h2><span>任务重启后仍可恢复</span></div>
          {history.length ? <div className="history-grid">{history.map((item) => (
            <button type="button" className="history-card" key={item.jobId} onClick={() => void openHistoryJob(item)}>
              <span>{new Date(item.updatedAt).toLocaleString('zh-CN')}</span>
              <strong>{item.input.storeName} · {item.input.offer}</strong>
              <small>{item.status} · {item.progress}% · 第 {item.attempt} 次</small>
            </button>
          ))}</div> : <div className="history-empty">完成首条视频后，项目版本、状态和产物会保存在这里。</div>}
        </section>
      </main>
      <button className="communication-test-trigger" type="button" onClick={() => setProtocolTesterOpen(true)} aria-label="打开通信测试"><SparkIcon /><span>通信<br />测试</span></button>
      {keyManagerOpen ? <KeyManager context={transportContext} onClose={() => setKeyManagerOpen(false)} onActiveKeyChange={setActiveRelayKey} /> : null}
      {protocolTesterOpen ? <RelayProtocolTester context={transportContext} onClose={() => setProtocolTesterOpen(false)} /> : null}
      <footer><span>洗车片场 Agent</span><span>真实媒体 · 断点恢复 · 租户隔离 · 产物追溯</span></footer>
    </div>
  );
}
