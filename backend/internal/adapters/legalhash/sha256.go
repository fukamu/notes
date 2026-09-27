package legalhash

import (
	"context"
	"crypto/sha256"
	"encoding/hex"

	"github.com/fukamu/notes/backend/internal/legal"
)

type SHA256Hasher struct{}

var _ legal.TermsDocumentHasher = SHA256Hasher{}

func (SHA256Hasher) Hash(_ context.Context, serialized string) (legal.TermsDocumentHash, error) {
	digest := sha256.Sum256([]byte(serialized))
	return legal.ParseTermsDocumentHash("sha256:" + hex.EncodeToString(digest[:]))
}
