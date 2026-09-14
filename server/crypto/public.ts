import type { AccountId, VaultId } from '../../lib/domain/identity';
import type { VaultWrappedKeyFinalizationResult } from './core';

export { createDekRotationService } from './rotation-service';
export { parseDekRotationOperationId } from './rotation-core';
export type {
  DekRotationOperation,
  DekRotationOperationId,
  DekRotationScope,
} from './rotation-core';
export type {
  DekRotationRunResult,
  DekRotationService,
} from './rotation-service';

export type VaultWrappedKeyFinalizationScope = {
  readonly accountId: AccountId;
  readonly vaultId: VaultId;
};

export type VaultWrappedKeyFinalizationPort = {
  finalizeVaultWrappedKeys(
    scope: VaultWrappedKeyFinalizationScope,
  ): Promise<VaultWrappedKeyFinalizationResult>;
};

export type { VaultWrappedKeyFinalizationResult } from './core';
