package syncv2

import (
	"context"
	"errors"
	"sort"

	"github.com/fukamu/notes/backend/internal/encryptedobject"
	"github.com/fukamu/notes/backend/internal/entitlement"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/quota"
)

const maximumJournalCommitAttempts = 3

var ErrInvalidApplicationConfiguration = errors.New("invalid Sync v2 application configuration")

type CursorPort interface {
	Issue(CursorClaims) (Cursor, error)
	Verify(Cursor) (CursorClaims, error)
}

type ApplicationRejectionReason string

const (
	ApplicationInvalidCursor            ApplicationRejectionReason = "invalid-cursor"
	ApplicationScopeUnavailable         ApplicationRejectionReason = "scope-unavailable"
	ApplicationIdempotencyKeyReuse      ApplicationRejectionReason = "idempotency-key-reuse"
	ApplicationMutationConflict         ApplicationRejectionReason = "mutation-conflict"
	ApplicationRequestLimit             ApplicationRejectionReason = "request-limit"
	ApplicationDisplayCharacterLimit    ApplicationRejectionReason = "display-character-limit"
	ApplicationSerializedPlaintextLimit ApplicationRejectionReason = "serialized-plaintext-limit"
	ApplicationCiphertextLimit          ApplicationRejectionReason = "ciphertext-limit"
	ApplicationActiveCardLimit          ApplicationRejectionReason = "active-card-limit"
	ApplicationVaultPlaintextLimit      ApplicationRejectionReason = "vault-plaintext-limit"
	ApplicationQuotaUnavailable         ApplicationRejectionReason = "quota-unavailable"
)

type ApplicationResultKind string

const (
	ApplicationSynchronized ApplicationResultKind = "synchronized"
	ApplicationRejected     ApplicationResultKind = "rejected"
)

type ApplicationResult struct {
	Kind     ApplicationResultKind
	Reason   ApplicationRejectionReason
	Response Response
}

type SynchronizeInput struct {
	Context        identity.VaultContext
	Request        Request
	SynchronizedAt int64
	RequestBytes   int64
	Limits         entitlement.PersonalVaultLimits
}

type DeleteCardInput struct {
	Context          identity.VaultContext
	MutationID       MutationID
	CardID           CardID
	ExpectedRevision Revision
	DeletedAt        int64
	SynchronizedAt   int64
	Limits           entitlement.PersonalVaultLimits
}

type DeleteCardResultKind string

const (
	DeleteCardDeleted  DeleteCardResultKind = "deleted"
	DeleteCardRejected DeleteCardResultKind = "rejected"
)

type DeleteCardResult struct {
	Kind    DeleteCardResultKind
	Reason  ApplicationRejectionReason
	Receipt MutationReceipt
}

type Application struct {
	journals                  Directory
	contents                  ContentDirectory
	cursors                   CursorPort
	quotas                    quota.Directory
	reservationReconcileDelay int64
}

func NewApplication(
	journals Directory,
	contents ContentDirectory,
	cursors CursorPort,
	quotas quota.Directory,
	reservationReconcileDelay int64,
) (*Application, error) {
	if journals == nil || contents == nil || cursors == nil || quotas == nil ||
		reservationReconcileDelay <= 0 || reservationReconcileDelay > MaximumSafeInteger {
		return nil, ErrInvalidApplicationConfiguration
	}
	return &Application{
		journals: journals, contents: contents, cursors: cursors, quotas: quotas,
		reservationReconcileDelay: reservationReconcileDelay,
	}, nil
}

