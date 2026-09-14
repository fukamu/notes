# Personal Vault quota policy

Issue #194 defines the deterministic quota measures used by the later D1
reservation and Sync v2 enforcement stages. This stage is pure policy only. It
does not read or change storage, enable an endpoint, migrate production data,
or make a client-side hint authoritative.

## Display-character decision

The 1,000-character limit counts Unicode scalar values in the card title and
stored text segments. An inline card-link token counts as one logical displayed
item; its UUID and a generated label such as a display ID do not count. Title
and body are not normalized before counting.

This deliberately differs from both common alternatives:

- JavaScript `string.length` counts UTF-16 code units, so one supplementary
  character such as many emoji would count as two.
- A grapheme segmenter can group a combining sequence or a ZWJ family emoji as
  one visible cluster, but its Unicode data and behavior can vary across
  runtime versions.

Unicode scalar counting is portable and reviewable: a surrogate pair counts as
one, `e` plus a combining accent counts as two, and the four-person ZWJ family
sequence counts its seven scalars. An unpaired surrogate is rejected rather
than being silently converted to the replacement character by a UTF-8 encoder.
The UI may show a friendlier live counter later, but only the server evaluation
is authoritative.

## Independent byte measures

The following values are measured and checked separately. One value must never
stand in for another:

| Measure                   | Limit and source                        | Meaning                                             |
| ------------------------- | --------------------------------------- | --------------------------------------------------- |
| Display characters/card   | 1,000 from Entitlement                  | Unicode scalar policy above                         |
| Serialized plaintext/card | 8,192 bytes from Entitlement            | UTF-8 bytes passed to envelope encryption           |
| Plaintext/Vault           | 134,217,728 bytes from Entitlement      | Current active-card serialized plaintext total      |
| Active cards/Vault        | 10,000 from Entitlement                 | Current non-tombstoned cards                        |
| Encoded ciphertext/object | 16,384 bytes internal ceiling           | Complete versioned AES-GCM envelope, not plaintext  |
| HTTP sync request         | 4,000,000 bytes existing decode ceiling | Bytes read from the request body before JSON decode |

The 16 KiB ciphertext ceiling is not a customer storage entitlement. It is a
defensive internal bound for the current envelope: an 8 KiB plaintext plus the
16-byte GCM tag expands to 10,944 base64url characters, and the fixed version,
algorithm, maximum numeric DEK version, 16-character nonce, field names, and
JSON punctuation remain below 16 KiB. A future envelope format must review this
bound rather than silently inheriting it.

The HTTP ceiling reuses the existing `CONTRACT_LIMITS.payloadBytes` boundary.
It is intentionally independent of mutation-count and per-card limits: a
request can be structurally valid and still be rejected for total bytes.

## Usage transitions

The pure transition accepts only refined non-negative safe-integer snapshots.
A create adds one active card and its next plaintext bytes. An update keeps the
card count and applies `next - current` bytes. A delete/tombstone removes one
active card and its current bytes. The exact limit is accepted; one unit above
is rejected. Underflow, unsafe arithmetic, deletion from an empty Vault, or a
current-card size greater than the recorded Vault total is invalid evidence.

Concurrent correctness is not claimed by this pure calculation alone. Issue
#195 will place the snapshot, reservation, and revision behind a Vault-scoped
D1 CAS. Issue #196 will obtain Entitlement limits and boundary measurements,
then connect that reservation to authenticated Sync v2 without weakening
idempotency or failure handling.

Main is unchanged and production is not deployed by this policy.
