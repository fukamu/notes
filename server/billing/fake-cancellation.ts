import type {
  ProviderSubscriptionCancellationCommand,
  ProviderSubscriptionCancellationObservation,
} from './cancellation-core';
import type { SubscriptionCancellationProviderPort } from './ports';

export type FakeCancellationAction =
  | 'scheduled'
  | 'cancelled'
  | 'already-cancelled'
  | 'retryable-failure'
  | 'terminal-failure'
  | 'malformed'
  | 'out-of-order'
  | 'unavailable'
  | 'scheduled-response-lost'
  | 'cancelled-response-lost';

export type FakeSubscriptionCancellationProvider =
  SubscriptionCancellationProviderPort & {
    readonly commands: () => readonly ProviderSubscriptionCancellationCommand[];
    readonly cancellationSideEffectCount: () => number;
  };

export function createFakeSubscriptionCancellationProvider(input: {
  readonly actions: readonly FakeCancellationAction[];
  readonly scheduledAccessEndsAt?: number;
}): FakeSubscriptionCancellationProvider {
  const actions = [...input.actions];
  const commands: ProviderSubscriptionCancellationCommand[] = [];
  const confirmed = new Map<
    string,
    ProviderSubscriptionCancellationObservation
  >();
  let cancellationSideEffectCount = 0;

  return {
    async cancelSubscription(command) {
      commands.push(command);
      const replay = confirmed.get(command.idempotencyKey);
      if (replay !== undefined) {
        return replay.kind === 'scheduled'
          ? replay
          : { ...replay, kind: 'already-cancelled' };
      }

      const action = actions.shift() ?? 'unavailable';
      switch (action) {
        case 'scheduled': {
          const observation = providerObservation(
            command,
            'scheduled',
            input.scheduledAccessEndsAt,
          );
          confirmed.set(command.idempotencyKey, observation);
          cancellationSideEffectCount += 1;
          return observation;
        }
        case 'cancelled': {
          const observation = providerObservation(command, 'cancelled');
          confirmed.set(command.idempotencyKey, observation);
          cancellationSideEffectCount += 1;
          return observation;
        }
        case 'scheduled-response-lost': {
          confirmed.set(
            command.idempotencyKey,
            providerObservation(
              command,
              'scheduled',
              input.scheduledAccessEndsAt,
            ),
          );
          cancellationSideEffectCount += 1;
          throw new Error('simulated cancellation response loss');
        }
        case 'cancelled-response-lost': {
          confirmed.set(
            command.idempotencyKey,
            providerObservation(command, 'cancelled'),
          );
          cancellationSideEffectCount += 1;
          throw new Error('simulated cancellation response loss');
        }
        case 'already-cancelled':
        case 'retryable-failure':
        case 'terminal-failure':
          return providerObservation(command, action);
        case 'out-of-order':
          return {
            ...providerObservation(command, 'cancelled'),
            observedAt: Math.max(0, command.requestedAt - 1),
          };
        case 'malformed':
          return { kind: 'cancelled' };
        case 'unavailable':
          throw new Error('simulated provider unavailability');
      }
    },
    commands() {
      return [...commands];
    },
    cancellationSideEffectCount() {
      return cancellationSideEffectCount;
    },
  };
}

function providerObservation(
  command: ProviderSubscriptionCancellationCommand,
  kind: ProviderSubscriptionCancellationObservation['kind'],
  scheduledAccessEndsAt?: number,
): ProviderSubscriptionCancellationObservation {
  const base = {
    kind,
    provider: command.provider,
    providerSubscriptionReference: command.providerSubscriptionReference,
    idempotencyKey: command.idempotencyKey,
    observedAt: command.requestedAt,
  } as const;
  switch (kind) {
    case 'scheduled':
      return {
        ...base,
        kind,
        accessEndsAt: scheduledAccessEndsAt ?? command.requestedAt + 1,
      };
    case 'cancelled':
    case 'already-cancelled':
      return { ...base, kind, accessEndsAt: command.requestedAt };
    case 'retryable-failure':
    case 'terminal-failure':
      return { ...base, kind };
  }
}
