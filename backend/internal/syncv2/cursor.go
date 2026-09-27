package syncv2

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"strings"

	"github.com/fukamu/notes/backend/internal/identity"
)

type CursorClaims struct {
	Version       string           `json:"version"`
	VaultID       identity.VaultID `json:"vaultId"`
	DeviceID      DeviceID         `json:"deviceId"`
	AfterSequence Sequence         `json:"afterSequence"`
	HighWatermark Sequence         `json:"highWatermark"`
}

type CursorAuthenticator struct {
	secret []byte
}

func NewCursorAuthenticator(secret []byte) (*CursorAuthenticator, error) {
	if len(secret) < MinimumCursorSecretBytes || len(secret) > MaximumCursorSecretBytes {
		return nil, ErrInvalidCursor
	}
	return &CursorAuthenticator{secret: append([]byte(nil), secret...)}, nil
}

func (authenticator *CursorAuthenticator) Issue(claims CursorClaims) (Cursor, error) {
	if authenticator == nil || !validCursorClaims(claims) {
		return "", ErrInvalidCursor
	}
	payloadBytes, err := marshalCanonical(claims)
	if err != nil {
		return "", ErrInvalidCursor
	}
	payload := base64.RawURLEncoding.EncodeToString(payloadBytes)
	signature := authenticator.sign(payload)
	token := Cursor(payload + "." + base64.RawURLEncoding.EncodeToString(signature))
	if !validCursor(token) {
		return "", ErrInvalidCursor
	}
	return token, nil
}

func (authenticator *CursorAuthenticator) Verify(cursor Cursor) (CursorClaims, error) {
	if authenticator == nil || !validCursor(cursor) {
		return CursorClaims{}, ErrInvalidCursor
	}
	parts := strings.Split(string(cursor), ".")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return CursorClaims{}, ErrInvalidCursor
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || len(signature) != sha256.Size || !hmac.Equal(signature, authenticator.sign(parts[0])) {
		return CursorClaims{}, ErrInvalidCursor
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return CursorClaims{}, ErrInvalidCursor
	}
	fields, err := decodeJSONObject(payload, ErrInvalidCursor)
	if err != nil || !hasExactJSONKeys(
		fields, "version", "vaultId", "deviceId", "afterSequence", "highWatermark",
	) {
		return CursorClaims{}, ErrInvalidCursor
	}
	version, err := decodeBoundedJSONString(fields["version"], len(CursorVersion), ErrInvalidCursor)
	if err != nil || version != CursorVersion {
		return CursorClaims{}, ErrInvalidCursor
	}
	vaultValue, err := decodeBoundedJSONString(fields["vaultId"], 36, ErrInvalidCursor)
	if err != nil {
		return CursorClaims{}, ErrInvalidCursor
	}
	vaultID, err := identity.ParseVaultID(vaultValue)
	if err != nil {
		return CursorClaims{}, ErrInvalidCursor
	}
	deviceValue, err := decodeBoundedJSONString(fields["deviceId"], 36, ErrInvalidCursor)
	if err != nil {
		return CursorClaims{}, ErrInvalidCursor
	}
	deviceID, err := ParseDeviceID(deviceValue)
	if err != nil {
		return CursorClaims{}, ErrInvalidCursor
	}
	afterValue, err := decodeSafeJSONInteger(fields["afterSequence"], false, ErrInvalidCursor)
	if err != nil {
		return CursorClaims{}, ErrInvalidCursor
	}
	after, err := ParseSequence(afterValue)
	if err != nil {
		return CursorClaims{}, ErrInvalidCursor
	}
	highValue, err := decodeSafeJSONInteger(fields["highWatermark"], false, ErrInvalidCursor)
	if err != nil {
		return CursorClaims{}, ErrInvalidCursor
	}
	high, err := ParseSequence(highValue)
	if err != nil {
		return CursorClaims{}, ErrInvalidCursor
	}
	claims := CursorClaims{
		Version: version, VaultID: vaultID, DeviceID: deviceID,
		AfterSequence: after, HighWatermark: high,
	}
	if !validCursorClaims(claims) {
		return CursorClaims{}, ErrInvalidCursor
	}
	return claims, nil
}

func (authenticator *CursorAuthenticator) sign(payload string) []byte {
	digest := hmac.New(sha256.New, authenticator.secret)
	_, _ = digest.Write([]byte(payload))
	return digest.Sum(nil)
}

func validCursorClaims(claims CursorClaims) bool {
	if claims.Version != CursorVersion || claims.AfterSequence > claims.HighWatermark {
		return false
	}
	if _, err := identity.ParseVaultID(string(claims.VaultID)); err != nil {
		return false
	}
	if _, err := ParseDeviceID(string(claims.DeviceID)); err != nil {
		return false
	}
	if _, err := ParseSequence(int64(claims.AfterSequence)); err != nil {
		return false
	}
	if _, err := ParseSequence(int64(claims.HighWatermark)); err != nil {
		return false
	}
	return true
}
