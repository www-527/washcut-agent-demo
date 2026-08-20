import {useRef, useState} from 'react';
import type {AssetRef} from '../../shared/contracts';
import {CheckIcon, TrashIcon, UploadIcon} from './Icons';

type Props = {
  assets: AssetRef[];
  uploading: boolean;
  onUpload: (files: File[]) => Promise<void>;
  onRemove: (assetId: string) => void;
};

const demoPositions = ['0% 0%', '100% 0%', '0% 100%', '100% 100%'];

const AssetThumbnail = ({asset, index, onRemove}: {asset: AssetRef; index: number; onRemove: () => void}) => {
  const [failed, setFailed] = useState(false);
  const isDemoSheet = asset.previewUrl?.includes('carwash-contact-sheet');
  const visual = isDemoSheet ? (
    <div className="sheet-thumb" style={{backgroundPosition: demoPositions[index % 4]}} />
  ) : asset.contentType.startsWith('video/') ? (
    <video src={asset.previewUrl} poster={asset.thumbnailUrl} muted onError={() => setFailed(true)} />
  ) : (
    <img src={failed ? '/media/carwash-contact-sheet.png' : asset.previewUrl} alt="" onError={() => setFailed(true)} />
  );
  return (
    <article className="asset-card">
      <div className="asset-visual">
        {visual}
        <span className="duration">{asset.durationMs ? `00:${String(Math.round(asset.durationMs / 1000)).padStart(2, '0')}` : '图片'}</span>
        <button className="remove-asset" type="button" aria-label={`删除 ${asset.fileName}`} onClick={onRemove}><TrashIcon /></button>
      </div>
      <div className="asset-meta">
        <strong title={asset.fileName}>{asset.fileName}</strong>
        <span>{asset.contentType.split('/')[1]?.toUpperCase()} · {(asset.sizeBytes / 1024 / 1024).toFixed(1)}MB</span>
        <em><CheckIcon /> 已探测 {asset.width}×{asset.height}{asset.durationMs ? ` · ${Math.round(asset.durationMs / 1000)}秒` : ''}</em>
      </div>
    </article>
  );
};

export const AssetWorkbench = ({assets, uploading, onUpload, onRemove}: Props) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const openPicker = () => inputRef.current?.click();
  const accept = (list: FileList | null) => {
    if (!list?.length) return;
    void onUpload(Array.from(list));
  };
  return (
    <section className="asset-workbench" id="assets" aria-labelledby="workbench-title">
      <div className="workbench-heading">
        <h1 id="workbench-title">把真实门店，变成一条能投放的视频</h1>
        <p>上传门店实拍，系统会校验文件、读取真实元数据、转代理文件并抽取关键帧。</p>
      </div>
      <button
        className="upload-zone"
        type="button"
        onClick={openPicker}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {event.preventDefault(); accept(event.dataTransfer.files);}}
      >
        <span className="wash-lines" aria-hidden="true"><i/><i/><i/></span>
        <span className="upload-icon"><UploadIcon /></span>
        <strong>{uploading ? '正在探测、转码并抽取关键帧…' : '点击上传或拖拽文件到此处'}</strong>
        <small>支持 JPEG / PNG / WebP / MP4 / WebM；单个文件不超过 250MB</small>
      </button>
      <input ref={inputRef} className="sr-only" type="file" accept="video/*,image/*" multiple onChange={(event) => accept(event.target.files)} />
      <div className="asset-list-heading">
        <h2>已上传素材 <span>({assets.length})</span></h2>
        <span>{assets.length ? '文件已绑定当前租户和项目，客户端不能改写存储位置' : '尚未上传真实素材'}</span>
      </div>
      <div className="asset-grid">
        {assets.map((asset, index) => <AssetThumbnail key={asset.assetId} asset={asset} index={index} onRemove={() => onRemove(asset.assetId)} />)}
      </div>
    </section>
  );
};
