import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/{unit,integration}/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: [
        'lib/application/notes-runtime.ts',
        'lib/client/browser-clock.ts',
        'lib/client/browser-connectivity.ts',
        'lib/client/http-sync-transport.ts',
        'lib/client/id-generator.ts',
        'lib/client/legacy-notes-runtime.ts',
        'lib/client/offline.ts',
        'lib/domain/**/*.ts',
        'lib/editor/body-document.ts',
        'lib/storage/**/*.ts',
        'server/core/**/*.ts',
      ],
    },
  },
});
