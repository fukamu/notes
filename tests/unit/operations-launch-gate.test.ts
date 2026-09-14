import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { BoundaryDecodeError } from '@/lib/codec/core';
import {
  decodeLaunchGateEvidence,
  evaluateLaunchGate,
  operationalActions,
  operationEnvironments,
  planEnvironmentAction,
  type LaunchGateEvidence,
} from '@/server/operations/core';

function completeEvidence(
  overrides: Partial<LaunchGateEvidence> = {},
): LaunchGateEvidence {
  return {
    schemaVersion: 1,
    environment: 'staging',
    action: 'canary-entry',
    target: 'confirmed',
    changeApproval: 'staging-approved',
    review: 'single-operator',
    backup: 'not-required',
    rollbackWindow: { kind: 'open', closesAt: 2_000 },
    telemetry: 'ready',
    decisions: 'resolved',
    migration: 'none',
    canary: 'not-applicable',
    isolatedRestore: 'not-applicable',
    checkedAt: 1_000,
    ...overrides,
  };
}

describe('operations environment policy', () => {
  it('allows fixtures only in local/test and requires gates in staging', () => {
    expect(
      planEnvironmentAction({
        environment: 'local',
        action: 'fixture-drill',
      }),
    ).toEqual({ kind: 'fixture-only' });
    expect(
      planEnvironmentAction({
        environment: 'test',
        action: 'fixture-drill',
      }),
    ).toEqual({ kind: 'fixture-only' });
    expect(
      planEnvironmentAction({
        environment: 'staging',
        action: 'canary-entry',
      }),
    ).toEqual({ kind: 'launch-gate-required' });
    expect(
      planEnvironmentAction({
        environment: 'production',
        action: 'restore-drill',
      }),
    ).toEqual({
      kind: 'blocked',
      reason: 'isolated-staging-restore-required',
    });
  });

  it('never turns production readiness into execution permission', () => {
    for (const action of [
      'canary-entry',
      'canary-promote',
      'canary-abort',
      'code-rollback',
      'data-restore',
    ] as const) {
      expect(
        planEnvironmentAction({ environment: 'production', action }),
      ).toEqual({
        kind: 'launch-gate-and-explicit-approval-required',
        approval: 'explicit-production-operation-approval-required',
      });
    }
  });

  it('blocks destructive and provider configuration actions in every environment', () => {
    for (const environment of operationEnvironments) {
      for (const action of ['data-delete', 'key-destruction'] as const) {
        expect(planEnvironmentAction({ environment, action })).toEqual({
          kind: 'blocked',
          reason: 'destructive-action-outside-launch-workflow',
        });
      }
      for (const action of [
        'webhook-registration',
        'alert-configuration',
      ] as const) {
        expect(planEnvironmentAction({ environment, action })).toEqual({
          kind: 'blocked',
          reason: 'provider-configuration-outside-launch-workflow',
        });
      }
    }
  });

  it('classifies the complete fixed environment/action matrix', () => {
    for (const environment of operationEnvironments) {
      for (const action of operationalActions) {
        expect(planEnvironmentAction({ environment, action }).kind).toMatch(
          /fixture-only|launch-gate-required|launch-gate-and-explicit-approval-required|blocked/,
        );
      }
    }
  });
});

