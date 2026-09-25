package legal

type SnapshotPlanKind string

const (
	SnapshotReady   SnapshotPlanKind = "ready"
	SnapshotInvalid SnapshotPlanKind = "invalid-terms"
)

type SnapshotPlan struct {
	Kind     SnapshotPlanKind
	Snapshot TermsSnapshot
}

func PlanTermsSnapshot(disclosure TermsDisclosure, termsHash TermsDocumentHash) SnapshotPlan {
	if _, err := ParseTermsDocumentHash(string(termsHash)); err != nil {
		return SnapshotPlan{Kind: SnapshotInvalid}
	}
	serialized, err := SerializeTermsDisclosure(disclosure)
	if err != nil {
		return SnapshotPlan{Kind: SnapshotInvalid}
	}
	snapshot := TermsSnapshot{
		TermsVersion: disclosure.TermsVersion, TermsHash: termsHash,
		Disclosure: cloneTermsDisclosure(disclosure), SerializedTerms: serialized,
	}
	if !ValidTermsSnapshot(snapshot) {
		return SnapshotPlan{Kind: SnapshotInvalid}
	}
	return SnapshotPlan{Kind: SnapshotReady, Snapshot: snapshot}
}

type ConsentPlanKind string

const (
	ConsentAppend ConsentPlanKind = "append"
	ConsentReplay ConsentPlanKind = "replay"
	ConsentReject ConsentPlanKind = "rejected"
)

type ConsentRejectionReason string

const (
	ConsentInvalidCommand     ConsentRejectionReason = "invalid-command"
	ConsentRequired           ConsentRejectionReason = "consent-required"
	ConsentStaleTerms         ConsentRejectionReason = "stale-terms"
	ConsentOwnerMismatch      ConsentRejectionReason = "owner-mismatch"
	ConsentIdentifierConflict ConsentRejectionReason = "identifier-conflict"
)

type ConsentPlan struct {
	Kind   ConsentPlanKind
	Record TermsConsentRecord
	Reason ConsentRejectionReason
}

func PlanTermsConsent(
	scope TermsScope,
	command TermsConsentCommand,
	snapshot TermsSnapshot,
	consentID TermsConsentID,
	acceptedAt int64,
	existing *TermsConsentRecord,
) ConsentPlan {
	if !ValidTermsScope(scope) || !validConsentCommand(command) || !ValidTermsSnapshot(snapshot) || !validTimestamp(acceptedAt) {
		return rejectedConsent(ConsentInvalidCommand)
	}
	if _, err := ParseTermsConsentID(string(consentID)); err != nil {
		return rejectedConsent(ConsentInvalidCommand)
	}
	if command.Consent != ConsentAffirmed {
		return rejectedConsent(ConsentRequired)
	}
	if command.PresentedTermsVersion != snapshot.TermsVersion || command.PresentedTermsHash != snapshot.TermsHash {
		return rejectedConsent(ConsentStaleTerms)
	}
	if existing != nil {
		if !ValidTermsConsentRecord(*existing) {
			return rejectedConsent(ConsentIdentifierConflict)
		}
		if existing.Scope != scope {
			return rejectedConsent(ConsentOwnerMismatch)
		}
		if !sameSubmissionPayload(*existing, command, snapshot) {
			return rejectedConsent(ConsentIdentifierConflict)
		}
		return ConsentPlan{Kind: ConsentReplay, Record: cloneTermsRecord(*existing)}
	}
	record := TermsConsentRecord{
		Scope: scope, ConsentID: consentID, SubmissionID: command.SubmissionID,
		Snapshot: cloneTermsSnapshot(snapshot), Consent: ConsentAffirmed, AcceptedAt: acceptedAt,
	}
	if !ValidTermsConsentRecord(record) {
		return rejectedConsent(ConsentInvalidCommand)
	}
	return ConsentPlan{Kind: ConsentAppend, Record: record}
}

type StatusPlanKind string

const (
	StatusResolved StatusPlanKind = "resolved"
	StatusRejected StatusPlanKind = "rejected"
)

type StatusRejectionReason string

const (
	StatusOwnerMismatch          StatusRejectionReason = "owner-mismatch"
	StatusClassificationRequired StatusRejectionReason = "classification-required"
	StatusInconsistentEvidence   StatusRejectionReason = "inconsistent-evidence"
)

type StatusPlan struct {
	Kind   StatusPlanKind
	Status TermsConsentStatus
	Reason StatusRejectionReason
}

