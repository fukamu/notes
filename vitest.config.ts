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
        'components/session-notes-app.tsx',
        'lib/application/logout-coordination.ts',
        'lib/application/notes-access.ts',
        'lib/application/notes-database-scope.ts',
        'lib/application/logout-purge-progress.ts',
        'lib/application/logout-purge.ts',
        'lib/application/logout-runtime-coordination.ts',
        'lib/application/notes-operation-lifecycle.ts',
        'lib/application/notes-runtime.ts',
        'lib/client/browser-clock.ts',
        'lib/client/browser-logout-coordination.ts',
        'lib/client/browser-connectivity.ts',
        'lib/client/http-sync-transport.ts',
        'lib/client/id-generator.ts',
        'lib/client/legacy-notes-runtime.ts',
        'lib/client/fake-logout-purge-progress.ts',
        'lib/client/notes-store.tsx',
        'lib/client/offline.ts',
        'lib/domain/**/*.ts',
        'lib/editor/body-document.ts',
        'lib/storage/**/*.ts',
        'server/**/*.ts',
      ],
    },
  },
});
