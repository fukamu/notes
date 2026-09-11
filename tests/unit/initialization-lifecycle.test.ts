import { describe, expect, it } from 'vitest';
import {
  INITIAL_NOTES_INITIALIZATION,
  isInitialSyncComplete,
  isNotesInitialized,
  transitionNotesInitialization,
  type InitializationLoadOutcome,
  type NotesInitializationLifecycle,
} from '@/lib/application/initialization-lifecycle';

describe('notes initialization lifecycle', () => {
  it('starts in the only uninitialized state and ignores early sync completion', () => {
    expect(INITIAL_NOTES_INITIALIZATION).toEqual({ stage: 'loading' });
    expect(isNotesInitialized(INITIAL_NOTES_INITIALIZATION)).toBe(false);
    expect(isInitialSyncComplete(INITIAL_NOTES_INITIALIZATION)).toBe(false);

    expect(
      transitionNotesInitialization(INITIAL_NOTES_INITIALIZATION, {
        type: 'initial-sync-completed',
      }),
    ).toBe(INITIAL_NOTES_INITIALIZATION);
  });

  it.each<InitializationLoadOutcome>(['succeeded', 'failed'])(
    'advances a %s load through initial sync without losing its outcome',
    (outcome) => {
      const loading = Object.freeze<NotesInitializationLifecycle>({
        stage: 'loading',
      });
      const loadEvent = Object.freeze({
        type: 'load-completed' as const,
        outcome,
      });

      const awaitingSync = transitionNotesInitialization(loading, loadEvent);

      expect(awaitingSync).toEqual({
        stage: 'awaiting-initial-sync',
        loadOutcome: outcome,
      });
      expect(isNotesInitialized(awaitingSync)).toBe(true);
      expect(isInitialSyncComplete(awaitingSync)).toBe(false);
      expect(loading).toEqual({ stage: 'loading' });
      expect(loadEvent).toEqual({ type: 'load-completed', outcome });

      const ready = transitionNotesInitialization(awaitingSync, {
        type: 'initial-sync-completed',
      });

      expect(ready).toEqual({ stage: 'ready', loadOutcome: outcome });
      expect(isNotesInitialized(ready)).toBe(true);
      expect(isInitialSyncComplete(ready)).toBe(true);
    },
  );

  it('does not regress or overwrite lifecycle state when completion repeats', () => {
    const awaitingSync: NotesInitializationLifecycle = {
      stage: 'awaiting-initial-sync',
      loadOutcome: 'failed',
    };
    expect(
      transitionNotesInitialization(awaitingSync, {
        type: 'load-completed',
        outcome: 'succeeded',
      }),
    ).toBe(awaitingSync);

    const ready = transitionNotesInitialization(awaitingSync, {
      type: 'initial-sync-completed',
    });
    expect(
      transitionNotesInitialization(ready, {
        type: 'initial-sync-completed',
      }),
    ).toBe(ready);
    expect(
      transitionNotesInitialization(ready, {
        type: 'load-completed',
        outcome: 'succeeded',
      }),
    ).toBe(ready);
  });
});
