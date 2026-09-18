import {
  areNotesLocationsEqual,
  EMPTY_NOTES_LOCATION,
  notesNavigationCause,
  reduceNotesLocation,
  type NotesLocation,
  type NotesNavigationIntent,
  type NotesNavigationSnapshot,
  type NotesNavigator,
} from '@/lib/application/navigation';
import { createNotesCameraSession } from '@/lib/application/navigation-camera-session';
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
  subscribePop: (listener: () => void) => () => void;
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
    back: () => window.history.back(),
    subscribePop: (listener) => {
      window.addEventListener('popstate', listener);
      return () => window.removeEventListener('popstate', listener);
    },
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

function replaceIntent(intent: NotesNavigationIntent): boolean {
  return intent.type === 'initialize' || intent.type === 'reconcile-cards';
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
  const initialMetadata = decodeNotesNavigationHistoryMetadata(port.getState());
  const initialEntryId =
    initialMetadata?.runtimeId === runtimeId ? initialMetadata.entryId : 1;
  let nextEntryId = Math.max(2, initialEntryId + 1);
  let knownEntries: KnownEntry[] = [
    { entryId: initialEntryId, location: initialLocation },
  ];
  let cursor = 0;
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

  const replaceCurrent = (pathname: string, entryId: number) => {
    port.replace(
      pathname,
      replaceMetadataState(port.getState(), metadata(entryId)),
    );
  };

  const ensureCurrentManaged = () => {
    const canonicalPathname = notesLocationPathname(snapshot.location);
    const currentMetadata = decodeNotesNavigationHistoryMetadata(
      port.getState(),
    );
    if (
      currentMetadata?.runtimeId !== runtimeId ||
      currentMetadata.entryId !== snapshot.entryId ||
      !isCanonicalUrl(port.getUrl(), canonicalPathname)
    ) {
      replaceCurrent(canonicalPathname, snapshot.entryId);
    }
  };

  const adoptUnknownPop = (
    location: NotesLocation,
    canonicalPathname: string,
  ) => {
    cameraSession.discardEntries(knownEntries.map((entry) => entry.entryId));
    const entryId = nextEntryId;
    nextEntryId += 1;
    knownEntries = [{ entryId, location }];
    cursor = 0;
    snapshot = {
      location,
      entryId,
      activationId: snapshot.activationId + 1,
      cause: 'traverse',
      pending: false,
    };
    replaceCurrent(canonicalPathname, entryId);
    emit();
  };

  const handlePop = () => {
    const url = port.getUrl();
    const parsed = parseNotesPathname(url.pathname);
    const location =
      parsed.kind === 'valid' ? parsed.location : EMPTY_NOTES_LOCATION;
    const canonicalPathname =
      parsed.kind === 'valid' ? parsed.canonicalPathname : '/';
    const currentMetadata = decodeNotesNavigationHistoryMetadata(
      port.getState(),
    );
    const knownIndex =
      currentMetadata?.runtimeId === runtimeId
        ? knownEntries.findIndex(
            (entry) => entry.entryId === currentMetadata.entryId,
          )
        : -1;
    const known = knownIndex >= 0 ? knownEntries[knownIndex] : undefined;
    if (!known || !areNotesLocationsEqual(known.location, location)) {
      adoptUnknownPop(location, canonicalPathname);
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
      replaceCurrent(canonicalPathname, known.entryId);
    }
    emit();
  };

  return {
    getLocation: () => snapshot.location,
    getSnapshot: () => snapshot,
    navigate: (intent) => {
      const previous = snapshot.location;
      const next = reduceNotesLocation(previous, intent);
      const canonicalPathname = notesLocationPathname(next);
      if (next === previous) {
        if (!isCanonicalUrl(port.getUrl(), canonicalPathname)) {
          replaceCurrent(canonicalPathname, snapshot.entryId);
        }
        return snapshot.location;
      }

      const firstCardFromEmpty =
        previous.kind === 'empty' && intent.type === 'open-card';
      if (replaceIntent(intent) || firstCardFromEmpty) {
        const current = knownEntries[cursor];
        if (!current) return snapshot.location;
        cameraSession.replaceEntry(current.entryId, previous, next);
        knownEntries[cursor] = { entryId: current.entryId, location: next };
        snapshot = {
          location: next,
          entryId: current.entryId,
          activationId: snapshot.activationId + 1,
          cause: notesNavigationCause(intent),
          pending: false,
        };
        replaceCurrent(canonicalPathname, current.entryId);
      } else {
        const discarded = knownEntries.slice(cursor + 1);
        cameraSession.discardEntries(discarded.map((entry) => entry.entryId));
        const entryId = nextEntryId;
        nextEntryId += 1;
        knownEntries = [
          ...knownEntries.slice(0, cursor + 1),
          { entryId, location: next },
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
      }
      emit();
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
