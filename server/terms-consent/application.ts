import {
  acceptedTermsStatus,
  decideTermsConsentStatus,
  type TermsConsentStatus,
} from './application-core';
import { planTermsConsent, planTermsDisclosureSnapshot } from './core';
import {
  currentTermsSourceValueDecoder,
  termsDocumentHashDecoder,
  type CurrentTermsSourcePort,
  type TermsAcceptancePolicy,
  type TermsConsentCommand,
  type TermsConsentId,
  type TermsConsentRecord,
  type TermsConsentRepository,
  type TermsConsentSnapshot,
  type TermsConsentScope,
  type TermsDocumentHasherPort,
} from './public';

export type TermsConsentApplicationResult =
  | {
      readonly kind: 'accepted';
      readonly outcome: 'status' | 'recorded' | 'replayed';
      readonly status: TermsConsentStatus;
    }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'invalid-current-terms'
        | 'hash-unavailable'
        | 'classification-required'
        | 'inconsistent-evidence'
        | 'invalid-command'
        | 'consent-required'
        | 'stale-terms'
        | 'owner-mismatch'
        | 'identifier-conflict'
        | 'unavailable';
    };

export type TermsConsentApplication = {
  status(input: {
    readonly context: TermsConsentScope;
  }): Promise<TermsConsentApplicationResult>;
  accept(input: {
    readonly context: TermsConsentScope;
    readonly command: TermsConsentCommand;
    readonly consentId: TermsConsentId;
    readonly acceptedAt: number;
  }): Promise<TermsConsentApplicationResult>;
};

export function createTermsConsentApplication(dependencies: {
  readonly source: CurrentTermsSourcePort;
  readonly hasher: TermsDocumentHasherPort;
  readonly repository: TermsConsentRepository;
}): TermsConsentApplication {
  async function current(): Promise<
    | {
        readonly kind: 'ready';
        readonly snapshot: TermsConsentSnapshot;
        readonly acceptancePolicy: TermsAcceptancePolicy;
      }
    | {
        readonly kind: 'rejected';
        readonly reason: 'invalid-current-terms' | 'hash-unavailable';
      }
  > {
    let candidate: unknown;
    try {
      candidate = dependencies.source.readCurrent();
    } catch {
      return { kind: 'rejected', reason: 'invalid-current-terms' };
    }
    const decoded = currentTermsSourceValueDecoder.decode(candidate);
    if (!decoded.ok) {
      return { kind: 'rejected', reason: 'invalid-current-terms' };
    }

    const withoutHash = planTermsDisclosureSnapshot(decoded.value.disclosure);
    if (withoutHash.kind === 'rejected') {
      return { kind: 'rejected', reason: 'invalid-current-terms' };
    }
    let hashCandidate: unknown;
    try {
      hashCandidate = await dependencies.hasher.hash(
        withoutHash.snapshot.serializedTerms,
      );
    } catch {
      return { kind: 'rejected', reason: 'hash-unavailable' };
    }
    const hash = termsDocumentHashDecoder.decode(hashCandidate);
    if (!hash.ok) return { kind: 'rejected', reason: 'hash-unavailable' };
    return {
      kind: 'ready',
      snapshot: { ...withoutHash.snapshot, termsHash: hash.value },
      acceptancePolicy: decoded.value.acceptancePolicy,
    };
  }

  return {
    async status(input): Promise<TermsConsentApplicationResult> {
      const prepared = await current();
      if (prepared.kind === 'rejected') return prepared;
      let latest: TermsConsentRecord | undefined;
      try {
        latest = await dependencies.repository.findLatest(input.context);
      } catch {
        return rejected('unavailable');
      }
      const plan = decideTermsConsentStatus({
        context: input.context,
        current: prepared.snapshot,
        latest,
        acceptancePolicy: prepared.acceptancePolicy,
      });
      return plan.kind === 'resolved'
        ? { kind: 'accepted', outcome: 'status', status: plan.status }
        : rejected(plan.reason);
    },

    async accept(input): Promise<TermsConsentApplicationResult> {
      const prepared = await current();
      if (prepared.kind === 'rejected') return prepared;
      let existing: TermsConsentRecord | undefined;
      try {
        existing = await dependencies.repository.findBySubmission(
          input.context,
          input.command.submissionId,
        );
      } catch {
        return rejected('unavailable');
      }
      const plan = planTermsConsent({
        ...input,
        snapshot: prepared.snapshot,
        existing,
      });
      if (plan.kind === 'rejected') return plan;
      if (plan.kind === 'replay') {
        return accepted('replayed', prepared.snapshot, plan.record);
      }

      let appended;
      try {
        appended = await dependencies.repository.append(
          input.context,
          plan.record,
        );
      } catch {
        return rejected('unavailable');
      }
      switch (appended.kind) {
        case 'created':
          return accepted('recorded', prepared.snapshot, plan.record);
        case 'conflict':
          return rejected('identifier-conflict');
        case 'rejected':
          return rejected(appended.reason);
        case 'existing': {
          const raced = planTermsConsent({
            ...input,
            snapshot: prepared.snapshot,
            existing: appended.record,
          });
          return raced.kind === 'replay'
            ? accepted('replayed', prepared.snapshot, raced.record)
            : raced.kind === 'rejected'
              ? raced
              : rejected('identifier-conflict');
        }
      }
    },
  };
}

function accepted(
  outcome: 'recorded' | 'replayed',
  current: TermsConsentSnapshot,
  record: TermsConsentRecord,
): TermsConsentApplicationResult {
  const status = acceptedTermsStatus({ current, record });
  return status.kind === 'resolved'
    ? { kind: 'accepted', outcome, status: status.status }
    : rejected(status.reason);
}

function rejected(
  reason: Extract<
    TermsConsentApplicationResult,
    { readonly kind: 'rejected' }
  >['reason'],
): TermsConsentApplicationResult {
  return { kind: 'rejected', reason };
}
