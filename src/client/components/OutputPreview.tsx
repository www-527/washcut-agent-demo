import {useEffect, useRef, useState, type CSSProperties} from 'react';
import {SHORT_VIDEO_CAPTION_BOTTOM_RATIO} from '../../shared/auto-video-caption';
import {useStableMediaUrl} from '../use-stable-media-url';

type OutputPreviewProps = {
  mediaRevision: string;
  captionedMediaRevision: string;
  versionNumber: number;
  status: string;
  statusLabel: string;
  progress: number;
  videoWidth: number;
  videoHeight: number;
  videoUrl: string;
  captionedVideoUrl?: string;
  subtitleUrl?: string;
  durationMs?: number;
  onPrepareCaptionedDownload?: () => Promise<string>;
};

type PreviewCaption = {
  text: string;
  startMs: number;
  endMs: number;
};

type PlaybackSnapshot = {
  currentTime: number;
  muted: boolean;
  playbackRate: number;
  shouldResume: boolean;
  volume: number;
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

const startDownload = (url: string) => {
  const link = document.createElement('a');
  link.href = url;
  link.download = '';
  document.body.append(link);
  link.click();
  link.remove();
};

export const OutputPreview = ({mediaRevision, captionedMediaRevision, versionNumber, status, statusLabel, progress, videoWidth, videoHeight, videoUrl, captionedVideoUrl, subtitleUrl, durationMs, onPrepareCaptionedDownload}: OutputPreviewProps) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const pendingPlaybackSnapshotRef = useRef<PlaybackSnapshot | undefined>(undefined);
  const [showSubtitles, setShowSubtitles] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(durationMs ? durationMs / 1_000 : 0);
  const [captions, setCaptions] = useState<PreviewCaption[]>([]);
  const [preparedCaptionedVideoUrl, setPreparedCaptionedVideoUrl] = useState<string>();
  const [preparingDownload, setPreparingDownload] = useState(false);
  const [downloadError, setDownloadError] = useState<string>();
  const [captionBottomPx, setCaptionBottomPx] = useState<number>();
  const stableVideoUrl = useStableMediaUrl(mediaRevision, videoUrl);
  const stableCaptionedVideoUrl = useStableMediaUrl(captionedMediaRevision, captionedVideoUrl ?? '');
  const stableSubtitleUrl = useStableMediaUrl(mediaRevision, subtitleUrl ?? '');
  const readyCaptionedVideoUrl = preparedCaptionedVideoUrl ?? (stableCaptionedVideoUrl || undefined);
  const activeVideoUrl = showSubtitles && readyCaptionedVideoUrl ? readyCaptionedVideoUrl : stableVideoUrl;
  // Keep portrait previews usable on desktop while allowing landscape output
  // to use the available width. CSS applies this custom width cap only in the
  // normal preview state; fullscreen rules deliberately take over.
  const previewWidthAtMaxHeight = Math.max(1, Math.round(680 * videoWidth / videoHeight));
  const previewStyle = {
    '--preview-width': `${previewWidthAtMaxHeight}px`,
    '--preview-aspect-ratio': `${videoWidth} / ${videoHeight}`,
    marginInline: 'auto',
  } as CSSProperties & Record<'--preview-width' | '--preview-aspect-ratio', string>;

  useEffect(() => {
    if (readyCaptionedVideoUrl) return;
    const updateCaptionLayout = () => {
      const container = previewRef.current;
      if (!container || !videoWidth || !videoHeight) return;
      const containerWidth = container.clientWidth;
      const containerHeight = container.clientHeight;
      if (!containerWidth || !containerHeight) return;

      // The browser may letterbox the video inside a fullscreen viewport. Find
      // the actual displayed video rectangle, then place the preview caption
      // at the same normalized bottom offset as the burned-in MP4 caption.
      const videoAspectRatio = videoWidth / videoHeight;
      const containerAspectRatio = containerWidth / containerHeight;
      const displayedVideoHeight = containerAspectRatio > videoAspectRatio
        ? containerHeight
        : containerWidth / videoAspectRatio;
      const verticalVideoOffset = (containerHeight - displayedVideoHeight) / 2;
      const displayedCaptionBottom = verticalVideoOffset
        + displayedVideoHeight * SHORT_VIDEO_CAPTION_BOTTOM_RATIO;
      setCaptionBottomPx(Math.round(displayedCaptionBottom));
    };

    updateCaptionLayout();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateCaptionLayout) : undefined;
    if (previewRef.current) observer?.observe(previewRef.current);
    window.addEventListener('resize', updateCaptionLayout);
    document.addEventListener('fullscreenchange', updateCaptionLayout);
    document.addEventListener('webkitfullscreenchange', updateCaptionLayout);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateCaptionLayout);
      document.removeEventListener('fullscreenchange', updateCaptionLayout);
      document.removeEventListener('webkitfullscreenchange', updateCaptionLayout);
    };
  }, [readyCaptionedVideoUrl, videoHeight, videoWidth]);

  useEffect(() => {
    setPreparedCaptionedVideoUrl(undefined);
    setDownloadError(undefined);
  }, [captionedMediaRevision, mediaRevision]);

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
    if (readyCaptionedVideoUrl || !stableSubtitleUrl) {
      setCaptions([]);
      return;
    }
    const controller = new AbortController();
    void fetch(stableSubtitleUrl, {signal: controller.signal})
      .then((response) => response.ok ? response.text() : '')
      .then((source) => { if (!controller.signal.aborted) setCaptions(parseWebVtt(source)); })
      .catch(() => { if (!controller.signal.aborted) setCaptions([]); });
    return () => controller.abort();
  }, [readyCaptionedVideoUrl, stableSubtitleUrl]);

  const activeCaption = showSubtitles && !readyCaptionedVideoUrl
    ? captions.find((caption) => currentTime * 1_000 >= caption.startMs && currentTime * 1_000 < caption.endMs)
    : undefined;

  const rememberPlaybackForSourceSwitch = (nextVideoUrl: string) => {
    const video = videoRef.current;
    if (!video || nextVideoUrl === activeVideoUrl) return;
    pendingPlaybackSnapshotRef.current = {
      currentTime: video.currentTime,
      muted: video.muted,
      playbackRate: video.playbackRate,
      shouldResume: !video.paused && !video.ended,
      volume: video.volume,
    };
  };

  const toggleSubtitles = () => {
    const nextShowSubtitles = !showSubtitles;
    const nextVideoUrl = nextShowSubtitles && readyCaptionedVideoUrl ? readyCaptionedVideoUrl : stableVideoUrl;
    rememberPlaybackForSourceSwitch(nextVideoUrl);
    setShowSubtitles(nextShowSubtitles);
  };

  const handleLoadedMetadata = (video: HTMLVideoElement) => {
    setDuration(video.duration);
    const snapshot = pendingPlaybackSnapshotRef.current;
    if (!snapshot) return;
    pendingPlaybackSnapshotRef.current = undefined;
    const targetTime = Math.min(snapshot.currentTime, Number.isFinite(video.duration) ? video.duration : snapshot.currentTime);
    video.currentTime = targetTime;
    video.muted = snapshot.muted;
    video.playbackRate = snapshot.playbackRate;
    video.volume = snapshot.volume;
    setCurrentTime(targetTime);
    if (snapshot.shouldResume) void video.play().catch(() => undefined);
  };

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

  const downloadVideo = async () => {
    setDownloadError(undefined);
    if (!showSubtitles) {
      startDownload(videoUrl);
      return;
    }
    const readyUrl = preparedCaptionedVideoUrl ?? captionedVideoUrl;
    if (readyUrl) {
      startDownload(readyUrl);
      return;
    }
    if (!onPrepareCaptionedDownload) {
      setDownloadError('当前版本缺少带字幕成片，请重新生成后再下载。');
      return;
    }
    setPreparingDownload(true);
    try {
      const preparedUrl = await onPrepareCaptionedDownload();
      rememberPlaybackForSourceSwitch(preparedUrl);
      setPreparedCaptionedVideoUrl(preparedUrl);
      startDownload(preparedUrl);
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : String(error));
    } finally {
      setPreparingDownload(false);
    }
  };

  return (
    <section className="auto-output-preview" aria-labelledby="auto-output-title">
      <div className="auto-output-copy">
        <div className="auto-version-summary auto-output-version-summary">
          <h2 id="auto-output-title">V{versionNumber}</h2>
          <div className={`auto-status auto-status-${status}`}><i />{statusLabel}<small>{progress}%</small></div>
        </div>
        <div className="auto-output-actions">
          <button type="button" className={showSubtitles ? 'auto-subtitle-toggle on' : 'auto-subtitle-toggle'} aria-pressed={showSubtitles} disabled={preparingDownload} onClick={toggleSubtitles}>
            {showSubtitles ? '字幕：开启' : '字幕：关闭'}
          </button>
          <button type="button" className="auto-download-button" disabled={preparingDownload} onClick={() => void downloadVideo()}>
            {preparingDownload ? '正在生成带字幕 MP4…' : '下载 MP4'}
          </button>
          {downloadError ? <span className="auto-output-download-status error" role="alert">{downloadError}</span> : null}
        </div>
      </div>
      <div
        ref={previewRef}
        className="auto-video-wrap"
        style={previewStyle}
        onDoubleClick={() => void toggleFullscreen()}
      >
        <video
          ref={videoRef}
          src={activeVideoUrl}
          style={{width: '100%', height: '100%', objectFit: 'contain'}}
          aria-label="最终成片预览"
          preload="metadata"
          onLoadedMetadata={(event) => handleLoadedMetadata(event.currentTarget)}
          onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={() => setIsPlaying(false)}
        >
          您的浏览器不支持 HTML5 视频播放。
        </video>
        {activeCaption ? <div className="auto-preview-caption" style={captionBottomPx !== undefined ? {bottom: `${captionBottomPx}px`} : undefined} aria-live="polite">{activeCaption.text}</div> : null}
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
