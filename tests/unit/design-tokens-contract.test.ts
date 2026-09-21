import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const BUNDLE_ROOT = 'vendor/fukamu-design-tokens/0.1.0';
const CONTRACT_VERSION = '0.1.0';
const SOURCE_REVISION = 'b57d1531f26c14e2f1f82440b9f150a3a185bd16';
const MANIFEST_SHA256 =
  '5c7e8e90873e5581fb70e7676cb5935092fa3a517f46b3a98360c411d7633915';

const ARTIFACTS = new Map([
  [
    'css/tokens.css',
    'f18a82445a7e27db4bedcde9710c5c4744af0c1486e0d55b3cbd65d494ff2213',
  ],
  [
    'figma/mapping.json',
    '32d994c578cb0723304424a3a0846fafdcfbc3db76a2356f41f528899c9dbf6f',
  ],
  [
    'js/index.cjs',
    'a77c369e62885579ae6ec92a38ae8842c0730b622a94b31d700d281adafa0b99',
  ],
  [
    'js/index.mjs',
    'd76293ed4618d825f31de1716c3ddde7879768f67967d0dcfa832b891a86cda8',
  ],
  [
    'json/tokens.json',
    '7927257131b737631e31bc66479584eeaa3f7f86bdc44fcaed1d7c67249b2ba3',
  ],
  [
    'reference/tokens.md',
    'c52f4b697e02efbd18a0999be06c88aa8945ac1c9fa8d2d7b5237fbc82426b03',
  ],
  [
    'types/index.d.ts',
    '9c93d7f1de5db9f04290bf24db359e7b094de3dd55a17a3006760cc5aef8e43e',
  ],
]);

type BundleManifest = {
  contractVersion: string;
  sourceRevision: string;
  mode: string;
  handEdited: boolean;
  artifacts: { path: string; sha256: string }[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeManifest(value: unknown): BundleManifest {
  if (!isRecord(value)) throw new Error('Manifest must be an object');
  const { contractVersion, sourceRevision, mode, handEdited, artifacts } =
    value;
  if (
    typeof contractVersion !== 'string' ||
    typeof sourceRevision !== 'string' ||
    typeof mode !== 'string' ||
    typeof handEdited !== 'boolean' ||
    !Array.isArray(artifacts)
  ) {
    throw new Error('Manifest header is invalid');
  }
  const decodedArtifacts = artifacts.map((artifact) => {
    if (
      !isRecord(artifact) ||
      typeof artifact.path !== 'string' ||
      typeof artifact.sha256 !== 'string'
    ) {
      throw new Error('Manifest artifact is invalid');
    }
    return { path: artifact.path, sha256: artifact.sha256 };
  });
  return {
    contractVersion,
    sourceRevision,
    mode,
    handEdited,
    artifacts: decodedArtifacts,
  };
}

function sha256(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

async function bundleFiles(
  directory = BUNDLE_ROOT,
  prefix = '',
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const relativePath = path.posix.join(prefix, entry.name);
      if (entry.isDirectory()) {
        return bundleFiles(path.join(directory, entry.name), relativePath);
      }
      return [relativePath];
    }),
  );
  return nested.flat().sort();
}

