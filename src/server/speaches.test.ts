import assert from 'node:assert/strict';
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import test from 'node:test';
import {SpeachesTranscriptionProvider} from './speaches.js';
import {TranscriptionProviderError} from './transcription-provider.js';

const model = 'Systran/faster-whisper-large-v3';

const listen = async (handler: (request: IncomingMessage, response: ServerResponse) => void) => {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test_server_address_missing');
  return {server, baseUrl: `http://127.0.0.1:${address.port}/v1`};
};

const close = (server: ReturnType<typeof createServer>) => new Promise<void>((resolve, reject) => {
  server.closeAllConnections();
  server.close((error) => error ? reject(error) : resolve());
});

test('Speaches provider lazily selects and explicitly unloads Whisper through the process control API', async () => {
  let installed = true;
  let loaded = true;
  const requests: string[] = [];
  const {server, baseUrl} = await listen((request, response) => {
    const url = new URL(request.url ?? '/', baseUrl);
    const pathname = decodeURIComponent(url.pathname);
    requests.push(`${request.method} ${pathname}`);
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && pathname === '/v1/models') {
      response.end(JSON.stringify({data: installed ? [{id: model}] : []}));
      return;
    }
    if (request.method === 'POST' && pathname === `/v1/models/${model}`) {
      installed = true;
      response.end('{}');
      return;
    }
    if (request.method === 'GET' && pathname === '/api/ps') {
      response.end(JSON.stringify({models: loaded ? [model] : []}));
      return;
    }
    if (request.method === 'DELETE' && pathname === `/api/ps/${model}`) {
      loaded = false;
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({detail: 'not found'}));
  });
  try {
    const provider = new SpeachesTranscriptionProvider({baseUrl, model, timeoutMs: 500, maxRetries: 0});
    assert.equal((await provider.status()).ready, true);
    assert.equal((await provider.start()).ready, true);
    assert.equal((await provider.stop()).gpuMemoryReleased, true);
    assert.equal((await provider.status()).ready, true);
    assert.equal(requests.includes(`POST /api/ps/${model}`), false);
    assert.ok(requests.includes(`DELETE /api/ps/${model}`));
    assert.equal(requests.some((request) => request.startsWith('DELETE /v1/models/')), false);
  } finally {
    await close(server);
  }
});

test('Speaches provider preserves a failed unload confirmation as a specific provider error', async () => {
  const {server, baseUrl} = await listen((request, response) => {
    const url = new URL(request.url ?? '/', baseUrl);
    const pathname = decodeURIComponent(url.pathname);
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && pathname === '/v1/models') {
      response.end(JSON.stringify({data: [{id: model}]}));
      return;
    }
    if (request.method === 'GET' && pathname === '/api/ps') {
      response.end(JSON.stringify({models: [model]}));
      return;
    }
    if (request.method === 'DELETE' && pathname === `/api/ps/${model}`) {
      response.end('{}');
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({detail: 'not found'}));
  });
  try {
    const provider = new SpeachesTranscriptionProvider({baseUrl, model, timeoutMs: 500, maxRetries: 0});
    await assert.rejects(
      provider.stop(),
      (error: unknown) => error instanceof TranscriptionProviderError
        && error.code === 'SPEACHES_MODEL_UNLOAD_NOT_CONFIRMED'
        && error.retryable === false,
    );
  } finally {
    await close(server);
  }
});
