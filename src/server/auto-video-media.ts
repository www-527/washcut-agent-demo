import {createHash, createHmac, timingSafeEqual} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {access, mkdir, open, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import sharp from 'sharp';
import {
  assetMetadataSchema,
  type AssetMetadata,
  type StoredAutoVideoAsset,
  type StoredVideoScreenshot,
  type VideoTimeline,
} from '../shared/auto-video-contracts.js';
import {ffmpegPath, ffprobePath} from './media.js';

const root = process.cwd();
const dataRoot = path.resolve(process.env.DATA_ROOT ?? path.join(root, 'data'));
const autoVideoRoot = path.join(dataRoot, 'auto-video');
const signingSecret = process.env.MEDIA_SIGNING_SECRET ?? 'washcut-local-development-signing-secret';

const safeId = (value: string) => {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error('INVALID_UPLOAD');
  return value;
};

const runMedia = (command: string, args: string[], options: {timeoutMs?: number; signal?: AbortSignal} = {}) => new Promise<{stdout: string; stderr: string}>((resolve, reject) => {
  const child = spawn(command, args, {cwd: root, windowsHide: true, shell: process.platform === 'win32' && command.toLowerCase().endsWith('.cmd')});
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  const timeout = setTimeout(() => {
    child.kill('SIGKILL');
    reject(new Error('media_command_timeout'));
  }, options.timeoutMs ?? 10 * 60_000);
  const abort = () => child.kill('SIGKILL');
  options.signal?.addEventListener('abort', abort, {once: true});
  child.on('error', (error) => { clearTimeout(timeout); reject(error); });
  child.on('close', (code) => {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
    if (options.signal?.aborted) reject(new Error('cancelled'));
    else if (code === 0) resolve({stdout, stderr});
    else reject(new Error(`${path.basename(command)}_failed:${stderr.slice(-8_000)}`));
  });
});

type ProbeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  sample_rate?: string;
  channels?: number;
};

type Probe = {streams?: ProbeStream[]; format?: {duration?: string; format_name?: string}};

const parseFps = (value: string | undefined) => {
  const [numerator, denominator] = (value ?? '0/1').split('/').map(Number);
  const fps = denominator ? numerator / denominator : 0;
  return Number.isFinite(fps) && fps > 0 ? fps : 0;
};

export const probeAutoVideo = async (assetId: string, originalPath: string): Promise<AssetMetadata> => {
  const result = await runMedia(ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', originalPath], {timeoutMs: 60_000});
  const probe = JSON.parse(result.stdout) as Probe;
  const video = probe.streams?.find((stream) => stream.codec_type === 'video');
  if (!video) throw new Error('NO_VIDEO_STREAM');
  const width = video.width;
  const height = video.height;
  const durationSeconds = Number(video.duration ?? probe.format?.duration ?? 0);
  const durationMs = Math.round(durationSeconds * 1_000);
  const fps = parseFps(video.avg_frame_rate) || parseFps(video.r_frame_rate);
  if (typeof width !== 'number' || typeof height !== 'number' || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || durationMs <= 0 || fps <= 0 || !video.codec_name) {
    throw new Error('MEDIA_PROBE_FAILED');
  }
  const audio = probe.streams?.find((stream) => stream.codec_type === 'audio');
  const orientation = width === height ? 'square' : width > height ? 'landscape' : 'portrait';
  return assetMetadataSchema.parse({
    assetId,
    durationMs,
    width,
    height,
    fps,
    videoCodec: video.codec_name,
    hasAudio: Boolean(audio),
    audioCodec: audio?.codec_name,
    sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : undefined,
    channels: audio?.channels,
    orientation,
  });
};

const supportedVideoCodecs = new Set(['h264', 'hevc', 'h265', 'vp8', 'vp9', 'av1', 'mpeg4']);

export const isRemotionRenderable = (metadata: AssetMetadata) => supportedVideoCodecs.has(metadata.videoCodec.toLowerCase());

const extensionFor = (mimeType: string, originalName: string) => {
  const extension = path.extname(path.basename(originalName)).toLowerCase();
  if (['.mp4', '.webm', '.mov'].includes(extension)) return extension;
  return mimeType === 'video/webm' ? '.webm' : mimeType === 'video/quicktime' ? '.mov' : '.mp4';
};

const isMp4Family = (header: Buffer) => header.length >= 8 && header.subarray(4, 8).toString('ascii') === 'ftyp';
const isWebm = (header: Buffer) => header.length >= 4 && header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));

