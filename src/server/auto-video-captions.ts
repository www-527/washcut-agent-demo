import {mkdir, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {
  assetCaptionTrackSchema,
  autoCaptionSchema,
  type AssetCaptionTrack,
  type AutoCaption,
  type NormalizedTranscript,
  type VideoTimeline,
} from '../shared/auto-video-contracts.js';
import {autoVideoGenerationArtifactPath, autoVideoProjectArtifactPath, writeGenerationJson, writeProjectJson} from './auto-video-media.js';

const maxCaptionCharacters = 14;
const maxCaptionDurationMs = 1_800;
const maxWordGapMs = 500;
const sentenceEnd = /[。！？!?；;]/u;

const wordTimedCaptions = (transcript: NormalizedTranscript): AutoCaption[] => {
  const captions: AutoCaption[] = [];
  let group: typeof transcript.words = [];
  const flush = () => {
    if (!group.length) return;
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const text = group.map((word) => word.text.trim()).join('');
    if (text && first.startMs < last.endMs) {
      captions.push(autoCaptionSchema.parse({
        text,
        startMs: first.startMs,
        endMs: last.endMs,
        timestampMs: first.startMs,
        confidence: first.confidence,
      }));
    }
    group = [];
  };
  for (const word of transcript.words) {
    const text = word.text.trim();
    if (!text || word.startMs >= word.endMs || word.endMs > transcript.durationMs) continue;
    const first = group[0];
    const previous = group[group.length - 1];
    const nextText = `${group.map((item) => item.text.trim()).join('')}${text}`;
    const startsNewCaption = Boolean(first && (
      nextText.length > maxCaptionCharacters
      || word.endMs - first.startMs > maxCaptionDurationMs
      || word.startMs - (previous?.endMs ?? word.startMs) > maxWordGapMs
    ));
    if (startsNewCaption) flush();
    group.push(word);
    if (sentenceEnd.test(text)) flush();
  }
  flush();
  return captions;
};

export const transcriptToCaptions = (assetId: string, transcript: NormalizedTranscript | null): AssetCaptionTrack => {
  if (!transcript || transcript.assetId !== assetId) return assetCaptionTrackSchema.parse({assetId, captions: []});
  if (transcript.words.length) return assetCaptionTrackSchema.parse({assetId, captions: wordTimedCaptions(transcript)});
  const captions = transcript.segments.flatMap((source) => {
    const text = source.text.trim();
    if (!text || source.startMs >= source.endMs || source.endMs > transcript.durationMs) return [];
    return [autoCaptionSchema.parse({
      text,
      startMs: source.startMs,
      endMs: source.endMs,
      timestampMs: source.startMs,
      confidence: source.confidence,
    })];
  });
  return assetCaptionTrackSchema.parse({assetId, captions});
};

export const globalizeCaptions = (tracks: AssetCaptionTrack[], timeline: VideoTimeline): AutoCaption[] => {
  const clips = new Map(timeline.clips.map((clip) => [clip.assetId, clip]));
  const captions: AutoCaption[] = [];
  for (const track of tracks) {
    const clip = clips.get(track.assetId);
    if (!clip) continue;
    for (const caption of track.captions) {
      const startMs = clip.startMs + caption.startMs;
      const endMs = Math.min(clip.startMs + clip.durationMs, clip.startMs + caption.endMs);
      if (caption.text.trim() && startMs < endMs) captions.push(autoCaptionSchema.parse({...caption, startMs, endMs}));
    }
  }
  return [...captions].sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
};

export const formatWebVttTime = (milliseconds: number) => {
  const safe = Math.max(0, Math.floor(milliseconds));
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1_000);
  const millis = safe % 1_000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
};

export const captionsToWebVtt = (captions: AutoCaption[]) => {
  const bodies = captions.map((caption, index) => `${index + 1}\n${formatWebVttTime(caption.startMs)} --> ${formatWebVttTime(caption.endMs)}\n${caption.text.trim()}`);
  return `WEBVTT\n\n${bodies.join('\n\n')}${bodies.length ? '\n' : ''}`;
};

export const writeAutoVideoCaptionJson = async (projectId: string, captions: AutoCaption[]) =>
  writeProjectJson(projectId, 'captions.json', captions);

export const writeAutoVideoVtt = async (projectId: string, captions: AutoCaption[]) => {
  const vttPath = autoVideoProjectArtifactPath(projectId, 'captions.vtt');
  await mkdir(path.dirname(vttPath), {recursive: true});
  const temporary = `${vttPath}.${process.pid}.tmp`;
  await writeFile(temporary, captionsToWebVtt(captions), 'utf8');
  await rename(temporary, vttPath);
  return vttPath;
};

export const writeAutoVideoCaptions = async (projectId: string, captions: AutoCaption[]) => {
  const [jsonPath, vttPath] = await Promise.all([
    writeAutoVideoCaptionJson(projectId, captions),
    writeAutoVideoVtt(projectId, captions),
  ]);
  return {jsonPath, vttPath};
};

export const writeAutoVideoGenerationCaptionJson = async (projectId: string, generationId: string, captions: AutoCaption[]) =>
  writeGenerationJson(projectId, generationId, 'captions.json', captions);

export const writeAutoVideoGenerationVtt = async (projectId: string, generationId: string, captions: AutoCaption[]) => {
  const vttPath = autoVideoGenerationArtifactPath(projectId, generationId, 'captions.vtt');
  await mkdir(path.dirname(vttPath), {recursive: true});
  const temporary = `${vttPath}.${process.pid}.tmp`;
  await writeFile(temporary, captionsToWebVtt(captions), 'utf8');
  await rename(temporary, vttPath);
  return vttPath;
};
