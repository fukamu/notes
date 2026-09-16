import type { MigrationDefinition } from '../migrations/core';

export const identityVaultControlPlaneStatements = [
  `CREATE TABLE accounts (
    account_id TEXT PRIMARY KEY NOT NULL,
    created_at INTEGER NOT NULL CONSTRAINT accounts_created_at_check CHECK (created_at >= 0)
  )`,
  `CREATE TABLE personal_vaults (
    vault_id TEXT PRIMARY KEY NOT NULL,
    account_id TEXT NOT NULL,
    created_at INTEGER NOT NULL CONSTRAINT personal_vaults_created_at_check CHECK (created_at >= 0),
    CONSTRAINT personal_vaults_account_fk FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
  )`,
  'CREATE UNIQUE INDEX idx_personal_vaults_account ON personal_vaults(account_id)',
  'CREATE UNIQUE INDEX idx_personal_vaults_owner ON personal_vaults(account_id, vault_id)',
  `CREATE TABLE identities (
    identity_id TEXT PRIMARY KEY NOT NULL,
    account_id TEXT NOT NULL,
    provider TEXT NOT NULL CONSTRAINT identities_provider_check CHECK (provider IN ('google-oidc', 'email-otp')),
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    created_at INTEGER NOT NULL CONSTRAINT identities_created_at_check CHECK (created_at >= 0),
    CONSTRAINT identities_account_fk FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
  )`,
  'CREATE UNIQUE INDEX idx_identities_issuer_subject ON identities(issuer, subject)',
  'CREATE INDEX idx_identities_account ON identities(account_id)',
  `CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY NOT NULL,
    account_id TEXT NOT NULL,
    vault_id TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    session_epoch INTEGER NOT NULL CONSTRAINT sessions_epoch_check CHECK (session_epoch > 0),
    issued_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    revocation_reason TEXT,
    CONSTRAINT sessions_owner_fk FOREIGN KEY (account_id, vault_id) REFERENCES personal_vaults(account_id, vault_id) ON DELETE CASCADE,
    CONSTRAINT sessions_timeline_check CHECK (issued_at >= 0 AND expires_at > issued_at),
    CONSTRAINT sessions_revocation_check CHECK (
      (revoked_at IS NULL AND revocation_reason IS NULL) OR
      (revoked_at >= issued_at AND revocation_reason IN ('logout', 'rotated', 'security'))
    )
  )`,
  'CREATE UNIQUE INDEX idx_sessions_token_hash ON sessions(token_hash)',
  'CREATE INDEX idx_sessions_account ON sessions(account_id)',
  'CREATE INDEX idx_sessions_vault ON sessions(vault_id)',
  'CREATE INDEX idx_sessions_expires_at ON sessions(expires_at)',
] as const;

export const identityVaultControlPlaneMigration: MigrationDefinition = {
  id: '0002_identity_vault_control_plane',
  checksum:
    'sha256:6b40f7998457c4746430898bcb2a843b672e82218dfc9d504761a7b0b65bc6dd',
  statements: identityVaultControlPlaneStatements,
};
