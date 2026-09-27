package identity

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

const (
	fixtureAccountID     = "01991f20-61d2-7000-8000-000000000101"
	fixtureOtherAccount  = "01991f20-61d2-7000-8000-000000000102"
	fixtureVaultID       = "01991f20-61d2-7000-8000-000000000201"
	fixtureOtherVault    = "01991f20-61d2-7000-8000-000000000202"
	fixtureSessionID     = "01991f20-61d2-7000-8000-000000000301"
	fixtureNextSessionID = "01991f20-61d2-7000-8000-000000000302"
)

func TestIdentityValues(t *testing.T) {
	t.Parallel()
	for _, parse := range []func(string) error{
		func(value string) error { _, err := ParseAccountID(value); return err },
		func(value string) error { _, err := ParseVaultID(value); return err },
		func(value string) error { _, err := ParseSessionID(value); return err },
		func(value string) error { _, err := ParseIdentityID(value); return err },
	} {
		if err := parse(fixtureAccountID); err != nil {
			t.Fatalf("valid UUIDv7 rejected: %v", err)
		}
		if err := parse("01991f20-61d2-4000-8000-000000000999"); err == nil {
			t.Fatal("UUIDv4 accepted as an identity identifier")
		}
	}
	for _, value := range []int64{0, -1, 2_147_483_648} {
		if _, err := ParseSessionEpoch(value); err == nil {
			t.Fatalf("invalid epoch %d accepted", value)
		}
	}
	token := mustToken(t, strings.Repeat("A", 43))
	hash, err := HashSessionToken(token)
	if err != nil {
		t.Fatalf("HashSessionToken() error = %v", err)
	}
	if string(hash) != "DwBzhbb51LfusnSGBa_hqYSgo7-j8BTQnip4TOnlzRo" {
		t.Fatalf("token hash = %q", hash)
	}
	for _, value := range []string{
		"short", strings.Repeat("A", 42), strings.Repeat("A", 42) + ";",
		strings.Repeat("A", 42) + "B",
	} {
		if _, err := ParseSessionToken(value); err == nil {
			t.Fatalf("invalid token %q accepted", value)
		}
	}
}

