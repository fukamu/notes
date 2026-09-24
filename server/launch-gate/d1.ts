import type { D1DatabaseBinding } from '../../db/d1-types';
import {
  decodeOrThrow,
  objectDecoder,
  safeIntegerDecoder,
} from '../../lib/codec/core';
import { decideLaunchAccess, type LaunchGateDecision } from './core';

const launchGateRowDecoder = objectDecoder(
  {
    public_access_enabled: safeIntegerDecoder({ minimum: 0, maximum: 1 }),
    user_allowed: safeIntegerDecoder({ minimum: 0, maximum: 1 }),
  },
  { unknownFields: 'allow' },
);

export async function readLaunchGateDecision(
  database: D1DatabaseBinding,
  userId: string | undefined,
): Promise<LaunchGateDecision> {
  const input: unknown = await database
    .prepare(
      `SELECT
         public_access_enabled,
         CASE WHEN ? IS NOT NULL AND EXISTS (
           SELECT 1 FROM launch_allowed_users WHERE user_id = ?
         ) THEN 1 ELSE 0 END AS user_allowed
       FROM launch_config
       WHERE singleton = 1`,
    )
    .bind(userId ?? null, userId ?? null)
    .first();

  if (input === null) {
    throw new Error('Production Launch Gate configuration is invalid');
  }
  const row = decodeOrThrow(
    launchGateRowDecoder,
    input,
    'Production Launch Gate D1 row',
  );

  return decideLaunchAccess({
    publicAccessEnabled: row.public_access_enabled === 1,
    userAllowed: row.user_allowed === 1,
  });
}
