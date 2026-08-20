import {createHash, createHmac, timingSafeEqual} from 'node:crypto';
import {createReadStream, globSync} from 'node:fs';
import {mkdir, open, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import type {Artifact, Caption} from '../shared/contracts.js';
import type {StoredAsset} from './store.js';

const root = process.cwd();
const dataRoot = path.resolve(process.env.DATA_ROOT ?? path.join(root, 'data'));
const signingSecret = process.env.MEDIA_SIGNING_SECRET ?? 'washcut-local-development-signing-secret';
const publicBaseUrl = () => process.env.PUBLIC_API_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`;

const findBinary = (name: 'ffmpeg' | 'ffprobe') => {
  const override = process.env[name === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH'];
  if (override) return override;
  const extension = process.platform === 'win32' ? '.exe' : '';
  const candidates = globSync(`node_modules/.pnpm/@remotion+compositor-*/node_modules/@remotion/compositor-*/${name}${extension}`, {cwd: root});
  if (!candidates[0]) throw new Error(`${name}_binary_not_found`);
  return path.join(root, candidates[0]);
};

const ffmpegPath = findBinary('ffmpeg');
const ffprobePath = findBinary('ffprobe');

const run = (command: string, args: string[], options: {timeoutMs?: number; signal?: AbortSignal} = {}) => new Promise<{stdout: string; stderr: string}>((resolve, reject) => {
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
    else reject(new Error(`${path.basename(command)}_failed:${stderr.slice(-1200)}`));
  });
});

type Probe = {
  streams?: Array<{codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string; duration?: string}>;
  format?: {duration?: string; format_name?: string};
};

export const probeMedia = async (filePath: string) => {
  const result = await run(ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath], {timeoutMs: 60_000});
  const probe = JSON.parse(result.stdout) as Probe;
  const video = probe.streams?.find((stream) => stream.codec_type === 'video');
  const audio = probe.streams?.some((stream) => stream.codec_type === 'audio') ?? false;
  const [numerator, denominator] = (video?.avg_frame_rate ?? '0/1').split('/').map(Number);
  const durationSeconds = Number(video?.duration ?? probe.format?.duration ?? 0);
  return {
    durationMs: durationSeconds > 0 ? Math.round(durationSeconds * 1000) : undefined,
    width: video?.width,
    height: video?.height,
    fps: denominator ? numerator / denominator : undefined,
    hasAudio: audio,
    videoCodec: video?.codec_name,
    formatName: probe.format?.format_name,
  };
};

const detectContentType = (bytes: Buffer) => {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  if (bytes.subarray(4, 8).toString('ascii') === 'ftyp') return 'video/mp4';
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'video/webm';
  return undefined;
};

const extensionFor = (contentType: string) => ({'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'video/mp4': '.mp4', 'video/webm': '.webm'}[contentType] ?? '.bin');

export const processUploadedMedia = async (args: {
  tempPath: string;
  originalName: string;
  claimedType: string;
  sizeBytes: number;
  tenantId: string;
  projectId: string;
  ownerId: string;
  assetId: string;
}): Promise<StoredAsset> => {
  const header = (await readFile(args.tempPath)).subarray(0, 16);
  const contentType = detectContentType(header);
  if (!contentType || !args.claimedType.startsWith(contentType.split('/')[0])) throw new Error('asset_magic_mime_mismatch');
  const assetDir = path.join(dataRoot, 'objects', args.tenantId, args.projectId, args.assetId);
  await mkdir(path.join(assetDir, 'keyframes'), {recursive: true});
  const originalPath = path.join(assetDir, `original${extensionFor(contentType)}`);
  try {
    await rename(args.tempPath, originalPath);
    const probe = await probeMedia(originalPath);
    if (!probe.width || !probe.height) throw new Error('asset_video_stream_missing');
    if (probe.width * probe.height > 12_000_000 || Math.max(probe.width, probe.height) > 4096) throw new Error('asset_resolution_exceeded');
    if (probe.durationMs && probe.durationMs > 10 * 60_000) throw new Error('asset_duration_exceeded');

    const thumbnailPath = path.join(assetDir, 'thumbnail.jpg');
    const proxyPath = contentType.startsWith('video/') ? path.join(assetDir, 'proxy.mp4') : originalPath;
    const seekSeconds = Math.min(2, Math.max(0, (probe.durationMs ?? 0) / 5000));
    if (contentType.startsWith('video/')) {
      await run(ffmpegPath, ['-y', '-i', originalPath, '-vf', 'scale=720:-2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', proxyPath]);
      await run(ffmpegPath, ['-y', '-ss', String(seekSeconds), '-i', originalPath, '-frames:v', '1', '-vf', 'scale=640:-2', thumbnailPath], {timeoutMs: 60_000});
    } else {
      await run(ffmpegPath, ['-y', '-i', originalPath, '-frames:v', '1', '-vf', 'scale=640:-2', thumbnailPath], {timeoutMs: 60_000});
    }

    const points = contentType.startsWith('video/') && probe.durationMs
      ? [0, probe.durationMs / 3, probe.durationMs * 2 / 3]
      : [0];
    const keyframePaths: string[] = [];
    for (let index = 0; index < points.length; index += 1) {
      const keyframePath = path.join(assetDir, 'keyframes', `${index + 1}.jpg`);
      await run(ffmpegPath, ['-y', '-ss', String(points[index] / 1000), '-i', originalPath, '-frames:v', '1', '-vf', 'scale=512:-2', keyframePath], {timeoutMs: 60_000});
      keyframePaths.push(keyframePath);
    }
    const sha256 = createHash('sha256').update(await readFile(originalPath)).digest('hex');
    const createdAt = new Date().toISOString();
    return {
      assetId: args.assetId,
      tenantId: args.tenantId,
      projectId: args.projectId,
      ownerId: args.ownerId,
      originalPath,
      proxyPath,
      thumbnailPath,
      keyframePaths,
      createdAt,
      fileName: args.originalName,
      sha256,
      contentType,
      sizeBytes: args.sizeBytes,
      durationMs: probe.durationMs,
      width: probe.width,
      height: probe.height,
      fps: probe.fps,
      hasAudio: probe.hasAudio,
      sourceType: 'user_upload',
      status: 'ready',
      keyframeUrls: [],
      license: {recordId: `license_${args.assetId}`, label: '用户上传并确认授权', expiresAt: null},
    };
  } catch (error) {
    await rm(assetDir, {recursive: true, force: true});
    throw error;
  }
};

const signatureFor = (scope: string, resourceId: string, variant: string, expires: number) =>
  createHmac('sha256', signingSecret).update(`${scope}:${resourceId}:${variant}:${expires}`).digest('hex');

export const signedMediaUrl = (scope: 'asset' | 'job', resourceId: string, variant: string, ttlSeconds = 15 * 60) => {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const signature = signatureFor(scope, resourceId, variant, expires);
  const base = scope === 'asset' ? `/api/assets/${resourceId}/content` : `/api/jobs/${resourceId}/media/${variant}`;
  const query = scope === 'asset' ? `variant=${encodeURIComponent(variant)}&expires=${expires}&signature=${signature}` : `expires=${expires}&signature=${signature}`;
  return `${publicBaseUrl()}${base}?${query}`;
};

export const verifyMediaSignature = (scope: 'asset' | 'job', resourceId: string, variant: string, expiresValue: unknown, signatureValue: unknown) => {
  const expires = Number(expiresValue);
  const signature = String(signatureValue ?? '');
  if (!Number.isInteger(expires) || expires < Math.floor(Date.now() / 1000) || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const expected = signatureFor(scope, resourceId, variant, expires);
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
};

export const publicAsset = (asset: StoredAsset): import('../shared/contracts.js').AssetRef => ({
  assetId: asset.assetId,
  fileName: asset.fileName,
  sha256: asset.sha256,
  contentType: asset.contentType,
  sizeBytes: asset.sizeBytes,
  durationMs: asset.durationMs,
  width: asset.width,
  height: asset.height,
  fps: asset.fps,
  hasAudio: asset.hasAudio,
  sourceType: asset.sourceType,
  status: asset.status,
  previewUrl: signedMediaUrl('asset', asset.assetId, asset.contentType.startsWith('video/') ? 'proxy' : 'original', 60 * 60),
  thumbnailUrl: signedMediaUrl('asset', asset.assetId, 'thumbnail', 60 * 60),
  keyframeUrls: asset.keyframePaths.map((_, index) => signedMediaUrl('asset', asset.assetId, `keyframe-${index}`, 60 * 60)),
  license: asset.license,
});

const maxInlineAnalysisImages = 10;
const maxInlineAnalysisBytes = 6 * 1024 * 1024;
const maxProtocolImages = 10;
const maxProtocolImageBytes = 15 * 1024 * 1024;
const maxProtocolTotalImageBytes = 60 * 1024 * 1024;
const maxProtocolVideoBytes = 250 * 1024 * 1024;
const protocolFramesPerVideo = 3;
const protocolImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const protocolVideoTypes = new Set(['video/mp4', 'video/webm']);

const readFileHeader = async (filePath: string) => {
  const handle = await open(filePath, 'r');
  try {
    const header = Buffer.alloc(16);
    const {bytesRead} = await handle.read(header, 0, header.length, 0);
    return header.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
};

export type ProtocolTestMedia = {path: string; sizeBytes: number; fileName: string};

/**
 * Prepares only image files for an ad-hoc chat turn. The files are validated
 * from their bytes rather than their browser-provided MIME types, are passed
 * to the relay as data URLs, and are deleted by the route once the turn ends.
 */
export const prepareChatTestImages = async (uploads: ProtocolTestMedia[]) => {
  const imageUrls: string[] = [];
  let totalImageBytes = 0;
  for (const upload of uploads) {
    if (imageUrls.length >= maxProtocolImages) throw new Error('chat_image_count_exceeded');
    const bytes = await readFile(upload.path);
    const contentType = detectContentType(bytes.subarray(0, 16));
    if (!contentType || !protocolImageTypes.has(contentType)) throw new Error('chat_image_type_invalid');
    if (bytes.length > maxProtocolImageBytes) throw new Error('chat_image_too_large');
    if (totalImageBytes + bytes.length > maxProtocolTotalImageBytes) throw new Error('chat_images_too_large');
    totalImageBytes += bytes.length;
    imageUrls.push(`data:${contentType};base64,${bytes.toString('base64')}`);
  }
  return {imageUrls, uploadedImageCount: imageUrls.length};
};

/**
 * Responses vision models accept image inputs, not raw video modality. Images
 * stay on the documented input_image path; videos are probed locally and sampled
 * into JPEG keyframes before any request reaches the relay.
 */
export const prepareProtocolTestMedia = async (uploads: ProtocolTestMedia[]) => {
  const imageUrls: string[] = [];
  let totalImageBytes = 0;
  let totalVideoBytes = 0;
  let uploadedImageCount = 0;
  let uploadedVideoCount = 0;

  const addImage = async (imagePath: string, expectedContentType?: string) => {
    if (imageUrls.length >= maxProtocolImages) throw new Error('protocol_image_count_exceeded');
    const bytes = await readFile(imagePath);
    const contentType = expectedContentType ?? detectContentType(bytes.subarray(0, 16));
    if (!contentType || !protocolImageTypes.has(contentType)) throw new Error('protocol_image_type_invalid');
    if (bytes.length > maxProtocolImageBytes) throw new Error('protocol_image_too_large');
    if (totalImageBytes + bytes.length > maxProtocolTotalImageBytes) throw new Error('protocol_images_too_large');
    totalImageBytes += bytes.length;
    imageUrls.push(`data:${contentType};base64,${bytes.toString('base64')}`);
  };

  for (const upload of uploads) {
    const contentType = detectContentType(await readFileHeader(upload.path));
    if (!contentType) throw new Error('protocol_media_type_invalid');
    if (protocolImageTypes.has(contentType)) {
      uploadedImageCount += 1;
      if (upload.sizeBytes > maxProtocolImageBytes) throw new Error('protocol_image_too_large');
      await addImage(upload.path, contentType);
      continue;
    }
    if (!protocolVideoTypes.has(contentType)) throw new Error('protocol_media_type_invalid');
    uploadedVideoCount += 1;
    if (upload.sizeBytes > maxProtocolVideoBytes) throw new Error('protocol_video_too_large');
    totalVideoBytes += upload.sizeBytes;
    if (totalVideoBytes > maxProtocolVideoBytes) throw new Error('protocol_videos_too_large');
    if (imageUrls.length + protocolFramesPerVideo > maxProtocolImages) throw new Error('protocol_image_count_exceeded');
    const probe = await probeMedia(upload.path);
    if (!probe.width || !probe.height) throw new Error('protocol_video_stream_missing');
    const durationMs = probe.durationMs ?? 0;
    const positionsMs = durationMs > 0
      ? [0.1, 0.5, 0.9].map((ratio) => Math.max(0, Math.min(durationMs - 1, Math.round(durationMs * ratio))))
      : [0, 500, 1_000];
    const framePaths = positionsMs.map((_, index) => `${upload.path}.protocol-frame-${index + 1}.jpg`);
    try {
      for (let index = 0; index < framePaths.length; index += 1) {
        await run(ffmpegPath, [
          '-y', '-ss', String(positionsMs[index] / 1000), '-i', upload.path,
          '-frames:v', '1', '-vf', 'scale=768:-2', '-q:v', '3', framePaths[index],
        ], {timeoutMs: 60_000});
        await addImage(framePaths[index], 'image/jpeg');
      }
    } finally {
      await Promise.all(framePaths.map((framePath) => rm(framePath, {force: true}).catch(() => undefined)));
    }
  }
  return {imageUrls, uploadedImageCount, uploadedVideoCount};
};

/**
 * Keyframes are private files on this machine. A remote relay cannot fetch a
 * 127.0.0.1 signed URL, so asset analysis must receive the image bytes.
 */
export const readInlineAnalysisImages = async (assets: StoredAsset[]) => {
  const images: string[] = [];
  let totalBytes = 0;
  for (const asset of assets) {
    if (images.length >= maxInlineAnalysisImages) break;
    const paths = [...asset.keyframePaths, asset.thumbnailPath];
    let added = false;
    for (const imagePath of paths) {
      try {
        const bytes = await readFile(imagePath);
        totalBytes += bytes.length;
        if (totalBytes > maxInlineAnalysisBytes) throw new Error('asset_keyframes_too_large');
        images.push(`data:image/jpeg;base64,${bytes.toString('base64')}`);
        added = true;
        if (images.length >= maxInlineAnalysisImages) break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if (!added) continue;
  }
  if (!images.length) throw new Error('asset_keyframe_missing');
  return images;
};

export const assetVariantPath = (asset: StoredAsset, variant: string) => {
  if (variant === 'original') return asset.originalPath;
  if (variant === 'proxy') return asset.proxyPath;
  if (variant === 'thumbnail') return asset.thumbnailPath;
  const match = /^keyframe-(\d+)$/.exec(variant);
  return match ? asset.keyframePaths[Number(match[1])] : undefined;
};

const formatSrtTime = (milliseconds: number) => {
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1000);
  const millis = milliseconds % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
};

export const writeSrt = async (captions: Caption[], outputPath: string) => {
  const content = captions.map((caption, index) => `${index + 1}\n${formatSrtTime(caption.startMs)} --> ${formatSrtTime(caption.endMs)}\n${caption.text}\n`).join('\n');
  await writeFile(outputPath, content, 'utf8');
};

export const createAudioAssets = async (jobId: string, narration: string, durationMs: number, signal: AbortSignal) => {
  const jobDir = path.join(dataRoot, 'jobs', jobId);
  await mkdir(jobDir, {recursive: true});
  const textPath = path.join(jobDir, 'narration.txt');
  const voicePath = path.join(jobDir, 'voice.wav');
  const bgmPath = path.join(jobDir, 'bgm.wav');
  await writeFile(textPath, narration, 'utf8');
  if (process.platform === 'win32') {
    const scriptPath = path.join(jobDir, 'synthesize.ps1');
    const script = `param([string]$TextPath,[string]$OutputPath)\nAdd-Type -AssemblyName System.Speech\n$s=New-Object System.Speech.Synthesis.SpeechSynthesizer\n$v=$s.GetInstalledVoices() | Where-Object {$_.VoiceInfo.Culture.Name -eq 'zh-CN'} | Select-Object -First 1\nif($v){$s.SelectVoice($v.VoiceInfo.Name)}\n$s.Rate=1\n$s.SetOutputToWaveFile($OutputPath)\n$s.Speak([IO.File]::ReadAllText($TextPath,[Text.Encoding]::UTF8))\n$s.Dispose()\n`;
    await writeFile(scriptPath, script, 'utf8');
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', scriptPath, textPath, voicePath], {timeoutMs: 120_000, signal});
  } else {
    await run(ffmpegPath, ['-y', '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo`, '-t', String(durationMs / 1000), voicePath], {signal});
  }
  await run(ffmpegPath, ['-y', '-f', 'lavfi', '-i', `sine=frequency=174:sample_rate=48000:duration=${durationMs / 1000}`, '-af', 'volume=0.035', bgmPath], {signal});
  const voiceProbe = await probeMedia(voicePath);
  return {jobDir, voicePath, bgmPath, voiceDurationMs: voiceProbe.durationMs};
};

