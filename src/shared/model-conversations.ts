import {z} from 'zod';

export const modelConversationStatusSchema = z.enum(['streaming', 'completed', 'failed']);
export type ModelConversationStatus = z.infer<typeof modelConversationStatusSchema>;

export const modelConversationMessageRoleSchema = z.enum(['program', 'user', 'model', 'media']);
export type ModelConversationMessageRole = z.infer<typeof modelConversationMessageRoleSchema>;

export const modelConversationMessageSchema = z.object({
  role: modelConversationMessageRoleSchema,
  label: z.string().min(1).max(100).optional(),
  content: z.string().max(100_000),
}).strict();
export type ModelConversationMessage = z.infer<typeof modelConversationMessageSchema>;

export const modelConversationRecordSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  ownerId: z.string().min(1),
  relayKeyId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  generationId: z.string().min(1).optional(),
  jobId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  assetId: z.string().min(1).optional(),
  source: z.string().min(1).max(120),
  model: z.string().min(1).max(160),
  endpoint: z.string().min(1).max(2_000),
  startedAt: z.string().datetime({offset: true}),
  completedAt: z.string().datetime({offset: true}),
  latencyMs: z.number().int().nonnegative(),
  timeToFirstByteMs: z.number().int().nonnegative().optional(),
  timeToFirstEventMs: z.number().int().nonnegative().optional(),
  timeoutPhase: z.enum(['first_byte', 'idle', 'total']).optional(),
  attempts: z.number().int().positive().max(8),
  status: modelConversationStatusSchema,
  requestMessages: z.array(modelConversationMessageSchema).min(1).max(32),
  responseText: z.string().max(100_000).optional(),
  errorCode: z.string().min(1).max(160).optional(),
  errorMessage: z.string().min(1).max(2_000).optional(),
}).strict();
export type ModelConversationRecord = z.infer<typeof modelConversationRecordSchema>;

export const modelConversationSummarySchema = modelConversationRecordSchema.pick({
  id: true,
  projectId: true,
  generationId: true,
  jobId: true,
  taskId: true,
  assetId: true,
  source: true,
  model: true,
  startedAt: true,
  completedAt: true,
  latencyMs: true,
  attempts: true,
  status: true,
}).extend({
  requestPreview: z.string().max(420),
  responsePreview: z.string().max(420).optional(),
  messageCount: z.number().int().positive(),
}).strict();
export type ModelConversationSummary = z.infer<typeof modelConversationSummarySchema>;

export const modelConversationListSchema = z.object({
  conversations: z.array(modelConversationSummarySchema),
}).strict();

export type ModelConversationLogContext = {
  ownerId: string;
  projectId?: string;
  generationId?: string;
  jobId?: string;
  taskId?: string;
  assetId?: string;
  source: string;
};