func (application *Application) Synchronize(
	ctx context.Context,
	input SynchronizeInput,
) (ApplicationResult, error) {
	if !application.valid() || !validSynchronizeInput(input) {
		return rejectedApplication(ApplicationScopeUnavailable), nil
	}
	after, high, cursorAccepted := application.resolveCursor(input.Context, input.Request)
	if !cursorAccepted {
		return rejectedApplication(ApplicationInvalidCursor), nil
	}

	journalScope, err := application.journals.Open(ctx, input.Context)
	if err != nil {
		return ApplicationResult{}, err
	}
	if journalScope.Kind != JournalOpened || journalScope.Repository == nil {
		return rejectedApplication(ApplicationScopeUnavailable), nil
	}
	contentScope, err := application.contents.Open(ctx, input.Context)
	if err != nil {
		return ApplicationResult{}, err
	}
	if contentScope.Kind != ContentOpened || contentScope.Repository == nil {
		return rejectedApplication(ApplicationScopeUnavailable), nil
	}
	quotaScope, err := application.quotas.Open(ctx, input.Context, input.SynchronizedAt)
	if err != nil {
		return ApplicationResult{}, err
	}
	if quotaScope.Kind != quota.LedgerOpened || quotaScope.Ledger == nil {
		return rejectedApplication(ApplicationScopeUnavailable), nil
	}

	ordered := append([]Mutation(nil), input.Request.Mutations...)
	sort.Slice(ordered, func(left, right int) bool {
		if ordered[left].CardID != ordered[right].CardID {
			return ordered[left].CardID < ordered[right].CardID
		}
		return ordered[left].MutationID < ordered[right].MutationID
	})
	receipts := make([]MutationReceipt, 0, len(ordered))
	for _, mutation := range ordered {
		applied, err := application.applyMutation(
			ctx, journalScope.Repository, contentScope.Repository, quotaScope.Ledger,
			mutation, input.SynchronizedAt, input.RequestBytes, input.Limits,
		)
		if err != nil {
			return ApplicationResult{}, err
		}
		if applied.Reason != "" {
			return rejectedApplication(applied.Reason), nil
		}
		receipts = append(receipts, toMutationReceipt(applied.Receipt))
	}

	page, err := journalScope.Repository.ReadPage(ctx, after, high, MaximumPageSize)
	if err != nil {
		return ApplicationResult{}, err
	}
	changes := make([]HydratedChange, 0, len(page.Changes))
	for _, change := range page.Changes {
		hydrated, err := hydrateChange(ctx, contentScope.Repository, change)
		if err != nil {
			return ApplicationResult{}, err
		}
		if hydrated == nil {
			return rejectedApplication(ApplicationScopeUnavailable), nil
		}
		changes = append(changes, *hydrated)
	}
	nextCursor, err := application.cursors.Issue(CursorClaims{
		Version: CursorVersion, VaultID: input.Context.VaultID, DeviceID: input.Request.DeviceID,
		AfterSequence: page.AfterSequence, HighWatermark: page.HighWatermark,
	})
	if err != nil {
		return ApplicationResult{}, err
	}
	response := Response{
		Version: ProtocolVersion, HighWatermark: page.HighWatermark,
		Changes: changes, Receipts: receipts,
		Page: ResponsePage{Kind: page.Kind, NextCursor: nextCursor},
	}
	if err := ValidateResponse(response); err != nil {
		return ApplicationResult{}, ErrInvalidResponse
	}
	return ApplicationResult{Kind: ApplicationSynchronized, Response: response}, nil
}

