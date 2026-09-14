import type { ReactNode } from 'react';
import { PublicRouteLink } from '@/components/public-route-link';

const legalHref = '/legal/commercial-transactions';

export default function PublicRouteLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="border-b bg-card/65 px-5 py-4 sm:px-8">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4">
          <PublicRouteLink
            href="/"
            className="font-heading text-lg font-semibold tracking-[0.08em]"
          >
            FUKAMU Notes
          </PublicRouteLink>
          <nav
            aria-label="公開情報"
            className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground"
          >
            <PublicRouteLink className="hover:text-foreground" href="/pricing">
              料金
            </PublicRouteLink>
            <PublicRouteLink className="hover:text-foreground" href="/company">
              会社概要
            </PublicRouteLink>
            <PublicRouteLink className="hover:text-foreground" href={legalHref}>
              特定商取引法に基づく表記
            </PublicRouteLink>
          </nav>
        </div>
      </header>
      {children}
      <footer className="border-t px-5 py-7 text-sm text-muted-foreground sm:px-8">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
          <p>FUKAMU Notes</p>
          <nav aria-label="法務情報" className="flex flex-wrap gap-x-5 gap-y-2">
            <PublicRouteLink className="hover:text-foreground" href="/company">
              会社概要
            </PublicRouteLink>
            <PublicRouteLink className="hover:text-foreground" href="/pricing">
              料金
            </PublicRouteLink>
            <PublicRouteLink className="hover:text-foreground" href={legalHref}>
              特定商取引法に基づく表記
            </PublicRouteLink>
          </nav>
        </div>
      </footer>
    </div>
  );
}
