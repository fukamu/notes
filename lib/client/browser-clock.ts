import type { Clock } from '@/lib/application/notes-runtime';

export const browserClock: Clock = {
  now: () => Date.now(),
};
