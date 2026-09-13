-- Overdraft Radar's minimal auditable financial-data model.
-- Apply through the Supabase SQL Editor or Supabase CLI only after review.

create extension if not exists pgcrypto;

create table if not exists public.bank_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plaid_item_id text not null unique,
  access_token_encrypted text not null,
  institution_name text,
  sync_cursor text,
  status text not null default 'active' check (status in ('active', 'error', 'revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bank_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  bank_item_id uuid not null references public.bank_items(id) on delete cascade,
  plaid_account_id text not null unique,
  name text not null,
  official_name text,
  mask text,
  account_type text not null,
  current_balance numeric(14, 2),
  available_balance numeric(14, 2),
  balance_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references public.bank_accounts(id) on delete cascade,
  plaid_transaction_id text not null unique,
  posted_date date not null,
  authorized_date date,
  amount numeric(14, 2) not null,
  merchant_name text,
  description text not null,
  primary_category text,
  detailed_category text,
  pending boolean not null default false,
  is_removed boolean not null default false,
  raw_payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists transactions_user_date_idx on public.transactions(user_id, posted_date desc);
create index if not exists transactions_account_date_idx on public.transactions(account_id, posted_date desc);

create table if not exists public.recurring_streams (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references public.bank_accounts(id) on delete cascade,
  plaid_stream_id text unique,
  name text not null,
  amount numeric(14, 2) not null check (amount >= 0),
  cadence_days integer not null check (cadence_days > 0),
  next_expected_date date,
  is_income boolean not null,
  source text not null default 'plaid' check (source in ('plaid', 'user')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.forecast_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references public.bank_accounts(id) on delete cascade,
  model_version text not null,
  input_version text not null,
  generated_at timestamptz not null default now(),
  horizon_days integer not null check (horizon_days between 1 and 90),
  overdraft_probability numeric(5, 4) not null check (overdraft_probability between 0 and 1),
  result jsonb not null
);

create index if not exists forecast_runs_account_generated_idx on public.forecast_runs(account_id, generated_at desc);

alter table public.bank_items enable row level security;
alter table public.bank_accounts enable row level security;
alter table public.transactions enable row level security;
alter table public.recurring_streams enable row level security;
alter table public.forecast_runs enable row level security;

create policy "users manage their own bank items" on public.bank_items for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "users manage their own bank accounts" on public.bank_accounts for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "users manage their own transactions" on public.transactions for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "users manage their own recurring streams" on public.recurring_streams for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "users manage their own forecast runs" on public.forecast_runs for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
