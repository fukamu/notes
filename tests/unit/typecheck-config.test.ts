import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const strictOptions = [
  '"strict": true',
  '"noUncheckedIndexedAccess": true',
  '"exactOptionalPropertyTypes": true',
  '"noImplicitReturns": true',
  '"noFallthroughCasesInSwitch": true',
  '"noImplicitOverride": true',
] as const;

const runtimeConfigs = [
  'tsconfig.json',
  'tsconfig.api.json',
  'tsconfig.service-worker.json',
  'tsconfig.tooling.json',
  'tsconfig.test.json',
] as const;

describe('runtime typecheck configuration', () => {
  it('defines every required strict option in the shared base', async () => {
    const source = await readFile('tsconfig.base.json', 'utf8');
    for (const option of strictOptions) expect(source).toContain(option);
  });

  it('makes every supported runtime inherit the strict base', async () => {
    for (const config of runtimeConfigs) {
      const source = await readFile(config, 'utf8');
      expect(source, config).toContain('"extends": "./tsconfig.base.json"');
    }
  });

  it('includes the server boundary in typecheck, lint, architecture and coverage', async () => {
    const [apiConfig, packageSource, architecture, vitest] = await Promise.all([
      readFile('tsconfig.api.json', 'utf8'),
      readFile('package.json', 'utf8'),
      readFile('tests/unit/architecture.test.ts', 'utf8'),
      readFile('vitest.config.ts', 'utf8'),
    ]);

    expect(apiConfig).toContain('"server/**/*.ts"');
    expect(apiConfig).toContain('"lib/codec/**/*.ts"');
    expect(apiConfig).toContain('"lib/shared/**/*.ts"');
    expect(packageSource).toContain('app/api db server');
    expect(architecture).toContain("'server'");
    expect(architecture).toContain("'server/core'");
    expect(vitest).toContain("'server/**/*.ts'");
  });

  it('includes the extracted data ports and adapters in coverage', async () => {
    const vitest = await readFile('vitest.config.ts', 'utf8');

    for (const target of [
      'lib/application/notes-runtime.ts',
      'lib/application/notes-access.ts',
      'components/session-notes-app.tsx',
      'server/**/*.ts',
      'lib/client/browser-clock.ts',
      'lib/client/browser-connectivity.ts',
      'lib/client/http-sync-transport.ts',
      'lib/client/id-generator.ts',
      'lib/client/legacy-notes-runtime.ts',
      'lib/client/offline.ts',
      'lib/storage/**/*.ts',
    ]) {
      expect(vitest).toContain(`'${target}'`);
    }
  });
});
