import {
  decodeOrThrow,
  literalDecoder,
  objectDecoder,
  refineDecoder,
  type InferDecoder,
} from '@/lib/codec/core';
import { vaultIdDecoder, type VaultContext } from '@/lib/domain/identity';
import { deviceIdDecoder, type DeviceId } from '@/lib/domain/id';
import {
  syncSequenceDecoder,
  type SyncSequence,
  type SyncV2Cursor,
} from '@/lib/sync/v2-protocol';

export const SYNC_V2_CURSOR_VERSION = 'sync-cursor/v2' as const;

export const syncV2CursorClaimsDecoder = refineDecoder(
  objectDecoder({
    version: literalDecoder(SYNC_V2_CURSOR_VERSION),
    vaultId: vaultIdDecoder,
    deviceId: deviceIdDecoder,
    afterSequence: syncSequenceDecoder,
    highWatermark: syncSequenceDecoder,
  }),
  (claims) => claims.afterSequence <= claims.highWatermark,
  'expected afterSequence <= highWatermark',
);

export type SyncV2CursorClaims = InferDecoder<typeof syncV2CursorClaimsDecoder>;

export type SyncV2CursorVerification =
  | { readonly kind: 'verified'; readonly claims: unknown }
  | { readonly kind: 'rejected' };

export type SyncV2CursorAuthenticator = {
  issue(claims: SyncV2CursorClaims): Promise<SyncV2Cursor>;
  verify(cursor: SyncV2Cursor): Promise<SyncV2CursorVerification>;
};

export type SyncV2CursorAuthorization =
  | {
      readonly kind: 'accepted';
      readonly afterSequence: SyncSequence;
      readonly highWatermark: SyncSequence;
    }
  | {
      readonly kind: 'rejected';
      readonly reason: 'vault-mismatch' | 'device-mismatch';
    };

export function decodeSyncV2CursorClaims(input: unknown): SyncV2CursorClaims {
  return decodeOrThrow(syncV2CursorClaimsDecoder, input, 'SyncV2CursorClaims');
}

export function authorizeSyncV2Cursor(
  context: VaultContext,
  expectedDeviceId: DeviceId,
  claims: SyncV2CursorClaims,
): SyncV2CursorAuthorization {
  if (claims.vaultId !== context.vaultId) {
    return { kind: 'rejected', reason: 'vault-mismatch' };
  }
  if (claims.deviceId !== expectedDeviceId) {
    return { kind: 'rejected', reason: 'device-mismatch' };
  }
  return {
    kind: 'accepted',
    afterSequence: claims.afterSequence,
    highWatermark: claims.highWatermark,
  };
}
