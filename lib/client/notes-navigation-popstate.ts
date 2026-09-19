type NotesPopstateListener = (state: unknown) => boolean;

type NotesPopstateBridge = {
  installed: boolean;
  listeners: Set<NotesPopstateListener>;
};

declare global {
  interface Window {
    __fukamuNotesPopstateBridgeV1?: NotesPopstateBridge;
  }
}

function bridge(): NotesPopstateBridge {
  const existing = window.__fukamuNotesPopstateBridgeV1;
  if (existing) return existing;
  const created: NotesPopstateBridge = {
    installed: false,
    listeners: new Set(),
  };
  window.__fukamuNotesPopstateBridgeV1 = created;
  return created;
}

export function installNotesNavigationPopstateBridge(): void {
  if (typeof window === 'undefined') return;
  const current = bridge();
  if (current.installed) return;
  current.installed = true;
  window.addEventListener(
    'popstate',
    (event) => {
      for (const listener of current.listeners) {
        if (!listener(event.state)) continue;
        event.stopImmediatePropagation();
        return;
      }
    },
    true,
  );
}

export function subscribeNotesNavigationPopstate(
  listener: NotesPopstateListener,
): () => void {
  installNotesNavigationPopstateBridge();
  const current = bridge();
  current.listeners.add(listener);
  return () => current.listeners.delete(listener);
}
