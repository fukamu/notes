import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { vaultPartitionMappings } from '../vault-content/d1-schema';

export const vaultEncryptedObjects = sqliteTable(
  'vault_encrypted_objects',
  {
    vaultId: text('vault_id').notNull(),
    objectType: text('object_type').notNull(),
    objectId: text('object_id').notNull(),
    objectRevision: integer('object_revision').notNull(),
    writeId: text('write_id').notNull(),
    objectKey: text('object_key').notNull(),
    plaintextBytes: integer('plaintext_bytes').notNull(),
    ciphertextBytes: integer('ciphertext_bytes').notNull(),
    cryptoVersion: text('crypto_version').notNull(),
    dekVersion: integer('dek_version').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.vaultId,
        table.objectType,
        table.objectId,
        table.objectRevision,
      ],
    }),
    uniqueIndex('idx_vault_encrypted_objects_write').on(
      table.vaultId,
      table.writeId,
    ),
    uniqueIndex('idx_vault_encrypted_objects_key').on(
      table.vaultId,
      table.objectKey,
    ),
    index('idx_vault_encrypted_objects_current').on(
      table.vaultId,
      table.objectType,
      table.objectId,
      table.objectRevision,
    ),
    foreignKey({
      columns: [table.vaultId],
      foreignColumns: [vaultPartitionMappings.vaultId],
      name: 'vault_encrypted_objects_route_fk',
    }).onDelete('cascade'),
    check(
      'vault_encrypted_objects_shape_check',
      sql`${table.objectType} IN ('card', 'conflict')
        AND ${table.objectRevision} > 0
        AND length(${table.objectKey}) = 50
        AND ${table.plaintextBytes} >= 0
        AND ${table.ciphertextBytes} > 0
        AND ${table.cryptoVersion} = 'fukamu-envelope-aes-256-gcm/v1'
        AND ${table.dekVersion} > 0
        AND ${table.createdAt} >= 0`,
    ),
  ],
);

export const vaultEncryptedWriteIntents = sqliteTable(
  'vault_encrypted_write_intents',
  {
    vaultId: text('vault_id').notNull(),
    writeId: text('write_id').notNull(),
    objectType: text('object_type').notNull(),
    objectId: text('object_id').notNull(),
    expectedRevision: integer('expected_revision'),
    objectRevision: integer('object_revision').notNull(),
    objectKey: text('object_key').notNull(),
    plaintextBytes: integer('plaintext_bytes').notNull(),
    cryptoVersion: text('crypto_version').notNull(),
    dekVersion: integer('dek_version').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.vaultId, table.writeId] }),
    uniqueIndex('idx_vault_encrypted_write_intents_target').on(
      table.vaultId,
      table.objectType,
      table.objectId,
      table.objectRevision,
    ),
    uniqueIndex('idx_vault_encrypted_write_intents_key').on(
      table.vaultId,
      table.objectKey,
    ),
    foreignKey({
      columns: [table.vaultId],
      foreignColumns: [vaultPartitionMappings.vaultId],
      name: 'vault_encrypted_write_intents_route_fk',
    }).onDelete('cascade'),
    check(
      'vault_encrypted_write_intents_shape_check',
      sql`${table.objectType} IN ('card', 'conflict')
        AND (${table.expectedRevision} IS NULL OR ${table.expectedRevision} > 0)
        AND ${table.objectRevision} > 0
        AND length(${table.objectKey}) = 50
        AND ${table.plaintextBytes} >= 0
        AND ${table.cryptoVersion} = 'fukamu-envelope-aes-256-gcm/v1'
        AND ${table.dekVersion} > 0
        AND ${table.createdAt} >= 0`,
    ),
  ],
);

export const vaultObjectDeleteOutbox = sqliteTable(
  'vault_object_delete_outbox',
  {
    vaultId: text('vault_id').notNull(),
    objectKey: text('object_key').notNull(),
    attemptCount: integer('attempt_count').notNull(),
    nextAttemptAt: integer('next_attempt_at').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.vaultId, table.objectKey] }),
    index('idx_vault_object_delete_outbox_ready').on(
      table.vaultId,
      table.nextAttemptAt,
      table.objectKey,
    ),
    check(
      'vault_object_delete_outbox_attempt_check',
      sql`${table.attemptCount} >= 0`,
    ),
    check(
      'vault_object_delete_outbox_next_attempt_check',
      sql`${table.nextAttemptAt} >= 0`,
    ),
    check(
      'vault_object_delete_outbox_created_at_check',
      sql`${table.createdAt} >= 0`,
    ),
  ],
);
