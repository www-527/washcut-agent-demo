import {
  videoTimelineSchema,
  type AutoVideoGeneration,
  type AutoVideoProject,
  type EditPlan,
  type StoredAutoVideoAsset,
  type VideoTimeline,
} from '../shared/auto-video-contracts.js';
import {signedAutoVideoUrl} from './auto-video-media.js';

/**
 * Resolve the render canvas from the uploaded media instead of forcing every
 * generation into the historical 1080x1920 portrait canvas. The first asset
 * establishes the project output ratio; individual clips still use `contain`
 * so mixed-ratio uploads are never stretched or cropped.
 */
export const resolveAutoVideoCanvas = (
  fallback: {width: number; height: number; fps: number},
  assets: Pick<StoredAutoVideoAsset, 'metadata'>[],
) => {
  const metadata = assets.find((asset) => asset.metadata)?.metadata;
  return metadata
    ? {width: metadata.width, height: metadata.height, fps: fallback.fps}
    : fallback;
};

export const validateAutoTimeline = (timeline: VideoTimeline, expectedAssetIds: string[]) => {
  const parsed = videoTimelineSchema.parse(timeline);
  if (parsed.clips.length !== expectedAssetIds.length) throw new Error('TIMELINE_INVALID');
  const expected = new Set(expectedAssetIds);
  const seen = new Set<string>();
  let expectedFrame = 0;
  let expectedStartMs = 0;
  for (let index = 0; index < parsed.clips.length; index += 1) {
    const clip = parsed.clips[index]!;
    if (!expected.has(clip.assetId) || seen.has(clip.assetId) || clip.order !== index + 1) throw new Error('TIMELINE_INVALID');
    if (clip.fromFrame !== expectedFrame || clip.startMs !== expectedStartMs || clip.fit !== 'contain' || clip.volume !== 1) throw new Error('TIMELINE_INVALID');
    expectedFrame += clip.durationInFrames;
    expectedStartMs += clip.durationMs;
    seen.add(clip.assetId);
  }
  if (seen.size !== expected.size || parsed.durationInFrames !== expectedFrame || parsed.durationMs !== expectedStartMs) throw new Error('TIMELINE_INVALID');
  return parsed;
};

export const compileAutoVideoTimeline = (project: Pick<AutoVideoProject, 'id' | 'canvas'>, assets: StoredAutoVideoAsset[], plan: EditPlan) => {
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const ordered = [...plan.clips].sort((left, right) => left.order - right.order);
  let fromFrame = 0;
  let startMs = 0;
  const clips = ordered.map((clip) => {
    const asset = assetById.get(clip.assetId);
    if (!asset?.metadata) throw new Error('TIMELINE_INVALID');
    const durationMs = asset.metadata.durationMs;
    const durationInFrames = Math.ceil(durationMs / 1_000 * project.canvas.fps);
    const result = {
      assetId: asset.id,
      src: signedAutoVideoUrl(project.id, 'original', {assetId: asset.id}),
      order: clip.order,
      startMs,
      durationMs,
      fromFrame,
      durationInFrames,
      volume: 1,
      fit: 'contain' as const,
    };
    fromFrame += durationInFrames;
    startMs += durationMs;
    return result;
  });
  const timeline = videoTimelineSchema.parse({
    projectId: project.id,
    fps: project.canvas.fps,
    width: project.canvas.width,
    height: project.canvas.height,
    durationInFrames: fromFrame,
    durationMs: startMs,
    clips,
  });
  return validateAutoTimeline(timeline, assets.map((asset) => asset.id));
};

export const compileAutoVideoGenerationTimeline = (generation: AutoVideoGeneration, assets: StoredAutoVideoAsset[], plan: EditPlan) =>
  compileAutoVideoTimeline({
    id: generation.projectId,
    canvas: generation.canvas,
  }, assets, plan);
