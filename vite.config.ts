import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

const requestedWebPort = process.env.WASHCUT_WEB_PORT;
const webPort = requestedWebPort === undefined ? 5173 : Number(requestedWebPort);

if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65_535) {
  throw new Error(`Invalid WASHCUT_WEB_PORT: ${requestedWebPort}`);
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: webPort,
    strictPort: requestedWebPort !== undefined,
    host: '127.0.0.1',
    proxy: {
      // A chat test may wait for the relay's bounded retry sequence. Keep the
      // dev proxy open instead of surfacing the browser's opaque "Failed to fetch".
      '/api': {target: 'http://127.0.0.1:8787', timeout: 360_000, proxyTimeout: 360_000},
      '/uploads': 'http://127.0.0.1:8787',
    },
  },
});
