CREATE TABLE terms_consent_evidence (
  account_id TEXT NOT NULL,
  vault_id TEXT NOT NULL,
  consent_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  terms_version TEXT NOT NULL,
  terms_hash TEXT NOT NULL,
  serialized_terms TEXT NOT NULL,
  consent TEXT NOT NULL,
  accepted_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, vault_id, consent_id),
  CONSTRAINT terms_consent_owner_fk FOREIGN KEY (account_id, vault_id) REFERENCES personal_vaults(account_id, vault_id) ON DELETE CASCADE,
  CONSTRAINT terms_consent_shape_check CHECK (
    length(consent_id) = 36
    AND length(submission_id) = 36
    AND length(terms_version) = 19
    AND substr(terms_version, 1, 9) = 'terms-v1:'
    AND length(terms_hash) = 71
    AND substr(terms_hash, 1, 7) = 'sha256:'
    AND length(serialized_terms) BETWEEN 1 AND 65536
    AND consent = 'affirmed'
    AND accepted_at >= 0
  )
);
--> statement-breakpoint

CREATE UNIQUE INDEX idx_terms_consent_submission
  ON terms_consent_evidence(account_id, vault_id, submission_id);
--> statement-breakpoint

CREATE INDEX idx_terms_consent_latest
  ON terms_consent_evidence(account_id, vault_id, accepted_at, consent_id);
--> statement-breakpoint

CREATE TRIGGER terms_consent_immutable
  BEFORE UPDATE ON terms_consent_evidence
  FOR EACH ROW
  BEGIN
    SELECT RAISE(ABORT, 'terms consent evidence is immutable');
  END;
