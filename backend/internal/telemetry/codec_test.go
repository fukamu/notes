package telemetry_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/fukamu/notes/backend/internal/telemetry"
)

const securityCorpusMarker = "security-corpus-sensitive-marker"

func TestDecodeEventJSONAcceptsOnlyExactBoundedEvents(t *testing.T) {
	t.Parallel()
	content := []byte(`{
		"schemaVersion": 1.0,
		"operation": "sync-v2",
		"outcome": "failure",
		"failureCategory": "dependency",
		"durationBucket": "100-999ms",
		"workItemsBucket": "11-100"
	}`)
	event, err := telemetry.DecodeEventJSON(content)
	if err != nil {
		t.Fatal(err)
	}
	if event.SchemaVersion() != 1 || event.Operation() != telemetry.OperationSyncV2 ||
		event.Outcome() != telemetry.OutcomeFailure || event.FailureCategory() != telemetry.FailureDependency ||
		event.DurationBucket() != telemetry.Duration100To999MS || event.WorkItemsBucket() != telemetry.Count11To100 {
		t.Fatalf("decoded event = %#v", event)
	}
}

func TestDecodeEventJSONRejectsMalformedSensitiveAndHighCardinalityValues(t *testing.T) {
	t.Parallel()
	valid := `"schemaVersion":1,"operation":"sync-v2","outcome":"failure","failureCategory":"dependency","durationBucket":"not-measured","workItemsBucket":"zero"`
	cases := []struct {
		name    string
		content []byte
	}{
		{name: "null", content: []byte(`null`)},
		{name: "boolean", content: []byte(`true`)},
		{name: "negative-number", content: []byte(`-1`)},
		{name: "fraction", content: []byte(`1.5`)},
		{name: "array", content: []byte(`["` + securityCorpusMarker + `"]`)},
		{name: "empty-object", content: []byte(`{}`)},
		{name: "unknown-field", content: []byte(`{"unexpected":"` + securityCorpusMarker + `"}`)},
		{name: "nested-object", content: []byte(`{"value":{"nested":{"marker":"` + securityCorpusMarker + `"}}}`)},
		{name: "oversized-string", content: []byte(`"` + strings.Repeat(securityCorpusMarker, 1_025) + `"`)},
		{name: "arbitrary-operation", content: []byte(`{` + strings.Replace(valid, `"sync-v2"`, `"`+securityCorpusMarker+`"`, 1) + `}`)},
		{name: "raw-vault-id", content: []byte(`{` + valid + `,"vaultId":"01991f20-61d2-7000-8000-000000000001"}`)},
		{name: "content-title", content: []byte(`{` + valid + `,"title":"` + securityCorpusMarker + `"}`)},
		{name: "content-body", content: []byte(`{` + valid + `,"body":"` + securityCorpusMarker + `"}`)},
		{name: "secret-token", content: []byte(`{` + valid + `,"token":"` + securityCorpusMarker + `"}`)},
		{name: "incoherent-success", content: []byte(`{` + strings.Replace(strings.Replace(valid, `"failure"`, `"success"`, 1), `"dependency"`, `"internal"`, 1) + `}`)},
		{name: "incoherent-failure", content: []byte(`{` + strings.Replace(valid, `"dependency"`, `"none"`, 1) + `}`)},
		{name: "duplicate", content: []byte(`{` + valid + `,"operation":"sync-v2"}`)},
		{name: "missing", content: []byte(`{"schemaVersion":1,"operation":"sync-v2"}`)},
		{name: "schema-version", content: []byte(`{` + strings.Replace(valid, `"schemaVersion":1`, `"schemaVersion":2`, 1) + `}`)},
		{name: "schema-fraction", content: []byte(`{` + strings.Replace(valid, `"schemaVersion":1`, `"schemaVersion":1.5`, 1) + `}`)},
		{name: "wrong-type", content: []byte(`{` + strings.Replace(valid, `"workItemsBucket":"zero"`, `"workItemsBucket":0`, 1) + `}`)},
		{name: "trailing-value", content: []byte(`{` + valid + `}{}`)},
		{name: "unpaired-surrogate", content: []byte(`{` + strings.Replace(valid, `"sync-v2"`, `"\ud800"`, 1) + `}`)},
		{name: "invalid-utf8", content: append([]byte(`{`+valid+`,"x":"`), 0xff, '"', '}')},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			_, err := telemetry.DecodeEventJSON(test.content)
			if !errors.Is(err, telemetry.ErrInvalidEvent) {
				t.Fatalf("error = %v, want ErrInvalidEvent", err)
			}
			if strings.Contains(err.Error(), securityCorpusMarker) || strings.Contains(err.Error(), "01991f20") {
				t.Fatalf("error reflected rejected content: %v", err)
			}
		})
	}
}

func TestDecodeEventJSONEnforcesBoundedInput(t *testing.T) {
	t.Parallel()
	content := []byte(`{"schemaVersion":1,"operation":"sync-v2","outcome":"success","failureCategory":"none","durationBucket":"not-measured","workItemsBucket":"zero"}`)
	padded := append(content, []byte(strings.Repeat(" ", telemetry.MaximumEventBytes))...)
	if _, err := telemetry.DecodeEventJSON(padded); !errors.Is(err, telemetry.ErrInvalidEvent) {
		t.Fatalf("oversized event error = %v", err)
	}
}