func DecideTermsConsentStatus(
	scope TermsScope,
	current TermsSnapshot,
	latest *TermsConsentRecord,
	policy AcceptancePolicy,
) StatusPlan {
	if !ValidTermsScope(scope) || !ValidTermsSnapshot(current) || !ValidAcceptancePolicy(policy) {
		return StatusPlan{Kind: StatusRejected, Reason: StatusInconsistentEvidence}
	}
	currentRef := currentTermsReference(current)
	if latest == nil {
		return StatusPlan{Kind: StatusResolved, Status: TermsConsentStatus{
			Kind: TermsStatusCurrent, AcceptanceRequired: true, Current: currentRef,
		}}
	}
	if !ValidTermsConsentRecord(*latest) {
		return StatusPlan{Kind: StatusRejected, Reason: StatusInconsistentEvidence}
	}
	if latest.Scope != scope {
		return StatusPlan{Kind: StatusRejected, Reason: StatusOwnerMismatch}
	}
	sameVersion := latest.Snapshot.TermsVersion == current.TermsVersion
	sameHash := latest.Snapshot.TermsHash == current.TermsHash
	sameSnapshot := latest.Snapshot.SerializedTerms == current.SerializedTerms
	accepted := acceptedTermsReference(*latest)
	if sameVersion && sameHash && sameSnapshot {
		return resolvedAccepted(TermsStatusAccepted, false, currentRef, accepted)
	}
	if sameVersion || sameHash {
		return StatusPlan{Kind: StatusRejected, Reason: StatusInconsistentEvidence}
	}
	switch policy.Kind {
	case AcceptanceReconsentRequired:
		return resolvedAccepted(TermsStatusReconsentRequired, true, currentRef, accepted)
	case AcceptanceNoticeOnly:
		return resolvedAccepted(TermsStatusNoticeOnly, false, currentRef, accepted)
	default:
		return StatusPlan{Kind: StatusRejected, Reason: StatusClassificationRequired}
	}
}

func AcceptedTermsStatus(current TermsSnapshot, record TermsConsentRecord) StatusPlan {
	if !ValidTermsSnapshot(current) || !ValidTermsConsentRecord(record) ||
		record.Snapshot.TermsVersion != current.TermsVersion || record.Snapshot.TermsHash != current.TermsHash ||
		record.Snapshot.SerializedTerms != current.SerializedTerms {
		return StatusPlan{Kind: StatusRejected, Reason: StatusInconsistentEvidence}
	}
	return resolvedAccepted(TermsStatusAccepted, false, currentTermsReference(current), acceptedTermsReference(record))
}

func rejectedConsent(reason ConsentRejectionReason) ConsentPlan {
	return ConsentPlan{Kind: ConsentReject, Reason: reason}
}

func sameSubmissionPayload(existing TermsConsentRecord, command TermsConsentCommand, snapshot TermsSnapshot) bool {
	return existing.SubmissionID == command.SubmissionID && existing.Snapshot.TermsVersion == snapshot.TermsVersion &&
		existing.Snapshot.TermsHash == snapshot.TermsHash && existing.Snapshot.SerializedTerms == snapshot.SerializedTerms &&
		existing.Consent == ConsentAffirmed
}

func resolvedAccepted(kind TermsStatusKind, required bool, current CurrentTermsReference, accepted AcceptedTermsReference) StatusPlan {
	return StatusPlan{Kind: StatusResolved, Status: TermsConsentStatus{
		Kind: kind, AcceptanceRequired: required, Current: current, Accepted: &accepted,
	}}
}

func currentTermsReference(snapshot TermsSnapshot) CurrentTermsReference {
	return CurrentTermsReference{TermsVersion: snapshot.TermsVersion, TermsHash: snapshot.TermsHash, EffectiveDate: snapshot.Disclosure.EffectiveDate}
}

func acceptedTermsReference(record TermsConsentRecord) AcceptedTermsReference {
	return AcceptedTermsReference{
		ConsentID: record.ConsentID, TermsVersion: record.Snapshot.TermsVersion,
		TermsHash: record.Snapshot.TermsHash, AcceptedAt: record.AcceptedAt,
	}
}

func cloneTermsSnapshot(value TermsSnapshot) TermsSnapshot {
	value.Disclosure = cloneTermsDisclosure(value.Disclosure)
	return value
}

func cloneTermsRecord(value TermsConsentRecord) TermsConsentRecord {
	value.Snapshot = cloneTermsSnapshot(value.Snapshot)
	return value
}
