package syncv2

import "sort"

func PlanCommitCommand(command CommitCommand, snapshot Snapshot) CommitPlan {
	if !validState(snapshot.State) {
		return rejected(ReasonInvalidState)
	}
	if reason := ValidateCommitCommand(command); reason != "" {
		return rejected(reason)
	}
	if snapshot.ExistingReceipt != nil {
		if snapshot.ExistingReceipt.Fingerprint == command.Fingerprint {
			return CommitPlan{Kind: PlanReplay, Receipt: *snapshot.ExistingReceipt}
		}
		return rejected(ReasonIdempotencyKeyReuse)
	}

	appliedRevision, officialDisplayID, changes, reason := planOperation(command, snapshot)
	if reason != "" {
		return rejected(reason)
	}
	nextSequence := int64(snapshot.State.NextSequence) + int64(len(changes))
	if nextSequence > MaximumSafeInteger {
		return rejected(ReasonInvalidState)
	}
	nextDisplayID := snapshot.State.NextDisplayID
	if officialDisplayID != 0 {
		if nextDisplayID == MaximumDisplayID {
			return rejected(ReasonInvalidState)
		}
		nextDisplayID++
	}
	sequenced := make([]Change, len(changes))
	for index, change := range changes {
		change.Sequence = Sequence(int64(snapshot.State.NextSequence) + int64(index))
		sequenced[index] = change
	}
	return CommitPlan{
		Kind: PlanCommit,
		Receipt: Receipt{
			MutationID: command.MutationID, Fingerprint: command.Fingerprint,
			CardID: command.CardID, AppliedRevision: appliedRevision, CommittedAt: command.CommittedAt,
		},
		ExpectedState:     snapshot.State,
		NextState:         State{NextDisplayID: nextDisplayID, NextSequence: Sequence(nextSequence)},
		OfficialDisplayID: officialDisplayID,
		Changes:           sequenced,
	}
}

// ValidateCommitCommand validates the typed repository boundary without
// reading state. An empty reason means that the command is structurally valid.
func ValidateCommitCommand(command CommitCommand) RejectionReason {
	if !validCommandBase(command) || !validCommandShape(command) {
		return ReasonInvalidState
	}
	if !validTimestamp(command.CommittedAt) {
		return ReasonInvalidTimeline
	}
	return ""
}

func PlanPage(afterSequence, highWatermark Sequence, candidates []Change, limit int) (Page, bool) {
	if limit < 1 || limit > MaximumPageSize || afterSequence > highWatermark || len(candidates) > limit+1 {
		return Page{}, false
	}
	for index, change := range candidates {
		if change.Sequence != Sequence(int64(afterSequence)+int64(index)+1) ||
			change.Sequence > highWatermark || !validChange(change) {
			return Page{}, false
		}
	}
	hasMore := len(candidates) > limit
	count := len(candidates)
	if hasMore {
		count = limit
	}
	changes := append([]Change(nil), candidates[:count]...)
	last := afterSequence
	if len(changes) > 0 {
		last = changes[len(changes)-1].Sequence
	}
	if hasMore {
		if last >= highWatermark {
			return Page{}, false
		}
		return Page{HighWatermark: highWatermark, Changes: changes, Kind: PageMore, AfterSequence: last}, true
	}
	if last != highWatermark {
		return Page{}, false
	}
	return Page{HighWatermark: highWatermark, Changes: changes, Kind: PageComplete, AfterSequence: highWatermark}, true
}

func planOperation(command CommitCommand, snapshot Snapshot) (Revision, int64, []Change, RejectionReason) {
	switch command.Kind {
	case CommandCardUpsert:
		return planCardUpsert(command, snapshot)
	case CommandConflictUpsert:
		return planConflictUpsert(command, snapshot)
	case CommandResolveConflicts:
		return planResolve(command, snapshot)
	case CommandCardDelete:
		return planDelete(command, snapshot)
	default:
		return 0, 0, nil, ReasonInvalidState
	}
}

