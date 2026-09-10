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
});
