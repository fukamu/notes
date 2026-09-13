import { describe, expect, expectTypeOf, it } from 'vitest';
import type { InferDecoder } from '@/lib/codec/core';
import type { CardId, ConflictId, DeviceId, MutationId } from '@/lib/domain/id';
import type {
  AccountId,
  IdentityId,
  SessionId,
  VaultId,
} from '@/lib/domain/identity';
import type { OidcNonce, OidcState } from '@/lib/domain/oidc';
import {
  pendingMutationDecoder,
  type PendingMutation,
} from '@/lib/domain/types';
import { assertNever } from '@/lib/shared/invariant';

type IsAssignable<TSource, TTarget> = [TSource] extends [TTarget]
  ? true
  : false;
type ExpectFalse<TValue extends false> = TValue;

type CardIsNotMutation = ExpectFalse<IsAssignable<CardId, MutationId>>;
type CardIsNotDevice = ExpectFalse<IsAssignable<CardId, DeviceId>>;
type ConflictIsNotMutation = ExpectFalse<IsAssignable<ConflictId, MutationId>>;
type AccountIsNotVault = ExpectFalse<IsAssignable<AccountId, VaultId>>;
type SessionIsNotIdentity = ExpectFalse<IsAssignable<SessionId, IdentityId>>;
type OidcStateIsNotNonce = ExpectFalse<IsAssignable<OidcState, OidcNonce>>;

describe('type-level contracts', () => {
  it('keeps schema inference, brands, and mutation variants aligned', () => {
    expectTypeOf<PendingMutation>().toEqualTypeOf<
      InferDecoder<typeof pendingMutationDecoder>
    >();
    expectTypeOf<
      Extract<PendingMutation, { kind: 'upsert' }>['conflictIds']
    >().toEqualTypeOf<[]>();
    expectTypeOf<
      Extract<PendingMutation, { kind: 'resolve' }>['conflictIds']
    >().toExtend<[ConflictId, ...ConflictId[]]>();
    expectTypeOf<
      Extract<PendingMutation, { kind: 'resolve' }>['baseServerRevision']
    >().toEqualTypeOf<number>();
    const brandChecks: [
      CardIsNotMutation,
      CardIsNotDevice,
      ConflictIsNotMutation,
      AccountIsNotVault,
      SessionIsNotIdentity,
      OidcStateIsNotNonce,
    ] = [false, false, false, false, false, false];
    expect(brandChecks).toEqual([false, false, false, false, false, false]);
  });

  it('uses a never helper as the exhaustive branch sink', () => {
    const render = (mutation: PendingMutation): string => {
      switch (mutation.kind) {
        case 'upsert':
          return 'upsert';
        case 'resolve':
          return 'resolve';
        default:
          return assertNever(mutation, 'Unhandled mutation');
      }
    };
    expect(render).toBeTypeOf('function');
  });
});
