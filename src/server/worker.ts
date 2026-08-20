import {randomUUID} from 'node:crypto';
import {access, mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {
  makeEnvelope,
  renderJobSchema,
  videoSpecSchema,
  type Envelope,
  type JobStage,
  type RegisteredSchema,
  type RenderJob,
  type TransportError,
} from '../shared/contracts.js';
import {
  createArtifact,
  createAudioAssets,
  inspectRenderedVideo,
  jobArtifactPath,
  makeCover,
  readInlineAnalysisImages,
  renderRemotion,
  signedMediaUrl,
  writeSrt,
} from './media.js';
import {analyzeAssets, buildQualityReport, buildVideoSpec, directCreative, validateVideoSpec} from './pipeline.js';
import {RelayClient} from './relay-client.js';
import {publicAsset} from './media.js';
import {SqliteStore} from './store.js';

type EventArgs = {type: string; schema: RegisteredSchema; data: unknown; producer: string};
type RelayResolver = (tenantId: string, keyId?: string) => RelayClient | undefined;

export class JobWorker {
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private running = 0;
  private readonly concurrency = Math.max(1, Number(process.env.WORKER_CONCURRENCY ?? 1));

  constructor(private readonly store: SqliteStore, private readonly resolveRelay?: RelayResolver) {}

  recover() {
    for (const job of this.store.listRecoverableJobs()) this.enqueue(job.jobId);
  }

  enqueue(jobId: string) {
    if (this.queued.has(jobId) || this.controllers.has(jobId)) return;
    this.queue.push(jobId);
    this.queued.add(jobId);
    this.drain();
  }

  cancel(jobId: string) {
    this.controllers.get(jobId)?.abort();
  }

  private drain() {
    while (this.running < this.concurrency && this.queue.length) {
      const jobId = this.queue.shift();
      if (!jobId) return;
      this.queued.delete(jobId);
      this.running += 1;
      void this.run(jobId).finally(() => {
        this.running -= 1;
        this.controllers.delete(jobId);
        this.drain();
      });
    }
  }

  private event(job: RenderJob, previous: Envelope | undefined, args: EventArgs) {
    return makeEnvelope({
      type: args.type,
      eventId: `evt_${randomUUID()}`,
      occurredAt: new Date().toISOString(),
      traceId: job.traceId,
      tenantId: job.tenantId,
      projectId: job.projectId,
      jobId: job.jobId,
      producer: args.producer,
      idempotencyKey: `${job.jobId}:${args.type}:${args.schema}:${job.attempt}`,
      schema: args.schema,
      data: args.data,
      causationId: previous?.eventId,
    });
  }

  private update(job: RenderJob, stage: JobStage, progress: number, patch: Partial<RenderJob> = {}, eventArgs?: EventArgs) {
    const next = renderJobSchema.parse({...job, ...patch, status: stage, progress, updatedAt: new Date().toISOString()});
    this.store.saveJob(next);
    if (eventArgs) {
      const events = this.store.getEvents(job.jobId);
      this.store.appendEvent(job.jobId, this.event(next, events.at(-1), eventArgs));
    }
    console.log(JSON.stringify({timestamp: next.updatedAt, level: 'info', event: 'job.stage_changed', jobId: next.jobId, traceId: next.traceId, tenantId: next.tenantId, stage, progress, attempt: next.attempt}));
    return next;
  }

  private assertActive(jobId: string, signal: AbortSignal) {
    if (signal.aborted || this.store.isCancelRequested(jobId)) throw new Error('cancelled');
  }

  private async run(jobId: string) {
    const controller = new AbortController();
    this.controllers.set(jobId, controller);
    this.store.clearCancel(jobId);
    let job = this.store.getJob(jobId);
    if (!job || ['completed', 'cancelled', 'awaiting_review'].includes(job.status)) return;
    try {
      const relay = job.mode === 'relay' ? this.resolveRelay?.(job.tenantId, job.relayKeyId) : undefined;
      if (job.mode === 'relay' && !relay) throw new Error('relay_key_unavailable');
      const storedAssets = this.store.resolveAssets(job.input.assetIds, job.tenantId, job.projectId);
      const assets = storedAssets.map(publicAsset);
      this.assertActive(jobId, controller.signal);

      let manifest = job.assetManifest;
      if (!manifest) {
        job = this.update(job, 'asset_analysis', 12, {}, {type: 'asset-analysis.requested', schema: 'project-input.v1', data: job.input, producer: 'washcut-orchestrator'});
        const imageDataUrls = relay ? await readInlineAnalysisImages(storedAssets) : undefined;
        manifest = await analyzeAssets(job.input, assets, relay, controller.signal, imageDataUrls, {
          ownerId: job.ownerId,
          projectId: job.projectId,
          jobId: job.jobId,
        });
        job = this.update(job, 'creative_direction', 30, {assetManifest: manifest}, {type: 'asset-manifest.created', schema: 'asset-manifest.v1', data: manifest, producer: 'asset-understanding-agent'});
      }
      this.assertActive(jobId, controller.signal);

      let creative = job.creativeSpec;
      if (!creative) {
        creative = await directCreative(job.input, manifest, relay, controller.signal, {
          ownerId: job.ownerId,
          projectId: job.projectId,
          jobId: job.jobId,
        });
        job = this.update(job, 'visual_direction', 47, {creativeSpec: creative}, {type: 'creative-spec.created', schema: 'creative-spec.v1', data: creative, producer: 'creative-director-agent'});
      }
      this.assertActive(jobId, controller.signal);

      let video = job.videoSpec;
      if (!video) {
        video = validateVideoSpec(buildVideoSpec(job.input, manifest, creative), manifest, creative);
        job = this.update(job, 'audio_production', 62, {videoSpec: video}, {type: 'video-spec.created', schema: 'video-spec.v1', data: video, producer: 'visual-director-agent'});
      }
      this.assertActive(jobId, controller.signal);

      const audio = await createAudioAssets(job.jobId, creative.voiceover.map((part) => part.text).join(' '), job.input.durationMs, controller.signal);
      video = videoSpecSchema.parse({
        ...video,
        audio: {
          voice: {assetId: `audio_${job.jobId}_voice`, url: signedMediaUrl('job', job.jobId, 'voice', 2 * 60 * 60), contentType: 'audio/wav', provider: process.platform === 'win32' ? 'windows-sapi-zh-cn' : 'silent-fallback', license: 'system-voice-runtime', durationMs: audio.voiceDurationMs},
          bgm: {assetId: `audio_${job.jobId}_bgm`, url: signedMediaUrl('job', job.jobId, 'bgm', 2 * 60 * 60), contentType: 'audio/wav', provider: 'ffmpeg-system-generated', license: 'system-generated', durationMs: job.input.durationMs},
          duckingDb: -12,
        },
      });
      job = this.update(job, 'rendering', 74, {videoSpec: video}, {type: 'render.requested', schema: 'video-spec.v1', data: video, producer: 'washcut-orchestrator'});

      const jobDir = audio.jobDir;
      const propsPath = path.join(jobDir, 'render-props.json');
      const outputPath = jobArtifactPath(job.jobId, 'video');
      const coverPath = jobArtifactPath(job.jobId, 'cover');
      const captionsPath = jobArtifactPath(job.jobId, 'captions');
      const provenancePath = jobArtifactPath(job.jobId, 'provenance');
      if (!outputPath || !coverPath || !captionsPath || !provenancePath) throw new Error('artifact_path_invalid');
      await mkdir(jobDir, {recursive: true});
      const renderMessage = makeEnvelope({
        type: 'render.requested', eventId: `evt_${randomUUID()}`, occurredAt: new Date().toISOString(), traceId: job.traceId,
        tenantId: job.tenantId, projectId: job.projectId, jobId: job.jobId, producer: 'media-worker',
        idempotencyKey: `${job.jobId}:render:${video.version}:${job.attempt}`, schema: 'video-spec.v1', data: video,
      });
      await Promise.all([
        writeFile(propsPath, JSON.stringify({message: renderMessage}), 'utf8'),
        writeSrt(video.captions, captionsPath),
        writeFile(provenancePath, JSON.stringify({jobId: job.jobId, projectId: job.projectId, traceId: job.traceId, specVersion: video.version, generatedAt: new Date().toISOString(), sources: video.provenance}, null, 2), 'utf8'),
      ]);
      const reusableRender = job.artifacts.some((artifact) => artifact.kind === 'video')
        && await access(outputPath).then(() => true).catch(() => false)
        && await access(coverPath).then(() => true).catch(() => false);
      if (!reusableRender) {
        await renderRemotion(propsPath, outputPath, controller.signal);
        this.assertActive(jobId, controller.signal);
        await makeCover(outputPath, coverPath);
      }

      job = this.update(job, 'quality_check', 91, {}, {type: 'quality-check.requested', schema: 'video-spec.v1', data: video, producer: 'media-worker'});
      const media = await inspectRenderedVideo(outputPath, job.input.durationMs);
      const quality = buildQualityReport(job.input, manifest, video, media);
      const artifacts = await Promise.all([
        createArtifact(job.jobId, 'video', `${job.projectId}.mp4`, 'video/mp4', outputPath, media.durationMs),
        createArtifact(job.jobId, 'cover', `${job.projectId}-cover.jpg`, 'image/jpeg', coverPath),
        createArtifact(job.jobId, 'captions', `${job.projectId}.srt`, 'application/x-subrip', captionsPath),
        createArtifact(job.jobId, 'provenance', `${job.projectId}-provenance.json`, 'application/json', provenancePath),
      ]);
      if (quality.decision !== 'passed') throw Object.assign(new Error('quality_failed'), {quality, artifacts});
      job = this.update(job, 'completed', 100, {qualityReport: quality, artifacts, review: {status: 'pending'}, error: undefined}, {type: 'quality-check.completed', schema: 'quality-report.v1', data: quality, producer: 'quality-check-agent'});
      this.store.audit(job.tenantId, 'media-worker', 'render.completed', 'job', job.jobId, {artifacts: artifacts.map((artifact) => artifact.artifactId)});
    } catch (error) {
      const latest = this.store.getJob(jobId);
      if (!latest) return;
      if (error instanceof Error && error.message === 'cancelled') {
        this.update(latest, 'cancelled', latest.progress, {}, {type: 'render-job.cancelled', schema: 'command-result.v1', data: {accepted: true}, producer: 'washcut-orchestrator'});
        return;
      }
      const source = error instanceof Error ? error as Error & {code?: unknown; retryable?: unknown} : undefined;
      const message = source?.message || String(error ?? 'unknown_error');
      const code = typeof source?.code === 'string' && source.code.trim() ? source.code : message;
      const structured: TransportError = {
        code,
        stage: latest.status,
        retryable: typeof source?.retryable === 'boolean' ? source.retryable : true,
        message,
        details: message,
      };
      const quality = error && typeof error === 'object' && 'quality' in error ? error.quality : latest.qualityReport;
      const artifacts = error && typeof error === 'object' && 'artifacts' in error ? error.artifacts : latest.artifacts;
      this.update(latest, 'failed', latest.progress, {error: structured, qualityReport: quality as RenderJob['qualityReport'], artifacts: artifacts as RenderJob['artifacts']}, {type: 'render.failed', schema: 'error.v1', data: structured, producer: 'media-worker'});
      this.store.audit(latest.tenantId, 'media-worker', 'render.failed', 'job', latest.jobId, {error: structured});
    }
  }
}
