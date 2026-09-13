import {
  decodeOrThrow,
  objectDecoder,
  refineDecoder,
  safeIntegerDecoder,
  stringDecoder,
  transformDecoder,
  type Decoder,
  type InferDecoder,
} from '../../lib/codec/core';
import {
  parseCardId,
  parseConflictId,
  parseMutationId,
  type CardId,
  type ConflictId,
  type MutationId,
} from '../../lib/domain/id';

declare const partitionIdBrand: unique symbol;
declare const routingRevisionBrand: unique symbol;
declare const contentRevisionBrand: unique symbol;

export type PartitionId = string & {
  readonly [partitionIdBrand]: 'PartitionId';
};

export type RoutingRevision = number & {
  readonly [routingRevisionBrand]: 'RoutingRevision';
};

export type ContentRevision = number & {
  readonly [contentRevisionBrand]: 'ContentRevision';
};

export type VaultPartitionRoute = {
  readonly partitionId: PartitionId;
  readonly routingRevision: RoutingRevision;
  readonly updatedAt: number;
};

export type VaultCardIndexRecord = {
  readonly cardId: CardId;
  readonly revision: ContentRevision;
  readonly updatedAt: number;
};

export type VaultMutationReceiptRecord = {
  readonly mutationId: MutationId;
  readonly cardId: CardId;
  readonly appliedRevision: ContentRevision;
  readonly createdAt: number;
};

export type VaultConflictIndexRecord = {
  readonly conflictId: ConflictId;
  readonly cardId: CardId;
  readonly serverRevision: ContentRevision;
  readonly createdAt: number;
};

const timestampDecoder = safeIntegerDecoder({ minimum: 0 });
const storedIdentifierDecoder = stringDecoder({ minLength: 36, maxLength: 36 });

export const partitionIdDecoder: Decoder<PartitionId> = transformDecoder(
  refineDecoder(
    stringDecoder({ minLength: 1, maxLength: 64 }),
    (value) => /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value),
    'expected a lowercase partition identifier',
  ),
  // The restricted value above is the runtime proof for this provider-neutral brand.
  (value) => value as PartitionId,
);

export const routingRevisionDecoder: Decoder<RoutingRevision> =
  transformDecoder(
    safeIntegerDecoder({ minimum: 1, maximum: 2_147_483_647 }),
    (value) => value as RoutingRevision,
  );

export const contentRevisionDecoder: Decoder<ContentRevision> =
  transformDecoder(
    safeIntegerDecoder({ minimum: 1, maximum: 2_147_483_647 }),
    (value) => value as ContentRevision,
  );

export function parsePartitionId(input: unknown): PartitionId {
  return decodeOrThrow(partitionIdDecoder, input, 'PartitionId');
}

export function parseRoutingRevision(input: unknown): RoutingRevision {
  return decodeOrThrow(routingRevisionDecoder, input, 'RoutingRevision');
}

export function parseContentRevision(input: unknown): ContentRevision {
  return decodeOrThrow(contentRevisionDecoder, input, 'ContentRevision');
}

export const partitionRouteRowDecoder = objectDecoder({
  partition_id: partitionIdDecoder,
  routing_revision: routingRevisionDecoder,
  updated_at: timestampDecoder,
});

export const cardIndexRowDecoder = objectDecoder({
  card_id: storedIdentifierDecoder,
  revision: contentRevisionDecoder,
  updated_at: timestampDecoder,
});

export const mutationReceiptRowDecoder = objectDecoder({
  mutation_id: storedIdentifierDecoder,
  card_id: storedIdentifierDecoder,
  applied_revision: contentRevisionDecoder,
  created_at: timestampDecoder,
});

export const conflictIndexRowDecoder = objectDecoder({
  conflict_id: storedIdentifierDecoder,
  card_id: storedIdentifierDecoder,
  server_revision: contentRevisionDecoder,
  created_at: timestampDecoder,
});

export type PartitionRouteRow = InferDecoder<typeof partitionRouteRowDecoder>;
export type CardIndexRow = InferDecoder<typeof cardIndexRowDecoder>;
export type MutationReceiptRow = InferDecoder<typeof mutationReceiptRowDecoder>;
export type ConflictIndexRow = InferDecoder<typeof conflictIndexRowDecoder>;

export function mapPartitionRouteRow(
  row: PartitionRouteRow,
): VaultPartitionRoute {
  return {
    partitionId: row.partition_id,
    routingRevision: row.routing_revision,
    updatedAt: row.updated_at,
  };
}

export function mapCardIndexRow(row: CardIndexRow): VaultCardIndexRecord {
  return {
    cardId: parseCardId(row.card_id),
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

export function mapMutationReceiptRow(
  row: MutationReceiptRow,
): VaultMutationReceiptRecord {
  return {
    mutationId: parseMutationId(row.mutation_id),
    cardId: parseCardId(row.card_id),
    appliedRevision: row.applied_revision,
    createdAt: row.created_at,
  };
}

export function mapConflictIndexRow(
  row: ConflictIndexRow,
): VaultConflictIndexRecord {
  return {
    conflictId: parseConflictId(row.conflict_id),
    cardId: parseCardId(row.card_id),
    serverRevision: row.server_revision,
    createdAt: row.created_at,
  };
}
