import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import test from 'node:test';
import {recoverWorkersAfterServerListening} from './server-startup.js';

const closeServer = (server: ReturnType<typeof createServer>) => new Promise<void>((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve());
});

test('worker recovery starts only after this server owns the listening port', async () => {
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  const address = occupied.address();
  if (!address || typeof address === 'string') throw new Error('occupied_server_address_invalid');

  let recoveryCalls = 0;
  const contender = createServer();
  recoverWorkersAfterServerListening(contender, [{recover: () => { recoveryCalls += 1; }}]);
  const listenError = await new Promise<NodeJS.ErrnoException>((resolve) => {
    contender.once('error', resolve);
    contender.listen(address.port, '127.0.0.1');
  });

  assert.equal(listenError.code, 'EADDRINUSE');
  assert.equal(recoveryCalls, 0);
  await closeServer(occupied);
});

test('worker recovery runs once after a successful listening event', async () => {
  let firstWorkerCalls = 0;
  let secondWorkerCalls = 0;
  const server = createServer();
  recoverWorkersAfterServerListening(server, [
    {recover: () => { firstWorkerCalls += 1; }},
    {recover: () => { secondWorkerCalls += 1; }},
  ]);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  assert.equal(firstWorkerCalls, 1);
  assert.equal(secondWorkerCalls, 1);
  await closeServer(server);
});