func planCardUpsert(command CommitCommand, snapshot Snapshot) (Revision, int64, []Change, RejectionReason) {
	if !validOccurred(command) {
		return 0, 0, nil, ReasonInvalidTimeline
	}
	if snapshot.Card == nil {
		if command.ExpectedRevision != nil {
			return 0, 0, nil, ReasonMissingCard
		}
		if command.NextRevision != 1 {
			return 0, 0, nil, ReasonInvalidNextRevision
		}
		return command.NextRevision, snapshot.State.NextDisplayID, []Change{{
			Kind: ChangeCardUpsert, CardID: command.CardID, Revision: command.NextRevision,
			OfficialDisplayID: snapshot.State.NextDisplayID, OccurredAt: command.OccurredAt,
		}}, ""
	}
	if command.ExpectedRevision == nil {
		return 0, 0, nil, ReasonUnexpectedCard
	}
	if snapshot.Card.CardID != command.CardID || snapshot.Card.Revision != *command.ExpectedRevision {
		return 0, 0, nil, ReasonStaleRevision
	}
	if int64(command.NextRevision) != int64(snapshot.Card.Revision)+1 {
		return 0, 0, nil, ReasonInvalidNextRevision
	}
	if command.OccurredAt < snapshot.Card.UpdatedAt {
		return 0, 0, nil, ReasonInvalidTimeline
	}
	return command.NextRevision, 0, []Change{{
		Kind: ChangeCardUpsert, CardID: command.CardID, Revision: command.NextRevision,
		OfficialDisplayID: snapshot.Card.OfficialDisplayID, OccurredAt: command.OccurredAt,
	}}, ""
}

func planConflictUpsert(command CommitCommand, snapshot Snapshot) (Revision, int64, []Change, RejectionReason) {
	if !validOccurred(command) {
		return 0, 0, nil, ReasonInvalidTimeline
	}
	if snapshot.Card == nil {
		return 0, 0, nil, ReasonMissingCard
	}
	if snapshot.Card.CardID != command.CardID || snapshot.Card.Revision != command.ServerRevision {
		return 0, 0, nil, ReasonStaleRevision
	}
	if len(snapshot.SelectedConflicts) > 0 {
		return 0, 0, nil, ReasonUnexpectedConflict
	}
	return command.ServerRevision, 0, []Change{{
		Kind: ChangeConflictUpsert, ConflictID: command.ConflictID, CardID: command.CardID,
		Revision: command.ServerRevision, OccurredAt: command.OccurredAt,
	}}, ""
}

func planResolve(command CommitCommand, snapshot Snapshot) (Revision, int64, []Change, RejectionReason) {
	if !validOccurred(command) {
		return 0, 0, nil, ReasonInvalidTimeline
	}
	if snapshot.Card == nil {
		return 0, 0, nil, ReasonMissingCard
	}
	if command.ExpectedRevision == nil || snapshot.Card.CardID != command.CardID || snapshot.Card.Revision != *command.ExpectedRevision {
		return 0, 0, nil, ReasonStaleRevision
	}
	if int64(command.NextRevision) != int64(snapshot.Card.Revision)+1 {
		return 0, 0, nil, ReasonInvalidNextRevision
	}
	if command.OccurredAt < snapshot.Card.UpdatedAt {
		return 0, 0, nil, ReasonInvalidTimeline
	}
	if len(command.ConflictIDs) == 0 {
		return 0, 0, nil, ReasonMissingConflict
	}
	available := make(map[ConflictID]ConflictHead, len(snapshot.SelectedConflicts))
	for _, conflict := range snapshot.SelectedConflicts {
		available[conflict.ConflictID] = conflict
	}
	seen := make(map[ConflictID]struct{}, len(command.ConflictIDs))
	changes := []Change{{
		Kind: ChangeCardUpsert, CardID: command.CardID, Revision: command.NextRevision,
		OfficialDisplayID: snapshot.Card.OfficialDisplayID, OccurredAt: command.OccurredAt,
	}}
	for _, conflictID := range command.ConflictIDs {
		if _, duplicate := seen[conflictID]; duplicate {
			return 0, 0, nil, ReasonMissingConflict
		}
		seen[conflictID] = struct{}{}
		conflict, found := available[conflictID]
		if !found {
			return 0, 0, nil, ReasonMissingConflict
		}
		if conflict.CardID != command.CardID {
			return 0, 0, nil, ReasonConflictCardMismatch
		}
		changes = append(changes, Change{
			Kind: ChangeConflictTombstone, ConflictID: conflict.ConflictID,
			CardID: command.CardID, Revision: conflict.ServerRevision, OccurredAt: command.OccurredAt,
		})
	}
	return command.NextRevision, 0, changes, ""
}

