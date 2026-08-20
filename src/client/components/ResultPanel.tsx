import {Player} from '@remotion/player';
import {useState} from 'react';
import {makeEnvelope, type Envelope, type EnvelopeContext, type RenderJob} from '../../shared/contracts';
import {WashcutVideo} from '../../remotion/WashcutVideo';
import {reviewJob} from '../api';
import {BracketsIcon, CheckIcon, PlayIcon} from './Icons';

const JsonBlock = ({title, value}: {title: string; value: unknown}) => (
  <details className="json-block"><summary><BracketsIcon />{title}<span>JSON</span></summary><pre>{JSON.stringify(value, null, 2)}</pre></details>
);

const artifactLabels = {video: '下载 MP4', cover: '下载封面', captions: '下载 SRT', provenance: '下载来源清单'} as const;

export default function ResultPanel({job, events, context, onJobChange, onReset}: {
  job: RenderJob;
  events: Envelope[];
  context: EnvelopeContext;
  onJobChange: (job: RenderJob) => void;
  onReset: () => void;
}) {
  const [reviewReason, setReviewReason] = useState('');
  const [reviewing, setReviewing] = useState(false);
  if (!job.videoSpec || !job.qualityReport) return null;
  const renderMessage = makeEnvelope({
    type: 'render.requested', eventId: `evt_render_${job.jobId}`, occurredAt: job.updatedAt, traceId: job.traceId,
    tenantId: job.tenantId, projectId: job.projectId, jobId: job.jobId, producer: 'web-app',
    idempotencyKey: `${job.jobId}:preview:${job.videoSpec.version}`, schema: 'video-spec.v1', data: job.videoSpec,
  });
  const submitReview = async (status: 'approved' | 'returned') => {
    setReviewing(true);
    try { onJobChange(await reviewJob(job.jobId, status, reviewReason, context)); }
    finally { setReviewing(false); }
  };
  return (
    <section className="result-panel" aria-labelledby="result-title">
      <div className="result-copy">
        <span className="result-status"><CheckIcon /> 最终媒体已通过全部阻断质检</span>
        <h2 id="result-title">真实 MP4 已生成，可下载、校验和追溯</h2>
        <p>右侧预览与下载文件使用同一份 VideoSpec。每个镜头绑定服务端解析的 assetId，语音、字幕、BGM、封面和来源清单均由媒体 Worker 生成。</p>
        <div className="artifact-actions">
          {job.artifacts.map((artifact) => <a key={artifact.artifactId} href={artifact.downloadUrl} download>{artifactLabels[artifact.kind]}<small>{(artifact.sizeBytes / 1024 / 1024).toFixed(2)} MB · {artifact.sha256.slice(0, 10)}</small></a>)}
        </div>
        <div className="qa-list">
          {job.qualityReport.checks.map((check) => <div key={check.key}><CheckIcon /><span><strong>{check.label}</strong><small>{check.detail}</small></span></div>)}
        </div>
        <div className="review-box">
          <strong>人工复核：{job.review?.status === 'approved' ? '已通过' : job.review?.status === 'returned' ? '已退回' : '待确认'}</strong>
          <input value={reviewReason} onChange={(event) => setReviewReason(event.target.value)} placeholder="可选：记录通过或退回原因" />
          <div><button type="button" disabled={reviewing} onClick={() => void submitReview('approved')}>通过</button><button type="button" disabled={reviewing} onClick={() => void submitReview('returned')}>退回</button></div>
        </div>
        <div className="spec-list">
          <JsonBlock title="AssetManifest" value={job.assetManifest} />
          <JsonBlock title="CreativeSpec" value={job.creativeSpec} />
          <JsonBlock title="VideoSpec" value={job.videoSpec} />
          <JsonBlock title="QualityReport" value={job.qualityReport} />
          <JsonBlock title={`Transport Envelopes (${events.length})`} value={events} />
        </div>
        <button className="secondary-button" type="button" onClick={onReset}>再建一个项目</button>
      </div>
      <div className="video-preview">
        <div className="phone-frame">
          <Player
            acknowledgeRemotionLicense
            component={WashcutVideo}
            inputProps={{message: renderMessage}}
            durationInFrames={Math.round(job.videoSpec.durationMs / 1000 * job.videoSpec.fps)}
            compositionWidth={job.videoSpec.width}
            compositionHeight={job.videoSpec.height}
            fps={job.videoSpec.fps}
            controls
            loop
            style={{width: '100%', aspectRatio: '9 / 16'}}
          />
        </div>
        <div className="preview-meta"><PlayIcon /><span><strong>{job.videoSpec.durationMs / 1000} 秒 · 1080×1920</strong><small>真实素材与混合音轨预览</small></span></div>
      </div>
    </section>
  );
}