func TestSessionLifecycle(t *testing.T) {
	t.Parallel()
	active := fixtureSession(t)
	missing := AuthorizeSession(nil, 1_500)
	if missing.Kind != AccessAnonymous || missing.Reason != AccessMissingSession {
		t.Fatalf("missing access = %#v", missing)
	}
	access := AuthorizeSession(&active, 1_500)
	if access.Kind != AccessAuthenticated || access.Context.AccountID != active.AccountID ||
		access.Context.VaultID != active.VaultID || access.Context.SessionID != active.SessionID ||
		access.Context.SessionEpoch != active.SessionEpoch {
		t.Fatalf("active access = %#v", access)
	}
	if expired := AuthorizeSession(&active, active.ExpiresAt); expired.Reason != AccessExpired {
		t.Fatalf("expiry decision = %#v", expired)
	}
	if invalid := AuthorizeSession(&active, -1); invalid.Reason != AccessInvalidClock {
		t.Fatalf("invalid clock decision = %#v", invalid)
	}
	invalidCreate := CreateActiveSession(SessionInput{
		SessionID: active.SessionID, AccountID: active.AccountID, VaultID: active.VaultID,
		SessionEpoch: active.SessionEpoch, IssuedAt: 2_000, ExpiresAt: 2_000,
	})
	if invalidCreate.Created || invalidCreate.Reason != CreateInvalidLifetime {
		t.Fatalf("invalid create = %#v", invalidCreate)
	}

	rotation := RotateSession(active, RotationInput{
		NextSessionID:    mustSessionID(t, fixtureNextSessionID),
		NextSessionEpoch: mustEpoch(t, 2),
		CurrentToken:     mustToken(t, strings.Repeat("A", 43)),
		NextToken:        mustToken(t, strings.Repeat("B", 42)+"A"),
		RotatedAt:        1_500,
		ExpiresAt:        3_000,
	})
	if !rotation.Rotated || !ValidRotation(rotation) ||
		rotation.Previous.RevocationReason != RevocationRotated ||
		rotation.Current.SessionEpoch != 2 {
		t.Fatalf("rotation = %#v", rotation)
	}
	if decision := AuthorizeSession(&rotation.Previous, 1_600); decision.Reason != AccessRevoked {
		t.Fatalf("previous access = %#v", decision)
	}
	assertRotationReason(t, active, RotationInput{
		NextSessionID: active.SessionID, NextSessionEpoch: 2,
		CurrentToken: mustToken(t, strings.Repeat("A", 43)),
		NextToken:    mustToken(t, strings.Repeat("B", 42)+"A"), RotatedAt: 1_500, ExpiresAt: 3_000,
	}, RotationSessionIDReused)
	assertRotationReason(t, active, RotationInput{
		NextSessionID: mustSessionID(t, fixtureNextSessionID), NextSessionEpoch: 1,
		CurrentToken: mustToken(t, strings.Repeat("A", 43)),
		NextToken:    mustToken(t, strings.Repeat("B", 42)+"A"), RotatedAt: 1_500, ExpiresAt: 3_000,
	}, RotationEpochNotIncremented)
	assertRotationReason(t, active, RotationInput{
		NextSessionID: mustSessionID(t, fixtureNextSessionID), NextSessionEpoch: 2,
		CurrentToken: mustToken(t, strings.Repeat("A", 43)),
		NextToken:    mustToken(t, strings.Repeat("A", 43)), RotatedAt: 1_500, ExpiresAt: 3_000,
	}, RotationSessionTokenReused)
}

func TestVaultAuthorizationAndRevocation(t *testing.T) {
	t.Parallel()
	active := fixtureSession(t)
	context := AuthorizeSession(&active, 1_500).Context
	if decision := AuthorizeVaultOperation(context, active, 1_500); !decision.Authorized {
		t.Fatalf("operation denied = %#v", decision)
	}
	wrongSession := context
	wrongSession.SessionID = mustSessionID(t, fixtureNextSessionID)
	if decision := AuthorizeVaultOperation(wrongSession, active, 1_500); decision.Reason != VaultOperationSessionMismatch {
		t.Fatalf("wrong session decision = %#v", decision)
	}
	wrongAccount := context
	wrongAccount.AccountID = mustAccountID(t, fixtureOtherAccount)
	if decision := AuthorizeVaultOperation(wrongAccount, active, 1_500); decision.Reason != VaultOperationAccountMismatch {
		t.Fatalf("wrong account decision = %#v", decision)
	}
	wrongVault := context
	wrongVault.VaultID = mustVaultID(t, fixtureOtherVault)
	if decision := AuthorizeVaultOperation(wrongVault, active, 1_500); decision.Reason != VaultOperationVaultMismatch {
		t.Fatalf("wrong vault decision = %#v", decision)
	}
	wrongEpoch := context
	wrongEpoch.SessionEpoch = 2
	if decision := AuthorizeVaultOperation(wrongEpoch, active, 1_500); decision.Reason != VaultOperationEpochMismatch {
		t.Fatalf("wrong epoch decision = %#v", decision)
	}
	revoked := RevokeSession(active, 1_600, RevocationLogout)
	if revoked.Kind != RevokeApplied || revoked.Session.Kind != SessionRevoked {
		t.Fatalf("revoke = %#v", revoked)
	}
	unchanged := RevokeSession(revoked.Session, 1_800, RevocationSecurity)
	if unchanged.Kind != RevokeUnchanged || unchanged.Session != revoked.Session {
		t.Fatalf("repeat revoke = %#v", unchanged)
	}
}

