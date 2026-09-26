import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  browserExternalDestinations,
  decideBrowserExternalDestination,
  decodeExternalTransmissionManifest,
  externalTransmissionManifest,
} from '@/lib/application/external-transmission';

describe('external transmission manifest', () => {
  it('decodes the complete manifest and exactly matches the browser destination catalog', () => {
    expect(
      decodeExternalTransmissionManifest(externalTransmissionManifest),
    ).toEqual({
      kind: 'decoded',
      manifest: externalTransmissionManifest,
    });
    expect(
      externalTransmissionManifest.entries.map((entry) => entry.destinationId),
    ).toEqual(browserExternalDestinations.map((entry) => entry.id));
    expect(externalTransmissionManifest.optionalTracking).toBe('none');
    expect(externalTransmissionManifest.firstPartySession.cookieName).toBe(
      '__Host-fukamu_session',
    );
  });

  it('rejects malformed, incomplete, duplicate and unknown manifests', () => {
    const manifest = externalTransmissionManifest;
    for (const input of [
      null,
      { ...manifest, unknown: true },
      { ...manifest, reviewedOn: '2026-02-30' },
      { ...manifest, manifestVersion: 'external-transmission-v1:old' },
      { ...manifest, optionalTracking: 'analytics' },
      {
        ...manifest,
        firstPartySession: {
          ...manifest.firstPartySession,
          sentTo: 'third-party',
        },
      },
      { ...manifest, entries: manifest.entries.slice(1) },
      { ...manifest, entries: [manifest.entries[0], manifest.entries[0]] },
      {
        ...manifest,
        entries: [
          { ...manifest.entries[0], destinationId: 'unknown-provider' },
          manifest.entries[1],
        ],
      },
      {
        ...manifest,
        entries: [
          { ...manifest.entries[0], privacyUrl: 'http://localhost/privacy' },
          manifest.entries[1],
        ],
      },
    ]) {
      expect(decodeExternalTransmissionManifest(input).kind).toBe('invalid');
    }
  });

  it('allows only the declared Google and Stripe origins and exact Google authorization path', () => {
    expect(
      decideBrowserExternalDestination(
        'google-oidc',
        'https://accounts.google.com/o/oauth2/v2/auth?client_id=test',
      ),
    ).toMatchObject({ kind: 'allowed', destinationId: 'google-oidc' });
    expect(
      decideBrowserExternalDestination(
        'stripe-checkout',
        'https://checkout.stripe.com/c/pay/cs_test_fukamu',
      ),
    ).toMatchObject({ kind: 'allowed', destinationId: 'stripe-checkout' });

    for (const [destination, url] of [
      ['google-oidc', 'https://accounts.google.com.evil.test/o/oauth2/v2/auth'],
      ['google-oidc', 'https://accounts.google.com/other'],
      ['google-oidc', 'https://user@accounts.google.com/o/oauth2/v2/auth'],
      ['stripe-checkout', 'https://checkout.stripe.com.evil.test/c/pay/test'],
      ['stripe-checkout', 'http://checkout.stripe.com/c/pay/test'],
      ['stripe-checkout', 'not-a-url'],
    ] as const) {
      expect(decideBrowserExternalDestination(destination, url).kind).toBe(
        'blocked',
      );
    }
  });

  it('runs the build gate and keeps provider navigation behind the shared policy', async () => {
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        'scripts/verify-external-transmission.mjs',
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    expect(result.status).toBe(0);

    const [
      oidcBoundary,
      oidcEvidence,
      cookieBoundary,
      checkout,
      page,
      layout,
      privacy,
      notes,
      staticHandler,
    ] = await Promise.all([
      readFile('backend/internal/identity/oidc_boundary.go', 'utf8'),
      readFile('backend/internal/identity/oidc_destination_test.go', 'utf8'),
      readFile('backend/internal/identity/cookie.go', 'utf8'),
      readFile('lib/client/http-billing-ui.ts', 'utf8'),
      readFile('app/(public)/legal/external-transmission/page.tsx', 'utf8'),
      readFile('app/(public)/layout.tsx', 'utf8'),
      readFile('app/(public)/legal/privacy/page.tsx', 'utf8'),
      readFile('components/notes-presentation.tsx', 'utf8'),
      readFile('backend/internal/httpapi/static.go', 'utf8'),
    ]);
    expect(oidcBoundary).toContain(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(oidcEvidence).toContain(
      'func TestSerializeGoogleOidcAuthorizationRequestRejectsNonExactDestination',
    );
    expect(cookieBoundary).toContain(
      'SessionCookieName              = "__Host-fukamu_session"',
    );
    expect(checkout).toContain(
      "decideBrowserExternalDestination('stripe-checkout'",
    );
    expect(page).toContain('externalTransmissionManifest.entries.map');
    expect(layout).toContain('/legal/external-transmission');
    expect(privacy).toContain('/legal/external-transmission');
    expect(notes).not.toMatch(/外部送信|external-transmission/);
    expect(staticHandler).toContain('Content-Security-Policy');
    expect(staticHandler).toContain("connect-src 'self'");
  });
});
