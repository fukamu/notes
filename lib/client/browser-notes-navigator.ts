import {
  areNotesLocationsEqual,
  EMPTY_NOTES_LOCATION,
  reduceNotesLocation,
  type NotesNavigationIntent,
  type NotesNavigator,
} from '@/lib/application/navigation';
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
  push: (pathname: string) => void;
  replace: (pathname: string) => void;
  subscribePop: (listener: () => void) => () => void;
};

function windowHistoryPort(): NotesBrowserHistoryPort {
  return {
    getUrl: () => ({
      pathname: window.location.pathname,
      search: window.location.search,
      hash: window.location.hash,
    }),
    push: (pathname) => window.history.pushState(null, '', pathname),
    replace: (pathname) => window.history.replaceState(null, '', pathname),
    subscribePop: (listener) => {
      window.addEventListener('popstate', listener);
      return () => window.removeEventListener('popstate', listener);
    },
  };
}

function serverHistoryPort(): NotesBrowserHistoryPort {
  return {
    getUrl: () => ({ pathname: '/', search: '', hash: '' }),
    push: () => undefined,
    replace: () => undefined,
    subscribePop: () => () => undefined,
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
): NotesNavigator {
  const initial = parseNotesPathname(port.getUrl().pathname);
  let location =
    initial.kind === 'valid' ? initial.location : EMPTY_NOTES_LOCATION;
  const listeners = new Set<() => void>();
  let stopListening: (() => void) | null = null;

  const emit = () => {
    for (const listener of listeners) listener();
  };

  const handlePop = () => {
    const parsed = parseNotesPathname(port.getUrl().pathname);
    const next =
      parsed.kind === 'valid' ? parsed.location : EMPTY_NOTES_LOCATION;
    const changed = !areNotesLocationsEqual(location, next);
    location = next;
    if (parsed.kind === 'invalid') {
      port.replace('/');
    } else if (!isCanonicalUrl(port.getUrl(), parsed.canonicalPathname)) {
      port.replace(parsed.canonicalPathname);
    }
    if (changed) emit();
  };

  return {
    getLocation: () => location,
    navigate: (intent) => {
      const previous = location;
      const next = reduceNotesLocation(previous, intent);
      const canonicalPathname = notesLocationPathname(next);
      if (next === previous) {
        if (!isCanonicalUrl(port.getUrl(), canonicalPathname)) {
          port.replace(canonicalPathname);
        }
        return location;
      }

      location = next;
      const firstCardFromEmpty =
        previous.kind === 'empty' && intent.type === 'open-card';
      if (replaceIntent(intent) || firstCardFromEmpty) {
        port.replace(canonicalPathname);
      } else {
        port.push(canonicalPathname);
      }
      emit();
      return location;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      stopListening ??= port.subscribePop(handlePop);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          stopListening?.();
          stopListening = null;
        }
      };
    },
  };
}
