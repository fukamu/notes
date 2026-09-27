import { createHash } from 'node:crypto';
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
  EXPECTED_PRODUCTION_DISABLED_ROUTES,
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
    'etc/',
    'etc/ssl/',
    'etc/ssl/certs/',
    'etc/ssl/certs/ca-certificates.crt',
  ];
}

function validManifest(): Record<string, unknown> {
  const fixedBodies: Readonly<Record<string, string>> = {
    'health-ok': '{"status":"ok"}\n',
    'not-ready': '{"status":"not_ready"}\n',
    'not-found-code': '{"code":"not_found"}\n',
    'launch-unavailable': '{"error":"launch-gate-unavailable"}\n',
    unavailable: '{"error":"unavailable"}\n',
  };
  const staticHashes: Readonly<Record<string, string>> = {
    'notes-html': 'e'.repeat(64),
    'pricing-html': 'f'.repeat(64),
  };
  return {
    schemaVersion: 2,
    verifierVersion: 2,
    sourceRevision: revision,
    imageID,
    imageReference: 'fukamu-notes-release-verify:abc-123',
    schemaMigrationVersion: 16,
    runtimeUser: '65532:65532',
    entrypoint: ['/notes'],
    notesBinary: { sha256: 'c'.repeat(64), bytes: 10 },
    frontend: { sha256: 'd'.repeat(64), files: 4, bytes: 20 },
    verifiedRoutes: EXPECTED_PRODUCTION_DISABLED_ROUTES.map((route) => ({
      ...route,
      bodySha256:
        staticHashes[route.bodyKind] ??
        createHash('sha256')
          .update(fixedBodies[route.bodyKind] ?? '')
          .digest('hex'),
    })),
    loopbackSmoke: {
      runtime: 'extracted-image-binary',
      bindAddress: '127.0.0.1',
      exitCode: 0,
      signal: 'SIGTERM',
      gracefulShutdown: true,
      logsSha256: '1'.repeat(64),
    },
    networkNoneLifecycles: [
      {
        containerID: '2'.repeat(64),
        imageID,
        networkMode: 'none',
        exitCode: 0,
        signal: 'SIGTERM',
        gracefulShutdown: true,
        logsSha256: '3'.repeat(64),
      },
      {
        containerID: '4'.repeat(64),
        imageID,
        networkMode: 'none',
        exitCode: 0,
        signal: 'SIGTERM',
        gracefulShutdown: true,
        logsSha256: '5'.repeat(64),
      },
    ],
    productionTransition: {
      status: 'not-performed',
      reason: 'explicit-production-approval-required',
    },
  };
}

