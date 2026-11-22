-- Kapsula Sync Baseline Schema (documented idempotently to match live Supabase project gxkvuwipzbqocbxgyqty)

CREATE SEQUENCE IF NOT EXISTS public.sync_record_seq_gen
  AS bigint
  START WITH 1
  INCREMENT BY 1
  NO MINVALUE
  NO MAXVALUE
  CACHE 1;

CREATE TABLE IF NOT EXISTS public.sync_key_envelopes (
  user_id uuid PRIMARY KEY,
  version integer NOT NULL DEFAULT 1,
  kdf_alg text NOT NULL DEFAULT 'pbkdf2-sha256',
  kdf_iterations integer NOT NULL DEFAULT 600000,
  kdf_salt text NOT NULL,
  wrapped_dek_passphrase text NOT NULL,
  wrapped_dek_recovery text NOT NULL,
  key_check_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.sync_records (
  user_id uuid NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  server_seq bigint NOT NULL DEFAULT nextval('public.sync_record_seq_gen'::regclass),
  updated_at bigint NOT NULL,
  deleted_at bigint,
  sync_version integer NOT NULL DEFAULT 1,
  device_id text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1,
  payload_ciphertext text NOT NULL,
  payload_iv text NOT NULL,
  payload_tag text NOT NULL,
  server_updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_sync_records_user_seq
  ON public.sync_records USING btree (user_id, server_seq);

CREATE TABLE IF NOT EXISTS public.sync_blobs (
  user_id uuid NOT NULL,
  blob_id text NOT NULL,
  byte_size bigint NOT NULL,
  ext text NOT NULL DEFAULT ''::text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, blob_id)
);

CREATE TABLE IF NOT EXISTS public.sync_devices (
  user_id uuid NOT NULL,
  device_id text NOT NULL,
  device_name text NOT NULL,
  platform text NOT NULL,
  app_version text NOT NULL DEFAULT '1.0.0'::text,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, device_id)
);

CREATE OR REPLACE FUNCTION public.bump_sync_record_seq()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.updated_at < OLD.updated_at)
       OR (NEW.updated_at = OLD.updated_at AND NEW.sync_version < OLD.sync_version)
       OR (NEW.updated_at = OLD.updated_at AND NEW.sync_version = OLD.sync_version AND NEW.device_id < OLD.device_id)
    THEN
      RETURN OLD;
    END IF;
  END IF;
  NEW.server_seq := nextval('public.sync_record_seq_gen');
  NEW.server_updated_at := NOW();
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_bump_sync_record_seq ON public.sync_records;
CREATE TRIGGER trg_bump_sync_record_seq
  BEFORE INSERT OR UPDATE ON public.sync_records
  FOR EACH ROW
  EXECUTE FUNCTION public.bump_sync_record_seq();

