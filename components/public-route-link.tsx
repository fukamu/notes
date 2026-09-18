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
  // vinext 1.0.0-beta.5 currently throws during Link prefetch/client navigation.
  // Use a native same-tab document navigation until that runtime is upgraded;
  // tests/e2e/legal-commerce.spec.ts exercises the workaround end to end.
  return (
    <a {...anchorProps} href={href}>
      {children}
    </a>
  );
}
