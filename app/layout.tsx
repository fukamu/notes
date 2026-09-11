import type { Metadata } from 'next';
import { resolveSiteUrl } from '@/lib/environment/site-url';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: resolveSiteUrl(process.env.NEXT_PUBLIC_SITE_URL),
  title: 'FUKAMU Notes',
  description:
    '紙のカードをめくるように、考えを書き、つなげるローカルファーストノート',
  applicationName: 'FUKAMU Notes',
  icons: { icon: '/favicon.svg' },
  manifest: '/manifest.webmanifest',
  openGraph: {
    title: 'FUKAMU Notes',
    description: '一枚ずつ、考えを深める',
    images: ['/og.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'FUKAMU Notes',
    description: '一枚ずつ、考えを深める',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