export const renderRemotion = async (propsPath: string, outputPath: string, signal: AbortSignal) => {
  const cli = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'remotion.cmd' : 'remotion');
  await run(cli, ['render', 'src/remotion/index.ts', 'WashcutMarketingVideo', outputPath, '--props', propsPath, '--codec', 'h264', '--overwrite'], {timeoutMs: 30 * 60_000, signal});
};

export const makeCover = async (videoPath: string, coverPath: string) => {
  await run(ffmpegPath, ['-y', '-ss', '1', '-i', videoPath, '-frames:v', '1', '-q:v', '2', coverPath], {timeoutMs: 120_000});
};

export const inspectRenderedVideo = async (videoPath: string, expectedDurationMs: number) => {
  const probe = await probeMedia(videoPath);
  const black = await run(ffmpegPath, ['-v', 'info', '-i', videoPath, '-vf', 'blackdetect=d=0.5:pix_th=0.98', '-an', '-f', 'null', '-'], {timeoutMs: 5 * 60_000}).catch((error: Error) => ({stdout: '', stderr: error.message}));
  const blackDuration = [...black.stderr.matchAll(/black_duration:([0-9.]+)/g)].reduce((sum, match) => sum + Number(match[1]), 0);
  return {
    ...probe,
    durationDeltaMs: Math.abs((probe.durationMs ?? 0) - expectedDurationMs),
    blackDurationMs: Math.round(blackDuration * 1000),
  };
};

export const createArtifact = async (jobId: string, kind: Artifact['kind'], fileName: string, contentType: string, filePath: string, durationMs?: number): Promise<Artifact> => {
  const info = await stat(filePath);
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return {
    artifactId: `artifact_${jobId}_${kind}`,
    kind,
    fileName,
    contentType,
    sizeBytes: info.size,
    sha256: hash.digest('hex'),
    durationMs,
    downloadUrl: signedMediaUrl('job', jobId, kind, 60 * 60),
  };
};

export const jobArtifactPath = (jobId: string, variant: string) => {
  const names: Record<string, string> = {video: 'final.mp4', cover: 'cover.jpg', captions: 'captions.srt', provenance: 'provenance.json', voice: 'voice.wav', bgm: 'bgm.wav'};
  const name = names[variant];
  return name ? path.join(dataRoot, 'jobs', jobId, name) : undefined;
};

export {ffmpegPath, ffprobePath};
