import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { MOCK_USER_POOL_CLIENT_ID, MOCK_USER_POOL_ID } from './browser/fixture-session';

// Smoke-only build: `smoke/index.html` plus `smoke/entry.tsx` to `dist-smoke/`.
// The packaged smoke sets `build.frontendDist` to that directory through
// `src-tauri/tauri.smoke.conf.json`; the shipped app never references it.
//
// The entry mounts the real `src/App.tsx` tree after its image-cache phase, so
// this config carries what `vite.config.ts` compiles into the shipping bundle:
// the Client version constant, the API origin and the fixture Cognito client.
// `src-tauri/tauri.smoke.conf.json` answers the app's API origin with a loopback
// fixture server (`scripts/packaged-smoke.mjs`, 127.0.0.1:38471).

// Read exactly as `vite.config.ts` does: the repository's single source of truth
// for the Client version, and a build failure if it is missing or malformed.
function readClientVersion(): number {
  const file = new URL('./client-version.json', import.meta.url);
  let source: string;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    throw new Error('client-version.json is missing or unreadable at the repository root');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error('client-version.json must be valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('client-version.json must contain a JSON object');
  }

  const version = (parsed as Record<string, unknown>).client_version;
  if ((parsed as Record<string, unknown>).schema_version !== 1) {
    throw new Error('client-version.json schema_version must be 1');
  }
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
    throw new Error('client-version.json client_version must be a non-negative safe integer');
  }
  return version;
}

const clientVersion = readClientVersion();

export default defineConfig({
  root: 'smoke',
  plugins: [react(), tailwindcss()],
  define: {
    __CLIENT_VERSION__: JSON.stringify(clientVersion),
    'import.meta.env.VITE_API_BASE_URL': JSON.stringify(
      process.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:38471',
    ),
    'import.meta.env.VITE_COGNITO_USER_POOL_ID': JSON.stringify(
      process.env.VITE_COGNITO_USER_POOL_ID ?? MOCK_USER_POOL_ID,
    ),
    'import.meta.env.VITE_COGNITO_CLIENT_ID': JSON.stringify(
      process.env.VITE_COGNITO_CLIENT_ID ?? MOCK_USER_POOL_CLIENT_ID,
    ),
  },
  build: {
    outDir: '../dist-smoke',
    emptyOutDir: true,
  },
});
