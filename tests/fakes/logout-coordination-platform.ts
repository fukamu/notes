import type {
  LogoutCoordinationChannelPort,
  LogoutCoordinationLockLease,
  LogoutCoordinationLockRequest,
  LogoutCoordinationLockResult,
  LogoutCoordinationPlatformPort,
} from '@/lib/application/logout-runtime-coordination';

type ChannelRecord = {
  readonly name: string;
  readonly listeners: Set<(input: unknown) => void>;
  closed: boolean;
};

type LockHolder = {
  readonly key: object;
  readonly mode: LogoutCoordinationLockRequest['mode'];
};

type PendingLock = {
  readonly request: LogoutCoordinationLockRequest;
  readonly resolve: (result: LogoutCoordinationLockResult) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

export class InMemoryLogoutCoordinationPlatform implements LogoutCoordinationPlatformPort {
  private readonly channels = new Set<ChannelRecord>();
  private readonly holders = new Map<string, LockHolder[]>();
  private readonly pending = new Map<string, PendingLock[]>();
  private channelSupported = true;
  private lockSupported = true;
  private failChannelOpenOnce = false;
  private failPostOnce = false;
  private failLockOnce = false;

  setChannelSupported(supported: boolean): void {
    this.channelSupported = supported;
  }

  setLockSupported(supported: boolean): void {
    this.lockSupported = supported;
  }

  failNextChannelOpen(): void {
    this.failChannelOpenOnce = true;
  }

  failNextPost(): void {
    this.failPostOnce = true;
  }

  failNextLock(): void {
    this.failLockOnce = true;
  }

  openChannel(name: string) {
    if (!this.channelSupported) {
      return { kind: 'failed', reason: 'unsupported-capability' } as const;
    }
    if (this.failChannelOpenOnce) {
      this.failChannelOpenOnce = false;
      return { kind: 'failed', reason: 'adapter-failure' } as const;
    }
    const record: ChannelRecord = {
      name,
      listeners: new Set(),
      closed: false,
    };
    this.channels.add(record);
    const channel: LogoutCoordinationChannelPort = {
      post: (message) => {
        if (record.closed || this.failPostOnce) {
          this.failPostOnce = false;
          return 'failed';
        }
        const recipients = [...this.channels].filter(
          (candidate) =>
            candidate !== record &&
            !candidate.closed &&
            candidate.name === record.name,
        );
        queueMicrotask(() => {
          for (const recipient of recipients) {
            for (const listener of recipient.listeners) listener(message);
          }
        });
        return 'sent';
      },
      subscribe: (listener) => {
        record.listeners.add(listener);
        return () => record.listeners.delete(listener);
      },
      close: () => {
        record.closed = true;
        record.listeners.clear();
        this.channels.delete(record);
      },
    };
    return { kind: 'opened', channel } as const;
  }

  acquireLock(
    request: LogoutCoordinationLockRequest,
  ): Promise<LogoutCoordinationLockResult> {
    if (!this.lockSupported) {
      return Promise.resolve({
        kind: 'failed',
        reason: 'unsupported-capability',
      });
    }
    if (this.failLockOnce) {
      this.failLockOnce = false;
      return Promise.resolve({ kind: 'failed', reason: 'adapter-failure' });
    }
    if (this.canGrant(request.name, request.mode)) {
      return Promise.resolve(this.grant(request));
    }
    if (request.ifAvailable) {
      return Promise.resolve({ kind: 'failed', reason: 'contended' });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.removePending(request.name, resolve);
        resolve({ kind: 'failed', reason: 'timeout' });
      }, request.timeoutMs);
      const queue = this.pending.get(request.name) ?? [];
      queue.push({ request, resolve, timer });
      this.pending.set(request.name, queue);
    });
  }

  private canGrant(
    name: string,
    mode: LogoutCoordinationLockRequest['mode'],
  ): boolean {
    const holders = this.holders.get(name) ?? [];
    if (mode === 'exclusive') return holders.length === 0;
    return holders.every((holder) => holder.mode === 'shared');
  }

  private grant(
    request: LogoutCoordinationLockRequest,
  ): LogoutCoordinationLockResult {
    const key = {};
    const holders = this.holders.get(request.name) ?? [];
    holders.push({ key, mode: request.mode });
    this.holders.set(request.name, holders);
    let released = false;
    const lease: LogoutCoordinationLockLease = {
      release: async () => {
        if (released) return;
        released = true;
        const remaining = (this.holders.get(request.name) ?? []).filter(
          (holder) => holder.key !== key,
        );
        if (remaining.length === 0) this.holders.delete(request.name);
        else this.holders.set(request.name, remaining);
        this.processPending(request.name);
      },
    };
    return { kind: 'acquired', lease };
  }

  private processPending(name: string): void {
    const queue = this.pending.get(name) ?? [];
    while (queue.length > 0) {
      const next = queue[0];
      if (!next || !this.canGrant(name, next.request.mode)) break;
      queue.shift();
      clearTimeout(next.timer);
      next.resolve(this.grant(next.request));
      if (next.request.mode === 'exclusive') break;
    }
    if (queue.length === 0) this.pending.delete(name);
    else this.pending.set(name, queue);
  }

  private removePending(name: string, resolve: PendingLock['resolve']): void {
    const queue = (this.pending.get(name) ?? []).filter(
      (pending) => pending.resolve !== resolve,
    );
    if (queue.length === 0) this.pending.delete(name);
    else this.pending.set(name, queue);
  }
}
