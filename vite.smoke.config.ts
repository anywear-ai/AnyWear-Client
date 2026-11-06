import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Smoke-only build: `smoke/index.html` plus `smoke/entry.tsx` to `dist-smoke/`.
// The packaged smoke sets `build.frontendDist` to that directory through
// `src-tauri/tauri.smoke.conf.json`; the shipped app never references it.
export default defineConfig({
  root: 'smoke',
  plugins: [react()],
  build: {
    outDir: '../dist-smoke',
    emptyOutDir: true,
  },
});
