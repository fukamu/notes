import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createHarness(options: {
  prebuilt: boolean;
  existingBuild: boolean;
  failStart?: boolean;
  testDatabaseUrl?: string;
}) {
  const root = await mkdtemp(path.join(tmpdir(), 'fukamu-e2e-server-'));
  temporaryDirectories.push(root);
  const bin = path.join(root, 'bin');
  const npmLog = path.join(root, 'npm.log');
  const goLog = path.join(root, 'go.log');
  const environmentLog = path.join(root, 'environment.log');
  await mkdir(bin);
  await writeFile(
    path.join(bin, 'npm'),
    `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' "$*" >> "${npmLog}"\nif [[ "$1 $2" == 'run build' ]]; then\n  mkdir -p dist/frontend\n  printf '<!doctype html>' > dist/frontend/index.html\nfi\n`,
  );
  await writeFile(
    path.join(bin, 'go'),
    `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' "$*" >> "${goLog}"\nif [[ "$*" == *'run ./cmd/notesctl prepare-e2e'* ]]; then\n  fixture_ready=false\n  if [[ -d "$NOTES_LOCAL_FIXTURE_ROOT" && "$(stat -c '%a' "$NOTES_LOCAL_FIXTURE_ROOT")" == '700' ]]; then fixture_ready=true; fi\n  printf 'NOTES_ENVIRONMENT=%s\\nNOTES_APPLICATION_PROFILE=%s\\nNOTES_DATABASE_URL=%s\\nNOTES_STATIC_DIR=%s\\nNOTES_PRIVATE_AUTH_MODE=%s\\nNOTES_LOCAL_FIXTURE_ROOT_READY=%s\\nNOTES_LOCAL_FIXTURE_SESSION_TOKEN=%s\\n' "$NOTES_ENVIRONMENT" "$NOTES_APPLICATION_PROFILE" "$NOTES_DATABASE_URL" "$NOTES_STATIC_DIR" "$NOTES_PRIVATE_AUTH_MODE" "$fixture_ready" "$NOTES_LOCAL_FIXTURE_SESSION_TOKEN" > "${environmentLog}"\nfi\nif [[ "$*" == *'run ./cmd/notes' && '${options.failStart ? '1' : '0'}' == '1' ]]; then\n  exit 1\nfi\n`,
  );
  await chmod(path.join(bin, 'npm'), 0o755);
  await chmod(path.join(bin, 'go'), 0o755);
  if (options.existingBuild) {
    await mkdir(path.join(root, 'dist/frontend'), { recursive: true });
    await writeFile(
      path.join(root, 'dist/frontend/index.html'),
      '<!doctype html>',
    );
  }

  const result = await new Promise<{ code: number | null; stderr: string }>(
    (resolve) => {
      const child = spawn('bash', [path.resolve('scripts/e2e-server.sh')], {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          FUKAMU_E2E_USE_PREBUILT: options.prebuilt ? '1' : '0',
          FUKAMU_E2E_LOCAL_AUTH_PUBLIC_KEY: 'test-public-key',
          NOTES_LOCAL_AUTH_ISSUER: 'https://issuer.test',
          NOTES_LOCAL_AUTH_AUDIENCE: 'notes-e2e',
          NOTES_LEGACY_OWNER_SUBJECT: 'fukamu-notes-e2e-user',
          NOTES_TEST_DATABASE_URL: options.testDatabaseUrl ?? '',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('close', (code) => resolve({ code, stderr }));
    },
  );

  const npmCalls = await readFile(npmLog, 'utf8').catch(() => '');
  const goCalls = await readFile(goLog, 'utf8').catch(() => '');
  const environment = await readFile(environmentLog, 'utf8').catch(() => '');
  return { ...result, npmCalls, goCalls, environment, root };
}

describe('Go E2E server', () => {
  it('keeps the seeded browser session tied to the local fixture profile', async () => {
    const [server, identity, playwright] = await Promise.all([
      readFile('scripts/e2e-server.sh', 'utf8'),
      readFile('tests/e2e/identity-fixture.ts', 'utf8'),
      readFile('playwright.config.ts', 'utf8'),
    ]);
    const token = server.match(
      /export NOTES_LOCAL_FIXTURE_SESSION_TOKEN=([A-Za-z0-9_-]{43})/,
    )?.[1];
    expect(token).toBeDefined();
    expect(identity).toContain(`'${token}'`);
    expect(identity).toContain("'__Host-fukamu_session'");
    expect(playwright).toContain('e2eSessionCookieName');
    expect(playwright).toContain('e2eSessionToken');
    expect(server).toContain('NOTES_APPLICATION_PROFILE=local-fixture');
    expect(server).not.toContain('NOTES_APPLICATION_PROFILE=disabled');
  });

  it('builds for standalone E2E and prepares an isolated allowlisted database', async () => {
    const result = await createHarness({
      prebuilt: false,
      existingBuild: true,
    });

    expect(result.code).toBe(0);
    expect(result.npmCalls.split('\n')[0]).toBe('run build');
    expect(result.goCalls).toContain('run ./cmd/notesctl prepare-e2e');
    expect(result.goCalls).toContain('run ./cmd/notes');
    expect(result.environment).toContain('NOTES_ENVIRONMENT=test');
    expect(result.environment).toContain(
      'NOTES_APPLICATION_PROFILE=local-fixture',
    );
    expect(result.environment).toContain(
      'NOTES_DATABASE_URL=postgres://notes_test:notes_test_password@127.0.0.1:55432/fukamu_notes_go_test?sslmode=disable',
    );
    expect(result.environment).toContain(
      `NOTES_STATIC_DIR=${result.root}/dist/frontend`,
    );
    expect(result.environment).toContain(
      'NOTES_PRIVATE_AUTH_MODE=local-signed',
    );
    expect(result.environment).toContain('NOTES_LOCAL_FIXTURE_ROOT_READY=true');
    expect(result.environment).toContain(
      'NOTES_LOCAL_FIXTURE_SESSION_TOKEN=QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE',
    );
  });

  it('uses verified frontend output only when explicitly requested', async () => {
    const result = await createHarness({ prebuilt: true, existingBuild: true });

    expect(result.code).toBe(0);
    expect(result.npmCalls).toBe('');
    expect(result.goCalls).toContain('run ./cmd/notesctl prepare-e2e');
  });

  it('uses the explicitly configured isolated test database', async () => {
    const databaseUrl =
      'postgres://notes_test:test_password@127.0.0.1:5432/fukamu_notes_go_test?sslmode=disable';
    const result = await createHarness({
      prebuilt: true,
      existingBuild: true,
      testDatabaseUrl: databaseUrl,
    });

    expect(result.code).toBe(0);
    expect(result.environment).toContain(`NOTES_DATABASE_URL=${databaseUrl}`);
  });

  it('fails before database setup when requested frontend output is missing', async () => {
    const result = await createHarness({
      prebuilt: true,
      existingBuild: false,
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('dist/frontend/index.html is missing');
    expect(result.goCalls).toBe('');
  });

  it('propagates a Go server startup failure', async () => {
    const result = await createHarness({
      prebuilt: true,
      existingBuild: true,
      failStart: true,
    });

    expect(result.code).toBe(1);
  });
});
