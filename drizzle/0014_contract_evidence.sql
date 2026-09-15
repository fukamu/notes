CREATE TABLE contract_evidence (
  account_id TEXT NOT NULL,
  vault_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  offer_hash TEXT NOT NULL,
  offer_version TEXT NOT NULL,
  disclosure_version TEXT NOT NULL,
  serialized_offer TEXT NOT NULL,
  consent TEXT NOT NULL,
  confirmed_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, vault_id, evidence_id),
  CONSTRAINT contract_evidence_owner_fk FOREIGN KEY (account_id, vault_id) REFERENCES personal_vaults(account_id, vault_id) ON DELETE CASCADE,
  CONSTRAINT contract_evidence_shape_check CHECK (
    length(evidence_id) = 36
    AND length(submission_id) = 36
    AND length(offer_hash) = 71
    AND substr(offer_hash, 1, 7) = 'sha256:'
    AND length(offer_version) BETWEEN 1 AND 128
    AND length(disclosure_version) = 10
    AND length(serialized_offer) BETWEEN 1 AND 8192
    AND consent = 'affirmed'
    AND confirmed_at >= 0
  )
);
--> statement-breakpoint

CREATE UNIQUE INDEX idx_contract_evidence_submission
  ON contract_evidence(account_id, vault_id, submission_id);
