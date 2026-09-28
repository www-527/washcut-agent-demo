import {Composition} from 'remotion';
import {parseEnvelope, type VideoSpec} from '../shared/contracts';
import {type VideoTimeline} from '../shared/auto-video-contracts';
import {AutoVideo} from './AutoVideo';
import {calculateAutoVideoMetadata} from './calculate-metadata';
import {WashcutVideo} from './WashcutVideo';
import {defaultRenderMessage, defaultVideoSpec} from './default-spec';

export const RemotionRoot = () => (
  <>
    <Composition
      id="WashcutMarketingVideo"
      component={WashcutVideo}
      width={1080}
      height={1920}
      fps={30}
      durationInFrames={defaultVideoSpec.durationMs / 1000 * defaultVideoSpec.fps}
      defaultProps={{message: defaultRenderMessage}}
      calculateMetadata={({props}) => {
        const spec = parseEnvelope<VideoSpec>(props.message, {type: 'render.requested', schema: 'video-spec.v1'}).payload.data;
        return {
          durationInFrames: Math.round(spec.durationMs / 1000 * spec.fps),
          width: spec.width,
          height: spec.height,
          fps: spec.fps,
        };
      }}
    />
    <Composition
      id="AutoVideoCompilation"
      component={AutoVideo}
      width={1080}
      height={1920}
      fps={30}
      durationInFrames={30}
      defaultProps={{
        timeline: {
          projectId: 'project_preview', fps: 30, width: 1080, height: 1920, durationInFrames: 30, durationMs: 1_000,
          clips: [{assetId: 'asset_preview', src: 'https://remotion.media/video.mp4', order: 1, startMs: 0, durationMs: 1_000, fromFrame: 0, durationInFrames: 30, volume: 1, fit: 'contain'}],
        } satisfies VideoTimeline,
        captions: [],
        showSubtitles: false,
      }}
      calculateMetadata={calculateAutoVideoMetadata}
    />
  </>
);
