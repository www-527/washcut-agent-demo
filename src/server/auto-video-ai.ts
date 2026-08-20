import {z} from 'zod';
import {
  assetAnalysisSchema,
  assetVisualAnalysisSchema,
  editPlanSchema,
  screenshotAnalysisSchema,
  type AssetAnalysis,
  type AssetVisualAnalysis,
  type AssetMetadata,
  type EditPlan,
  type NormalizedTranscript,
  type ScreenshotAnalysis,
  type StoredVideoScreenshot,
} from '../shared/auto-video-contracts.js';
import type {ModelConversationLogContext} from '../shared/model-conversations.js';
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
  const {suggestedPosition: legacySuggestedPosition, ...source} = input;
  if (legacySuggestedPosition !== undefined) diagnostics.normalizedFields.push('suggestedPosition');
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
const assetVisualInstructions = `你是视频素材联合理解模块。你只能根据本次提供的一张本地生成联系表、必要媒体元数据和用户要求做结论；不能读取原片、原始音频或不存在的画面。画面中可见的人、物与动作是唯一的内容判断依据：必须优先描述实际画面行为，不能让口播、转写、字幕或用户要求改变对画面行为的判断。画面内 OCR 文字只能作为辅助线索，也不能推翻可见动作。联系表从左到右依次为 A（早）、B（中）、C（晚），每个面板底部标有其可信时间戳。只返回一个 JSON 对象，不使用 Markdown。字段必须为 assetId、visualSummary、people、objects、actions、scenes、screenTexts、chronologicalHints、confidence、needsDetail、detailReason（可选）、detailTimestampMs（可选）。people、objects、actions、scenes、screenTexts、chronologicalHints 必须是纯文本字符串数组；数组项不得是对象、嵌套数组、数字或 null。confidence 是 0 到 1 的数字。scenes 只用文本描述，绝不返回 location、lighting 等嵌套对象。needsDetail 为 false 时不要返回 detailReason 或 detailTimestampMs。`;
const detailVisualInstructions = `你是视频素材精查模块。只根据本次提供的一张高精度截图和已有基础分析补充不确定信息。只返回严格 JSON，字段与基础联合理解完全相同。保留 assetId；不能声称看到了未提供的视频、音频或画面。数组必须都是纯文本字符串数组，confidence 是 0 到 1 的数字。`;
const visualRepairInstructions = `你是结构化输出修复模块。只根据之前的结构化输入和模型回复修正 JSON 字段形状；不能推断、补充或编造媒体内容。只返回一个严格 JSON 对象，不使用 Markdown。people、objects、actions、scenes、screenTexts、chronologicalHints 必须是字符串数组，confidence 为 0 到 1 的数字。`;
const assetVisualResponseFormat = {
  name: 'auto_video_asset_visual_analysis',
  schema: {
    type: 'object', additionalProperties: false,
    required: ['assetId', 'visualSummary', 'people', 'objects', 'actions', 'scenes', 'screenTexts', 'chronologicalHints', 'confidence', 'needsDetail'],
    properties: {
      assetId: {type: 'string'}, visualSummary: {type: 'string'},
      people: {type: 'array', items: {type: 'string'}}, objects: {type: 'array', items: {type: 'string'}}, actions: {type: 'array', items: {type: 'string'}}, scenes: {type: 'array', items: {type: 'string'}}, screenTexts: {type: 'array', items: {type: 'string'}}, chronologicalHints: {type: 'array', items: {type: 'string'}},
      confidence: {type: 'number', minimum: 0, maximum: 1}, needsDetail: {type: 'boolean'}, detailReason: {type: 'string'}, detailTimestampMs: {type: 'integer', minimum: 0},
    },
  },
} as const;
const understandingInstructions = `你是素材综合理解模块。只读取输入中的转写文字、截图结构化分析、媒体元数据和用户编排要求；你不能读取原始音频或完整视频。判断素材内容和广告作用时，画面行为（截图 description、actions、people、scenes）优先级最高；画面内文字其次；转写只可用于补充已被画面支持的信息，不能覆盖或改写画面结论。返回严格的 AssetAnalysis JSON，字段为 assetId、audioSummary（可省略）、visualSummary、combinedSummary、topics、people、scenes、screenTexts、chronologicalHints、duplicateWithAssetIds、confidence。不要生成代码、文件路径、帧数或不存在的素材 ID。`;
const planningInstructions = `你是视频自动编排模块。只读取输入的合法素材分析、时长与画布信息。编排时严格按证据优先级决策：1）visualSummary、people、scenes 与 chronologicalHints 中可见的画面行为；2）screenTexts 中的画面内可读文字；3）topics、audioSummary 与 combinedSummary 中的口播/字幕转写。低优先级转写不得推翻画面行为；若两者冲突，以画面行为为准。每个 clips.reason 必须说明该片段的画面行为如何衔接，不要仅复述口播或字幕。第一版必须使用每一个有效素材且每个只能出现一次，excludedAssets 必须为空；clips.order 从 1 开始连续递增。返回严格 EditPlan JSON：projectId、clips（assetId/order/reason）、excludedAssets、overallReason。禁止 JSX、Remotion 代码、Shell 命令、文件路径和帧数。`;

