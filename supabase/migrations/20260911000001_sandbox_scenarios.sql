-- Persisted only for the connected Plaid Sandbox item. These are demo
-- overlays, never bank transactions and never sent to Plaid.
create table if not exists public.sandbox_scenarios (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  bank_item_id uuid not null unique references public.bank_items(id) on delete cascade,
  events jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.sandbox_scenarios enable row level security;

create policy "users manage their own sandbox scenarios"
  on public.sandbox_scenarios for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
