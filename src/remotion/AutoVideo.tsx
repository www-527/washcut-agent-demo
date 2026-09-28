import {Video} from '@remotion/media';
import {AbsoluteFill, Sequence} from 'remotion';
import {autoCaptionSchema, videoTimelineSchema, type AutoCaption, type VideoTimeline} from '../shared/auto-video-contracts';
import {VideoCaptions} from './captions/VideoCaptions';

export type AutoVideoProps = {
  timeline: VideoTimeline;
  captions: AutoCaption[];
  showSubtitles: boolean;
};

export const AutoVideo = ({timeline, captions, showSubtitles}: AutoVideoProps) => {
  const parsed = videoTimelineSchema.parse(timeline);
  const parsedCaptions = captions.map((caption) => autoCaptionSchema.parse(caption));
  return (
    <AbsoluteFill style={{backgroundColor: '#000'}}>
      {parsed.clips.map((clip) => (
        <Sequence key={clip.assetId} from={clip.fromFrame} durationInFrames={clip.durationInFrames} layout="absolute-fill" name={`Clip ${clip.order}`}>
          <Video
            src={clip.src}
            volume={clip.volume}
            objectFit={clip.fit}
            style={{width: '100%', height: '100%'}}
          />
        </Sequence>
      ))}
      {showSubtitles ? <VideoCaptions captions={parsedCaptions} style="short-video" /> : null}
    </AbsoluteFill>
  );
};
