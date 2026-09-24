import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Go PostgreSQL foundation', () => {
  it('keeps migration ledgers distinct and the launch gate default closed', async () => {
    const migration = await readFile(
      'backend/migrations/00001_core.sql',
      'utf8',
    );

    expect(migration).toContain('CREATE TABLE schema_migrations');
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS notes_goose_checksums',
    );
    expect(migration).not.toContain('CREATE TABLE notes_goose_versions');
    expect(migration).toContain('VALUES (1, false, 0)');
    expect(migration).toContain('WHERE revoked_at IS NULL');
  });

  it('does not put schema DDL in request handlers', async () => {
    const directory = 'backend/internal/httpapi';
    const sources = await Promise.all(
      (await readdir(directory))
        .filter((name) => name.endsWith('.go') && !name.endsWith('_test.go'))
        .map((name) => readFile(path.join(directory, name), 'utf8')),
    );

    expect(sources.join('\n')).not.toMatch(
      /\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|SCHEMA)\b/i,
    );
  });

  it('pins a loopback-only ephemeral PostgreSQL fixture', async () => {
    const compose = await readFile('deploy/compose.test.yaml', 'utf8');

    expect(compose).toContain('127.0.0.1:55432:5432');
    expect(compose).toContain('tmpfs:');
    expect(compose).not.toMatch(/^volumes:/m);
  });
});
