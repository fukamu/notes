import { check, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const launchConfig = sqliteTable(
  'launch_config',
  {
    singleton: integer('singleton').primaryKey(),
    publicAccessEnabled: integer('public_access_enabled', {
      mode: 'boolean',
    }).notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    check('launch_config_singleton_check', sql`${table.singleton} = 1`),
    check(
      'launch_config_public_access_check',
      sql`${table.publicAccessEnabled} IN (0, 1)`,
    ),
    check('launch_config_updated_at_check', sql`${table.updatedAt} >= 0`),
  ],
);

export const launchAllowedUsers = sqliteTable(
  'launch_allowed_users',
  {
    userId: text('user_id').primaryKey(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    check(
      'launch_allowed_users_user_id_check',
      sql`length(${table.userId}) BETWEEN 1 AND 256
        AND trim(${table.userId}) = ${table.userId}`,
    ),
    check(
      'launch_allowed_users_created_at_check',
      sql`${table.createdAt} >= 0`,
    ),
  ],
);
