import {z} from 'zod';
import {
  AUTO_VIDEO_MAX_ASSET_COUNT,
  marketingRoleSchema,
} from '../shared/auto-video-contracts.js';

export const modelAssetVisualContentSchema = z.object({
  visualSummary: z.string().trim().min(1).max(1_500),
  people: z.array(z.string().trim().min(1).max(120)).max(30),
  objects: z.array(z.string().trim().min(1).max(120)).max(40),
  actions: z.array(z.string().trim().min(1).max(160)).max(30),
  scenes: z.array(z.string().trim().min(1).max(300)).max(20),
  screenTexts: z.array(z.string().trim().min(1).max(300)).max(30),
  chronologicalHints: z.array(z.string().trim().min(1).max(300)).max(20),
  confidence: z.number().min(0).max(1),
  needsDetail: z.boolean(),
  detailReason: z.string().trim().min(1).max(300).optional(),
  detailTimestampMs: z.number().int().nonnegative().optional(),
}).strict();

export const modelAssetUnderstandingContentSchema = z.object({
  audioSummary: z.string().trim().min(1).optional(),
  visualSummary: z.string().trim().min(1),
  combinedSummary: z.string().trim().min(1),
  topics: z.array(z.string()),
  people: z.array(z.string()),
  scenes: z.array(z.string()),
  screenTexts: z.array(z.string()),
  chronologicalHints: z.array(z.string()),
  confidence: z.number().min(0).max(1),
}).strict();

export const modelMarketingRoleBatchInputSchema = z.object({
  schema: z.literal('auto-video-marketing-role-batch-input.v2'),
  clips: z.array(z.object({
    clipRef: z.string().regex(/^clip_\d{3}$/),
    durationMs: z.number().int().positive(),
    transcript: z.string(),
    visualSummary: z.string().trim().min(1).max(1_500),
    actions: z.array(z.string().trim().min(1).max(160)).max(30),
    scenes: z.array(z.string().trim().min(1).max(300)).max(20),
    screenTexts: z.array(z.string().trim().min(1).max(300)).max(30),
    chronologicalHints: z.array(z.string().trim().min(1).max(300)).max(20),
  }).strict()).min(1).max(AUTO_VIDEO_MAX_ASSET_COUNT),
  userInstruction: z.string().max(2_000),
}).strict();

export const modelMarketingRoleBatchResultSchema = z.object({
  clips: z.array(z.object({
    clipRef: z.string().regex(/^clip_\d{3}$/),
    marketingRole: marketingRoleSchema,
    roleReason: z.string().trim().min(1).max(1_000),
  }).strict()).min(1).max(AUTO_VIDEO_MAX_ASSET_COUNT),
}).strict();
export type ModelMarketingRoleBatchResult = z.infer<typeof modelMarketingRoleBatchResultSchema>;

export const modelEditPlanInputSchema = z.object({
  schema: z.literal('auto-video-edit-plan-input.v2'),
  clips: z.array(z.object({
    clipRef: z.string().regex(/^clip_\d{3}$/),
    durationMs: z.number().int().positive(),
    marketingRole: marketingRoleSchema,
    roleReason: z.string().trim().min(1).max(1_000).optional(),
    audioSummary: z.string().trim().min(1).optional(),
    visualSummary: z.string().trim().min(1),
    people: z.array(z.string()),
    scenes: z.array(z.string()),
    screenTexts: z.array(z.string()),
    chronologicalHints: z.array(z.string()),
  }).strict()).min(1).max(AUTO_VIDEO_MAX_ASSET_COUNT),
  canvas: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().positive(),
  }).strict(),
  userInstruction: z.string().max(2_000).optional(),
  allClipsMustBeUsed: z.literal(true),
}).strict();

export const modelEditPlanResultSchema = z.object({
  clips: z.array(z.object({
    clipRef: z.string().regex(/^clip_\d{3}$/),
    order: z.number().int().positive(),
    reason: z.string().trim().min(1).max(500),
  }).strict()).min(1).max(AUTO_VIDEO_MAX_ASSET_COUNT),
  overallReason: z.string().trim().min(1).max(2_000),
}).strict();
export type ModelEditPlanResult = z.infer<typeof modelEditPlanResultSchema>;

const stringArray = {type: 'array', items: {type: 'string'}} as const;

export const assetVisualResponseFormat = {
  name: 'auto-video-asset-visual-content-v2',
  schema: {
    type: 'object', additionalProperties: false,
    required: ['visualSummary', 'people', 'objects', 'actions', 'scenes', 'screenTexts', 'chronologicalHints', 'confidence', 'needsDetail'],
    properties: {
      visualSummary: {type: 'string'}, people: stringArray, objects: stringArray,
      actions: stringArray, scenes: stringArray, screenTexts: stringArray,
      chronologicalHints: stringArray, confidence: {type: 'number', minimum: 0, maximum: 1},
      needsDetail: {type: 'boolean'}, detailReason: {type: 'string'},
      detailTimestampMs: {type: 'integer', minimum: 0},
    },
  },
} as const;

export const assetUnderstandingResponseFormat = {
  name: 'auto-video-asset-understanding-content-v2',
  schema: {
    type: 'object', additionalProperties: false,
    required: ['visualSummary', 'combinedSummary', 'topics', 'people', 'scenes', 'screenTexts', 'chronologicalHints', 'confidence'],
    properties: {
      audioSummary: {type: 'string'}, visualSummary: {type: 'string'}, combinedSummary: {type: 'string'},
      topics: stringArray, people: stringArray, scenes: stringArray, screenTexts: stringArray,
      chronologicalHints: stringArray, confidence: {type: 'number', minimum: 0, maximum: 1},
    },
  },
} as const;

export const marketingRoleBatchResponseFormat = {
  name: 'auto-video-marketing-role-batch-result-v2',
  schema: {
    type: 'object', additionalProperties: false, required: ['clips'],
    properties: {
      clips: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['clipRef', 'marketingRole', 'roleReason'],
          properties: {
            clipRef: {type: 'string', pattern: '^clip_[0-9]{3}$'},
            marketingRole: {type: 'string', enum: ['hook', 'problem', 'service', 'process', 'detail', 'result', 'offer', 'cta', 'transition']},
            roleReason: {type: 'string', minLength: 1},
          },
        },
      },
    },
  },
} as const;

export const editPlanResponseFormat = {
  name: 'auto-video-edit-plan-result-v2',
  schema: {
    type: 'object', additionalProperties: false, required: ['clips', 'overallReason'],
    properties: {
      clips: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false, required: ['clipRef', 'order', 'reason'],
          properties: {
            clipRef: {type: 'string', pattern: '^clip_[0-9]{3}$'},
            order: {type: 'integer', minimum: 1}, reason: {type: 'string', minLength: 1},
          },
        },
      },
      overallReason: {type: 'string', minLength: 1},
    },
  },
} as const;
