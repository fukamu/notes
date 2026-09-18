import {
  decodeOrThrow,
  literalDecoder,
  objectDecoder,
  refineDecoder,
  safeIntegerDecoder,
  stringDecoder,
  transformDecoder,
  unionDecoder,
  type Decoder,
} from '../../lib/codec/core';
import {
  accountIdDecoder,
  vaultIdDecoder,
  type AccountId,
  type VaultId,
} from '../../lib/domain/identity';
import {
  dekVersionDecoder,
  vaultDekMetadataDecoder,
  type DekVersion,
  type VaultDekKeyring,
  type VaultDekMetadata,
} from './core';

declare const rotationOperationIdBrand: unique symbol;
declare const rotationRevisionBrand: unique symbol;

export type DekRotationOperationId = string & {
  readonly [rotationOperationIdBrand]: 'DekRotationOperationId';
};

export type DekRotationRevision = number & {
  readonly [rotationRevisionBrand]: 'DekRotationRevision';
};

export type DekRotationScope = {
  readonly accountId: AccountId;
  readonly vaultId: VaultId;
};

export type DekRotationState =
  | { readonly kind: 'generating' }
  | {
      readonly kind: 'promoting';
      readonly metadata: VaultDekMetadata;
    }
  | {
      readonly kind: 'completed';
      readonly metadata: VaultDekMetadata;
      readonly completedAt: number;
    };

export type DekRotationOperation = DekRotationScope & {
  readonly operationId: DekRotationOperationId;
  readonly revision: DekRotationRevision;
  readonly sourceVersion: DekVersion;
  readonly targetVersion: DekVersion;
  readonly state: DekRotationState;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type DekRotationSnapshot = {
  readonly keyring: VaultDekKeyring;
  readonly operation?: DekRotationOperation;
};

export type DekRotationStartPlan =
  | {
      readonly kind: 'accepted';
      readonly current?: DekRotationOperation;
      readonly next: DekRotationOperation;
    }
  | { readonly kind: 'replayed'; readonly operation: DekRotationOperation }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'active-rotation'
        | 'invalid-snapshot'
        | 'invalid-timestamp'
        | 'version-limit'
        | 'vault-mismatch';
    };

export type DekRotationTransition = {
  readonly current: DekRotationOperation;
  readonly next: DekRotationOperation;
};

export type DekRotationTransitionPlan =
  | { readonly kind: 'accepted'; readonly transition: DekRotationTransition }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'invalid-metadata'
        | 'invalid-snapshot'
        | 'invalid-timestamp'
        | 'revision-limit'
        | 'wrong-state';
    };

const timestampDecoder = safeIntegerDecoder({ minimum: 0 });
export const dekRotationOperationIdDecoder: Decoder<DekRotationOperationId> =
  transformDecoder(
    refineDecoder(
      stringDecoder({ minLength: 36, maxLength: 36 }),
      (value) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          value,
        ),
      'expected a UUIDv7 rotation operation ID',
    ),
    (value) => value as DekRotationOperationId,
  );
export const dekRotationRevisionDecoder: Decoder<DekRotationRevision> =
  transformDecoder(
    safeIntegerDecoder({ minimum: 1, maximum: 2_147_483_647 }),
    (value) => value as DekRotationRevision,
  );

const rotationStateDecoder = unionDecoder(
  objectDecoder({ kind: literalDecoder('generating') }),
  objectDecoder({
    kind: literalDecoder('promoting'),
    metadata: vaultDekMetadataDecoder,
  }),
  objectDecoder({
    kind: literalDecoder('completed'),
    metadata: vaultDekMetadataDecoder,
    completedAt: timestampDecoder,
  }),
);

const rotationOperationShapeDecoder = objectDecoder({
  operationId: dekRotationOperationIdDecoder,
  accountId: accountIdDecoder,
  vaultId: vaultIdDecoder,
  revision: dekRotationRevisionDecoder,
  sourceVersion: dekVersionDecoder,
  targetVersion: dekVersionDecoder,
  state: rotationStateDecoder,
  createdAt: timestampDecoder,
  updatedAt: timestampDecoder,
});

export const dekRotationOperationDecoder: Decoder<DekRotationOperation> =
  transformDecoder(
    refineDecoder(
      rotationOperationShapeDecoder,
      validOperation,
      'expected a consistent DEK rotation operation',
    ),
    (operation): DekRotationOperation => operation,
  );

