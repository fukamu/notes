CREATE TABLE vault_quota_finalization_assertions (
  account_id TEXT NOT NULL,
  vault_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  assertion_passed INTEGER NOT NULL,
  PRIMARY KEY (account_id, vault_id, reservation_id),
  CONSTRAINT vault_quota_finalization_assertions_owner_fk FOREIGN KEY (account_id, vault_id) REFERENCES personal_vaults(account_id, vault_id) ON DELETE CASCADE,
  CONSTRAINT vault_quota_finalization_assertions_shape_check CHECK (
    length(reservation_id) = 36 AND assertion_passed = 1
  )
);
