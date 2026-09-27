import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Go private identity and launch gate boundary', () => {
  it('keeps the local signed issuer out of production and the private key out of server config', async () => {
    const [configuration, main] = await Promise.all([
      readFile('backend/internal/config/config.go', 'utf8'),
      readFile('backend/cmd/notes/main.go', 'utf8'),
    ]);

    expect(configuration).toContain(
      'local-signed is unavailable in production',
    );
    expect(configuration).toContain('NOTES_LOCAL_AUTH_PUBLIC_KEY');
    expect(configuration).not.toContain('NOTES_LOCAL_AUTH_PRIVATE_KEY');
    expect(main).toContain('NewLocalVerifier');
    expect(main).not.toContain('SignLocalAssertion');
  });

  it('rejects the old Sites identity header and keeps launch responses private', async () => {
    const [handler, adapter] = await Promise.all([
      readFile('backend/internal/httpapi/handler.go', 'utf8'),
      readFile('backend/internal/adapters/access/local.go', 'utf8'),
    ]);

    expect(adapter).toContain(
      'LegacySitesHeader    = "Oai-Authenticated-User-Id"',
    );
    expect(handler).toContain(
      'request.Header.Values(accessadapter.LegacySitesHeader)',
    );
    expect(handler).toContain('"private, no-store"');
    expect(handler).toContain('"launch-gate-unavailable"');
  });

  it('reads the launch gate and readiness without request-time DDL', async () => {
    const [gate, readiness] = await Promise.all([
      readFile('backend/internal/adapters/postgres/launch_gate.go', 'utf8'),
      readFile('backend/internal/adapters/postgres/readiness.go', 'utf8'),
    ]);
    const httpSources = await Promise.all(
      (await readdir('backend/internal/httpapi'))
        .filter((name) => name.endsWith('.go') && !name.endsWith('_test.go'))
        .map((name) =>
          readFile(path.join('backend/internal/httpapi', name), 'utf8'),
        ),
    );

    expect(gate).toContain('FROM launch_config WHERE singleton = 1');
    expect(gate).toContain('FROM launch_allowed_users WHERE user_id = $1');
    expect(readiness).toContain('FROM notes_goose_versions');
    expect(readiness).toContain('CROSS JOIN launch_config');
    expect(httpSources.join('\n')).not.toMatch(
      /\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|SCHEMA)\b/i,
    );
  });

  it('records provider, cost, and rollout decisions as pending', async () => {
    const decisions = await readFile('docs/go-migration-decisions.md', 'utf8');

    expect(decisions).toContain('Cloud Run');
    expect(decisions).toContain('Cloud SQL');
    expect(decisions).toContain('Cloudflare Access');
    expect(decisions).toContain('no option is assumed to be free');
    expect(decisions).toContain('separate approvals');
  });
});
