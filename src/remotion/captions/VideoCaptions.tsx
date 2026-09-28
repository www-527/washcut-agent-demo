import type {Caption} from '@remotion/captions';
import {AbsoluteFill, Sequence, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {getShortVideoCaptionLayout} from '../../shared/auto-video-caption';

type CaptionStyle = 'card' | 'short-video';

const CaptionCard = ({caption, style}: {caption: Caption; style: CaptionStyle}) => {
  const frame = useCurrentFrame();
  const {fps, height, width} = useVideoConfig();
  if (style === 'short-video') {
    const layout = getShortVideoCaptionLayout(width, height, caption.text);
    return (
      <AbsoluteFill style={{justifyContent: 'flex-end', alignItems: 'center', paddingBottom: layout.bottomPx}}>
        <div
          style={{
            maxWidth: layout.maxWidthPx,
            color: 'white',
            fontFamily: 'Microsoft YaHei, PingFang SC, Arial, sans-serif',
            fontSize: layout.fontSizePx,
            fontWeight: 900,
            lineHeight: 1.25,
            letterSpacing: '0.012em',
            textAlign: 'center',
            textShadow: `-${layout.strokePx}px -${layout.strokePx}px 0 #090909, ${layout.strokePx}px -${layout.strokePx}px 0 #090909, -${layout.strokePx}px ${layout.strokePx}px 0 #090909, ${layout.strokePx}px ${layout.strokePx}px 0 #090909, 0 ${layout.shadowOffsetPx}px ${layout.shadowBlurPx}px rgba(0,0,0,.72)`,
            WebkitTextStroke: `${layout.strokePx}px #090909`,
            paintOrder: 'stroke fill',
            whiteSpace: 'nowrap',
          }}
        >
          {caption.text}
        </div>
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill style={{justifyContent: 'flex-end', alignItems: 'center', padding: '0 80px 120px'}}>
      <div
        style={{
          maxWidth: 920,
          color: 'white',
          backgroundColor: 'rgba(3, 15, 34, 0.78)',
          border: '2px solid rgba(255,255,255,.15)',
          borderRadius: 22,
          padding: '18px 30px 20px',
          fontFamily: 'Arial, Microsoft YaHei, sans-serif',
          fontSize: 46,
          fontWeight: 800,
          lineHeight: 1.32,
          textAlign: 'center',
          whiteSpace: 'pre-wrap',
          opacity: interpolate(frame, [0, 0.2 * fps], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}),
        }}
      >
        {caption.text}
      </div>
    </AbsoluteFill>
  );
};

export const VideoCaptions = ({captions, style = 'card'}: {captions: Caption[]; style?: CaptionStyle}) => {
  const {fps} = useVideoConfig();
  return (
    <AbsoluteFill name="Captions">
      {captions.map((caption, index) => {
        const from = Math.round(caption.startMs / 1000 * fps);
        const durationInFrames = Math.max(1, Math.round((caption.endMs - caption.startMs) / 1000 * fps));
        return (
          <Sequence key={`${caption.startMs}-${index}`} from={from} durationInFrames={durationInFrames}>
            <CaptionCard caption={caption} style={style} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
