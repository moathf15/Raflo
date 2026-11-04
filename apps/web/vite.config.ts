import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { cspPlugin } from '../../packages/ui/csp';

// SINGLE_FILE=1 inlines everything into one index.html for the shareable preview (no CSP meta: its script is inline).
const single = !!process.env.SINGLE_FILE;
export default defineConfig({
  plugins: [react(), cspPlugin(process.env.VITE_API_URL, !single), ...(single ? [viteSingleFile()] : [])],
  server: { port: 5173 }
});
