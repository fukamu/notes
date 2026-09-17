/// <reference types="vite/client" />

import { default as corridorWorkerUrl } from '@/lib/client/connections-corridor-worker-entry.ts?worker&url';

export const connectionsCorridorWorkerUrl = corridorWorkerUrl;