func (application *Application) DeleteCard(
	ctx context.Context,
	input DeleteCardInput,
) (DeleteCardResult, error) {
	if !application.valid() || !validDeleteCardInput(input) {
		return rejectedDelete(ApplicationScopeUnavailable), nil
	}
	journalScope, err := application.journals.Open(ctx, input.Context)
	if err != nil {
		return DeleteCardResult{}, err
	}
	contentScope, err := application.contents.Open(ctx, input.Context)
	if err != nil {
		return DeleteCardResult{}, err
	}
	quotaScope, err := application.quotas.Open(ctx, input.Context, input.SynchronizedAt)
	if err != nil {
		return DeleteCardResult{}, err
	}
	if journalScope.Kind != JournalOpened || journalScope.Repository == nil ||
		contentScope.Kind != ContentOpened || contentScope.Repository == nil ||
		quotaScope.Kind != quota.LedgerOpened || quotaScope.Ledger == nil {
		return rejectedDelete(ApplicationScopeUnavailable), nil
	}
	canonical, err := CanonicalizeCardDeletion(
		input.MutationID, input.CardID, input.ExpectedRevision, input.DeletedAt,
	)
	if err != nil {
		return rejectedDelete(ApplicationMutationConflict), nil
	}
	fingerprint := FingerprintCanonical(canonical)
	existing, err := journalScope.Repository.FindReceipt(ctx, input.MutationID)
	if err != nil {
		return DeleteCardResult{}, err
	}
	if existing != nil {
		if existing.Fingerprint != fingerprint {
			return rejectedDelete(ApplicationIdempotencyKeyReuse), nil
		}
		reason, err := finalizeQuota(
			ctx, quotaScope.Ledger, input.MutationID, fingerprint, input.Limits, input.SynchronizedAt,
		)
		if err != nil {
			return DeleteCardResult{}, err
		}
		if reason != "" {
			return rejectedDelete(reason), nil
		}
		return DeleteCardResult{Kind: DeleteCardDeleted, Receipt: toMutationReceipt(*existing)}, nil
	}
	current, err := journalScope.Repository.FindCard(ctx, input.CardID)
	if err != nil {
		return DeleteCardResult{}, err
	}
	if current == nil || current.Revision != input.ExpectedRevision {
		return rejectedDelete(ApplicationMutationConflict), nil
	}
	currentContent, err := contentScope.Repository.ReadCard(ctx, input.CardID, input.ExpectedRevision)
	if err != nil {
		return DeleteCardResult{}, err
	}
	if currentContent == nil {
		return rejectedDelete(ApplicationScopeUnavailable), nil
	}
	encoded, err := EncodeStoredCard(*currentContent)
	if err != nil {
		return rejectedDelete(ApplicationScopeUnavailable), nil
	}
	reconcileAfter, ok := safeReconcileAfter(input.SynchronizedAt, application.reservationReconcileDelay)
	if !ok {
		return rejectedDelete(ApplicationQuotaUnavailable), nil
	}
	reserved, err := quotaScope.Ledger.Reserve(ctx, quota.ReservationCommand{
		ReservationID: quota.ReservationID(input.MutationID), Fingerprint: quota.Fingerprint(fingerprint),
		CardID: quota.CardID(input.CardID),
		Change: quota.Change{Kind: quota.ChangeDelete, CurrentPlaintextBytes: int64(len(encoded))},
		Limits: input.Limits, RequestedAt: input.SynchronizedAt, ReconcileAfter: reconcileAfter,
	})
	clear(encoded)
	if err != nil {
		return DeleteCardResult{}, err
	}
	if reason := mapQuotaReservation(reserved); reason != "" {
		return rejectedDelete(reason), nil
	}
	if input.ExpectedRevision >= Revision(MaximumRevision) {
		return rejectedDelete(ApplicationMutationConflict), nil
	}
	nextRevision := Revision(int64(input.ExpectedRevision) + 1)
	command := CommitCommand{
		Kind: CommandCardDelete, MutationID: input.MutationID, Fingerprint: fingerprint,
		CommittedAt: input.SynchronizedAt, CardID: input.CardID,
		ExpectedRevision: revisionPointer(input.ExpectedRevision), NextRevision: nextRevision,
		OccurredAt: input.DeletedAt,
	}
	committed, reason, err := commitJournal(ctx, journalScope.Repository, command)
	if err != nil {
		return DeleteCardResult{}, err
	}
	if reason != "" {
		return rejectedDelete(reason), nil
	}
	reason, err = finalizeQuota(
		ctx, quotaScope.Ledger, input.MutationID, fingerprint, input.Limits, input.SynchronizedAt,
	)
	if err != nil {
		return DeleteCardResult{}, err
	}
	if reason != "" {
		return rejectedDelete(reason), nil
	}
	return DeleteCardResult{Kind: DeleteCardDeleted, Receipt: toMutationReceipt(committed)}, nil
}

type appliedMutation struct {
	Reason  ApplicationRejectionReason
	Receipt Receipt
}

