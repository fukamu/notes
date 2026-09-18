import {
  decodeOrThrow,
  literalDecoder,
  objectDecoder,
  safeIntegerDecoder,
  transformDecoder,
  unionDecoder,
  type Decoder,
} from '../../lib/codec/core';
import { assertNever } from '../../lib/shared/invariant';

export const operationEnvironments = [
  'local',
  'test',
  'staging',
  'production',
] as const;

export const operationalActions = [
  'fixture-drill',
  'restore-drill',
  'canary-entry',
  'canary-promote',
  'canary-abort',
  'code-rollback',
  'data-restore',
  'data-delete',
  'key-destruction',
  'webhook-registration',
  'alert-configuration',
] as const;

export const launchGateActions = [
  'restore-drill',
  'canary-entry',
  'canary-promote',
  'canary-abort',
  'code-rollback',
  'data-restore',
] as const;

export type OperationEnvironment = (typeof operationEnvironments)[number];
export type OperationalAction = (typeof operationalActions)[number];
export type LaunchGateAction = (typeof launchGateActions)[number];

export type EnvironmentActionPlan =
  | { readonly kind: 'fixture-only' }
  | { readonly kind: 'launch-gate-required' }
  | {
      readonly kind: 'launch-gate-and-explicit-approval-required';
      readonly approval: 'explicit-production-operation-approval-required';
    }
  | {
      readonly kind: 'blocked';
      readonly reason:
        | 'fixture-action-outside-fixture-environment'
        | 'non-fixture-action-in-fixture-environment'
        | 'isolated-staging-restore-required'
        | 'destructive-action-outside-launch-workflow'
        | 'provider-configuration-outside-launch-workflow';
    };

export function planEnvironmentAction(input: {
  readonly environment: OperationEnvironment;
  readonly action: OperationalAction;
}): EnvironmentActionPlan {
  switch (input.action) {
    case 'fixture-drill':
      return input.environment === 'local' || input.environment === 'test'
        ? { kind: 'fixture-only' }
        : {
            kind: 'blocked',
            reason: 'fixture-action-outside-fixture-environment',
          };
    case 'restore-drill':
      if (input.environment === 'staging') {
        return { kind: 'launch-gate-required' };
      }
      return {
        kind: 'blocked',
        reason:
          input.environment === 'production'
            ? 'isolated-staging-restore-required'
            : 'non-fixture-action-in-fixture-environment',
      };
    case 'data-delete':
    case 'key-destruction':
      return {
        kind: 'blocked',
        reason: 'destructive-action-outside-launch-workflow',
      };
    case 'webhook-registration':
    case 'alert-configuration':
      return {
        kind: 'blocked',
        reason: 'provider-configuration-outside-launch-workflow',
      };
    case 'canary-entry':
    case 'canary-promote':
    case 'canary-abort':
    case 'code-rollback':
    case 'data-restore':
      switch (input.environment) {
        case 'local':
        case 'test':
          return {
            kind: 'blocked',
            reason: 'non-fixture-action-in-fixture-environment',
          };
        case 'staging':
          return { kind: 'launch-gate-required' };
        case 'production':
          return {
            kind: 'launch-gate-and-explicit-approval-required',
            approval: 'explicit-production-operation-approval-required',
          };
        default:
          return assertNever(
            input.environment,
            'Unsupported operation environment',
          );
      }
    default:
      return assertNever(input.action, 'Unsupported operational action');
  }
}

export type LaunchGateEvidence = Readonly<{
  schemaVersion: 1;
  environment: 'staging' | 'production';
  action: LaunchGateAction;
  target: 'unconfirmed' | 'confirmed';
  changeApproval:
    | 'missing'
    | 'staging-approved'
    | 'production-two-person-approved';
  review: 'single-operator' | 'two-person-confirmed';
  backup: 'missing' | 'not-required' | 'verified';
  rollbackWindow:
    | { readonly kind: 'missing' }
    | { readonly kind: 'open'; readonly closesAt: number };
  telemetry: 'not-ready' | 'ready';
  decisions: 'decision-required' | 'resolved';
  migration: 'none' | 'backward-compatible' | 'destructive';
  canary: 'not-applicable' | 'observed' | 'aborted';
  isolatedRestore: 'not-applicable' | 'missing' | 'verified';
  checkedAt: number;
}>;

export type LaunchGateBlockReason =
  | 'target-unconfirmed'
  | 'isolated-staging-restore-required'
  | 'change-approval-missing'
  | 'two-person-review-required'
  | 'backup-evidence-required'
  | 'rollback-window-missing'
  | 'rollback-window-closed'
  | 'telemetry-not-ready'
  | 'operational-decision-required'
  | 'destructive-migration-outside-launch-workflow'
  | 'canary-observation-required'
  | 'canary-aborted'
  | 'isolated-restore-evidence-required';

export type LaunchGatePlan =
  | {
      readonly kind: 'blocked';
      readonly reasons: readonly LaunchGateBlockReason[];
    }
  | {
      readonly kind: 'ready';
      readonly environment: 'staging';
      readonly action: LaunchGateAction;
    }
  | {
      readonly kind: 'explicit-approval-required';
      readonly environment: 'production';
      readonly action: LaunchGateAction;
      readonly approval: 'explicit-production-operation-approval-required';
    };

