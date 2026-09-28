import {z} from 'zod';
import {
  assetAnalysisSchema,
  assetVisualAnalysisSchema,
  editPlanSchema,
  marketingRoleBatchInputSchema,
  marketingRoleBatchResultSchema,
  marketingRoleSchema,
  screenshotAnalysisSchema,
  type AssetAnalysis,
  type AssetVisualAnalysis,
  type AssetMetadata,
  type EditPlan,
  type MarketingRoleAssignment,
  type MarketingRoleBatchInput,
  type MarketingRoleBatchResult,
  type NormalizedTranscript,
  type ScreenshotAnalysis,
  type StoredVideoScreenshot,
} from '../shared/auto-video-contracts.js';
import type {ModelConversationLogContext} from '../shared/model-conversations.js';
import {
  assetUnderstandingResponseFormat,
  assetVisualResponseFormat,
  editPlanResponseFormat,
  marketingRoleBatchResponseFormat,
  modelAssetUnderstandingContentSchema,
  modelAssetVisualContentSchema,
  modelEditPlanInputSchema,
  modelEditPlanResultSchema,
  modelMarketingRoleBatchInputSchema,
  modelMarketingRoleBatchResultSchema,
  type ModelEditPlanResult,
  type ModelMarketingRoleBatchResult,
} from './auto-video-model-contracts.js';
import {
  createModelAssetReferenceMap,
  toAssetId,
  toModelClipRef,
  type ModelAssetReferenceMap,
  type ModelClipRef,
} from './model-asset-reference.js';
import {RelayClient} from './relay-client.js';

export {assetVisualAnalysisSchema};
export type {AssetVisualAnalysis};

const screenshotModelSchema = z.object({
  description: z.string().trim().min(1).max(1_500),
  people: z.array(z.string().trim().min(1).max(120)).max(30),
  objects: z.array(z.string().trim().min(1).max(120)).max(40),
  actions: z.array(z.string().trim().min(1).max(160)).max(30),
  scene: z.string().trim().min(1).max(300),
  ocrText: z.array(z.string().trim().min(1).max(300)).max(30),
  qualityIssues: z.array(z.string().trim().min(1).max(200)).max(20),
}).strict();

export type VisualNormalizationDiagnostics = {normalizedFields: string[]; droppedItems: string[]; unrecoverablePaths: string[]};

const unique = (items: string[]) => [...new Set(items.map((item) => item.trim()).filter(Boolean))];

const visualStringKeys = ['description', 'text', 'name', 'action', 'details'] as const;
const sceneKeys = ['location', 'environment', 'lighting', 'cameraView'] as const;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const firstText = (value: unknown, keys = visualStringKeys) => {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return undefined;
};

/** Safely recover common Relay object-shaped visual fields before strict Zod validation. */
export const normalizeVisualModelValue = (input: unknown): {value: unknown; diagnostics: VisualNormalizationDiagnostics} => {
  const diagnostics: VisualNormalizationDiagnostics = {normalizedFields: [], droppedItems: [], unrecoverablePaths: []};
  if (!isRecord(input)) {
    diagnostics.unrecoverablePaths.push('$');
    return {value: input, diagnostics};
  }
  const normalizeList = (field: string, source: unknown, limit: number, scene = false) => {
    const values = Array.isArray(source) ? source : source === undefined || source === null ? [] : [source];
    const result: string[] = [];
    values.forEach((item, index) => {
      let text: string | undefined;
      if (typeof item === 'string') text = item.trim();
      else if (scene && isRecord(item)) {
        text = sceneKeys.map((key) => item[key]).filter((value): value is string => typeof value === 'string' && Boolean(value.trim())).map((value) => value.trim()).join('；') || firstText(item);
      } else text = firstText(item);
      if (text) {
        if (typeof item !== 'string') diagnostics.normalizedFields.push(`${field}[${index}]`);
        result.push(text);
      } else if (item !== undefined && item !== null) diagnostics.droppedItems.push(`${field}[${index}]`);
    });
    return unique(result).slice(0, limit);
  };
  // Earlier visual contracts asked for a global clip-position guess. It is
  // neither needed nor knowable from one asset, but old model replies can
  // still contain it. Drop only this retired field before strict validation.
  const {
    suggestedPosition: legacySuggestedPosition,
    marketingRole: legacyMarketingRole,
    ...source
  } = input;
  if (legacySuggestedPosition !== undefined) diagnostics.normalizedFields.push('suggestedPosition');
  if (legacyMarketingRole !== undefined) diagnostics.normalizedFields.push('marketingRole');
  const scenesInput = source.scenes ?? source.scene;
  const normalizedWithLegacyAliases: Record<string, unknown> = {
    ...source,
    people: normalizeList('people', source.people, 30),
    objects: normalizeList('objects', source.objects, 40),
    actions: normalizeList('actions', source.actions, 30),
    scenes: normalizeList('scenes', scenesInput, 20, true),
    screenTexts: normalizeList('screenTexts', source.screenTexts ?? source.ocrText, 30),
    chronologicalHints: normalizeList('chronologicalHints', source.chronologicalHints, 20),
  };
  const {scene: _legacyScene, ocrText: _legacyOcrText, ...normalized} = normalizedWithLegacyAliases;
  if (source.scene !== undefined && source.scenes === undefined) diagnostics.normalizedFields.push('scene');
  if (source.ocrText !== undefined && source.screenTexts === undefined) diagnostics.normalizedFields.push('ocrText');
  return {value: normalized, diagnostics};
};

