package quota

import (
	"unicode/utf8"

	"github.com/fukamu/notes/backend/internal/entitlement"
)

func CountDisplayCharacters(title string, body []DisplaySegment) (int64, bool) {
	if !utf8.ValidString(title) {
		return 0, false
	}
	characters := int64(utf8.RuneCountInString(title))
	for _, segment := range body {
		switch segment.Kind {
		case SegmentLink:
			if characters == MaximumSafeInteger {
				return 0, false
			}
			characters++
		case SegmentText:
			if !utf8.ValidString(segment.Text) {
				return 0, false
			}
			count := int64(utf8.RuneCountInString(segment.Text))
			if count > MaximumSafeInteger-characters {
				return 0, false
			}
			characters += count
		default:
			return 0, false
		}
	}
	return characters, true
}

func EvaluateBoundaries(
	measurement BoundaryMeasurement,
	limits entitlement.PersonalVaultLimits,
) BoundaryEvaluation {
	reasons := make([]BoundaryRejectionReason, 0, 4)
	if !validMeasurement(measurement) || !validLimits(limits) {
		return BoundaryEvaluation{Reasons: []BoundaryRejectionReason{
			BoundaryDisplayCharacterLimit,
			BoundarySerializedPlaintextLimit,
			BoundaryCiphertextLimit,
			BoundaryRequestLimit,
		}}
	}
	if measurement.DisplayCharacters > limits.DisplayCharactersPerCard {
		reasons = append(reasons, BoundaryDisplayCharacterLimit)
	}
	if measurement.SerializedPlaintextBytes > limits.SerializedPlaintextBytesPerCard {
		reasons = append(reasons, BoundarySerializedPlaintextLimit)
	}
	if measurement.CiphertextBytes > MaximumCiphertextBytesPerObject {
		reasons = append(reasons, BoundaryCiphertextLimit)
	}
	if measurement.RequestBytes > MaximumRequestBytes {
		reasons = append(reasons, BoundaryRequestLimit)
	}
	return BoundaryEvaluation{Accepted: len(reasons) == 0, Reasons: reasons}
}

func EvaluateChange(
	current Usage,
	change Change,
	limits entitlement.PersonalVaultLimits,
) ChangeEvaluation {
	if !validUsage(current) || !validChange(change) || !validLimits(limits) {
		return ChangeEvaluation{Reason: ChangeInvalidUsage}
	}
	var cardDelta, currentBytes, byteDelta int64
	switch change.Kind {
	case ChangeCreate:
		cardDelta = 1
		byteDelta = change.NextPlaintextBytes
	case ChangeUpdate:
		currentBytes = change.CurrentPlaintextBytes
		byteDelta = change.NextPlaintextBytes - change.CurrentPlaintextBytes
	case ChangeDelete:
		cardDelta = -1
		currentBytes = change.CurrentPlaintextBytes
		byteDelta = -change.CurrentPlaintextBytes
	}
	if currentBytes > current.PlaintextBytes || cardDelta == -1 && current.ActiveCards == 0 {
		return ChangeEvaluation{Reason: ChangeInvalidUsage}
	}
	activeCards, cardsOK := safeAdd(current.ActiveCards, cardDelta)
	plaintextBytes, bytesOK := safeAdd(current.PlaintextBytes, byteDelta)
	if !cardsOK || !bytesOK || activeCards < 0 || plaintextBytes < 0 {
		return ChangeEvaluation{Reason: ChangeInvalidUsage}
	}
	if activeCards > limits.ActiveCards {
		return ChangeEvaluation{Reason: ChangeActiveCardLimit}
	}
	if plaintextBytes > limits.PlaintextBytesPerVault {
		return ChangeEvaluation{Reason: ChangeVaultPlaintextLimit}
	}
	return ChangeEvaluation{
		Accepted: true, CardDelta: cardDelta, PlaintextByteDelta: byteDelta,
		Next: Usage{ActiveCards: activeCards, PlaintextBytes: plaintextBytes},
	}
}

func validMeasurement(value BoundaryMeasurement) bool {
	return validCount(value.DisplayCharacters) && validCount(value.SerializedPlaintextBytes) &&
		validCount(value.CiphertextBytes) && validCount(value.RequestBytes)
}

func validLimits(value entitlement.PersonalVaultLimits) bool {
	return validCount(value.ActiveCards) && validCount(value.DisplayCharactersPerCard) &&
		validCount(value.SerializedPlaintextBytesPerCard) && validCount(value.PlaintextBytesPerVault)
}

func validChange(value Change) bool {
	if !validCount(value.CurrentPlaintextBytes) || !validCount(value.NextPlaintextBytes) {
		return false
	}
	switch value.Kind {
	case ChangeCreate:
		return value.CurrentPlaintextBytes == 0
	case ChangeUpdate:
		return true
	case ChangeDelete:
		return value.NextPlaintextBytes == 0
	default:
		return false
	}
}

func validUsage(value Usage) bool {
	return validCount(value.ActiveCards) && validCount(value.PlaintextBytes)
}

func validCount(value int64) bool {
	return value >= 0 && value <= MaximumSafeInteger
}

func validTimestamp(value int64) bool {
	return validCount(value)
}

func safeAdd(left, right int64) (int64, bool) {
	if right > 0 && left > MaximumSafeInteger-right || right < 0 && left < -right {
		return 0, false
	}
	value := left + right
	return value, value >= 0 && value <= MaximumSafeInteger
}
