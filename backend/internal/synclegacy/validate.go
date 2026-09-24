package synclegacy

func ValidateResponse(response Response, sent []Mutation) error {
	if response.Cards == nil || response.Conflicts == nil || response.AcknowledgedMutationIDs == nil ||
		len(response.Cards) > MaximumCards || len(response.Conflicts) > MaximumConflicts ||
		len(response.AcknowledgedMutationIDs) > MaximumMutations {
		return ErrInvalidState
	}
	cards := make(map[CardID]struct{}, len(response.Cards))
	displayIDs := make(map[int64]struct{}, len(response.Cards))
	for _, card := range response.Cards {
		if !validUUID(string(card.ID)) || !safePositive(card.OfficialDisplayID) ||
			!boundedString(card.Title, MaximumTitleLength) || card.CreatedAt < 0 ||
			card.UpdatedAt < card.CreatedAt || !safeNonNegative(card.UpdatedAt) ||
			!safePositive(card.Revision) || validateBody(card.Body, ErrInvalidState) != nil {
			return ErrInvalidState
		}
		if _, duplicate := cards[card.ID]; duplicate {
			return ErrInvalidState
		}
		if _, duplicate := displayIDs[card.OfficialDisplayID]; duplicate {
			return ErrInvalidState
		}
		cards[card.ID] = struct{}{}
		displayIDs[card.OfficialDisplayID] = struct{}{}
	}
	conflicts := make(map[ConflictID]struct{}, len(response.Conflicts))
	for _, conflict := range response.Conflicts {
		if !validUUID(string(conflict.ID)) || !validUUID(string(conflict.CardID)) ||
			!safePositive(conflict.ServerRevision) ||
			!boundedString(conflict.LocalTitle, MaximumTitleLength) ||
			!boundedString(conflict.ServerTitle, MaximumTitleLength) ||
			!safeNonNegative(conflict.CreatedAt) ||
			validateBody(conflict.LocalBody, ErrInvalidState) != nil ||
			validateBody(conflict.ServerBody, ErrInvalidState) != nil {
			return ErrInvalidState
		}
		if _, duplicate := conflicts[conflict.ID]; duplicate {
			return ErrInvalidState
		}
		if _, exists := cards[conflict.CardID]; !exists {
			return ErrInvalidState
		}
		conflicts[conflict.ID] = struct{}{}
	}
	for _, card := range response.Cards {
		for _, segment := range card.Body {
			if segment.Kind == SegmentLink {
				if _, exists := cards[segment.TargetCardID]; !exists {
					return ErrInvalidState
				}
			}
		}
	}
	sentIDs := make(map[MutationID]struct{}, len(sent))
	for _, mutation := range sent {
		sentIDs[mutation.MutationID] = struct{}{}
	}
	acknowledged := make(map[MutationID]struct{}, len(response.AcknowledgedMutationIDs))
	for _, identifier := range response.AcknowledgedMutationIDs {
		if !validUUID(string(identifier)) {
			return ErrInvalidState
		}
		if _, sent := sentIDs[identifier]; !sent {
			return ErrInvalidState
		}
		if _, duplicate := acknowledged[identifier]; duplicate {
			return ErrInvalidState
		}
		acknowledged[identifier] = struct{}{}
	}
	return nil
}

func validateBody(body []BodySegment, fixedError error) error {
	if body == nil || len(body) > MaximumBodySegments {
		return fixedError
	}
	for _, segment := range body {
		switch segment.Kind {
		case SegmentText:
			if segment.TargetCardID != "" || !boundedString(segment.Text, MaximumTextLength) {
				return fixedError
			}
		case SegmentLink:
			if segment.Text != "" || !validUUID(string(segment.TargetCardID)) {
				return fixedError
			}
		default:
			return fixedError
		}
	}
	return nil
}

func validUUID(value string) bool {
	return uuidV7Pattern.MatchString(value)
}

func boundedString(value string, maximum int) bool {
	return utf16Length(value) <= maximum
}

func safePositive(value int64) bool {
	return value >= 1 && value <= MaximumSafeInteger
}

func safeNonNegative(value int64) bool {
	return value >= 0 && value <= MaximumSafeInteger
}
