import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  createSpdxDocument,
  decodeImageInspection,
  decodeNpmProductionDependencies,
  decodeSavedImageLayers,
  parseGoBuildDependencies,
  parseLatestMigrationVersion,
  validateImageInspection,
  validateLayerTypes,
  validateReleaseManifest,
  validateRuntimePaths,
  validateSpdxDocument,
} from '../../scripts/release-artifact-core.mts';

const revision = 'a'.repeat(40);
const imageID = `sha256:${'b'.repeat(64)}`;

function validInspectionCandidate(
  extraEnvironment: readonly string[] = [],
): unknown {
  return [
    {
      Id: imageID,
      Config: {
        User: '65532:65532',
        Entrypoint: ['/notes'],
        Env: [
          'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
          'NOTES_ENVIRONMENT=production',
          'NOTES_HTTP_ADDR=0.0.0.0:8080',
          'NOTES_STATIC_DIR=/app/static',
          'NOTES_BODY_LIMIT_BYTES=4000000',
          'NOTES_SHUTDOWN_TIMEOUT=10s',
          'NOTES_LOG_LEVEL=info',
          ...extraEnvironment,
        ],
        Labels: {
          'org.opencontainers.image.source': 'https://github.com/fukamu/notes',
          'org.opencontainers.image.revision': revision,
          'org.opencontainers.image.title': 'FUKAMU Notes',
        },
      },
    },
  ];
}

function validRuntimePaths(): string[] {
  return [
    'notes',
    'app/',
    'app/static/',
    'app/static/index.html',
    'app/static/sw.js',
    'app/static/manifest.webmanifest',
    'app/static/assets/index-a1b2c3.js',
  ];
}

function validManifest(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    verifierVersion: 1,
    sourceRevision: revision,
    imageID,
    imageReference: 'fukamu-notes-release-verify:abc-123',
    schemaMigrationVersion: 16,
    runtimeUser: '65532:65532',
    entrypoint: ['/notes'],
    notesBinary: { sha256: 'c'.repeat(64), bytes: 10 },
    frontend: { sha256: 'd'.repeat(64), files: 4, bytes: 20 },
    verifiedRoutes: [
      { method: 'GET', path: '/healthz', status: 200 },
      { method: 'GET', path: '/readyz', status: 503 },
      { method: 'GET', path: '/', status: 200 },
      { method: 'GET', path: '/pricing', status: 200 },
      { method: 'GET', path: '/missing', status: 404 },
      { method: 'POST', path: '/api/v2/sync', status: 503 },
    ],
  };
}

describe('release image boundary', () => {
  it('keeps the final stage scratch-only and wires verification into the shared gate', async () => {
    const [dockerfile, packageSource] = await Promise.all([
      readFile('deploy/Dockerfile', 'utf8'),
      readFile('package.json', 'utf8'),
    ]);
    const runtimeStage = dockerfile.split('FROM scratch')[1];
    expect(runtimeStage).toBeDefined();
    expect(runtimeStage).toContain('USER 65532:65532');
    expect(runtimeStage).toContain('org.opencontainers.image.revision');
    expect(runtimeStage).not.toMatch(/\b(?:node|npm|npx|node_modules)\b/iu);
    expect(packageSource).toContain('"verify:release"');
    expect(packageSource).toContain(
      'npm run test:e2e && npm run verify:release',
    );
  });

  it('accepts only the fixed non-root Go runtime and reviewed provenance', () => {
    const inspection = decodeImageInspection(validInspectionCandidate());
    expect(() => validateImageInspection(inspection, revision)).not.toThrow();

    const secretBearing = validInspectionCandidate([
      'NOTES_DATABASE_URL=postgres://secret',
    ]);
    expect(() =>
      validateImageInspection(decodeImageInspection(secretBearing), revision),
    ).toThrow('secret-bearing');
    expect(() =>
      validateImageInspection(
        decodeImageInspection(
          validInspectionCandidate(['UNREVIEWED_DEFAULT=value']),
        ),
        revision,
      ),
    ).toThrow('unexpected default');
  });

  it('rejects malformed saved-image layer references', () => {
    expect(
      decodeSavedImageLayers([
        {
          Layers: [
            `${'a'.repeat(64)}/layer.tar`,
            `blobs/sha256/${'b'.repeat(64)}`,
          ],
        },
      ]),
    ).toHaveLength(2);
    expect(() =>
      decodeSavedImageLayers([{ Layers: ['../layer.tar'] }]),
    ).toThrow('unsafe');
  });

  it('allows regular runtime content and denies links or legacy server artifacts', () => {
    expect(validateRuntimePaths(validRuntimePaths())).toContain('notes');
    expect(() => validateLayerTypes(['lrwxrwxrwx link -> target'])).toThrow(
      'non-regular',
    );
    expect(() =>
      validateRuntimePaths([
        ...validRuntimePaths(),
        ['app', 'api/sync.ts'].join('/'),
      ]),
    ).toThrow('unexpected runtime content');
    expect(() =>
      validateRuntimePaths([...validRuntimePaths(), 'node_modules/x.js']),
    ).toThrow('unexpected runtime content');
    expect(() =>
      validateRuntimePaths(['../notes', ...validRuntimePaths()]),
    ).toThrow('unsafe path');
  });
});

describe('release evidence boundary', () => {
  it('decodes only production npm packages and compiled Go dependencies', () => {
    expect(
      decodeNpmProductionDependencies({
        packages: {
          '': { version: '0.1.0' },
          'node_modules/react': { version: '19.2.6', license: 'MIT' },
          'node_modules/dev-only': { version: '1.0.0', dev: true },
          'node_modules/parent/node_modules/child': { version: '2.0.0' },
        },
      }),
    ).toEqual([
      {
        ecosystem: 'npm',
        name: 'child',
        version: '2.0.0',
        license: 'NOASSERTION',
      },
      { ecosystem: 'npm', name: 'react', version: '19.2.6', license: 'MIT' },
    ]);
    expect(
      parseGoBuildDependencies(
        '/notes: go1.27.1\n\tdep\tgithub.com/jackc/pgx/v5\tv5.8.0\th1:ignored\n',
      ),
    ).toEqual([
      {
        ecosystem: 'golang',
        name: 'github.com/jackc/pgx/v5',
        version: 'v5.8.0',
        license: 'NOASSERTION',
      },
    ]);
  });

  it('decodes the migration version and rejects malformed source declarations', () => {
    expect(
      parseLatestMigrationVersion(
        'package migrations\nconst LatestVersion int64 = 16\n',
      ),
    ).toBe(16);
    expect(() =>
      parseLatestMigrationVersion('const LatestVersion = 0'),
    ).toThrow('missing');
  });

  it('validates the release manifest and SPDX 2.3 dependency evidence', () => {
    expect(validateReleaseManifest(validManifest())).toMatchObject({
      sourceRevision: revision,
      schemaMigrationVersion: 16,
    });
    const sbom = createSpdxDocument(
      revision,
      imageID,
      '2026-09-26T00:00:00.000Z',
      [
        {
          ecosystem: 'npm',
          name: '@scope/package',
          version: '1.0.0',
          license: 'MIT',
        },
      ],
    );
    expect(() => validateSpdxDocument(sbom)).not.toThrow();
    expect(JSON.stringify(sbom)).toContain('pkg:npm/%40scope/package@1.0.0');
    expect(() =>
      createSpdxDocument(revision, imageID, 'not-a-time', []),
    ).toThrow('provenance');
    expect(() =>
      validateReleaseManifest({ ...validManifest(), runtimeUser: '0:0' }),
    ).toThrow('identity');
  });
});
