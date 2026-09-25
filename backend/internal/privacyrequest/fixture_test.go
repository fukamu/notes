package privacyrequest

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestSharedPrivacyRequestFixture(t *testing.T) {
	content, err := os.ReadFile(filepath.Join("..", "..", "..", "contracts", "fixtures", "account", "lifecycle.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Privacy struct {
			Submit         json.RawMessage   `json:"submit"`
			StatusCommand  json.RawMessage   `json:"statusCommand"`
			PublicStatuses []json.RawMessage `json:"publicStatuses"`
			Invalid        json.RawMessage   `json:"invalid"`
		} `json:"privacy"`
	}
	if err := json.Unmarshal(content, &fixture); err != nil {
		t.Fatal(err)
	}
	if command, err := DecodeSubmitCommand(fixture.Privacy.Submit); err != nil || command.RequestKind != KindDisclosure {
		t.Fatalf("submit fixture = %#v, %v", command, err)
	}
	if command, err := DecodeStatusCommand(fixture.Privacy.StatusCommand); err != nil || command.RequestID == "" {
		t.Fatalf("status fixture = %#v, %v", command, err)
	}
	if len(fixture.Privacy.PublicStatuses) != 7 {
		t.Fatalf("public status fixture count = %d", len(fixture.Privacy.PublicStatuses))
	}
	for _, candidate := range fixture.Privacy.PublicStatuses {
		status, err := DecodePublicStatus(candidate)
		if err != nil {
			t.Fatalf("DecodePublicStatus(%s): %v", candidate, err)
		}
		encoded, err := EncodePublicStatus(status)
		if err != nil {
			t.Fatal(err)
		}
		redecoded, err := DecodePublicStatus(encoded)
		if err != nil || publicStatusMismatch(status, redecoded) {
			t.Fatalf("public status round trip = %#v, %#v, %v", status, redecoded, err)
		}
	}
	if _, err := DecodePublicStatus(fixture.Privacy.Invalid); err == nil {
		t.Fatal("privacy response containing owner data was accepted")
	}
}

func publicStatusMismatch(left PublicStatus, right PublicStatus) bool {
	if left.RequestID != right.RequestID || left.RequestKind != right.RequestKind ||
		left.RequestedAt != right.RequestedAt || left.UpdatedAt != right.UpdatedAt ||
		left.Status != right.Status || left.Outcome != right.Outcome {
		return true
	}
	if left.Retryable == nil || right.Retryable == nil {
		return left.Retryable != nil || right.Retryable != nil
	}
	return *left.Retryable != *right.Retryable
}
