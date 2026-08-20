import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {videoAnalysisResultSchema, videoUploadCreateSchema} from '../shared/contracts.js';
import {nativeResponseErrorText} from '../client/api.js';
import {SqliteStore} from './store.js';

const directory = mkdtempSync(path.join(os.tmpdir(), 'washcut-video-analysis-'));
process.env.DATA_ROOT = directory;
process.env.VIDEO_PART_SIZE_BYTES = '4';

const analysis = await import('./video-analysis.js');
const auth = {tenantId: 'tenant_video', userId: 'user_video', role: 'producer' as const};

test.after(() => rmSync(directory, {recursive: true, force: true}));

test('chunk upload records resumable parts and creates one idempotent analysis task', async () => {
  const store = new SqliteStore(path.join(directory, 'chunks.sqlite'), 'test-only-encryption-secret');
  const source = Buffer.from('abcdefghij');
  const input = videoUploadCreateSchema.parse({
    filename: 'sample.mp4', mime_type: 'video/mp4', size_bytes: source.length,
    sha256: createHash('sha256').update(source).digest('hex'), prompt: '总结画面', language: 'zh-CN',
    idempotency_key: 'upload-test-key',
  });
  const session = analysis.createVideoUploadSession(store, auth, 'project_video_test', input);
  assert.equal(session.part_size_bytes, 4);
  assert.equal(session.total_parts, 3);
  assert.equal(analysis.createVideoUploadSession(store, auth, 'project_video_test', input).upload_id, session.upload_id);

  let current = session;
  for (let index = 0; index < 3; index += 1) {
    const partNumber = index + 1;
    const start = index * 4;
    const bytes = source.subarray(start, Math.min(source.length, start + 4));
    const end = start + bytes.length - 1;
    current = await analysis.saveVideoUploadPart(
      store, current, partNumber, bytes, `bytes ${start}-${end}/${source.length}`,
      createHash('sha256').update(bytes).digest('hex'),
    );
  }
  assert.deepEqual(current.completed_part_numbers, [1, 2, 3]);
  const assembled = await analysis.assembleVideoUpload(store, current);
  assert.deepEqual(readFileSync(assembled), source);
  const task = await analysis.createTaskForUpload(store, current, auth, 'trace_video_test');
  const duplicate = await analysis.createTaskForUpload(store, {...current, task_id: task.task_id}, auth, 'trace_video_test');
  assert.equal(duplicate.task_id, task.task_id);
  assert.equal(store.getVideoAnalysisTask(task.task_id, auth.tenantId)?.status, 'queued');
  store.close();
});

test('chunk upload rejects a mismatched range or digest without marking the part complete', async () => {
  const store = new SqliteStore(path.join(directory, 'invalid.sqlite'), 'test-only-encryption-secret');
  const bytes = Buffer.from('abcd');
  const session = analysis.createVideoUploadSession(store, auth, 'project_video_bad', videoUploadCreateSchema.parse({
    filename: 'bad.mp4', mime_type: 'video/mp4', size_bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), prompt: '检查', language: 'zh-CN',
  }));
  await assert.rejects(() => analysis.saveVideoUploadPart(store, session, 1, bytes, 'bytes 1-4/4', createHash('sha256').update(bytes).digest('hex')), /upload_content_range_invalid/);
  await assert.rejects(() => analysis.saveVideoUploadPart(store, session, 1, bytes, 'bytes 0-3/4', '0'.repeat(64)), /upload_part_sha256_mismatch/);
  assert.deepEqual(store.listVideoUploadParts(session.upload_id), []);
  store.close();
});

test('URL policy blocks non-HTTPS and local/private destinations before fetching', async () => {
  await assert.rejects(() => analysis.assertPublicHttpsUrl('http://example.com/video.mp4'), /video_url_not_allowed/);
  await assert.rejects(() => analysis.assertPublicHttpsUrl('https://127.0.0.1/video.mp4'), /video_url_not_allowed/);
  await assert.rejects(() => analysis.assertPublicHttpsUrl('https://localhost/video.mp4'), /video_url_not_allowed/);
  await assert.rejects(() => analysis.assertPublicHttpsUrl('https://10.0.0.5/video.mp4'), /video_url_not_allowed/);
});

test('unified analysis result requires grounded metadata, timeline and transcript arrays', () => {
  const result = videoAnalysisResultSchema.parse({
    summary: '车辆进入画面。', transcript: [],
    timeline: [{start: 0, end: 2.5, description: '车辆进入画面', tags: ['vehicle']}],
    entities: [{type: 'vehicle', label: '车辆', appearances: [{start: 0, end: 2.5}]}],
    metadata: {duration_seconds: 2.5, width: 1080, height: 1920, fps: 30, has_audio: false, source_sha256: 'a'.repeat(64), model_version: 'test.v1', prompt: '定位车辆', language: 'zh-CN', warnings: []},
  });
  assert.equal(result.timeline[0]?.description, '车辆进入画面');
  assert.throws(() => videoAnalysisResultSchema.parse({...result, transcript: [{start: 2, end: 1, text: 'bad'}]}), /transcript_end_before_start/);
});

test('browser upload errors expose the native server detail without a friendly wrapper', () => {
  const body = JSON.stringify({
    payload: {data: {code: 'asset_magic_mime_mismatch', message: '请求处理失败，文件未进入项目。', details: 'asset_magic_mime_mismatch'}},
  });
  assert.equal(nativeResponseErrorText(body, 'Bad Request'), 'asset_magic_mime_mismatch');
  assert.equal(nativeResponseErrorText('upstream connection reset', 'Bad Gateway'), 'upstream connection reset');
  assert.equal(nativeResponseErrorText('', 'Payload Too Large'), 'Payload Too Large');
});