func (application *Application) applyMutation(
	ctx context.Context,
	journal Repository,
	content ContentRepository,
	ledger quota.Ledger,
	mutation Mutation,
	synchronizedAt int64,
	requestBytes int64,
	limits entitlement.PersonalVaultLimits,
) (appliedMutation, error) {
	canonical, err := CanonicalizeMutation(mutation)
	if err != nil {
		return appliedMutation{Reason: ApplicationMutationConflict}, nil
	}
	fingerprint := FingerprintCanonical(canonical)
	existing, err := journal.FindReceipt(ctx, mutation.MutationID)
	if err != nil {
		return appliedMutation{}, err
	}
	if existing != nil {
		if existing.Fingerprint != fingerprint {
			return appliedMutation{Reason: ApplicationIdempotencyKeyReuse}, nil
		}
		reason, err := finalizeQuota(ctx, ledger, mutation.MutationID, fingerprint, limits, synchronizedAt)
		if err != nil {
			return appliedMutation{}, err
		}
		return appliedMutation{Reason: reason, Receipt: *existing}, nil
	}
	current, err := journal.FindCard(ctx, mutation.CardID)
	if err != nil {
		return appliedMutation{}, err
	}
	var currentContent *StoredCard
	plan := PlanMutation(mutation, current, nil)
	if plan.Kind == MutationPlanNeedsContent {
		currentContent, err = content.ReadCard(ctx, mutation.CardID, plan.RequiredRevision)
		if err != nil {
			return appliedMutation{}, err
		}
		if currentContent == nil {
			return appliedMutation{Reason: ApplicationScopeUnavailable}, nil
		}
		plan = PlanMutation(mutation, current, currentContent)
	}
	if plan.Kind == MutationPlanNeedsContent {
		return appliedMutation{Reason: ApplicationScopeUnavailable}, nil
	}
	if plan.Kind == MutationPlanRejected {
		return appliedMutation{Reason: ApplicationMutationConflict}, nil
	}
	quotaCommand, reason := prepareQuotaReservation(
		mutation, plan, currentContent, requestBytes, limits, synchronizedAt,
		application.reservationReconcileDelay, fingerprint,
	)
	if reason != "" {
		return appliedMutation{Reason: reason}, nil
	}
	reserved, err := ledger.Reserve(ctx, quotaCommand)
	if err != nil {
		return appliedMutation{}, err
	}
	if reason := mapQuotaReservation(reserved); reason != "" {
		return appliedMutation{Reason: reason}, nil
	}
	written, err := writeMutationContent(ctx, content, mutation, plan, synchronizedAt)
	if err != nil {
		return appliedMutation{}, err
	}
	if written.Kind == ContentNotApplied {
		switch written.Reason {
		case encryptedobject.ReasonIdempotencyKeyReuse:
			return appliedMutation{Reason: ApplicationIdempotencyKeyReuse}, nil
		case encryptedobject.ReasonCiphertextLimit:
			return appliedMutation{Reason: ApplicationCiphertextLimit}, nil
		default:
			return appliedMutation{Reason: ApplicationMutationConflict}, nil
		}
	}
	command, ok := journalCommand(mutation, plan, fingerprint, synchronizedAt)
	if !ok {
		return appliedMutation{Reason: ApplicationMutationConflict}, nil
	}
	committed, reason, err := commitJournal(ctx, journal, command)
	if err != nil {
		return appliedMutation{}, err
	}
	if reason != "" {
		return appliedMutation{Reason: reason}, nil
	}
	reason, err = finalizeQuota(ctx, ledger, mutation.MutationID, fingerprint, limits, synchronizedAt)
	if err != nil {
		return appliedMutation{}, err
	}
	return appliedMutation{Reason: reason, Receipt: committed}, nil
}

