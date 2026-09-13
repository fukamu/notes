import {
  collectLogoutPeerAcknowledgement,
  createLogoutPeerAcknowledgements,
  createLogoutPeerRuntimeState,
  createLogoutPurgeCompleted,
  createLogoutPurgeRequest,
  logoutCoordinationChannelName,
  logoutOwnerLockName,
  logoutRuntimeLockName,
  transitionLogoutPeerRuntime,
  type LogoutCoordinationFailureReason,
  type LogoutCoordinationMessage,
  type LogoutPeerAcknowledgements,
  type TabInstanceId,
} from '@/lib/application/logout-coordination';
import {
  decideNotesRuntimePurgeGate,
  type LogoutPurgeGeneration,
  type NotesRuntimePurgeGateDecision,
} from '@/lib/application/logout-purge';
import {
  readLogoutPurgeProgress,
  type LogoutPurgeProgressPort,
} from '@/lib/application/logout-purge-progress';

export type LogoutCoordinationChannelPort = {
  post: (message: LogoutCoordinationMessage) => 'sent' | 'failed';
  subscribe: (listener: (input: unknown) => void) => () => void;
  close: () => void;
};

export type LogoutCoordinationLockLease = {
  /** Resolves only after the underlying browser lock has been released. */
  release: () => Promise<void>;
};

export type LogoutCoordinationLockRequest = {
  readonly name: string;
  readonly mode: 'shared' | 'exclusive';
  readonly ifAvailable: boolean;
  readonly timeoutMs: number;
};

export type LogoutCoordinationLockResult =
  | {
      readonly kind: 'acquired';
      readonly lease: LogoutCoordinationLockLease;
    }
  | {
      readonly kind: 'failed';
      readonly reason: LogoutCoordinationFailureReason;
    };

export type LogoutCoordinationChannelResult =
  | {
      readonly kind: 'opened';
      readonly channel: LogoutCoordinationChannelPort;
    }
  | {
      readonly kind: 'failed';
      readonly reason: 'adapter-failure' | 'unsupported-capability';
    };

export type LogoutCoordinationPlatformPort = {
  openChannel: (name: string) => LogoutCoordinationChannelResult;
  acquireLock: (
    request: LogoutCoordinationLockRequest,
  ) => Promise<LogoutCoordinationLockResult>;
};

export type LogoutRuntimeFenceLease = {
  /** Stops the runtime lock and acknowledges while retaining crash-retry messaging. */
  quiesce: () => Promise<void>;
  /** Quiesces if needed, then removes the channel subscription. */
  close: () => Promise<void>;
};

export type LogoutRuntimeFenceEnterResult =
  | { readonly kind: 'entered'; readonly lease: LogoutRuntimeFenceLease }
  | {
      readonly kind: 'blocked';
      readonly reason:
        | Extract<NotesRuntimePurgeGateDecision, { kind: 'blocked' }>['reason']
        | LogoutCoordinationFailureReason
        | 'purge-requested';
    };

export type LogoutRuntimeFencePort = {
  enter: (input: {
    readonly generation: LogoutPurgeGeneration;
    readonly onPurgeRequested: () => void;
  }) => Promise<LogoutRuntimeFenceEnterResult>;
};

export type LogoutPeerQuiescenceLease = {
  acknowledgedPeerIds: () => readonly TabInstanceId[];
  release: () => Promise<void>;
};

export type QuiesceLogoutPeersResult =
  | {
      readonly kind: 'quiesced';
      readonly lease: LogoutPeerQuiescenceLease;
    }
  | {
      readonly kind: 'failed';
      readonly reason:
        | LogoutCoordinationFailureReason
        | 'already-coordinating'
        | 'invalid-attempt';
    };

export type LogoutPurgeOwnerLease = {
  quiescePeers: (attempt: number) => Promise<QuiesceLogoutPeersResult>;
  announceCompleted: (attempt: number) => 'sent' | 'failed';
  release: () => Promise<void>;
};

export type AcquireLogoutPurgeOwnerResult =
  | { readonly kind: 'acquired'; readonly lease: LogoutPurgeOwnerLease }
  | {
      readonly kind: 'failed';
      readonly reason: LogoutCoordinationFailureReason;
    };

export type LogoutPurgeCoordinationPort = {
  acquireOwner: (
    generation: LogoutPurgeGeneration,
  ) => Promise<AcquireLogoutPurgeOwnerResult>;
};

