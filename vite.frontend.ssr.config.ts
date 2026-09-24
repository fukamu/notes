import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const publicEnvironmentKeys = [
  'FUKAMU_AUTH_ENTRY_URL',
  'FUKAMU_LEGAL_COMMERCE_JSON',
  'FUKAMU_LEGAL_TERMS_JSON',
  'FUKAMU_PRIVACY_DISCLOSURE_JSON',
  'FUKAMU_PRIVACY_PROCESSING_REGISTRY_JSON',
  'FUKAMU_SERVICE_MODE',
  'NEXT_PUBLIC_SITE_URL',
] as const;

const publicEnvironment = Object.fromEntries(
  publicEnvironmentKeys.flatMap((key) => {
    const value = process.env[key];
    return value === undefined ? [] : [[key, value]];
  }),
);

export default defineConfig({
  resolve: { alias: { '@': resolve(import.meta.dirname) } },
  define: { __FUKAMU_PUBLIC_ENV__: JSON.stringify(publicEnvironment) },
  plugins: [react()],
  build: {
    ssr: 'frontend/entry-server.tsx',
    outDir: 'dist/frontend-server',
    emptyOutDir: true,
  },
});