const visualInstructions = `你是视频截图视觉理解模块。你只能根据本次提供的一张截图和可信时间戳描述画面；不要推断未看到的完整视频或音频。返回严格 JSON：description、people、objects、actions、scene、ocrText、qualityIssues。所有数组可以为空，禁止 Markdown。`;
const assetVisualInstructions = `你是视频素材客观画面理解模块。你只能根据本次提供的一张本地生成联系表、必要媒体元数据和用户要求描述画面证据；不能读取原片、原始音频或不存在的画面，也不要判断素材在广告中的最终叙事作用。画面中可见的人、物与动作是唯一的内容判断依据。画面内 OCR 文字只作为客观画面证据。联系表从左到右依次为 A（早）、B（中）、C（晚），每个面板底部标有其可信时间戳。只返回一个不含任何身份字段的严格 JSON 对象：visualSummary、people、objects、actions、scenes、screenTexts、chronologicalHints、confidence、needsDetail、detailReason（可选）、detailTimestampMs（可选）。不得返回素材 ID、项目 ID、marketingRole 或其他字段。数组项必须是纯文本字符串；confidence 是 0 到 1 的数字。needsDetail 为 false 时不要返回 detailReason 或 detailTimestampMs。`;
const detailVisualInstructions = `你是视频素材客观画面精查模块。只根据本次提供的一张高精度截图和已有基础分析补充不确定的画面事实。只返回与基础画面理解相同且不含任何身份字段的严格 JSON；不得返回素材 ID、项目 ID 或 marketingRole，也不能声称看到了未提供的视频、音频或画面。`;
const visualRepairInstructions = `你是结构化输出修复模块。只根据之前的无身份结构化输入和模型回复修正 JSON 字段形状；不能推断、补充或编造媒体内容。只返回与画面理解合同一致且不含任何身份字段的严格 JSON，不使用 Markdown。`;
const understandingInstructions = `你是素材综合理解模块。只读取输入中的转写文字、截图结构化分析、媒体元数据和用户编排要求；你不能读取原始音频或完整视频。画面行为优先，画面内文字其次，转写只补充不冲突的信息。返回不含任何身份字段的严格 JSON：audioSummary（可省略）、visualSummary、combinedSummary、topics、people、scenes、screenTexts、chronologicalHints、confidence。不要返回素材 ID、项目 ID、其他素材引用、代码、文件路径或帧数。`;
const marketingRoleBatchInstructions = `你是洗车营销短视频的整批素材作用判断模块。输入只使用 clip_001 等当前任务内短引用。请为每条素材判断主要广告作用，marketingRole 只能是 hook、problem、service、process、detail、result、offer、cta、transition。有效口播的营销意图优先；客观画面用于辅助理解和检查价格、优惠、门店、服务承诺或效果冲突；普通洗车动作可以作为 B-roll，不应覆盖口播作用。不得为了覆盖九类标签而强行分配。必须为每个输入 clipRef 返回且只返回一条结果，不得遗漏、重复、修改或引入其他引用。只返回 clips（clipRef/marketingRole/roleReason）的严格 JSON，不返回项目或素材真实 ID。`;
const planningInstructions = `你是洗车营销短视频自动编排模块。输入只使用 clip_001 等当前任务内短引用；marketingRole 和 roleReason 是整批判断得到的主要事实。按“吸引注意 → 问题/服务 → 清洗过程 → 细节 → 效果 → 优惠 → 行动引导”的方向组织，但不强求每类都存在。普通音画动作不完全一致可作为 B-roll；涉及价格、优惠、门店、服务承诺或效果的明确冲突必须在 reason 中说明。第一版必须使用每个输入 clipRef 且每个只能出现一次，order 从 1 连续递增并与数组位置一致。只返回 clips（clipRef/order/reason）和 overallReason，不返回项目 ID、素材真实 ID、excludedAssets、代码、路径或帧数。`;

const omitLegacySuggestedPosition = (candidate: unknown): unknown => {
  if (!isRecord(candidate)) return candidate;
  const {suggestedPosition: _legacySuggestedPosition, ...withoutLegacyPosition} = candidate;
  return withoutLegacyPosition;
};

