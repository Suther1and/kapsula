-- Wave 1 Cloud Security & Quota Hardening

-- 1. Track active in-flight reservations on ai_usage_monthly and atomically across all users in ai_usage_global_monthly
ALTER TABLE public.ai_usage_monthly
  ADD COLUMN IF NOT EXISTS reserved_usd numeric(10,6) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.ai_usage_global_monthly (
  month_ym text PRIMARY KEY,
  spent_usd numeric(12,6) NOT NULL DEFAULT 0,
  reserved_usd numeric(12,6) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ai_usage_global_monthly ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_usage_global_monthly FROM PUBLIC, anon, authenticated;

INSERT INTO public.ai_usage_global_monthly (month_ym, spent_usd, reserved_usd, updated_at)
SELECT m.month_ym, COALESCE(SUM(m.spent_usd), 0), COALESCE(SUM(m.reserved_usd), 0), now()
FROM public.ai_usage_monthly m
GROUP BY m.month_ym
ON CONFLICT (month_ym) DO UPDATE
  SET spent_usd = GREATEST(public.ai_usage_global_monthly.spent_usd, EXCLUDED.spent_usd),
      reserved_usd = EXCLUDED.reserved_usd,
      updated_at = now();

-- 2. GCal OAuth per-user rate-limiting table
CREATE TABLE IF NOT EXISTS public.gcal_oauth_rate_limits (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  window_count integer NOT NULL DEFAULT 0
);

ALTER TABLE public.gcal_oauth_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gcal_oauth_rate_limits FROM PUBLIC, anon, authenticated;

-- 3. Add ON DELETE CASCADE FKs to auth.users(id) across user-owned tables
DO $$
DECLARE
  v_tbl text;
  v_fk_name text;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY[
    'ai_usage_monthly',
    'ai_user_overrides',
    'sync_key_envelopes',
    'sync_records',
    'sync_blobs',
    'sync_devices'
  ]
  LOOP
    v_fk_name := v_tbl || '_user_id_fkey';
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.table_constraints tc
      WHERE tc.table_schema = 'public'
        AND tc.table_name = v_tbl
        AND tc.constraint_type = 'FOREIGN KEY'
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE',
        v_tbl,
        v_fk_name
      );
    END IF;
  END LOOP;
END
$$;

