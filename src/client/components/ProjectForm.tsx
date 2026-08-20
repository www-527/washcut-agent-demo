import type {ProjectInput} from '../../shared/contracts';

type EditableProject = Omit<ProjectInput, 'projectId' | 'assetIds'>;
type Props = {value: EditableProject; onChange: (value: EditableProject) => void};

const durations: EditableProject['durationMs'][] = [15_000, 30_000, 45_000, 60_000, 90_000, 120_000, 180_000];

export const ProjectForm = ({value, onChange}: Props) => {
  const set = <K extends keyof EditableProject>(key: K, next: EditableProject[K]) => onChange({...value, [key]: next});
  return (
    <aside className="project-form" aria-label="门店与视频信息">
      <section>
        <h2>门店与活动</h2>
        <label><span>门店名称 <b>*</b></span><input value={value.storeName} onChange={(e) => set('storeName', e.target.value)} maxLength={40} /></label>
        <label><span>城市区域 <b>*</b></span><input value={value.region} onChange={(e) => set('region', e.target.value)} maxLength={40} /></label>
        <label><span>优惠内容 <b>*</b></span><textarea className="offer-field" value={value.offer} onChange={(e) => set('offer', e.target.value)} maxLength={80} /><small>{value.offer.length}/80</small></label>
        <label><span>使用规则 <b>*</b></span><textarea value={value.rules} onChange={(e) => set('rules', e.target.value)} maxLength={160} /><small>{value.rules.length}/160</small></label>
        <label><span>行动引导 <b>*</b></span><input value={value.cta} onChange={(e) => set('cta', e.target.value)} maxLength={60} /></label>
      </section>
      <section>
        <h2>视频目标</h2>
        <div className="form-row">
          <span className="row-label">视频时长 <b>*</b></span>
          <div className="duration-options">
            {durations.map((duration) => <button key={duration} type="button" className={value.durationMs === duration ? 'selected' : ''} onClick={() => set('durationMs', duration)}>{duration / 1000}秒</button>)}
          </div>
        </div>
        <label><span>视频风格 <b>*</b></span><select value={value.tone} onChange={(e) => set('tone', e.target.value as EditableProject['tone'])}><option value="direct">促销直接</option><option value="real">真实探店</option><option value="professional">专业服务</option><option value="relaxed">轻松车主口吻</option></select></label>
      </section>
      <section className="library-permission">
        <div><h2>允许使用已授权通用素材</h2><p>仅在真实素材不足时补充无品牌通用镜头，并记录来源。</p></div>
        <button type="button" role="switch" aria-checked={value.allowLibrary} className={`switch ${value.allowLibrary ? 'on' : ''}`} onClick={() => set('allowLibrary', !value.allowLibrary)}><i /></button>
      </section>
    </aside>
  );
};
