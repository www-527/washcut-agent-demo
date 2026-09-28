import assert from 'node:assert/strict';
import test from 'node:test';
import {derivePublicUploadView, formatElapsedTime, type PublicUploadProgressItem} from './public-upload-state.js';

const item = (
  name: string,
  size: number,
  status: PublicUploadProgressItem['status'],
  uploadedBytes: number,
): PublicUploadProgressItem => ({file: {name, size}, status, uploadedBytes});

test('100% browser transfer remains a saving state until the server confirms the file', () => {
  const view = derivePublicUploadView({
    phase: 'uploading',
    items: [item('clip.mp4', 1_000, 'uploading', 1_000)],
    taskStatus: 'created',
    now: 20_000,
    startedAt: 5_000,
    lastActivityAt: 19_000,
  });

  assert.equal(view.progress, 100);
  assert.equal(view.stage, 'saving');
  assert.equal(view.allSaved, false);
  assert.equal(view.uploadedCount, 0);
});

test('all saved files with an unstarted task become a start-only recovery state', () => {
  const view = derivePublicUploadView({
    phase: 'idle',
    items: [item('one.mp4', 400, 'uploaded', 400), item('two.mp4', 600, 'uploaded', 600)],
    taskStatus: 'uploaded',
    now: 30_000,
    startedAt: 10_000,
    lastActivityAt: 25_000,
  });

  assert.equal(view.stage, 'start_unconfirmed');
  assert.equal(view.allSaved, true);
  assert.equal(view.remainingCount, 0);
});

test('a failed file pauses the batch while preserving confirmed progress', () => {
  const view = derivePublicUploadView({
    phase: 'idle',
    items: [item('saved.mp4', 400, 'uploaded', 400), item('failed.mp4', 600, 'failed', 120)],
    taskStatus: 'created',
    now: 30_000,
    startedAt: 10_000,
    lastActivityAt: 15_000,
  });

  assert.equal(view.stage, 'paused');
  assert.equal(view.uploadedCount, 1);
  assert.equal(view.transferredBytes, 520);
  assert.equal(view.progress, 52);
});

test('an active transfer is marked slow after fifteen seconds without byte progress', () => {
  const view = derivePublicUploadView({
    phase: 'uploading',
    items: [item('clip.mp4', 1_000, 'uploading', 200)],
    taskStatus: 'created',
    now: 30_000,
    startedAt: 5_000,
    lastActivityAt: 14_000,
  });

  assert.equal(view.stage, 'transferring');
  assert.equal(view.stalled, true);
  assert.equal(view.activityAgeSeconds, 16);
});

test('elapsed time uses short readable Chinese units', () => {
  assert.equal(formatElapsedTime(12), '12 秒');
  assert.equal(formatElapsedTime(60), '1 分钟');
  assert.equal(formatElapsedTime(138), '2 分 18 秒');
});
