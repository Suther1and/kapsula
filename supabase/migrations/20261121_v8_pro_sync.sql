-- Kapsula V8 Pro Cloud Sync Migration
-- Widens public.sync_records.entity_type CHECK constraint to support:
--   - 'item_revision' (E2EE cross-device note version history)
--   - 'workspace_prefs' (E2EE Kanban columns & appearance preferences)
-- Strictly additive & idempotent.

DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'sync_records'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%entity_type%'
  LOOP
    EXECUTE format('ALTER TABLE public.sync_records DROP CONSTRAINT IF EXISTS %I', constraint_name);
  END LOOP;
END $$;

ALTER TABLE public.sync_records
  ADD CONSTRAINT sync_records_entity_type_check
  CHECK (
    entity_type IN (
      'item',
      'orbit',
      'focus_board',
      'calendar_event',
      'item_revision',
      'workspace_prefs'
    )
  );