type EditPlanValidationError = Error & {code: 'EDIT_PLAN_INVALID'; retryable: false};

const invalidEditPlan = (reasons: string[]): EditPlanValidationError => {
  const error = new Error(`EDIT_PLAN_INVALID: ${unique(reasons).join('; ')}`) as EditPlanValidationError;
  error.code = 'EDIT_PLAN_INVALID';
  error.retryable = false;
  return error;
};

export const validateAutoEditPlan = (candidate: unknown, projectId: string, validAssetIds: string[]): EditPlan => {
  const parsed = editPlanSchema.safeParse(candidate);
  if (!parsed.success) throw invalidEditPlan([`invalid internal response shape: ${parsed.error.issues.map((issue) => issue.path.map(String).join('.') || '$').slice(0, 5).join(',')}`]);
  const plan = parsed.data;
  const reasons: string[] = [];
  if (plan.projectId !== projectId) reasons.push('projectId mismatch');
  if (plan.excludedAssets.length) reasons.push('excludedAssets must be empty');
  if (plan.clips.length !== validAssetIds.length) reasons.push(`asset count mismatch: expected ${validAssetIds.length}, received ${plan.clips.length}`);
  const expected = new Set(validAssetIds);
  if (expected.size !== validAssetIds.length) reasons.push('duplicate expected assetId');
  const seen = new Set<string>();
  for (let index = 0; index < plan.clips.length; index += 1) {
    const clip = plan.clips[index]!;
    if (!expected.has(clip.assetId)) reasons.push(`unexpected assetId: ${clip.assetId}`);
    if (seen.has(clip.assetId)) reasons.push(`duplicate assetId: ${clip.assetId}`);
    if (clip.order !== index + 1) reasons.push(`invalid order for assetId ${clip.assetId}: expected ${index + 1}, received ${clip.order}`);
    seen.add(clip.assetId);
  }
  for (const assetId of expected) if (!seen.has(assetId)) reasons.push(`missing assetId: ${assetId}`);
  if (reasons.length) throw invalidEditPlan(reasons);
  return plan;
};

const validateModelClipRefs = (
  clips: unknown,
  references: ModelAssetReferenceMap,
  errorFactory: (reasons: string[]) => Error,
  checkOrder = false,
) => {
  if (!Array.isArray(clips)) throw errorFactory(['clips must be an array']);
  const reasons: string[] = [];
  const seen = new Set<string>();
  clips.forEach((rawClip, index) => {
    if (!isRecord(rawClip) || typeof rawClip.clipRef !== 'string') {
      reasons.push(`missing clipRef at index ${index}`);
      return;
    }
    const clipRef = rawClip.clipRef;
    if (!references.byClipRef.has(clipRef as ModelClipRef)) reasons.push(`unexpected clipRef: ${clipRef}`);
    if (seen.has(clipRef)) reasons.push(`duplicate clipRef: ${clipRef}`);
    seen.add(clipRef);
    if (checkOrder && rawClip.order !== index + 1) {
      reasons.push(`invalid order for clipRef ${clipRef}: expected ${index + 1}, received ${String(rawClip.order)}`);
    }
  });
  for (const clipRef of references.byClipRef.keys()) if (!seen.has(clipRef)) reasons.push(`missing clipRef: ${clipRef}`);
  if (clips.length !== references.byClipRef.size
    && !reasons.some((reason) => /^(missing|duplicate|unexpected) clipRef/.test(reason))) {
    reasons.push(`clip count mismatch: expected ${references.byClipRef.size}, received ${clips.length}`);
  }
  if (reasons.length) throw errorFactory(reasons);
};

export const validateModelEditPlanCandidate = (
  candidate: unknown,
  references: ModelAssetReferenceMap,
): ModelEditPlanResult => {
  if (!isRecord(candidate)) throw invalidEditPlan(['response must be an object']);
  validateModelClipRefs(candidate.clips, references, invalidEditPlan, true);
  const parsed = modelEditPlanResultSchema.safeParse(candidate);
  if (!parsed.success) {
    throw invalidEditPlan([`invalid response shape: ${parsed.error.issues.map((issue) => issue.path.map(String).join('.') || '$').slice(0, 5).join(',')}`]);
  }
  return parsed.data;
};

type MarketingRoleAssignmentError = Error & {code: 'MARKETING_ROLE_ASSIGNMENT_INVALID'; retryable: false};

const invalidMarketingRoleAssignment = (reasons: string[]): MarketingRoleAssignmentError => {
  const error = new Error(`MARKETING_ROLE_ASSIGNMENT_INVALID: ${unique(reasons).join('; ')}`) as MarketingRoleAssignmentError;
  error.code = 'MARKETING_ROLE_ASSIGNMENT_INVALID';
  error.retryable = false;
  return error;
};

