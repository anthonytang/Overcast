-- Reproducible artifacts from Overcast's local calibrated decision engine.
-- Forecast runs remain the canonical UI history. This table stores the
-- feature/model/calibration lineage needed to replay a recommendation.
create table if not exists public.analytics_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references public.bank_accounts(id) on delete cascade,
  model_version text not null,
  model_family text not null,
  input_fingerprint text not null,
  simulation_count integer not null check (simulation_count > 0),
  calibration_windows integer not null default 0 check (calibration_windows >= 0),
  calibration_radius numeric(14, 2) not null default 0,
  risk_target numeric(5, 4) not null check (risk_target > 0 and risk_target <= 1),
  result jsonb not null,
  generated_at timestamptz not null default now()
);

create index if not exists analytics_runs_account_generated_idx
  on public.analytics_runs(account_id, generated_at desc);

alter table public.analytics_runs enable row level security;

create policy "users manage their own analytics runs"
  on public.analytics_runs for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
