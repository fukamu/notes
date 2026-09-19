import {
  areNotesLocationsEqual,
  decideNotesHistoryEffect,
  EMPTY_NOTES_LOCATION,
  notesNavigationCause,
  reduceNotesLocation,
  type NotesLocation,
  type NotesNavigationSnapshot,
  type NotesNavigator,
} from '@/lib/application/navigation';
import { createNotesCameraSession } from '@/lib/application/navigation-camera-session';
import { subscribeNotesNavigationPopstate } from '@/lib/client/notes-navigation-popstate';
import {
  notesLocationPathname,
  parseNotesPathname,
} from '@/lib/application/url-navigation';

export type NotesBrowserUrl = {
  pathname: string;
  search: string;
  hash: string;
};

export type NotesBrowserHistoryPort = {
  getUrl: () => NotesBrowserUrl;
  getState: () => unknown;
  push: (pathname: string, state: unknown) => void;
  replace: (pathname: string, state: unknown) => void;
  back: () => void;
  subscribePop: (listener: (state: unknown) => boolean) => () => void;
};

export type NotesNavigationHistoryMetadata = Readonly<{
  version: 1;
  runtimeId: string;
  entryId: number;
}>;

export const NOTES_NAVIGATION_HISTORY_STATE_KEY = '__fukamuNotesNavigationV1';

type KnownEntry = Readonly<{
  entryId: number;
  location: NotesLocation;
  managed: boolean;
}>;

type PendingReturn =
  | Readonly<{
      kind: 'target';
      fromEntryId: number;
      expectedEntryId: number;
      expectedLocation: NotesLocation;
      target: NotesLocation;
    }>
  | Readonly<{
      kind: 'cancelled';
      fromEntryId: number;
      expectedEntryId: number;
    }>;

type BrowserNavigatorOptions = Readonly<{
  createRuntimeId?: () => string;
}>;

function windowHistoryPort(): NotesBrowserHistoryPort {
  return {
    getUrl: () => ({
      pathname: window.location.pathname,
      search: window.location.search,
      hash: window.location.hash,
    }),
    getState: () => window.history.state as unknown,
    push: (pathname, state) => window.history.pushState(state, '', pathname),
    replace: (pathname, state) =>
      window.history.replaceState(state, '', pathname),
    back: () => window.history.go(-1),
    subscribePop: subscribeNotesNavigationPopstate,
  };
}

function serverHistoryPort(): NotesBrowserHistoryPort {
  return {
    getUrl: () => ({ pathname: '/', search: '', hash: '' }),
    getState: () => null,
    push: () => undefined,
    replace: () => undefined,
    back: () => undefined,
    subscribePop: () => () => undefined,
  };
}

