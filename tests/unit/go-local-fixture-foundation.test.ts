import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('Go local fixture foundation boundary', () => {
  it('keeps explicit profile activation separate from the HTTP fixture response switch', async () => {
    const [configuration, main] = await Promise.all([
      readFile('backend/internal/config/config.go', 'utf8'),
      readFile('backend/cmd/notes/main.go', 'utf8'),
    ]);

    expect(configuration).toContain(
      'ApplicationProfileLocalFixture ApplicationProfile = "local-fixture"',
    );
    expect(configuration).toContain(
      'ApplicationProfileDisabled     ApplicationProfile = "disabled"',
    );
    expect(configuration).toContain(
      'values["NOTES_APPLICATION_PROFILE"] == string(ApplicationProfileLocalFixture)',
    );
    expect(main).toContain(
      'EnableDisconnectedFixtures: disconnectedFixturesEnabled(configuration.Environment)',
    );
    expect(main).not.toContain(
      'EnableDisconnectedFixtures: configuration.ApplicationProfile == config.ApplicationProfileLocalFixture',
    );
  });

  it('exposes only complete local Sync v2 and commerce graphs without leaking the foundation or external providers', async () => {
    const [main, handler] = await Promise.all([
      readFile('backend/cmd/notes/main.go', 'utf8'),
      readFile('backend/internal/httpapi/handler.go', 'utf8'),
    ]);

    expect(main).not.toContain('internal/adapters/stripe');
    expect(main).not.toContain('internal/adapters/kms');
    expect(handler).not.toContain('runtimefoundation.LocalFixture');
    expect(main).toMatch(/localFixture\s+\*runtimefoundation\.LocalFixture/);
    expect(main).toMatch(/syncV2\s+\*httpapi\.SyncV2Runtime/);
    expect(main).toContain('if configuration.LocalFixture != nil {');
    expect(handler).toContain('if options.SyncV2Runtime != nil {');
    expect(handler).toContain('legacyHandler = closedAPI');
    expect(main).toContain('internal/adapters/localcommerce');
    const serverOptions = main.slice(
      main.indexOf('httpapi.ServerOptions{'),
      main.indexOf('}); err != nil', main.indexOf('httpapi.ServerOptions{')),
    );
    expect(serverOptions).not.toContain('LocalFixture:');
    expect(serverOptions).toContain('SyncV2Runtime:');
    expect(serverOptions).toContain('LegalRuntime:');
    expect(serverOptions).toContain('BillingCancellationRuntime:');
  });

  it('keeps every destructive E2E reset behind the exact disposable database guard', async () => {
    const source = await readFile('backend/cmd/notesctl/main.go', 'utf8');
    const functionStart = source.indexOf(
      'func prepareLocalFixtureE2EDatabase(',
    );
    const guard = source.indexOf(
      'postgresadapter.ValidateTestDatabaseURL(configuration.DatabaseURL)',
      functionStart,
    );
    const reset = source.indexOf(
      'DROP SCHEMA public CASCADE; CREATE SCHEMA public',
      functionStart,
    );

    expect(functionStart).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(functionStart);
    expect(reset).toBeGreaterThan(guard);
  });
});
