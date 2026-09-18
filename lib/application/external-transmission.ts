import {
  arrayDecoder,
  literalDecoder,
  objectDecoder,
  refineDecoder,
  safeIntegerDecoder,
  stringDecoder,
  transformDecoder,
  unionDecoder,
  type Decoder,
} from '../codec/core.ts';

export const EXTERNAL_TRANSMISSION_SCHEMA_VERSION = 1;

export const browserExternalDestinations = [
  {
    id: 'google-oidc',
    feature: 'Google Login',
    origin: 'https://accounts.google.com',
  },
  {
    id: 'stripe-checkout',
    feature: 'Stripe Checkout',
    origin: 'https://checkout.stripe.com',
  },
] as const;

export type BrowserExternalDestinationId =
  (typeof browserExternalDestinations)[number]['id'];

export type ExternalTransmissionEntry = Readonly<{
  destinationId: BrowserExternalDestinationId;
  serviceName: string;
  recipientLegalNames: readonly string[];
  trigger: 'user-initiated-navigation';
  sentInformation: readonly string[];
  operatorPurposes: readonly string[];
  recipientPurposes: readonly string[];
  privacyUrl: string;
  refusalEffect: string;
}>;

export type ExternalTransmissionManifest = Readonly<{
  schemaVersion: typeof EXTERNAL_TRANSMISSION_SCHEMA_VERSION;
  manifestVersion: string;
  reviewedOn: string;
  serviceShape: 'personal-storage-without-sharing';
  applicabilityAssessment: 'specialist-confirmation-required-before-launch';
  optionalTracking: 'none';
  firstPartySession: Readonly<{
    cookieName: string;
    sentTo: 'same-origin-only';
    purpose: string;
  }>;
  localDeviceStorage: Readonly<{
    technologies: readonly string[];
    purpose: string;
    logoutHandling: 'delete-user-content';
  }>;
  entries: readonly ExternalTransmissionEntry[];
}>;

export type ExternalTransmissionManifestDecodeResult =
  | {
      readonly kind: 'decoded';
      readonly manifest: ExternalTransmissionManifest;
    }
  | { readonly kind: 'invalid'; readonly issues: readonly string[] };

export type BrowserExternalDestinationDecision =
  | {
      readonly kind: 'allowed';
      readonly destinationId: BrowserExternalDestinationId;
      readonly url: URL;
    }
  | {
      readonly kind: 'blocked';
      readonly reason: 'invalid-url' | 'destination-mismatch';
    };

const textDecoder = refineDecoder(
  stringDecoder({ minLength: 1, maxLength: 1_000 }),
  (value) => value.trim().length > 0,
  'expected non-blank text',
);
const dateDecoder = refineDecoder(
  stringDecoder({ minLength: 10, maxLength: 10 }),
  validCalendarDate,
  'expected a valid YYYY-MM-DD date',
);
const httpsUrlDecoder = refineDecoder(
  stringDecoder({ minLength: 1, maxLength: 500 }),
  isPublicHttpsUrl,
  'expected a public HTTPS URL',
);
const destinationIdDecoder: Decoder<BrowserExternalDestinationId> =
  unionDecoder(
    literalDecoder('google-oidc'),
    literalDecoder('stripe-checkout'),
  );
const entryDecoder: Decoder<ExternalTransmissionEntry> = transformDecoder(
  objectDecoder({
    destinationId: destinationIdDecoder,
    serviceName: textDecoder,
    recipientLegalNames: arrayDecoder(textDecoder, {
      minLength: 1,
      maxLength: 4,
      uniqueBy: (value) => value,
    }),
    trigger: literalDecoder('user-initiated-navigation'),
    sentInformation: arrayDecoder(textDecoder, {
      minLength: 1,
      maxLength: 12,
      uniqueBy: (value) => value,
    }),
    operatorPurposes: arrayDecoder(textDecoder, {
      minLength: 1,
      maxLength: 8,
      uniqueBy: (value) => value,
    }),
    recipientPurposes: arrayDecoder(textDecoder, {
      minLength: 1,
      maxLength: 8,
      uniqueBy: (value) => value,
    }),
    privacyUrl: httpsUrlDecoder,
    refusalEffect: textDecoder,
  }),
  (value): ExternalTransmissionEntry => value,
);
const manifestDecoder = objectDecoder({
  schemaVersion: transformDecoder(
    safeIntegerDecoder({ minimum: 1, maximum: 1 }),
    (): typeof EXTERNAL_TRANSMISSION_SCHEMA_VERSION =>
      EXTERNAL_TRANSMISSION_SCHEMA_VERSION,
  ),
  manifestVersion: textDecoder,
  reviewedOn: dateDecoder,
  serviceShape: literalDecoder('personal-storage-without-sharing'),
  applicabilityAssessment: literalDecoder(
    'specialist-confirmation-required-before-launch',
  ),
  optionalTracking: literalDecoder('none'),
  firstPartySession: objectDecoder({
    cookieName: textDecoder,
    sentTo: literalDecoder('same-origin-only'),
    purpose: textDecoder,
  }),
  localDeviceStorage: objectDecoder({
    technologies: arrayDecoder(textDecoder, {
      minLength: 1,
      maxLength: 6,
      uniqueBy: (value) => value,
    }),
    purpose: textDecoder,
    logoutHandling: literalDecoder('delete-user-content'),
  }),
  entries: arrayDecoder(entryDecoder, {
    minLength: browserExternalDestinations.length,
    maxLength: browserExternalDestinations.length,
    uniqueBy: (value) => value.destinationId,
  }),
});

