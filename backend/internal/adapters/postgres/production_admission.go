package postgres

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/launchgate"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrProductionAdmissionUnavailable = errors.New("production admission unavailable")

// ProductionAdmission resolves launch admission from the exact verified OIDC
// identity bound to the current session. It deliberately does not trust an
// account, vault, or user ID supplied by the browser.
type ProductionAdmission struct {
	pool *pgxpool.Pool
}

func NewProductionAdmission(pool *pgxpool.Pool) (*ProductionAdmission, error) {
	if pool == nil {
		return nil, errors.New("database pool is required")
	}
	return &ProductionAdmission{pool: pool}, nil
}

func (admission *ProductionAdmission) AuthorizeVault(
	ctx context.Context,
	vaultContext identity.VaultContext,
) (launchgate.Decision, error) {
	if admission == nil || admission.pool == nil || !validVaultContext(vaultContext) {
		return launchgate.Decision{}, ErrProductionAdmissionUnavailable
	}
	var publicAccess, mapped, allowed bool
	err := admission.pool.QueryRow(
		ctx,
		`SELECT launch.public_access_enabled,
		        EXISTS (
		          SELECT 1
		            FROM sessions session
		            JOIN session_identities binding ON binding.session_id = session.session_id
		            JOIN identities identity ON identity.identity_id = binding.identity_id
		           WHERE session.session_id = $1 AND session.account_id = $2
		             AND session.vault_id = $3 AND session.session_epoch = $4
		             AND identity.account_id = session.account_id
		             AND identity.provider = 'google-oidc'
		        ),
		        EXISTS (
		          SELECT 1
		            FROM sessions session
		            JOIN session_identities binding ON binding.session_id = session.session_id
		            JOIN identities identity ON identity.identity_id = binding.identity_id
		            JOIN launch_allowed_users allowed ON allowed.user_id = identity.subject
		           WHERE session.session_id = $1 AND session.account_id = $2
		             AND session.vault_id = $3 AND session.session_epoch = $4
		             AND identity.account_id = session.account_id
		             AND identity.provider = 'google-oidc'
		        )
		   FROM launch_config launch WHERE launch.singleton = 1`,
		string(vaultContext.SessionID), string(vaultContext.AccountID),
		string(vaultContext.VaultID), int64(vaultContext.SessionEpoch),
	).Scan(&publicAccess, &mapped, &allowed)
	if err != nil {
		return launchgate.Decision{}, ErrProductionAdmissionUnavailable
	}
	if !mapped {
		return launchgate.Decision{}, nil
	}
	return launchgate.Decide(launchgate.Facts{
		PublicAccessEnabled: publicAccess,
		UserAllowed:         allowed,
	}), nil
}

func validVaultContext(value identity.VaultContext) bool {
	_, accountErr := identity.ParseAccountID(string(value.AccountID))
	_, vaultErr := identity.ParseVaultID(string(value.VaultID))
	_, sessionErr := identity.ParseSessionID(string(value.SessionID))
	_, epochErr := identity.ParseSessionEpoch(int64(value.SessionEpoch))
	return accountErr == nil && vaultErr == nil && sessionErr == nil && epochErr == nil
}
