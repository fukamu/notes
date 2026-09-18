import {
  initialForegroundResumeState,
  transitionForegroundResume,
  type ForegroundResumeEvent,
} from '@/lib/application/foreground-resume';
import type { ForegroundResumePort } from '@/lib/application/notes-runtime';

export function subscribeBrowserForegroundResume(
  documentRef: Document,
  windowRef: Window,
  onResume: () => void,
): () => void {
  let state = initialForegroundResumeState(
    documentRef.visibilityState === 'visible',
  );
  const apply = (event: ForegroundResumeEvent) => {
    const transition = transitionForegroundResume(state, event);
    state = transition.state;
    if (transition.notify) onResume();
  };
  const onVisibilityChange = () =>
    apply({
      type: 'visibility-changed',
      visible: documentRef.visibilityState === 'visible',
    });
  const onPageHide = () => apply({ type: 'page-hidden' });
  const onPageShow = () =>
    apply({
      type: 'page-shown',
      visible: documentRef.visibilityState === 'visible',
    });

  documentRef.addEventListener('visibilitychange', onVisibilityChange);
  windowRef.addEventListener('pagehide', onPageHide);
  windowRef.addEventListener('pageshow', onPageShow);
  return () => {
    documentRef.removeEventListener('visibilitychange', onVisibilityChange);
    windowRef.removeEventListener('pagehide', onPageHide);
    windowRef.removeEventListener('pageshow', onPageShow);
  };
}

export const browserForegroundResume: ForegroundResumePort = {
  subscribe: (onResume) =>
    subscribeBrowserForegroundResume(document, window, onResume),
};
