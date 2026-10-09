import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

const apiTarget = process.env.API_URL || 'http://localhost:4000';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '0.0.0.0',
    proxy: {
      '/auth': apiTarget,
      '/jobs': apiTarget,
      '/health': apiTarget,
      '/ready': apiTarget,
    },
  },
  resolve: {
    alias: {
      '@forgeflow/shared': path.resolve(__dirname, '../../packages/shared/src/browser'),
    },
  },
});
