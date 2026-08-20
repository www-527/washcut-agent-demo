import type {Caption} from '@remotion/captions';
import {AbsoluteFill, Sequence, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';

const CaptionCard = ({caption}: {caption: Caption}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
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

export const VideoCaptions = ({captions}: {captions: Caption[]}) => {
  const {fps} = useVideoConfig();
  return (
    <AbsoluteFill name="Captions">
      {captions.map((caption, index) => {
        const from = Math.round(caption.startMs / 1000 * fps);
        const durationInFrames = Math.max(1, Math.round((caption.endMs - caption.startMs) / 1000 * fps));
        return (
          <Sequence key={`${caption.startMs}-${index}`} from={from} durationInFrames={durationInFrames}>
            <CaptionCard caption={caption} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
