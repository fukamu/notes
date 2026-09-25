package quota

import (
	"testing"

	"github.com/fukamu/notes/backend/internal/entitlement"
)

func TestCountDisplayCharactersUsesUnicodeScalarsAndLogicalLinks(t *testing.T) {
	characters, ok := CountDisplayCharacters("😀", []DisplaySegment{
		{Kind: SegmentText, Text: "e\u0301"},
		{Kind: SegmentLink},
	})
	if !ok || characters != 4 {
		t.Fatalf("count = %d, %v", characters, ok)
	}
	if _, ok := CountDisplayCharacters(string([]byte{0xff}), nil); ok {
		t.Fatal("invalid UTF-8 title was accepted")
	}
	if _, ok := CountDisplayCharacters("valid", []DisplaySegment{{Kind: SegmentText, Text: string([]byte{0xff})}}); ok {
		t.Fatal("invalid UTF-8 body was accepted")
	}
	if _, ok := CountDisplayCharacters("valid", []DisplaySegment{{Kind: "unknown"}}); ok {
		t.Fatal("unknown segment was accepted")
	}
}

func TestEvaluateBoundariesKeepsIndependentExactLimits(t *testing.T) {
	limits := entitlement.PaidPersonalVaultLimits()
	exact := EvaluateBoundaries(BoundaryMeasurement{
		DisplayCharacters:        limits.DisplayCharactersPerCard,
		SerializedPlaintextBytes: limits.SerializedPlaintextBytesPerCard,
		CiphertextBytes:          MaximumCiphertextBytesPerObject,
		RequestBytes:             MaximumRequestBytes,
	}, limits)
	if !exact.Accepted || len(exact.Reasons) != 0 {
		t.Fatalf("exact boundary = %#v", exact)
	}
	over := EvaluateBoundaries(BoundaryMeasurement{
		DisplayCharacters:        limits.DisplayCharactersPerCard + 1,
		SerializedPlaintextBytes: limits.SerializedPlaintextBytesPerCard + 1,
		CiphertextBytes:          MaximumCiphertextBytesPerObject + 1,
		RequestBytes:             MaximumRequestBytes + 1,
	}, limits)
	want := []BoundaryRejectionReason{
		BoundaryDisplayCharacterLimit,
		BoundarySerializedPlaintextLimit,
		BoundaryCiphertextLimit,
		BoundaryRequestLimit,
	}
	if over.Accepted || len(over.Reasons) != len(want) {
		t.Fatalf("over boundary = %#v", over)
	}
	for index := range want {
		if over.Reasons[index] != want[index] {
			t.Fatalf("reason[%d] = %q", index, over.Reasons[index])
		}
	}
}

func TestEvaluateChangeAcceptsExactCapacityAndDelaysDecreases(t *testing.T) {
	limits := entitlement.PaidPersonalVaultLimits()
	created := EvaluateChange(Usage{
		ActiveCards:    limits.ActiveCards - 1,
		PlaintextBytes: limits.PlaintextBytesPerVault - 5,
	}, Change{Kind: ChangeCreate, NextPlaintextBytes: 5}, limits)
	if !created.Accepted || created.CardDelta != 1 || created.PlaintextByteDelta != 5 ||
		created.Next.ActiveCards != limits.ActiveCards ||
		created.Next.PlaintextBytes != limits.PlaintextBytesPerVault {
		t.Fatalf("exact create = %#v", created)
	}
	tooMany := EvaluateChange(created.Next, Change{Kind: ChangeCreate}, limits)
	if tooMany.Accepted || tooMany.Reason != ChangeActiveCardLimit {
		t.Fatalf("over card limit = %#v", tooMany)
	}
	decreased := EvaluateChange(
		Usage{ActiveCards: 1, PlaintextBytes: 10},
		Change{Kind: ChangeUpdate, CurrentPlaintextBytes: 10, NextPlaintextBytes: 4},
		limits,
	)
	if !decreased.Accepted || decreased.CardDelta != 0 || decreased.PlaintextByteDelta != -6 ||
		decreased.Next != (Usage{ActiveCards: 1, PlaintextBytes: 4}) {
		t.Fatalf("decrease = %#v", decreased)
	}
	invalidDelete := EvaluateChange(
		Usage{}, Change{Kind: ChangeDelete, CurrentPlaintextBytes: 1}, limits,
	)
	if invalidDelete.Accepted || invalidDelete.Reason != ChangeInvalidUsage {
		t.Fatalf("invalid delete = %#v", invalidDelete)
	}
}