func TestSharedSessionFixture(t *testing.T) {
	t.Parallel()
	content, err := os.ReadFile("../../../contracts/fixtures/identity/session.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Profile string `json:"profile"`
		Active  struct {
			Kind         string `json:"kind"`
			SessionID    string `json:"sessionId"`
			AccountID    string `json:"accountId"`
			VaultID      string `json:"vaultId"`
			SessionEpoch int64  `json:"sessionEpoch"`
			IssuedAt     int64  `json:"issuedAt"`
			ExpiresAt    int64  `json:"expiresAt"`
		} `json:"active"`
		AccessCases []struct {
			Now      int64  `json:"now"`
			Expected string `json:"expected"`
		} `json:"accessCases"`
		CSRF struct {
			Allowed CSRFInput `json:"allowed"`
			Denied  CSRFInput `json:"denied"`
		} `json:"csrf"`
	}
	decoder := json.NewDecoder(strings.NewReader(string(content)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&fixture); err != nil {
		t.Fatalf("decode shared fixture: %v", err)
	}
	created := CreateActiveSession(SessionInput{
		SessionID:    mustSessionID(t, fixture.Active.SessionID),
		AccountID:    mustAccountID(t, fixture.Active.AccountID),
		VaultID:      mustVaultID(t, fixture.Active.VaultID),
		SessionEpoch: mustEpoch(t, fixture.Active.SessionEpoch),
		IssuedAt:     fixture.Active.IssuedAt, ExpiresAt: fixture.Active.ExpiresAt,
	})
	if fixture.Profile != "session-core" || fixture.Active.Kind != "active" || !created.Created {
		t.Fatalf("fixture session = %#v", created)
	}
	for _, accessCase := range fixture.AccessCases {
		decision := AuthorizeSession(&created.Session, accessCase.Now)
		actual := string(decision.Kind)
		if decision.Kind == AccessDenied {
			actual = string(decision.Reason)
		}
		if actual != accessCase.Expected {
			t.Fatalf("access at %d = %q, want %q", accessCase.Now, actual, accessCase.Expected)
		}
	}
	if decision := EvaluateCSRF(fixture.CSRF.Allowed); decision.Kind != CSRFAllowed {
		t.Fatalf("allowed CSRF = %#v", decision)
	}
	if decision := EvaluateCSRF(fixture.CSRF.Denied); decision.Reason != CSRFOriginMismatch {
		t.Fatalf("denied CSRF = %#v", decision)
	}
}

func assertRotationReason(
	t *testing.T,
	session Session,
	input RotationInput,
	want RotationReason,
) {
	t.Helper()
	if decision := RotateSession(session, input); decision.Rotated || decision.Reason != want {
		t.Fatalf("rotation decision = %#v, want %q", decision, want)
	}
}

func fixtureSession(t *testing.T) Session {
	t.Helper()
	decision := CreateActiveSession(SessionInput{
		SessionID: mustSessionID(t, fixtureSessionID), AccountID: mustAccountID(t, fixtureAccountID),
		VaultID: mustVaultID(t, fixtureVaultID), SessionEpoch: mustEpoch(t, 1),
		IssuedAt: 1_000, ExpiresAt: 2_000,
	})
	if !decision.Created {
		t.Fatalf("fixture session rejected: %#v", decision)
	}
	return decision.Session
}

func mustAccountID(t *testing.T, value string) AccountID {
	t.Helper()
	parsed, err := ParseAccountID(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func mustVaultID(t *testing.T, value string) VaultID {
	t.Helper()
	parsed, err := ParseVaultID(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func mustSessionID(t *testing.T, value string) SessionID {
	t.Helper()
	parsed, err := ParseSessionID(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func mustEpoch(t *testing.T, value int64) SessionEpoch {
	t.Helper()
	parsed, err := ParseSessionEpoch(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func mustToken(t *testing.T, value string) SessionToken {
	t.Helper()
	parsed, err := ParseSessionToken(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}
