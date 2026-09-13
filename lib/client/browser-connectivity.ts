import type { ConnectivityPort } from '@/lib/application/notes-runtime';

export const browserConnectivity: ConnectivityPort = {
  isOnline: () => navigator.onLine,
  subscribe: ({ onOnline, onOffline }) => {
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  },
};