export const validateMarketingRoleBatchResult = (
  candidate: unknown,
  projectId: string,
  expectedAssetIds: string[],
): MarketingRoleBatchResult => {
  const reasons: string[] = [];
  const expected = new Set(expectedAssetIds);
  if (expected.size !== expectedAssetIds.length) throw invalidMarketingRoleAssignment(['duplicate expected assetId']);
  if (!isRecord(candidate)) throw invalidMarketingRoleAssignment(['response must be an object']);
  if (candidate.projectId !== projectId) reasons.push('projectId mismatch');
  const rawAssets = candidate.assets;
  if (!Array.isArray(rawAssets)) throw invalidMarketingRoleAssignment([...reasons, 'assets must be an array']);
  const seen = new Set<string>();
  const allowedKeys = new Set(['assetId', 'marketingRole', 'roleReason']);
  rawAssets.forEach((rawAsset, index) => {
    if (!isRecord(rawAsset)) {
      reasons.push(`missing assetId at index ${index}`);
      return;
    }
    const assetId = typeof rawAsset.assetId === 'string' ? rawAsset.assetId.trim() : '';
    if (!assetId) {
      reasons.push(`missing assetId at index ${index}`);
      return;
    }
    if (!expected.has(assetId)) reasons.push(`unknown assetId: ${assetId}`);
    if (seen.has(assetId)) reasons.push(`duplicate assetId: ${assetId}`);
    seen.add(assetId);
    if (!marketingRoleSchema.safeParse(rawAsset.marketingRole).success) reasons.push(`invalid marketingRole: ${assetId}`);
    if (typeof rawAsset.roleReason !== 'string' || !rawAsset.roleReason.trim()) reasons.push(`empty roleReason: ${assetId}`);
    const unexpected = Object.keys(rawAsset).filter((key) => !allowedKeys.has(key));
    if (unexpected.length) reasons.push(`unexpected fields for ${assetId}: ${unexpected.join(',')}`);
  });
  for (const assetId of expected) if (!seen.has(assetId)) reasons.push(`missing assetId: ${assetId}`);
  if (rawAssets.length !== expected.size && !reasons.some((reason) => reason.startsWith('missing assetId') || reason.startsWith('duplicate assetId') || reason.startsWith('unknown assetId'))) {
    reasons.push(`asset count mismatch: expected ${expected.size}, received ${rawAssets.length}`);
  }
  const parsed = marketingRoleBatchResultSchema.safeParse(candidate);
  if (!parsed.success && !reasons.length) {
    reasons.push(`invalid response shape: ${parsed.error.issues.map((issue) => issue.path.map(String).join('.') || '$').slice(0, 5).join(',')}`);
  }
  if (reasons.length || !parsed.success) throw invalidMarketingRoleAssignment(reasons.length ? reasons : ['invalid response shape']);
  return parsed.data;
};

const validateModelMarketingRoleBatchResult = (
  candidate: unknown,
  references: ModelAssetReferenceMap,
): ModelMarketingRoleBatchResult => {
  if (!isRecord(candidate)) throw invalidMarketingRoleAssignment(['response must be an object']);
  validateModelClipRefs(candidate.clips, references, invalidMarketingRoleAssignment);
  const parsed = modelMarketingRoleBatchResultSchema.safeParse(candidate);
  if (!parsed.success) {
    throw invalidMarketingRoleAssignment([`invalid response shape: ${parsed.error.issues.map((issue) => issue.path.map(String).join('.') || '$').slice(0, 5).join(',')}`]);
  }
  return parsed.data;
};

const metadataForModel = ({assetId: _assetId, ...metadata}: AssetMetadata) => metadata;
const transcriptForModel = (transcript: NormalizedTranscript | null) => transcript ? {
  language: transcript.language,
  durationMs: transcript.durationMs,
  text: transcript.text,
  words: transcript.words,
  segments: transcript.segments,
  provider: transcript.provider,
  model: transcript.model,
} : null;
const screenshotForModel = ({screenshotId: _screenshotId, assetId: _assetId, ...screenshot}: ScreenshotAnalysis) => screenshot;
const visualForModel = ({assetId: _assetId, ...analysis}: AssetVisualAnalysis) => analysis;
const withoutIdentityFields = (candidate: unknown): unknown => {
  if (Array.isArray(candidate)) return candidate.map(withoutIdentityFields);
  if (!isRecord(candidate)) return candidate;
  return Object.fromEntries(Object.entries(candidate)
    .filter(([key]) => !['projectId', 'generationId', 'assetId'].includes(key))
    .map(([key, value]) => [key, withoutIdentityFields(value)]));
};

const narrationFirstSummary = (visualSummary: string, audioSummary?: string) =>
  audioSummary ? `口播内容：${audioSummary}。客观画面：${visualSummary}` : `无有效口播。客观画面：${visualSummary}`;

