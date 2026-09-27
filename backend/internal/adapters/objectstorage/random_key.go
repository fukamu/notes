package objectstorage

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"io"
)

var ErrObjectKeyGeneration = errors.New("opaque object key generation failed")

type RandomObjectKeyGenerator struct {
	reader io.Reader
}

func NewRandomObjectKeyGenerator() *RandomObjectKeyGenerator {
	return &RandomObjectKeyGenerator{reader: rand.Reader}
}

func (generator *RandomObjectKeyGenerator) CreateObjectKey(context.Context) (string, error) {
	if generator == nil || generator.reader == nil {
		return "", ErrObjectKeyGeneration
	}
	value := make([]byte, 32)
	if _, err := io.ReadFull(generator.reader, value); err != nil {
		return "", ErrObjectKeyGeneration
	}
	return "obj_v1_" + base64.RawURLEncoding.EncodeToString(value), nil
}
