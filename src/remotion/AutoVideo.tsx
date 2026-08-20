import {Video} from '@remotion/media';
import {AbsoluteFill, Sequence} from 'remotion';
import {videoTimelineSchema, type VideoTimeline} from '../shared/auto-video-contracts';

export type AutoVideoProps = {timeline: VideoTimeline};

export const AutoVideo = ({timeline}: AutoVideoProps) => {
  const parsed = videoTimelineSchema.parse(timeline);
  return (
    <AbsoluteFill style={{backgroundColor: '#000'}}>
      {parsed.clips.map((clip) => (
        <Sequence key={clip.assetId} from={clip.fromFrame} durationInFrames={clip.durationInFrames} layout="absolute-fill" name={`Clip ${clip.order}`}>
          <Video
            src={clip.src}
            volume={clip.volume}
            style={{width: '100%', height: '100%', objectFit: clip.fit}}
          />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