export const validateAutoVideoUpload = async (filePath: string, claimedMimeType: string, originalName: string) => {
  const handle = await open(filePath, 'r');
  let header: Buffer;
  try {
    header = Buffer.alloc(16);
    const {bytesRead} = await handle.read(header, 0, header.length, 0);
    header = header.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  const extension = path.extname(path.basename(originalName)).toLowerCase();
  if (!['.mp4', '.webm', '.mov'].includes(extension) || !claimedMimeType.startsWith('video/')) throw new Error('INVALID_UPLOAD');
  if (!isMp4Family(header) && !isWebm(header)) throw new Error('INVALID_UPLOAD');
  if (isWebm(header) && claimedMimeType !== 'video/webm') throw new Error('INVALID_UPLOAD');
  return isWebm(header) ? 'video/webm' : claimedMimeType === 'video/quicktime' ? 'video/quicktime' : 'video/mp4';
};

export const autoVideoPaths = (projectId: string, assetId?: string) => {
  const project = safeId(projectId);
  const asset = assetId ? safeId(assetId) : undefined;
  return {
    originalsRoot: path.join(autoVideoRoot, 'originals'),
    temporaryRoot: path.join(autoVideoRoot, 'temporary'),
    projectDir: path.join(autoVideoRoot, 'projects', project),
    assetOriginalDir: asset ? path.join(autoVideoRoot, 'originals', project, asset) : undefined,
    assetTemporaryDir: asset ? path.join(autoVideoRoot, 'temporary', project, asset) : undefined,
  };
};

export const autoVideoProjectArtifactPath = (projectId: string, fileName: string) => {
  if (!/^[a-zA-Z0-9_.-]+(?:[/\\][a-zA-Z0-9_.-]+)*$/.test(fileName)) throw new Error('INVALID_UPLOAD');
  return path.join(autoVideoPaths(projectId).projectDir, fileName);
};

export const autoVideoGenerationArtifactPath = (projectId: string, generationId: string, fileName: string) => {
  if (!/^[a-zA-Z0-9_.-]+(?:[/\\][a-zA-Z0-9_.-]+)*$/.test(fileName)) throw new Error('INVALID_UPLOAD');
  return path.join(autoVideoPaths(projectId).projectDir, 'generations', safeId(generationId), fileName);
};

export const hashFile = async (filePath: string) => {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
};

export const persistImmutableOriginal = async (args: {
  tempPath: string;
  projectId: string;
  assetId: string;
  mimeType: string;
  originalName: string;
}) => {
  const paths = autoVideoPaths(args.projectId, args.assetId);
  if (!paths.assetOriginalDir) throw new Error('INVALID_UPLOAD');
  await mkdir(paths.assetOriginalDir, {recursive: true});
  const originalPath = path.join(paths.assetOriginalDir, `original${extensionFor(args.mimeType, args.originalName)}`);
  const exists = await access(originalPath).then(() => true).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  if (exists) throw new Error('original_asset_immutable');
  await rename(args.tempPath, originalPath);
  return originalPath;
};

export const extractAnalysisAudio = async (asset: StoredAutoVideoAsset, signal?: AbortSignal) => {
  if (!asset.metadata?.hasAudio) return undefined;
  const paths = autoVideoPaths(asset.projectId, asset.id);
  if (!paths.assetTemporaryDir) throw new Error('AUDIO_EXTRACTION_FAILED');
  await mkdir(paths.assetTemporaryDir, {recursive: true});
  const output = path.join(paths.assetTemporaryDir, `${asset.id}-analysis.wav`);
  try {
    await runMedia(ffmpegPath, ['-y', '-i', asset.originalPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', output], {timeoutMs: 10 * 60_000, signal});
    return output;
  } catch (error) {
    await rm(output, {force: true}).catch(() => undefined);
    throw error;
  }
};

export const screenshotTimestamps = (durationMs: number) => {
  const duration = Math.max(1, durationMs);
  const points = new Set<number>();
  const add = (value: number) => points.add(Math.max(0, Math.min(duration - 1, Math.round(value))));
  add(Math.min(300, duration * 0.02));
  add(duration / 2);
  add(Math.max(0, duration - 300));
  const interval = duration <= 30_000 ? 8_000 : duration <= 120_000 ? 12_000 : 25_000;
  for (let timestamp = interval; timestamp < duration - interval / 2; timestamp += interval) add(timestamp);
  return [...points].sort((left, right) => left - right).slice(0, 24);
};

/** The balanced profile always observes the start, middle and end once. */
export const balancedScreenshotTimestamps = (durationMs: number) => {
  const duration = Math.max(1, durationMs);
  const points = new Set<number>();
  const add = (value: number) => points.add(Math.max(0, Math.min(duration - 1, Math.round(value))));
  add(Math.min(300, duration * 0.02));
  add(duration / 2);
  add(Math.max(0, duration - 300));
  return [...points].sort((left, right) => left - right);
};

export const extractScreenshots = async (asset: StoredAutoVideoAsset, signal?: AbortSignal, profile: 'balanced' | 'legacy' = 'legacy'): Promise<StoredVideoScreenshot[]> => {
  if (!asset.metadata) throw new Error('MEDIA_PROBE_FAILED');
  const paths = autoVideoPaths(asset.projectId, asset.id);
  if (!paths.assetTemporaryDir) throw new Error('SCREENSHOT_EXTRACTION_FAILED');
  const screenshotDir = path.join(paths.assetTemporaryDir, 'screenshots');
  await mkdir(screenshotDir, {recursive: true});
  const timestamps = profile === 'balanced' ? balancedScreenshotTimestamps(asset.metadata.durationMs) : screenshotTimestamps(asset.metadata.durationMs);
  const screenshots: StoredVideoScreenshot[] = [];
  try {
    for (let index = 0; index < timestamps.length; index += 1) {
      const timestampMs = timestamps[index]!;
      const filePath = path.join(screenshotDir, `${String(index + 1).padStart(2, '0')}-${timestampMs}.jpg`);
      await runMedia(ffmpegPath, [
        '-y', '-ss', String(timestampMs / 1_000), '-i', asset.originalPath,
        '-frames:v', '1', '-vf', "scale='min(1024,iw)':-2", '-q:v', '3', filePath,
      ], {timeoutMs: 60_000, signal});
      screenshots.push({id: `shot_${asset.id}_${index + 1}`, assetId: asset.id, timestampMs, filePath});
    }
    return screenshots;
  } catch (error) {
    await rm(screenshotDir, {recursive: true, force: true}).catch(() => undefined);
    throw error;
  }
};

export type ContactSheet = {filePath: string; panels: Array<{id: 'A' | 'B' | 'C'; timestampMs: number}>};

/**
 * Build one locally-rendered JPEG from the early, middle and late screenshots.
 * Sharp avoids the deliberately restricted Remotion FFmpeg build, which only
 * contains scale-related filters on some hosts.
 */
export const createContactSheet = async (screenshots: StoredVideoScreenshot[], signal?: AbortSignal): Promise<ContactSheet> => {
  if (!screenshots.length || screenshots.length > 3) throw new Error('SCREENSHOT_EXTRACTION_FAILED');
  if (signal?.aborted) throw new Error('cancelled');
  const first = screenshots[0]!;
  const paths = autoVideoPathsFromScreenshot(first.filePath);
  const output = path.join(paths, 'contact-sheet.jpg');
  const panels = screenshots.map((screenshot, index) => ({id: (['A', 'B', 'C'] as const)[index]!, timestampMs: screenshot.timestampMs}));
  const panelWidth = 512;
  const panelHeight = 896;
  const labelHeight = 78;
  const canvasWidth = panelWidth * screenshots.length;
  const canvasHeight = panelHeight + labelHeight;
  const formatTimestamp = (timestampMs: number) => `${(timestampMs / 1_000).toFixed(2)}s`;
  const label = (panel: ContactSheet['panels'][number], left: number) => Buffer.from(`
    <svg width="${panelWidth}" height="${labelHeight}" viewBox="0 0 ${panelWidth} ${labelHeight}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${panelWidth}" height="${labelHeight}" fill="#101827"/>
      <text x="28" y="49" fill="#ffffff" font-family="Arial, Microsoft YaHei, sans-serif" font-size="32" font-weight="700">${panel.id}</text>
      <text x="88" y="49" fill="#cbd5e1" font-family="Arial, Microsoft YaHei, sans-serif" font-size="25">${formatTimestamp(panel.timestampMs)}</text>
    </svg>`);
  try {
    const frames = await Promise.all(screenshots.map((screenshot) =>
      sharp(screenshot.filePath).rotate().resize(panelWidth, panelHeight, {fit: 'contain', background: '#000000'}).jpeg({quality: 86, mozjpeg: true}).toBuffer()));
    if (signal?.aborted) throw new Error('cancelled');
    await sharp({create: {width: canvasWidth, height: canvasHeight, channels: 3, background: '#000000'}})
      .composite([
        ...frames.map((input, index) => ({input, left: index * panelWidth, top: 0})),
        ...panels.map((panel, index) => ({input: label(panel, index * panelWidth), left: index * panelWidth, top: panelHeight})),
      ])
      .jpeg({quality: 86, mozjpeg: true})
      .toFile(output);
    if (signal?.aborted) throw new Error('cancelled');
    return {filePath: output, panels};
  } catch (error) {
    await rm(output, {force: true}).catch(() => undefined);
    throw error;
  }
};

/** Extract one high-resolution, disposable JPEG for an approved detail pass. */
export const extractDetailScreenshot = async (asset: StoredAutoVideoAsset, timestampMs: number, signal?: AbortSignal): Promise<StoredVideoScreenshot> => {
  if (!asset.metadata) throw new Error('MEDIA_PROBE_FAILED');
  const paths = autoVideoPaths(asset.projectId, asset.id);
  if (!paths.assetTemporaryDir) throw new Error('SCREENSHOT_EXTRACTION_FAILED');
  const timestamp = Math.max(0, Math.min(asset.metadata.durationMs - 1, Math.round(timestampMs)));
  const filePath = path.join(paths.assetTemporaryDir, `detail-${timestamp}.jpg`);
  try {
    await runMedia(ffmpegPath, ['-y', '-ss', String(timestamp / 1_000), '-i', asset.originalPath, '-frames:v', '1', '-vf', "scale='min(1920,iw)':-2", '-q:v', '2', filePath], {timeoutMs: 60_000, signal});
    return {id: `detail_${asset.id}_${timestamp}`, assetId: asset.id, timestampMs: timestamp, filePath};
  } catch (error) {
    await rm(filePath, {force: true}).catch(() => undefined);
    throw error;
  }
};

const autoVideoPathsFromScreenshot = (filePath: string) => path.dirname(path.dirname(filePath));

export const screenshotAsDataUrl = async (screenshot: StoredVideoScreenshot) => {
  const bytes = await readFile(screenshot.filePath);
  return `data:image/jpeg;base64,${bytes.toString('base64')}`;
};

export const writeProjectJson = async (projectId: string, fileName: string, value: unknown) => {
  const target = autoVideoProjectArtifactPath(projectId, fileName);
  await mkdir(path.dirname(target), {recursive: true});
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
  await rename(temporary, target);
  return target;
};

export const writeGenerationJson = async (projectId: string, generationId: string, fileName: string, value: unknown) => {
  const target = autoVideoGenerationArtifactPath(projectId, generationId, fileName);
  await mkdir(path.dirname(target), {recursive: true});
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
  await rename(temporary, target);
  return target;
};

export const writeRawTranscription = async (projectId: string, assetId: string, value: unknown) =>
  writeProjectJson(projectId, `transcription-${safeId(assetId)}.raw.json`, value);

export const writeGenerationRawTranscription = async (projectId: string, generationId: string, assetId: string, value: unknown) =>
  writeGenerationJson(projectId, generationId, `transcription-${safeId(assetId)}.raw.json`, value);

export const cleanupAssetAnalysisFiles = async (asset: StoredAutoVideoAsset) => {
  await Promise.all([
    asset.temporaryAudioPath ? rm(asset.temporaryAudioPath, {force: true}).catch(() => undefined) : Promise.resolve(),
    asset.contactSheetPath ? rm(asset.contactSheetPath, {force: true}).catch(() => undefined) : Promise.resolve(),
    ...asset.screenshots.map((screenshot) => rm(screenshot.filePath, {force: true}).catch(() => undefined)),
  ]);
  if (asset.screenshots[0]) {
    await rm(path.dirname(asset.screenshots[0].filePath), {recursive: true, force: true}).catch(() => undefined);
  }
  return {...asset, temporaryAudioPath: undefined, screenshots: [], contactSheetPath: undefined};
};

const signatureFor = (projectId: string, resource: 'original' | 'output' | 'captions', expires: number, assetId?: string, generationId?: string) =>
  createHmac('sha256', signingSecret).update(`auto-video:${projectId}:${generationId ?? ''}:${resource}:${assetId ?? ''}:${expires}`).digest('hex');

const publicBaseUrl = () => process.env.PUBLIC_API_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`;

export const signedAutoVideoUrl = (projectId: string, resource: 'original' | 'output' | 'captions', options: {assetId?: string; ttlSeconds?: number} = {}) => {
  const expires = Math.floor(Date.now() / 1_000) + (options.ttlSeconds ?? 6 * 60 * 60);
  const signature = signatureFor(projectId, resource, expires, options.assetId);
  const base = resource === 'original'
    ? `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(options.assetId ?? '')}/original`
    : resource === 'output'
      ? `/api/projects/${encodeURIComponent(projectId)}/output.mp4`
      : `/api/projects/${encodeURIComponent(projectId)}/captions.vtt`;
  return `${publicBaseUrl()}${base}?expires=${expires}&signature=${signature}`;
};

export const signedAutoVideoGenerationUrl = (projectId: string, generationId: string, resource: 'output' | 'captions', options: {ttlSeconds?: number} = {}) => {
  const expires = Math.floor(Date.now() / 1_000) + (options.ttlSeconds ?? 6 * 60 * 60);
  const signature = signatureFor(projectId, resource, expires, undefined, generationId);
  const base = resource === 'output'
    ? `/api/projects/${encodeURIComponent(projectId)}/generations/${encodeURIComponent(generationId)}/output.mp4`
    : `/api/projects/${encodeURIComponent(projectId)}/generations/${encodeURIComponent(generationId)}/captions.vtt`;
  return `${publicBaseUrl()}${base}?expires=${expires}&signature=${signature}`;
};

export const verifyAutoVideoSignature = (projectId: string, resource: 'original' | 'output' | 'captions', expiresValue: unknown, signatureValue: unknown, assetId?: string) => {
  const expires = Number(expiresValue);
  const signature = String(signatureValue ?? '');
  if (!Number.isInteger(expires) || expires < Math.floor(Date.now() / 1_000) || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const expected = signatureFor(projectId, resource, expires, assetId);
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
};

export const verifyAutoVideoGenerationSignature = (projectId: string, generationId: string, resource: 'output' | 'captions', expiresValue: unknown, signatureValue: unknown) => {
  const expires = Number(expiresValue);
  const signature = String(signatureValue ?? '');
  if (!Number.isInteger(expires) || expires < Math.floor(Date.now() / 1_000) || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const expected = signatureFor(projectId, resource, expires, undefined, generationId);
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
};

export const renderAutoVideo = async (projectId: string, timeline: VideoTimeline, signal?: AbortSignal) => {
  const propsPath = await writeProjectJson(projectId, 'render-props.json', {timeline});
  const outputPath = autoVideoProjectArtifactPath(projectId, 'output.mp4');
  const pendingPath = autoVideoProjectArtifactPath(projectId, 'output.next.mp4');
  const backupPath = autoVideoProjectArtifactPath(projectId, 'output.previous.mp4');
  await mkdir(path.dirname(outputPath), {recursive: true});
  await rm(pendingPath, {force: true}).catch(() => undefined);
  try {
    await runMedia(
      path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'remotion.cmd' : 'remotion'),
      ['render', 'src/remotion/index.ts', 'AutoVideoCompilation', pendingPath, '--props', propsPath, '--codec', 'h264', '--overwrite'],
      {timeoutMs: 30 * 60_000, signal},
    );
    await stat(pendingPath);
  } catch (error) {
    await rm(pendingPath, {force: true}).catch(() => undefined);
    throw error;
  } finally {
    await rm(propsPath, {force: true}).catch(() => undefined);
  }
  let previousMoved = false;
  try {
    await rm(backupPath, {force: true});
    if (await access(outputPath).then(() => true).catch(() => false)) {
      await rename(outputPath, backupPath);
      previousMoved = true;
    }
    await rename(pendingPath, outputPath);
    await rm(backupPath, {force: true});
  } catch (error) {
    if (previousMoved && await access(backupPath).then(() => true).catch(() => false) && !(await access(outputPath).then(() => true).catch(() => false))) {
      await rename(backupPath, outputPath).catch(() => undefined);
    }
    throw error;
  }
  return outputPath;
};

export const renderAutoVideoGeneration = async (projectId: string, generationId: string, timeline: VideoTimeline, signal?: AbortSignal) => {
  const propsPath = await writeGenerationJson(projectId, generationId, 'render-props.json', {timeline});
  const outputPath = autoVideoGenerationArtifactPath(projectId, generationId, 'output.mp4');
  const pendingPath = autoVideoGenerationArtifactPath(projectId, generationId, 'output.next.mp4');
  await mkdir(path.dirname(outputPath), {recursive: true});
  await rm(pendingPath, {force: true}).catch(() => undefined);
  try {
    await runMedia(
      path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'remotion.cmd' : 'remotion'),
      ['render', 'src/remotion/index.ts', 'AutoVideoCompilation', pendingPath, '--props', propsPath, '--codec', 'h264', '--overwrite'],
      {timeoutMs: 30 * 60_000, signal},
    );
    await stat(pendingPath);
    await rename(pendingPath, outputPath);
  } catch (error) {
    await rm(pendingPath, {force: true}).catch(() => undefined);
    throw error;
  } finally {
    await rm(propsPath, {force: true}).catch(() => undefined);
  }
  return outputPath;
};

export const inspectAutoVideoOutput = async (projectId: string) => {
  const outputPath = autoVideoProjectArtifactPath(projectId, 'output.mp4');
  const metadata = await probeAutoVideo(`output_${projectId}`, outputPath);
  const info = await stat(outputPath);
  return {outputPath, metadata, fileSize: info.size};
};

export const inspectAutoVideoGenerationOutput = async (projectId: string, generationId: string) => {
  const outputPath = autoVideoGenerationArtifactPath(projectId, generationId, 'output.mp4');
  const metadata = await probeAutoVideo(`output_${generationId}`, outputPath);
  const info = await stat(outputPath);
  return {outputPath, metadata, fileSize: info.size};
};
