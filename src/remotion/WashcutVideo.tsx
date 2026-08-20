import {Audio, Video} from '@remotion/media';
import {TransitionSeries, linearTiming} from '@remotion/transitions';
import {fade} from '@remotion/transitions/fade';
import {slide} from '@remotion/transitions/slide';
import {Fragment} from 'react';
import {
  AbsoluteFill,
  Easing,
  Img,
  Interactive,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {parseEnvelope, type Envelope, type VideoSpec} from '../shared/contracts';
import {VideoCaptions} from './captions/VideoCaptions';

const resolveMediaUrl = (url: string) => url.startsWith('/media/') ? staticFile(url.slice(1)) : url;

const SceneMedia = ({scene}: {scene: VideoSpec['scenes'][number]}) => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const cropAmount = Math.min(0.22, (scene.crop.scale - 1) / (2 * scene.crop.scale));
  const cropLeft = cropAmount * Math.max(0, 2 - scene.crop.x * 2);
  const cropRight = cropAmount * Math.max(0, scene.crop.x * 2);
  const cropTop = cropAmount * Math.max(0, 2 - scene.crop.y * 2);
  const cropBottom = cropAmount * Math.max(0, scene.crop.y * 2);
  const mediaStyle = {
    width: '100%',
    height: '100%',
    scale: interpolate(frame, [0, durationInFrames], [1.01, 1.07], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}),
  };
  return scene.media.contentType.startsWith('video/') ? (
    <Video
      name="Project footage"
      src={resolveMediaUrl(scene.media.url)}
      trimBefore={Math.round(scene.sourceStartMs / 1000 * fps)}
      loop
      muted
      objectFit="cover"
      cropLeft={cropLeft}
      cropRight={cropRight}
      cropTop={cropTop}
      cropBottom={cropBottom}
      style={mediaStyle}
    />
  ) : (
    <Img
      name="Project image"
      src={resolveMediaUrl(scene.media.url)}
      cropLeft={cropLeft}
      cropRight={cropRight}
      cropTop={cropTop}
      cropBottom={cropBottom}
      style={{...mediaStyle, objectFit: 'cover'}}
    />
  );
};

const Scene = ({scene, index, offer}: {scene: VideoSpec['scenes'][number]; index: number; offer: string}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  return (
    <AbsoluteFill name={`Scene ${index + 1}`} style={{backgroundColor: '#081a36', overflow: 'hidden'}}>
      <SceneMedia scene={scene} />
      <AbsoluteFill style={{background: 'linear-gradient(180deg, rgba(3,14,32,.05) 24%, rgba(3,14,32,.90) 100%)'}} />
      <Interactive.Div name="Brand" style={{position: 'absolute', top: 92, left: 80, color: 'white', fontFamily: 'Arial, Microsoft YaHei, sans-serif', fontSize: 30, fontWeight: 700, letterSpacing: 3}}>
        洗车片场 · VERIFIED SOURCE
      </Interactive.Div>
      <Interactive.Div
        name="Scene title"
        style={{
          position: 'absolute',
          left: 80,
          right: 80,
          ...(scene.captionPosition === 'upper' ? {top: 260} : {bottom: 300}),
          color: 'white',
          fontFamily: 'Arial, Microsoft YaHei, sans-serif',
          translate: interpolate(frame, [0, 0.5 * fps], ['0px 42px', '0px 0px'], {
            extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
          opacity: interpolate(frame, [0, 0.4 * fps], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}),
        }}
      >
        {index === 0 ? <div style={{display: 'inline-block', color: '#ff7b19', background: 'white', borderRadius: 14, padding: '13px 22px', fontSize: 42, fontWeight: 800, marginBottom: 24}}>{offer}</div> : null}
        <div style={{fontSize: index === 0 ? 84 : 74, fontWeight: 900, lineHeight: 1.14, textShadow: '0 5px 22px rgba(0,0,0,.38)'}}>{scene.headline}</div>
        <div style={{fontSize: 44, lineHeight: 1.42, marginTop: 20, opacity: 0.94}}>{scene.subtitle}</div>
        <div style={{width: 84, height: 9, borderRadius: 5, backgroundColor: '#2f85ff', marginTop: 34}} />
      </Interactive.Div>
    </AbsoluteFill>
  );
};

const transitionFor = (transition: VideoSpec['scenes'][number]['transition']) => transition === 'slide'
  ? slide({direction: 'from-right'})
  : fade();

export const WashcutVideo = ({message}: {message: Envelope<VideoSpec>}) => {
  const spec = parseEnvelope<VideoSpec>(message, {type: 'render.requested', schema: 'video-spec.v1'}).payload.data;
  const transitionFrames = Math.round(spec.fps * 0.5);
  return (
    <AbsoluteFill style={{backgroundColor: '#071a37'}}>
      <TransitionSeries name="Washcut timeline">
        {spec.scenes.map((scene, index) => (
          <Fragment key={scene.sceneId}>
            {index > 0 ? (
              <TransitionSeries.Transition
                presentation={transitionFor(scene.transition)}
                timing={linearTiming({durationInFrames: transitionFrames})}
              />
            ) : null}
            <TransitionSeries.Sequence name={`Clip ${index + 1}`} durationInFrames={Math.round(scene.durationMs / 1000 * spec.fps)}>
              <Scene scene={scene} index={index} offer={spec.offer} />
            </TransitionSeries.Sequence>
          </Fragment>
        ))}
      </TransitionSeries>
      {spec.audio.bgm ? <Audio name="Licensed BGM" src={spec.audio.bgm.url} loop volume={Math.max(0.02, Math.min(0.2, 0.2 * 10 ** (spec.audio.duckingDb / 20)))} /> : null}
      {spec.audio.voice ? <Audio name="Chinese voiceover" src={spec.audio.voice.url} volume={1} /> : null}
      <VideoCaptions captions={spec.captions} />
    </AbsoluteFill>
  );
};
