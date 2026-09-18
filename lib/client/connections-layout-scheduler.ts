import type { ConnectionsLayout } from '@/lib/graph/elk-layout';

export class ConnectionsLayoutSupersededError extends Error {
  constructor() {
    super('Connections layout request was superseded before it started');
    this.name = 'ConnectionsLayoutSupersededError';
  }
}

type ScheduledJob = {
  readonly key: string;
  readonly operation: () => Promise<ConnectionsLayout>;
  readonly promise: Promise<ConnectionsLayout>;
  readonly resolve: (layout: ConnectionsLayout) => void;
  readonly reject: (error: unknown) => void;
  settled: boolean;
};

export type ConnectionsLayoutScheduler = Readonly<{
  desire: (key: string) => void;
  schedule: (
    key: string,
    operation: () => Promise<ConnectionsLayout>,
  ) => Promise<ConnectionsLayout>;
  reset: (reason: Error) => number;
  isDesired: (key: string) => boolean;
}>;

function scheduledJob(
  key: string,
  operation: () => Promise<ConnectionsLayout>,
): ScheduledJob {
  let resolvePromise: (layout: ConnectionsLayout) => void = () => undefined;
  let rejectPromise: (error: unknown) => void = () => undefined;
  const promise = new Promise<ConnectionsLayout>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    key,
    operation,
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
    settled: false,
  };
}

export function createConnectionsLayoutScheduler(): ConnectionsLayoutScheduler {
  let desiredKey: string | null = null;
  let active: ScheduledJob | null = null;
  let queued: ScheduledJob | null = null;
  let resetReason: Error | null = null;

  const settle = (
    job: ScheduledJob,
    outcome:
      | Readonly<{ kind: 'resolved'; layout: ConnectionsLayout }>
      | Readonly<{ kind: 'rejected'; error: unknown }>,
  ) => {
    if (job.settled) return;
    job.settled = true;
    if (outcome.kind === 'resolved') job.resolve(outcome.layout);
    else job.reject(outcome.error);
  };

  const rejectQueued = (reason: Error) => {
    const pending = queued;
    queued = null;
    if (pending) settle(pending, { kind: 'rejected', error: reason });
  };

  const start = (job: ScheduledJob) => {
    if (resetReason) {
      settle(job, { kind: 'rejected', error: resetReason });
      return;
    }
    if (desiredKey !== job.key) {
      settle(job, {
        kind: 'rejected',
        error: new ConnectionsLayoutSupersededError(),
      });
      return;
    }
    active = job;
    void Promise.resolve()
      .then(job.operation)
      .then(
        (layout) => settle(job, { kind: 'resolved', layout }),
        (error: unknown) => settle(job, { kind: 'rejected', error }),
      )
      .finally(() => {
        if (active !== job) return;
        active = null;
        const next = queued;
        queued = null;
        if (next) start(next);
      });
  };

  return {
    desire: (key) => {
      if (resetReason) return;
      desiredKey = key;
      if (queued && queued.key !== key) {
        rejectQueued(new ConnectionsLayoutSupersededError());
      }
    },
    schedule: (key, operation) => {
      if (resetReason) return Promise.reject(resetReason);
      if (desiredKey !== key) {
        return Promise.reject(new ConnectionsLayoutSupersededError());
      }
      if (active?.key === key) return active.promise;
      if (queued?.key === key) return queued.promise;
      const job = scheduledJob(key, operation);
      if (active) {
        rejectQueued(new ConnectionsLayoutSupersededError());
        queued = job;
      } else {
        start(job);
      }
      return job.promise;
    },
    reset: (reason) => {
      if (resetReason) return 0;
      resetReason = reason;
      desiredKey = null;
      let rejected = 0;
      if (queued) {
        rejected += 1;
        rejectQueued(reason);
      }
      if (active && !active.settled) {
        rejected += 1;
        settle(active, { kind: 'rejected', error: reason });
      }
      active = null;
      return rejected;
    },
    isDesired: (key) => resetReason === null && desiredKey === key,
  };
}
