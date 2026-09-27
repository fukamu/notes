-- +goose Up
CREATE TABLE session_identities (
  session_id text PRIMARY KEY,
  identity_id text NOT NULL,
  CONSTRAINT session_identities_session_fk
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
  CONSTRAINT session_identities_identity_fk
    FOREIGN KEY (identity_id) REFERENCES identities(identity_id) ON DELETE CASCADE
);
CREATE INDEX idx_session_identities_identity
  ON session_identities(identity_id, session_id);

-- +goose Down
DROP TABLE session_identities;
