package syncv2_test

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/syncv2"
)

const (
	testDeviceID   = "01991f20-61d2-7000-8000-000000000004"
	testMutationID = "01991f20-61d2-7000-8000-000000000005"
	testCardID     = "01991f20-61d2-7000-8000-000000000001"
	testVaultID    = "01991f20-61d2-7000-8000-000000000201"
)

func TestSyncV2ProtocolStrictDecodeAndCanonicalContent(t *testing.T) {
	t.Parallel()
	valid := `{"version":"sync/v2","deviceId":"` + testDeviceID + `","cursor":null,"mutations":[{` +
		`"mutationId":"` + testMutationID + `","cardId":"` + testCardID + `","baseServerRevision":null,` +
		`"title":"<>&\u2028","body":[{"type":"text","text":"😀"},{"type":"link","targetCardId":"` + testCardID + `"}],` +
		`"createdAt":1e3,"updatedAt":1001,"kind":"upsert","conflictIds":[]}]}`
	request, err := syncv2.DecodeRequest([]byte(valid))
	if err != nil || len(request.Mutations) != 1 || request.Cursor != nil ||
		request.Mutations[0].Title != "<>&\u2028" || request.Mutations[0].CreatedAt != 1_000 {
		t.Fatalf("DecodeRequest() = %#v, %v", request, err)
	}
	canonical, err := syncv2.CanonicalizeMutation(request.Mutations[0])
	if err != nil {
		t.Fatal(err)
	}
	wantCanonical := `["fukamu-sync-v2-mutation/v1","upsert","` + testMutationID + `","` + testCardID +
		`",null,"<>&` + "\u2028" + `",[["text","😀"],["link","` + testCardID + `"]],1000,1001,[]]`
	if string(canonical) != wantCanonical {
		t.Fatalf("canonical = %s\nwant      = %s", canonical, wantCanonical)
	}
	fingerprint := syncv2.FingerprintCanonical(canonical)
	if _, err := syncv2.ParseFingerprint(string(fingerprint)); err != nil {
		t.Fatalf("fingerprint = %q: %v", fingerprint, err)
	}

	card := syncv2.StoredCard{
		Title: request.Mutations[0].Title, Body: request.Mutations[0].Body,
		CreatedAt: 1_000, UpdatedAt: 1_001,
	}
	encoded, err := syncv2.EncodeStoredCard(card)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `{"title":"<>&`+"\u2028"+`","body":[{"type":"text","text":"😀"},{"type":"link","targetCardId":"`+testCardID+`"}],"createdAt":1000,"updatedAt":1001}` {
		t.Fatalf("stored card = %s", encoded)
	}
	decoded, err := syncv2.DecodeStoredCard(encoded)
	if err != nil || decoded.Title != card.Title || len(decoded.Body) != 2 {
		t.Fatalf("stored round trip = %#v, %v", decoded, err)
	}
}