export function parseDekRotationOperationId(
  input: unknown,
): DekRotationOperationId {
  return decodeOrThrow(
    dekRotationOperationIdDecoder,
    input,
    'DEK rotation operation ID',
  );
}

export function planDekRotationStart(input: {
  readonly scope: DekRotationScope;
  readonly keyring: VaultDekKeyring;
  readonly current?: DekRotationOperation;
  readonly operationId: DekRotationOperationId;
  readonly requestedAt: number;
}): DekRotationStartPlan {
  if (input.keyring.vaultId !== input.scope.vaultId) {
    return { kind: 'rejected', reason: 'vault-mismatch' };
  }
  if (!validTimestamp(input.requestedAt)) {
    return { kind: 'rejected', reason: 'invalid-timestamp' };
  }
  const current = input.current;
  if (current !== undefined) {
    if (
      current.accountId !== input.scope.accountId ||
      current.vaultId !== input.scope.vaultId ||
      !validSnapshot({ keyring: input.keyring, operation: current })
    ) {
      return { kind: 'rejected', reason: 'invalid-snapshot' };
    }
    if (current.operationId === input.operationId) {
      return { kind: 'replayed', operation: current };
    }
    if (current.state.kind !== 'completed') {
      return { kind: 'rejected', reason: 'active-rotation' };
    }
    if (input.requestedAt < current.updatedAt) {
      return { kind: 'rejected', reason: 'invalid-timestamp' };
    }
  }
  const target = dekVersionDecoder.decode(input.keyring.writeVersion + 1);
  if (!target.ok) return { kind: 'rejected', reason: 'version-limit' };
  return {
    kind: 'accepted',
    ...(current === undefined ? {} : { current }),
    next: {
      operationId: input.operationId,
      ...input.scope,
      revision: decodeOrThrow(
        dekRotationRevisionDecoder,
        1,
        'initial DEK rotation revision',
      ),
      sourceVersion: input.keyring.writeVersion,
      targetVersion: target.value,
      state: { kind: 'generating' },
      createdAt: input.requestedAt,
      updatedAt: input.requestedAt,
    },
  };
}

export function planDekRotationGenerated(input: {
  readonly operation: DekRotationOperation;
  readonly metadata: VaultDekMetadata;
  readonly generatedAt: number;
}): DekRotationTransitionPlan {
  if (input.operation.state.kind !== 'generating') {
    return { kind: 'rejected', reason: 'wrong-state' };
  }
  if (
    !validTimestamp(input.generatedAt) ||
    input.generatedAt < input.operation.updatedAt
  ) {
    return { kind: 'rejected', reason: 'invalid-timestamp' };
  }
  if (
    input.metadata.vaultId !== input.operation.vaultId ||
    input.metadata.dekVersion !== input.operation.targetVersion ||
    input.metadata.createdAt < input.operation.createdAt ||
    input.metadata.createdAt > input.generatedAt
  ) {
    return { kind: 'rejected', reason: 'invalid-metadata' };
  }
  return advance(
    input.operation,
    {
      kind: 'promoting',
      metadata: input.metadata,
    },
    input.generatedAt,
  );
}

export function planDekRotationPromotion(input: {
  readonly operation: DekRotationOperation;
  readonly keyring: VaultDekKeyring;
  readonly completedAt: number;
}): DekRotationTransitionPlan {
  if (input.operation.state.kind !== 'promoting') {
    return { kind: 'rejected', reason: 'wrong-state' };
  }
  if (
    !validTimestamp(input.completedAt) ||
    input.completedAt < input.operation.updatedAt
  ) {
    return { kind: 'rejected', reason: 'invalid-timestamp' };
  }
  if (!validSnapshot({ keyring: input.keyring, operation: input.operation })) {
    return { kind: 'rejected', reason: 'invalid-snapshot' };
  }
  return advance(
    input.operation,
    {
      kind: 'completed',
      metadata: input.operation.state.metadata,
      completedAt: input.completedAt,
    },
    input.completedAt,
  );
}

export function validDekRotationSnapshot(
  snapshot: DekRotationSnapshot,
): boolean {
  return validSnapshot(snapshot);
}

export function sameDekRotationOperation(
  left: DekRotationOperation,
  right: DekRotationOperation,
): boolean {
  return (
    left.operationId === right.operationId &&
    left.accountId === right.accountId &&
    left.vaultId === right.vaultId &&
    left.revision === right.revision &&
    left.sourceVersion === right.sourceVersion &&
    left.targetVersion === right.targetVersion &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    sameState(left.state, right.state)
  );
}

