package cryptocontent

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/identity"
)

const maximumNonceReservationAttempts = 4

var ErrUniqueNonceUnavailable = errors.New("unique encryption nonce unavailable")

type Service struct {
	keys         KeyManagementPort
	nonces       NonceGeneratorPort
	reservations NonceReservationPort
	aesGCM       AES256GCMPort
}

func NewService(
	keys KeyManagementPort,
	nonces NonceGeneratorPort,
	reservations NonceReservationPort,
	aesGCM AES256GCMPort,
) (*Service, error) {
	if keys == nil || nonces == nil || reservations == nil || aesGCM == nil {
		return nil, ErrInvalidEnvelope
	}
	return &Service{keys: keys, nonces: nonces, reservations: reservations, aesGCM: aesGCM}, nil
}

func (service *Service) Encrypt(
	ctx context.Context,
	keyring VaultDEKKeyring,
	object ObjectContext,
	plaintext []byte,
) (EnvelopeCiphertext, error) {
	if service == nil || ValidateObjectContext(object) != nil {
		return EnvelopeCiphertext{}, ErrEnvelopePolicy
	}
	metadata, err := keyring.SelectForWrite(object.VaultID)
	if err != nil {
		return EnvelopeCiphertext{}, ErrEnvelopePolicy
	}
	key, err := service.keys.UnwrapDataKey(ctx, metadata)
	if err != nil {
		return EnvelopeCiphertext{}, err
	}
	defer key.Destroy()
	nonce, err := service.reserveUniqueNonce(ctx, object.VaultID, metadata.DEKVersion)
	if err != nil {
		return EnvelopeCiphertext{}, err
	}
	aad, err := SerializeEnvelopeAAD(object, metadata.DEKVersion)
	if err != nil {
		return EnvelopeCiphertext{}, ErrEnvelopePolicy
	}
	workingPlaintext := append([]byte(nil), plaintext...)
	defer clear(workingPlaintext)
	sealed, err := service.aesGCM.Seal(key, nonce, aad, workingPlaintext)
	if err != nil {
		return EnvelopeCiphertext{}, err
	}
	result := EnvelopeCiphertext{
		Format: EnvelopeCryptoVersion, Algorithm: EnvelopeAlgorithm,
		DEKVersion: metadata.DEKVersion, Nonce: nonce, SealedPayload: sealed,
	}
	if ValidateEnvelopeCiphertext(result) != nil {
		return EnvelopeCiphertext{}, ErrInvalidEnvelope
	}
	return result, nil
}

func (service *Service) Decrypt(
	ctx context.Context,
	keyring VaultDEKKeyring,
	object ObjectContext,
	ciphertext EnvelopeCiphertext,
) ([]byte, error) {
	if service == nil || ValidateObjectContext(object) != nil || ValidateEnvelopeCiphertext(ciphertext) != nil {
		return nil, ErrEnvelopePolicy
	}
	metadata, err := keyring.SelectForRead(object.VaultID, ciphertext.DEKVersion)
	if err != nil {
		return nil, ErrEnvelopePolicy
	}
	key, err := service.keys.UnwrapDataKey(ctx, metadata)
	if err != nil {
		return nil, err
	}
	defer key.Destroy()
	aad, err := SerializeEnvelopeAAD(object, ciphertext.DEKVersion)
	if err != nil {
		return nil, ErrEnvelopePolicy
	}
	return service.aesGCM.Open(key, ciphertext.Nonce, aad, ciphertext.SealedPayload)
}

func (service *Service) reserveUniqueNonce(
	ctx context.Context,
	vaultID identity.VaultID,
	version DEKVersion,
) (string, error) {
	for attempt := 0; attempt < maximumNonceReservationAttempts; attempt++ {
		candidate, err := service.nonces.CreateNonce(ctx)
		if err != nil {
			return "", err
		}
		if len(candidate) != 12 {
			clear(candidate)
			return "", ErrInvalidEnvelope
		}
		nonce := EncodeBase64URL(candidate)
		clear(candidate)
		reserved, err := service.reservations.ReserveNonce(ctx, vaultID, version, nonce)
		if err != nil {
			return "", err
		}
		if reserved {
			return nonce, nil
		}
	}
	return "", ErrUniqueNonceUnavailable
}
