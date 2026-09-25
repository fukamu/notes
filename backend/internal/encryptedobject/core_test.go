package encryptedobject

import (
	"testing"

	"github.com/fukamu/notes/backend/internal/cryptocontent"
)

func TestPlanWriteCompatibility(t *testing.T) {
	request := fixtureWriteRequest(t)
	current := fixtureMetadata(t)

	tests := []struct {
		name     string
		existing *Metadata
		current  *Metadata
		request  WriteRequest
		kind     WritePlanKind
		reason   RejectionReason
	}{
		{name: "initial", request: request, kind: WritePlanAccepted},
		{name: "replay", existing: &current, request: request, kind: WritePlanReplay},
		{name: "idempotency reuse", existing: &current, request: changedPlaintextSize(request), kind: WritePlanRejected, reason: ReasonIdempotencyKeyReuse},
		{name: "missing", request: withExpected(request, 1, 2), kind: WritePlanRejected, reason: ReasonMissingObject},
		{name: "unexpected", current: &current, request: request, kind: WritePlanRejected, reason: ReasonUnexpectedExisting},
		{name: "stale", current: &current, request: withExpected(request, 2, 3), kind: WritePlanRejected, reason: ReasonStaleRevision},
		{name: "skipped revision", current: &current, request: withExpected(request, 1, 3), kind: WritePlanRejected, reason: ReasonInvalidNextRevision},
		{name: "timeline", current: &current, request: withTimeline(withExpected(request, 1, 2), 999), kind: WritePlanRejected, reason: ReasonInvalidTimeline},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			plan := PlanWrite(test.existing, test.current, test.request)
			if plan.Kind != test.kind || plan.Reason != test.reason {
				t.Fatalf("PlanWrite() = %#v", plan)
			}
		})
	}
}

func TestPendingCiphertextOrphanAndDeletePlans(t *testing.T) {
	request := fixtureWriteRequest(t)
	intent := fixturePendingWrite(t)
	if !PendingMatchesRequest(intent, request) {
		t.Fatal("matching intent was rejected")
	}
	changed := request
	changed.DEKVersion = 2
	if PendingMatchesRequest(intent, changed) {
		t.Fatal("changed DEK version was accepted")
	}
	ciphertext := cryptocontent.EnvelopeCiphertext{
		Format: cryptocontent.EnvelopeCryptoVersion, Algorithm: cryptocontent.EnvelopeAlgorithm,
		DEKVersion: 1, Nonce: "AAAAAAAAAAAAAAAA", SealedPayload: "AAAAAAAAAAAAAAAAAAAAAA",
	}
	expectedBytes := int64(100)
	if !StoredCiphertextMatches(cryptocontent.EnvelopeCryptoVersion, 1, &expectedBytes, ciphertext, 100) {
		t.Fatal("matching ciphertext was rejected")
	}
	if StoredCiphertextMatches(cryptocontent.EnvelopeCryptoVersion, 1, &expectedBytes, ciphertext, 99) {
		t.Fatal("ciphertext size mismatch was accepted")
	}
	keyA, _ := ParseObjectKey("obj_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	keyB, _ := ParseObjectKey("obj_v1_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB")
	keyC, _ := ParseObjectKey("obj_v1_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC")
	orphans := PlanOrphanCollection(
		[]PrivateObjectDescriptor{{ObjectKey: keyC, CreatedAtMilli: 1_000}, {ObjectKey: keyA, CreatedAtMilli: 1_000}, {ObjectKey: keyB, CreatedAtMilli: 9_500}},
		map[ObjectKey]struct{}{keyC: {}}, 10_000, 1_000,
	)
	if len(orphans) != 1 || orphans[0] != keyA {
		t.Fatalf("orphans = %v", orphans)
	}
	entry := DeleteOutboxEntry{ObjectKey: keyA, AttemptCount: 0, NextAttemptAt: 1_000, CreatedAtMilli: 1_000}
	retry, complete := PlanDeleteAttempt(entry, false, 10_000, 5_000)
	if complete || retry.AttemptCount != 1 || retry.NextAttemptAt != 15_000 {
		t.Fatalf("retry = %#v, complete = %t", retry, complete)
	}
	if _, complete := PlanDeleteAttempt(retry, true, 15_000, 5_000); !complete {
		t.Fatal("successful delete was not completed")
	}
}

func fixtureWriteRequest(t *testing.T) WriteRequest {
	t.Helper()
	writeID, err := ParseWriteID("01991f20-61d2-7000-8000-000000000501")
	if err != nil {
		t.Fatal(err)
	}
	return WriteRequest{
		Object:       ObjectRef{Kind: cryptocontent.ObjectCard, ObjectID: "01991f20-61d2-7000-8000-000000000001"},
		NextRevision: 1, WriteID: writeID, PlaintextBytes: 17, DEKVersion: 1, CreatedAtMilli: 1_000,
	}
}

func fixturePendingWrite(t *testing.T) PendingWrite {
	t.Helper()
	request := fixtureWriteRequest(t)
	key, _ := ParseObjectKey("obj_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	return PendingWrite{
		Object: request.Object, ObjectRevision: request.NextRevision, WriteID: request.WriteID,
		ObjectKey: key, PlaintextBytes: request.PlaintextBytes,
		CryptoVersion: cryptocontent.EnvelopeCryptoVersion, DEKVersion: request.DEKVersion,
		CreatedAtMilli: request.CreatedAtMilli,
	}
}

func fixtureMetadata(t *testing.T) Metadata {
	t.Helper()
	intent := fixturePendingWrite(t)
	return Metadata{
		Object: intent.Object, ObjectRevision: intent.ObjectRevision, WriteID: intent.WriteID,
		ObjectKey: intent.ObjectKey, PlaintextBytes: intent.PlaintextBytes, CiphertextBytes: 100,
		CryptoVersion: intent.CryptoVersion, DEKVersion: intent.DEKVersion, CreatedAtMilli: intent.CreatedAtMilli,
	}
}

func withExpected(request WriteRequest, expected, next int64) WriteRequest {
	parsedExpected := cryptocontent.ObjectRevision(expected)
	request.ExpectedRevision = &parsedExpected
	request.NextRevision = cryptocontent.ObjectRevision(next)
	return request
}

func changedPlaintextSize(request WriteRequest) WriteRequest {
	request.PlaintextBytes++
	return request
}

func withTimeline(request WriteRequest, createdAt int64) WriteRequest {
	request.CreatedAtMilli = createdAt
	return request
}
