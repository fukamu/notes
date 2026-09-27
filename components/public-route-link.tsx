import type { ComponentPropsWithoutRef } from 'react';

type PublicRouteLinkProps = Omit<
  ComponentPropsWithoutRef<'a'>,
  'href' | 'target'
> & {
  readonly href: string;
};

export function PublicRouteLink({
  children,
  href,
  ...anchorProps
}: PublicRouteLinkProps) {
  // Public pages are prerendered documents. Native anchors preserve normal
  // document navigation and work before the browser bundle has hydrated.
  return (
    <a {...anchorProps} href={href}>
      {children}
    </a>
  );
}
