package otpadapter

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"time"

	"github.com/fukamu/notes/backend/internal/identity"
)

const otpCodeSpace = uint64(100_000_000)

var _ identity.EmailOtpSecretPort = (*Secrets)(nil)

type Secrets struct {
	reader io.Reader
	now    func() time.Time
}

func NewSecrets(reader io.Reader, now func() time.Time) (*Secrets, error) {
	if reader == nil || now == nil {
		return nil, ErrInvalidCryptoInput
	}
	return &Secrets{reader: reader, now: now}, nil
}

func NewProductionSecrets() *Secrets {
	return &Secrets{reader: rand.Reader, now: time.Now}
}

func (secrets *Secrets) CreateChallengeID(context.Context) (string, error) {
	if secrets == nil || secrets.reader == nil || secrets.now == nil {
		return "", ErrInvalidCryptoInput
	}
	milliseconds := secrets.now().UnixMilli()
	if milliseconds < 0 || milliseconds > (1<<48)-1 {
		return "", ErrInvalidCryptoInput
	}
	var value [16]byte
	if _, err := io.ReadFull(secrets.reader, value[6:]); err != nil {
		return "", ErrInvalidCryptoInput
	}
	value[0] = byte(milliseconds >> 40)
	value[1] = byte(milliseconds >> 32)
	value[2] = byte(milliseconds >> 24)
	value[3] = byte(milliseconds >> 16)
	value[4] = byte(milliseconds >> 8)
	value[5] = byte(milliseconds)
	value[6] = (value[6] & 0x0f) | 0x70
	value[8] = (value[8] & 0x3f) | 0x80
	return fmt.Sprintf(
		"%08x-%04x-%04x-%04x-%012x",
		value[0:4], value[4:6], value[6:8], value[8:10], value[10:16],
	), nil
}

func (secrets *Secrets) CreateCode(context.Context) (string, error) {
	if secrets == nil || secrets.reader == nil {
		return "", ErrInvalidCryptoInput
	}
	limit := uint64(1<<32) - uint64(1<<32)%otpCodeSpace
	var buffer [4]byte
	for {
		if _, err := io.ReadFull(secrets.reader, buffer[:]); err != nil {
			return "", ErrInvalidCryptoInput
		}
		value := uint64(binary.BigEndian.Uint32(buffer[:]))
		if value < limit {
			return fmt.Sprintf("%08d", value%otpCodeSpace), nil
		}
	}
}

func (secrets *Secrets) CreateSalt(context.Context) (string, error) {
	if secrets == nil || secrets.reader == nil {
		return "", ErrInvalidCryptoInput
	}
	buffer := make([]byte, 32)
	if _, err := io.ReadFull(secrets.reader, buffer); err != nil {
		return "", ErrInvalidCryptoInput
	}
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}
