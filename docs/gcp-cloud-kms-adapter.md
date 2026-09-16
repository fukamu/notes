# GCP Cloud KMS adapter

Issue #260 supplies the provider adapter selected for wrapping and unwrapping
Vault data-encryption keys (DEKs). It implements the existing
`KeyManagementPort`; envelope encryption, Vault keyring selection, rotation,
and content storage remain provider-neutral. This change does not create a GCP
project, key ring, key, service account, credential, secret, or production
binding, and it does not deploy or rotate any production key.

## Envelope boundary

The application creates each 32-byte DEK locally with Web Crypto. It sends only
that DEK and authenticated context to Cloud KMS `Encrypt`, then retains only the
returned ciphertext and metadata. Content plaintext is encrypted locally with
AES-256-GCM by the existing envelope service and is never sent to Cloud KMS.

The adapter requires one fully qualified CryptoKeyVersion resource, for example:

```text
projects/PROJECT_ID/locations/LOCATION/keyRings/KEY_RING/cryptoKeys/KEY/cryptoKeyVersions/VERSION
```

New wrapping calls address that exact version. Metadata records the exact
version returned by Cloud KMS. Unwrap calls address its parent CryptoKey because
Cloud KMS encodes the version in the ciphertext and selects that version during
`Decrypt`; the adapter still validates the recorded version belongs to the
configured CryptoKey. Old enabled versions therefore remain readable during a
mixed-version rotation.

The additional authenticated data (AAD) is a canonical JSON tuple containing:

1. the `fukamu-vault-dek-wrap/v1` context version;
2. the authenticated Vault ID;
3. the DEK version;
4. the fully qualified CryptoKeyVersion resource.

A wrapped DEK cannot be relabelled as another Vault, logical DEK version, or KEK
version without Cloud KMS authentication failing. Account/Vault ownership is
still established by the authenticated scope and the scope-bound repositories;
it is not accepted from an untrusted request body.

## Integrity and failure behavior

Requests include CRC32C for plaintext/AAD or ciphertext/AAD. Wrapping accepts a
response only when Cloud KMS confirms both request checksums, returns the exact
requested key version, and supplies a ciphertext whose CRC32C matches. Unwrap
accepts only a 32-byte plaintext with a matching response CRC32C.

Raw generated and unwrapped byte buffers are zeroized after a copied ephemeral
`DataEncryptionKey` handle is created. All configuration, transport, decoding,
checksum, authentication, and provider failures fail closed as fixed adapter
errors. Provider response bodies, access tokens, raw keys, and wrapped values
are not attached to those errors or logged by the adapter. There is no plaintext
or fake-adapter fallback.

## Production composition (not performed here)

Production composition must separately provide:

- an access-token source for a dedicated runtime identity;
- the reviewed CryptoKeyVersion resource as configuration;
- network access to `https://cloudkms.googleapis.com`;
- IAM limited to Cloud KMS encrypt/decrypt for the selected key; and
- monitoring for authentication, quota, availability, integrity, and disabled
  key-version failures without logging secret or content material.

Google documents `roles/cloudkms.cryptoKeyEncrypterDecrypter` as the role for
encrypt/decrypt use. The final service-account and workload-identity design,
region, key protection level, rotation schedule, disable/destroy procedure, and
audit retention still require a production operations review. Key destruction
remains a separately approved action under the existing retirement gate.

References:

- [Envelope encryption](https://cloud.google.com/kms/docs/envelope-encryption)
- [Encrypt REST method](https://cloud.google.com/kms/docs/reference/rest/v1/projects.locations.keyRings.cryptoKeys/encrypt)
- [Decrypt REST method](https://cloud.google.com/kms/docs/reference/rest/v1/projects.locations.keyRings.cryptoKeys/decrypt)
- [Key rotation](https://cloud.google.com/kms/docs/key-rotation)
- [Cloud KMS IAM roles](https://cloud.google.com/kms/docs/reference/permissions-and-roles)

## Local verification and rollback

Unit tests use injected entropy, clock, transport, and access-token ports. They
make no GCP call and use no real credential. Code rollback removes this adapter
and its composition option only; it must not delete metadata, ciphertext, or a
provider key. Once production metadata refers to a GCP CryptoKeyVersion, retain
that readable version until the explicit recovery and retirement process proves
it safe to disable or destroy.
