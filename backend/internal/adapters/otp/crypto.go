package otpadapter

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"strings"

	"github.com/fukamu/notes/backend/internal/identity"
)

var ErrInvalidCryptoInput = errors.New("invalid Email OTP cryptographic input")

var (
	_ identity.EmailOtpHasherPort   = (*Hasher)(nil)
	_ identity.EmailOtpAbuseKeyPort = (*AbuseKeyDeriver)(nil)
)

type Hasher struct {
	pepper []byte
}

func NewHasher(pepper []byte) (*Hasher, error) {
	if len(pepper) < 32 || len(pepper) > 1_024 {
		return nil, ErrInvalidCryptoInput
	}
	return &Hasher{pepper: append([]byte(nil), pepper...)}, nil
}

func (hasher *Hasher) CreateDigest(_ context.Context, input identity.EmailOtpHashInput) (string, error) {
	if hasher == nil || len(hasher.pepper) < 32 || !validHashInput(input) {
		return "", ErrInvalidCryptoInput
	}
	mac := hmac.New(sha256.New, hasher.pepper)
	writeFrame(mac, "fukamu-email-otp-hmac-sha256/v1")
	writeFrame(mac, string(input.ChallengeID))
	writeFrame(mac, string(input.Address))
	writeFrame(mac, string(input.Salt))
	writeFrame(mac, string(input.Code))
	digest, err := identity.ParseEmailOtpDigest(base64.RawURLEncoding.EncodeToString(mac.Sum(nil)))
	if err != nil {
		return "", ErrInvalidCryptoInput
	}
	return string(digest), nil
}

func (hasher *Hasher) MatchesDigest(
	ctx context.Context,
	input identity.EmailOtpHashInput,
	expected identity.EmailOtpDigest,
) (bool, error) {
	if _, err := identity.ParseEmailOtpDigest(string(expected)); err != nil {
		return false, ErrInvalidCryptoInput
	}
	candidate, err := hasher.CreateDigest(ctx, input)
	if err != nil {
		return false, err
	}
	left, leftErr := base64.RawURLEncoding.DecodeString(string(candidate))
	right, rightErr := base64.RawURLEncoding.DecodeString(string(expected))
	if leftErr != nil || rightErr != nil || len(left) != sha256.Size || len(right) != sha256.Size {
		return false, ErrInvalidCryptoInput
	}
	return hmac.Equal(left, right), nil
}

func validHashInput(input identity.EmailOtpHashInput) bool {
	if _, err := identity.ParseEmailOtpChallengeID(string(input.ChallengeID)); err != nil {
		return false
	}
	if _, err := identity.ParseEmailOtpAddress(string(input.Address)); err != nil {
		return false
	}
	if _, err := identity.ParseEmailOtpCode(string(input.Code)); err != nil {
		return false
	}
	_, err := identity.ParseEmailOtpSalt(string(input.Salt))
	return err == nil
}

type framedWriter interface {
	Write([]byte) (int, error)
}

func writeFrame(writer framedWriter, value string) {
	var length [4]byte
	binary.BigEndian.PutUint32(length[:], uint32(len(value)))
	_, _ = writer.Write(length[:])
	_, _ = writer.Write([]byte(value))
}

type AbuseKeys = identity.EmailOtpRateLimitKeys

type AbuseKeyDeriver struct {
	pepper []byte
}

func NewAbuseKeyDeriver(pepper []byte) (*AbuseKeyDeriver, error) {
	if len(pepper) < 32 || len(pepper) > 1_024 {
		return nil, ErrInvalidCryptoInput
	}
	return &AbuseKeyDeriver{pepper: append([]byte(nil), pepper...)}, nil
}

func (deriver *AbuseKeyDeriver) Derive(
	address identity.EmailOtpAddress,
	trustedNetworkScope string,
	accountID *identity.AccountID,
) (AbuseKeys, error) {
	if deriver == nil || len(deriver.pepper) < 32 ||
		len(trustedNetworkScope) < 1 || len(trustedNetworkScope) > 1_024 ||
		strings.TrimSpace(trustedNetworkScope) != trustedNetworkScope {
		return AbuseKeys{}, ErrInvalidCryptoInput
	}
	if _, err := identity.ParseEmailOtpAddress(string(address)); err != nil {
		return AbuseKeys{}, ErrInvalidCryptoInput
	}
	if accountID != nil {
		if _, err := identity.ParseAccountID(string(*accountID)); err != nil {
			return AbuseKeys{}, ErrInvalidCryptoInput
		}
	}
	addressKey, err := deriver.key("address", string(address))
	if err != nil {
		return AbuseKeys{}, err
	}
	networkKey, err := deriver.key("network", trustedNetworkScope)
	if err != nil {
		return AbuseKeys{}, err
	}
	keys := AbuseKeys{Address: addressKey, Network: networkKey}
	if accountID != nil {
		accountKey, keyErr := deriver.key("account", string(*accountID))
		if keyErr != nil {
			return AbuseKeys{}, keyErr
		}
		keys.Account = &accountKey
	}
	return keys, nil
}

func (deriver *AbuseKeyDeriver) DeriveKeys(
	_ context.Context,
	address identity.EmailOtpAddress,
	trustedNetworkScope string,
	accountID *identity.AccountID,
) (identity.EmailOtpRateLimitKeys, error) {
	return deriver.Derive(address, trustedNetworkScope, accountID)
}

func (deriver *AbuseKeyDeriver) key(kind string, value string) (identity.EmailOtpRateLimitKey, error) {
	mac := hmac.New(sha256.New, deriver.pepper)
	writeFrame(mac, "fukamu-email-otp-abuse-key/v1")
	writeFrame(mac, kind)
	writeFrame(mac, value)
	key, err := identity.ParseEmailOtpRateLimitKey(base64.RawURLEncoding.EncodeToString(mac.Sum(nil)))
	if err != nil {
		return "", ErrInvalidCryptoInput
	}
	return key, nil
}