export const toAssetAnalysis = (analysis: AssetVisualAnalysis, transcript: NormalizedTranscript | null, assignment: MarketingRoleAssignment): AssetAnalysis => {
  if (analysis.assetId !== assignment.assetId) throw invalidMarketingRoleAssignment([`assetId mismatch: ${analysis.assetId} != ${assignment.assetId}`]);
  const audioSummary = transcript?.text.trim();
  const visualTopics = unique([...analysis.actions, ...analysis.objects]).slice(0, 20);
  return assetAnalysisSchema.parse({
    assetId: analysis.assetId,
    marketingRole: assignment.marketingRole,
    audioSummary: audioSummary || undefined,
    visualSummary: analysis.visualSummary,
    combinedSummary: narrationFirstSummary(analysis.visualSummary, audioSummary),
    roleReason: assignment.roleReason,
    topics: visualTopics.length ? visualTopics : ['视频素材'],
    people: analysis.people,
    scenes: analysis.scenes,
    screenTexts: analysis.screenTexts,
    chronologicalHints: analysis.chronologicalHints,
    duplicateWithAssetIds: [],
    confidence: analysis.confidence,
  });
};

export const mergeAssetVisualAnalysis = (base: AssetVisualAnalysis, detail: AssetVisualAnalysis): AssetVisualAnalysis => assetVisualAnalysisSchema.parse({
  ...base,
  visualSummary: detail.visualSummary || base.visualSummary,
  people: unique([...base.people, ...detail.people]).slice(0, 30),
  objects: unique([...base.objects, ...detail.objects]).slice(0, 40),
  actions: unique([...base.actions, ...detail.actions]).slice(0, 30),
  scenes: unique([...base.scenes, ...detail.scenes]).slice(0, 20),
  screenTexts: unique([...base.screenTexts, ...detail.screenTexts]).slice(0, 30),
  chronologicalHints: unique([...base.chronologicalHints, ...detail.chronologicalHints]).slice(0, 20),
  confidence: Math.max(base.confidence, detail.confidence),
  needsDetail: false,
  detailReason: undefined,
  detailTimestampMs: undefined,
});

export class AutoVideoAiProvider {
  constructor(
    private readonly relay?: RelayClient,
    private readonly conversationContext?: Omit<ModelConversationLogContext, 'source'>,
  ) {}

  private logContext(source: string, assetId?: string): ModelConversationLogContext | undefined {
    return this.conversationContext ? {...this.conversationContext, source, assetId: assetId ?? this.conversationContext.assetId} : undefined;
  }

  /** Keep image understanding on the same plain multimodal chat path as the UI tester. */
  private async requestVisualJson(instructions: string, structuredInput: unknown, imageUrls: string[], signal: AbortSignal | undefined, source: string, assetId: string) {
    if (!this.relay) throw new Error('VISUAL_ANALYSIS_FAILED');
    const prompt = `${instructions}\n\n请分析以下结构化输入：\n${JSON.stringify(structuredInput)}`;
    // Keep the ordinary image input (no text.format/json_schema) but send the
    // task prompt as Responses instructions. requestChatJson always applies
    // the connection-tester instruction, which is not valid for production
    // visual analysis and makes its audit record misleading.
    return this.relay.requestJson(instructions, prompt, signal, imageUrls, this.logContext(source, assetId));
  }

  private parseAssetVisualAnalysis(candidate: unknown, assetId: string, durationMs: number): {analysis: AssetVisualAnalysis; diagnostics: VisualNormalizationDiagnostics} {
    const normalized = normalizeVisualModelValue(candidate);
    const parsed = modelAssetVisualContentSchema.safeParse(normalized.value);
    if (!parsed.success) {
      const paths = parsed.error.issues.map((issue) => issue.path.length ? issue.path.map(String).join('.') : '$');
      throw new Error(`INVALID_MODEL_RESPONSE:${paths.slice(0, 5).join(',') || '$'}`);
    }
    const hydrated = assetVisualAnalysisSchema.parse({assetId, ...parsed.data});
    if (hydrated.detailTimestampMs !== undefined && hydrated.detailTimestampMs >= durationMs) throw new Error('INVALID_MODEL_RESPONSE:detailTimestampMs');
    if (!hydrated.needsDetail && (hydrated.detailReason !== undefined || hydrated.detailTimestampMs !== undefined)) {
      return {analysis: {...hydrated, detailReason: undefined, detailTimestampMs: undefined}, diagnostics: normalized.diagnostics};
    }
    return {analysis: hydrated, diagnostics: normalized.diagnostics};
  }

  private async repairAssetVisualAnalysis(input: Record<string, unknown>, previousResponse: unknown, assetId: string, durationMs: number, signal?: AbortSignal) {
    if (!this.relay || Math.max(0, Number(process.env.AUTO_VIDEO_VISUAL_MAX_RETRIES ?? 1)) < 1) throw new Error('INVALID_MODEL_RESPONSE');
    const candidate = await this.relay.requestJson(visualRepairInstructions, {
      schema: 'auto-video-visual-repair.v2',
      originalInput: input,
      previousResponse: withoutIdentityFields(previousResponse),
    }, signal, [], this.logContext('auto-video.visual-repair', assetId), assetVisualResponseFormat);
    return this.parseAssetVisualAnalysis(candidate, assetId, durationMs);
  }

