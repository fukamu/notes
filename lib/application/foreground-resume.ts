export type ForegroundResumeState = 'foreground' | 'background';

export type ForegroundResumeEvent =
  | Readonly<{ type: 'visibility-changed'; visible: boolean }>
  | Readonly<{ type: 'page-hidden' }>
  | Readonly<{ type: 'page-shown'; visible: boolean }>;

export type ForegroundResumeTransition = Readonly<{
  state: ForegroundResumeState;
  notify: boolean;
}>;

export function initialForegroundResumeState(
  visible: boolean,
): ForegroundResumeState {
  return visible ? 'foreground' : 'background';
}

function observeForeground(
  state: ForegroundResumeState,
): ForegroundResumeTransition {
  return state === 'background'
    ? { state: 'foreground', notify: true }
    : { state, notify: false };
}

export function transitionForegroundResume(
  state: ForegroundResumeState,
  event: ForegroundResumeEvent,
): ForegroundResumeTransition {
  switch (event.type) {
    case 'visibility-changed':
      return event.visible
        ? observeForeground(state)
        : { state: 'background', notify: false };
    case 'page-hidden':
      return { state: 'background', notify: false };
    case 'page-shown':
      return event.visible
        ? observeForeground(state)
        : { state: 'background', notify: false };
  }
}
