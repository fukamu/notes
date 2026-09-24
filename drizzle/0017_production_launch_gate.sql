CREATE TABLE launch_config (
  singleton INTEGER PRIMARY KEY NOT NULL,
  public_access_enabled INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CONSTRAINT launch_config_singleton_check CHECK (singleton = 1),
  CONSTRAINT launch_config_public_access_check CHECK (public_access_enabled IN (0, 1)),
  CONSTRAINT launch_config_updated_at_check CHECK (updated_at >= 0)
);
--> statement-breakpoint

CREATE TABLE launch_allowed_users (
  user_id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  CONSTRAINT launch_allowed_users_user_id_check CHECK (
    length(user_id) BETWEEN 1 AND 256 AND trim(user_id) = user_id
  ),
  CONSTRAINT launch_allowed_users_created_at_check CHECK (created_at >= 0)
);
--> statement-breakpoint

INSERT INTO launch_config(singleton, public_access_enabled, updated_at)
VALUES (1, 0, unixepoch() * 1000);