describe('release image boundary', () => {
  it('pins the exact production-disabled route matrix independently', () => {
    expect(EXPECTED_PRODUCTION_DISABLED_ROUTES).toEqual([
      {
        method: 'GET',
        path: '/healthz',
        status: 200,
        bodyKind: 'health-ok',
        contentType: 'application/json; charset=utf-8',
        cacheControl: 'no-store',
        vary: '',
      },
      {
        method: 'GET',
        path: '/readyz',
        status: 503,
        bodyKind: 'not-ready',
        contentType: 'application/json; charset=utf-8',
        cacheControl: 'no-store',
        vary: '',
      },
      {
        method: 'GET',
        path: '/',
        status: 200,
        bodyKind: 'notes-html',
        contentType: 'text/html; charset=utf-8',
        cacheControl: 'no-store',
        vary: '',
      },
      {
        method: 'GET',
        path: '/pricing',
        status: 200,
        bodyKind: 'pricing-html',
        contentType: 'text/html; charset=utf-8',
        cacheControl: 'no-store',
        vary: '',
      },
      {
        method: 'GET',
        path: '/cards/release-verification/history',
        status: 200,
        bodyKind: 'notes-html',
        contentType: 'text/html; charset=utf-8',
        cacheControl: 'no-store',
        vary: '',
      },
      {
        method: 'GET',
        path: '/not-a-release-route',
        status: 404,
        bodyKind: 'not-found-code',
        contentType: 'application/json; charset=utf-8',
        cacheControl: 'no-store',
        vary: '',
      },
      {
        method: 'GET',
        path: '/api/not-a-release-route',
        status: 404,
        bodyKind: 'not-found-code',
        contentType: 'application/json; charset=utf-8',
        cacheControl: 'no-store',
        vary: '',
      },
      {
        method: 'GET',
        path: '/api/launch-status',
        status: 503,
        bodyKind: 'launch-unavailable',
        contentType: 'application/json; charset=utf-8',
        cacheControl: 'private, no-store',
        vary: 'Cookie, X-Fukamu-Local-Identity-Assertion',
      },
      {
        method: 'POST',
        path: '/api/sync',
        status: 404,
        bodyKind: 'not-found-code',
        contentType: 'application/json; charset=utf-8',
        cacheControl: 'no-store',
        vary: '',
      },
      {
        method: 'POST',
        path: '/api/v2/sync',
        status: 503,
        bodyKind: 'launch-unavailable',
        contentType: 'application/json; charset=utf-8',
        cacheControl: 'private, no-store',
        vary: 'Cookie, X-Fukamu-Local-Identity-Assertion',
      },
      {
        method: 'GET',
        path: '/api/session-context',
        status: 503,
        bodyKind: 'launch-unavailable',
        contentType: 'application/json; charset=utf-8',
        cacheControl: 'private, no-store',
        vary: 'Cookie, X-Fukamu-Local-Identity-Assertion',
      },
      {
        method: 'GET',
        path: '/api/billing/checkout',
        status: 503,
        bodyKind: 'launch-unavailable',
        contentType: 'application/json; charset=utf-8',
        cacheControl: 'private, no-store',
        vary: 'Cookie, X-Fukamu-Local-Identity-Assertion',
      },
      {
        method: 'POST',
        path: '/api/billing/checkout',
        status: 503,
        bodyKind: 'launch-unavailable',
        contentType: 'application/json; charset=utf-8',
        cacheControl: 'private, no-store',
        vary: 'Cookie, X-Fukamu-Local-Identity-Assertion',
      },
      {
        method: 'GET',
        path: '/api/account/terms-consent',
        status: 503,
        bodyKind: 'launch-unavailable',
        contentType: 'application/json; charset=utf-8',
        cacheControl: 'private, no-store',
        vary: 'Cookie, X-Fukamu-Local-Identity-Assertion',
      },
      {
        method: 'POST',
        path: '/api/account/terms-consent',
        status: 503,
        bodyKind: 'launch-unavailable',
        contentType: 'application/json; charset=utf-8',
        cacheControl: 'private, no-store',
        vary: 'Cookie, X-Fukamu-Local-Identity-Assertion',
      },
      {
        method: 'POST',
        path: '/api/billing/cancel',
        status: 503,
        bodyKind: 'unavailable',
        contentType: 'application/json; charset=utf-8',
        cacheControl: 'no-store',
        vary: '',
      },
      {
        method: 'POST',
        path: '/api/account/deletion',
        status: 503,
        bodyKind: 'unavailable',
        contentType: 'application/json; charset=utf-8',
        cacheControl: 'no-store',
        vary: '',
      },
      {
        method: 'POST',
        path: '/api/account/deletion/status',
        status: 503,
        bodyKind: 'unavailable',
        contentType: 'application/json; charset=utf-8',
        cacheControl: 'no-store',
        vary: '',
      },
      {
        method: 'POST',
        path: '/api/account/privacy-requests',
        status: 503,
        bodyKind: 'unavailable',
        contentType: 'application/json; charset=utf-8',
        cacheControl: 'no-store',
        vary: '',
      },
      {
        method: 'POST',
        path: '/api/account/privacy-requests/status',
        status: 503,
        bodyKind: 'unavailable',
        contentType: 'application/json; charset=utf-8',
        cacheControl: 'no-store',
        vary: '',
      },
    ]);
  });

  it('keeps the final stage scratch-only and wires verification into the shared gate', async () => {
    const [dockerfile, packageSource, verifierSource] = await Promise.all([
      readFile('deploy/Dockerfile', 'utf8'),
      readFile('package.json', 'utf8'),
      readFile('scripts/verify-release-artifact.mts', 'utf8'),
    ]);
    const notesctlStage = dockerfile
      .split('FROM scratch AS notesctl')[1]
      ?.split('FROM scratch AS runtime')[0];
    const runtimeStage = dockerfile.split('FROM scratch AS runtime')[1];
    expect(notesctlStage).toBeDefined();
    expect(notesctlStage).toContain('USER 65532:65532');
    expect(notesctlStage).toContain('ENTRYPOINT ["/notesctl"]');
    expect(notesctlStage).toContain('/out/notesctl /notesctl');
    expect(notesctlStage).toContain('/etc/ssl/certs/ca-certificates.crt');
    expect(notesctlStage).not.toContain('/app/static');
    expect(notesctlStage).not.toMatch(/\/out\/notes\s+\/notes(?:\s|$)/u);
    expect(runtimeStage).toBeDefined();
    expect(runtimeStage).toContain('USER 65532:65532');
    expect(runtimeStage).toContain('org.opencontainers.image.revision');
    expect(runtimeStage).toContain('ENTRYPOINT ["/notes"]');
    expect(runtimeStage).not.toContain('/out/notesctl');
    expect(runtimeStage).not.toMatch(/\b(?:node|npm|npx|node_modules)\b/iu);
    expect(packageSource).toContain('"verify:release"');
    expect(packageSource).toContain('npm run test:e2e &&');
    expect(packageSource).toContain('&& npm run verify:release');
    expect(verifierSource).toContain("'--iidfile'");
    expect(verifierSource).toContain("'--network',\n    'none'");
    expect(verifierSource).toContain("runtime: 'extracted-image-binary'");
    expect(verifierSource).toContain(
      "reason: 'explicit-production-approval-required'",
    );
    expect(verifierSource).not.toContain("'image', 'inspect', imageReference");
    expect(verifierSource).not.toContain('imageArchive,\n    imageReference');
    expect(verifierSource).not.toContain("'none',\n    imageReference");
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
    expect(() =>
      validateRuntimePaths(
        validRuntimePaths().filter(
          (value) => value !== 'etc/ssl/certs/ca-certificates.crt',
        ),
      ),
    ).toThrow('missing required runtime content');
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
    expect(() =>
      validateReleaseManifest({ ...validManifest(), schemaVersion: 1 }),
    ).toThrow('identity');
    expect(() =>
      validateReleaseManifest({ ...validManifest(), verifierVersion: 1 }),
    ).toThrow('identity');
    expect(() =>
      validateReleaseManifest({ ...validManifest(), unexpected: true }),
    ).toThrow('unexpected fields');

    const extraRouteField = structuredClone(validManifest());
    const extraRoutes = extraRouteField.verifiedRoutes as Record<
      string,
      unknown
    >[];
    extraRoutes[0] = { ...extraRoutes[0], unexpected: true };
    expect(() => validateReleaseManifest(extraRouteField)).toThrow(
      'unexpected fields',
    );

    const extraLifecycleField = structuredClone(validManifest());
    const extraLifecycles = extraLifecycleField.networkNoneLifecycles as Record<
      string,
      unknown
    >[];
    extraLifecycles[0] = { ...extraLifecycles[0], unexpected: true };
    expect(() => validateReleaseManifest(extraLifecycleField)).toThrow(
      'unexpected fields',
    );

    const missingRoute = structuredClone(validManifest());
    (missingRoute.verifiedRoutes as unknown[]).pop();
    expect(() => validateReleaseManifest(missingRoute)).toThrow(
      'routes are incomplete',
    );

    const duplicateRoute = structuredClone(validManifest());
    const duplicateRoutes = duplicateRoute.verifiedRoutes as Record<
      string,
      unknown
    >[];
    const firstRoute = duplicateRoutes[0];
    if (firstRoute === undefined) throw new Error('invalid release test setup');
    duplicateRoutes[1] = structuredClone(firstRoute);
    expect(() => validateReleaseManifest(duplicateRoute)).toThrow('route set');

    const changedRoute = structuredClone(validManifest());
    const routes = changedRoute.verifiedRoutes as Record<string, unknown>[];
    routes[0] = { ...routes[0], status: 204 };
    expect(() => validateReleaseManifest(changedRoute)).toThrow('route result');

    const wrongBody = structuredClone(validManifest());
    const wrongBodyRoutes = wrongBody.verifiedRoutes as Record<
      string,
      unknown
    >[];
    wrongBodyRoutes[0] = {
      ...wrongBodyRoutes[0],
      bodySha256: '9'.repeat(64),
    };
    expect(() => validateReleaseManifest(wrongBody)).toThrow('route body');

    const oneNetworkNone = structuredClone(validManifest());
    (oneNetworkNone.networkNoneLifecycles as unknown[]).pop();
    expect(() => validateReleaseManifest(oneNetworkNone)).toThrow(
      'network-none lifecycle evidence',
    );

    const duplicateContainer = structuredClone(validManifest());
    const lifecycles = duplicateContainer.networkNoneLifecycles as Record<
      string,
      unknown
    >[];
    lifecycles[1] = {
      ...lifecycles[1],
      containerID: lifecycles[0]?.containerID,
    };
    expect(() => validateReleaseManifest(duplicateContainer)).toThrow(
      'must be distinct',
    );

    const copiedLogs = structuredClone(validManifest());
    const copiedLogLifecycles = copiedLogs.networkNoneLifecycles as Record<
      string,
      unknown
    >[];
    copiedLogLifecycles[1] = {
      ...copiedLogLifecycles[1],
      logsSha256: copiedLogLifecycles[0]?.logsSha256,
    };
    expect(() => validateReleaseManifest(copiedLogs)).toThrow(
      'must be distinct',
    );

    const transitioned = structuredClone(validManifest());
    transitioned.productionTransition = {
      status: 'performed',
      reason: 'explicit-production-approval-required',
    };
    expect(() => validateReleaseManifest(transitioned)).toThrow(
      'production transition',
    );
  });
});
