import {mkdirSync} from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {
  assetRefSchema,
  envelopeSchema,
  relayKeySummarySchema,
  renderJobSchema,
  videoAnalysisTaskSchema,
  videoUploadSessionSchema,
  type AssetRef,
  type Envelope,
  type RelayKeySummary,
  type RenderJob,
  type VideoAnalysisTask,
  type VideoUploadSession,
} from '../shared/contracts.js';
import {
  AUTO_VIDEO_MAX_ASSET_COUNT,
  autoVideoGenerationSchema,
  autoVideoAssetCheckpointSchema,
  autoVideoProjectSchema,
  generationTerminalStatuses,
  makeInitialProcessingSteps,
  type AutoVideoGeneration,
  type AutoVideoAssetCheckpoint,
  storedAutoVideoAssetSchema,
  type AutoVideoProject,
  type StoredAutoVideoAsset,
} from '../shared/auto-video-contracts.js';
import {
  modelConversationRecordSchema,
  modelConversationSummarySchema,
  type ModelConversationRecord,
  type ModelConversationStatus,
  type ModelConversationSummary,
} from '../shared/model-conversations.js';
import {KeyVault, maskApiKey} from './key-vault.js';

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * New contracts deliberately reject unknown fields. Before parsing persisted
 * auto-video data, remove fields retired by earlier versions.
 * This is read-time compatibility only: historical JSON is never rewritten.
 */
const stripLegacySuggestedPosition = (payload: unknown): unknown => {
  if (!isRecord(payload)) return payload;
  const {sourceAssetId: _legacySourceAssetId, ...payloadWithoutSourceAssetId} = payload;
  const assetAnalyses = Array.isArray(payloadWithoutSourceAssetId.assetAnalyses)
    ? payloadWithoutSourceAssetId.assetAnalyses.map((analysis) => {
      if (!isRecord(analysis)) return analysis;
      const {suggestedPosition: _legacySuggestedPosition, ...withoutLegacyPosition} = analysis;
      return withoutLegacyPosition;
    })
    : payloadWithoutSourceAssetId.assetAnalyses;
  const visualAnalysis = isRecord(payloadWithoutSourceAssetId.visualAnalysis) ? payloadWithoutSourceAssetId.visualAnalysis : undefined;
  const visualValue = visualAnalysis && isRecord(visualAnalysis.value) ? visualAnalysis.value : undefined;
  const normalizedVisualAnalysis = visualAnalysis && visualValue
    ? (() => {
      const {suggestedPosition: _legacySuggestedPosition, ...withoutLegacyPosition} = visualValue;
      return {...visualAnalysis, value: withoutLegacyPosition};
    })()
    : visualAnalysis;
  const assets = Array.isArray(payloadWithoutSourceAssetId.assets)
    ? payloadWithoutSourceAssetId.assets.map((asset) => {
      if (!isRecord(asset)) return asset;
      const {sourceAssetId: _legacySourceAssetId, ...withoutSourceAssetId} = asset;
      return withoutSourceAssetId;
    })
    : payloadWithoutSourceAssetId.assets;
  return {
    ...payloadWithoutSourceAssetId,
    ...(Array.isArray(payloadWithoutSourceAssetId.assetAnalyses) ? {assetAnalyses} : {}),
    ...(normalizedVisualAnalysis ? {visualAnalysis: normalizedVisualAnalysis} : {}),
    ...(Array.isArray(payloadWithoutSourceAssetId.assets) ? {assets} : {}),
  };
};

export type StoredAsset = AssetRef & {
  tenantId: string;
  projectId: string;
  ownerId: string;
  originalPath: string;
  proxyPath: string;
  thumbnailPath: string;
  keyframePaths: string[];
  createdAt: string;
};

export type StoredRelayKey = Omit<RelayKeySummary, 'maskedKey'> & {tenantId: string; apiKey: string};

type RelayKeyRow = {
  key_id: string;
  tenant_id: string;
  name: string;
  base_url: string;
  model: string;
  encrypted_api_key: string;
  active: number;
  created_at: string;
  updated_at: string;
};

type ModelConversationFilters = {
  projectId?: string;
  generationId?: string;
  status?: ModelConversationStatus;
  source?: string;
  limit?: number;
};

const dataRoot = path.resolve(process.env.DATA_ROOT ?? path.join(process.cwd(), 'data'));
mkdirSync(dataRoot, {recursive: true});

const DEFAULT_AUTO_VIDEO_CANVAS = {width: 1080, height: 1920, fps: 30};

const normalizedLegacyTimestamp = (value: unknown, fallback: string) => {
  if (typeof value !== 'string') return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
};

const normalizedLegacyCanvas = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return DEFAULT_AUTO_VIDEO_CANVAS;
  const candidate = value as Record<string, unknown>;
  const {width, height, fps} = candidate;
  if (
    typeof width !== 'number' || !Number.isInteger(width) || width <= 0 ||
    typeof height !== 'number' || !Number.isInteger(height) || height <= 0 ||
    typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0
  ) return DEFAULT_AUTO_VIDEO_CANVAS;
  return {width, height, fps};
};

export class SqliteStore {
  private readonly db: DatabaseSync;
  private readonly keyVault: KeyVault;

