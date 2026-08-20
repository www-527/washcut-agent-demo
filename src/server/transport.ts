import {randomUUID} from 'node:crypto';
import type {Response} from 'express';
import {
  makeEnvelope,
  type Envelope,
  type EnvelopeContext,
  type RegisteredSchema,
  type TransportError,
} from '../shared/contracts.js';

export const TRANSPORT_VERSION = '1.0' as const;
export const DEMO_TENANT_ID = 'tenant_demo';

export const newTransportId = (prefix: 'evt' | 'job' | 'trc' | 'project' | 'ast') => `${prefix}_${randomUUID()}`;

export const createTransportEnvelope = <T>(
  context: EnvelopeContext,
  args: {
    type: string;
    schema: RegisteredSchema;
    data: T;
    producer: string;
    idempotencyKey: string;
    causationId?: string;
  },
): Envelope<T> => makeEnvelope({
  ...context,
  ...args,
  eventId: newTransportId('evt'),
  occurredAt: new Date().toISOString(),
});

export const sendEnvelope = <T>(response: Response, status: number, envelope: Envelope<T>) => {
  response.status(status).type('application/json; charset=utf-8').json(envelope);
};

export const sendTransportError = (
  response: Response,
  status: number,
  context: EnvelopeContext,
  error: TransportError,
  causationId?: string,
) => sendEnvelope(response, status, createTransportEnvelope(context, {
  type: 'request.failed',
  schema: 'error.v1',
  data: error,
  producer: 'business-api',
  idempotencyKey: `${context.jobId}:request-failed:${error.code}`,
  causationId,
}));

export const contextFromHeaders = (headers: Record<string, unknown>): EnvelopeContext => ({
  tenantId: typeof headers['x-tenant-id'] === 'string' ? headers['x-tenant-id'] : DEMO_TENANT_ID,
  projectId: typeof headers['x-project-id'] === 'string' ? headers['x-project-id'] : newTransportId('project'),
  jobId: typeof headers['x-job-id'] === 'string' ? headers['x-job-id'] : newTransportId('job'),
  traceId: typeof headers['x-trace-id'] === 'string' ? headers['x-trace-id'] : newTransportId('trc'),
});
