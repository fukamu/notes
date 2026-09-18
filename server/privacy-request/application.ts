import {
  planPrivacyRequestCompletion,
  planPrivacyRequestFailure,
  planPrivacyRequestProcessingStart,
  planPrivacyRequestStart,
  planPrivacyRequestVerification,
} from './core';
import {
  privacyRequestPublicStatus,
  type PrivacyRequestPublicStatus,
  type PrivacyRequestSubmitCommand,
} from './application-core';
import {
  parsePrivacyRequestFailureCode,
  privacyRequestScope,
  type PrivacyRequestFailureCode,
  type PrivacyRequestId,
  type PrivacyRequestRecord,
  type PrivacyRequestRepository,
  type PrivacyRequestScope,
  type PrivacyRequestVerificationReceiptId,
} from './public';

export type PrivacyRequestVerificationPortResult =
  | {
      readonly kind: 'approved';
      readonly receiptId: PrivacyRequestVerificationReceiptId;
    }
  | {
      readonly kind: 'rejected';
      readonly reason: 'identity-not-verified' | 'request-not-applicable';
    }
  | { readonly kind: 'unavailable' };

export type PrivacyRequestVerificationPort = {
  verify(input: {
    readonly scope: PrivacyRequestScope;
    readonly requestId: PrivacyRequestId;
    readonly requestKind: PrivacyRequestRecord['requestKind'];
    readonly checkedAt: number;
  }): Promise<PrivacyRequestVerificationPortResult>;
};

export type PrivacyRequestExecutionResult =
  | { readonly kind: 'fulfilled' }
  | {
      readonly kind: 'failed';
      readonly failureCode: PrivacyRequestFailureCode;
      readonly retryable: boolean;
    };

export type PrivacyRequestExecutionPort = {
  execute(input: {
    readonly scope: PrivacyRequestScope;
    readonly requestId: PrivacyRequestId;
    readonly requestKind: Exclude<
      PrivacyRequestRecord['requestKind'],
      'deletion'
    >;
  }): Promise<PrivacyRequestExecutionResult>;
};

export type PrivacyRequestDeletionHandoffResult =
  | { readonly kind: 'started' }
  | {
      readonly kind: 'failed';
      readonly failureCode: PrivacyRequestFailureCode;
      readonly retryable: boolean;
    };

export type PrivacyRequestDeletionHandoffPort = {
  startExistingAccountDeletionSaga(input: {
    readonly scope: PrivacyRequestScope;
    readonly privacyRequestId: PrivacyRequestId;
  }): Promise<PrivacyRequestDeletionHandoffResult>;
};

export type PrivacyRequestApplicationResult =
  | {
      readonly kind: 'accepted';
      readonly outcome: 'recorded' | 'replayed' | 'status' | 'updated';
      readonly request: PrivacyRequestPublicStatus;
    }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'identifier-conflict'
        | 'invalid-input'
        | 'invalid-state'
        | 'not-found'
        | 'unavailable';
    };

export type PrivacyRequestApplication = {
  submit(input: {
    readonly scope: PrivacyRequestScope;
    readonly command: PrivacyRequestSubmitCommand;
    readonly requestId: PrivacyRequestId;
    readonly requestedAt: number;
  }): Promise<PrivacyRequestApplicationResult>;
  status(input: {
    readonly scope: PrivacyRequestScope;
    readonly requestId: PrivacyRequestId;
  }): Promise<PrivacyRequestApplicationResult>;
  verify(input: {
    readonly scope: PrivacyRequestScope;
    readonly requestId: PrivacyRequestId;
    readonly checkedAt: number;
  }): Promise<PrivacyRequestApplicationResult>;
  process(input: {
    readonly scope: PrivacyRequestScope;
    readonly requestId: PrivacyRequestId;
    readonly startedAt: number;
    readonly finishedAt: number;
  }): Promise<PrivacyRequestApplicationResult>;
};

export type PrivacyRequestApplicationDependencies = {
  readonly repository: PrivacyRequestRepository;
  readonly verification: PrivacyRequestVerificationPort;
  readonly execution: PrivacyRequestExecutionPort;
  readonly accountDeletion: PrivacyRequestDeletionHandoffPort;
};

const executorUnavailable = parsePrivacyRequestFailureCode(
  'executor-unavailable',
);

