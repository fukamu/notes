package postgres

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/access"
	"github.com/fukamu/notes/backend/internal/launchgate"
	"github.com/jackc/pgx/v5/pgxpool"
)

type LaunchGateReader struct {
	pool *pgxpool.Pool
}

func NewLaunchGateReader(pool *pgxpool.Pool) (*LaunchGateReader, error) {
	if pool == nil {
		return nil, errors.New("database pool is required")
	}
	return &LaunchGateReader{pool: pool}, nil
}

func (reader *LaunchGateReader) Read(
	ctx context.Context,
	subject *access.Subject,
) (launchgate.Facts, error) {
	if reader == nil || reader.pool == nil {
		return launchgate.Facts{}, launchgate.ErrUnavailable
	}
	var subjectValue any
	if subject != nil {
		subjectValue = string(*subject)
	}
	var facts launchgate.Facts
	err := reader.pool.QueryRow(
		ctx,
		`SELECT public_access_enabled,
           CASE WHEN $1::text IS NULL THEN false ELSE EXISTS (
             SELECT 1 FROM launch_allowed_users WHERE user_id = $1
           ) END
         FROM launch_config WHERE singleton = 1`,
		subjectValue,
	).Scan(&facts.PublicAccessEnabled, &facts.UserAllowed)
	if err != nil {
		return launchgate.Facts{}, launchgate.ErrUnavailable
	}
	return facts, nil
}
