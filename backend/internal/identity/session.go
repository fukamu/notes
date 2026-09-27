package identity

type SessionKind string

const (
	SessionActive  SessionKind = "active"
	SessionRevoked SessionKind = "revoked"
)

type RevocationReason string

const (
	RevocationLogout   RevocationReason = "logout"
	RevocationRotated  RevocationReason = "rotated"
	RevocationSecurity RevocationReason = "security"
)

type Session struct {
	Kind             SessionKind
	SessionID        SessionID
	AccountID        AccountID
	VaultID          VaultID
	SessionEpoch     SessionEpoch
	IssuedAt         int64
	ExpiresAt        int64
	RevokedAt        int64
	RevocationReason RevocationReason
}

type VaultContext struct {
	AccountID    AccountID
	VaultID      VaultID
	SessionID    SessionID
	SessionEpoch SessionEpoch
}

type SessionInput struct {
	SessionID    SessionID
	AccountID    AccountID
	VaultID      VaultID
	SessionEpoch SessionEpoch
	IssuedAt     int64
	ExpiresAt    int64
}

type CreateReason string

const (
	CreateInvalidLifetime CreateReason = "invalid-lifetime"
	CreateInvalidSession  CreateReason = "invalid-session"
)

type CreateDecision struct {
	Created bool
	Reason  CreateReason
	Session Session
}

func CreateActiveSession(input SessionInput) CreateDecision {
	session := Session{
		Kind:         SessionActive,
		SessionID:    input.SessionID,
		AccountID:    input.AccountID,
		VaultID:      input.VaultID,
		SessionEpoch: input.SessionEpoch,
		IssuedAt:     input.IssuedAt,
		ExpiresAt:    input.ExpiresAt,
	}
	if !validTimestamp(input.IssuedAt) || !validTimestamp(input.ExpiresAt) ||
		input.ExpiresAt <= input.IssuedAt {
		return CreateDecision{Reason: CreateInvalidLifetime}
	}
	if !validSessionIdentifiers(session) {
		return CreateDecision{Reason: CreateInvalidSession}
	}
	return CreateDecision{Created: true, Session: session}
}

type AccessKind string
type AccessReason string

const (
	AccessAnonymous     AccessKind = "anonymous"
	AccessDenied        AccessKind = "denied"
	AccessAuthenticated AccessKind = "authenticated"

	AccessMissingSession AccessReason = "missing-session"
	AccessInvalidSession AccessReason = "invalid-session"
	AccessRevoked        AccessReason = "revoked"
	AccessExpired        AccessReason = "expired"
	AccessInvalidClock   AccessReason = "invalid-clock"
)

type AccessDecision struct {
	Kind    AccessKind
	Reason  AccessReason
	Context VaultContext
}

func AuthorizeSession(session *Session, now int64) AccessDecision {
	if session == nil {
		return AccessDecision{Kind: AccessAnonymous, Reason: AccessMissingSession}
	}
	if !validTimestamp(now) {
		return AccessDecision{Kind: AccessDenied, Reason: AccessInvalidClock}
	}
	if !ValidSession(*session) {
		return AccessDecision{Kind: AccessDenied, Reason: AccessInvalidSession}
	}
	if session.Kind == SessionRevoked {
		return AccessDecision{Kind: AccessDenied, Reason: AccessRevoked}
	}
	if now >= session.ExpiresAt {
		return AccessDecision{Kind: AccessDenied, Reason: AccessExpired}
	}
	return AccessDecision{
		Kind: AccessAuthenticated,
		Context: VaultContext{
			AccountID:    session.AccountID,
			VaultID:      session.VaultID,
			SessionID:    session.SessionID,
			SessionEpoch: session.SessionEpoch,
		},
	}
}

type RotationInput struct {
	NextSessionID    SessionID
	NextSessionEpoch SessionEpoch
	CurrentToken     SessionToken
	NextToken        SessionToken
	RotatedAt        int64
	ExpiresAt        int64
}

type RotationReason string

