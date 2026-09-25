package syncv2

import (
	"crypto/sha256"
	"encoding/base64"
)

type MutationPlanKind string

const (
	MutationPlanNeedsContent  MutationPlanKind = "requires-current-content"
	MutationPlanWriteCard     MutationPlanKind = "write-card"
	MutationPlanWriteConflict MutationPlanKind = "write-conflict"
	MutationPlanRejected      MutationPlanKind = "rejected"
)

type MutationPlan struct {
	Kind             MutationPlanKind
	Reason           RejectionReason
	RequiredRevision Revision
	ExpectedRevision *Revision
	NextRevision     Revision
	ConflictID       ConflictID
	ServerRevision   Revision
	Card             StoredCard
	Conflict         StoredConflict
}

func CanonicalizeMutation(mutation Mutation) ([]byte, error) {
	if !validMutation(mutation) {
		return nil, ErrInvalidRequest
	}
	canonicalBody := make([][]string, 0, len(mutation.Body))
	for _, segment := range mutation.Body {
		switch segment.Kind {
		case SegmentText:
			canonicalBody = append(canonicalBody, []string{"text", segment.Text})
		case SegmentLink:
			canonicalBody = append(canonicalBody, []string{"link", string(segment.TargetCardID)})
		default:
			return nil, ErrInvalidRequest
		}
	}
	conflictIDs := make([]string, len(mutation.ConflictIDs))
	for index, conflictID := range mutation.ConflictIDs {
		conflictIDs[index] = string(conflictID)
	}
	var baseRevision any
	if mutation.BaseServerRevision != nil {
		baseRevision = int64(*mutation.BaseServerRevision)
	}
	return marshalCanonical([]any{
		"fukamu-sync-v2-mutation/v1", mutation.Kind, mutation.MutationID,
		mutation.CardID, baseRevision, mutation.Title, canonicalBody,
		mutation.CreatedAt, mutation.UpdatedAt, conflictIDs,
	})
}

func CanonicalizeCardDeletion(
	mutationID MutationID,
	cardID CardID,
	expectedRevision Revision,
	deletedAt int64,
) ([]byte, error) {
	if _, err := ParseMutationID(string(mutationID)); err != nil {
		return nil, ErrInvalidRequest
	}
	if _, err := ParseCardID(string(cardID)); err != nil {
		return nil, ErrInvalidRequest
	}
	if _, err := ParseRevision(int64(expectedRevision)); err != nil || !validTimestamp(deletedAt) {
		return nil, ErrInvalidRequest
	}
	return marshalCanonical([]any{
		"fukamu-sync-v2-card-delete/v1", mutationID, cardID, expectedRevision, deletedAt,
	})
}

func FingerprintCanonical(content []byte) Fingerprint {
	digest := sha256.Sum256(content)
	return Fingerprint(base64.RawURLEncoding.EncodeToString(digest[:]))
}

func PlanMutation(mutation Mutation, current *CardHead, currentContent *StoredCard) MutationPlan {
	if !validMutation(mutation) {
		return MutationPlan{Kind: MutationPlanRejected, Reason: ReasonInvalidState}
	}
	if current == nil {
		if mutation.Kind == MutationResolve || mutation.BaseServerRevision != nil {
			return MutationPlan{Kind: MutationPlanRejected, Reason: ReasonMissingCard}
		}
		return MutationPlan{
			Kind: MutationPlanWriteCard, NextRevision: 1,
			Card: StoredCard{
				Title: mutation.Title, Body: cloneBody(mutation.Body),
				CreatedAt: mutation.CreatedAt, UpdatedAt: mutation.UpdatedAt,
			},
		}
	}
	if currentContent == nil {
		return MutationPlan{Kind: MutationPlanNeedsContent, RequiredRevision: current.Revision}
	}
	if currentContent.UpdatedAt != current.UpdatedAt {
		return MutationPlan{Kind: MutationPlanRejected, Reason: ReasonInvalidTimeline}
	}
	if mutation.Kind == MutationResolve {
		if mutation.BaseServerRevision == nil || *mutation.BaseServerRevision != current.Revision {
			return MutationPlan{Kind: MutationPlanRejected, Reason: ReasonStaleRevision}
		}
		return planMutationCardWrite(mutation, *current, *currentContent)
	}
	if mutation.BaseServerRevision != nil && *mutation.BaseServerRevision == current.Revision ||
		sameEditableContent(mutation, *currentContent) {
		return planMutationCardWrite(mutation, *current, *currentContent)
	}
	conflictID, err := ParseConflictID(string(mutation.MutationID))
	if err != nil {
		return MutationPlan{Kind: MutationPlanRejected, Reason: ReasonInvalidState}
	}
	return MutationPlan{
		Kind: MutationPlanWriteConflict, ConflictID: conflictID, ServerRevision: current.Revision,
		Conflict: StoredConflict{
			LocalTitle: mutation.Title, LocalBody: cloneBody(mutation.Body),
			ServerTitle: currentContent.Title, ServerBody: cloneBody(currentContent.Body),
			CreatedAt: mutation.UpdatedAt,
		},
	}
}

