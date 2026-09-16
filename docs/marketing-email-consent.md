# Marketing email consent and record fixture

FUKAMU Notes currently has no marketing-email sender. Issue #135 defines the
provider-neutral pure state machine and retention fixture that a later approved
provider adapter must use before any marketing email is enabled. It sends no
email and stores no real recipient data.

Marketing consent is separate from Email OTP, security notices, invoices,
contract notices, support replies, and other transactional delivery. Creating an
account, accepting the terms, supplying a billing method, or requesting an OTP
does not grant marketing consent. Delivery is allowed only in the explicit
`consented` state, and withdrawal blocks all later marketing delivery.

The fixture records consent, each marketing send date, and withdrawal as ordered
events. It rejects delivery without consent and rejects events dated before the
current state. Consent evidence remains retained for three years from the latest
of the consent, last marketing send, and withdrawal dates. This conservative
engineering baseline preserves the Issue #135 three-year record requirement
while preventing withdrawal from deleting evidence immediately. Deletion after
that date is only _eligible for reviewed deletion_; an approved retention policy
and any legal hold still apply.

The three-year baseline reflects the record rule described in the Consumer
Affairs Agency material for email advertising under the Act on Specified
Commercial Transactions. The Act on Regulation of Transmission of Specified
Electronic Mail has its own record rules and exceptions. Qualified Japanese
legal review must confirm the applicable classification, retention period,
required sender display, opt-out method, and provider implementation before
launch; the pure fixture does not make that legal determination.

- [Consumer Affairs Agency specified email guidance](https://www.caa.go.jp/policies/policy/consumer_transaction/specifed_email/)
- [Launch compliance gate](./legal-launch-compliance.md)

The future adapter must keep the recipient identity and consent evidence in an
approved access-controlled system, support audited lookup and withdrawal, and
never place recipient addresses or message bodies in this repository, telemetry
labels, or the launch manifest. Real email and provider configuration require a
separate explicit approval.
