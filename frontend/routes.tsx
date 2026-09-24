import type { ReactNode } from 'react';
import NotesRouteLayout from '@/app/(notes)/layout';
import AccountBillingPage from '@/app/(public)/account/billing/page';
import AccountPrivacyPage from '@/app/(public)/account/privacy/page';
import AccountTermsPage from '@/app/(public)/account/terms/page';
import CheckoutPage from '@/app/(public)/checkout/page';
import CompanyPage from '@/app/(public)/company/page';
import CommercialTransactionsPage from '@/app/(public)/legal/commercial-transactions/page';
import ExternalTransmissionPage from '@/app/(public)/legal/external-transmission/page';
import PrivacyPage from '@/app/(public)/legal/privacy/page';
import LegalTermsPage from '@/app/(public)/legal/terms/page';
import PublicRouteLayout from '@/app/(public)/layout';
import PricingPage from '@/app/(public)/pricing/page';

export const baseDescription =
  '紙のカードをめくるように、考えを書き、つなげるローカルファーストWebアプリ';

type PublicRoute = Readonly<{
  component: () => ReactNode;
  title: string;
}>;

export const publicRoutes: Readonly<Record<string, PublicRoute>> = {
  '/account/billing': {
    component: AccountBillingPage,
    title: '契約管理 | FUKAMU Notes',
  },
  '/account/privacy': {
    component: AccountPrivacyPage,
    title: '個人情報に関する請求 | FUKAMU Notes',
  },
  '/account/terms': {
    component: AccountTermsPage,
    title: '利用規約の確認 | FUKAMU Notes',
  },
  '/checkout': {
    component: CheckoutPage,
    title: '申込み内容の最終確認 | FUKAMU Notes',
  },
  '/company': { component: CompanyPage, title: '会社概要 | FUKAMU Notes' },
  '/legal/commercial-transactions': {
    component: CommercialTransactionsPage,
    title: '特定商取引法に基づく表記 | FUKAMU Notes',
  },
  '/legal/external-transmission': {
    component: ExternalTransmissionPage,
    title: '外部送信について | FUKAMU Notes',
  },
  '/legal/privacy': {
    component: PrivacyPage,
    title: '個人情報保護方針 | FUKAMU Notes',
  },
  '/legal/terms': {
    component: LegalTermsPage,
    title: '利用規約 | FUKAMU Notes',
  },
  '/pricing': { component: PricingPage, title: '料金 | FUKAMU Notes' },
};

export function isNotesRoute(pathname: string): boolean {
  return (
    pathname === '/' ||
    pathname === '/history' ||
    /^\/cards\/[^/]+(?:\/(?:history|connections))?$/.test(pathname)
  );
}

export function routeTitle(pathname: string): string {
  return publicRoutes[pathname]?.title ?? 'FUKAMU Notes';
}

export function RouteApplication({ pathname }: { pathname: string }) {
  const publicRoute = publicRoutes[pathname];
  if (publicRoute) {
    return <PublicRouteLayout>{publicRoute.component()}</PublicRouteLayout>;
  }
  if (isNotesRoute(pathname)) {
    return <NotesRouteLayout>{null}</NotesRouteLayout>;
  }
  return null;
}
