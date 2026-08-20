import type {JobStage, RenderJob} from '../../shared/contracts';
import {STAGE_LABELS} from '../../shared/contracts';
import {CheckIcon} from './Icons';

const stages: JobStage[] = ['asset_analysis', 'creative_direction', 'visual_direction', 'audio_production', 'rendering', 'quality_check'];
const stageIndex = (stage: JobStage) => stage === 'completed' ? stages.length : stages.indexOf(stage);

export const PipelineProgress = ({job}: {job?: RenderJob}) => {
  const current = job ? stageIndex(job.status) : -1;
  return (
    <section className="pipeline-progress" aria-label="Agent 处理进度">
      <div className="pipeline-title"><h2>Agent 生产线</h2><span>{job ? `${job.mode === 'local' ? '本地真实媒体 Worker' : '视觉模型中转站'} · ${job.progress}%` : '等待启动'}</span></div>
      <div className="stage-track">
        {stages.map((stage, index) => {
          const done = current > index;
          const active = current === index;
          return (
            <div className={`stage ${done ? 'done' : ''} ${active ? 'active' : ''}`} key={stage}>
              <div className="stage-node">{done ? <CheckIcon /> : index + 1}</div>
              <div><strong>{STAGE_LABELS[stage].title}</strong><small>{STAGE_LABELS[stage].detail}</small></div>
              {index < stages.length - 1 ? <i className="stage-line" /> : null}
            </div>
          );
        })}
      </div>
    </section>
  );
};
