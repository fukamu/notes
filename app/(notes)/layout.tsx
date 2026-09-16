import type { ReactNode } from 'react';
import { LegacyNotesApp } from '@/components/notes-app';

export default function NotesRouteLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <>
      <LegacyNotesApp />
      {children}
    </>
  );
}
