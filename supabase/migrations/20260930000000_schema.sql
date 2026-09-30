-- Gestão de Tráfego · Pedro Granado Imóveis
-- Estrutura do banco. Rode uma vez no SQL Editor do Supabase (ou via "supabase db push").

create table if not exists public.ad_accounts (
  id          text primary key,              -- act_000000000
  name        text,
  currency    text,
  timezone    text,
  updated_at  timestamptz not null default now()
);

create table if not exists public.campaigns (
  id                text primary key,
  account_id        text references public.ad_accounts(id) on delete set null,
  name              text not null,
  objective         text,
  status            text,
  effective_status  text,
  daily_budget      numeric(14,2),
  lifetime_budget   numeric(14,2),
  start_time        timestamptz,
  stop_time         timestamptz,
  created_time      timestamptz,
  updated_time      timestamptz,
  synced_at         timestamptz not null default now()
);
create index if not exists campaigns_status_idx on public.campaigns (effective_status);

-- Uma linha por campanha por dia. É o histórico que alimenta painel, relatórios e análises.
create table if not exists public.campaign_insights_daily (
  campaign_id    text not null references public.campaigns(id) on delete cascade,
  date           date not null,
  account_id     text,
  spend          numeric(14,2) not null default 0,
  impressions    bigint not null default 0,
  reach          bigint not null default 0,
  clicks         bigint not null default 0,
  link_clicks    bigint not null default 0,
  leads          numeric(12,2) not null default 0,
  conversations  numeric(12,2) not null default 0,
  actions        jsonb,                        -- todas as ações brutas retornadas pela Meta
  synced_at      timestamptz not null default now(),
  primary key (campaign_id, date)
);
create index if not exists insights_date_idx on public.campaign_insights_daily (date);

create table if not exists public.reports (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  campaign_ids  text[],
  date_from     date not null,
  date_to       date not null,
  file_path     text not null,
  file_size     integer,
  summary       jsonb,
  created_at    timestamptz not null default now()
);

create table if not exists public.telegram_messages (
  id            uuid primary key default gen_random_uuid(),
  origin        text not null check (origin in ('manual', 'agendado')),
  campaign_ids  text[],
  date_from     date,
  date_to       date,
  text          text not null,
  status        text not null,
  error         text,
  created_at    timestamptz not null default now()
);

create table if not exists public.sync_runs (
  id           bigserial primary key,
  origin       text not null,
  days         integer,
  status       text not null,
  details      jsonb,
  error        text,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz
);

-- Acesso somente pela Edge Function (service role). Sem políticas públicas:
-- a chave anônima não lê nem grava nada.
alter table public.ad_accounts             enable row level security;
alter table public.campaigns               enable row level security;
alter table public.campaign_insights_daily enable row level security;
alter table public.reports                 enable row level security;
alter table public.telegram_messages       enable row level security;
alter table public.sync_runs               enable row level security;

-- Pasta privada para os PDFs gerados.
insert into storage.buckets (id, name, public)
values ('relatorios', 'relatorios', false)
on conflict (id) do nothing;
