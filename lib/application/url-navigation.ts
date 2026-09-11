import type { NotesLocation } from '@/lib/application/navigation';
import { parseCardId } from '@/lib/domain/id';
import { assertNever } from '@/lib/shared/invariant';

export type ParsedNotesPathname =
  | {
      kind: 'valid';
      location: NotesLocation;
      canonicalPathname: string;
    }
  | { kind: 'invalid' };

function decodedCardId(segment: string) {
  try {
    return parseCardId(decodeURIComponent(segment).toLowerCase());
  } catch {
    return null;
  }
}

export function notesLocationPathname(location: NotesLocation): string {
  switch (location.kind) {
    case 'empty':
      return '/';
    case 'card':
      return `/cards/${encodeURIComponent(location.cardId)}`;
    case 'history':
      return location.cardId
        ? `/cards/${encodeURIComponent(location.cardId)}/history`
        : '/history';
    case 'connections':
      return `/cards/${encodeURIComponent(location.cardId)}/connections`;
    default:
      return assertNever(location, 'Unsupported notes URL location');
  }
}

export function parseNotesPathname(pathname: string): ParsedNotesPathname {
  if (!pathname.startsWith('/')) return { kind: 'invalid' };
  const normalized =
    pathname.length > 1 && pathname.endsWith('/')
      ? pathname.slice(0, -1)
      : pathname;
  let location: NotesLocation;

  if (normalized === '/') {
    location = { kind: 'empty' };
  } else if (normalized === '/history') {
    location = { kind: 'history', cardId: null };
  } else {
    const segments = normalized.split('/');
    if (segments[0] !== '' || segments[1] !== 'cards') {
      return { kind: 'invalid' };
    }
    const cardIdSegment = segments[2];
    if (!cardIdSegment) return { kind: 'invalid' };
    const cardId = decodedCardId(cardIdSegment);
    if (!cardId) return { kind: 'invalid' };

    if (segments.length === 3) {
      location = { kind: 'card', cardId };
    } else if (segments.length === 4 && segments[3] === 'history') {
      location = { kind: 'history', cardId };
    } else if (segments.length === 4 && segments[3] === 'connections') {
      location = { kind: 'connections', cardId };
    } else {
      return { kind: 'invalid' };
    }
  }

  return {
    kind: 'valid',
    location,
    canonicalPathname: notesLocationPathname(location),
  };
}