  async analyzeScreenshot(input: {screenshot: StoredVideoScreenshot; imageDataUrl: string; signal?: AbortSignal}): Promise<ScreenshotAnalysis> {
    if (!this.relay) {
      return screenshotAnalysisSchema.parse({
        screenshotId: input.screenshot.id,
        assetId: input.screenshot.assetId,
        timestampMs: input.screenshot.timestampMs,
        description: `本地模式：已采集 ${Math.round(input.screenshot.timestampMs / 1_000 * 10) / 10} 秒截图，等待配置视觉模型后生成画面语义。`,
        people: [], objects: [], actions: [], scene: '未配置视觉模型', ocrText: [], qualityIssues: [],
      });
    }
    try {
      const candidate = screenshotModelSchema.parse(await this.requestVisualJson(visualInstructions, {
        schema: 'auto-video-screenshot-analysis.v1',
        screenshot: {timestampMs: input.screenshot.timestampMs},
      }, [input.imageDataUrl], input.signal, 'auto-video.screenshot-analysis', input.screenshot.assetId));
      return screenshotAnalysisSchema.parse({
        screenshotId: input.screenshot.id,
        assetId: input.screenshot.assetId,
        timestampMs: input.screenshot.timestampMs,
        ...candidate,
      });
    } catch (error) {
      throw error;
    }
  }

  async analyzeAssetVisualSummary(input: {
    assetId: string;
    metadata: AssetMetadata;
    contactSheetDataUrls: string[];
    panels: Array<{id: 'A' | 'B' | 'C'; timestampMs: number}>;
    userInstruction?: string;
    signal?: AbortSignal;
  }): Promise<{analysis: AssetVisualAnalysis; diagnostics: VisualNormalizationDiagnostics}> {
    if (!this.relay) throw new Error('VISUAL_ANALYSIS_FAILED');
    const structuredInput = {
      schema: 'auto-video-asset-visual-analysis-input.v2',
      metadata: metadataForModel(input.metadata),
      contactSheet: {panels: input.panels},
      userInstruction: input.userInstruction,
    };
    try {
      const candidate = await this.requestVisualJson(assetVisualInstructions, structuredInput, input.contactSheetDataUrls, input.signal, 'auto-video.asset-visual-summary', input.assetId);
      try { return this.parseAssetVisualAnalysis(candidate, input.assetId, input.metadata.durationMs); }
      catch (error) {
        if (error instanceof Error && error.message.startsWith('INVALID_MODEL_RESPONSE')) return await this.repairAssetVisualAnalysis(structuredInput, candidate, input.assetId, input.metadata.durationMs, input.signal);
        throw error;
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'model_invalid_json') {
        try { return await this.repairAssetVisualAnalysis(structuredInput, '[模型回复不是合法 JSON]', input.assetId, input.metadata.durationMs, input.signal); }
        catch (repairError) { throw repairError; }
      }
      throw error;
    }
  }

  async analyzeAssetVisualDetail(input: {
    assetId: string;
    metadata: AssetMetadata;
    timestampMs: number;
    imageDataUrl: string;
    baseAnalysis: AssetVisualAnalysis;
    userInstruction?: string;
    signal?: AbortSignal;
  }): Promise<{analysis: AssetVisualAnalysis; diagnostics: VisualNormalizationDiagnostics}> {
    if (!this.relay) throw new Error('VISUAL_ANALYSIS_FAILED');
    const structuredInput = {
      schema: 'auto-video-asset-visual-detail-input.v2',
      metadata: metadataForModel(input.metadata),
      detailTimestampMs: input.timestampMs,
      baseAnalysis: visualForModel(input.baseAnalysis),
      userInstruction: input.userInstruction,
    };
    try {
      const candidate = await this.requestVisualJson(detailVisualInstructions, structuredInput, [input.imageDataUrl], input.signal, 'auto-video.asset-visual-detail', input.assetId);
      try { return this.parseAssetVisualAnalysis(candidate, input.assetId, input.metadata.durationMs); }
      catch (error) {
        if (error instanceof Error && error.message.startsWith('INVALID_MODEL_RESPONSE')) return await this.repairAssetVisualAnalysis(structuredInput, candidate, input.assetId, input.metadata.durationMs, input.signal);
        throw error;
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'model_invalid_json') {
        try { return await this.repairAssetVisualAnalysis(structuredInput, '[模型回复不是合法 JSON]', input.assetId, input.metadata.durationMs, input.signal); }
        catch (repairError) { throw repairError; }
      }
      throw error;
    }
  }