func planMutationCardWrite(mutation Mutation, current CardHead, currentContent StoredCard) MutationPlan {
	if mutation.UpdatedAt < current.UpdatedAt || int64(current.Revision) >= MaximumRevision {
		return MutationPlan{Kind: MutationPlanRejected, Reason: ReasonInvalidTimeline}
	}
	expected := current.Revision
	return MutationPlan{
		Kind: MutationPlanWriteCard, ExpectedRevision: &expected,
		NextRevision: Revision(int64(current.Revision) + 1),
		Card: StoredCard{
			Title: mutation.Title, Body: cloneBody(mutation.Body),
			CreatedAt: currentContent.CreatedAt, UpdatedAt: mutation.UpdatedAt,
		},
	}
}

func HydrateJournalChange(change Change, card *StoredCard, conflict *StoredConflict) (HydratedChange, bool) {
	if !validChange(change) {
		return HydratedChange{}, false
	}
	switch change.Kind {
	case ChangeCardUpsert:
		if card == nil || conflict != nil || card.UpdatedAt != change.OccurredAt || !validStoredCard(*card) {
			return HydratedChange{}, false
		}
		hydrated := ServerCard{
			ID: change.CardID, OfficialDisplayID: change.OfficialDisplayID,
			Title: card.Title, Body: cloneBody(card.Body), CreatedAt: card.CreatedAt,
			UpdatedAt: card.UpdatedAt, Revision: change.Revision,
		}
		return HydratedChange{Kind: change.Kind, Sequence: change.Sequence, Card: &hydrated}, true
	case ChangeConflictUpsert:
		if card != nil || conflict == nil || conflict.CreatedAt != change.OccurredAt || !validStoredConflict(*conflict) {
			return HydratedChange{}, false
		}
		hydrated := ServerConflict{
			ID: change.ConflictID, CardID: change.CardID, ServerRevision: change.Revision,
			LocalTitle: conflict.LocalTitle, LocalBody: cloneBody(conflict.LocalBody),
			ServerTitle: conflict.ServerTitle, ServerBody: cloneBody(conflict.ServerBody),
			CreatedAt: conflict.CreatedAt,
		}
		return HydratedChange{Kind: change.Kind, Sequence: change.Sequence, Conflict: &hydrated}, true
	case ChangeCardTombstone:
		if card != nil || conflict != nil {
			return HydratedChange{}, false
		}
		return HydratedChange{
			Kind: change.Kind, Sequence: change.Sequence, CardID: change.CardID,
			Revision: change.Revision, OccurredAt: change.OccurredAt,
		}, true
	case ChangeConflictTombstone:
		if card != nil || conflict != nil {
			return HydratedChange{}, false
		}
		return HydratedChange{
			Kind: change.Kind, Sequence: change.Sequence, ConflictID: change.ConflictID,
			CardID: change.CardID, OccurredAt: change.OccurredAt,
		}, true
	default:
		return HydratedChange{}, false
	}
}

func validMutation(mutation Mutation) bool {
	if _, err := ParseMutationID(string(mutation.MutationID)); err != nil {
		return false
	}
	if _, err := ParseCardID(string(mutation.CardID)); err != nil ||
		!validBoundedString(mutation.Title, MaximumTitleCharacters) || !validBody(mutation.Body) ||
		!validTimestamp(mutation.CreatedAt) || !validTimestamp(mutation.UpdatedAt) ||
		mutation.CreatedAt > mutation.UpdatedAt || len(mutation.ConflictIDs) > MaximumConflictIDs {
		return false
	}
	if mutation.BaseServerRevision != nil {
		if _, err := ParseRevision(int64(*mutation.BaseServerRevision)); err != nil {
			return false
		}
	}
	seen := make(map[ConflictID]struct{}, len(mutation.ConflictIDs))
	for _, conflictID := range mutation.ConflictIDs {
		if _, err := ParseConflictID(string(conflictID)); err != nil {
			return false
		}
		if _, duplicate := seen[conflictID]; duplicate {
			return false
		}
		seen[conflictID] = struct{}{}
	}
	switch mutation.Kind {
	case MutationUpsert:
		return len(mutation.ConflictIDs) == 0
	case MutationResolve:
		return mutation.BaseServerRevision != nil && len(mutation.ConflictIDs) > 0
	default:
		return false
	}
}

func sameEditableContent(mutation Mutation, current StoredCard) bool {
	if mutation.Title != current.Title || len(mutation.Body) != len(current.Body) {
		return false
	}
	for index, segment := range mutation.Body {
		candidate := current.Body[index]
		if candidate != segment {
			return false
		}
	}
	return true
}

func cloneBody(body []BodySegment) []BodySegment {
	if body == nil {
		return nil
	}
	cloned := make([]BodySegment, len(body))
	copy(cloned, body)
	return cloned
}
