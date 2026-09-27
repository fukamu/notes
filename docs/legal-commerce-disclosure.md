# Legal commerce disclosure pages and production build gate

Issue #129 adds three public, directly addressable pages:

- `/pricing`
- `/company`
- `/legal/commercial-transactions`

They use a public-only route layout and do not mount the Notes application.
Legal text, a banner, or a blocking dialog is not added to the card editor,
history, or connections UI. Pricing, company, and legal pages link to each other
through a restrained public header/footer. Future signup and account flows may
link directly to the canonical legal URL without copying the full disclosure
into the Notes interface.

Public pages are prerendered at build time and their links use ordinary
same-origin document navigation. This keeps the public route artifact usable
without mounting the Notes application or depending on a request-time
TypeScript server. Focused browser tests protect direct navigation and the
absence of external transmission.

## Local and test behavior

When `FUKAMU_SERVICE_MODE` is absent or `legacy-test`, the pages render a built-in
fixture. Operator identity and contact values are visibly marked as development
samples, while the approved JPY 980 monthly price and contract policies are the
same values that production validation requires. An accessible notice says that
the operator is not real and that the local screen cannot create a contract or
charge. This keeps `npm run dev`, local builds, CI, and the Go local/test
runtime independent of production credentials and services.
The replaceable operator sample is defined once in
`lib/application/legal-operator-fixture.ts` and shared with the local privacy and
terms fixtures so those pages cannot accidentally identify different operators.

The fixture remains deliberately invalid for production because of its operator
placeholders. Replace those values; never copy them into production.

## Production configuration

`public-paid` mode requires `FUKAMU_LEGAL_COMMERCE_JSON`. The value is decoded as
unknown and must have exactly this versioned shape:

```json
{
  "schemaVersion": 1,
  "seller": {
    "legalName": "株式会社の登記上の正式名称",
    "representative": "代表者または通信販売責任者",
    "postalAddress": "登記住所",
    "phone": "確実に連絡可能な電話番号",
    "supportUrl": "https://support-host/contact"
  },
  "offer": {
    "planName": "法務・商品承認済みのプラン名",
    "priceYen": 980,
    "billingPeriod": "monthly",
    "taxIncluded": true,
    "trialDays": 14
  },
  "additionalFees": "価格以外の負担",
  "cancellationPolicy": "方法、期限、効果を含む解約条件",
  "refundPolicy": "返金および日割り条件",
  "specialTerms": "販売上の特別条件。該当なしの場合も明記",
  "systemRequirements": ["法務・商品承認済みの対応環境"],
  "effectiveDate": "YYYY-MM-DD"
}
```

The decoder rejects missing and unknown fields, malformed telephone/URL/date,
non-positive price, non-tax-inclusive offers, a trial other than 14 days, empty
requirements, and unsupported billing periods. Production validation additionally
rejects development/placeholder markers, unreachable all-zero telephone values,
non-HTTPS or local/example support URLs, and a seller name that does not contain
the verified `株式会社` name. The public paid product is fixed to **980 JPY,
tax included, per month**; a production configuration with another price or an
annual billing period fails closed before build.

`npm run build` runs `check:legal-commerce` before creating artifacts. Therefore
`public-paid` with missing or invalid data fails before a deployable build exists.
This is a completeness and placeholder gate, not legal approval. The price and
billing cycle and the cancellation/refund policies are approved product
decisions and are exact production invariants. Corporate values, contact
operation, and supported environment still require real configuration, and a
qualified Japanese lawyer must review the rendered pages before launch.

## Consistency and rollback

The price and billing period come from one decoded offer used by both the pricing
and statutory-disclosure pages. The fixed 14-day value is tested against the
Billing domain duration. Issue #130 must derive its final checkout offer from the
same approved commercial source instead of copying display strings.

There is no schema/data migration, provider call, real charge, email, or deployment.
Rollback is one PR revert of the pure disclosure contract, environment adapter,
pages, build gate, tests, and this document. If pages have already been published,
their effective versions must be archived under the later legal-version policy;
rollback must not erase historical evidence.
