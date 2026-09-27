package contentcrypto

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
	"io"

	"github.com/fukamu/notes/backend/internal/cryptocontent"
)

var (
	ErrAuthenticationFailed = errors.New("envelope authentication failed")
	ErrEncryptionFailed     = errors.New("envelope encryption failed")
	ErrNonceUnavailable     = errors.New("encryption nonce unavailable")
)

type AES256GCM struct{}

func (AES256GCM) Seal(
	key *cryptocontent.DataEncryptionKey,
	nonceValue string,
	aad string,
	plaintext []byte,
) (string, error) {
	nonce, err := cryptocontent.DecodeCanonicalBase64URL(nonceValue, 16, 16)
	if err != nil || len(nonce) != 12 {
		return "", ErrEncryptionFailed
	}
	defer clear(nonce)
	var sealed []byte
	err = key.Use(func(keyBytes []byte) error {
		block, blockErr := aes.NewCipher(keyBytes)
		if blockErr != nil {
			return blockErr
		}
		var gcm cipher.AEAD
		gcm, blockErr = cipher.NewGCM(block)
		if blockErr != nil {
			return blockErr
		}
		sealed = gcm.Seal(nil, nonce, plaintext, []byte(aad))
		return nil
	})
	if err != nil {
		clear(sealed)
		return "", ErrEncryptionFailed
	}
	encoded := cryptocontent.EncodeBase64URL(sealed)
	clear(sealed)
	if _, err := cryptocontent.DecodeCanonicalBase64URL(encoded, 22, cryptocontent.MaximumWrappedDEKSize); err != nil {
		return "", ErrEncryptionFailed
	}
	return encoded, nil
}

func (AES256GCM) Open(
	key *cryptocontent.DataEncryptionKey,
	nonceValue string,
	aad string,
	sealedValue string,
) ([]byte, error) {
	nonce, err := cryptocontent.DecodeCanonicalBase64URL(nonceValue, 16, 16)
	if err != nil || len(nonce) != 12 {
		return nil, ErrAuthenticationFailed
	}
	defer clear(nonce)
	sealed, err := cryptocontent.DecodeCanonicalBase64URL(
		sealedValue,
		22,
		cryptocontent.MaximumWrappedDEKSize,
	)
	if err != nil {
		return nil, ErrAuthenticationFailed
	}
	defer clear(sealed)
	var plaintext []byte
	err = key.Use(func(keyBytes []byte) error {
		block, blockErr := aes.NewCipher(keyBytes)
		if blockErr != nil {
			return blockErr
		}
		var gcm cipher.AEAD
		gcm, blockErr = cipher.NewGCM(block)
		if blockErr != nil {
			return blockErr
		}
		plaintext, blockErr = gcm.Open(nil, nonce, sealed, []byte(aad))
		return blockErr
	})
	if err != nil {
		clear(plaintext)
		return nil, ErrAuthenticationFailed
	}
	return plaintext, nil
}

type RandomNonceGenerator struct {
	reader io.Reader
}

func NewRandomNonceGenerator(reader io.Reader) (*RandomNonceGenerator, error) {
	if reader == nil {
		return nil, ErrNonceUnavailable
	}
	return &RandomNonceGenerator{reader: reader}, nil
}

func NewSecureRandomNonceGenerator() *RandomNonceGenerator {
	return &RandomNonceGenerator{reader: rand.Reader}
}

func (generator *RandomNonceGenerator) CreateNonce(ctx context.Context) ([]byte, error) {
	if generator == nil || generator.reader == nil {
		return nil, ErrNonceUnavailable
	}
	if err := ctx.Err(); err != nil {
		return nil, ErrNonceUnavailable
	}
	nonce := make([]byte, 12)
	if _, err := io.ReadFull(generator.reader, nonce); err != nil {
		clear(nonce)
		return nil, ErrNonceUnavailable
	}
	return nonce, nil
}
