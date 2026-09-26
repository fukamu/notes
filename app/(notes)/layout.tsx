import type { ReactNode } from 'react';
import { NotesRouteRuntime } from './notes-route-runtime';

export default function NotesRouteLayout({
  children,
}: {
  children: ReactNode;
}) {
  return <NotesRouteRuntime>{children}</NotesRouteRuntime>;
}
