package stripebilling

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"
)

var ErrInvalidWebhookVerifier = errors.New("invalid Stripe webhook verifier configuration")

type HMACWebhookVerifier struct {
	secret      []byte
	toleranceMS int64
}

type SignatureHeader struct {
	TimestampSeconds int64
	V1Signatures     [][]byte
}

func NewHMACWebhookVerifier(secret string, toleranceMS int64) (*HMACWebhookVerifier, error) {
	if !validWebhookSecret(secret) || toleranceMS <= 0 || !validMillis(toleranceMS) {
		return nil, ErrInvalidWebhookVerifier
	}
	return &HMACWebhookVerifier{secret: []byte(secret), toleranceMS: toleranceMS}, nil
}

func (verifier *HMACWebhookVerifier) Verify(input WebhookRequest) VerificationResult {
	if verifier == nil || len(input.RawBody) == 0 || len(input.RawBody) > MaxWebhookBytes || !validMillis(input.ReceivedAt) {
		return VerificationResult{}
	}
	header, ok := ParseSignatureHeader(input.SignatureHeader)
	if !ok {
		return VerificationResult{}
	}
	timestampMS, ok := millisFromSeconds(header.TimestampSeconds)
	if !ok {
		return VerificationResult{}
	}
	difference := input.ReceivedAt - timestampMS
	if difference < 0 {
		difference = -difference
	}
	if difference > verifier.toleranceMS {
		return VerificationResult{}
	}
	body := append([]byte(nil), input.RawBody...)
	signed := make([]byte, 0, 24+len(body))
	signed = strconv.AppendInt(signed, header.TimestampSeconds, 10)
	signed = append(signed, '.')
	signed = append(signed, body...)
	mac := hmac.New(sha256.New, verifier.secret)
	_, _ = mac.Write(signed)
	expected := mac.Sum(nil)
	for _, signature := range header.V1Signatures {
		if hmac.Equal(expected, signature) {
			return VerificationResult{Verified: true, RawBody: body}
		}
	}
	return VerificationResult{}
}

func ParseSignatureHeader(input string) (SignatureHeader, bool) {
	if len(input) == 0 || len(input) > MaxSignatureHeader {
		return SignatureHeader{}, false
	}
	var timestamp *int64
	signatures := make([][]byte, 0, 2)
	for _, component := range strings.Split(input, ",") {
		separator := strings.IndexByte(component, '=')
		if separator <= 0 || separator == len(component)-1 {
			return SignatureHeader{}, false
		}
		name := component[:separator]
		value := component[separator+1:]
		switch name {
		case "t":
			if timestamp != nil || len(value) < 1 || len(value) > 16 || !decimalDigits(value) {
				return SignatureHeader{}, false
			}
			parsed, err := strconv.ParseInt(value, 10, 64)
			if err != nil || parsed < 0 {
				return SignatureHeader{}, false
			}
			timestamp = &parsed
		case "v1":
			if len(value) != sha256.Size*2 || value != strings.ToLower(value) {
				return SignatureHeader{}, false
			}
			decoded, err := hex.DecodeString(value)
			if err != nil || len(decoded) != sha256.Size {
				return SignatureHeader{}, false
			}
			signatures = append(signatures, decoded)
		}
	}
	if timestamp == nil || len(signatures) == 0 {
		return SignatureHeader{}, false
	}
	return SignatureHeader{TimestampSeconds: *timestamp, V1Signatures: signatures}, true
}

func decimalDigits(value string) bool {
	for index := range len(value) {
		if value[index] < '0' || value[index] > '9' {
			return false
		}
	}
	return true
}
