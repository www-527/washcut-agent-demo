import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {bootstrapServer} from './bootstrap.js';

const configuredNames = [
  'DATA_ROOT',
  'MEDIA_SIGNING_SECRET',
  'VIDEO_PART_SIZE_BYTES',
  'FFMPEG_PATH',
  'FFPROBE_PATH',
] as const;

test('bootstrap loads .env before business modules evaluate', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'washcut-bootstrap-'));
  const previousDirectory = process.cwd();
  const previousEnvironment = new Map(configuredNames.map((name) => [name, process.env[name]]));
  const signingSecret = 'bootstrap-test-signing-secret-a';
  const otherSigningSecret = 'bootstrap-test-signing-secret-b';

  try {
    writeFileSync(path.join(directory, '.env'), [
      'DATA_ROOT=isolated-data',
      `MEDIA_SIGNING_SECRET=${signingSecret}`,
      'VIDEO_PART_SIZE_BYTES=1048576',
      'FFMPEG_PATH=ffmpeg-test',
      'FFPROBE_PATH=ffprobe-test',
      '',
    ].join('\n'), 'utf8');
    for (const name of configuredNames) delete process.env[name];
    process.chdir(directory);

    await bootstrapServer(async () => {
      const [{autoVideoPaths, signedAutoVideoUrl, verifyAutoVideoSignature}, {videoPartSizeBytes}] = await Promise.all([
        import('./auto-video-media.js'),
        import('./video-analysis.js'),
      ]);
      const expectedDataRoot = path.join(directory, 'isolated-data');
      assert.equal(autoVideoPaths('project_bootstrap').projectDir, path.join(expectedDataRoot, 'auto-video', 'projects', 'project_bootstrap'));
      assert.equal(videoPartSizeBytes, 1_048_576);

      const signed = new URL(signedAutoVideoUrl('project_bootstrap', 'output', {ttlSeconds: 60}));
      const expires = signed.searchParams.get('expires');
      const signature = signed.searchParams.get('signature');
      const payload = `auto-video:project_bootstrap::output::${expires}`;
      assert.equal(signature, createHmac('sha256', signingSecret).update(payload).digest('hex'));
      assert.notEqual(signature, createHmac('sha256', otherSigningSecret).update(payload).digest('hex'));
      assert.equal(verifyAutoVideoSignature('project_bootstrap', 'output', expires, signature), true);
    });
  } finally {
    process.chdir(previousDirectory);
    for (const [name, value] of previousEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(directory, {recursive: true, force: true});
  }
});