export function createPrivacyRequestApplication(
  dependencies: PrivacyRequestApplicationDependencies,
): PrivacyRequestApplication {
  return {
    async submit(input) {
      try {
        const scope = privacyRequestScope(input.scope);
        const plan = planPrivacyRequestStart({
          scope,
          requestId: input.requestId,
          submissionId: input.command.submissionId,
          requestKind: input.command.requestKind,
          requestedAt: input.requestedAt,
        });
        if (plan.kind === 'rejected') return rejected('invalid-input');
        const created = await dependencies.repository.create(plan.record);
        switch (created.kind) {
          case 'created':
            return accepted('recorded', created.record);
          case 'existing':
            return accepted('replayed', created.record);
          case 'conflict':
            return rejected('identifier-conflict');
          case 'rejected':
            return rejected('invalid-input');
        }
      } catch {
        return rejected('unavailable');
      }
    },

    async status(input) {
      try {
        const scope = privacyRequestScope(input.scope);
        const record = await dependencies.repository.findById(
          scope,
          input.requestId,
        );
        return record === undefined
          ? rejected('not-found')
          : accepted('status', record);
      } catch {
        return rejected('unavailable');
      }
    },

    async verify(input) {
      try {
        const scope = privacyRequestScope(input.scope);
        const record = await dependencies.repository.findById(
          scope,
          input.requestId,
        );
        if (record === undefined) return rejected('not-found');
        if (record.state.kind !== 'verification-pending') {
          return accepted('status', record);
        }
        const verification = await dependencies.verification.verify({
          scope,
          requestId: record.requestId,
          requestKind: record.requestKind,
          checkedAt: input.checkedAt,
        });
        if (verification.kind === 'unavailable') {
          return rejected('unavailable');
        }
        const plan = planPrivacyRequestVerification({
          record,
          decision:
            verification.kind === 'approved'
              ? {
                  kind: 'approved',
                  receiptId: verification.receiptId,
                  decidedAt: input.checkedAt,
                }
              : {
                  kind: 'rejected',
                  reason: verification.reason,
                  decidedAt: input.checkedAt,
                },
        });
        return plan.kind === 'accepted'
          ? commitUpdate(dependencies.repository, scope, plan.transition)
          : rejected('invalid-state');
      } catch {
        return rejected('unavailable');
      }
    },

    async process(input) {
      try {
        const scope = privacyRequestScope(input.scope);
        const record = await dependencies.repository.findById(
          scope,
          input.requestId,
        );
        if (record === undefined) return rejected('not-found');
        if (record.state.kind !== 'ready') return accepted('status', record);

        const claim = planPrivacyRequestProcessingStart({
          record,
          startedAt: input.startedAt,
        });
        if (claim.kind === 'rejected') return rejected('invalid-state');
        const claimed = await dependencies.repository.commit(
          scope,
          claim.transition,
        );
        if (claimed.kind === 'rejected') return rejected('invalid-state');
        if (claimed.kind === 'conflict') {
          return claimed.current === undefined
            ? rejected('not-found')
            : accepted('status', claimed.current);
        }
        if (claimed.kind === 'replayed') {
          return accepted('status', claimed.record);
        }

        const execution = await executeRequest(
          dependencies,
          scope,
          claimed.record,
        );
        const completion =
          execution.kind === 'completed'
            ? planPrivacyRequestCompletion({
                record: claimed.record,
                completedAt: input.finishedAt,
                outcome: execution.outcome,
              })
            : planPrivacyRequestFailure({
                record: claimed.record,
                failedAt: input.finishedAt,
                failureCode: execution.failureCode,
                retryable: execution.retryable,
              });
        return completion.kind === 'accepted'
          ? commitUpdate(dependencies.repository, scope, completion.transition)
          : rejected('invalid-state');
      } catch {
        return rejected('unavailable');
      }
    },
  };
}

type RequestExecution =
  | {
      readonly kind: 'completed';
      readonly outcome: 'fulfilled' | 'account-deletion-started';
    }
  | {
      readonly kind: 'failed';
      readonly failureCode: PrivacyRequestFailureCode;
      readonly retryable: boolean;
    };

async function executeRequest(
  dependencies: PrivacyRequestApplicationDependencies,
  scope: PrivacyRequestScope,
  record: PrivacyRequestRecord,
): Promise<RequestExecution> {
  try {
    if (record.requestKind === 'deletion') {
      const result =
        await dependencies.accountDeletion.startExistingAccountDeletionSaga({
          scope,
          privacyRequestId: record.requestId,
        });
      return result.kind === 'started'
        ? { kind: 'completed', outcome: 'account-deletion-started' }
        : result;
    }
    const result = await dependencies.execution.execute({
      scope,
      requestId: record.requestId,
      requestKind: record.requestKind,
    });
    return result.kind === 'fulfilled'
      ? { kind: 'completed', outcome: 'fulfilled' }
      : result;
  } catch {
    return {
      kind: 'failed',
      failureCode: executorUnavailable,
      retryable: true,
    };
  }
}

async function commitUpdate(
  repository: PrivacyRequestRepository,
  scope: PrivacyRequestScope,
  transition: Parameters<PrivacyRequestRepository['commit']>[1],
): Promise<PrivacyRequestApplicationResult> {
  const committed = await repository.commit(scope, transition);
  switch (committed.kind) {
    case 'applied':
    case 'replayed':
      return accepted('updated', committed.record);
    case 'conflict':
      return committed.current === undefined
        ? rejected('not-found')
        : accepted('status', committed.current);
    case 'rejected':
      return rejected('invalid-state');
  }
}

function accepted(
  outcome: Extract<
    PrivacyRequestApplicationResult,
    { kind: 'accepted' }
  >['outcome'],
  record: PrivacyRequestRecord,
): PrivacyRequestApplicationResult {
  return {
    kind: 'accepted',
    outcome,
    request: privacyRequestPublicStatus(record),
  };
}

function rejected(
  reason: Extract<
    PrivacyRequestApplicationResult,
    { kind: 'rejected' }
  >['reason'],
): PrivacyRequestApplicationResult {
  return { kind: 'rejected', reason };
}