-- 4. Atomic AI rate check + pre-request budget reservation (per-user & global)
CREATE OR REPLACE FUNCTION public.check_and_reserve_ai_rate_v2(
  p_user_id uuid,
  p_month_ym text,
  p_reserve_usd numeric DEFAULT 0.0200
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_now timestamptz := now();
  v_reserve numeric(10,6) := GREATEST(0::numeric, COALESCE(p_reserve_usd, 0.0200));
  v_default_limit numeric(10,4) := 1.0000;
  v_global_cap numeric(10,4) := 15.0000;
  v_rate_limit integer := 20;
  v_override_limit numeric(10,4);
  v_blocked boolean := false;
  v_limit_usd numeric(10,4);
  v_spent_usd numeric(10,6) := 0;
  v_reserved_usd numeric(10,6) := 0;
  v_window_started_at timestamptz;
  v_window_count integer := 0;
  v_global_spent_usd numeric(12,6) := 0;
  v_global_reserved_usd numeric(12,6) := 0;
  v_remaining_usd numeric(10,6);
  v_retry_after_sec integer := 60;
BEGIN
  SELECT c.default_monthly_limit_usd, c.global_monthly_cap_usd, c.rate_limit_per_min
    INTO v_default_limit, v_global_cap, v_rate_limit
    FROM public.ai_quota_config c
   WHERE c.id = 1;

  v_default_limit := COALESCE(v_default_limit, 1.0000);
  v_global_cap := COALESCE(v_global_cap, 15.0000);
  v_rate_limit := COALESCE(v_rate_limit, 20);

  SELECT o.monthly_limit_usd, COALESCE(o.blocked, false)
    INTO v_override_limit, v_blocked
    FROM public.ai_user_overrides o
   WHERE o.user_id = p_user_id;

  v_blocked := COALESCE(v_blocked, false);
  v_limit_usd := COALESCE(v_override_limit, v_default_limit);

  INSERT INTO public.ai_usage_global_monthly (month_ym, spent_usd, reserved_usd, updated_at)
  VALUES (p_month_ym, 0, 0, v_now)
  ON CONFLICT (month_ym) DO NOTHING;

  SELECT g.spent_usd, g.reserved_usd
    INTO v_global_spent_usd, v_global_reserved_usd
    FROM public.ai_usage_global_monthly g
   WHERE g.month_ym = p_month_ym
     FOR UPDATE;

  INSERT INTO public.ai_usage_monthly (user_id, month_ym, window_started_at, window_count, reserved_usd, updated_at)
  VALUES (p_user_id, p_month_ym, v_now, 0, 0, v_now)
  ON CONFLICT (user_id, month_ym) DO NOTHING;

  SELECT u.spent_usd, u.reserved_usd, u.window_started_at, u.window_count
    INTO v_spent_usd, v_reserved_usd, v_window_started_at, v_window_count
    FROM public.ai_usage_monthly u
   WHERE u.user_id = p_user_id
     AND u.month_ym = p_month_ym
     FOR UPDATE;

  v_spent_usd := COALESCE(v_spent_usd, 0);
  v_reserved_usd := COALESCE(v_reserved_usd, 0);
  v_global_spent_usd := COALESCE(v_global_spent_usd, 0);
  v_global_reserved_usd := COALESCE(v_global_reserved_usd, 0);
  v_remaining_usd := GREATEST(0::numeric, v_limit_usd - (v_spent_usd + v_reserved_usd));

  IF v_blocked THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'blocked',
      'spent_usd', ROUND(v_spent_usd, 6),
      'limit_usd', ROUND(v_limit_usd, 4),
      'remaining_usd', ROUND(v_remaining_usd, 6)
    );
  END IF;

  IF v_spent_usd >= v_limit_usd OR (v_spent_usd + v_reserved_usd + v_reserve) > v_limit_usd THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'user_quota_exceeded',
      'spent_usd', ROUND(v_spent_usd, 6),
      'limit_usd', ROUND(v_limit_usd, 4),
      'remaining_usd', ROUND(v_remaining_usd, 6)
    );
  END IF;

  IF v_global_spent_usd >= v_global_cap OR (v_global_spent_usd + v_global_reserved_usd + v_reserve) > v_global_cap THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'global_quota_exceeded',
      'spent_usd', ROUND(v_spent_usd, 6),
      'limit_usd', ROUND(v_limit_usd, 4),
      'remaining_usd', ROUND(v_remaining_usd, 6)
    );
  END IF;

  IF v_window_started_at IS NULL OR (v_now - v_window_started_at) >= interval '60 seconds' THEN
    UPDATE public.ai_usage_monthly
       SET window_started_at = v_now,
           window_count = 1,
           reserved_usd = reserved_usd + v_reserve,
           updated_at = v_now
     WHERE user_id = p_user_id
       AND month_ym = p_month_ym;
  ELSIF v_window_count >= v_rate_limit THEN
    v_retry_after_sec := GREATEST(
      1,
      CEIL(EXTRACT(EPOCH FROM (v_window_started_at + interval '60 seconds' - v_now)))::integer
    );
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'rate_limit_exceeded',
      'retry_after_sec', v_retry_after_sec,
      'spent_usd', ROUND(v_spent_usd, 6),
      'limit_usd', ROUND(v_limit_usd, 4),
      'remaining_usd', ROUND(v_remaining_usd, 6)
    );
  ELSE
    UPDATE public.ai_usage_monthly
       SET window_count = window_count + 1,
           reserved_usd = reserved_usd + v_reserve,
           updated_at = v_now
     WHERE user_id = p_user_id
       AND month_ym = p_month_ym;
  END IF;

  UPDATE public.ai_usage_global_monthly
     SET reserved_usd = reserved_usd + v_reserve,
         updated_at = v_now
   WHERE month_ym = p_month_ym;

  RETURN jsonb_build_object(
    'allowed', true,
    'reason', NULL,
    'reserved_usd', ROUND(v_reserve, 6),
    'spent_usd', ROUND(v_spent_usd, 6),
    'limit_usd', ROUND(v_limit_usd, 4),
    'remaining_usd', ROUND(GREATEST(0::numeric, v_limit_usd - (v_spent_usd + v_reserved_usd + v_reserve)), 6)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.check_and_reserve_ai_rate(p_user_id uuid, p_month_ym text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  RETURN public.check_and_reserve_ai_rate_v2(p_user_id, p_month_ym, 0.0200);
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_ai_usage_v2(
  p_user_id uuid,
  p_month_ym text,
  p_cost_usd numeric,
  p_in_tokens bigint,
  p_out_tokens bigint,
  p_reserved_usd numeric DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_now timestamptz := now();
  v_safe_cost numeric(10,6) := GREATEST(0::numeric, COALESCE(p_cost_usd, 0));
  v_rel_reserved numeric(10,6) := GREATEST(0::numeric, COALESCE(p_reserved_usd, 0));
  v_safe_in bigint := GREATEST(0::bigint, COALESCE(p_in_tokens, 0));
  v_safe_out bigint := GREATEST(0::bigint, COALESCE(p_out_tokens, 0));
  v_default_limit numeric(10,4) := 1.0000;
  v_override_limit numeric(10,4);
  v_limit_usd numeric(10,4);
  v_spent_usd numeric(10,6);
  v_reserved_usd numeric(10,6);
  v_request_count integer;
  v_remaining_usd numeric(10,6);
BEGIN
  SELECT c.default_monthly_limit_usd
    INTO v_default_limit
    FROM public.ai_quota_config c
   WHERE c.id = 1;

  v_default_limit := COALESCE(v_default_limit, 1.0000);

  SELECT o.monthly_limit_usd
    INTO v_override_limit
    FROM public.ai_user_overrides o
   WHERE o.user_id = p_user_id;

  v_limit_usd := COALESCE(v_override_limit, v_default_limit);

  INSERT INTO public.ai_usage_monthly (
    user_id,
    month_ym,
    spent_usd,
    reserved_usd,
    request_count,
    input_tokens,
    output_tokens,
    window_started_at,
    window_count,
    updated_at
  )
  VALUES (
    p_user_id,
    p_month_ym,
    v_safe_cost,
    0,
    1,
    v_safe_in,
    v_safe_out,
    v_now,
    1,
    v_now
  )
  ON CONFLICT (user_id, month_ym) DO UPDATE
    SET spent_usd = public.ai_usage_monthly.spent_usd + v_safe_cost,
        reserved_usd = GREATEST(0::numeric, public.ai_usage_monthly.reserved_usd - v_rel_reserved),
        request_count = public.ai_usage_monthly.request_count + 1,
        input_tokens = public.ai_usage_monthly.input_tokens + v_safe_in,
        output_tokens = public.ai_usage_monthly.output_tokens + v_safe_out,
        updated_at = v_now
  RETURNING spent_usd, reserved_usd, request_count
    INTO v_spent_usd, v_reserved_usd, v_request_count;

  INSERT INTO public.ai_usage_global_monthly (month_ym, spent_usd, reserved_usd, updated_at)
  VALUES (p_month_ym, v_safe_cost, 0, v_now)
  ON CONFLICT (month_ym) DO UPDATE
    SET spent_usd = public.ai_usage_global_monthly.spent_usd + v_safe_cost,
        reserved_usd = GREATEST(0::numeric, public.ai_usage_global_monthly.reserved_usd - v_rel_reserved),
        updated_at = v_now;

  v_remaining_usd := GREATEST(0::numeric, v_limit_usd - (v_spent_usd + COALESCE(v_reserved_usd, 0)));

  RETURN jsonb_build_object(
    'spent_usd', ROUND(v_spent_usd, 6),
    'limit_usd', ROUND(v_limit_usd, 4),
    'remaining_usd', ROUND(v_remaining_usd, 6),
    'request_count', v_request_count
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_ai_usage(
  p_user_id uuid,
  p_month_ym text,
  p_cost_usd numeric,
  p_in_tokens bigint,
  p_out_tokens bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  RETURN public.record_ai_usage_v2(p_user_id, p_month_ym, p_cost_usd, p_in_tokens, p_out_tokens, 0);
END;
$function$;

CREATE OR REPLACE FUNCTION public.release_ai_reservation(
  p_user_id uuid,
  p_month_ym text,
  p_reserved_usd numeric DEFAULT 0
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_now timestamptz := now();
  v_rel numeric(10,6) := GREATEST(0::numeric, COALESCE(p_reserved_usd, 0));
BEGIN
  IF v_rel <= 0 THEN
    RETURN;
  END IF;

  UPDATE public.ai_usage_monthly
     SET reserved_usd = GREATEST(0::numeric, reserved_usd - v_rel),
         updated_at = v_now
   WHERE user_id = p_user_id
     AND month_ym = p_month_ym;

  UPDATE public.ai_usage_global_monthly
     SET reserved_usd = GREATEST(0::numeric, reserved_usd - v_rel),
         updated_at = v_now
   WHERE month_ym = p_month_ym;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_ai_quota_status(p_user_id uuid, p_month_ym text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_default_limit numeric(10,4) := 1.0000;
  v_global_cap numeric(10,4) := 15.0000;
  v_override_limit numeric(10,4);
  v_blocked boolean := false;
  v_limit_usd numeric(10,4);
  v_spent_usd numeric(10,6) := 0;
  v_reserved_usd numeric(10,6) := 0;
  v_request_count integer := 0;
  v_global_spent_usd numeric(12,6) := 0;
  v_global_reserved_usd numeric(12,6) := 0;
  v_remaining_usd numeric(10,6);
BEGIN
  SELECT c.default_monthly_limit_usd, c.global_monthly_cap_usd
    INTO v_default_limit, v_global_cap
    FROM public.ai_quota_config c
   WHERE c.id = 1;

  v_default_limit := COALESCE(v_default_limit, 1.0000);
  v_global_cap := COALESCE(v_global_cap, 15.0000);

  SELECT o.monthly_limit_usd, COALESCE(o.blocked, false)
    INTO v_override_limit, v_blocked
    FROM public.ai_user_overrides o
   WHERE o.user_id = p_user_id;

  v_blocked := COALESCE(v_blocked, false);
  v_limit_usd := COALESCE(v_override_limit, v_default_limit);

  SELECT u.spent_usd, u.reserved_usd, u.request_count
    INTO v_spent_usd, v_reserved_usd, v_request_count
    FROM public.ai_usage_monthly u
   WHERE u.user_id = p_user_id
     AND u.month_ym = p_month_ym;

  v_spent_usd := COALESCE(v_spent_usd, 0);
  v_reserved_usd := COALESCE(v_reserved_usd, 0);
  v_request_count := COALESCE(v_request_count, 0);

  SELECT COALESCE(g.spent_usd, 0), COALESCE(g.reserved_usd, 0)
    INTO v_global_spent_usd, v_global_reserved_usd
    FROM public.ai_usage_global_monthly g
   WHERE g.month_ym = p_month_ym;

  v_global_spent_usd := COALESCE(v_global_spent_usd, 0);
  v_global_reserved_usd := COALESCE(v_global_reserved_usd, 0);
  v_remaining_usd := GREATEST(0::numeric, v_limit_usd - (v_spent_usd + v_reserved_usd));

  RETURN jsonb_build_object(
    'spent_usd', ROUND(v_spent_usd, 6),
    'limit_usd', ROUND(v_limit_usd, 4),
    'remaining_usd', ROUND(v_remaining_usd, 6),
    'request_count', v_request_count,
    'blocked', v_blocked,
    'global_spent_usd', ROUND(v_global_spent_usd, 6),
    'global_cap_usd', ROUND(v_global_cap, 4),
    'global_exhausted', ((v_global_spent_usd + v_global_reserved_usd) >= v_global_cap)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.check_gcal_oauth_rate(
  p_user_id uuid,
  p_max_per_10min integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_now timestamptz := now();
  v_max integer := GREATEST(1, COALESCE(p_max_per_10min, 20));
  v_started timestamptz;
  v_count integer := 0;
  v_retry_after integer := 600;
BEGIN
  INSERT INTO public.gcal_oauth_rate_limits (user_id, window_started_at, window_count)
  VALUES (p_user_id, v_now, 0)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT g.window_started_at, g.window_count
    INTO v_started, v_count
    FROM public.gcal_oauth_rate_limits g
   WHERE g.user_id = p_user_id
     FOR UPDATE;

  IF v_started IS NULL OR (v_now - v_started) >= interval '10 minutes' THEN
    UPDATE public.gcal_oauth_rate_limits
       SET window_started_at = v_now,
           window_count = 1
     WHERE user_id = p_user_id;
    RETURN jsonb_build_object('allowed', true, 'remaining', GREATEST(0, v_max - 1));
  END IF;

  IF v_count >= v_max THEN
    v_retry_after := GREATEST(
      1,
      CEIL(EXTRACT(EPOCH FROM (v_started + interval '10 minutes' - v_now)))::integer
    );
    RETURN jsonb_build_object(
      'allowed', false,
      'retry_after_sec', v_retry_after,
      'remaining', 0
    );
  END IF;

  UPDATE public.gcal_oauth_rate_limits
     SET window_count = window_count + 1
   WHERE user_id = p_user_id;

  RETURN jsonb_build_object('allowed', true, 'remaining', GREATEST(0, v_max - (v_count + 1)));
END;
$function$;

REVOKE ALL ON FUNCTION public.check_and_reserve_ai_rate_v2(uuid, text, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.check_and_reserve_ai_rate(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_ai_usage_v2(uuid, text, numeric, bigint, bigint, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_ai_usage(uuid, text, numeric, bigint, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_ai_reservation(uuid, text, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_ai_quota_status(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.check_gcal_oauth_rate(uuid, integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.check_and_reserve_ai_rate_v2(uuid, text, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.check_and_reserve_ai_rate(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_ai_usage_v2(uuid, text, numeric, bigint, bigint, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_ai_usage(uuid, text, numeric, bigint, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_ai_reservation(uuid, text, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_ai_quota_status(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.check_gcal_oauth_rate(uuid, integer) TO service_role;