const omitLegacySuggestedPosition = (candidate: unknown): unknown => {
  if (!isRecord(candidate)) return candidate;
  const {suggestedPosition: _legacySuggestedPosition, ...withoutLegacyPosition} = candidate;
  return withoutLegacyPosition;
};

export const validateAutoEditPlan = (candidate: unknown, projectId: string, validAssetIds: string[]): EditPlan => {
  const plan = editPlanSchema.parse(candidate);
  if (plan.projectId !== projectId) throw new Error('EDIT_PLAN_INVALID');
  if (plan.excludedAssets.length) throw new Error('EDIT_PLAN_INVALID');
  if (plan.clips.length !== validAssetIds.length) throw new Error('EDIT_PLAN_INVALID');
  const expected = new Set(validAssetIds);
  const seen = new Set<string>();
  for (let index = 0; index < plan.clips.length; index += 1) {
    const clip = plan.clips[index]!;
    if (!expected.has(clip.assetId) || seen.has(clip.assetId) || clip.order !== index + 1) throw new Error('EDIT_PLAN_INVALID');
    seen.add(clip.assetId);
  }
  if (seen.size !== expected.size) throw new Error('EDIT_PLAN_INVALID');
  return plan;
};

const visualFirstSummary = (visualSummary: string, audioSummary?: string) =>
  audioSummary ? `画面行为：${visualSummary}。语音/字幕（仅辅助）：${audioSummary}` : `画面行为：${visualSummary}`;

export const toAssetAnalysis = (analysis: AssetVisualAnalysis, transcript: NormalizedTranscript | null): AssetAnalysis => {
  const audioSummary = transcript?.text.trim();
  const visualTopics = unique([...analysis.actions, ...analysis.objects]).slice(0, 20);
  return assetAnalysisSchema.parse({
    assetId: analysis.assetId,
    audioSummary: audioSummary || undefined,
    visualSummary: analysis.visualSummary,
    combinedSummary: visualFirstSummary(analysis.visualSummary, audioSummary),
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
    const parsed = assetVisualAnalysisSchema.safeParse(normalized.value);
    if (!parsed.success) {
      const paths = parsed.error.issues.map((issue) => issue.path.length ? issue.path.map(String).join('.') : '$');
      throw new Error(`INVALID_MODEL_RESPONSE:${paths.slice(0, 5).join(',') || '$'}`);
    }
    if (parsed.data.assetId !== assetId) throw new Error('INVALID_MODEL_RESPONSE:assetId');
    if (parsed.data.detailTimestampMs !== undefined && parsed.data.detailTimestampMs >= durationMs) throw new Error('INVALID_MODEL_RESPONSE:detailTimestampMs');
    if (!parsed.data.needsDetail && (parsed.data.detailReason !== undefined || parsed.data.detailTimestampMs !== undefined)) {
      return {analysis: {...parsed.data, detailReason: undefined, detailTimestampMs: undefined}, diagnostics: normalized.diagnostics};
    }
    return {analysis: parsed.data, diagnostics: normalized.diagnostics};
  }

  private async repairAssetVisualAnalysis(input: Record<string, unknown>, previousResponse: unknown, assetId: string, durationMs: number, signal?: AbortSignal) {
    if (!this.relay || Math.max(0, Number(process.env.AUTO_VIDEO_VISUAL_MAX_RETRIES ?? 1)) < 1) throw new Error('INVALID_MODEL_RESPONSE');
    const candidate = await this.relay.requestJson(visualRepairInstructions, {
      schema: 'auto-video-visual-repair.v1',
      originalInput: input,
      previousResponse,
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
      schema: 'auto-video-asset-visual-analysis.v1',
      assetId: input.assetId,
      metadata: input.metadata,
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
      schema: 'auto-video-asset-visual-detail.v1',
      assetId: input.assetId,
      metadata: input.metadata,
      detailTimestampMs: input.timestampMs,
      baseAnalysis: input.baseAnalysis,
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
        schema: 'auto-video-asset-understanding-input.v1',
        assetId: input.assetId,
        metadata: input.metadata,
        transcript: input.transcript,
        screenshots: input.screenshots,
        userInstruction: input.userInstruction,
      }, input.signal, [], this.logContext('auto-video.asset-understanding', input.assetId));
      const parsed = assetAnalysisSchema.parse(omitLegacySuggestedPosition(candidate));
      if (parsed.assetId !== input.assetId) throw new Error('INVALID_MODEL_RESPONSE');
      return assetAnalysisSchema.parse({...parsed, combinedSummary: visualFirstSummary(parsed.visualSummary, parsed.audioSummary)});
    } catch (error) { throw error; }
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

    let repairContext: string | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const candidate = await this.relay.requestJson(planningInstructions, {
          schema: 'auto-video-edit-plan-input.v1',
          projectId: input.projectId,
          analyses: input.analyses,
          assetDurations: input.assetDurations,
          canvas: input.canvas,
          userInstruction: input.userInstruction,
          allValidAssetsMustBeUsed: true,
          repairContext,
        }, input.signal, [], this.logContext('auto-video.edit-planning'));
        return validateAutoEditPlan(candidate, input.projectId, validAssetIds);
      } catch (error) {
        if (attempt === 2) break;
        repairContext = error instanceof Error ? `上一次输出未通过校验：${error.message}。请只返回修正后的严格 JSON。` : '上一次输出未通过校验。';
      }
    }
    throw new Error('EDIT_PLAN_INVALID');
  }
}