func planDelete(command CommitCommand, snapshot Snapshot) (Revision, int64, []Change, RejectionReason) {
	if !validOccurred(command) {
		return 0, 0, nil, ReasonInvalidTimeline
	}
	if snapshot.Card == nil {
		return 0, 0, nil, ReasonMissingCard
	}
	if command.ExpectedRevision == nil || snapshot.Card.CardID != command.CardID || snapshot.Card.Revision != *command.ExpectedRevision {
		return 0, 0, nil, ReasonStaleRevision
	}
	if int64(command.NextRevision) != int64(snapshot.Card.Revision)+1 {
		return 0, 0, nil, ReasonInvalidNextRevision
	}
	if command.OccurredAt < snapshot.Card.UpdatedAt {
		return 0, 0, nil, ReasonInvalidTimeline
	}
	conflicts := append([]ConflictHead(nil), snapshot.AllCardConflicts...)
	sort.Slice(conflicts, func(left, right int) bool { return conflicts[left].ConflictID < conflicts[right].ConflictID })
	changes := make([]Change, 0, len(conflicts)+1)
	for _, conflict := range conflicts {
		if conflict.CardID != command.CardID {
			return 0, 0, nil, ReasonConflictCardMismatch
		}
		changes = append(changes, Change{
			Kind: ChangeConflictTombstone, ConflictID: conflict.ConflictID,
			CardID: command.CardID, Revision: conflict.ServerRevision, OccurredAt: command.OccurredAt,
		})
	}
	changes = append(changes, Change{
		Kind: ChangeCardTombstone, CardID: command.CardID,
		Revision: command.NextRevision, OccurredAt: command.OccurredAt,
	})
	return command.NextRevision, 0, changes, ""
}

func validCommandBase(command CommitCommand) bool {
	if _, err := ParseMutationID(string(command.MutationID)); err != nil {
		return false
	}
	if _, err := ParseFingerprint(string(command.Fingerprint)); err != nil {
		return false
	}
	if _, err := ParseCardID(string(command.CardID)); err != nil {
		return false
	}
	return true
}

func validCommandShape(command CommitCommand) bool {
	validRevision := func(value Revision) bool {
		_, err := ParseRevision(int64(value))
		return err == nil
	}
	validOptionalRevision := func(value *Revision) bool {
		return value == nil || validRevision(*value)
	}
	switch command.Kind {
	case CommandCardUpsert:
		return command.ConflictID == "" && len(command.ConflictIDs) == 0 && command.ServerRevision == 0 &&
			validOptionalRevision(command.ExpectedRevision) && validRevision(command.NextRevision)
	case CommandConflictUpsert:
		_, err := ParseConflictID(string(command.ConflictID))
		return err == nil && command.ExpectedRevision == nil && command.NextRevision == 0 &&
			len(command.ConflictIDs) == 0 && validRevision(command.ServerRevision)
	case CommandResolveConflicts:
		if command.ConflictID != "" || command.ServerRevision != 0 || command.ExpectedRevision == nil ||
			!validRevision(*command.ExpectedRevision) ||
			!validRevision(command.NextRevision) || len(command.ConflictIDs) == 0 || len(command.ConflictIDs) > MaximumConflictIDs {
			return false
		}
		for _, conflictID := range command.ConflictIDs {
			if _, err := ParseConflictID(string(conflictID)); err != nil {
				return false
			}
		}
		return true
	case CommandCardDelete:
		return command.ConflictID == "" && len(command.ConflictIDs) == 0 && command.ServerRevision == 0 &&
			command.ExpectedRevision != nil && validRevision(*command.ExpectedRevision) && validRevision(command.NextRevision)
	default:
		return false
	}
}

func validOccurred(command CommitCommand) bool {
	return validTimestamp(command.OccurredAt) && command.CommittedAt >= command.OccurredAt
}

func validState(state State) bool {
	return state.NextDisplayID >= 1 && state.NextDisplayID <= MaximumDisplayID &&
		state.NextSequence >= 1 && int64(state.NextSequence) <= MaximumSafeInteger
}

func validChange(change Change) bool {
	if change.Sequence < 1 || !validTimestamp(change.OccurredAt) {
		return false
	}
	if _, err := ParseCardID(string(change.CardID)); err != nil {
		return false
	}
	if _, err := ParseRevision(int64(change.Revision)); err != nil {
		return false
	}
	switch change.Kind {
	case ChangeCardUpsert:
		return change.ConflictID == "" && change.OfficialDisplayID >= 1 && change.OfficialDisplayID <= MaximumDisplayID
	case ChangeCardTombstone:
		return change.ConflictID == "" && change.OfficialDisplayID == 0
	case ChangeConflictUpsert, ChangeConflictTombstone:
		_, err := ParseConflictID(string(change.ConflictID))
		return err == nil && change.OfficialDisplayID == 0
	default:
		return false
	}
}

func validTimestamp(value int64) bool {
	return value >= 0 && value <= MaximumSafeInteger
}

func rejected(reason RejectionReason) CommitPlan {
	return CommitPlan{Kind: PlanRejected, Reason: reason}
}