func prepareQuotaReservation(
	mutation Mutation,
	plan MutationPlan,
	currentContent *StoredCard,
	requestBytes int64,
	limits entitlement.PersonalVaultLimits,
	requestedAt int64,
	reconcileDelay int64,
	fingerprint Fingerprint,
) (quota.ReservationCommand, ApplicationRejectionReason) {
	displaySegments := make([]quota.DisplaySegment, len(mutation.Body))
	for index, segment := range mutation.Body {
		displaySegments[index] = quota.DisplaySegment{Kind: quota.SegmentKind(segment.Kind), Text: segment.Text}
	}
	displayCharacters, ok := quota.CountDisplayCharacters(mutation.Title, displaySegments)
	if !ok {
		return quota.ReservationCommand{}, ApplicationDisplayCharacterLimit
	}
	var serialized []byte
	var err error
	if plan.Kind == MutationPlanWriteCard {
		serialized, err = EncodeStoredCard(plan.Card)
	} else {
		serialized, err = EncodeStoredConflict(plan.Conflict)
	}
	if err != nil {
		return quota.ReservationCommand{}, ApplicationScopeUnavailable
	}
	nextBytes := int64(len(serialized))
	clear(serialized)
	evaluation := quota.EvaluateBoundaries(quota.BoundaryMeasurement{
		DisplayCharacters: displayCharacters, SerializedPlaintextBytes: nextBytes,
		CiphertextBytes: 0, RequestBytes: requestBytes,
	}, limits)
	if !evaluation.Accepted {
		for _, rejected := range evaluation.Reasons {
			switch rejected {
			case quota.BoundaryRequestLimit:
				return quota.ReservationCommand{}, ApplicationRequestLimit
			case quota.BoundaryDisplayCharacterLimit:
				return quota.ReservationCommand{}, ApplicationDisplayCharacterLimit
			case quota.BoundarySerializedPlaintextLimit:
				return quota.ReservationCommand{}, ApplicationSerializedPlaintextLimit
			case quota.BoundaryCiphertextLimit:
				continue
			}
		}
	}
	reconcileAfter, ok := safeReconcileAfter(requestedAt, reconcileDelay)
	if !ok {
		return quota.ReservationCommand{}, ApplicationQuotaUnavailable
	}
	currentBytes := int64(0)
	if currentContent != nil {
		encoded, err := EncodeStoredCard(*currentContent)
		if err != nil {
			return quota.ReservationCommand{}, ApplicationScopeUnavailable
		}
		currentBytes = int64(len(encoded))
		clear(encoded)
	}
	var change quota.Change
	switch plan.Kind {
	case MutationPlanWriteConflict:
		if currentContent == nil {
			return quota.ReservationCommand{}, ApplicationScopeUnavailable
		}
		change = quota.Change{
			Kind: quota.ChangeUpdate, CurrentPlaintextBytes: currentBytes, NextPlaintextBytes: currentBytes,
		}
	case MutationPlanWriteCard:
		if plan.ExpectedRevision == nil {
			change = quota.Change{Kind: quota.ChangeCreate, NextPlaintextBytes: nextBytes}
		} else {
			if currentContent == nil {
				return quota.ReservationCommand{}, ApplicationScopeUnavailable
			}
			change = quota.Change{
				Kind: quota.ChangeUpdate, CurrentPlaintextBytes: currentBytes, NextPlaintextBytes: nextBytes,
			}
		}
	default:
		return quota.ReservationCommand{}, ApplicationMutationConflict
	}
	return quota.ReservationCommand{
		ReservationID: quota.ReservationID(mutation.MutationID), Fingerprint: quota.Fingerprint(fingerprint),
		CardID: quota.CardID(mutation.CardID), Change: change, Limits: limits,
		RequestedAt: requestedAt, ReconcileAfter: reconcileAfter,
	}, ""
}

func mapQuotaReservation(result quota.ReservationResult) ApplicationRejectionReason {
	if (result.Kind == quota.ReservationApplied || result.Kind == quota.ReservationReplayed) &&
		result.Reservation != nil && result.Reservation.State.Kind == quota.ReservationReserved {
		return ""
	}
	if result.Kind != quota.ReservationRejected {
		return ApplicationQuotaUnavailable
	}
	switch result.Reason {
	case quota.RejectionIdempotencyKeyReuse:
		return ApplicationIdempotencyKeyReuse
	case quota.RejectionActiveCardLimit:
		return ApplicationActiveCardLimit
	case quota.RejectionVaultPlaintextLimit:
		return ApplicationVaultPlaintextLimit
	default:
		return ApplicationQuotaUnavailable
	}
}

