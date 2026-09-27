package accountdeletioncredential

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"hash"

	"github.com/fukamu/notes/backend/internal/accountdeletion"
)

var ErrInvalidCredentialInput = errors.New("invalid account deletion credential input")

type Deriver struct {
	key []byte
}

var _ accountdeletion.CredentialPort = (*Deriver)(nil)

func New(key []byte) (*Deriver, error) {
	if len(key) < 32 || len(key) > 1_024 {
		return nil, ErrInvalidCredentialInput
	}
	return &Deriver{key: append([]byte(nil), key...)}, nil
}

func (deriver *Deriver) Derive(
	scope accountdeletion.Scope,
	idempotencyKey accountdeletion.IdempotencyKey,
) (accountdeletion.CredentialBundle, error) {
	if deriver == nil || len(deriver.key) < 32 || !accountdeletion.ValidScope(scope) {
		return accountdeletion.CredentialBundle{}, ErrInvalidCredentialInput
	}
	if _, err := accountdeletion.ParseIdempotencyKey(string(idempotencyKey)); err != nil {
		return accountdeletion.CredentialBundle{}, ErrInvalidCredentialInput
	}
	idempotencyHash, err := deriver.derive("idempotency/v1", scope, idempotencyKey)
	if err != nil {
		return accountdeletion.CredentialBundle{}, err
	}
	secretValue, err := deriver.derive("continuation/v1", scope, idempotencyKey)
	if err != nil {
		return accountdeletion.CredentialBundle{}, err
	}
	secret, err := accountdeletion.ParseContinuationSecret(string(secretValue))
	if err != nil {
		return accountdeletion.CredentialBundle{}, ErrInvalidCredentialInput
	}
	secretHash, err := deriver.DigestSecret(secret)
	if err != nil {
		return accountdeletion.CredentialBundle{}, err
	}
	return accountdeletion.CredentialBundle{
		IdempotencyHash: idempotencyHash, Secret: secret, SecretHash: secretHash,
	}, nil
}

func (deriver *Deriver) DigestSecret(secret accountdeletion.ContinuationSecret) (accountdeletion.CredentialHash, error) {
	if deriver == nil || len(deriver.key) < 32 {
		return "", ErrInvalidCredentialInput
	}
	if _, err := accountdeletion.ParseContinuationSecret(string(secret)); err != nil {
		return "", ErrInvalidCredentialInput
	}
	digest := sha256.Sum256([]byte(secret))
	parsed, err := accountdeletion.ParseCredentialHash(base64.RawURLEncoding.EncodeToString(digest[:]))
	if err != nil {
		return "", ErrInvalidCredentialInput
	}
	return parsed, nil
}

func (deriver *Deriver) derive(
	domain string,
	scope accountdeletion.Scope,
	idempotencyKey accountdeletion.IdempotencyKey,
) (accountdeletion.CredentialHash, error) {
	mac := hmac.New(sha256.New, deriver.key)
	writeFrame(mac, "fukamu-account-deletion/v1")
	writeFrame(mac, domain)
	writeFrame(mac, string(scope.AccountID))
	writeFrame(mac, string(scope.VaultID))
	writeFrame(mac, string(idempotencyKey))
	parsed, err := accountdeletion.ParseCredentialHash(base64.RawURLEncoding.EncodeToString(mac.Sum(nil)))
	if err != nil {
		return "", ErrInvalidCredentialInput
	}
	return parsed, nil
}

func writeFrame(writer hash.Hash, value string) {
	var length [4]byte
	binary.BigEndian.PutUint32(length[:], uint32(len(value)))
	_, _ = writer.Write(length[:])
	_, _ = writer.Write([]byte(value))
}
