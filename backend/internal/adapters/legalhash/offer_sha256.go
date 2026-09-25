package legalhash

import (
	"context"
	"crypto/sha256"
	"encoding/hex"

	"github.com/fukamu/notes/backend/internal/legal"
)

type OfferSHA256Hasher struct{}

var _ legal.ContractOfferHasher = OfferSHA256Hasher{}

func (OfferSHA256Hasher) Hash(_ context.Context, serialized string) (legal.ContractOfferHash, error) {
	digest := sha256.Sum256([]byte(serialized))
	return legal.ParseContractOfferHash("sha256:" + hex.EncodeToString(digest[:]))
}
