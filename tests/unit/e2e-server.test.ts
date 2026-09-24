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
}) {
  const root = await mkdtemp(path.join(tmpdir(), 'fukamu-e2e-server-'));
  temporaryDirectories.push(root);
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'npm.log');
  const environmentLog = path.join(root, 'environment.log');
  await mkdir(bin);
  await writeFile(
    path.join(bin, 'npm'),
    `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' "$*" >> "${log}"\nif [[ "$1 $2" == 'run build' ]]; then\n  mkdir -p dist/server\n  printf '{}' > dist/server/wrangler.json\nfi\nif [[ "$1" == 'start' ]]; then\n  printf 'WRANGLER_WRITE_LOGS=%s\\nWRANGLER_LOG_PATH=%s\\nMINIFLARE_REGISTRY_PATH=%s\\n' "$WRANGLER_WRITE_LOGS" "$WRANGLER_LOG_PATH" "$MINIFLARE_REGISTRY_PATH" > "${environmentLog}"\n  if [[ '${options.failStart ? '1' : '0'}' == '1' ]]; then\n    mkdir -p "$WRANGLER_LOG_PATH"\n    for line_number in $(seq 1 260); do\n      printf 'diagnostic-line-%03d\\n' "$line_number"\n    done > "$WRANGLER_LOG_PATH/wrangler.log"\n    exit 1\n  fi\nfi\n`,
  );
  await chmod(path.join(bin, 'npm'), 0o755);
  if (options.existingBuild) {
    await mkdir(path.join(root, 'dist/server'), { recursive: true });
    await writeFile(path.join(root, 'dist/server/wrangler.json'), '{}');
  }

  const result = await new Promise<{ code: number | null; stderr: string }>(
    (resolve) => {
      const child = spawn('bash', [path.resolve('scripts/e2e-server.sh')], {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          FUKAMU_E2E_USE_PREBUILT: options.prebuilt ? '1' : '0',
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

  const calls = await readFile(log, 'utf8').catch(() => '');
  const environment = await readFile(environmentLog, 'utf8').catch(() => '');
  return { ...result, calls, environment };
}

describe('E2E server build reuse', () => {
  it('limits prebuilt reuse to the E2E child of verify', async () => {
    const packageSource = await readFile('package.json', 'utf8');

    expect(packageSource).toContain(
      '"verify": "npm run contracts:check && npm run format:check && npm run check && npm run go:check && FUKAMU_E2E_USE_PREBUILT=1 npm run test:e2e"',
    );
    expect(packageSource).toContain('"test:e2e": "playwright test"');
  });

  it('builds for standalone E2E even when an old build exists', async () => {
    const result = await createHarness({
      prebuilt: false,
      existingBuild: true,
    });

    expect(result.code).toBe(0);
    expect(result.calls.split('\n')[0]).toBe('run build');
    expect(result.calls).toContain('start -- --port 3100');
  });

  it('uses verified build output only when explicitly requested', async () => {
    const result = await createHarness({ prebuilt: true, existingBuild: true });

    expect(result.code).toBe(0);
    expect(result.calls).not.toContain('run build');
    expect(result.calls).toContain('start -- --port 3100');
  });

  it('isolates Wrangler diagnostics and Miniflare registry state per run', async () => {
    const result = await createHarness({ prebuilt: true, existingBuild: true });

    expect(result.code).toBe(0);
    expect(result.environment).toContain('WRANGLER_WRITE_LOGS=true');

    const logPrefix = 'WRANGLER_LOG_PATH=';
    const registryPrefix = 'MINIFLARE_REGISTRY_PATH=';
    const logLine = result.environment
      .split('\n')
      .find((line) => line.startsWith(logPrefix));
    const registryLine = result.environment
      .split('\n')
      .find((line) => line.startsWith(registryPrefix));

    if (logLine === undefined || registryLine === undefined) {
      throw new Error('Expected isolated Wrangler environment paths.');
    }
    const logPath = logLine.slice(logPrefix.length);
    const registryPath = registryLine.slice(registryPrefix.length);

    expect(path.dirname(logPath)).toBe(path.dirname(registryPath));
    expect(path.basename(logPath)).toBe('wrangler-logs');
    expect(path.basename(registryPath)).toBe('miniflare-registry');
  });

  it('reports the bounded tail of Wrangler diagnostics when startup fails', async () => {
    const result = await createHarness({
      prebuilt: true,
      existingBuild: true,
      failStart: true,
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('diagnostic-line-260');
    expect(result.stderr).not.toContain('diagnostic-line-020');
  });

  it('fails before database setup when requested build output is missing', async () => {
    const result = await createHarness({
      prebuilt: true,
      existingBuild: false,
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('dist/server/wrangler.json is missing');
    expect(result.calls).toBe('');
  });
});
