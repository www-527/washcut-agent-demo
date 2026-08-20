import {useEffect, useRef, useState} from 'react';

type OutputPreviewProps = {
  videoUrl: string;
  subtitleUrl?: string;
  durationMs?: number;
};

type PreviewCaption = {
  text: string;
  startMs: number;
  endMs: number;
};

const parseVttTimestamp = (value: string) => {
  const parts = value.trim().split(':');
  if (parts.length !== 3) return undefined;
  const [hours, minutes, secondsAndMillis] = parts;
  const [seconds, millis = '0'] = secondsAndMillis!.split('.');
  const parsed = [hours, minutes, seconds, millis].map(Number);
  if (parsed.some((item) => !Number.isFinite(item))) return undefined;
  return parsed[0]! * 3_600_000 + parsed[1]! * 60_000 + parsed[2]! * 1_000 + Number(millis!.padEnd(3, '0').slice(0, 3));
};

export const parseWebVtt = (source: string): PreviewCaption[] => source
  .replace(/^\uFEFF?WEBVTT[^\n]*\r?\n/, '')
  .split(/\r?\n\s*\r?\n/)
  .flatMap((block) => {
    const lines = block.split(/\r?\n/).filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex < 0) return [];
    const [start, endWithSettings] = lines[timingIndex]!.split('-->');
    const startMs = parseVttTimestamp(start ?? '');
    const endMs = parseVttTimestamp((endWithSettings ?? '').trim().split(/\s+/)[0] ?? '');
    const text = lines.slice(timingIndex + 1).join('\n').trim();
    return startMs !== undefined && endMs !== undefined && startMs < endMs && text
      ? [{startMs, endMs, text}]
      : [];
  });

const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor(total % 3_600 / 60);
  const remaining = total % 60;
  return hours ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}` : `${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`;
};

export const OutputPreview = ({videoUrl, subtitleUrl, durationMs}: OutputPreviewProps) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<HTMLTrackElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const [showSubtitles, setShowSubtitles] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(durationMs ? durationMs / 1_000 : 0);
  const [captions, setCaptions] = useState<PreviewCaption[]>([]);

  useEffect(() => {
    const track = trackRef.current?.track ?? videoRef.current?.textTracks[0];
    if (track) track.mode = 'disabled';
  }, [subtitleUrl]);

  useEffect(() => {
    const updateFullscreenState = () => {
      const documentWithWebkitFullscreen = document as Document & {webkitFullscreenElement?: Element | null};
      const fullscreenElement = document.fullscreenElement ?? documentWithWebkitFullscreen.webkitFullscreenElement;
      setIsFullscreen(fullscreenElement === previewRef.current);
    };
    updateFullscreenState();
    document.addEventListener('fullscreenchange', updateFullscreenState);
    document.addEventListener('webkitfullscreenchange', updateFullscreenState);
    return () => {
      document.removeEventListener('fullscreenchange', updateFullscreenState);
      document.removeEventListener('webkitfullscreenchange', updateFullscreenState);
    };
  }, []);

  useEffect(() => {
    if (!subtitleUrl) {
      setCaptions([]);
      return;
    }
    const controller = new AbortController();
    void fetch(subtitleUrl, {signal: controller.signal})
      .then((response) => response.ok ? response.text() : '')
      .then((source) => { if (!controller.signal.aborted) setCaptions(parseWebVtt(source)); })
      .catch(() => { if (!controller.signal.aborted) setCaptions([]); });
    return () => controller.abort();
  }, [subtitleUrl]);

  const activeCaption = showSubtitles
    ? captions.find((caption) => currentTime * 1_000 >= caption.startMs && currentTime * 1_000 < caption.endMs)
    : undefined;

  const togglePlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play();
    else video.pause();
  };

  const seek = (seconds: number) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(seconds)) return;
    video.currentTime = seconds;
    setCurrentTime(seconds);
  };

  const toggleFullscreen = async () => {
    const container = previewRef.current;
    if (!container) return;
    const documentWithWebkitFullscreen = document as Document & {webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void};
    const containerWithWebkitFullscreen = container as HTMLDivElement & {webkitRequestFullscreen?: () => void};
    if (document.fullscreenElement === container || documentWithWebkitFullscreen.webkitFullscreenElement === container) {
      if (document.exitFullscreen) await document.exitFullscreen();
      else documentWithWebkitFullscreen.webkitExitFullscreen?.();
      return;
    }
    if (container.requestFullscreen) await container.requestFullscreen();
    else containerWithWebkitFullscreen.webkitRequestFullscreen?.();
  };

  return (
    <section className="auto-output-preview" aria-labelledby="auto-output-title">
      <div className="auto-output-copy">
        <span className="auto-eyebrow">成品已生成</span>
        <h2 id="auto-output-title">网页预览字幕与独立 WebVTT</h2>
        <p>字幕会直接叠加显示在此预览画面中；开关不会重新转写、分析、编排或渲染。下载的 MP4 仍保留原始画面，WebVTT 可单独下载。</p>
        <div className="auto-output-actions">
          <button type="button" className={showSubtitles ? 'auto-subtitle-toggle on' : 'auto-subtitle-toggle'} onClick={() => setShowSubtitles((current) => !current)}>
            {showSubtitles ? '字幕：开启' : '字幕：关闭'}
          </button>
          <a href={videoUrl} download>下载 MP4</a>
        </div>
      </div>
      <div ref={previewRef} className="auto-video-wrap" onDoubleClick={() => void toggleFullscreen()}>
        <video
          ref={videoRef}
          preload="metadata"
          onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
          onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={() => setIsPlaying(false)}
        >
          <source src={videoUrl} type="video/mp4" />
          {subtitleUrl ? <track key={subtitleUrl} ref={trackRef} kind="subtitles" src={subtitleUrl} srcLang="zh" label="中文字幕" default /> : null}
          您的浏览器不支持 HTML5 视频播放。
        </video>
        {activeCaption ? <div className="auto-preview-caption" aria-live="polite">{activeCaption.text}</div> : null}
        <div className="auto-video-controls" onDoubleClick={(event) => event.stopPropagation()}>
          <button type="button" className="auto-video-control" onClick={togglePlayback} aria-label={isPlaying ? '暂停' : '播放'}>{isPlaying ? 'Ⅱ' : '▶'}</button>
          <input className="auto-video-scrubber" type="range" min="0" max={Math.max(duration, 0)} step="0.01" value={Math.min(currentTime, duration || 0)} onChange={(event) => seek(Number(event.currentTarget.value))} aria-label="播放进度" disabled={!duration} />
          <span className="auto-video-duration">{formatTime(currentTime)} / {formatTime(duration)}</span>
          <button type="button" className="auto-video-control auto-video-fullscreen" onClick={() => void toggleFullscreen()} aria-label={isFullscreen ? '退出全屏' : '全屏'}>{isFullscreen ? '↙' : '⛶'}</button>
        </div>
        <div className="auto-time-readout" aria-live="polite">{formatTime(currentTime)} / {formatTime(duration)}</div>
      </div>
    </section>
  );
};
