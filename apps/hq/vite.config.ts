import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the HQ API runs on :8090 and is proxied, so the session cookie stays same-origin.
export default defineConfig({
  plugins: [react()],
  server: { port: 5180, proxy: { '/hq/v1': { target: process.env.HQ_API_URL ?? 'http://localhost:8090', changeOrigin: false } } },
  preview: { port: 5180, proxy: { '/hq/v1': { target: process.env.HQ_API_URL ?? 'http://localhost:8090', changeOrigin: false } } }
});
