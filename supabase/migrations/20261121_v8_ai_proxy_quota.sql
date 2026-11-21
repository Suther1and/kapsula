-- Kapsula V8 Shared AI Proxy Quota & Rate Limiting Schema
-- Strictly additive, idempotent, RLS-enforced, service_role RPCs.

-- 1. Global quota configuration (single-row table id = 1)
CREATE TABLE IF NOT EXISTS public.ai_quota_config (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  default_monthly_limit_usd numeric(10,4) NOT NULL DEFAULT 1.0000 CHECK (default_monthly_limit_usd >= 0),
  global_monthly_cap_usd numeric(10,4) NOT NULL DEFAULT 15.0000 CHECK (global_monthly_cap_usd >= 0),
  rate_limit_per_min integer NOT NULL DEFAULT 20 CHECK (rate_limit_per_min > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.ai_quota_config (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.ai_quota_config ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.ai_quota_config FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.ai_quota_config TO service_role;

-- 2. Per-user monthly usage + 1-minute sliding rate window
CREATE TABLE IF NOT EXISTS public.ai_usage_monthly (
  user_id uuid NOT NULL,
  month_ym text NOT NULL CHECK (month_ym ~ '^\d{4}-\d{2}$'),
  spent_usd numeric(10,6) NOT NULL DEFAULT 0 CHECK (spent_usd >= 0),
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  window_started_at timestamptz NOT NULL DEFAULT now(),
  window_count integer NOT NULL DEFAULT 0 CHECK (window_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, month_ym)
);

CREATE INDEX IF NOT EXISTS ai_usage_monthly_month_ym_idx
  ON public.ai_usage_monthly (month_ym);

ALTER TABLE public.ai_usage_monthly ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_usage_monthly_select_own ON public.ai_usage_monthly;
CREATE POLICY ai_usage_monthly_select_own
  ON public.ai_usage_monthly
  FOR SELECT
  TO authenticated
  USING ((select auth.uid()) = user_id);

REVOKE ALL ON TABLE public.ai_usage_monthly FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.ai_usage_monthly TO authenticated;
GRANT ALL ON TABLE public.ai_usage_monthly TO service_role;

-- 3. Optional per-user overrides / blocklist (admin / service_role only)
CREATE TABLE IF NOT EXISTS public.ai_user_overrides (
  user_id uuid PRIMARY KEY,
  email text,
  monthly_limit_usd numeric(10,4) CHECK (monthly_limit_usd IS NULL OR monthly_limit_usd >= 0),
  blocked boolean NOT NULL DEFAULT false,
  note text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ai_user_overrides ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.ai_user_overrides FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.ai_user_overrides TO service_role;

-- 4. RPC: get_ai_quota_status
CREATE OR REPLACE FUNCTION public.get_ai_quota_status(
  p_user_id uuid,
  p_month_ym text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_default_limit numeric(10,4) := 1.0000;
  v_global_cap numeric(10,4) := 15.0000;
  v_override_limit numeric(10,4);
  v_blocked boolean := false;
  v_limit_usd numeric(10,4);
  v_spent_usd numeric(10,6) := 0;
  v_request_count integer := 0;
  v_global_spent_usd numeric(12,6) := 0;
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

  SELECT u.spent_usd, u.request_count
    INTO v_spent_usd, v_request_count
    FROM public.ai_usage_monthly u
   WHERE u.user_id = p_user_id
     AND u.month_ym = p_month_ym;

  v_spent_usd := COALESCE(v_spent_usd, 0);
  v_request_count := COALESCE(v_request_count, 0);

  SELECT COALESCE(SUM(u.spent_usd), 0)
    INTO v_global_spent_usd
    FROM public.ai_usage_monthly u
   WHERE u.month_ym = p_month_ym;

  v_remaining_usd := GREATEST(0::numeric, v_limit_usd - v_spent_usd);

  RETURN jsonb_build_object(
    'spent_usd', ROUND(v_spent_usd, 6),
    'limit_usd', ROUND(v_limit_usd, 4),
    'remaining_usd', ROUND(v_remaining_usd, 6),
    'request_count', v_request_count,
    'blocked', v_blocked,
    'global_spent_usd', ROUND(v_global_spent_usd, 6),
    'global_cap_usd', ROUND(v_global_cap, 4),
    'global_exhausted', (v_global_spent_usd >= v_global_cap)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_ai_quota_status(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_ai_quota_status(uuid, text) TO service_role;

-- 5. RPC: check_and_reserve_ai_rate (atomic row lock + rate window + quota checks)
CREATE OR REPLACE FUNCTION public.check_and_reserve_ai_rate(
  p_user_id uuid,
  p_month_ym text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
  v_default_limit numeric(10,4) := 1.0000;
  v_global_cap numeric(10,4) := 15.0000;
  v_rate_limit integer := 20;
  v_override_limit numeric(10,4);
  v_blocked boolean := false;
  v_limit_usd numeric(10,4);
  v_spent_usd numeric(10,6) := 0;
  v_window_started_at timestamptz;
  v_window_count integer := 0;
  v_global_spent_usd numeric(12,6) := 0;
  v_remaining_usd numeric(10,6);
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

  INSERT INTO public.ai_usage_monthly (user_id, month_ym, window_started_at, window_count, updated_at)
  VALUES (p_user_id, p_month_ym, v_now, 0, v_now)
  ON CONFLICT (user_id, month_ym) DO NOTHING;

  SELECT u.spent_usd, u.window_started_at, u.window_count
    INTO v_spent_usd, v_window_started_at, v_window_count
    FROM public.ai_usage_monthly u
   WHERE u.user_id = p_user_id
     AND u.month_ym = p_month_ym
     FOR UPDATE;

  v_spent_usd := COALESCE(v_spent_usd, 0);
  v_remaining_usd := GREATEST(0::numeric, v_limit_usd - v_spent_usd);

  IF v_blocked THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'blocked',
      'spent_usd', ROUND(v_spent_usd, 6),
      'limit_usd', ROUND(v_limit_usd, 4),
      'remaining_usd', ROUND(v_remaining_usd, 6)
    );
  END IF;

  IF v_spent_usd >= v_limit_usd THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'user_quota_exceeded',
      'spent_usd', ROUND(v_spent_usd, 6),
      'limit_usd', ROUND(v_limit_usd, 4),
      'remaining_usd', ROUND(v_remaining_usd, 6)
    );
  END IF;

  SELECT COALESCE(SUM(u.spent_usd), 0)
    INTO v_global_spent_usd
    FROM public.ai_usage_monthly u
   WHERE u.month_ym = p_month_ym;

  IF v_global_spent_usd >= v_global_cap THEN
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
           updated_at = v_now
     WHERE user_id = p_user_id
       AND month_ym = p_month_ym;
  ELSIF v_window_count >= v_rate_limit THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'rate_limit_exceeded',
      'spent_usd', ROUND(v_spent_usd, 6),
      'limit_usd', ROUND(v_limit_usd, 4),
      'remaining_usd', ROUND(v_remaining_usd, 6)
    );
  ELSE
    UPDATE public.ai_usage_monthly
       SET window_count = window_count + 1,
           updated_at = v_now
     WHERE user_id = p_user_id
       AND month_ym = p_month_ym;
  END IF;

  RETURN jsonb_build_object(
    'allowed', true,
    'reason', NULL,
    'spent_usd', ROUND(v_spent_usd, 6),
    'limit_usd', ROUND(v_limit_usd, 4),
    'remaining_usd', ROUND(v_remaining_usd, 6)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.check_and_reserve_ai_rate(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_and_reserve_ai_rate(uuid, text) TO service_role;

-- 6. RPC: record_ai_usage (atomic upsert of actual token & USD spend)
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
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
  v_safe_cost numeric(10,6) := GREATEST(0::numeric, COALESCE(p_cost_usd, 0));
  v_safe_in bigint := GREATEST(0::bigint, COALESCE(p_in_tokens, 0));
  v_safe_out bigint := GREATEST(0::bigint, COALESCE(p_out_tokens, 0));
  v_default_limit numeric(10,4) := 1.0000;
  v_override_limit numeric(10,4);
  v_limit_usd numeric(10,4);
  v_spent_usd numeric(10,6);
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
    1,
    v_safe_in,
    v_safe_out,
    v_now,
    1,
    v_now
  )
  ON CONFLICT (user_id, month_ym) DO UPDATE
    SET spent_usd = public.ai_usage_monthly.spent_usd + v_safe_cost,
        request_count = public.ai_usage_monthly.request_count + 1,
        input_tokens = public.ai_usage_monthly.input_tokens + v_safe_in,
        output_tokens = public.ai_usage_monthly.output_tokens + v_safe_out,
        updated_at = v_now
  RETURNING spent_usd, request_count
    INTO v_spent_usd, v_request_count;

  v_remaining_usd := GREATEST(0::numeric, v_limit_usd - v_spent_usd);

  RETURN jsonb_build_object(
    'spent_usd', ROUND(v_spent_usd, 6),
    'limit_usd', ROUND(v_limit_usd, 4),
    'remaining_usd', ROUND(v_remaining_usd, 6),
    'request_count', v_request_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_ai_usage(uuid, text, numeric, bigint, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_ai_usage(uuid, text, numeric, bigint, bigint) TO service_role;