func finalizeQuota(
	ctx context.Context,
	ledger quota.Ledger,
	mutationID MutationID,
	fingerprint Fingerprint,
	limits entitlement.PersonalVaultLimits,
	finalizedAt int64,
) (ApplicationRejectionReason, error) {
	result, err := ledger.Finalize(ctx, quota.FinalizationCommand{
		ReservationID: quota.ReservationID(mutationID), Fingerprint: quota.Fingerprint(fingerprint),
		Outcome: quota.FinalizationCommit, Limits: limits, FinalizedAt: finalizedAt,
	})
	if err != nil {
		return "", err
	}
	if result.Kind == quota.FinalizationCommitted || result.Kind == quota.FinalizationReplayed &&
		result.Reservation != nil && result.Reservation.State.Kind == quota.ReservationCommitted {
		return "", nil
	}
	if result.Kind == quota.FinalizationRejected && result.Reason == quota.RejectionIdempotencyKeyReuse {
		return ApplicationIdempotencyKeyReuse, nil
	}
	return ApplicationQuotaUnavailable, nil
}

func writeMutationContent(
	ctx context.Context,
	content ContentRepository,
	mutation Mutation,
	plan MutationPlan,
	writtenAt int64,
) (ContentWriteResult, error) {
	switch plan.Kind {
	case MutationPlanWriteCard:
		return content.WriteCard(
			ctx, mutation.CardID, plan.ExpectedRevision, plan.NextRevision,
			mutation.MutationID, plan.Card, writtenAt,
		)
	case MutationPlanWriteConflict:
		return content.WriteConflict(
			ctx, plan.ConflictID, mutation.MutationID, plan.Conflict, writtenAt,
		)
	default:
		return ContentWriteResult{Kind: ContentNotApplied}, nil
	}
}

func journalCommand(
	mutation Mutation,
	plan MutationPlan,
	fingerprint Fingerprint,
	committedAt int64,
) (CommitCommand, bool) {
	switch plan.Kind {
	case MutationPlanWriteConflict:
		return CommitCommand{
			Kind: CommandConflictUpsert, MutationID: mutation.MutationID, Fingerprint: fingerprint,
			CommittedAt: committedAt, CardID: mutation.CardID, ConflictID: plan.ConflictID,
			ServerRevision: plan.ServerRevision, OccurredAt: plan.Conflict.CreatedAt,
		}, true
	case MutationPlanWriteCard:
		kind := CommandCardUpsert
		conflicts := []ConflictID(nil)
		if mutation.Kind == MutationResolve {
			if plan.ExpectedRevision == nil {
				return CommitCommand{}, false
			}
			kind = CommandResolveConflicts
			conflicts = append([]ConflictID(nil), mutation.ConflictIDs...)
		}
		return CommitCommand{
			Kind: kind, MutationID: mutation.MutationID, Fingerprint: fingerprint,
			CommittedAt: committedAt, CardID: mutation.CardID,
			ExpectedRevision: copyRevisionPointer(plan.ExpectedRevision), NextRevision: plan.NextRevision,
			OccurredAt: plan.Card.UpdatedAt, ConflictIDs: conflicts,
		}, true
	default:
		return CommitCommand{}, false
	}
}

func commitJournal(
	ctx context.Context,
	repository Repository,
	command CommitCommand,
) (Receipt, ApplicationRejectionReason, error) {
	for attempt := 0; attempt < maximumJournalCommitAttempts; attempt++ {
		result, err := repository.Commit(ctx, command)
		if err != nil {
			return Receipt{}, "", err
		}
		if (result.Kind == CommitApplied || result.Kind == CommitReplayed) && result.Receipt != nil {
			return *result.Receipt, "", nil
		}
		if result.Reason == ReasonCASConflict && attempt+1 < maximumJournalCommitAttempts {
			continue
		}
		if result.Reason == ReasonIdempotencyKeyReuse {
			return Receipt{}, ApplicationIdempotencyKeyReuse, nil
		}
		return Receipt{}, ApplicationMutationConflict, nil
	}
	return Receipt{}, ApplicationMutationConflict, nil
}

func hydrateChange(
	ctx context.Context,
	content ContentRepository,
	change Change,
) (*HydratedChange, error) {
	var card *StoredCard
	var conflict *StoredConflict
	var err error
	switch change.Kind {
	case ChangeCardUpsert:
		card, err = content.ReadCard(ctx, change.CardID, change.Revision)
	case ChangeConflictUpsert:
		conflict, err = content.ReadConflict(ctx, change.ConflictID)
	}
	if err != nil {
		return nil, err
	}
	hydrated, ok := HydrateJournalChange(change, card, conflict)
	if !ok {
		return nil, nil
	}
	return &hydrated, nil
}

