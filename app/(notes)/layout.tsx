import type { ReactNode } from 'react';
import { LegacyNotesApp } from '@/components/notes-app';
import { ProductionLaunchGate } from './production-launch-gate';

export default function NotesRouteLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <ProductionLaunchGate>
      <LegacyNotesApp />
      {children}
    </ProductionLaunchGate>
  );
}