const (
	RotationExpired             RotationReason = "expired"
	RotationSessionIDReused     RotationReason = "session-id-reused"
	RotationSessionTokenReused  RotationReason = "session-token-reused"
	RotationEpochNotIncremented RotationReason = "epoch-not-incremented"
	RotationInvalidLifetime     RotationReason = "invalid-lifetime"
	RotationInvalidSession      RotationReason = "invalid-session"
)

type RotationDecision struct {
	Rotated   bool
	Reason    RotationReason
	Previous  Session
	Current   Session
	NextToken SessionToken
}

func RotateSession(session Session, input RotationInput) RotationDecision {
	if !ValidSession(session) || session.Kind != SessionActive ||
		!validSessionID(input.NextSessionID) || !validEpoch(input.NextSessionEpoch) ||
		!validToken(input.CurrentToken) || !validToken(input.NextToken) {
		return RotationDecision{Reason: RotationInvalidSession}
	}
	if input.RotatedAt >= session.ExpiresAt {
		return RotationDecision{Reason: RotationExpired}
	}
	if input.NextSessionID == session.SessionID {
		return RotationDecision{Reason: RotationSessionIDReused}
	}
	if input.NextToken == input.CurrentToken {
		return RotationDecision{Reason: RotationSessionTokenReused}
	}
	if int64(input.NextSessionEpoch) != int64(session.SessionEpoch)+1 {
		return RotationDecision{Reason: RotationEpochNotIncremented}
	}
	if !validTimestamp(input.RotatedAt) || !validTimestamp(input.ExpiresAt) ||
		input.RotatedAt < session.IssuedAt || input.ExpiresAt <= input.RotatedAt {
		return RotationDecision{Reason: RotationInvalidLifetime}
	}
	previous := session
	previous.Kind = SessionRevoked
	previous.RevokedAt = input.RotatedAt
	previous.RevocationReason = RevocationRotated
	current := Session{
		Kind:         SessionActive,
		SessionID:    input.NextSessionID,
		AccountID:    session.AccountID,
		VaultID:      session.VaultID,
		SessionEpoch: input.NextSessionEpoch,
		IssuedAt:     input.RotatedAt,
		ExpiresAt:    input.ExpiresAt,
	}
	return RotationDecision{
		Rotated: true, Previous: previous, Current: current, NextToken: input.NextToken,
	}
}

type RevokeKind string
type RevokeReason string

const (
	RevokeApplied   RevokeKind = "revoked"
	RevokeUnchanged RevokeKind = "unchanged"
	RevokeRejected  RevokeKind = "rejected"

	RevokeInvalidTime    RevokeReason = "invalid-revocation-time"
	RevokeInvalidSession RevokeReason = "invalid-session"
)

type RevokeDecision struct {
	Kind    RevokeKind
	Reason  RevokeReason
	Session Session
}

func RevokeSession(
	session Session,
	revokedAt int64,
	reason RevocationReason,
) RevokeDecision {
	if !ValidSession(session) || (reason != RevocationLogout && reason != RevocationSecurity) {
		return RevokeDecision{Kind: RevokeRejected, Reason: RevokeInvalidSession}
	}
	if session.Kind == SessionRevoked {
		return RevokeDecision{Kind: RevokeUnchanged, Session: session}
	}
	if !validTimestamp(revokedAt) || revokedAt < session.IssuedAt {
		return RevokeDecision{Kind: RevokeRejected, Reason: RevokeInvalidTime}
	}
	session.Kind = SessionRevoked
	session.RevokedAt = revokedAt
	session.RevocationReason = reason
	return RevokeDecision{Kind: RevokeApplied, Session: session}
}

type VaultOperationReason string

const (
	VaultOperationRevoked         VaultOperationReason = "revoked"
	VaultOperationExpired         VaultOperationReason = "expired"
	VaultOperationInvalidClock    VaultOperationReason = "invalid-clock"
	VaultOperationInvalidSession  VaultOperationReason = "invalid-session"
	VaultOperationSessionMismatch VaultOperationReason = "session-mismatch"
	VaultOperationAccountMismatch VaultOperationReason = "account-mismatch"
	VaultOperationVaultMismatch   VaultOperationReason = "vault-mismatch"
	VaultOperationEpochMismatch   VaultOperationReason = "epoch-mismatch"
)

