import type { ReactNode } from 'react';
import { AuthenticatedNotesBootstrap } from '@/components/authenticated-notes-bootstrap';
import { ProductionLaunchGate } from './production-launch-gate';

export default function NotesRouteLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <ProductionLaunchGate>
      <AuthenticatedNotesBootstrap />
      {children}
    </ProductionLaunchGate>
  );
}
