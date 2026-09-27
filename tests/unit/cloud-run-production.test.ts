import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const renderer = 'scripts/render-cloud-run-production.mts';
const example = 'deploy/cloud-run/production.values.example.json';
const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('Cloud Run restricted-production deployment', () => {
  it('renders digest-pinned, production-only service and operations manifests', async () => {
    const output = await temporaryDirectory('notes-cloud-run-');
    await execute(
      process.execPath,
      [
        '--experimental-strip-types',
        renderer,
        '--values',
        example,
        '--output',
        output,
      ],
      { cwd: process.cwd() },
    );
    const [service, operations] = await Promise.all([
      readFile(path.join(output, 'runtime.service.yaml'), 'utf8'),
      readFile(path.join(output, 'operations.job.yaml'), 'utf8'),
    ]);

    expect(service).toContain('image: asia-southeast1-docker.pkg.dev/');
    expect(service).toContain(
      '@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    expect(service).toContain('value: production');
    expect(service).toContain('value: google-oidc');
    expect(service).toContain(
      'run.googleapis.com/invoker-iam-disabled: "true"',
    );
    expect(service).toContain('autoscaling.knative.dev/minScale: "0"');
    expect(service).toContain('autoscaling.knative.dev/maxScale: "2"');
    expect(service).toContain('path: /readyz');
    expect(service).toContain('path: /healthz');
    expect(service).toContain('name: notes-runtime-database-url');
    expect(service).toContain('key: "1"');
    expect(operations).toContain(
      '@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    );
    expect(operations).toContain('serviceAccountName: notes-operations@');
    expect(operations).toContain('parallelism: 1');
    expect(operations).toContain('taskCount: 1');
    expect(operations).toContain('maxRetries: 0');
    expect(operations).toContain('name: notes-operations-database-url');
    expect(`${service}\n${operations}`).not.toMatch(
      /@@|:latest|key: "latest"|local-fixture|local-signed|NOTES_LOCAL_|NOTES_GCP_KMS_ACCESS_TOKEN/u,
    );
  });

  it('rejects mutable images, latest secrets, identity reuse, and unknown fields', async () => {
    const source: unknown = JSON.parse(await readFile(example, 'utf8'));
    if (!isRecord(source) || !isRecord(source.secrets))
      throw new Error('invalid fixture');
    const invalidCases = [
      {
        ...source,
        runtimeImageDigest:
          'asia-southeast1-docker.pkg.dev/example/notes/runtime:latest',
      },
      {
        ...source,
        secrets: {
          ...source.secrets,
          cursorHmacKey: { name: 'notes-cursor-hmac-key', version: 'latest' },
        },
      },
      { ...source, operationsServiceAccount: source.runtimeServiceAccount },
      { ...source, unexpected: true },
    ];

    for (const [index, value] of invalidCases.entries()) {
      const directory = await temporaryDirectory('notes-cloud-run-invalid-');
      const valuesPath = path.join(directory, `invalid-${index}.json`);
      await writeFile(valuesPath, JSON.stringify(value), {
        encoding: 'utf8',
        mode: 0o600,
      });
      await expect(
        execute(
          process.execPath,
          [
            '--experimental-strip-types',
            renderer,
            '--values',
            valuesPath,
            '--check',
          ],
          { cwd: process.cwd() },
        ),
      ).rejects.toBeDefined();
    }
  });

  it('refuses to overwrite an already rendered release manifest', async () => {
    const output = await temporaryDirectory('notes-cloud-run-existing-');
    const command = [
      '--experimental-strip-types',
      renderer,
      '--values',
      example,
      '--output',
      output,
    ];
    await execute(process.execPath, command, { cwd: process.cwd() });
    await expect(
      execute(process.execPath, command, { cwd: process.cwd() }),
    ).rejects.toBeDefined();
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}
