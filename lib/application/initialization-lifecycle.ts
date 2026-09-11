import { assertNever } from '@/lib/shared/invariant';

export type InitializationLoadOutcome = 'succeeded' | 'failed';

export type NotesInitializationLifecycle =
  | { readonly stage: 'loading' }
  | {
      readonly stage: 'awaiting-initial-sync';
      readonly loadOutcome: InitializationLoadOutcome;
    }
  | {
      readonly stage: 'ready';
      readonly loadOutcome: InitializationLoadOutcome;
    };

export type NotesInitializationEvent =
  | {
      readonly type: 'load-completed';
      readonly outcome: InitializationLoadOutcome;
    }
  | { readonly type: 'initial-sync-completed' };

export const INITIAL_NOTES_INITIALIZATION: NotesInitializationLifecycle = {
  stage: 'loading',
};

/**
 * Advances initialization without observing storage, network, or time. Events
 * that arrive too early or after their transition was already applied are
 * ignored, so asynchronous completion cannot construct an invalid state.
 */
export function transitionNotesInitialization(
  lifecycle: NotesInitializationLifecycle,
  event: NotesInitializationEvent,
): NotesInitializationLifecycle {
  switch (event.type) {
    case 'load-completed': {
      switch (lifecycle.stage) {
        case 'loading':
          return {
            stage: 'awaiting-initial-sync',
            loadOutcome: event.outcome,
          };
        case 'awaiting-initial-sync':
        case 'ready':
          return lifecycle;
        default:
          return assertNever(lifecycle, 'Unsupported initialization stage');
      }
    }
    case 'initial-sync-completed': {
      switch (lifecycle.stage) {
        case 'loading':
        case 'ready':
          return lifecycle;
        case 'awaiting-initial-sync':
          return { stage: 'ready', loadOutcome: lifecycle.loadOutcome };
        default:
          return assertNever(lifecycle, 'Unsupported initialization stage');
      }
    }
    default:
      return assertNever(event, 'Unsupported initialization event');
  }
}

export function isNotesInitialized(
  lifecycle: NotesInitializationLifecycle,
): boolean {
  switch (lifecycle.stage) {
    case 'loading':
      return false;
    case 'awaiting-initial-sync':
    case 'ready':
      return true;
    default:
      return assertNever(lifecycle, 'Unsupported initialization stage');
  }
}

export function isInitialSyncComplete(
  lifecycle: NotesInitializationLifecycle,
): boolean {
  switch (lifecycle.stage) {
    case 'loading':
    case 'awaiting-initial-sync':
      return false;
    case 'ready':
      return true;
    default:
      return assertNever(lifecycle, 'Unsupported initialization stage');
  }
}
