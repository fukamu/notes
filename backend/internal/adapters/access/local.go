package access

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"time"
	"unicode/utf8"

	accesscore "github.com/fukamu/notes/backend/internal/access"
)

const (
	LocalAssertionHeader = "X-Fukamu-Local-Identity-Assertion"
	LegacySitesHeader    = "Oai-Authenticated-User-Id"
	maximumAssertionSize = 8_192
	maximumLifetime      = 10 * time.Minute
	maximumClockSkew     = 30 * time.Second
)

var ErrInvalidAssertion = errors.New("invalid signed identity assertion")

type LocalVerifier struct {
	publicKey ed25519.PublicKey
	issuer    string
	audience  string
}

type tokenHeader struct {
	Algorithm string `json:"alg"`
	Type      string `json:"typ"`
}

type tokenClaims struct {
	Issuer    string `json:"iss"`
	Audience  string `json:"aud"`
	Subject   string `json:"sub"`
	IssuedAt  int64  `json:"iat"`
	ExpiresAt int64  `json:"exp"`
}

func NewLocalVerifier(publicKey ed25519.PublicKey, issuer string, audience string) (*LocalVerifier, error) {
	if len(publicKey) != ed25519.PublicKeySize || issuer == "" || audience == "" {
		return nil, ErrInvalidAssertion
	}
	return &LocalVerifier{
		publicKey: append(ed25519.PublicKey(nil), publicKey...),
		issuer:    issuer,
		audience:  audience,
	}, nil
}

func (verifier *LocalVerifier) Verify(assertion string, now time.Time) (accesscore.Subject, error) {
	if verifier == nil || len(assertion) < 1 || len(assertion) > maximumAssertionSize {
		return "", ErrInvalidAssertion
	}
	segments := strings.Split(assertion, ".")
	if len(segments) != 3 {
		return "", ErrInvalidAssertion
	}
	headerBytes, err := decodeSegment(segments[0])
	if err != nil {
		return "", ErrInvalidAssertion
	}
	payloadBytes, err := decodeSegment(segments[1])
	if err != nil {
		return "", ErrInvalidAssertion
	}
	signature, err := decodeSegment(segments[2])
	if err != nil || len(signature) != ed25519.SignatureSize {
		return "", ErrInvalidAssertion
	}
	if !ed25519.Verify(verifier.publicKey, []byte(segments[0]+"."+segments[1]), signature) {
		return "", ErrInvalidAssertion
	}

	var header tokenHeader
	if err := decodeExactObject(headerBytes, []string{"alg", "typ"}, &header); err != nil ||
		header.Algorithm != "EdDSA" || header.Type != "JWT" {
		return "", ErrInvalidAssertion
	}
	var claims tokenClaims
	if err := decodeExactObject(payloadBytes, []string{"aud", "exp", "iat", "iss", "sub"}, &claims); err != nil {
		return "", ErrInvalidAssertion
	}
	if claims.Issuer != verifier.issuer || claims.Audience != verifier.audience {
		return "", ErrInvalidAssertion
	}
	issuedAt := time.Unix(claims.IssuedAt, 0)
	expiresAt := time.Unix(claims.ExpiresAt, 0)
	if expiresAt.Sub(issuedAt) <= 0 || expiresAt.Sub(issuedAt) > maximumLifetime ||
		issuedAt.After(now.Add(maximumClockSkew)) || !expiresAt.After(now) {
		return "", ErrInvalidAssertion
	}
	subject, err := accesscore.ParseSubject(claims.Subject)
	if err != nil {
		return "", ErrInvalidAssertion
	}
	return subject, nil
}

func SignLocalAssertion(
	privateKey ed25519.PrivateKey,
	issuer string,
	audience string,
	subject accesscore.Subject,
	issuedAt time.Time,
	expiresAt time.Time,
) (string, error) {
	if len(privateKey) != ed25519.PrivateKeySize || issuer == "" || audience == "" || subject == "" ||
		expiresAt.Sub(issuedAt) <= 0 || expiresAt.Sub(issuedAt) > maximumLifetime {
		return "", ErrInvalidAssertion
	}
	header, err := json.Marshal(tokenHeader{Algorithm: "EdDSA", Type: "JWT"})
	if err != nil {
		return "", ErrInvalidAssertion
	}
	payload, err := json.Marshal(tokenClaims{
		Issuer:    issuer,
		Audience:  audience,
		Subject:   string(subject),
		IssuedAt:  issuedAt.Unix(),
		ExpiresAt: expiresAt.Unix(),
	})
	if err != nil {
		return "", ErrInvalidAssertion
	}
	unsigned := encodeSegment(header) + "." + encodeSegment(payload)
	signature := ed25519.Sign(privateKey, []byte(unsigned))
	return unsigned + "." + encodeSegment(signature), nil
}

func encodeSegment(value []byte) string {
	return base64.RawURLEncoding.EncodeToString(value)
}

func decodeSegment(value string) ([]byte, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || encodeSegment(decoded) != value {
		return nil, ErrInvalidAssertion
	}
	return decoded, nil
}

func decodeExactObject(content []byte, expectedKeys []string, destination any) error {
	if !utf8.Valid(content) {
		return ErrInvalidAssertion
	}
	decoder := json.NewDecoder(strings.NewReader(string(content)))
	opening, err := decoder.Token()
	if err != nil || opening != json.Delim('{') {
		return ErrInvalidAssertion
	}
	seen := make(map[string]json.RawMessage, len(expectedKeys))
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return ErrInvalidAssertion
		}
		key, ok := keyToken.(string)
		if !ok {
			return ErrInvalidAssertion
		}
		if _, duplicate := seen[key]; duplicate {
			return ErrInvalidAssertion
		}
		var raw json.RawMessage
		if err := decoder.Decode(&raw); err != nil {
			return ErrInvalidAssertion
		}
		seen[key] = raw
	}
	closing, err := decoder.Token()
	if err != nil || closing != json.Delim('}') {
		return ErrInvalidAssertion
	}
	if decoder.More() {
		return ErrInvalidAssertion
	}
	if len(seen) != len(expectedKeys) {
		return ErrInvalidAssertion
	}
	for _, key := range expectedKeys {
		if _, ok := seen[key]; !ok {
			return ErrInvalidAssertion
		}
	}
	strict := json.NewDecoder(strings.NewReader(string(content)))
	strict.DisallowUnknownFields()
	if err := strict.Decode(destination); err != nil {
		return ErrInvalidAssertion
	}
	if err := strict.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return ErrInvalidAssertion
	}
	return nil
}