export function createLogoutRuntimeFence(input: {
  readonly progressPort: LogoutPurgeProgressPort;
  readonly platform: LogoutCoordinationPlatformPort;
  readonly tabId: TabInstanceId;
  readonly lockTimeoutMs: number;
}): LogoutRuntimeFencePort {
  return {
    async enter({ generation, onPurgeRequested }) {
      const firstGate = await inspectRuntimeGate(input.progressPort);
      if (firstGate.kind === 'blocked') return firstGate;

      const opened = input.platform.openChannel(
        logoutCoordinationChannelName(generation),
      );
      if (opened.kind === 'failed') {
        return { kind: 'blocked', reason: opened.reason };
      }
      const channel = opened.channel;

      let peerState = createLogoutPeerRuntimeState(generation, input.tabId);
      let quiesced = false;
      let closed = false;
      const unsubscribe = channel.subscribe((message) => {
        const transition = transitionLogoutPeerRuntime(peerState, {
          type: 'message-received',
          input: message,
        });
        peerState = transition.state;
        if (
          transition.kind === 'accepted' &&
          transition.action.kind === 'stop-runtime'
        ) {
          onPurgeRequested();
        }
        if (
          transition.kind === 'accepted' &&
          transition.action.kind === 'send-message'
        ) {
          channel.post(transition.action.message);
        }
        if (
          transition.kind === 'accepted' &&
          transition.action.kind === 'purge-completed'
        ) {
          closeChannel();
        }
      });

      function closeChannel(): void {
        if (closed) return;
        closed = true;
        unsubscribe();
        channel.close();
      }

      const acquired = await input.platform.acquireLock({
        name: logoutRuntimeLockName(generation),
        mode: 'shared',
        ifAvailable: false,
        timeoutMs: input.lockTimeoutMs,
      });
      if (acquired.kind === 'failed') {
        closeChannel();
        return { kind: 'blocked', reason: acquired.reason };
      }

      const quiesce = async (): Promise<void> => {
        if (quiesced) return;
        quiesced = true;
        await acquired.lease.release();
        const transition = transitionLogoutPeerRuntime(peerState, {
          type: 'runtime-released',
        });
        peerState = transition.state;
        if (
          transition.kind === 'accepted' &&
          transition.action.kind === 'send-message'
        ) {
          channel.post(transition.action.message);
        }
      };
      const close = async (): Promise<void> => {
        if (closed) return;
        await quiesce();
        closeChannel();
      };

      // Closes the read/acquire race: a purge marker created while the shared
      // runtime lock was being acquired blocks the runtime before construction.
      const secondGate = await inspectRuntimeGate(input.progressPort);
      if (secondGate.kind === 'blocked') {
        await close();
        return secondGate;
      }
      if (peerState.kind !== 'active') {
        await close();
        return { kind: 'blocked', reason: 'purge-requested' };
      }
      return { kind: 'entered', lease: { quiesce, close } };
    },
  };
}

export function createLogoutPurgeCoordination(input: {
  readonly platform: LogoutCoordinationPlatformPort;
  readonly tabId: TabInstanceId;
  readonly lockTimeoutMs: number;
}): LogoutPurgeCoordinationPort {
  return {
    async acquireOwner(generation) {
      const opened = input.platform.openChannel(
        logoutCoordinationChannelName(generation),
      );
      if (opened.kind === 'failed') return opened;
      const acquired = await input.platform.acquireLock({
        name: logoutOwnerLockName(generation),
        mode: 'exclusive',
        ifAvailable: true,
        timeoutMs: input.lockTimeoutMs,
      });
      if (acquired.kind === 'failed') {
        opened.channel.close();
        return acquired;
      }
      return {
        kind: 'acquired',
        lease: createOwnerLease({
          generation,
          ownerTabId: input.tabId,
          ownerLock: acquired.lease,
          channel: opened.channel,
          platform: input.platform,
          lockTimeoutMs: input.lockTimeoutMs,
        }),
      };
    },
  };
}

async function inspectRuntimeGate(
  progressPort: LogoutPurgeProgressPort,
): Promise<LogoutRuntimeFenceEnterResult | { readonly kind: 'allowed' }> {
  const decision = decideNotesRuntimePurgeGate(
    await readLogoutPurgeProgress(progressPort),
  );
  return decision.kind === 'allowed'
    ? decision
    : { kind: 'blocked', reason: decision.reason };
}

function createOwnerLease(input: {
  readonly generation: LogoutPurgeGeneration;
  readonly ownerTabId: TabInstanceId;
  readonly ownerLock: LogoutCoordinationLockLease;
  readonly channel: LogoutCoordinationChannelPort;
  readonly platform: LogoutCoordinationPlatformPort;
  readonly lockTimeoutMs: number;
}): LogoutPurgeOwnerLease {
  let acknowledgements: LogoutPeerAcknowledgements | undefined;
  let peerLock: LogoutCoordinationLockLease | undefined;
  let released = false;
  const unsubscribe = input.channel.subscribe((message) => {
    if (acknowledgements === undefined) return;
    const decision = collectLogoutPeerAcknowledgement(
      acknowledgements,
      message,
    );
    acknowledgements = decision.acknowledgements;
  });

  return {
    async quiescePeers(attempt) {
      if (!Number.isSafeInteger(attempt) || attempt < 1) {
        return { kind: 'failed', reason: 'invalid-attempt' };
      }
      if (acknowledgements !== undefined || peerLock !== undefined) {
        return { kind: 'failed', reason: 'already-coordinating' };
      }
      acknowledgements = createLogoutPeerAcknowledgements(
        input.generation,
        attempt,
        input.ownerTabId,
      );
      if (
        input.channel.post(
          createLogoutPurgeRequest(input.generation, attempt, input.ownerTabId),
        ) === 'failed'
      ) {
        acknowledgements = undefined;
        return { kind: 'failed', reason: 'adapter-failure' };
      }
      const acquired = await input.platform.acquireLock({
        name: logoutRuntimeLockName(input.generation),
        mode: 'exclusive',
        ifAvailable: false,
        timeoutMs: input.lockTimeoutMs,
      });
      if (acquired.kind === 'failed') {
        acknowledgements = undefined;
        return acquired;
      }
      peerLock = acquired.lease;
      let quiescenceReleased = false;
      return {
        kind: 'quiesced',
        lease: {
          acknowledgedPeerIds: () => acknowledgements?.peerTabIds ?? [],
          release: async () => {
            if (quiescenceReleased) return;
            quiescenceReleased = true;
            const lock = peerLock;
            peerLock = undefined;
            await lock?.release();
          },
        },
      };
    },
    announceCompleted(attempt) {
      if (!Number.isSafeInteger(attempt) || attempt < 1) return 'failed';
      return input.channel.post(
        createLogoutPurgeCompleted(input.generation, attempt, input.ownerTabId),
      );
    },
    async release() {
      if (released) return;
      released = true;
      unsubscribe();
      await peerLock?.release();
      peerLock = undefined;
      await input.ownerLock.release();
      input.channel.close();
    },
  };
}
