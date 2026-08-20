import type {CalculateMetadataFunction} from 'remotion';
import {videoTimelineSchema} from '../shared/auto-video-contracts';
import type {AutoVideoProps} from './AutoVideo';

export const calculateAutoVideoMetadata: CalculateMetadataFunction<AutoVideoProps> = ({props}) => {
  const timeline = videoTimelineSchema.parse(props.timeline);
  return {
    durationInFrames: timeline.durationInFrames,
    width: timeline.width,
    height: timeline.height,
    fps: timeline.fps,
    defaultOutName: `${timeline.projectId}-output`,
  };
};