describe('operations launch gate', () => {
  it('accepts complete staging evidence', () => {
    expect(evaluateLaunchGate(completeEvidence())).toEqual({
      kind: 'ready',
      environment: 'staging',
      action: 'canary-entry',
    });
  });

  it('requires a separate production execution approval after all evidence passes', () => {
    expect(
      evaluateLaunchGate(
        completeEvidence({
          environment: 'production',
          changeApproval: 'production-two-person-approved',
          review: 'two-person-confirmed',
        }),
      ),
    ).toEqual({
      kind: 'explicit-approval-required',
      environment: 'production',
      action: 'canary-entry',
      approval: 'explicit-production-operation-approval-required',
    });
  });

  it('returns deterministic blockers for incomplete production evidence', () => {
    expect(
      evaluateLaunchGate(
        completeEvidence({
          environment: 'production',
          target: 'unconfirmed',
          changeApproval: 'missing',
          review: 'single-operator',
          backup: 'missing',
          rollbackWindow: { kind: 'missing' },
          telemetry: 'not-ready',
          decisions: 'decision-required',
          migration: 'destructive',
        }),
      ),
    ).toEqual({
      kind: 'blocked',
      reasons: [
        'target-unconfirmed',
        'change-approval-missing',
        'two-person-review-required',
        'backup-evidence-required',
        'rollback-window-missing',
        'telemetry-not-ready',
        'operational-decision-required',
        'destructive-migration-outside-launch-workflow',
      ],
    });
  });

  it('requires an open rollback window and an observed canary before promotion', () => {
    expect(
      evaluateLaunchGate(
        completeEvidence({
          action: 'canary-promote',
          rollbackWindow: { kind: 'open', closesAt: 1_000 },
          canary: 'not-applicable',
        }),
      ),
    ).toEqual({
      kind: 'blocked',
      reasons: ['rollback-window-closed', 'canary-observation-required'],
    });
    expect(
      evaluateLaunchGate(
        completeEvidence({
          action: 'canary-promote',
          canary: 'aborted',
        }),
      ),
    ).toEqual({ kind: 'blocked', reasons: ['canary-aborted'] });
  });

  it('requires verified backup and isolated restore evidence for recovery', () => {
    expect(
      evaluateLaunchGate(
        completeEvidence({
          action: 'data-restore',
          backup: 'missing',
          isolatedRestore: 'missing',
        }),
      ),
    ).toEqual({
      kind: 'blocked',
      reasons: [
        'backup-evidence-required',
        'isolated-restore-evidence-required',
      ],
    });
    expect(
      evaluateLaunchGate(
        completeEvidence({
          action: 'restore-drill',
          backup: 'verified',
          isolatedRestore: 'verified',
        }),
      ),
    ).toEqual({
      kind: 'ready',
      environment: 'staging',
      action: 'restore-drill',
    });
    expect(
      evaluateLaunchGate(
        completeEvidence({
          environment: 'production',
          action: 'restore-drill',
          changeApproval: 'production-two-person-approved',
          review: 'two-person-confirmed',
          backup: 'verified',
          isolatedRestore: 'verified',
        }),
      ),
    ).toEqual({
      kind: 'blocked',
      reasons: ['isolated-staging-restore-required'],
    });
  });

  it('allows a reviewed abort decision when required telemetry is unavailable', () => {
    expect(
      evaluateLaunchGate(
        completeEvidence({
          environment: 'production',
          action: 'canary-abort',
          changeApproval: 'production-two-person-approved',
          review: 'two-person-confirmed',
          backup: 'missing',
          rollbackWindow: { kind: 'missing' },
          telemetry: 'not-ready',
          decisions: 'decision-required',
          migration: 'destructive',
          canary: 'aborted',
        }),
      ),
    ).toEqual({
      kind: 'explicit-approval-required',
      environment: 'production',
      action: 'canary-abort',
      approval: 'explicit-production-operation-approval-required',
    });
  });

  it('decodes unknown evidence strictly at the boundary', () => {
    expect(
      decodeLaunchGateEvidence(
        completeEvidence({ rollbackWindow: { kind: 'open', closesAt: 2_001 } }),
      ),
    ).toEqual(
      completeEvidence({ rollbackWindow: { kind: 'open', closesAt: 2_001 } }),
    );
    for (const input of [
      { ...completeEvidence(), environment: 'preview' },
      { ...completeEvidence(), checkedAt: -1 },
      { ...completeEvidence(), vaultId: 'sensitive-tenant-id' },
      { ...completeEvidence(), rollbackWindow: { kind: 'open' } },
    ]) {
      expect(() => decodeLaunchGateEvidence(input)).toThrow(
        BoundaryDecodeError,
      );
    }
  });
});

describe('operations runbook static contract', () => {
  it('keeps required procedures, failures and unresolved decisions explicit', async () => {
    const runbook = await readFile(
      'docs/production-operations-runbook.md',
      'utf8',
    );
    for (const heading of [
      '## Environment boundaries',
      '## Restore drill',
      '## Canary gates',
      '## Rollback decision tree',
      '## Failure and escalation matrix',
      '## Decision Required before production',
    ]) {
      expect(runbook).toContain(heading);
    }
    for (const dependency of ['D1', 'R2', 'KMS', 'Stripe', 'auth', 'Sync V2']) {
      expect(runbook).toContain(dependency);
    }
    for (const phase of [
      'Inventory',
      'Isolated restore',
      'Integrity, crypto, and tenant verification',
      'Evidence',
      'Cleanup',
    ]) {
      expect(runbook).toContain(phase);
    }
    expect(runbook).toContain(
      'explicit-production-operation-approval-required',
    );
    expect(runbook).toContain('RTO: Decision Required');
    expect(runbook).toContain('RPO: Decision Required');
    expect(runbook).toContain('SLO: Decision Required');
    expect(runbook).not.toMatch(
      /wrangler\s+(?:deploy|d1|r2)|stripe\s+(?:listen|trigger)|curl\s+-X|sk_live_|whsec_|BEGIN PRIVATE KEY/,
    );
  });
});
