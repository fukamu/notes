package stripebilling

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"
	"testing"
)

const testWebhookSecret = "whsec_abcdefghijklmnopqrstuv"

func TestHMACWebhookVerifierAcceptsExactRawBodyAndRotatedSignature(t *testing.T) {
	verifier, err := NewHMACWebhookVerifier(testWebhookSecret, WebhookToleranceMillis)
	if err != nil {
		t.Fatal(err)
	}
	body := []byte(`{"id":"evt_signature_A"}`)
	valid := signWebhook(1_000, body, testWebhookSecret)
	result := verifier.Verify(WebhookRequest{
		RawBody: body, SignatureHeader: "t=1000,v1=" + strings.Repeat("0", 64) + ",v1=" + valid, ReceivedAt: 1_000_000,
	})
	if !result.Verified || string(result.RawBody) != string(body) {
		t.Fatalf("verification = %#v", result)
	}
	body[0] = '['
	if string(result.RawBody) != `{"id":"evt_signature_A"}` {
		t.Fatal("verified body aliases caller-owned bytes")
	}
}

func TestHMACWebhookVerifierRejectsTamperingSecretAndRecency(t *testing.T) {
	body := []byte(`{"id":"evt_signature_A"}`)
	valid := signWebhook(1_000, body, testWebhookSecret)
	verifier, _ := NewHMACWebhookVerifier(testWebhookSecret, WebhookToleranceMillis)
	tampered := append([]byte(nil), body...)
	tampered[2] = 'x'
	cases := []WebhookRequest{
		{RawBody: tampered, SignatureHeader: "t=1000,v1=" + valid, ReceivedAt: 1_000_000},
		{RawBody: body, SignatureHeader: "t=1000,v1=" + valid, ReceivedAt: 1_300_001},
		{RawBody: body, SignatureHeader: "t=1301,v1=" + signWebhook(1_301, body, testWebhookSecret), ReceivedAt: 1_000_000},
		{RawBody: make([]byte, MaxWebhookBytes+1), SignatureHeader: "t=1000,v1=" + valid, ReceivedAt: 1_000_000},
	}
	for index, input := range cases {
		if verifier.Verify(input).Verified {
			t.Fatalf("case %d accepted", index)
		}
	}
	other, _ := NewHMACWebhookVerifier("whsec_zyxwvutsrqponmlkjihgfedc", WebhookToleranceMillis)
	if other.Verify(WebhookRequest{RawBody: body, SignatureHeader: "t=1000,v1=" + valid, ReceivedAt: 1_000_000}).Verified {
		t.Fatal("wrong secret accepted")
	}
}

func TestParseSignatureHeaderRejectsAmbiguityAndMalformedValues(t *testing.T) {
	cases := []string{
		"", "t=1,t=2,v1=" + strings.Repeat("0", 64), "t=1,v1=" + strings.Repeat("x", 64),
		"t=-1,v1=" + strings.Repeat("0", 64), "t=1,v1=" + strings.Repeat("A", 64), "t=1",
	}
	for _, value := range cases {
		if _, ok := ParseSignatureHeader(value); ok {
			t.Fatalf("accepted %q", value)
		}
	}
	if _, err := NewHMACWebhookVerifier(testWebhookSecret, 0); err == nil {
		t.Fatal("disabled recency check accepted")
	}
}

func signWebhook(timestamp int64, body []byte, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(strconv.FormatInt(timestamp, 10) + "."))
	_, _ = mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}
