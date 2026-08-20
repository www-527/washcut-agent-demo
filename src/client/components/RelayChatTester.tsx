import {useEffect, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent, type KeyboardEvent} from 'react';
import type {EnvelopeContext, RelayChatMessage, RelayKeySummary} from '../../shared/contracts';
import {chatWithRelayKey} from '../api';
import {AttachmentIcon, ShieldIcon, SparkIcon} from './Icons';

type ChatAttachment = {
  id: string;
  file: File;
  previewUrl: string;
};

type DisplayMessage = RelayChatMessage & {id: string; attachments?: ChatAttachment[]};

type RelayChatTesterProps = {
  relayKey: RelayKeySummary;
  context: EnvelopeContext;
  onClose: () => void;
};

const starters = ['请回复 pong', '用一句话介绍你自己', '你当前使用的模型是什么？'];
const imageAccept = 'image/jpeg,image/png,image/webp,image/gif';
const maxImageCount = 10;
const maxImageBytes = 15 * 1024 * 1024;
const maxTotalImageBytes = 60 * 1024 * 1024;
const supportedImageTypes = new Set(imageAccept.split(','));
const formatBytes = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : `${Math.max(1, Math.ceil(bytes / 1024))} KiB`;
const sameFile = (left: File, right: File) => left.name === right.name && left.size === right.size && left.lastModified === right.lastModified;

