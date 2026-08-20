import {Video} from '@remotion/media';
import {AbsoluteFill} from 'remotion';
import type {TimelineClip} from '../shared/auto-video-contracts';

export const VideoClip = ({clip}: {clip: TimelineClip}) => (
  <AbsoluteFill style={{backgroundColor: '#000'}}>
    <Video src={clip.src} volume={clip.volume} style={{width: '100%', height: '100%', objectFit: clip.fit}} />
  </AbsoluteFill>
);