func TestSyncV2SharedClientFixture(t *testing.T) {
	t.Parallel()
	content, err := os.ReadFile("../../../contracts/fixtures/sync/v2.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Request  json.RawMessage `json:"request"`
		Response struct {
			Version       string          `json:"version"`
			HighWatermark syncv2.Sequence `json:"highWatermark"`
			Changes       []any           `json:"changes"`
			Receipts      []any           `json:"receipts"`
			Page          struct {
				Kind       syncv2.PageKind `json:"kind"`
				NextCursor syncv2.Cursor   `json:"nextCursor"`
			} `json:"page"`
		} `json:"response"`
	}
	if err := json.Unmarshal(content, &fixture); err != nil {
		t.Fatal(err)
	}
	request, err := syncv2.DecodeRequest(fixture.Request)
	if err != nil || request.Cursor != nil || len(request.Mutations) != 0 ||
		request.DeviceID != syncv2.DeviceID(testDeviceID) {
		t.Fatalf("shared request = %#v, %v", request, err)
	}
	if fixture.Response.Changes == nil || fixture.Response.Receipts == nil ||
		len(fixture.Response.Changes) != 0 || len(fixture.Response.Receipts) != 0 {
		t.Fatalf("shared fixture arrays = %#v %#v", fixture.Response.Changes, fixture.Response.Receipts)
	}
	encoded, err := syncv2.EncodeResponse(syncv2.Response{
		Version: fixture.Response.Version, HighWatermark: fixture.Response.HighWatermark,
		Changes: []syncv2.HydratedChange{}, Receipts: []syncv2.MutationReceipt{},
		Page: syncv2.ResponsePage{
			Kind: fixture.Response.Page.Kind, NextCursor: fixture.Response.Page.NextCursor,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	var fixtureDocument struct {
		Response json.RawMessage `json:"response"`
	}
	if err := json.Unmarshal(content, &fixtureDocument); err != nil {
		t.Fatal(err)
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, fixtureDocument.Response); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(encoded, compact.Bytes()) {
		t.Fatalf("Go response = %s\nfixture     = %s", encoded, compact.Bytes())
	}
}

func TestSyncV2ProtocolRejectsAmbiguousAndInvalidInput(t *testing.T) {
	t.Parallel()
	base := `{"version":"sync/v2","deviceId":"` + testDeviceID + `","cursor":null,"mutations":[]}`
	cases := map[string]string{
		"unknown field":      strings.Replace(base, `"mutations":[]`, `"mutations":[],"extra":true`, 1),
		"duplicate root":     strings.Replace(base, `"mutations":[]`, `"mutations":[],"mutations":[]`, 1),
		"trailing value":     base + `{}`,
		"wrong version":      strings.Replace(base, `sync/v2`, `sync/v1`, 1),
		"short cursor":       strings.Replace(base, `"cursor":null`, `"cursor":"short"`, 1),
		"unpaired surrogate": strings.Replace(base, testDeviceID, `\ud800`, 1),
		"null mutations":     strings.Replace(base, `"mutations":[]`, `"mutations":null`, 1),
	}
	for name, candidate := range cases {
		name, candidate := name, candidate
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if _, err := syncv2.DecodeRequest([]byte(candidate)); !errors.Is(err, syncv2.ErrInvalidRequest) {
				t.Fatalf("DecodeRequest() error = %v", err)
			}
		})
	}

	validMutation := `{"mutationId":"` + testMutationID + `","cardId":"` + testCardID +
		`","baseServerRevision":null,"title":"ok","body":[],"createdAt":1,"updatedAt":1,"kind":"upsert","conflictIds":[]}`
	withMutations := func(items string) string {
		return strings.Replace(base, `"mutations":[]`, `"mutations":[`+items+`]`, 1)
	}
	validUpsertWithBase := strings.Replace(validMutation, `"baseServerRevision":null`, `"baseServerRevision":1`, 1)
	validResolve := strings.NewReplacer(
		`"baseServerRevision":null`, `"baseServerRevision":1`,
		`"kind":"upsert"`, `"kind":"resolve"`,
		`"conflictIds":[]`, `"conflictIds":["`+testMutationID+`"]`,
	).Replace(validMutation)
	for name, candidate := range map[string]string{
		"upsert with null base":     validMutation,
		"upsert with positive base": validUpsertWithBase,
		"resolve":                   validResolve,
	} {
		if _, err := syncv2.DecodeRequest([]byte(withMutations(candidate))); err != nil {
			t.Fatalf("valid %s error = %v", name, err)
		}
	}
	for name, candidate := range map[string]string{
		"duplicate mutation":      withMutations(validMutation + "," + validMutation),
		"unknown mutation":        strings.Replace(withMutations(validMutation), `"conflictIds":[]`, `"conflictIds":[],"extra":0`, 1),
		"upsert conflicts":        strings.Replace(withMutations(validMutation), `"conflictIds":[]`, `"conflictIds":["`+testMutationID+`"]`, 1),
		"resolve null base":       strings.Replace(withMutations(validResolve), `"baseServerRevision":1`, `"baseServerRevision":null`, 1),
		"resolve empty conflicts": strings.Replace(withMutations(validResolve), `"conflictIds":["`+testMutationID+`"]`, `"conflictIds":[]`, 1),
		"zero base":               strings.Replace(withMutations(validUpsertWithBase), `"baseServerRevision":1`, `"baseServerRevision":0`, 1),
		"base above maximum":      strings.Replace(withMutations(validUpsertWithBase), `"baseServerRevision":1`, `"baseServerRevision":2147483648`, 1),
		"duplicate conflict":      strings.Replace(withMutations(validResolve), `"conflictIds":["`+testMutationID+`"]`, `"conflictIds":["`+testMutationID+`","`+testMutationID+`"]`, 1),
		"timeline":                strings.Replace(withMutations(validMutation), `"createdAt":1`, `"createdAt":2`, 1),
	} {
		if _, err := syncv2.DecodeRequest([]byte(candidate)); !errors.Is(err, syncv2.ErrInvalidRequest) {
			t.Fatalf("%s error = %v", name, err)
		}
	}
}

func TestSyncV2CursorAuthenticatesAndBindsClaims(t *testing.T) {
	t.Parallel()
	if _, err := syncv2.NewCursorAuthenticator(make([]byte, 31)); !errors.Is(err, syncv2.ErrInvalidCursor) {
		t.Fatalf("short secret error = %v", err)
	}
	authenticator, err := syncv2.NewCursorAuthenticator(bytesOf(0x51, 32))
	if err != nil {
		t.Fatal(err)
	}
	vaultID, _ := identity.ParseVaultID(testVaultID)
	deviceID, _ := syncv2.ParseDeviceID(testDeviceID)
	claims := syncv2.CursorClaims{
		Version: syncv2.CursorVersion, VaultID: vaultID, DeviceID: deviceID,
		AfterSequence: 7, HighWatermark: 11,
	}
	token, err := authenticator.Issue(claims)
	if err != nil {
		t.Fatal(err)
	}
	verified, err := authenticator.Verify(token)
	if err != nil || verified != claims {
		t.Fatalf("Verify() = %#v, %v", verified, err)
	}
	parts := strings.Split(string(token), ".")
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || string(payload) != `{"version":"sync-cursor/v2","vaultId":"`+testVaultID+`","deviceId":"`+testDeviceID+`","afterSequence":7,"highWatermark":11}` {
		t.Fatalf("cursor payload = %q, %v", payload, err)
	}
	replacement := byte('A')
	if token[len(token)-1] == replacement {
		replacement = 'B'
	}
	tampered := syncv2.Cursor(string(token[:len(token)-1]) + string(replacement))
	if _, err := authenticator.Verify(tampered); !errors.Is(err, syncv2.ErrInvalidCursor) {
		t.Fatalf("tampered cursor error = %v", err)
	}
	if _, err := authenticator.Issue(syncv2.CursorClaims{
		Version: syncv2.CursorVersion, VaultID: vaultID, DeviceID: deviceID,
		AfterSequence: 12, HighWatermark: 11,
	}); !errors.Is(err, syncv2.ErrInvalidCursor) {
		t.Fatalf("invalid window error = %v", err)
	}
}

func TestSyncV2MutationPlanningAndHydration(t *testing.T) {
	t.Parallel()
	cardID, _ := syncv2.ParseCardID(testCardID)
	mutationID, _ := syncv2.ParseMutationID(testMutationID)
	mutation := syncv2.Mutation{
		MutationID: mutationID, CardID: cardID, Title: "first",
		Body: []syncv2.BodySegment{}, CreatedAt: 1_000, UpdatedAt: 1_000,
		Kind: syncv2.MutationUpsert, ConflictIDs: []syncv2.ConflictID{},
	}
	created := syncv2.PlanMutation(mutation, nil, nil)
	if created.Kind != syncv2.MutationPlanWriteCard || created.NextRevision != 1 || created.Card.CreatedAt != 1_000 {
		t.Fatalf("create plan = %#v", created)
	}
	head := syncv2.CardHead{CardID: cardID, OfficialDisplayID: 1, Revision: 1, UpdatedAt: 1_000}
	if needs := syncv2.PlanMutation(mutation, &head, nil); needs.Kind != syncv2.MutationPlanNeedsContent {
		t.Fatalf("content plan = %#v", needs)
	}
	current := created.Card
	concurrent := mutation
	concurrent.MutationID, _ = syncv2.ParseMutationID("01991f20-61d2-7000-8000-000000000006")
	concurrent.Title = "concurrent"
	concurrent.UpdatedAt = 1_100
	conflict := syncv2.PlanMutation(concurrent, &head, &current)
	if conflict.Kind != syncv2.MutationPlanWriteConflict || conflict.ServerRevision != 1 ||
		conflict.Conflict.ServerTitle != "first" {
		t.Fatalf("conflict plan = %#v", conflict)
	}
	change := syncv2.Change{
		Kind: syncv2.ChangeCardUpsert, Sequence: 1, CardID: cardID,
		Revision: 1, OfficialDisplayID: 1, OccurredAt: 1_000,
	}
	hydrated, ok := syncv2.HydrateJournalChange(change, &current, nil)
	if !ok || hydrated.Card == nil || hydrated.Card.Title != "first" {
		t.Fatalf("hydration = %#v, %t", hydrated, ok)
	}
	swapped := current
	swapped.UpdatedAt++
	if _, ok := syncv2.HydrateJournalChange(change, &swapped, nil); ok {
		t.Fatal("timeline-swapped content was hydrated")
	}
}

func bytesOf(value byte, count int) []byte {
	result := make([]byte, count)
	for index := range result {
		result[index] = value
	}
	return result
}
