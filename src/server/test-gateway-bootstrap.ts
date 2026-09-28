import {existsSync} from 'node:fs';
import path from 'node:path';
import {createServer} from 'node:http';
import {createTestGateway} from './test-gateway.js';
import {createTestAdmin} from './test-admin.js';
import {
  AUTO_VIDEO_VISUAL_CONCURRENCY_DEFAULT,
  AUTO_VIDEO_VISUAL_CONCURRENCY_MAX,
  AUTO_VIDEO_VISUAL_CONCURRENCY_MIN,
} from '../shared/auto-video-contracts.js';

const environmentFile = path.join(process.cwd(), '.env');
if (existsSync(environmentFile)) process.loadEnvFile(environmentFile);

const port = Number(process.env.WASHCUT_TEST_PORT ?? 8790);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid WASHCUT_TEST_PORT: ${process.env.WASHCUT_TEST_PORT}`);
const adminPort = Number(process.env.WASHCUT_TEST_ADMIN_PORT ?? 8791);
if (!Number.isInteger(adminPort) || adminPort < 1 || adminPort > 65_535 || adminPort === port) throw new Error(`Invalid WASHCUT_TEST_ADMIN_PORT: ${process.env.WASHCUT_TEST_ADMIN_PORT}`);

const maxUploadBytes = Number(process.env.WASHCUT_TEST_MAX_UPLOAD_BYTES ?? 1_000 * 1024 * 1024);
if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes < 1) throw new Error(`Invalid WASHCUT_TEST_MAX_UPLOAD_BYTES: ${process.env.WASHCUT_TEST_MAX_UPLOAD_BYTES}`);

const visualConcurrency = Number(process.env.WASHCUT_TEST_VISUAL_CONCURRENCY ?? AUTO_VIDEO_VISUAL_CONCURRENCY_DEFAULT);
if (!Number.isSafeInteger(visualConcurrency)
  || visualConcurrency < AUTO_VIDEO_VISUAL_CONCURRENCY_MIN
  || visualConcurrency > AUTO_VIDEO_VISUAL_CONCURRENCY_MAX) {
  throw new Error(`Invalid WASHCUT_TEST_VISUAL_CONCURRENCY: ${process.env.WASHCUT_TEST_VISUAL_CONCURRENCY}`);
}
const consoleMonitor = process.env.WASHCUT_TEST_CONSOLE_MONITOR !== 'false';

const app = createTestGateway({
  accessCode: process.env.WASHCUT_TEST_ACCESS_CODE ?? '',
  internalBaseUrl: process.env.WASHCUT_INTERNAL_API_URL ?? 'http://127.0.0.1:8787',
  staticDir: process.env.WASHCUT_TEST_STATIC_DIR ?? path.join(process.cwd(), 'dist'),
  maxUploadBytes,
  visualConcurrency,
  consoleMonitor,
});
const adminApp = createTestAdmin({
  internalBaseUrl: process.env.WASHCUT_INTERNAL_API_URL ?? 'http://127.0.0.1:8787',
  staticDir: process.env.WASHCUT_TEST_STATIC_DIR ?? path.join(process.cwd(), 'dist'),
  adminPort,
});

const server = createServer(app);
const adminServer = createServer(adminApp);
server.listen(port, '127.0.0.1', () => {
  console.log(`[washcut-test] Test gateway listening on http://127.0.0.1:${port}/test`);
  if (consoleMonitor) console.log('[washcut-test] 本机监控已开启：操作、任务进度、模型对话与原始错误将在本窗口输出（不输出访问码、API Key 和 Cookie）。');
});
adminServer.listen(adminPort, '127.0.0.1', () => {
  console.log(`[washcut-test] Local administrator dashboard ready on http://127.0.0.1:${adminPort}/admin`);
});
server.on('error', (error: NodeJS.ErrnoException) => {
  console.error('[washcut-test] Gateway failed:', {code: error.code, message: error.message, retryable: error.code === 'EADDRINUSE'});
  adminServer.close();
  process.exitCode = 1;
});
adminServer.on('error', (error: NodeJS.ErrnoException) => {
  console.error('[washcut-test] Administrator dashboard failed:', {code: error.code, message: error.message, retryable: error.code === 'EADDRINUSE'});
  server.close();
  process.exitCode = 1;
});
