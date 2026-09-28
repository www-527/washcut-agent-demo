import type {Server} from 'node:http';

export type RecoverableWorker = {recover(): void};

/**
 * Arms recovery on the server's successful `listening` event. Call this before
 * `server.listen(...)`; a process that loses the port race never starts jobs.
 */
export const recoverWorkersAfterServerListening = (
  server: Server,
  workers: readonly RecoverableWorker[],
) => {
  let recovered = false;
  server.once('listening', () => {
    if (recovered) return;
    recovered = true;
    for (const worker of workers) worker.recover();
  });
};