type VaultOperationDecision struct {
	Authorized bool
	Reason     VaultOperationReason
}

func AuthorizeVaultOperation(
	context VaultContext,
	current Session,
	now int64,
) VaultOperationDecision {
	access := AuthorizeSession(&current, now)
	if access.Kind != AccessAuthenticated {
		switch access.Reason {
		case AccessRevoked:
			return VaultOperationDecision{Reason: VaultOperationRevoked}
		case AccessExpired:
			return VaultOperationDecision{Reason: VaultOperationExpired}
		case AccessInvalidClock:
			return VaultOperationDecision{Reason: VaultOperationInvalidClock}
		default:
			return VaultOperationDecision{Reason: VaultOperationInvalidSession}
		}
	}
	if context.SessionID != access.Context.SessionID {
		return VaultOperationDecision{Reason: VaultOperationSessionMismatch}
	}
	if context.AccountID != access.Context.AccountID {
		return VaultOperationDecision{Reason: VaultOperationAccountMismatch}
	}
	if context.VaultID != access.Context.VaultID {
		return VaultOperationDecision{Reason: VaultOperationVaultMismatch}
	}
	if context.SessionEpoch != access.Context.SessionEpoch {
		return VaultOperationDecision{Reason: VaultOperationEpochMismatch}
	}
	return VaultOperationDecision{Authorized: true}
}

func ValidSession(session Session) bool {
	if !validSessionIdentifiers(session) || !validTimestamp(session.IssuedAt) ||
		!validTimestamp(session.ExpiresAt) || session.ExpiresAt <= session.IssuedAt {
		return false
	}
	switch session.Kind {
	case SessionActive:
		return session.RevokedAt == 0 && session.RevocationReason == ""
	case SessionRevoked:
		return validTimestamp(session.RevokedAt) && session.RevokedAt >= session.IssuedAt &&
			validRevocationReason(session.RevocationReason)
	default:
		return false
	}
}

func ValidRotation(decision RotationDecision) bool {
	if !decision.Rotated || !ValidSession(decision.Previous) || !ValidSession(decision.Current) ||
		decision.Previous.Kind != SessionRevoked || decision.Current.Kind != SessionActive ||
		decision.Previous.RevocationReason != RevocationRotated ||
		decision.Previous.RevokedAt != decision.Current.IssuedAt ||
		decision.Previous.RevokedAt >= decision.Previous.ExpiresAt ||
		decision.Previous.AccountID != decision.Current.AccountID ||
		decision.Previous.VaultID != decision.Current.VaultID ||
		int64(decision.Current.SessionEpoch) != int64(decision.Previous.SessionEpoch)+1 ||
		decision.Previous.SessionID == decision.Current.SessionID || !validToken(decision.NextToken) {
		return false
	}
	return true
}

func SessionMatchesContext(context VaultContext, session Session) bool {
	return context.AccountID == session.AccountID && context.VaultID == session.VaultID &&
		context.SessionID == session.SessionID && context.SessionEpoch == session.SessionEpoch
}

func validSessionIdentifiers(session Session) bool {
	return validAccountID(session.AccountID) && validVaultID(session.VaultID) &&
		validSessionID(session.SessionID) && validEpoch(session.SessionEpoch)
}

func validAccountID(value AccountID) bool {
	_, err := ParseAccountID(string(value))
	return err == nil
}

func validVaultID(value VaultID) bool {
	_, err := ParseVaultID(string(value))
	return err == nil
}

func validSessionID(value SessionID) bool {
	_, err := ParseSessionID(string(value))
	return err == nil
}

func validEpoch(value SessionEpoch) bool {
	_, err := ParseSessionEpoch(int64(value))
	return err == nil
}

func validToken(value SessionToken) bool {
	_, err := ParseSessionToken(string(value))
	return err == nil
}

func validRevocationReason(value RevocationReason) bool {
	return value == RevocationLogout || value == RevocationRotated || value == RevocationSecurity
}
