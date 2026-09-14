import type { ComponentProps } from 'react';
import Link from 'next/link';

type PublicRouteLinkProps = Omit<
  ComponentProps<typeof Link>,
  'prefetch' | 'target'
>;

export function PublicRouteLink(props: PublicRouteLinkProps) {
  // vinext 1.0.0-beta.5 currently throws during Link prefetch/client navigation.
  // Use a normal top-level document navigation until that runtime is upgraded;
  // tests/e2e/legal-commerce.spec.ts exercises the workaround end to end.
  return <Link {...props} prefetch={false} target="_top" />;
}
