import type {Request} from 'express';

export type AuthContext = {
  tenantId: string;
  userId: string;
  role: 'admin' | 'producer' | 'viewer';
};

export const authFromRequest = (request: Request): AuthContext => {
  const tenantId = String(request.headers['x-tenant-id'] ?? 'tenant_demo');
  const userId = String(request.headers['x-user-id'] ?? 'user_demo');
  const candidate = String(request.headers['x-role'] ?? 'producer');
  const role = candidate === 'admin' || candidate === 'viewer' ? candidate : 'producer';
  if (!/^tenant_[a-zA-Z0-9_-]+$/.test(tenantId) || !/^user_[a-zA-Z0-9_-]+$/.test(userId)) throw new Error('invalid_identity');
  return {tenantId, userId, role};
};

export const canMutate = (auth: AuthContext) => auth.role === 'admin' || auth.role === 'producer';

export const canReadJob = (auth: AuthContext, job: {tenantId: string; ownerId: string}) =>
  job.tenantId === auth.tenantId && (auth.role === 'admin' || job.ownerId === auth.userId);
