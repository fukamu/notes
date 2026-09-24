package synclegacy_test

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/fukamu/notes/backend/internal/synclegacy"
)

func TestDecodeCapturedLegacyRequest(t *testing.T) {
	t.Parallel()
	fixture := readFixtureObject(t, "../../../contracts/fixtures/sync/legacy-v1.json")
	request, err := synclegacy.DecodeRequest(fixture["request"])
	if err != nil {
		t.Fatalf("DecodeRequest() error = %v", err)
	}
	if request.DeviceID != "01991f20-61d2-7000-8000-000000000004" || len(request.Mutations) != 1 {
		t.Fatalf("request = %#v", request)
	}
	mutation := request.Mutations[0]
	if mutation.Kind != synclegacy.MutationUpsert || mutation.Title != "固定カードA <>&  😀" ||
		len(mutation.Body) != 3 || mutation.Body[1].TargetCardID != "01991f20-61d2-7000-8000-000000000002" {
		t.Fatalf("mutation = %#v", mutation)
	}
}

func TestDecodeRejectsCapturedAndAmbiguousRequests(t *testing.T) {
	t.Parallel()
	content, err := os.ReadFile("../../../contracts/fixtures/sync/rejections.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Cases []struct {
			Name  string          `json:"name"`
			Input json.RawMessage `json:"input"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(content, &fixture); err != nil {
		t.Fatal(err)
	}
	cases := map[string][]byte{
		"duplicate root":   []byte(`{"deviceId":"01991f20-61d2-7000-8000-000000000004","mutations":[],"mutations":[]}`),
		"duplicate nested": []byte(`{"deviceId":"01991f20-61d2-7000-8000-000000000004","mutations":[{"mutationId":"01991f20-61d2-7000-8000-000000000005","cardId":"01991f20-61d2-7000-8000-000000000001","baseServerRevision":null,"title":"a","title":"b","body":[],"createdAt":0,"updatedAt":0,"kind":"upsert","conflictIds":[]}]}`),
		"invalid utf8": append(
			[]byte(`{"deviceId":"01991f20-61d2-7000-8000-000000000004","mutations":[],"extra":"`),
			0xff,
		),
		"trailing": []byte(`{"deviceId":"01991f20-61d2-7000-8000-000000000004","mutations":[]} true`),
	}
	for _, testCase := range fixture.Cases {
		cases[testCase.Name] = testCase.Input
	}
	for name, candidate := range cases {
		name, candidate := name, candidate
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if _, err := synclegacy.DecodeRequest(candidate); !errors.Is(err, synclegacy.ErrInvalidRequest) {
				t.Fatalf("DecodeRequest() error = %v", err)
			}
		})
	}
}

func TestDecodeUsesJavaScriptSafeIntegerAndUTF16Limits(t *testing.T) {
	t.Parallel()
	valid := validRequestJSON("1e3", strings.Repeat("😀", synclegacy.MaximumTitleLength/2))
	if _, err := synclegacy.DecodeRequest([]byte(valid)); err != nil {
		t.Fatalf("safe exponent/UTF-16 boundary rejected: %v", err)
	}
	validEscapedPair := strings.Replace(
		validRequestJSON("1", "title"),
		`"title":"title"`,
		`"title":"\ud83d\ude00"`,
		1,
	)
	if _, err := synclegacy.DecodeRequest([]byte(validEscapedPair)); err != nil {
		t.Fatalf("valid escaped surrogate pair rejected: %v", err)
	}
	for name, candidate := range map[string]string{
		"unsafe integer": validRequestJSON("9007199254740992", "title"),
		"fraction":       validRequestJSON("1.5", "title"),
		"UTF-16 over":    validRequestJSON("1", strings.Repeat("😀", synclegacy.MaximumTitleLength/2+1)),
		"unpaired surrogate": strings.Replace(
			validRequestJSON("1", "title"),
			`"title":"title"`,
			`"title":"\ud800"`,
			1,
		),
	} {
		name, candidate := name, candidate
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if _, err := synclegacy.DecodeRequest([]byte(candidate)); !errors.Is(err, synclegacy.ErrInvalidRequest) {
				t.Fatalf("DecodeRequest() error = %v", err)
			}
		})
	}
}