  constructor(filePath = process.env.DATABASE_FILE ?? path.join(dataRoot, 'washcut.sqlite'), encryptionSecret?: string) {
    this.db = new DatabaseSync(filePath);
    this.keyVault = new KeyVault(filePath, encryptionSecret);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS assets (
        asset_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_assets_scope ON assets(tenant_id, project_id);
      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_scope ON jobs(tenant_id, owner_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        FOREIGN KEY(job_id) REFERENCES jobs(job_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_events_job ON events(job_id, sequence);
      CREATE TABLE IF NOT EXISTS idempotency (
        tenant_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        detail_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS relay_keys (
        key_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        model TEXT NOT NULL,
        encrypted_api_key TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_relay_keys_tenant ON relay_keys(tenant_id, updated_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_relay_keys_one_active ON relay_keys(tenant_id) WHERE active = 1;
      CREATE TABLE IF NOT EXISTS video_uploads (
        upload_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        status TEXT NOT NULL,
        idempotency_key TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_video_upload_idempotency ON video_uploads(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_video_upload_scope ON video_uploads(tenant_id, owner_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS video_upload_parts (
        upload_id TEXT NOT NULL,
        part_number INTEGER NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        file_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(upload_id, part_number),
        FOREIGN KEY(upload_id) REFERENCES video_uploads(upload_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS video_analysis_tasks (
        task_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        status TEXT NOT NULL,
        idempotency_key TEXT,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_video_task_idempotency ON video_analysis_tasks(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_video_task_scope ON video_analysis_tasks(tenant_id, owner_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        event_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        target_url TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        status TEXT NOT NULL,
        last_error TEXT,
        occurred_at TEXT NOT NULL,
        PRIMARY KEY(event_id, attempt),
        FOREIGN KEY(task_id) REFERENCES video_analysis_tasks(task_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS auto_video_projects (
        project_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_auto_video_projects_scope ON auto_video_projects(tenant_id, owner_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS auto_video_assets (
        asset_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        checksum TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_auto_video_assets_scope ON auto_video_assets(tenant_id, project_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_auto_video_assets_checksum ON auto_video_assets(tenant_id, project_id, checksum);
      CREATE TABLE IF NOT EXISTS auto_video_generations (
        generation_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        version_number INTEGER NOT NULL,
        status TEXT NOT NULL,
        ai_mode_json TEXT NOT NULL,
        connection_id TEXT,
        model TEXT,
        instruction_snapshot TEXT NOT NULL,
        asset_ids_json TEXT NOT NULL,
        steps_json TEXT NOT NULL,
        transcripts_json TEXT NOT NULL,
        screenshot_analyses_json TEXT NOT NULL,
        asset_analyses_json TEXT NOT NULL,
        edit_plan_json TEXT,
        timeline_json TEXT,
        output_json TEXT,
        error_code TEXT,
        error_message TEXT,
        artifact_storage TEXT NOT NULL DEFAULT 'generation',
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        idempotency_key TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, version_number)
      );
      CREATE INDEX IF NOT EXISTS idx_generations_scope ON auto_video_generations(tenant_id, owner_id, project_id, updated_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_generations_idempotency ON auto_video_generations(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE TABLE IF NOT EXISTS auto_video_asset_checkpoints (
        generation_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (generation_id, asset_id)
      );
      CREATE INDEX IF NOT EXISTS idx_auto_video_asset_checkpoints_generation
        ON auto_video_asset_checkpoints (tenant_id, generation_id);
      CREATE TABLE IF NOT EXISTS model_conversations (
        conversation_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        project_id TEXT,
        job_id TEXT,
        task_id TEXT,
        asset_id TEXT,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_model_conversations_scope ON model_conversations(tenant_id, owner_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_model_conversations_project ON model_conversations(tenant_id, project_id, started_at DESC);
      CREATE TABLE IF NOT EXISTS model_connection_health (
        tenant_id TEXT NOT NULL,
        key_id TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT NOT NULL,
        tested_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id, key_id)
      );
    `);
    // Asset identity is clip-scoped; identical uploads are still distinct
    // clips and must not be silently deduplicated.
    this.db.exec('DROP INDEX IF EXISTS idx_auto_video_assets_checksum');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_auto_video_assets_checksum ON auto_video_assets(tenant_id, project_id, checksum)');
    // Existing installations created model_conversations before generation
    // auditing existed. SQLite has no ADD COLUMN IF NOT EXISTS, so a duplicate
    // column error is intentionally ignored here.
    try { this.db.exec('ALTER TABLE model_conversations ADD COLUMN generation_id TEXT'); } catch { /* already migrated */ }
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_model_conversations_generation ON model_conversations(tenant_id, generation_id, started_at DESC)');
    this.migrateLegacyAutoVideoProjects();
    this.migrateMalformedAutoVideoGenerations();
  }

  /**
   * Converts the former single-project pipeline payload into a stable V1.
   * Old artifacts deliberately remain in place and the migrated generation
   * points at them read-only, so a failed migration can be restarted without
  * deleting MP4/VTT/original files.
  */
  private migrateLegacyAutoVideoProjects() {
    const rows = this.db.prepare('SELECT project_id, tenant_id, owner_id, status, created_at, updated_at, payload_json FROM auto_video_projects ORDER BY created_at').all() as Array<{
      project_id: string;
      tenant_id: string;
      owner_id: string;
      status: string;
      created_at: string;
      updated_at: string;
      payload_json: string;
    }>;
    for (const row of rows) {
      try {
        const parsedPayload = stripLegacySuggestedPosition(JSON.parse(row.payload_json));
        const raw = parsedPayload && typeof parsedPayload === 'object' && !Array.isArray(parsedPayload)
          ? parsedPayload as Record<string, unknown>
          : {};
        const oldStatus = typeof raw.status === 'string' ? raw.status : row.status;
        const legacyStatuses = new Set(['uploading', 'probing', 'analyzing', 'planning', 'timeline_ready', 'rendering', 'completed', 'failed']);
        const hasLegacySteps = Array.isArray(raw.steps) && raw.steps.length > 0;
        const needsNormalization = !autoVideoProjectSchema.safeParse(raw).success;
        if (!legacyStatuses.has(oldStatus) && !hasLegacySteps && !needsNormalization) continue;

        const projectId = typeof raw.id === 'string' && raw.id.trim() ? raw.id : row.project_id;
        const tenantId = typeof raw.tenantId === 'string' && raw.tenantId.trim() ? raw.tenantId : row.tenant_id;
        const ownerId = typeof raw.ownerId === 'string' && raw.ownerId.trim() ? raw.ownerId : row.owner_id;
        const now = new Date().toISOString();
        const createdAt = normalizedLegacyTimestamp(raw.createdAt, normalizedLegacyTimestamp(row.created_at, now));
        const updatedAt = normalizedLegacyTimestamp(raw.updatedAt, normalizedLegacyTimestamp(row.updated_at, createdAt));
        const canvas = normalizedLegacyCanvas(raw.canvas);
        const assetIds = Array.isArray(raw.assetIds)
          ? raw.assetIds.filter((value): value is string => typeof value === 'string' && value.length > 0).slice(0, AUTO_VIDEO_MAX_ASSET_COUNT)
          : [];
        const instruction = typeof raw.userInstruction === 'string' ? raw.userInstruction.slice(0, 2_000) : '';
        const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : '未命名视频编排项目';
        const existing = this.db.prepare('SELECT 1 FROM auto_video_generations WHERE project_id = ? LIMIT 1').get(projectId);
        if (!existing) {
          const status = !assetIds.length
            ? 'cancelled'
            : oldStatus === 'completed' ? 'completed'
              : oldStatus === 'failed' ? 'failed'
                : oldStatus === 'rendering' || oldStatus === 'timeline_ready' ? 'rendering'
                  : oldStatus === 'planning' ? 'planning'
                    : 'analyzing';
          const completed = status === 'completed' || status === 'failed' || status === 'cancelled';
          const output = raw.output;
          const candidate = {
            generationId: `generation_legacy_${projectId}`,
            projectId,
            tenantId,
            ownerId,
            versionNumber: 1,
            status,
            progress: typeof raw.progress === 'number' && Number.isFinite(raw.progress) ? Math.max(0, Math.min(100, Math.round(raw.progress))) : completed ? 100 : 0,
            aiMode: {kind: 'local', reason: 'no_model_connection'},
            instructionSnapshot: instruction,
            canvas,
            assetIds,
            steps: Array.isArray(raw.steps) && raw.steps.length ? raw.steps : makeInitialProcessingSteps(),
            transcripts: Array.isArray(raw.transcripts) ? raw.transcripts : [],
            screenshotAnalyses: Array.isArray(raw.screenshotAnalyses) ? raw.screenshotAnalyses : [],
            assetAnalyses: Array.isArray(raw.assetAnalyses) ? raw.assetAnalyses : [],
            ...(raw.editPlan ? {editPlan: raw.editPlan} : {}),
            ...(raw.timeline ? {timeline: raw.timeline} : {}),
            ...(output ? {output} : {}),
            ...(raw.error ? {error: raw.error} : {}),
            ...(output && typeof output === 'object' && (output as {status?: unknown}).status === 'ready' ? {artifactStorage: 'legacy_project'} : {}),
            createdAt,
            ...(status !== 'cancelled' ? {startedAt: createdAt} : {}),
            ...(completed ? {completedAt: updatedAt} : {}),
            updatedAt,
          };
          // A few pre-blueprint drafts omitted canvas/progress or used a
          // partial step shape. Preserve every valid legacy field; if an old
          // payload itself is malformed, retain the project and create a
          // recoverable, structurally valid V1 instead of breaking the list.
          const parsedCandidate = autoVideoGenerationSchema.safeParse(candidate);
          const legacyGeneration = parsedCandidate.success ? parsedCandidate.data : autoVideoGenerationSchema.parse({
            generationId: candidate.generationId,
            projectId,
            tenantId,
            ownerId,
            versionNumber: 1,
            status,
            progress: candidate.progress,
            aiMode: {kind: 'local', reason: 'no_model_connection'},
            instructionSnapshot: instruction,
            canvas,
            assetIds,
            steps: makeInitialProcessingSteps(),
            transcripts: [],
            screenshotAnalyses: [],
            assetAnalyses: [],
            createdAt,
            ...(status !== 'cancelled' ? {startedAt: createdAt} : {}),
            ...(completed ? {completedAt: updatedAt} : {}),
            updatedAt,
          });
          this.saveAutoVideoGeneration(legacyGeneration);
        }

        // The project is now only a mutable asset and intent container. Keep no
        // copied analysis/output data at this layer after the migration.
        const project = autoVideoProjectSchema.parse({
          id: projectId,
          tenantId,
          ownerId,
          name,
          ...(instruction ? {userInstruction: instruction} : {}),
          status: oldStatus === 'archived' ? 'archived' : assetIds.length ? 'ready' : 'draft',
          progress: 0,
          canvas,
          assetIds,
          steps: [],
          transcripts: [],
          screenshotAnalyses: [],
          assetAnalyses: [],
          createdAt,
          updatedAt,
        });
        this.saveAutoVideoProject(project);
      } catch (error) {
        // Leave the old row untouched if it is malformed. The migration is
        // intentionally idempotent and runs again on the next startup.
        console.error('[washcut] auto-video generation migration skipped:', error instanceof Error ? error.message : error);
      }
    }
  }

  /**
   * The first draft of the version migration wrote generation snapshots before
   * canvas/progress became mandatory. Repair those payloads in place so an
   * otherwise valid historical V1 can never make the project list fail.
   */
  private migrateMalformedAutoVideoGenerations() {
    const rows = this.db.prepare('SELECT generation_id, project_id, tenant_id, owner_id, version_number, status, created_at, updated_at, payload_json FROM auto_video_generations ORDER BY created_at').all() as Array<{
      generation_id: string;
      project_id: string;
      tenant_id: string;
      owner_id: string;
      version_number: number;
      status: string;
      created_at: string;
      updated_at: string;
      payload_json: string;
    }>;
    const validStatuses = new Set(['queued', 'analyzing', 'retry_waiting', 'planning', 'rendering', 'completed', 'failed', 'cancelled', 'needs_attention']);
    for (const row of rows) {
      try {
        const parsedPayload = stripLegacySuggestedPosition(JSON.parse(row.payload_json));
        const validGeneration = autoVideoGenerationSchema.safeParse(parsedPayload);
        if (validGeneration.success) {
          if (validGeneration.data.status === 'completed' && validGeneration.data.progress !== 100) {
            this.saveAutoVideoGeneration({...validGeneration.data, progress: 100});
          }
          continue;
        }
        const raw = parsedPayload && typeof parsedPayload === 'object' && !Array.isArray(parsedPayload)
          ? parsedPayload as Record<string, unknown>
          : {};
        const project = this.getAutoVideoProject(row.project_id, row.tenant_id);
        const now = new Date().toISOString();
        const createdAt = normalizedLegacyTimestamp(raw.createdAt, normalizedLegacyTimestamp(row.created_at, now));
        const updatedAt = normalizedLegacyTimestamp(raw.updatedAt, normalizedLegacyTimestamp(row.updated_at, createdAt));
        const status = typeof raw.status === 'string' && validStatuses.has(raw.status) ? raw.status : validStatuses.has(row.status) ? row.status : 'failed';
        const completed = status === 'completed' || status === 'failed' || status === 'cancelled';
        const assetIds = Array.isArray(raw.assetIds)
          ? raw.assetIds.filter((value): value is string => typeof value === 'string' && value.length > 0).slice(0, AUTO_VIDEO_MAX_ASSET_COUNT)
          : [];
        const instruction = typeof raw.instructionSnapshot === 'string' ? raw.instructionSnapshot.slice(0, 2_000) : project?.userInstruction ?? '';
        const candidate = {
          ...raw,
          generationId: typeof raw.generationId === 'string' && raw.generationId.trim() ? raw.generationId : row.generation_id,
          projectId: row.project_id,
          tenantId: row.tenant_id,
          ownerId: row.owner_id,
          versionNumber: row.version_number,
          status,
          progress: status === 'completed'
            ? 100
            : typeof raw.progress === 'number' && Number.isFinite(raw.progress)
              ? Math.max(0, Math.min(100, Math.round(raw.progress)))
              : completed ? 100 : 0,
          canvas: normalizedLegacyCanvas(raw.canvas ?? project?.canvas),
          assetIds,
          instructionSnapshot: instruction,
          createdAt,
          updatedAt,
        };
        const parsedCandidate = autoVideoGenerationSchema.safeParse(candidate);
        const generation = parsedCandidate.success ? parsedCandidate.data : autoVideoGenerationSchema.parse({
          generationId: row.generation_id,
          projectId: row.project_id,
          tenantId: row.tenant_id,
          ownerId: row.owner_id,
          versionNumber: row.version_number,
          status,
          progress: completed ? 100 : 0,
          aiMode: {kind: 'local', reason: 'no_model_connection'},
          instructionSnapshot: instruction,
          canvas: normalizedLegacyCanvas(project?.canvas),
          assetIds,
          steps: makeInitialProcessingSteps(),
          transcripts: [],
          screenshotAnalyses: [],
          assetAnalyses: [],
          createdAt,
          ...(status !== 'cancelled' ? {startedAt: createdAt} : {}),
          ...(completed ? {completedAt: updatedAt} : {}),
          updatedAt,
        });
        this.saveAutoVideoGeneration(generation);
      } catch (error) {
        console.error('[washcut] auto-video generation payload repair skipped:', error instanceof Error ? error.message : error);
      }
    }
  }

  close() {
    this.db.close();
  }

  saveAsset(asset: StoredAsset) {
    assetRefSchema.parse({
      assetId: asset.assetId, fileName: asset.fileName, sha256: asset.sha256, contentType: asset.contentType,
      sizeBytes: asset.sizeBytes, durationMs: asset.durationMs, width: asset.width, height: asset.height,
      fps: asset.fps, hasAudio: asset.hasAudio, sourceType: asset.sourceType, status: asset.status,
      previewUrl: asset.previewUrl, thumbnailUrl: asset.thumbnailUrl, keyframeUrls: asset.keyframeUrls, license: asset.license,
    });
    this.db.prepare(`INSERT OR REPLACE INTO assets(asset_id, tenant_id, project_id, owner_id, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(asset.assetId, asset.tenantId, asset.projectId, asset.ownerId, JSON.stringify(asset), asset.createdAt);
  }

  getAsset(assetId: string, tenantId: string): StoredAsset | undefined {
    const row = this.db.prepare('SELECT payload_json FROM assets WHERE asset_id = ? AND tenant_id = ?').get(assetId, tenantId) as {payload_json: string} | undefined;
    return row ? JSON.parse(row.payload_json) as StoredAsset : undefined;
  }

  getAssetById(assetId: string): StoredAsset | undefined {
    const row = this.db.prepare('SELECT payload_json FROM assets WHERE asset_id = ?').get(assetId) as {payload_json: string} | undefined;
    return row ? JSON.parse(row.payload_json) as StoredAsset : undefined;
  }

  resolveAssets(assetIds: string[], tenantId: string, projectId: string): StoredAsset[] {
    return assetIds.map((assetId) => {
      const asset = this.getAsset(assetId, tenantId);
      if (!asset || asset.projectId !== projectId || asset.status !== 'ready') throw new Error('asset_not_owned_or_ready');
      return asset;
    });
  }

  saveAutoVideoProject(project: AutoVideoProject) {
    const parsed = autoVideoProjectSchema.parse({...project, updatedAt: new Date().toISOString()});
    this.db.prepare(`INSERT INTO auto_video_projects(project_id, tenant_id, owner_id, status, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET status=excluded.status, payload_json=excluded.payload_json, updated_at=excluded.updated_at`)
      .run(parsed.id, parsed.tenantId, parsed.ownerId, parsed.status, JSON.stringify(parsed), parsed.createdAt, parsed.updatedAt);
    return parsed;
  }

  getAutoVideoProject(projectId: string, tenantId?: string): AutoVideoProject | undefined {
    const row = tenantId
      ? this.db.prepare('SELECT payload_json FROM auto_video_projects WHERE project_id = ? AND tenant_id = ?').get(projectId, tenantId)
      : this.db.prepare('SELECT payload_json FROM auto_video_projects WHERE project_id = ?').get(projectId) as {payload_json: string} | undefined;
    return row ? autoVideoProjectSchema.parse(stripLegacySuggestedPosition(JSON.parse((row as {payload_json: string}).payload_json))) : undefined;
  }

  listAutoVideoProjects(tenantId: string, ownerId: string, role: string): AutoVideoProject[] {
    const rows = role === 'admin'
      ? this.db.prepare('SELECT payload_json FROM auto_video_projects WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT 50').all(tenantId)
      : this.db.prepare('SELECT payload_json FROM auto_video_projects WHERE tenant_id = ? AND owner_id = ? ORDER BY updated_at DESC LIMIT 50').all(tenantId, ownerId);
    return rows.map((row) => autoVideoProjectSchema.parse(stripLegacySuggestedPosition(JSON.parse((row as {payload_json: string}).payload_json))));
  }

  listRecoverableAutoVideoProjects(): AutoVideoProject[] {
    const rows = this.db.prepare("SELECT payload_json FROM auto_video_projects WHERE status IN ('probing', 'analyzing', 'planning', 'timeline_ready', 'rendering') ORDER BY created_at").all();
    return rows.map((row) => autoVideoProjectSchema.parse(stripLegacySuggestedPosition(JSON.parse((row as {payload_json: string}).payload_json))));
  }

  saveAutoVideoGeneration(generation: AutoVideoGeneration, idempotencyKey?: string) {
    const parsed = autoVideoGenerationSchema.parse({...generation, updatedAt: new Date().toISOString()});
    this.db.prepare(`INSERT INTO auto_video_generations(
      generation_id, project_id, tenant_id, owner_id, version_number, status, ai_mode_json, connection_id, model,
      instruction_snapshot, asset_ids_json, steps_json, transcripts_json, screenshot_analyses_json, asset_analyses_json,
      edit_plan_json, timeline_json, output_json, error_code, error_message, artifact_storage, idempotency_key,
      payload_json, created_at, started_at, completed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(generation_id) DO UPDATE SET
      status=excluded.status, ai_mode_json=excluded.ai_mode_json, connection_id=excluded.connection_id, model=excluded.model,
      instruction_snapshot=excluded.instruction_snapshot, asset_ids_json=excluded.asset_ids_json, steps_json=excluded.steps_json,
      transcripts_json=excluded.transcripts_json, screenshot_analyses_json=excluded.screenshot_analyses_json,
      asset_analyses_json=excluded.asset_analyses_json, edit_plan_json=excluded.edit_plan_json, timeline_json=excluded.timeline_json,
      output_json=excluded.output_json, error_code=excluded.error_code, error_message=excluded.error_message,
      artifact_storage=excluded.artifact_storage, idempotency_key=COALESCE(excluded.idempotency_key, auto_video_generations.idempotency_key),
      payload_json=excluded.payload_json, started_at=excluded.started_at, completed_at=excluded.completed_at, updated_at=excluded.updated_at`)
      .run(
        parsed.generationId, parsed.projectId, parsed.tenantId, parsed.ownerId, parsed.versionNumber, parsed.status,
        JSON.stringify(parsed.aiMode), parsed.connectionId ?? null, parsed.model ?? null, parsed.instructionSnapshot,
        JSON.stringify(parsed.assetIds), JSON.stringify(parsed.steps), JSON.stringify(parsed.transcripts),
        JSON.stringify(parsed.screenshotAnalyses), JSON.stringify(parsed.assetAnalyses),
        parsed.editPlan ? JSON.stringify(parsed.editPlan) : null, parsed.timeline ? JSON.stringify(parsed.timeline) : null,
        parsed.output ? JSON.stringify(parsed.output) : null, parsed.error?.code ?? null, parsed.error?.message ?? null,
        parsed.artifactStorage, idempotencyKey ?? null, JSON.stringify(parsed), parsed.createdAt, parsed.startedAt ?? null,
        parsed.completedAt ?? null, parsed.updatedAt,
      );
    return parsed;
  }

  createAutoVideoGeneration(generation: Omit<AutoVideoGeneration, 'versionNumber'>, idempotencyKey?: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (idempotencyKey) {
        const existing = this.getAutoVideoGenerationByIdempotency(generation.tenantId, idempotencyKey);
        if (existing) { this.db.exec('COMMIT'); return existing; }
      }
      const row = this.db.prepare('SELECT COALESCE(MAX(version_number), 0) AS version_number FROM auto_video_generations WHERE project_id = ?').get(generation.projectId) as {version_number: number};
      const next = this.saveAutoVideoGeneration({...generation, versionNumber: row.version_number + 1}, idempotencyKey);
      this.db.exec('COMMIT');
      return next;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getAutoVideoGeneration(generationId: string, tenantId?: string): AutoVideoGeneration | undefined {
    const row = tenantId
      ? this.db.prepare('SELECT payload_json FROM auto_video_generations WHERE generation_id = ? AND tenant_id = ?').get(generationId, tenantId)
      : this.db.prepare('SELECT payload_json FROM auto_video_generations WHERE generation_id = ?').get(generationId) as {payload_json: string} | undefined;
    return row ? autoVideoGenerationSchema.parse(stripLegacySuggestedPosition(JSON.parse((row as {payload_json: string}).payload_json))) : undefined;
  }

  getAutoVideoAssetCheckpoint(generationId: string, assetId: string, tenantId: string): AutoVideoAssetCheckpoint | undefined {
    const row = this.db.prepare('SELECT payload_json FROM auto_video_asset_checkpoints WHERE generation_id = ? AND asset_id = ? AND tenant_id = ?')
      .get(generationId, assetId, tenantId) as {payload_json: string} | undefined;
    return row ? autoVideoAssetCheckpointSchema.parse(stripLegacySuggestedPosition(JSON.parse(row.payload_json))) : undefined;
  }

  listAutoVideoAssetCheckpoints(generationId: string, tenantId: string): AutoVideoAssetCheckpoint[] {
    const rows = this.db.prepare('SELECT payload_json FROM auto_video_asset_checkpoints WHERE generation_id = ? AND tenant_id = ? ORDER BY asset_id')
      .all(generationId, tenantId);
    return rows.map((row) => autoVideoAssetCheckpointSchema.parse(stripLegacySuggestedPosition(JSON.parse((row as {payload_json: string}).payload_json))));
  }

  /**
   * Checkpoints use an optimistic updatedAt guard. A stale writer is never
   * allowed to replace a completed checkpoint with older running work.
   */
  saveAutoVideoAssetCheckpoint(checkpoint: AutoVideoAssetCheckpoint, expectedUpdatedAt?: string) {
    const now = new Date().toISOString();
    const parsed = autoVideoAssetCheckpointSchema.parse({...checkpoint, updatedAt: now});
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // The tenant is not encoded in a checkpoint payload by design. Fetch it
      // from the generation inside the transaction before writing.
      const generation = this.getAutoVideoGeneration(parsed.generationId);
      if (!generation) throw new Error('checkpoint_generation_not_found');
      const current = this.getAutoVideoAssetCheckpoint(parsed.generationId, parsed.assetId, generation.tenantId);
      if (current && current.sourceChecksum !== parsed.sourceChecksum) throw new Error('checkpoint_source_checksum_mismatch');
      if (current?.visualAnalysis.status === 'completed' && parsed.visualAnalysis.status !== 'completed') {
        this.db.exec('COMMIT');
        return current;
      }
      if (current?.visualAnalysis.status === 'completed' && parsed.visualAnalysis.status === 'completed') {
        this.db.exec('COMMIT');
        return current;
      }
      if (expectedUpdatedAt && current && current.updatedAt !== expectedUpdatedAt) throw new Error('checkpoint_concurrent_update');
      this.db.prepare(`INSERT INTO auto_video_asset_checkpoints(generation_id, asset_id, tenant_id, payload_json, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(generation_id, asset_id) DO UPDATE SET payload_json=excluded.payload_json, updated_at=excluded.updated_at`)
        .run(parsed.generationId, parsed.assetId, generation.tenantId, JSON.stringify(parsed), parsed.updatedAt);
      this.db.exec('COMMIT');
      return parsed;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listDueAutoVideoGenerationRetries(now = new Date().toISOString()): AutoVideoGeneration[] {
    const rows = this.db.prepare(`SELECT payload_json FROM auto_video_generations
      WHERE status = 'retry_waiting'
        AND json_extract(payload_json, '$.retryState.nextRetryAt') IS NOT NULL
        AND json_extract(payload_json, '$.retryState.nextRetryAt') <= ?
      ORDER BY json_extract(payload_json, '$.retryState.nextRetryAt')`).all(now);
    return rows.map((row) => autoVideoGenerationSchema.parse(stripLegacySuggestedPosition(JSON.parse((row as {payload_json: string}).payload_json))));
  }

  getAutoVideoGenerationByIdempotency(tenantId: string, idempotencyKey: string): AutoVideoGeneration | undefined {
    const row = this.db.prepare('SELECT payload_json FROM auto_video_generations WHERE tenant_id = ? AND idempotency_key = ?').get(tenantId, idempotencyKey) as {payload_json: string} | undefined;
    return row ? autoVideoGenerationSchema.parse(stripLegacySuggestedPosition(JSON.parse(row.payload_json))) : undefined;
  }

  listAutoVideoGenerations(tenantId: string, ownerId: string, role: string, projectId: string, limit = 50): AutoVideoGeneration[] {
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const rows = role === 'admin'
      ? this.db.prepare('SELECT payload_json FROM auto_video_generations WHERE tenant_id = ? AND project_id = ? ORDER BY version_number DESC LIMIT ?').all(tenantId, projectId, safeLimit)
      : this.db.prepare('SELECT payload_json FROM auto_video_generations WHERE tenant_id = ? AND owner_id = ? AND project_id = ? ORDER BY version_number DESC LIMIT ?').all(tenantId, ownerId, projectId, safeLimit);
    return rows.map((row) => autoVideoGenerationSchema.parse(stripLegacySuggestedPosition(JSON.parse((row as {payload_json: string}).payload_json))));
  }

  getLatestAutoVideoGeneration(tenantId: string, ownerId: string, role: string, projectId: string): AutoVideoGeneration | undefined {
    return this.listAutoVideoGenerations(tenantId, ownerId, role, projectId, 1)[0];
  }

  countAutoVideoGenerations(tenantId: string, projectId: string) {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM auto_video_generations WHERE tenant_id = ? AND project_id = ?').get(tenantId, projectId) as {count: number};
    return row.count;
  }

  deleteAutoVideoGeneration(generationId: string, tenantId: string, projectId: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM auto_video_asset_checkpoints WHERE generation_id = ? AND tenant_id = ?').run(generationId, tenantId);
      this.db.prepare('DELETE FROM model_conversations WHERE generation_id = ? AND tenant_id = ?').run(generationId, tenantId);
      const deleted = this.db.prepare('DELETE FROM auto_video_generations WHERE generation_id = ? AND tenant_id = ? AND project_id = ?').run(generationId, tenantId, projectId).changes > 0;
      this.db.exec('COMMIT');
      return deleted;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listRecoverableAutoVideoGenerations(): AutoVideoGeneration[] {
    const placeholders = generationTerminalStatuses.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT payload_json FROM auto_video_generations WHERE status NOT IN (${placeholders}) ORDER BY created_at`).all(...generationTerminalStatuses);
    return rows.map((row) => autoVideoGenerationSchema.parse(stripLegacySuggestedPosition(JSON.parse((row as {payload_json: string}).payload_json))));
  }

  hasActiveAutoVideoGeneration(tenantId: string, projectId: string) {
    const terminal = generationTerminalStatuses.map(() => '?').join(',');
    return Boolean(this.db.prepare(`SELECT 1 FROM auto_video_generations WHERE tenant_id = ? AND project_id = ? AND status NOT IN (${terminal}) LIMIT 1`).get(tenantId, projectId, ...generationTerminalStatuses));
  }

  hasAnyActiveAutoVideoGeneration() {
    const terminal = generationTerminalStatuses.map(() => '?').join(',');
    return Boolean(this.db.prepare(`SELECT 1 FROM auto_video_generations WHERE status NOT IN (${terminal}) LIMIT 1`).get(...generationTerminalStatuses));
  }

  requestAutoVideoGenerationCancel(generationId: string, tenantId: string) {
    // A historical failure can contain an interrupted sibling step marked
    // running. The API only exposes cancellation for that inconsistent state,
    // but storage must still record it so a live worker can observe the abort.
    return this.db.prepare(`UPDATE auto_video_generations SET cancel_requested = 1
      WHERE generation_id = ? AND tenant_id = ? AND status NOT IN ('completed', 'cancelled', 'needs_attention')`)
      .run(generationId, tenantId).changes > 0;
  }

  clearAutoVideoGenerationCancel(generationId: string) {
    this.db.prepare('UPDATE auto_video_generations SET cancel_requested = 0 WHERE generation_id = ?').run(generationId);
  }

  isAutoVideoGenerationCancelRequested(generationId: string) {
    const row = this.db.prepare('SELECT cancel_requested FROM auto_video_generations WHERE generation_id = ?').get(generationId) as {cancel_requested: number} | undefined;
    return row?.cancel_requested === 1;
  }

  saveAutoVideoAsset(asset: StoredAutoVideoAsset) {
    const parsed = storedAutoVideoAssetSchema.parse(asset);
    const existing = this.getAutoVideoAsset(parsed.id, parsed.tenantId);
    if (existing && (existing.originalPath !== parsed.originalPath || existing.checksum !== parsed.checksum)) {
      throw new Error('original_asset_immutable');
    }
    this.db.prepare(`INSERT INTO auto_video_assets(asset_id, tenant_id, owner_id, project_id, checksum, status, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(asset_id) DO UPDATE SET status=excluded.status, payload_json=excluded.payload_json`)
      .run(parsed.id, parsed.tenantId, parsed.ownerId, parsed.projectId, parsed.checksum, parsed.status, JSON.stringify(parsed), parsed.createdAt);
    return parsed;
  }

  saveAutoVideoAssetsBatch(project: AutoVideoProject, assets: StoredAutoVideoAsset[]) {
    const parsedProject = autoVideoProjectSchema.parse(project);
    const parsedAssets = assets.map((asset) => storedAutoVideoAssetSchema.parse(asset));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const parsed of parsedAssets) {
        const existing = this.getAutoVideoAsset(parsed.id, parsed.tenantId);
        if (existing && (existing.originalPath !== parsed.originalPath || existing.checksum !== parsed.checksum)) throw new Error('original_asset_immutable');
        this.db.prepare(`INSERT INTO auto_video_assets(asset_id, tenant_id, owner_id, project_id, checksum, status, payload_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(asset_id) DO UPDATE SET status=excluded.status, payload_json=excluded.payload_json`)
          .run(parsed.id, parsed.tenantId, parsed.ownerId, parsed.projectId, parsed.checksum, parsed.status, JSON.stringify(parsed), parsed.createdAt);
      }
      this.db.prepare(`INSERT INTO auto_video_projects(project_id, tenant_id, owner_id, status, payload_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET status=excluded.status, payload_json=excluded.payload_json, updated_at=excluded.updated_at`)
        .run(parsedProject.id, parsedProject.tenantId, parsedProject.ownerId, parsedProject.status, JSON.stringify(parsedProject), parsedProject.createdAt, parsedProject.updatedAt);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return parsedProject;
  }

  getAutoVideoAsset(assetId: string, tenantId?: string): StoredAutoVideoAsset | undefined {
    const row = tenantId
      ? this.db.prepare('SELECT payload_json FROM auto_video_assets WHERE asset_id = ? AND tenant_id = ?').get(assetId, tenantId)
      : this.db.prepare('SELECT payload_json FROM auto_video_assets WHERE asset_id = ?').get(assetId) as {payload_json: string} | undefined;
    return row ? storedAutoVideoAssetSchema.parse(stripLegacySuggestedPosition(JSON.parse((row as {payload_json: string}).payload_json))) : undefined;
  }

  findAutoVideoAssetByChecksum(tenantId: string, projectId: string, checksum: string): StoredAutoVideoAsset | undefined {
    const row = this.db.prepare('SELECT payload_json FROM auto_video_assets WHERE tenant_id = ? AND project_id = ? AND checksum = ?').get(tenantId, projectId, checksum) as {payload_json: string} | undefined;
    return row ? storedAutoVideoAssetSchema.parse(stripLegacySuggestedPosition(JSON.parse(row.payload_json))) : undefined;
  }

  listAutoVideoAssets(tenantId: string, projectId: string): StoredAutoVideoAsset[] {
    const rows = this.db.prepare('SELECT payload_json FROM auto_video_assets WHERE tenant_id = ? AND project_id = ? ORDER BY created_at').all(tenantId, projectId);
    return rows.map((row) => storedAutoVideoAssetSchema.parse(stripLegacySuggestedPosition(JSON.parse((row as {payload_json: string}).payload_json))));
  }

  deleteAutoVideoAsset(assetId: string, tenantId: string, projectId: string) {
    return this.db.prepare('DELETE FROM auto_video_assets WHERE asset_id = ? AND tenant_id = ? AND project_id = ?').run(assetId, tenantId, projectId).changes > 0;
  }

  deleteAutoVideoProject(projectId: string, tenantId: string, ownerId?: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.hasActiveAutoVideoGeneration(tenantId, projectId)) throw new Error('auto_video_project_active');
      const deleted = ownerId
        ? this.db.prepare('DELETE FROM auto_video_projects WHERE project_id = ? AND tenant_id = ? AND owner_id = ?').run(projectId, tenantId, ownerId).changes > 0
        : this.db.prepare('DELETE FROM auto_video_projects WHERE project_id = ? AND tenant_id = ?').run(projectId, tenantId).changes > 0;
      if (deleted) {
        this.db.prepare('DELETE FROM auto_video_asset_checkpoints WHERE generation_id IN (SELECT generation_id FROM auto_video_generations WHERE project_id = ? AND tenant_id = ?)').run(projectId, tenantId);
        this.db.prepare('DELETE FROM model_conversations WHERE project_id = ? AND tenant_id = ?').run(projectId, tenantId);
        this.db.prepare('DELETE FROM auto_video_generations WHERE project_id = ? AND tenant_id = ?').run(projectId, tenantId);
        this.db.prepare('DELETE FROM auto_video_assets WHERE project_id = ? AND tenant_id = ?').run(projectId, tenantId);
      }
      this.db.exec('COMMIT');
      return deleted;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  resolveAutoVideoAssets(assetIds: string[], tenantId: string, projectId: string): StoredAutoVideoAsset[] {
    return assetIds.map((assetId) => {
      const asset = this.getAutoVideoAsset(assetId, tenantId);
      if (!asset || asset.projectId !== projectId || asset.status !== 'ready') throw new Error('auto_video_asset_not_owned_or_ready');
      return asset;
    });
  }

  isAutoVideoAssetReferencedByGeneration(tenantId: string, projectId: string, assetId: string) {
    const row = this.db.prepare(`SELECT 1 FROM auto_video_generations, json_each(auto_video_generations.asset_ids_json)
      WHERE auto_video_generations.tenant_id = ? AND auto_video_generations.project_id = ? AND json_each.value = ? LIMIT 1`)
      .get(tenantId, projectId, assetId);
    return Boolean(row);
  }

  private relayKeyFromRow(row: RelayKeyRow): StoredRelayKey {
    return {
      keyId: row.key_id,
      tenantId: row.tenant_id,
      name: row.name,
      baseUrl: row.base_url,
      model: row.model,
      apiKey: this.keyVault.decrypt(row.encrypted_api_key),
      active: row.active === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  relayKeySummary(key: StoredRelayKey): RelayKeySummary {
    return relayKeySummarySchema.parse({
      keyId: key.keyId,
      name: key.name,
      baseUrl: key.baseUrl,
      model: key.model,
      maskedKey: maskApiKey(key.apiKey),
      active: key.active,
      createdAt: key.createdAt,
      updatedAt: key.updatedAt,
    });
  }

  listRelayKeys(tenantId: string): RelayKeySummary[] {
    const rows = this.db.prepare('SELECT * FROM relay_keys WHERE tenant_id = ? ORDER BY active DESC, updated_at DESC').all(tenantId) as unknown as RelayKeyRow[];
    return rows.map((row) => this.relayKeySummary(this.relayKeyFromRow(row)));
  }

  getRelayKey(keyId: string, tenantId: string): StoredRelayKey | undefined {
    const row = this.db.prepare('SELECT * FROM relay_keys WHERE key_id = ? AND tenant_id = ?').get(keyId, tenantId) as RelayKeyRow | undefined;
    return row ? this.relayKeyFromRow(row) : undefined;
  }

  getActiveRelayKey(tenantId: string): StoredRelayKey | undefined {
    const row = this.db.prepare('SELECT * FROM relay_keys WHERE tenant_id = ? AND active = 1').get(tenantId) as RelayKeyRow | undefined;
    return row ? this.relayKeyFromRow(row) : undefined;
  }

  saveRelayKey(key: StoredRelayKey) {
    const active = key.active || !this.db.prepare('SELECT 1 FROM relay_keys WHERE tenant_id = ? LIMIT 1').get(key.tenantId);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (active) this.db.prepare('UPDATE relay_keys SET active = 0 WHERE tenant_id = ?').run(key.tenantId);
      this.db.prepare(`INSERT INTO relay_keys(key_id, tenant_id, name, base_url, model, encrypted_api_key, active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key_id) DO UPDATE SET name=excluded.name, base_url=excluded.base_url, model=excluded.model,
          encrypted_api_key=excluded.encrypted_api_key, active=excluded.active, updated_at=excluded.updated_at`)
        .run(key.keyId, key.tenantId, key.name, key.baseUrl, key.model, this.keyVault.encrypt(key.apiKey), active ? 1 : 0, key.createdAt, key.updatedAt);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getRelayKey(key.keyId, key.tenantId)!;
  }

  activateRelayKey(keyId: string, tenantId: string, updatedAt: string): StoredRelayKey | undefined {
    if (!this.getRelayKey(keyId, tenantId)) return undefined;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE relay_keys SET active = 0 WHERE tenant_id = ?').run(tenantId);
      this.db.prepare('UPDATE relay_keys SET active = 1, updated_at = ? WHERE key_id = ? AND tenant_id = ?').run(updatedAt, keyId, tenantId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getRelayKey(keyId, tenantId);
  }

  deleteRelayKey(keyId: string, tenantId: string) {
    const existing = this.getRelayKey(keyId, tenantId);
    if (!existing) return false;
    this.db.prepare('DELETE FROM relay_keys WHERE key_id = ? AND tenant_id = ?').run(keyId, tenantId);
    if (existing.active) {
      const fallback = this.db.prepare('SELECT key_id FROM relay_keys WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT 1').get(tenantId) as {key_id: string} | undefined;
      if (fallback) this.activateRelayKey(fallback.key_id, tenantId, new Date().toISOString());
    }
    return true;
  }

  saveModelConnectionHealth(tenantId: string, keyId: string, result: {ok: boolean; message: string; testedAt?: string}) {
    const testedAt = result.testedAt ?? new Date().toISOString();
    this.db.prepare(`INSERT INTO model_connection_health(tenant_id, key_id, status, message, tested_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, key_id) DO UPDATE SET status=excluded.status, message=excluded.message, tested_at=excluded.tested_at`)
      .run(tenantId, keyId, result.ok ? 'connected' : 'failed', result.message.slice(0, 1_000), testedAt);
  }

  getModelConnectionHealth(tenantId: string, keyId: string) {
    const row = this.db.prepare('SELECT status, message, tested_at FROM model_connection_health WHERE tenant_id = ? AND key_id = ?').get(tenantId, keyId) as {status: string; message: string; tested_at: string} | undefined;
    return row ? {ok: row.status === 'connected', message: row.message, testedAt: row.tested_at} : undefined;
  }

  saveModelConversation(record: ModelConversationRecord) {
    const parsed = modelConversationRecordSchema.parse(record);
    // Keep progress updates visible to detail readers at every point. SQLite's
    // INSERT OR REPLACE deletes the existing row before inserting the new one,
    // which creates a small 404 window while an SSE stream is being persisted.
    // Use a real upsert so a selected streaming record is never transiently
    // missing from the detail endpoint.
    this.db.prepare(`INSERT INTO model_conversations(
      conversation_id, tenant_id, owner_id, project_id, generation_id, job_id, task_id, asset_id, source, status, started_at, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET
      tenant_id=excluded.tenant_id,
      owner_id=excluded.owner_id,
      project_id=excluded.project_id,
      generation_id=excluded.generation_id,
      job_id=excluded.job_id,
      task_id=excluded.task_id,
      asset_id=excluded.asset_id,
      source=excluded.source,
      status=excluded.status,
      started_at=excluded.started_at,
      payload_json=excluded.payload_json`)
      .run(
        parsed.id,
        parsed.tenantId,
        parsed.ownerId,
        parsed.projectId ?? null,
        parsed.generationId ?? null,
        parsed.jobId ?? null,
        parsed.taskId ?? null,
        parsed.assetId ?? null,
        parsed.source,
        parsed.status,
        parsed.startedAt,
        JSON.stringify(parsed),
      );
    return parsed;
  }

  listModelConversations(tenantId: string, ownerId: string, role: string, filters: ModelConversationFilters = {}): ModelConversationSummary[] {
    const clauses = ['tenant_id = ?'];
    const parameters: Array<string | number> = [tenantId];
    if (role !== 'admin') {
      clauses.push('owner_id = ?');
      parameters.push(ownerId);
    }
    if (filters.projectId) {
      clauses.push('project_id = ?');
      parameters.push(filters.projectId);
    }
    if (filters.generationId) {
      clauses.push('generation_id = ?');
      parameters.push(filters.generationId);
    }
    if (filters.status) {
      clauses.push('status = ?');
      parameters.push(filters.status);
    }
    if (filters.source) {
      clauses.push('source = ?');
      parameters.push(filters.source);
    }
    const limit = Math.max(1, Math.min(filters.limit ?? 100, 300));
    parameters.push(limit);
    const rows = this.db.prepare(`SELECT payload_json FROM model_conversations WHERE ${clauses.join(' AND ')} ORDER BY started_at DESC LIMIT ?`).all(...parameters);
    return rows.map((row) => {
      const record = modelConversationRecordSchema.parse(JSON.parse((row as {payload_json: string}).payload_json));
      const requestPreview = record.requestMessages.map((message) => message.content).join(' ').replace(/\s+/g, ' ').trim().slice(0, 420);
      const responsePreview = record.responseText?.replace(/\s+/g, ' ').trim().slice(0, 420) || record.errorMessage?.slice(0, 420);
      return modelConversationSummarySchema.parse({
        id: record.id,
        projectId: record.projectId,
        generationId: record.generationId,
        jobId: record.jobId,
        taskId: record.taskId,
        assetId: record.assetId,
        source: record.source,
        model: record.model,
        startedAt: record.startedAt,
        completedAt: record.completedAt,
        latencyMs: record.latencyMs,
        attempts: record.attempts,
        status: record.status,
        requestPreview,
        responsePreview,
        messageCount: record.requestMessages.length,
      });
    });
  }

  getModelConversation(conversationId: string, tenantId: string, ownerId: string, role: string): ModelConversationRecord | undefined {
    const row = role === 'admin'
      ? this.db.prepare('SELECT payload_json FROM model_conversations WHERE conversation_id = ? AND tenant_id = ?').get(conversationId, tenantId)
      : this.db.prepare('SELECT payload_json FROM model_conversations WHERE conversation_id = ? AND tenant_id = ? AND owner_id = ?').get(conversationId, tenantId, ownerId) as {payload_json: string} | undefined;
    return row ? modelConversationRecordSchema.parse(JSON.parse((row as {payload_json: string}).payload_json)) : undefined;
  }

  saveJob(job: RenderJob) {
    const parsed = renderJobSchema.parse(job);
    this.db.prepare(`INSERT INTO jobs(job_id, tenant_id, project_id, owner_id, status, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET status=excluded.status, payload_json=excluded.payload_json, updated_at=excluded.updated_at`)
      .run(parsed.jobId, parsed.tenantId, parsed.projectId, parsed.ownerId, parsed.status, JSON.stringify(parsed), parsed.createdAt, parsed.updatedAt);
  }

  saveVideoUpload(session: VideoUploadSession, idempotencyKey?: string) {
    const parsed = videoUploadSessionSchema.parse(session);
    this.db.prepare(`INSERT INTO video_uploads(upload_id, tenant_id, owner_id, project_id, status, idempotency_key, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(upload_id) DO UPDATE SET status=excluded.status, payload_json=excluded.payload_json, updated_at=excluded.updated_at`)
      .run(parsed.upload_id, parsed.tenant_id, parsed.owner_id, parsed.project_id, parsed.status, idempotencyKey ?? null, JSON.stringify(parsed), parsed.created_at, parsed.updated_at);
  }

  getVideoUpload(uploadId: string, tenantId: string, ownerId?: string): VideoUploadSession | undefined {
    const row = ownerId
      ? this.db.prepare('SELECT payload_json FROM video_uploads WHERE upload_id = ? AND tenant_id = ? AND owner_id = ?').get(uploadId, tenantId, ownerId)
      : this.db.prepare('SELECT payload_json FROM video_uploads WHERE upload_id = ? AND tenant_id = ?').get(uploadId, tenantId) as {payload_json: string} | undefined;
    return row ? videoUploadSessionSchema.parse(JSON.parse((row as {payload_json: string}).payload_json)) : undefined;
  }

  getVideoUploadByIdempotency(tenantId: string, key: string): VideoUploadSession | undefined {
    const row = this.db.prepare('SELECT payload_json FROM video_uploads WHERE tenant_id = ? AND idempotency_key = ?').get(tenantId, key) as {payload_json: string} | undefined;
    return row ? videoUploadSessionSchema.parse(JSON.parse(row.payload_json)) : undefined;
  }

  saveVideoUploadPart(part: {uploadId: string; partNumber: number; sizeBytes: number; sha256: string; filePath: string}) {
    this.db.prepare(`INSERT INTO video_upload_parts(upload_id, part_number, size_bytes, sha256, file_path, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(upload_id, part_number) DO UPDATE SET size_bytes=excluded.size_bytes, sha256=excluded.sha256, file_path=excluded.file_path, created_at=excluded.created_at`)
      .run(part.uploadId, part.partNumber, part.sizeBytes, part.sha256, part.filePath, new Date().toISOString());
  }

  listVideoUploadParts(uploadId: string) {
    return this.db.prepare('SELECT part_number, size_bytes, sha256, file_path FROM video_upload_parts WHERE upload_id = ? ORDER BY part_number').all(uploadId) as Array<{part_number: number; size_bytes: number; sha256: string; file_path: string}>;
  }

  saveVideoAnalysisTask(task: VideoAnalysisTask, idempotencyKey?: string) {
    const parsed = videoAnalysisTaskSchema.parse(task);
    this.db.prepare(`INSERT INTO video_analysis_tasks(task_id, tenant_id, owner_id, project_id, status, idempotency_key, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET status=excluded.status, payload_json=excluded.payload_json, updated_at=excluded.updated_at`)
      .run(parsed.task_id, parsed.tenant_id, parsed.owner_id, parsed.project_id, parsed.status, idempotencyKey ?? null, JSON.stringify(parsed), parsed.created_at, parsed.updated_at);
  }

  getVideoAnalysisTask(taskId: string, tenantId?: string): VideoAnalysisTask | undefined {
    const row = tenantId
      ? this.db.prepare('SELECT payload_json FROM video_analysis_tasks WHERE task_id = ? AND tenant_id = ?').get(taskId, tenantId)
      : this.db.prepare('SELECT payload_json FROM video_analysis_tasks WHERE task_id = ?').get(taskId) as {payload_json: string} | undefined;
    return row ? videoAnalysisTaskSchema.parse(JSON.parse((row as {payload_json: string}).payload_json)) : undefined;
  }

  getVideoAnalysisTaskByIdempotency(tenantId: string, key: string): VideoAnalysisTask | undefined {
    const row = this.db.prepare('SELECT payload_json FROM video_analysis_tasks WHERE tenant_id = ? AND idempotency_key = ?').get(tenantId, key) as {payload_json: string} | undefined;
    return row ? videoAnalysisTaskSchema.parse(JSON.parse(row.payload_json)) : undefined;
  }

  listRecoverableVideoAnalysisTasks(): VideoAnalysisTask[] {
    const rows = this.db.prepare("SELECT payload_json FROM video_analysis_tasks WHERE status IN ('queued', 'processing') ORDER BY created_at").all();
    return rows.map((row) => videoAnalysisTaskSchema.parse(JSON.parse((row as {payload_json: string}).payload_json)));
  }

  requestVideoAnalysisCancel(taskId: string, tenantId: string) {
    return this.db.prepare('UPDATE video_analysis_tasks SET cancel_requested = 1 WHERE task_id = ? AND tenant_id = ?').run(taskId, tenantId).changes > 0;
  }

  clearVideoAnalysisCancel(taskId: string) {
    this.db.prepare('UPDATE video_analysis_tasks SET cancel_requested = 0 WHERE task_id = ?').run(taskId);
  }

  isVideoAnalysisCancelRequested(taskId: string) {
    const row = this.db.prepare('SELECT cancel_requested FROM video_analysis_tasks WHERE task_id = ?').get(taskId) as {cancel_requested: number} | undefined;
    return row?.cancel_requested === 1;
  }

  saveWebhookDelivery(args: {eventId: string; taskId: string; targetUrl: string; attempt: number; status: string; error?: string}) {
    this.db.prepare(`INSERT OR REPLACE INTO webhook_deliveries(event_id, task_id, target_url, attempt, status, last_error, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(args.eventId, args.taskId, args.targetUrl, args.attempt, args.status, args.error ?? null, new Date().toISOString());
  }

  getJob(jobId: string, tenantId?: string): RenderJob | undefined {
    const row = tenantId
      ? this.db.prepare('SELECT payload_json FROM jobs WHERE job_id = ? AND tenant_id = ?').get(jobId, tenantId)
      : this.db.prepare('SELECT payload_json FROM jobs WHERE job_id = ?').get(jobId) as {payload_json: string} | undefined;
    return row ? renderJobSchema.parse(JSON.parse((row as {payload_json: string}).payload_json)) : undefined;
  }

  listJobs(tenantId: string, ownerId: string, role: string): RenderJob[] {
    const rows = role === 'admin'
      ? this.db.prepare('SELECT payload_json FROM jobs WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT 50').all(tenantId)
      : this.db.prepare('SELECT payload_json FROM jobs WHERE tenant_id = ? AND owner_id = ? ORDER BY updated_at DESC LIMIT 50').all(tenantId, ownerId);
    return rows.map((row) => renderJobSchema.parse(JSON.parse((row as {payload_json: string}).payload_json)));
  }

  listRecoverableJobs(): RenderJob[] {
    const terminal = ['completed', 'failed', 'cancelled', 'awaiting_review'];
    const placeholders = terminal.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT payload_json FROM jobs WHERE status NOT IN (${placeholders}) ORDER BY created_at`).all(...terminal);
    return rows.map((row) => renderJobSchema.parse(JSON.parse((row as {payload_json: string}).payload_json)));
  }

  requestCancel(jobId: string, tenantId: string): boolean {
    const result = this.db.prepare('UPDATE jobs SET cancel_requested = 1 WHERE job_id = ? AND tenant_id = ?').run(jobId, tenantId);
    return result.changes > 0;
  }

  clearCancel(jobId: string) {
    this.db.prepare('UPDATE jobs SET cancel_requested = 0 WHERE job_id = ?').run(jobId);
  }

  isCancelRequested(jobId: string): boolean {
    const row = this.db.prepare('SELECT cancel_requested FROM jobs WHERE job_id = ?').get(jobId) as {cancel_requested: number} | undefined;
    return row?.cancel_requested === 1;
  }

  appendEvent(jobId: string, envelope: Envelope) {
    envelopeSchema.parse(envelope);
    this.db.prepare('INSERT INTO events(job_id, envelope_json) VALUES (?, ?)').run(jobId, JSON.stringify(envelope));
  }

  getEvents(jobId: string): Envelope[] {
    const rows = this.db.prepare('SELECT envelope_json FROM events WHERE job_id = ? ORDER BY sequence').all(jobId);
    return rows.map((row) => envelopeSchema.parse(JSON.parse((row as {envelope_json: string}).envelope_json)));
  }

  getIdempotent(tenantId: string, key: string): Envelope | undefined {
    const row = this.db.prepare('SELECT envelope_json FROM idempotency WHERE tenant_id = ? AND idempotency_key = ?').get(tenantId, key) as {envelope_json: string} | undefined;
    return row ? envelopeSchema.parse(JSON.parse(row.envelope_json)) : undefined;
  }

  saveIdempotent(tenantId: string, key: string, envelope: Envelope) {
    this.db.prepare('INSERT OR REPLACE INTO idempotency(tenant_id, idempotency_key, envelope_json, created_at) VALUES (?, ?, ?, ?)')
      .run(tenantId, key, JSON.stringify(envelope), new Date().toISOString());
  }

  audit(tenantId: string, actorId: string, action: string, resourceType: string, resourceId: string, detail: unknown = {}) {
    this.db.prepare('INSERT INTO audit_log(occurred_at, tenant_id, actor_id, action, resource_type, resource_id, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(new Date().toISOString(), tenantId, actorId, action, resourceType, resourceId, JSON.stringify(detail));
  }

  metrics() {
    const jobs = this.db.prepare('SELECT status, COUNT(*) AS count FROM jobs GROUP BY status').all() as Array<{status: string; count: number}>;
    const videoTasks = this.db.prepare('SELECT status, COUNT(*) AS count FROM video_analysis_tasks GROUP BY status').all() as Array<{status: string; count: number}>;
    const totals = this.db.prepare(`SELECT
      (SELECT COUNT(*) FROM jobs) AS jobs,
      (SELECT COUNT(*) FROM assets) AS assets,
      (SELECT COUNT(*) FROM events) AS events,
      (SELECT COUNT(*) FROM audit_log) AS audit_entries,
      (SELECT COUNT(*) FROM video_uploads) AS video_uploads,
      (SELECT COUNT(*) FROM video_analysis_tasks) AS video_analysis_tasks,
      (SELECT COUNT(*) FROM webhook_deliveries) AS webhook_deliveries`).get() as {jobs: number; assets: number; events: number; audit_entries: number; video_uploads: number; video_analysis_tasks: number; webhook_deliveries: number};
    return {jobs, videoTasks, totals};
  }
}
