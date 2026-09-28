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
const minimumBalancedCaptionCharacters = 3;
const orphanMergeDurationToleranceMs = 250;
const sentenceEnd = /[。！？!?；;]/u;

const captionCharacterCount = (text: string) => Array.from(text).length;

const rebalanceTrailingTextOrphan = (chunks: string[]) => {
  if (chunks.length < 2) return chunks;
  const balanced = [...chunks];
  const orphan = balanced[balanced.length - 1]!;
  const previous = balanced[balanced.length - 2]!;
  if (
    captionCharacterCount(orphan) >= minimumBalancedCaptionCharacters
    || sentenceEnd.test(previous.at(-1) ?? '')
  ) return balanced;
  if (captionCharacterCount(previous) + captionCharacterCount(orphan) <= maxCaptionCharacters) {
    balanced.splice(-2, 2, `${previous}${orphan}`);
    return balanced;
  }
  const previousCharacters = Array.from(previous);
  const orphanCharacters = Array.from(orphan);
  while (
    orphanCharacters.length < minimumBalancedCaptionCharacters
    && previousCharacters.length > minimumBalancedCaptionCharacters
  ) {
    orphanCharacters.unshift(previousCharacters.pop()!);
  }
  balanced.splice(-2, 2, previousCharacters.join(''), orphanCharacters.join(''));
  return balanced;
};

const splitCaptionText = (text: string) => {
  const chunks: string[] = [];
  let current: string[] = [];
  const flush = () => {
    const value = current.join('').trim();
    if (value) chunks.push(value);
    current = [];
  };
  for (const character of Array.from(text.trim())) {
    if (!character.trim() && current.length === 0) continue;
    current.push(character);
    if (current.length >= maxCaptionCharacters || sentenceEnd.test(character)) flush();
  }
  flush();
  return rebalanceTrailingTextOrphan(chunks);
};

const captionWordGroupText = (group: NormalizedTranscript['words']) =>
  group.map((word) => word.text.trim()).join('');

const rebalanceWordTimedOrphans = (groups: NormalizedTranscript['words'][]) => {
  const balanced = groups.map((group) => [...group]);
  for (let index = 1; index < balanced.length; index += 1) {
    const previous = balanced[index - 1];
    const orphan = balanced[index];
    if (!previous?.length || !orphan?.length) continue;
    if (captionCharacterCount(captionWordGroupText(orphan)) >= minimumBalancedCaptionCharacters) continue;
    const previousLast = previous[previous.length - 1]!;
    const orphanFirst = orphan[0]!;
    const orphanLast = orphan[orphan.length - 1]!;
    if (
      sentenceEnd.test(previousLast.text.trim())
      || orphanFirst.startMs - previousLast.endMs > maxWordGapMs
    ) continue;

    const combinedText = `${captionWordGroupText(previous)}${captionWordGroupText(orphan)}`;
    const combinedDurationMs = orphanLast.endMs - previous[0]!.startMs;
    if (
      captionCharacterCount(combinedText) <= maxCaptionCharacters
      && combinedDurationMs <= maxCaptionDurationMs + orphanMergeDurationToleranceMs
    ) {
      previous.push(...orphan);
      balanced.splice(index, 1);
      index -= 1;
      continue;
    }

    while (captionCharacterCount(captionWordGroupText(orphan)) < minimumBalancedCaptionCharacters) {
      const candidate = previous[previous.length - 1];
      if (!candidate) break;
      const candidateCharacters = captionCharacterCount(candidate.text.trim());
      const remainingPreviousCharacters = captionCharacterCount(captionWordGroupText(previous)) - candidateCharacters;
      const rebalancedOrphanCharacters = captionCharacterCount(captionWordGroupText(orphan)) + candidateCharacters;
      const rebalancedOrphanDurationMs = orphanLast.endMs - candidate.startMs;
      if (
        remainingPreviousCharacters < minimumBalancedCaptionCharacters
        || rebalancedOrphanCharacters > maxCaptionCharacters
        || rebalancedOrphanDurationMs > maxCaptionDurationMs + orphanMergeDurationToleranceMs
      ) break;
      previous.pop();
      orphan.unshift(candidate);
    }
  }
  return balanced;
};

const wordTimedCaptions = (transcript: NormalizedTranscript): AutoCaption[] => {
  const groups: NormalizedTranscript['words'][] = [];
  let group: typeof transcript.words = [];
  const flush = () => {
    if (!group.length) return;
    groups.push(group);
    group = [];
  };
  for (const word of transcript.words) {
    const text = word.text.trim();
    if (!text || word.startMs >= word.endMs || word.endMs > transcript.durationMs) continue;
    const first = group[0];
    const previous = group[group.length - 1];
    const nextText = `${group.map((item) => item.text.trim()).join('')}${text}`;
    const startsNewCaption = Boolean(first && (
      captionCharacterCount(nextText) > maxCaptionCharacters
      || word.endMs - first.startMs > maxCaptionDurationMs
      || word.startMs - (previous?.endMs ?? word.startMs) > maxWordGapMs
    ));
    if (startsNewCaption) flush();
    group.push(word);
    if (sentenceEnd.test(text)) flush();
  }
  flush();
  return rebalanceWordTimedOrphans(groups).flatMap((balancedGroup) => {
    const first = balancedGroup[0];
    const last = balancedGroup[balancedGroup.length - 1];
    const text = captionWordGroupText(balancedGroup);
    if (!first || !last || !text || first.startMs >= last.endMs) return [];
    return [autoCaptionSchema.parse({
      text,
      startMs: first.startMs,
      endMs: last.endMs,
      timestampMs: first.startMs,
      confidence: first.confidence,
    })];
  });
};

export const transcriptToCaptions = (assetId: string, transcript: NormalizedTranscript | null): AssetCaptionTrack => {
  if (!transcript || transcript.assetId !== assetId) return assetCaptionTrackSchema.parse({assetId, captions: []});
  if (transcript.words.length) return assetCaptionTrackSchema.parse({assetId, captions: wordTimedCaptions(transcript)});
  const captions = transcript.segments.flatMap((source) => {
    const text = source.text.trim();
    if (!text || source.startMs >= source.endMs || source.endMs > transcript.durationMs) return [];
    const chunks = splitCaptionText(text);
    const durationMs = source.endMs - source.startMs;
    if (chunks.length <= 1 || durationMs < chunks.length) {
      return [autoCaptionSchema.parse({text, startMs: source.startMs, endMs: source.endMs, timestampMs: source.startMs, confidence: source.confidence})];
    }
    const characterCount = chunks.reduce((total, chunk) => total + captionCharacterCount(chunk), 0);
    let elapsedCharacters = 0;
    return chunks.map((chunk, index) => {
      const startMs = source.startMs + Math.round(durationMs * elapsedCharacters / characterCount);
      elapsedCharacters += captionCharacterCount(chunk);
      const endMs = index === chunks.length - 1
        ? source.endMs
        : source.startMs + Math.round(durationMs * elapsedCharacters / characterCount);
      return autoCaptionSchema.parse({text: chunk, startMs, endMs, timestampMs: startMs, confidence: source.confidence});
    });
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
