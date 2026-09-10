export type DisplayId =
  | { kind: 'provisional'; value: number }
  | { kind: 'official'; value: number };

export type TextSegment = {
  type: 'text';
  text: string;
};

export type CardLinkSegment = {
  type: 'link';
  targetCardId: string;
};

export type BodySegment = TextSegment | CardLinkSegment;

export type CardRecord = {
  id: string;
  displayId: DisplayId;
  title: string;
  body: BodySegment[];
  createdAt: number;
  updatedAt: number;
  localRevision: number;
  serverRevision: number | null;
};

export type ConflictRecord = {
  id: string;
  cardId: string;
  serverRevision: number;
  localTitle: string;
  localBody: BodySegment[];
  serverTitle: string;
  serverBody: BodySegment[];
  createdAt: number;
};

export type PendingMutation = {
  mutationId: string;
  cardId: string;
  kind: 'upsert' | 'resolve';
  baseServerRevision: number | null;
  title: string;
  body: BodySegment[];
  createdAt: number;
  updatedAt: number;
  conflictIds: string[];
};

export type SaveState = 'saved' | 'saving' | 'failed';
export type SyncState = 'idle' | 'syncing' | 'offline' | 'failed';

export function visibleTitle(title: string): string {
  return title.trim() === '' ? 'Untitled' : title;
}