export const externalTransmissionManifest: ExternalTransmissionManifest = {
  schemaVersion: EXTERNAL_TRANSMISSION_SCHEMA_VERSION,
  manifestVersion: 'external-transmission-v1:2026-09-15',
  reviewedOn: '2026-09-15',
  serviceShape: 'personal-storage-without-sharing',
  applicabilityAssessment: 'specialist-confirmation-required-before-launch',
  optionalTracking: 'none',
  firstPartySession: {
    cookieName: '__Host-fukamu_session',
    sentTo: 'same-origin-only',
    purpose:
      '認証済みsessionを維持し、requestごとにAccountとPersonal Vaultのscopeをserverで決定するため',
  },
  localDeviceStorage: {
    technologies: ['IndexedDB', 'Cache Storage'],
    purpose: 'local-firstの自動保存、offline編集およびapp shellの提供',
    logoutHandling: 'delete-user-content',
  },
  entries: [
    {
      destinationId: 'google-oidc',
      serviceName: 'Google Login（OpenID Connect）',
      recipientLegalNames: ['Google LLC'],
      trigger: 'user-initiated-navigation',
      sentInformation: [
        'OAuth client ID、redirect URIおよび要求scope',
        'CSRF防止用state、replay防止用nonceおよびPKCE challenge',
        '遷移時にブラウザから通常送信されるIP address、user agent等の通信情報',
      ],
      operatorPurposes: [
        'Google Accountを用いた本人認証',
        '認証responseの改ざん、CSRFおよびreplayの防止',
      ],
      recipientPurposes: [
        'Google Loginの提供、securityおよび不正利用防止',
        'Googleのprivacy policyに定めるserviceの維持・改善',
      ],
      privacyUrl: 'https://policies.google.com/privacy?hl=ja',
      refusalEffect:
        'Google Loginを選択しなければGoogleへのこの送信は行われません。Email OTPで登録・loginできます。',
    },
    {
      destinationId: 'stripe-checkout',
      serviceName: 'Stripe Checkout',
      recipientLegalNames: [
        'Stripe Japan, Inc.（ストライプジャパン株式会社）',
        'Stripe Payments Europe, Limited',
      ],
      trigger: 'user-initiated-navigation',
      sentInformation: [
        'FUKAMU Notes serverが発行したCheckout sessionを特定するURL',
        '遷移時にブラウザから通常送信されるIP address、user agent、device情報およびCookie等',
        'Stripeの画面で利用者が入力するcard情報、連絡先および本人認証情報',
      ],
      operatorPurposes: [
        '支払い方法の登録、subscriptionの開始および継続課金',
        '本人認証、不正利用防止、支払い状態および利用権の管理',
      ],
      recipientPurposes: [
        '決済処理、本人認証、fraud detectionおよび法令遵守',
        'Stripe serviceの運営、分析および改善',
      ],
      privacyUrl: 'https://stripe.com/jp/privacy',
      refusalEffect:
        'Stripe Checkoutで支払い方法を登録しない場合、有料subscriptionを開始できません。card番号とCVCはFUKAMU Notesのserverを通過せず、保存もしません。',
    },
  ],
};

export function decodeExternalTransmissionManifest(
  input: unknown,
): ExternalTransmissionManifestDecodeResult {
  const decoded = manifestDecoder.decode(input);
  if (!decoded.ok) {
    return {
      kind: 'invalid',
      issues: decoded.issues.map(
        (issue) =>
          `${issue.path.length === 0 ? '$' : `$.${issue.path.join('.')}`}: ${issue.reason}`,
      ),
    };
  }
  const issues: string[] = [];
  if (
    decoded.value.manifestVersion !==
    `external-transmission-v1:${decoded.value.reviewedOn}`
  ) {
    issues.push(
      '$.manifestVersion must match external-transmission-v1:<reviewedOn>',
    );
  }
  for (const destination of browserExternalDestinations) {
    if (
      !decoded.value.entries.some(
        (entry) => entry.destinationId === destination.id,
      )
    ) {
      issues.push(`$.entries must include ${destination.id}`);
    }
  }
  return issues.length === 0
    ? { kind: 'decoded', manifest: decoded.value }
    : { kind: 'invalid', issues };
}

export function decideBrowserExternalDestination(
  destinationId: BrowserExternalDestinationId,
  input: unknown,
): BrowserExternalDestinationDecision {
  if (typeof input !== 'string' || input.length > 2_048) {
    return { kind: 'blocked', reason: 'invalid-url' };
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { kind: 'blocked', reason: 'invalid-url' };
  }
  const destination = browserExternalDestinations.find(
    (candidate) => candidate.id === destinationId,
  );
  if (
    destination === undefined ||
    url.origin !== destination.origin ||
    url.username !== '' ||
    url.password !== ''
  ) {
    return { kind: 'blocked', reason: 'destination-mismatch' };
  }
  if (destinationId === 'google-oidc' && url.pathname !== '/o/oauth2/v2/auth') {
    return { kind: 'blocked', reason: 'destination-mismatch' };
  }
  return { kind: 'allowed', destinationId, url };
}

export function browserExternalDestination(
  destinationId: BrowserExternalDestinationId,
): (typeof browserExternalDestinations)[number] {
  switch (destinationId) {
    case 'google-oidc':
      return browserExternalDestinations[0];
    case 'stripe-checkout':
      return browserExternalDestinations[1];
  }
}

function validCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().startsWith(value);
}

function isPublicHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.hostname !== 'localhost' &&
      url.hostname !== '127.0.0.1' &&
      url.hostname !== '[::1]'
    );
  } catch {
    return false;
  }
}
