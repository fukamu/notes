import type {
  DekRotationScope,
  DekRotationSnapshot,
  DekRotationStartPlan,
  DekRotationTransition,
} from './rotation-core';

export type DekRotationLoadResult =
  | { readonly kind: 'found'; readonly snapshot: DekRotationSnapshot }
  | { readonly kind: 'not-found' };

export type DekRotationCommitResult =
  | { readonly kind: 'applied'; readonly snapshot: DekRotationSnapshot }
  | { readonly kind: 'replayed'; readonly snapshot: DekRotationSnapshot }
  | {
      readonly kind: 'conflict';
      readonly current?: DekRotationSnapshot;
    };

export type DekRotationRepository = {
  load(scope: DekRotationScope): Promise<DekRotationLoadResult>;
  start(
    scope: DekRotationScope,
    plan: Extract<DekRotationStartPlan, { kind: 'accepted' }>,
  ): Promise<DekRotationCommitResult>;
  recordGenerated(
    scope: DekRotationScope,
    transition: DekRotationTransition,
  ): Promise<DekRotationCommitResult>;
  promote(
    scope: DekRotationScope,
    transition: DekRotationTransition,
  ): Promise<DekRotationCommitResult>;
};
