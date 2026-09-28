import {useEffect, useState, type ChangeEvent, type DragEvent, type FormEvent} from 'react';
import type {EnvelopeContext, RelayKeySummary, RelayProtocolTestResult} from '../../shared/contracts';
import {listRelayKeys, testRelayProtocol} from '../api';
import {ShieldIcon, SparkIcon, UploadIcon} from './Icons';

type RelayProtocolTesterProps = {
  context: EnvelopeContext;
  onClose: () => void;
};

const supportedAccept = 'image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm';
const defaultPrompt = '请描述你实际看到的图片或视频画面；如果没有附件，请回复 pong。';

const formatBytes = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : `${Math.max(1, Math.ceil(bytes / 1024))} KiB`;

export function RelayProtocolTester({context, onClose}: RelayProtocolTesterProps) {
  const [keys, setKeys] = useState<RelayKeySummary[]>([]);
  const [selectedKeyId, setSelectedKeyId] = useState('');
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [files, setFiles] = useState<File[]>([]);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [loadingKeys, setLoadingKeys] = useState(true);
  const [sending, setSending] = useState(false);
  const [sendingElapsedMs, setSendingElapsedMs] = useState(0);
  const [error, setError] = useState('');
  const [result, setResult] = useState<RelayProtocolTestResult>();

  useEffect(() => {
    let active = true;
    void listRelayKeys(context).then((nextKeys) => {
      if (!active) return;
      setKeys(nextKeys);
      setSelectedKeyId(nextKeys.find((key) => key.active)?.keyId ?? nextKeys[0]?.keyId ?? '');
    }).catch((caught: unknown) => {
      if (active) setError(caught instanceof Error ? caught.message : '读取 Key 失败。');
    }).finally(() => {
      if (active) setLoadingKeys(false);
    });
    return () => {active = false;};
  }, [context]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !sending) onClose(); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose, sending]);

  useEffect(() => {
    if (!sending) {
      setSendingElapsedMs(0);
      return;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => setSendingElapsedMs(Date.now() - startedAt), 250);
    return () => window.clearInterval(timer);
  }, [sending]);

  const updateFiles = (nextFiles: File[]) => {
    if (nextFiles.length > 10) { setError('单次最多选择 10 个图片或视频文件。'); return; }
    setFiles(nextFiles);
    setError('');
    setResult(undefined);
  };

  const selectFiles = (event: ChangeEvent<HTMLInputElement>) => {
    updateFiles(Array.from(event.target.files ?? []));
    event.target.value = '';
  };

  const handleDragEnter = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    if (!sending) setDraggingFiles(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    if (!event.currentTarget.contains(event.relatedTarget as Node)) setDraggingFiles(false);
  };

  const handleDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDraggingFiles(false);
    if (!sending) updateFiles(Array.from(event.dataTransfer.files));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (sending) return;
    if (!selectedKeyId) { setError('请先在 Key 管理中添加可用 Key。'); return; }
    if (!prompt.trim()) { setError('请先输入测试消息。'); return; }
    setSending(true);
    setError('');
    setResult(undefined);
    try {
      setResult(await testRelayProtocol(selectedKeyId, prompt, files, context));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '通信测试失败。');
    } finally {
      setSending(false);
    }
  };

  const selectedKey = keys.find((key) => key.keyId === selectedKeyId);

  return (
    <div className="protocol-test-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !sending) onClose(); }}>
      <section className="protocol-test-dialog" role="dialog" aria-modal="true" aria-labelledby="protocol-test-title">
        <header>
          <div><span className="protocol-test-icon"><SparkIcon /></span><span><h2 id="protocol-test-title">通信测试</h2><p>按 Responses / SSE 协议发送真实的文字与多模态输入。</p></span></div>
          <button type="button" className="key-dialog-close" onClick={onClose} disabled={sending} aria-label="关闭通信测试">×</button>
        </header>

        <div className="protocol-test-security"><ShieldIcon /><span>浏览器只上传所选文件到本机服务端；图片以 data URL 作为 <code>input_image</code> 发送，MP4/WebM 在本机抽取 3 张关键帧后以 <code>input_image</code> 发送，原视频不会进入中转站。</span></div>

        <form className="protocol-test-form" onSubmit={(event) => void submit(event)}>
          <label className="protocol-test-field">
            <span>使用 Key</span>
            <select value={selectedKeyId} onChange={(event) => { setSelectedKeyId(event.target.value); setResult(undefined); }} disabled={loadingKeys || sending || !keys.length}>
              {!keys.length ? <option value="">{loadingKeys ? '正在读取 Key…' : '没有可用 Key'}</option> : keys.map((key) => <option key={key.keyId} value={key.keyId}>{key.active ? '● ' : ''}{key.name} · {key.model}</option>)}
            </select>
            {selectedKey ? <small>{selectedKey.baseUrl}</small> : null}
          </label>

          <label className="protocol-test-field">
            <span>测试消息</span>
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={8_000} rows={4} disabled={sending} placeholder="输入文字；可搭配图片或视频测试视觉输入" />
            <small>{prompt.length.toLocaleString('zh-CN')} / 8,000</small>
          </label>

          <div className="protocol-test-field">
            <span>图片或视频</span>
            <label className={`protocol-upload-zone${draggingFiles ? ' is-dragging' : ''}`} onDragEnter={handleDragEnter} onDragOver={handleDragEnter} onDragLeave={handleDragLeave} onDrop={handleDrop}>
              <input type="file" accept={supportedAccept} multiple onChange={selectFiles} disabled={sending} />
              <UploadIcon /><strong>{draggingFiles ? '松开以上传文件' : files.length ? `已选择 ${files.length} 个文件` : '点击或拖拽图片、视频到这里'}</strong><small>JPEG / PNG / WebP / GIF / MP4 / WebM</small>
            </label>
            <div className="protocol-upload-note">图片与视频关键帧合计最多 10 张；图片单张 ≤ 15 MiB、合计 ≤ 60 MiB。每个视频本机抽取 3 张关键帧；视频单个及本次合计均 ≤ 250 MiB。</div>
            {files.length ? <ul className="protocol-file-list">{files.map((file) => <li key={`${file.name}:${file.lastModified}:${file.size}`}><span>{file.type.startsWith('video/') ? '视频' : '图片'}</span><strong title={file.name}>{file.name}</strong><small>{formatBytes(file.size)}</small></li>)}</ul> : null}
          </div>

          {error ? <div className="protocol-test-error" role="alert">{error}</div> : null}
          {result ? <section className="protocol-test-result" aria-live="polite"><div><strong>已收到 <code>response.completed</code></strong><span>{result.model} · {result.latencyMs.toLocaleString('zh-CN')} ms · 视觉输入 {result.inputImageCount} 张（图片 {result.uploadedImageCount} · 视频 {result.uploadedVideoCount}）</span></div><p>{result.reply}</p></section> : null}

          <footer><span>请求：<code>POST /v1/responses</code> · <code>stream: true</code> · <code>store: false</code></span><button className="protocol-test-send" type="submit" disabled={sending || loadingKeys || !selectedKeyId || !prompt.trim()}><SparkIcon />{sending ? '正在等待 SSE 完成…' : '发送通信测试'}</button></footer>
          {sending ? <div className="protocol-test-progress" role="status" aria-live="polite">
            <div><strong>正在接收中转站 SSE</strong><span>{(sendingElapsedMs / 1_000).toFixed(1)}s</span></div>
            <p>程序正在逐块读取响应；首字节上限 120s，分块空闲上限 30s，总时长上限 180s。</p>
            <div className="protocol-test-progress-track" role="progressbar" aria-label="SSE 接收耗时" aria-valuemin={0} aria-valuemax={180_000} aria-valuenow={Math.min(180_000, sendingElapsedMs)}><i style={{width: `${Math.min(100, sendingElapsedMs / 1_800)}%`}} /></div>
          </div> : null}
        </form>
      </section>
    </div>
  );
}
