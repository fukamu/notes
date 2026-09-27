package accountdeletion

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestSharedAccountDeletionFixture(t *testing.T) {
	content, err := os.ReadFile(filepath.Join("..", "..", "..", "contracts", "fixtures", "account", "lifecycle.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Deletion struct {
			InProgress      json.RawMessage `json:"inProgress"`
			RetryWait       json.RawMessage `json:"retryWait"`
			Failed          json.RawMessage `json:"failed"`
			Terminal        json.RawMessage `json:"terminal"`
			InvalidTerminal json.RawMessage `json:"invalidTerminal"`
		} `json:"deletion"`
	}
	if err := json.Unmarshal(content, &fixture); err != nil {
		t.Fatal(err)
	}
	for name, candidate := range map[string]json.RawMessage{
		"in-progress": fixture.Deletion.InProgress,
		"retry-wait":  fixture.Deletion.RetryWait,
		"failed":      fixture.Deletion.Failed,
		"completed":   fixture.Deletion.Terminal,
	} {
		response, err := DecodePublicResponse(candidate)
		if err != nil || string(response.Status) != name {
			t.Fatalf("%s response = %#v, %v", name, response, err)
		}
		encoded, err := EncodePublicResponse(response)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := DecodePublicResponse(encoded); err != nil {
			t.Fatalf("%s round trip: %v", name, err)
		}
	}
	if _, err := DecodePublicResponse(fixture.Deletion.InvalidTerminal); err == nil {
		t.Fatal("terminal deletion response with continuation token was accepted")
	}
}