  async understandAsset(input: {
    assetId: string;
    metadata: AssetMetadata;
    transcript: NormalizedTranscript | null;
    screenshots: ScreenshotAnalysis[];
    userInstruction?: string;
    signal?: AbortSignal;
  }): Promise<AssetAnalysis> {
    if (!this.relay) {
      const transcriptText = input.transcript?.text.trim() ?? '';
      const descriptions = input.screenshots.map((screenshot) => screenshot.description);
      const scenes = unique(input.screenshots.map((screenshot) => screenshot.scene));
      const people = unique(input.screenshots.flatMap((screenshot) => screenshot.people));
      const screenTexts = unique(input.screenshots.flatMap((screenshot) => screenshot.ocrText));
      const indexHint = input.screenshots.length > 1 ? '包含开场、中段和结尾截图采样。' : '包含视频截图采样。';
      return assetAnalysisSchema.parse({
        assetId: input.assetId,
        audioSummary: transcriptText || undefined,
        visualSummary: descriptions.join(' ') || '没有可用截图描述。',
        combinedSummary: [transcriptText, descriptions.join(' ')].filter(Boolean).join('；') || '本地模式仅完成媒体结构采样，尚未配置语义模型。',
        topics: transcriptText ? ['转写内容'] : ['视频素材'],
        people,
        scenes,
        screenTexts,
        chronologicalHints: [indexHint],
        duplicateWithAssetIds: [],
        confidence: 0.25,
      });
    }
    try {
      const candidate = await this.relay.requestJson(understandingInstructions, {
        schema: 'auto-video-asset-understanding-input.v2',
        metadata: metadataForModel(input.metadata),
        transcript: transcriptForModel(input.transcript),
        screenshots: input.screenshots.map(screenshotForModel),
        userInstruction: input.userInstruction,
      }, input.signal, [], this.logContext('auto-video.asset-understanding', input.assetId), assetUnderstandingResponseFormat);
      const content = modelAssetUnderstandingContentSchema.parse(omitLegacySuggestedPosition(candidate));
      return assetAnalysisSchema.parse({
        ...content,
        assetId: input.assetId,
        marketingRole: 'transition',
        combinedSummary: narrationFirstSummary(content.visualSummary, content.audioSummary),
        duplicateWithAssetIds: [],
      });
    } catch (error) { throw error; }
  }