func TestValidateResponseRejectsDuplicateAndMissingReferences(t *testing.T) {
	t.Parallel()
	cardID := synclegacy.CardID("01991f20-61d2-7000-8000-000000000001")
	mutationID := synclegacy.MutationID("01991f20-61d2-7000-8000-000000000005")
	response := synclegacy.Response{
		Cards: []synclegacy.Card{{
			ID: cardID, OfficialDisplayID: 1, Title: "card", Body: []synclegacy.BodySegment{},
			CreatedAt: 1, UpdatedAt: 1, Revision: 1,
		}},
		Conflicts:               []synclegacy.Conflict{},
		AcknowledgedMutationIDs: []synclegacy.MutationID{mutationID},
	}
	sent := []synclegacy.Mutation{{MutationID: mutationID}}
	if err := synclegacy.ValidateResponse(response, sent); err != nil {
		t.Fatalf("ValidateResponse() error = %v", err)
	}
	duplicate := response
	duplicate.Cards = append(append([]synclegacy.Card(nil), response.Cards...), response.Cards[0])
	if err := synclegacy.ValidateResponse(duplicate, sent); !errors.Is(err, synclegacy.ErrInvalidState) {
		t.Fatalf("duplicate error = %v", err)
	}
	missingLink := response
	missingLink.Cards = append([]synclegacy.Card(nil), response.Cards...)
	missingLink.Cards[0].Body = []synclegacy.BodySegment{{
		Kind: synclegacy.SegmentLink, TargetCardID: "01991f20-61d2-7000-8000-000000000099",
	}}
	if err := synclegacy.ValidateResponse(missingLink, sent); !errors.Is(err, synclegacy.ErrInvalidState) {
		t.Fatalf("missing link error = %v", err)
	}
	nilCollections := response
	nilCollections.Conflicts = nil
	if err := synclegacy.ValidateResponse(nilCollections, sent); !errors.Is(err, synclegacy.ErrInvalidState) {
		t.Fatalf("nil collection error = %v", err)
	}
	if _, err := synclegacy.DecodeStoredMutationID("not-a-mutation-id"); !errors.Is(
		err,
		synclegacy.ErrInvalidState,
	) {
		t.Fatalf("stored mutation ID error = %v", err)
	}
}

func TestEncodeBodyMatchesJavaScriptLineSeparatorEncoding(t *testing.T) {
	t.Parallel()
	encoded, err := synclegacy.EncodeBody([]synclegacy.BodySegment{{
		Kind: synclegacy.SegmentText,
		Text: "<>&\u2028\u2029😀",
	}})
	if err != nil {
		t.Fatal(err)
	}
	if encoded != "[{\"type\":\"text\",\"text\":\"<>&\u2028\u2029😀\"}]" {
		t.Fatalf("encoded body = %q", encoded)
	}
	literalEscape, err := synclegacy.EncodeBody([]synclegacy.BodySegment{{
		Kind: synclegacy.SegmentText,
		Text: `\u2028`,
	}})
	if err != nil {
		t.Fatal(err)
	}
	if literalEscape != `[{"type":"text","text":"\\u2028"}]` {
		t.Fatalf("literal escape body = %q", literalEscape)
	}
}

func validRequestJSON(createdAt string, title string) string {
	encodedTitle, _ := json.Marshal(title)
	return `{"deviceId":"01991f20-61d2-7000-8000-000000000004","mutations":[{` +
		`"mutationId":"01991f20-61d2-7000-8000-000000000005",` +
		`"cardId":"01991f20-61d2-7000-8000-000000000001",` +
		`"baseServerRevision":null,"title":` + string(encodedTitle) + `,"body":[],` +
		`"createdAt":` + createdAt + `,"updatedAt":1000,"kind":"upsert","conflictIds":[]}]}`
}

func readFixtureObject(t *testing.T, path string) map[string]json.RawMessage {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]json.RawMessage
	if err := json.Unmarshal(content, &value); err != nil {
		t.Fatal(err)
	}
	return value
}