ALTER TABLE public.sync_key_envelopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_blobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_devices ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sync_key_envelopes' AND policyname = 'sync_key_envelopes_select_own') THEN
    CREATE POLICY sync_key_envelopes_select_own ON public.sync_key_envelopes FOR SELECT USING (((SELECT auth.uid() AS uid) = user_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sync_key_envelopes' AND policyname = 'sync_key_envelopes_insert_own') THEN
    CREATE POLICY sync_key_envelopes_insert_own ON public.sync_key_envelopes FOR INSERT WITH CHECK (((SELECT auth.uid() AS uid) = user_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sync_key_envelopes' AND policyname = 'sync_key_envelopes_update_own') THEN
    CREATE POLICY sync_key_envelopes_update_own ON public.sync_key_envelopes FOR UPDATE USING (((SELECT auth.uid() AS uid) = user_id)) WITH CHECK (((SELECT auth.uid() AS uid) = user_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sync_key_envelopes' AND policyname = 'sync_key_envelopes_delete_own') THEN
    CREATE POLICY sync_key_envelopes_delete_own ON public.sync_key_envelopes FOR DELETE USING (((SELECT auth.uid() AS uid) = user_id));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sync_records' AND policyname = 'sync_records_select_own') THEN
    CREATE POLICY sync_records_select_own ON public.sync_records FOR SELECT USING (((SELECT auth.uid() AS uid) = user_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sync_records' AND policyname = 'sync_records_insert_own') THEN
    CREATE POLICY sync_records_insert_own ON public.sync_records FOR INSERT WITH CHECK (((SELECT auth.uid() AS uid) = user_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sync_records' AND policyname = 'sync_records_update_own') THEN
    CREATE POLICY sync_records_update_own ON public.sync_records FOR UPDATE USING (((SELECT auth.uid() AS uid) = user_id)) WITH CHECK (((SELECT auth.uid() AS uid) = user_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sync_records' AND policyname = 'sync_records_delete_own') THEN
    CREATE POLICY sync_records_delete_own ON public.sync_records FOR DELETE USING (((SELECT auth.uid() AS uid) = user_id));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sync_blobs' AND policyname = 'sync_blobs_select_own') THEN
    CREATE POLICY sync_blobs_select_own ON public.sync_blobs FOR SELECT USING (((SELECT auth.uid() AS uid) = user_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sync_blobs' AND policyname = 'sync_blobs_insert_own') THEN
    CREATE POLICY sync_blobs_insert_own ON public.sync_blobs FOR INSERT WITH CHECK (((SELECT auth.uid() AS uid) = user_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sync_blobs' AND policyname = 'sync_blobs_update_own') THEN
    CREATE POLICY sync_blobs_update_own ON public.sync_blobs FOR UPDATE USING (((SELECT auth.uid() AS uid) = user_id)) WITH CHECK (((SELECT auth.uid() AS uid) = user_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sync_blobs' AND policyname = 'sync_blobs_delete_own') THEN
    CREATE POLICY sync_blobs_delete_own ON public.sync_blobs FOR DELETE USING (((SELECT auth.uid() AS uid) = user_id));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sync_devices' AND policyname = 'sync_devices_select_own') THEN
    CREATE POLICY sync_devices_select_own ON public.sync_devices FOR SELECT USING (((SELECT auth.uid() AS uid) = user_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sync_devices' AND policyname = 'sync_devices_insert_own') THEN
    CREATE POLICY sync_devices_insert_own ON public.sync_devices FOR INSERT WITH CHECK (((SELECT auth.uid() AS uid) = user_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sync_devices' AND policyname = 'sync_devices_update_own') THEN
    CREATE POLICY sync_devices_update_own ON public.sync_devices FOR UPDATE USING (((SELECT auth.uid() AS uid) = user_id)) WITH CHECK (((SELECT auth.uid() AS uid) = user_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sync_devices' AND policyname = 'sync_devices_delete_own') THEN
    CREATE POLICY sync_devices_delete_own ON public.sync_devices FOR DELETE USING (((SELECT auth.uid() AS uid) = user_id));
  END IF;
END
$$;

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('kapsula-blobs', 'kapsula-blobs', false, 52428800)
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'kapsula_blobs_select_own') THEN
    CREATE POLICY kapsula_blobs_select_own ON storage.objects FOR SELECT TO authenticated USING (((bucket_id = 'kapsula-blobs'::text) AND ((storage.foldername(name))[1] = ((SELECT auth.uid())::text))));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'kapsula_blobs_insert_own') THEN
    CREATE POLICY kapsula_blobs_insert_own ON storage.objects FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'kapsula-blobs'::text) AND ((storage.foldername(name))[1] = ((SELECT auth.uid())::text))));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'kapsula_blobs_update_own') THEN
    CREATE POLICY kapsula_blobs_update_own ON storage.objects FOR UPDATE TO authenticated USING (((bucket_id = 'kapsula-blobs'::text) AND ((storage.foldername(name))[1] = ((SELECT auth.uid())::text)))) WITH CHECK (((bucket_id = 'kapsula-blobs'::text) AND ((storage.foldername(name))[1] = ((SELECT auth.uid())::text))));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'kapsula_blobs_delete_own') THEN
    CREATE POLICY kapsula_blobs_delete_own ON storage.objects FOR DELETE TO authenticated USING (((bucket_id = 'kapsula-blobs'::text) AND ((storage.foldername(name))[1] = ((SELECT auth.uid())::text))));
  END IF;
END
$$;
