import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
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

function publicEnvironment(): Readonly<Record<string, string>> {
  return Object.fromEntries(
    publicEnvironmentKeys.flatMap((key) => {
      const value = process.env[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

export default defineConfig({
  root: 'frontend',
  publicDir: '../public',
  resolve: { alias: { '@': resolve(import.meta.dirname) } },
  define: { __FUKAMU_PUBLIC_ENV__: JSON.stringify(publicEnvironment()) },
  css: { postcss: { plugins: [tailwindcss()] } },
  plugins: [react()],
  build: {
    outDir: '../dist/frontend',
    emptyOutDir: true,
    manifest: true,
  },
});
