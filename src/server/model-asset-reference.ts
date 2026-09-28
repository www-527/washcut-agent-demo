import {AUTO_VIDEO_MAX_ASSET_COUNT} from '../shared/auto-video-contracts.js';

export type ModelClipRef = `clip_${string}`;

export type ModelAssetReferenceMap = {
  readonly byAssetId: ReadonlyMap<string, ModelClipRef>;
  readonly byClipRef: ReadonlyMap<ModelClipRef, string>;
};

type ModelAssetReferenceError = Error & {
  code: 'MODEL_ASSET_REFERENCE_INVALID';
  retryable: false;
};

const invalidReference = (message: string): ModelAssetReferenceError => {
  const error = new Error(`MODEL_ASSET_REFERENCE_INVALID: ${message}`) as ModelAssetReferenceError;
  error.code = 'MODEL_ASSET_REFERENCE_INVALID';
  error.retryable = false;
  return error;
};

const clipRefAt = (index: number): ModelClipRef => `clip_${String(index + 1).padStart(3, '0')}`;

export const createModelAssetReferenceMap = (
  assetIds: readonly string[],
): ModelAssetReferenceMap => {
  if (!assetIds.length) throw invalidReference('assetIds must not be empty');
  if (assetIds.length > AUTO_VIDEO_MAX_ASSET_COUNT) {
    throw invalidReference(`asset count exceeds ${AUTO_VIDEO_MAX_ASSET_COUNT}`);
  }

  const byAssetId = new Map<string, ModelClipRef>();
  const byClipRef = new Map<ModelClipRef, string>();
  assetIds.forEach((assetId, index) => {
    if (!assetId.trim()) throw invalidReference(`empty assetId at index ${index}`);
    if (byAssetId.has(assetId)) throw invalidReference(`duplicate assetId: ${assetId}`);
    const clipRef = clipRefAt(index);
    byAssetId.set(assetId, clipRef);
    byClipRef.set(clipRef, assetId);
  });

  return {byAssetId, byClipRef};
};

export const toModelClipRef = (
  references: ModelAssetReferenceMap,
  assetId: string,
): ModelClipRef => {
  const clipRef = references.byAssetId.get(assetId);
  if (!clipRef) throw invalidReference(`unknown assetId: ${assetId}`);
  return clipRef;
};

export const toAssetId = (
  references: ModelAssetReferenceMap,
  clipRef: ModelClipRef,
): string => {
  const assetId = references.byClipRef.get(clipRef);
  if (!assetId) throw invalidReference(`unknown clipRef: ${clipRef}`);
  return assetId;
};