export function validDekRotationTransition(
  transition: DekRotationTransition,
): boolean {
  const { current, next } = transition;
  if (
    current.operationId !== next.operationId ||
    current.accountId !== next.accountId ||
    current.vaultId !== next.vaultId ||
    current.sourceVersion !== next.sourceVersion ||
    current.targetVersion !== next.targetVersion ||
    current.createdAt !== next.createdAt ||
    next.revision !== current.revision + 1 ||
    next.updatedAt < current.updatedAt
  ) {
    return false;
  }
  return (
    (current.state.kind === 'generating' && next.state.kind === 'promoting') ||
    (current.state.kind === 'promoting' && next.state.kind === 'completed')
  );
}

function advance(
  current: DekRotationOperation,
  state: DekRotationState,
  updatedAt: number,
): DekRotationTransitionPlan {
  const revision = dekRotationRevisionDecoder.decode(current.revision + 1);
  if (!revision.ok) return { kind: 'rejected', reason: 'revision-limit' };
  const transition = {
    current,
    next: { ...current, revision: revision.value, state, updatedAt },
  };
  return validDekRotationTransition(transition)
    ? { kind: 'accepted', transition }
    : { kind: 'rejected', reason: 'invalid-snapshot' };
}

function validOperation(operation: {
  readonly operationId: DekRotationOperationId;
  readonly accountId: AccountId;
  readonly vaultId: VaultId;
  readonly revision: DekRotationRevision;
  readonly sourceVersion: DekVersion;
  readonly targetVersion: DekVersion;
  readonly state: DekRotationState;
  readonly createdAt: number;
  readonly updatedAt: number;
}): boolean {
  if (
    operation.targetVersion !== operation.sourceVersion + 1 ||
    operation.updatedAt < operation.createdAt
  ) {
    return false;
  }
  switch (operation.state.kind) {
    case 'generating':
      return operation.revision === 1;
    case 'promoting':
      return (
        operation.revision === 2 &&
        validMetadata(operation, operation.state.metadata)
      );
    case 'completed':
      return (
        operation.revision === 3 &&
        operation.state.completedAt === operation.updatedAt &&
        validMetadata(operation, operation.state.metadata)
      );
  }
}

function validSnapshot(snapshot: DekRotationSnapshot): boolean {
  const operation = snapshot.operation;
  if (operation === undefined) return true;
  if (
    operation.vaultId !== snapshot.keyring.vaultId ||
    !validOperation(operation)
  ) {
    return false;
  }
  const expectedWriteVersion =
    operation.state.kind === 'completed'
      ? operation.targetVersion
      : operation.sourceVersion;
  if (snapshot.keyring.writeVersion !== expectedWriteVersion) return false;
  const target = snapshot.keyring.versions.find(
    (metadata) => metadata.dekVersion === operation.targetVersion,
  );
  if (operation.state.kind === 'generating') return target === undefined;
  if (target !== undefined && !sameMetadata(target, operation.state.metadata)) {
    return false;
  }
  return operation.state.kind !== 'completed' || target !== undefined;
}

function validMetadata(
  operation: Pick<
    DekRotationOperation,
    'vaultId' | 'targetVersion' | 'createdAt' | 'updatedAt'
  >,
  metadata: VaultDekMetadata,
): boolean {
  return (
    metadata.vaultId === operation.vaultId &&
    metadata.dekVersion === operation.targetVersion &&
    metadata.createdAt >= operation.createdAt &&
    metadata.createdAt <= operation.updatedAt
  );
}

function sameMetadata(
  left: VaultDekMetadata,
  right: VaultDekMetadata,
): boolean {
  return (
    left.vaultId === right.vaultId &&
    left.dekVersion === right.dekVersion &&
    left.kekKeyReference === right.kekKeyReference &&
    left.wrappedDek === right.wrappedDek &&
    left.createdAt === right.createdAt
  );
}

function sameState(left: DekRotationState, right: DekRotationState): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'generating' || right.kind === 'generating') return true;
  if (!sameMetadata(left.metadata, right.metadata)) return false;
  return (
    left.kind !== 'completed' ||
    (right.kind === 'completed' && left.completedAt === right.completedAt)
  );
}

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
