import assert from 'node:assert/strict';
import test from 'node:test';
import {canReuseMediaUrl} from '../client/use-stable-media-url.js';

const nowMs = Date.UTC(2026, 8, 1, 0, 0, 0);
const nowSeconds = Math.floor(nowMs / 1_000);
const signedUrl = (path: string, expires: number, signature: string, variant?: string) =>
  `http://127.0.0.1:8787${path}?expires=${expires}&signature=${signature}${variant ? `&variant=${variant}` : ''}`;

test('reuses a valid signed URL when only its expiry and signature were refreshed', () => {
  const current = signedUrl('/api/projects/project_a/assets/asset_a/original', nowSeconds + 3_600, 'a'.repeat(64));
  const refreshed = signedUrl('/api/projects/project_a/assets/asset_a/original', nowSeconds + 7_200, 'b'.repeat(64));

  assert.equal(canReuseMediaUrl(current, refreshed, nowMs), true);
});

test('renews a signed URL before it expires', () => {
  const expiring = signedUrl('/api/projects/project_a/output.mp4', nowSeconds + 299, 'a'.repeat(64));
  const refreshed = signedUrl('/api/projects/project_a/output.mp4', nowSeconds + 7_200, 'b'.repeat(64));

  assert.equal(canReuseMediaUrl(expiring, refreshed, nowMs), false);
});

test('does not reuse a URL for a different media resource or variant', () => {
  const current = signedUrl('/api/projects/project_a/output.mp4', nowSeconds + 3_600, 'a'.repeat(64), 'plain');
  const differentPath = signedUrl('/api/projects/project_a/output-captioned.mp4', nowSeconds + 7_200, 'b'.repeat(64), 'plain');
  const differentVariant = signedUrl('/api/projects/project_a/output.mp4', nowSeconds + 7_200, 'c'.repeat(64), 'captioned');

  assert.equal(canReuseMediaUrl(current, differentPath, nowMs), false);
  assert.equal(canReuseMediaUrl(current, differentVariant, nowMs), false);
});