describe('shared design token contract 0.1.0', () => {
  it('vendors the complete immutable bundle and verifies every byte', async () => {
    const manifestPath = path.join(BUNDLE_ROOT, 'manifest.json');
    const manifestSource = await readFile(manifestPath, 'utf8');
    const parsedManifest: unknown = JSON.parse(manifestSource);
    const manifest = decodeManifest(parsedManifest);

    expect((await lstat(manifestPath)).isFile()).toBe(true);
    expect(sha256(manifestSource)).toBe(MANIFEST_SHA256);
    expect(manifest).toMatchObject({
      contractVersion: CONTRACT_VERSION,
      sourceRevision: SOURCE_REVISION,
      mode: 'light',
      handEdited: false,
    });
    expect(
      new Map(manifest.artifacts.map(({ path, sha256 }) => [path, sha256])),
    ).toEqual(ARTIFACTS);
    expect(await bundleFiles()).toEqual(
      ['manifest.json', ...ARTIFACTS.keys()].sort(),
    );

    for (const [artifactPath, expectedHash] of ARTIFACTS) {
      const fullPath = path.join(BUNDLE_ROOT, artifactPath);
      expect((await lstat(fullPath)).isFile()).toBe(true);
      expect(sha256(await readFile(fullPath))).toBe(expectedHash);
    }
  });

  it('loads shared CSS first and maps light roles through public aliases', async () => {
    const css = await readFile('app/globals.css', 'utf8');
    const sharedImport =
      "@import '../vendor/fukamu-design-tokens/0.1.0/css/tokens.css';";
    expect(css.startsWith(`${sharedImport}\n`)).toBe(true);
    expect(
      css.match(/vendor\/fukamu-design-tokens\/0\.1\.0\/css\/tokens\.css/g),
    ).toHaveLength(1);

    const aliases = new Map([
      ['--font-body', '--fukamu-font-family-body-ja'],
      ['--foreground', '--fukamu-color-text-primary'],
      ['--card', '--fukamu-color-surface-default'],
      ['--card-foreground', '--fukamu-color-text-primary'],
      ['--popover', '--fukamu-color-surface-default'],
      ['--popover-foreground', '--fukamu-color-text-primary'],
      ['--muted-foreground', '--fukamu-color-text-secondary'],
      ['--border', '--fukamu-color-border-default'],
      ['--input', '--fukamu-color-border-default'],
      ['--primary', '--fukamu-color-action-primary'],
      ['--primary-hover', '--fukamu-color-action-primary-hover'],
      ['--primary-foreground', '--fukamu-color-action-on-primary'],
      ['--ring', '--fukamu-color-focus-ring'],
      ['--destructive', '--fukamu-color-status-danger-foreground'],
      ['--warning-bg', '--fukamu-color-status-warning-surface'],
      ['--warning-border', '--fukamu-color-status-warning-border'],
      ['--warning-foreground', '--fukamu-color-status-warning-foreground'],
      ['--warning-icon', '--fukamu-color-status-warning-foreground'],
      ['--radius', '--fukamu-radius-lg'],
    ]);
    for (const [compatibilityName, publicName] of aliases) {
      expect(css).toContain(`${compatibilityName}: var(${publicName});`);
    }
    expect(css).not.toContain('var(--fukamu-primitive-');
  });

  it('protects immutable vendor bytes from formatter rewrites', async () => {
    const formatterConfig = await readFile('.oxfmtrc.json', 'utf8');
    expect(formatterConfig).toContain('"vendor/fukamu-design-tokens/**"');
    expect(formatterConfig).not.toContain('"vendor/**"');
  });

  it('bridges Tailwind roles and keeps action and graph primary scopes distinct', async () => {
    const [css, button, hook] = await Promise.all([
      readFile('app/globals.css', 'utf8'),
      readFile('components/ui/button.tsx', 'utf8'),
      readFile('hooks/use-connections-viewport.ts', 'utf8'),
    ]);

    for (const bridge of [
      '--color-primary-hover: var(--primary-hover)',
      '--font-weight-medium: var(--fukamu-font-weight-medium)',
      '--font-weight-semibold: var(--fukamu-font-weight-semibold)',
      '--spacing: var(--fukamu-spacing-1)',
      '--radius-lg: var(--fukamu-radius-lg)',
      '--radius-2xl: var(--fukamu-radius-xl)',
    ]) {
      expect(css).toContain(bridge);
    }
    expect(button).toContain('hover:bg-primary-hover');
    expect(button).not.toContain('hover:bg-primary/80');
    expect(css).toMatch(
      /\.connections-viewport\s*\{\s*--primary: var\(--fukamu-color-accent\);/,
    );
    for (const property of ['--card', '--border', '--primary']) {
      expect(hook).toContain(`getPropertyValue('${property}')`);
    }
    expect(hook).not.toContain('--fukamu-');
  });

  it('retains Notes-owned light decoration and inactive dark definitions', async () => {
    const css = await readFile('app/globals.css', 'utf8');
    for (const ownedValue of [
      "--font-heading: 'Yu Mincho', 'Hiragino Mincho ProN', serif",
      '--background: oklch(0.968 0.013 82)',
      '--secondary: oklch(0.925 0.025 78)',
      '--muted: oklch(0.93 0.014 78)',
      '--accent: oklch(0.9 0.035 71)',
      '--link-bg: oklch(0.92 0.035 252)',
      '--warning-surface: oklch(1 0 0 / 70%)',
      '.paper-sheet',
    ]) {
      expect(css).toContain(ownedValue);
    }

    const darkStart = css.indexOf('.dark {');
    const darkEnd = css.indexOf('@layer base', darkStart);
    expect(darkStart).toBeGreaterThan(-1);
    expect(darkEnd).toBeGreaterThan(darkStart);
    const dark = css.slice(darkStart, darkEnd);
    expect(dark).toContain('--background: oklch(0.2 0.015 55)');
    expect(dark).toContain('--primary: oklch(0.72 0.09 252)');
    expect(dark).not.toContain('--fukamu-');
  });
});