  async assignMarketingRolesBatch(input: MarketingRoleBatchInput & {signal?: AbortSignal}): Promise<MarketingRoleBatchResult> {
    const {signal, ...batchInput} = input;
    const parsedInput = marketingRoleBatchInputSchema.parse(batchInput);
    const expectedAssetIds = parsedInput.assets.map((asset) => asset.assetId);
    if (new Set(expectedAssetIds).size !== expectedAssetIds.length) {
      throw invalidMarketingRoleAssignment(['duplicate assetId in batch input']);
    }
    if (!this.relay) {
      return marketingRoleBatchResultSchema.parse({
        projectId: parsedInput.projectId,
        assets: parsedInput.assets.map((asset) => ({
          assetId: asset.assetId,
          marketingRole: 'transition',
          roleReason: '本地降级：未配置 Relay，无法执行整批语义判断，保留为过渡素材。',
        })),
      });
    }

    const references = createModelAssetReferenceMap(expectedAssetIds);
    const modelInput = modelMarketingRoleBatchInputSchema.parse({
      schema: 'auto-video-marketing-role-batch-input.v2',
      clips: parsedInput.assets.map(({assetId, ...asset}) => ({
        clipRef: toModelClipRef(references, assetId),
        ...asset,
      })),
      userInstruction: parsedInput.userInstruction,
    });

    let lastValidationError: MarketingRoleAssignmentError | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const requestInput = lastValidationError ? {
        schema: 'auto-video-marketing-role-batch-repair.v2',
        originalInput: modelInput,
        validationErrors: lastValidationError.message,
        instruction: '请依据具体校验错误修正上一轮输出，并重新返回完整结果。',
      } : modelInput;
      try {
        const candidate = await this.relay.requestJson(
          marketingRoleBatchInstructions,
          requestInput,
          signal,
          [],
          this.logContext('auto-video.marketing-role-batch'),
          marketingRoleBatchResponseFormat,
        );
        const modelResult = validateModelMarketingRoleBatchResult(candidate, references);
        return validateMarketingRoleBatchResult({
          projectId: parsedInput.projectId,
          assets: modelResult.clips.map((clip) => ({
            assetId: toAssetId(references, clip.clipRef as ModelClipRef),
            marketingRole: clip.marketingRole,
            roleReason: clip.roleReason,
          })),
        }, parsedInput.projectId, expectedAssetIds);
      } catch (error) {
        const code = error instanceof Error ? (error as {code?: unknown}).code : undefined;
        if (error instanceof Error && (code === 'MARKETING_ROLE_ASSIGNMENT_INVALID' || code === 'model_invalid_json')) {
          lastValidationError = (error as Partial<MarketingRoleAssignmentError>).code === 'MARKETING_ROLE_ASSIGNMENT_INVALID'
            ? error as MarketingRoleAssignmentError
            : invalidMarketingRoleAssignment(['response is not valid JSON']);
          continue;
        }
        throw error;
      }
    }
    throw lastValidationError ?? invalidMarketingRoleAssignment(['batch role assignment failed validation']);
  }

  async plan(input: {
    projectId: string;
    analyses: AssetAnalysis[];
    assetDurations: Array<{assetId: string; durationMs: number}>;
    canvas: {width: number; height: number; fps: number};
    userInstruction?: string;
    signal?: AbortSignal;
  }): Promise<EditPlan> {
    const validAssetIds = input.assetDurations.map((asset) => asset.assetId);
    if (!this.relay) {
      return validateAutoEditPlan({
        projectId: input.projectId,
        clips: validAssetIds.map((assetId, index) => ({
          assetId,
          order: index + 1,
          reason: '本地确定性编排：按上传顺序完整合成。',
        })),
        excludedAssets: [],
        overallReason: '未配置编排模型，系统按上传顺序完整合成所有有效素材，不省略也不重复。',
      }, input.projectId, validAssetIds);
    }

    const references = createModelAssetReferenceMap(validAssetIds);
    const durationByAssetId = new Map(input.assetDurations.map((asset) => [asset.assetId, asset.durationMs]));
    if (durationByAssetId.size !== validAssetIds.length) throw invalidEditPlan(['duplicate assetId in assetDurations']);
    const analysisByAssetId = new Map(input.analyses.map((analysis) => [analysis.assetId, analysis]));
    if (analysisByAssetId.size !== input.analyses.length) throw invalidEditPlan(['duplicate assetId in analyses']);
    const analysisIds = new Set(input.analyses.map((analysis) => analysis.assetId));
    const missingAnalyses = validAssetIds.filter((assetId) => !analysisIds.has(assetId));
    const unexpectedAnalyses = [...analysisIds].filter((assetId) => !durationByAssetId.has(assetId));
    if (missingAnalyses.length || unexpectedAnalyses.length) {
      throw invalidEditPlan([
        ...missingAnalyses.map((assetId) => `missing analysis for assetId: ${assetId}`),
        ...unexpectedAnalyses.map((assetId) => `unexpected analysis assetId: ${assetId}`),
      ]);
    }
    const modelInput = modelEditPlanInputSchema.parse({
      schema: 'auto-video-edit-plan-input.v2',
      clips: validAssetIds.map((assetId) => {
        const analysis = analysisByAssetId.get(assetId)!;
        return {
          clipRef: toModelClipRef(references, assetId),
          durationMs: durationByAssetId.get(assetId),
          marketingRole: analysis.marketingRole,
          roleReason: analysis.roleReason,
          audioSummary: analysis.audioSummary,
          visualSummary: analysis.visualSummary,
          people: analysis.people,
          scenes: analysis.scenes,
          screenTexts: analysis.screenTexts,
          chronologicalHints: analysis.chronologicalHints,
        };
      }),
      canvas: input.canvas,
      userInstruction: input.userInstruction,
      allClipsMustBeUsed: true,
    });

    let lastValidationError: EditPlanValidationError | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const requestInput = lastValidationError ? {
        schema: 'auto-video-edit-plan-repair.v2',
        originalInput: modelInput,
        validationErrors: lastValidationError.message,
        instruction: '请依据具体校验错误修正上一轮输出，并重新返回完整结果。',
      } : modelInput;
      try {
        const candidate = await this.relay.requestJson(
          planningInstructions,
          requestInput,
          input.signal,
          [],
          this.logContext('auto-video.edit-planning'),
          editPlanResponseFormat,
        );
        const modelResult = validateModelEditPlanCandidate(candidate, references);
        return validateAutoEditPlan({
          projectId: input.projectId,
          clips: modelResult.clips.map((clip) => ({
            assetId: toAssetId(references, clip.clipRef as ModelClipRef),
            order: clip.order,
            reason: clip.reason,
          })),
          excludedAssets: [],
          overallReason: modelResult.overallReason,
        }, input.projectId, validAssetIds);
      } catch (error) {
        const code = error instanceof Error ? (error as {code?: unknown}).code : undefined;
        if (code !== 'EDIT_PLAN_INVALID' && code !== 'model_invalid_json') throw error;
        lastValidationError = code === 'EDIT_PLAN_INVALID'
          ? error as EditPlanValidationError
          : invalidEditPlan(['response is not valid JSON']);
      }
    }
    throw lastValidationError ?? invalidEditPlan(['edit plan failed validation']);
  }
}