function createBrowserRuntimeId(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }
  return `runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function decodeNotesNavigationHistoryMetadata(
  state: unknown,
): NotesNavigationHistoryMetadata | null {
  if (!isRecord(state)) return null;
  const value = state[NOTES_NAVIGATION_HISTORY_STATE_KEY];
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.runtimeId !== 'string' ||
    value.runtimeId.length === 0 ||
    typeof value.entryId !== 'number' ||
    !Number.isSafeInteger(value.entryId) ||
    value.entryId <= 0
  ) {
    return null;
  }
  return {
    version: 1,
    runtimeId: value.runtimeId,
    entryId: value.entryId,
  };
}

function metadataState(metadata: NotesNavigationHistoryMetadata) {
  return { [NOTES_NAVIGATION_HISTORY_STATE_KEY]: metadata };
}

function replaceMetadataState(
  state: unknown,
  metadata: NotesNavigationHistoryMetadata,
): Record<string, unknown> {
  return {
    ...(isRecord(state) ? state : {}),
    [NOTES_NAVIGATION_HISTORY_STATE_KEY]: metadata,
  };
}

function isCanonicalUrl(url: NotesBrowserUrl, pathname: string): boolean {
  return url.pathname === pathname && url.search === '' && url.hash === '';
}

function canWriteMetadata(state: unknown): boolean {
  return state === null || isRecord(state);
}

export function createBrowserNotesNavigator(
  port: NotesBrowserHistoryPort = typeof window === 'undefined'
    ? serverHistoryPort()
    : windowHistoryPort(),
  options: BrowserNavigatorOptions = {},
): NotesNavigator {
  const runtimeId = (options.createRuntimeId ?? createBrowserRuntimeId)();
  const initial = parseNotesPathname(port.getUrl().pathname);
  const initialLocation =
    initial.kind === 'valid' ? initial.location : EMPTY_NOTES_LOCATION;
  const initialState = port.getState();
  const initialMetadata = decodeNotesNavigationHistoryMetadata(initialState);
  const initialEntryId =
    initialMetadata?.runtimeId === runtimeId ? initialMetadata.entryId : 1;
  let nextEntryId = Math.max(2, initialEntryId + 1);
  let knownEntries: KnownEntry[] = [
    {
      entryId: initialEntryId,
      location: initialLocation,
      managed:
        initialMetadata?.runtimeId === runtimeId &&
        initialMetadata.entryId === initialEntryId,
    },
  ];
  let cursor = 0;
  let pendingReturn: PendingReturn | null = null;
  let snapshot: NotesNavigationSnapshot = {
    location: initialLocation,
    entryId: initialEntryId,
    activationId: 1,
    cause: 'initial',
    pending: false,
  };
  const listeners = new Set<() => void>();
  let stopListening: (() => void) | null = null;
  const cameraSession = createNotesCameraSession(() => snapshot);

  const metadata = (entryId: number): NotesNavigationHistoryMetadata => ({
    version: 1,
    runtimeId,
    entryId,
  });

  const emit = () => {
    for (const listener of listeners) listener();
  };

  const replaceCurrent = (
    pathname: string,
    entryId: number,
    state: unknown = port.getState(),
  ): boolean => {
    if (!canWriteMetadata(state)) {
      port.replace(pathname, state);
      return false;
    }
    port.replace(pathname, replaceMetadataState(state, metadata(entryId)));
    return true;
  };

  const canonicalizeUnmanagedCurrent = (
    pathname: string,
    state: unknown = port.getState(),
  ) => {
    if (!isCanonicalUrl(port.getUrl(), pathname)) {
      port.replace(pathname, state);
    }
  };

  const ensureCurrentManaged = () => {
    const canonicalPathname = notesLocationPathname(snapshot.location);
    const current = knownEntries[cursor];
    if (!current) return;
    const state = port.getState();
    if (!canWriteMetadata(state)) {
      canonicalizeUnmanagedCurrent(canonicalPathname);
      knownEntries[cursor] = { ...current, managed: false };
      return;
    }
    const currentMetadata = decodeNotesNavigationHistoryMetadata(state);
    if (
      currentMetadata?.runtimeId !== runtimeId ||
      currentMetadata.entryId !== snapshot.entryId ||
      !isCanonicalUrl(port.getUrl(), canonicalPathname)
    ) {
      const managed = replaceCurrent(canonicalPathname, snapshot.entryId);
      knownEntries[cursor] = { ...current, managed };
    } else if (!current.managed) {
      knownEntries[cursor] = { ...current, managed: true };
    }
  };

  const isCurrentManagedEntry = (entry: KnownEntry): boolean => {
    const currentMetadata = decodeNotesNavigationHistoryMetadata(
      port.getState(),
    );
    return (
      entry.managed &&
      currentMetadata?.runtimeId === runtimeId &&
      currentMetadata.entryId === entry.entryId &&
      isCanonicalUrl(port.getUrl(), notesLocationPathname(entry.location))
    );
  };

  const adoptUnknownPop = (
    location: NotesLocation,
    canonicalPathname: string,
    poppedState: unknown,
  ) => {
    cameraSession.discardEntries(knownEntries.map((entry) => entry.entryId));
    const entryId = nextEntryId;
    nextEntryId += 1;
    const managed = canWriteMetadata(poppedState)
      ? replaceCurrent(canonicalPathname, entryId, poppedState)
      : (canonicalizeUnmanagedCurrent(canonicalPathname, poppedState), false);
    knownEntries = [{ entryId, location, managed }];
    cursor = 0;
    snapshot = {
      location,
      entryId,
      activationId: snapshot.activationId + 1,
      cause: 'traverse',
      pending: false,
    };
    emit();
  };

  const commitReplace = (
    next: NotesLocation,
    cause: NotesNavigationSnapshot['cause'],
    pending: boolean,
  ) => {
    const current = knownEntries[cursor];
    if (!current) return false;
    cameraSession.replaceEntry(current.entryId, snapshot.location, next);
    const managed = replaceCurrent(
      notesLocationPathname(next),
      current.entryId,
    );
    knownEntries[cursor] = {
      entryId: current.entryId,
      location: next,
      managed,
    };
    snapshot = {
      location: next,
      entryId: current.entryId,
      activationId: snapshot.activationId + 1,
      cause,
      pending,
    };
    emit();
    return true;
  };

  const handleActualPop = (
    location: NotesLocation,
    canonicalPathname: string,
    url: NotesBrowserUrl,
    poppedState: unknown,
  ) => {
    const currentMetadata = decodeNotesNavigationHistoryMetadata(poppedState);
    const knownIndex =
      currentMetadata?.runtimeId === runtimeId
        ? knownEntries.findIndex(
            (entry) => entry.entryId === currentMetadata.entryId,
          )
        : -1;
    const known = knownIndex >= 0 ? knownEntries[knownIndex] : undefined;
    if (!known?.managed || !areNotesLocationsEqual(known.location, location)) {
      adoptUnknownPop(location, canonicalPathname, poppedState);
      return;
    }

    cursor = knownIndex;
    snapshot = {
      location: known.location,
      entryId: known.entryId,
      activationId: snapshot.activationId + 1,
      cause: 'traverse',
      pending: false,
    };
    if (!isCanonicalUrl(url, canonicalPathname)) {
      const managed = replaceCurrent(
        canonicalPathname,
        known.entryId,
        poppedState,
      );
      knownEntries[cursor] = { ...known, managed };
    }
    emit();
  };

  const handlePop = (poppedState: unknown): boolean => {
    const url = port.getUrl();
    const parsed = parseNotesPathname(url.pathname);
    const location =
      parsed.kind === 'valid' ? parsed.location : EMPTY_NOTES_LOCATION;
    const canonicalPathname =
      parsed.kind === 'valid' ? parsed.canonicalPathname : '/';
    const currentMetadata = decodeNotesNavigationHistoryMetadata(poppedState);
    const expected = pendingReturn?.kind === 'target' ? pendingReturn : null;
    const expectedIndex = expected
      ? knownEntries.findIndex(
          (entry) => entry.entryId === expected.expectedEntryId,
        )
      : -1;
    const expectedEntry =
      expectedIndex >= 0 ? knownEntries[expectedIndex] : undefined;
    if (
      expected &&
      expectedEntry?.managed &&
      currentMetadata?.runtimeId === runtimeId &&
      currentMetadata.entryId === expected.expectedEntryId &&
      areNotesLocationsEqual(
        expectedEntry.location,
        expected.expectedLocation,
      ) &&
      areNotesLocationsEqual(location, expected.expectedLocation)
    ) {
      pendingReturn = null;
      cursor = expectedIndex;
      cameraSession.replaceEntry(
        expectedEntry.entryId,
        expectedEntry.location,
        expected.target,
      );
      const managed = replaceCurrent(
        notesLocationPathname(expected.target),
        expectedEntry.entryId,
        poppedState,
      );
      knownEntries[cursor] = {
        entryId: expectedEntry.entryId,
        location: expected.target,
        managed,
      };
      snapshot = {
        location: expected.target,
        entryId: expectedEntry.entryId,
        activationId: snapshot.activationId + 1,
        cause: 'tab',
        pending: false,
      };
      emit();
      return true;
    }

    pendingReturn = null;
    handleActualPop(location, canonicalPathname, url, poppedState);
    return false;
  };

  return {
    getLocation: () => snapshot.location,
    getSnapshot: () => snapshot,
    navigate: (intent) => {
      const previous = snapshot.location;
      const next = reduceNotesLocation(previous, intent);
      const canonicalPathname = notesLocationPathname(next);

      if (pendingReturn) {
        if (intent.type !== 'initialize' && intent.type !== 'reconcile-cards') {
          return snapshot.location;
        }
        if (next === previous) return snapshot.location;
        pendingReturn = {
          kind: 'cancelled',
          fromEntryId: pendingReturn.fromEntryId,
          expectedEntryId: pendingReturn.expectedEntryId,
        };
        commitReplace(next, notesNavigationCause(intent), true);
        return snapshot.location;
      }

      const previousEntry = knownEntries[cursor - 1];
      const effect = decideNotesHistoryEffect({
        current: previous,
        next,
        intent,
        previousManagedLocation: previousEntry?.managed
          ? previousEntry.location
          : null,
      });

      if (effect.type === 'noop') {
        const current = knownEntries[cursor];
        if (current?.managed) {
          if (!isCanonicalUrl(port.getUrl(), canonicalPathname)) {
            const managed = replaceCurrent(canonicalPathname, current.entryId);
            knownEntries[cursor] = { ...current, managed };
          }
        } else {
          canonicalizeUnmanagedCurrent(canonicalPathname);
        }
        return snapshot.location;
      }

      if (effect.type === 'replace') {
        commitReplace(next, notesNavigationCause(intent), false);
      } else if (effect.type === 'push') {
        const discarded = knownEntries.slice(cursor + 1);
        cameraSession.discardEntries(discarded.map((entry) => entry.entryId));
        const entryId = nextEntryId;
        nextEntryId += 1;
        knownEntries = [
          ...knownEntries.slice(0, cursor + 1),
          { entryId, location: next, managed: true },
        ];
        cursor = knownEntries.length - 1;
        snapshot = {
          location: next,
          entryId,
          activationId: snapshot.activationId + 1,
          cause: notesNavigationCause(intent),
          pending: false,
        };
        port.push(canonicalPathname, metadataState(metadata(entryId)));
        emit();
      } else {
        const current = knownEntries[cursor];
        if (
          !current ||
          !previousEntry?.managed ||
          !isCurrentManagedEntry(current)
        ) {
          commitReplace(next, notesNavigationCause(intent), false);
          return snapshot.location;
        }
        pendingReturn = {
          kind: 'target',
          fromEntryId: current.entryId,
          expectedEntryId: previousEntry.entryId,
          expectedLocation: previousEntry.location,
          target: next,
        };
        snapshot = { ...snapshot, pending: true };
        emit();
        try {
          port.back();
        } catch {
          const failed = pendingReturn;
          pendingReturn = null;
          if (
            failed?.kind === 'target' &&
            snapshot.entryId === failed.fromEntryId &&
            isCurrentManagedEntry(current)
          ) {
            commitReplace(next, notesNavigationCause(intent), false);
          } else {
            const actualUrl = port.getUrl();
            const parsedActual = parseNotesPathname(actualUrl.pathname);
            handleActualPop(
              parsedActual.kind === 'valid'
                ? parsedActual.location
                : EMPTY_NOTES_LOCATION,
              parsedActual.kind === 'valid'
                ? parsedActual.canonicalPathname
                : '/',
              actualUrl,
              port.getState(),
            );
          }
        }
      }
      return snapshot.location;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      if (!stopListening) {
        stopListening = port.subscribePop(handlePop);
        ensureCurrentManaged();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          stopListening?.();
          stopListening = null;
        }
      };
    },
    cameraSession,
  };
}
