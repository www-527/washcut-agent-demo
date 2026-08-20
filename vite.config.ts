import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      // A chat test may wait for the relay's bounded retry sequence. Keep the
      // dev proxy open instead of surfacing the browser's opaque "Failed to fetch".
      '/api': {target: 'http://127.0.0.1:8787', timeout: 360_000, proxyTimeout: 360_000},
      '/uploads': 'http://127.0.0.1:8787',
    },
  },
});
