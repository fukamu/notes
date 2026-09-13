import type { AccountId, VaultId } from '../../lib/domain/identity';
import type { VaultWrappedKeyFinalizationResult } from './core';

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