export function evaluateLaunchGate(
  evidence: LaunchGateEvidence,
): LaunchGatePlan {
  const reasons: LaunchGateBlockReason[] = [];
  const isAbort = evidence.action === 'canary-abort';

  if (evidence.target !== 'confirmed') reasons.push('target-unconfirmed');
  if (
    evidence.environment === 'production' &&
    evidence.action === 'restore-drill'
  ) {
    reasons.push('isolated-staging-restore-required');
  }

  if (
    (evidence.environment === 'staging' &&
      evidence.changeApproval !== 'staging-approved') ||
    (evidence.environment === 'production' &&
      evidence.changeApproval !== 'production-two-person-approved')
  ) {
    reasons.push('change-approval-missing');
  }

  if (
    evidence.environment === 'production' &&
    evidence.review !== 'two-person-confirmed'
  ) {
    reasons.push('two-person-review-required');
  }

  const backupRequired =
    !isAbort &&
    (evidence.action === 'restore-drill' ||
      evidence.action === 'data-restore' ||
      evidence.migration !== 'none');
  if (backupRequired && evidence.backup !== 'verified') {
    reasons.push('backup-evidence-required');
  }

  if (!isAbort) {
    switch (evidence.rollbackWindow.kind) {
      case 'missing':
        reasons.push('rollback-window-missing');
        break;
      case 'open':
        if (evidence.rollbackWindow.closesAt <= evidence.checkedAt) {
          reasons.push('rollback-window-closed');
        }
        break;
      default:
        assertNever(evidence.rollbackWindow, 'Unsupported rollback window');
    }

    if (evidence.telemetry !== 'ready') reasons.push('telemetry-not-ready');
    if (evidence.decisions !== 'resolved') {
      reasons.push('operational-decision-required');
    }
    if (evidence.migration === 'destructive') {
      reasons.push('destructive-migration-outside-launch-workflow');
    }
  }

  if (evidence.action === 'canary-promote') {
    if (evidence.canary === 'aborted') reasons.push('canary-aborted');
    else if (evidence.canary !== 'observed') {
      reasons.push('canary-observation-required');
    }
  }

  if (
    (evidence.action === 'restore-drill' ||
      evidence.action === 'data-restore') &&
    evidence.isolatedRestore !== 'verified'
  ) {
    reasons.push('isolated-restore-evidence-required');
  }

  if (reasons.length > 0) return { kind: 'blocked', reasons };
  if (evidence.environment === 'staging') {
    return {
      kind: 'ready',
      environment: 'staging',
      action: evidence.action,
    };
  }
  return {
    kind: 'explicit-approval-required',
    environment: 'production',
    action: evidence.action,
    approval: 'explicit-production-operation-approval-required',
  };
}

const environmentDecoder = unionDecoder(
  literalDecoder('staging'),
  literalDecoder('production'),
);
const launchGateActionDecoder = unionDecoder(
  literalDecoder('restore-drill'),
  literalDecoder('canary-entry'),
  literalDecoder('canary-promote'),
  literalDecoder('canary-abort'),
  literalDecoder('code-rollback'),
  literalDecoder('data-restore'),
);
const launchGateEvidenceDecoder: Decoder<LaunchGateEvidence> = objectDecoder({
  schemaVersion: transformDecoder(
    safeIntegerDecoder({ minimum: 1, maximum: 1 }),
    (): 1 => 1,
  ),
  environment: environmentDecoder,
  action: launchGateActionDecoder,
  target: unionDecoder(
    literalDecoder('unconfirmed'),
    literalDecoder('confirmed'),
  ),
  changeApproval: unionDecoder(
    literalDecoder('missing'),
    literalDecoder('staging-approved'),
    literalDecoder('production-two-person-approved'),
  ),
  review: unionDecoder(
    literalDecoder('single-operator'),
    literalDecoder('two-person-confirmed'),
  ),
  backup: unionDecoder(
    literalDecoder('missing'),
    literalDecoder('not-required'),
    literalDecoder('verified'),
  ),
  rollbackWindow: unionDecoder(
    objectDecoder({ kind: literalDecoder('missing') }),
    objectDecoder({
      kind: literalDecoder('open'),
      closesAt: safeIntegerDecoder({ minimum: 0 }),
    }),
  ),
  telemetry: unionDecoder(literalDecoder('not-ready'), literalDecoder('ready')),
  decisions: unionDecoder(
    literalDecoder('decision-required'),
    literalDecoder('resolved'),
  ),
  migration: unionDecoder(
    literalDecoder('none'),
    literalDecoder('backward-compatible'),
    literalDecoder('destructive'),
  ),
  canary: unionDecoder(
    literalDecoder('not-applicable'),
    literalDecoder('observed'),
    literalDecoder('aborted'),
  ),
  isolatedRestore: unionDecoder(
    literalDecoder('not-applicable'),
    literalDecoder('missing'),
    literalDecoder('verified'),
  ),
  checkedAt: safeIntegerDecoder({ minimum: 0 }),
});

export function decodeLaunchGateEvidence(input: unknown): LaunchGateEvidence {
  return decodeOrThrow(
    launchGateEvidenceDecoder,
    input,
    'Operational launch-gate evidence',
  );
}