export function RelayChatTester({relayKey, context, onClose}: RelayChatTesterProps) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [images, setImages] = useState<ChatAttachment[]>([]);
  const [draggingImages, setDraggingImages] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [lastLatency, setLastLatency] = useState<number>();
  const objectUrls = useRef(new Set<string>());

  const releaseAttachments = (attachments: ChatAttachment[]) => {
    attachments.forEach((attachment) => {
      if (!objectUrls.current.delete(attachment.previewUrl)) return;
      URL.revokeObjectURL(attachment.previewUrl);
    });
  };

  useEffect(() => () => {
    objectUrls.current.forEach((previewUrl) => URL.revokeObjectURL(previewUrl));
    objectUrls.current.clear();
  }, []);

  const sendMessage = async (text: string, selectedImages = images) => {
    const content = text.trim();
    if (!content || sending) return;
    const userMessage: DisplayMessage = {id: crypto.randomUUID(), role: 'user', content, ...(selectedImages.length ? {attachments: selectedImages} : {})};
    const requestMessages = [...messages, userMessage].slice(-12).map(({role, content: messageContent}) => ({role, content: messageContent}));
    setMessages((current) => [...current, userMessage].slice(-24));
    setDraft('');
    setImages([]);
    setSending(true);
    setError('');
    try {
      const result = await chatWithRelayKey(relayKey.keyId, requestMessages, selectedImages.map((image) => image.file), context);
      const assistantMessage: DisplayMessage = {id: crypto.randomUUID(), role: 'assistant', content: result.reply};
      setMessages((current) => [...current, assistantMessage].slice(-24));
      setLastLatency(result.latencyMs);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '模型对话失败。');
    } finally {
      setSending(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void sendMessage(draft);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendMessage(draft);
    }
  };

  const addImages = (nextImages: File[]) => {
    if (!nextImages.length) return;
    const currentFiles = images.map((image) => image.file);
    const combined = [...currentFiles, ...nextImages].filter((image, index, all) => all.findIndex((candidate) => sameFile(candidate, image)) === index);
    if (combined.length > maxImageCount) { setError('单次最多选择 10 张图片。'); return; }
    if (combined.some((image) => !supportedImageTypes.has(image.type))) { setError('仅支持 JPEG、PNG、WebP、GIF 图片。'); return; }
    if (combined.some((image) => image.size > maxImageBytes)) { setError('单张图片不能超过 15 MiB。'); return; }
    if (combined.reduce((total, image) => total + image.size, 0) > maxTotalImageBytes) { setError('本次图片合计不能超过 60 MiB。'); return; }
    const appendedFiles = combined.filter((candidate) => !currentFiles.some((current) => sameFile(current, candidate)));
    const attachments = appendedFiles.map((file) => {
      const previewUrl = URL.createObjectURL(file);
      objectUrls.current.add(previewUrl);
      return {id: crypto.randomUUID(), file, previewUrl};
    });
    setImages((current) => [...current, ...attachments]);
    setError('');
  };

  const removeImage = (attachment: ChatAttachment) => {
    releaseAttachments([attachment]);
    setImages((current) => current.filter((candidate) => candidate.id !== attachment.id));
  };

  const clearConversation = () => {
    releaseAttachments(images);
    messages.forEach((message) => releaseAttachments(message.attachments ?? []));
    setImages([]);
    setMessages([]);
    setError('');
    setLastLatency(undefined);
  };

  const close = () => {
    clearConversation();
    onClose();
  };

  const chooseImages = (event: ChangeEvent<HTMLInputElement>) => {
    addImages(Array.from(event.target.files ?? []));
    event.target.value = '';
  };

  const handleDragEnter = (event: DragEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!sending) setDraggingImages(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!event.currentTarget.contains(event.relatedTarget as Node)) setDraggingImages(false);
  };

  const handleDrop = (event: DragEvent<HTMLFormElement>) => {
    event.preventDefault();
    setDraggingImages(false);
    if (!sending) addImages(Array.from(event.dataTransfer.files));
  };

  return (
    <div className="key-chat-backdrop" role="presentation">
      <section className="key-chat-dialog" role="dialog" aria-modal="true" aria-labelledby="key-chat-title">
        <header>
          <div><span className="key-chat-icon"><SparkIcon /></span><span><h2 id="key-chat-title">模型对话测试</h2><p>{relayKey.name} · {relayKey.model}</p></span></div>
          <button type="button" className="key-dialog-close" onClick={close} aria-label="关闭对话测试">×</button>
        </header>

        <div className="key-chat-security"><ShieldIcon /><span>消息和所选图片由本程序服务端转发，API Key 不会发送到浏览器。每次请求最多携带最近 12 条消息；图片只随当前消息发送。</span></div>

        <div className="key-chat-messages" role="log" aria-live="polite" aria-label="对话消息">
          {!messages.length ? <div className="key-chat-empty"><SparkIcon /><strong>开始一次真实模型对话</strong><span>选择示例问题，或在下方输入内容。</span><div>{starters.map((starter) => <button type="button" key={starter} disabled={sending} onClick={() => void sendMessage(starter)}>{starter}</button>)}</div></div> : messages.map((message) => (
            <article className={`key-chat-message ${message.role}`} key={message.id}>
              <span>{message.role === 'user' ? '你' : relayKey.model}</span>
              <p>{message.content}</p>
              {message.attachments?.length ? <ul className="key-chat-message-images" aria-label="随消息发送的图片">{message.attachments.map((attachment) => <li key={attachment.id}><img src={attachment.previewUrl} alt={attachment.file.name} /><span>{attachment.file.name}</span></li>)}</ul> : null}
            </article>
          ))}
          {sending ? <article className="key-chat-message assistant pending"><span>{relayKey.model}</span><p><i/><i/><i/></p></article> : null}
        </div>

        {error ? <div className="key-chat-error" role="alert">{error}</div> : null}
        <form className={`key-chat-composer${draggingImages ? ' is-dragging' : ''}`} onSubmit={submit} onDragEnter={handleDragEnter} onDragOver={handleDragEnter} onDragLeave={handleDragLeave} onDrop={handleDrop}>
          {images.length ? <ul className="key-chat-image-list" aria-label="待发送图片">{images.map((attachment) => <li key={attachment.id}><img src={attachment.previewUrl} alt="" /><span title={attachment.file.name}>{attachment.file.name}<small>{formatBytes(attachment.file.size)}</small></span><button type="button" disabled={sending} onClick={() => removeImage(attachment)} aria-label={`移除图片 ${attachment.file.name}`}>×</button></li>)}</ul> : null}
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={handleKeyDown} maxLength={8_000} rows={2} placeholder="给模型发送消息…" aria-label="测试消息" />
          <div><span className="key-chat-composer-note">{draggingImages ? '松开即可添加图片' : '也可直接将图片拖放到此处'}</span><span className="key-chat-actions">{messages.length ? <button type="button" disabled={sending} onClick={clearConversation}>清空</button> : null}<label className="key-chat-attach-button"><AttachmentIcon />添加图片<input type="file" accept={imageAccept} multiple onChange={chooseImages} disabled={sending} /></label><button className="key-chat-send" type="submit" disabled={sending || !draft.trim()}><SparkIcon />{sending ? '等待回复' : '发送'}</button></span></div>
        </form>
      </section>
    </div>
  );
}
