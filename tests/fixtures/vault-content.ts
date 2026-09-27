import {
  parseAccountId,
  parseSessionEpoch,
  parseSessionId,
  parseVaultId,
  type VaultContext,
} from '@/lib/domain/identity';

const contexts = {
  a: {
    accountId: parseAccountId('01991f20-61d2-7000-8000-000000001101'),
    vaultId: parseVaultId('01991f20-61d2-7000-8000-000000001201'),
    sessionId: parseSessionId('01991f20-61d2-7000-8000-000000001401'),
    sessionEpoch: parseSessionEpoch(1),
  },
  b: {
    accountId: parseAccountId('01991f20-61d2-7000-8000-000000001102'),
    vaultId: parseVaultId('01991f20-61d2-7000-8000-000000001202'),
    sessionId: parseSessionId('01991f20-61d2-7000-8000-000000001402'),
    sessionEpoch: parseSessionEpoch(1),
  },
} as const satisfies Readonly<Record<'a' | 'b', VaultContext>>;

export function vaultContentContext(account: 'a' | 'b'): VaultContext {
  return contexts[account];
}
