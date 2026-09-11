import type { ReactNode } from 'react';
import { NotesApp } from '@/components/notes-app';

export default function NotesRouteLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <>
      <NotesApp />
      {children}
    </>
  );
}