func (application *Application) resolveCursor(
	vaultContext identity.VaultContext,
	request Request,
) (Sequence, *Sequence, bool) {
	if request.Cursor == nil {
		return 0, nil, true
	}
	claims, err := application.cursors.Verify(*request.Cursor)
	if err != nil || claims.VaultID != vaultContext.VaultID || claims.DeviceID != request.DeviceID {
		return 0, nil, false
	}
	if claims.AfterSequence == claims.HighWatermark {
		return claims.AfterSequence, nil, true
	}
	high := claims.HighWatermark
	return claims.AfterSequence, &high, true
}

func (application *Application) valid() bool {
	return application != nil && application.journals != nil && application.contents != nil &&
		application.cursors != nil && application.quotas != nil &&
		application.reservationReconcileDelay > 0 && application.reservationReconcileDelay <= MaximumSafeInteger
}

func validSynchronizeInput(input SynchronizeInput) bool {
	if !validVaultContext(input.Context) || !validTimestamp(input.SynchronizedAt) ||
		input.RequestBytes < 0 || input.RequestBytes > MaximumSafeInteger ||
		len(input.Request.Mutations) > MaximumMutations || input.Request.Mutations == nil ||
		!validLimits(input.Limits) {
		return false
	}
	if _, err := ParseDeviceID(string(input.Request.DeviceID)); err != nil {
		return false
	}
	if input.Request.Cursor != nil && !validCursor(*input.Request.Cursor) {
		return false
	}
	seen := make(map[MutationID]struct{}, len(input.Request.Mutations))
	for _, mutation := range input.Request.Mutations {
		if !validMutation(mutation) {
			return false
		}
		if _, duplicate := seen[mutation.MutationID]; duplicate {
			return false
		}
		seen[mutation.MutationID] = struct{}{}
	}
	return true
}

func validDeleteCardInput(input DeleteCardInput) bool {
	if !validVaultContext(input.Context) || !validTimestamp(input.DeletedAt) ||
		!validTimestamp(input.SynchronizedAt) || input.SynchronizedAt < input.DeletedAt ||
		!validLimits(input.Limits) {
		return false
	}
	if _, err := ParseMutationID(string(input.MutationID)); err != nil {
		return false
	}
	if _, err := ParseCardID(string(input.CardID)); err != nil {
		return false
	}
	_, err := ParseRevision(int64(input.ExpectedRevision))
	return err == nil
}

func validLimits(limits entitlement.PersonalVaultLimits) bool {
	return limits.ActiveCards >= 0 && limits.ActiveCards <= MaximumSafeInteger &&
		limits.DisplayCharactersPerCard >= 0 && limits.DisplayCharactersPerCard <= MaximumSafeInteger &&
		limits.SerializedPlaintextBytesPerCard >= 0 && limits.SerializedPlaintextBytesPerCard <= MaximumSafeInteger &&
		limits.PlaintextBytesPerVault >= 0 && limits.PlaintextBytesPerVault <= MaximumSafeInteger
}

func safeReconcileAfter(requestedAt, delay int64) (int64, bool) {
	if !validTimestamp(requestedAt) || delay <= 0 || delay > MaximumSafeInteger ||
		requestedAt > MaximumSafeInteger-delay {
		return 0, false
	}
	return requestedAt + delay, true
}

func toMutationReceipt(receipt Receipt) MutationReceipt {
	return MutationReceipt{
		MutationID: receipt.MutationID, CardID: receipt.CardID,
		AppliedRevision: receipt.AppliedRevision,
	}
}

func rejectedApplication(reason ApplicationRejectionReason) ApplicationResult {
	return ApplicationResult{Kind: ApplicationRejected, Reason: reason}
}

func rejectedDelete(reason ApplicationRejectionReason) DeleteCardResult {
	return DeleteCardResult{Kind: DeleteCardRejected, Reason: reason}
}

func revisionPointer(value Revision) *Revision {
	copy := value
	return &copy
}

func copyRevisionPointer(value *Revision) *Revision {
	if value == nil {
		return nil
	}
	return revisionPointer(*value)
}
