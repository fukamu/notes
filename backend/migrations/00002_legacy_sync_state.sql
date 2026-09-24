-- +goose Up
INSERT INTO sync_state(singleton, next_display_id)
VALUES (1, 1)
ON CONFLICT (singleton) DO NOTHING;

-- +goose Down
DELETE FROM sync_state
WHERE singleton = 1
  AND next_display_id = 1
  AND NOT EXISTS (SELECT 1 FROM cards)
  AND NOT EXISTS (SELECT 1 FROM card_mutations)
  AND NOT EXISTS (SELECT 1 FROM conflicts);
