-- Fase 1 — Fundação
-- Núcleo: organizações, perfis de usuário, papéis (roles), configurações
-- do sistema e trilha de auditoria. Toda tabela com dado sensível carrega
-- organization_id e política RLS correspondente.

create extension if not exists "pgcrypto";
-- ---------------------------------------------------------------------
-- organizations
-- ---------------------------------------------------------------------
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);
comment on table public.organizations is
  'Organização proprietária dos dados. Fase 1: apenas a Pedro Granado Imóveis. Mantida como tabela própria para permitir expansão futura do grupo sem migration estrutural.';
-- ---------------------------------------------------------------------
-- roles — catálogo fixo dos 4 perfis de acesso
-- ---------------------------------------------------------------------
create table public.roles (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key in ('admin', 'marketing', 'comercial', 'diretoria')),
  label text not null
);
comment on table public.roles is 'Catálogo fixo dos perfis de acesso do sistema.';
-- ---------------------------------------------------------------------
-- profiles — 1:1 com auth.users
-- ---------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  organization_id uuid not null references public.organizations (id),
  full_name text not null,
  email text not null,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index profiles_organization_id_idx on public.profiles (organization_id);
comment on table public.profiles is 'Dados do usuário da aplicação, 1:1 com auth.users.';
-- ---------------------------------------------------------------------
-- user_roles — N:N entre profiles e roles
-- ---------------------------------------------------------------------
create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  role_id uuid not null references public.roles (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (profile_id, role_id)
);
create index user_roles_profile_id_idx on public.user_roles (profile_id);
-- ---------------------------------------------------------------------
-- app_settings — parâmetros configuráveis (pesos de ranking, limites de
-- score de saúde, thresholds de orçamento). Nunca hardcoded no código.
-- ---------------------------------------------------------------------
create table public.app_settings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  key text not null,
  value jsonb not null,
  description text,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id),
  unique (organization_id, key)
);
comment on table public.app_settings is
  'Parâmetros configuráveis do sistema (pesos de ranking, limites de score de saúde, thresholds de orçamento).';
-- ---------------------------------------------------------------------
-- audit_logs — trilha de auditoria genérica
-- ---------------------------------------------------------------------
create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  actor_id uuid references public.profiles (id),
  action text not null,
  entity_type text not null,
  entity_id uuid,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_organization_id_idx on public.audit_logs (organization_id);
create index audit_logs_entity_idx on public.audit_logs (entity_type, entity_id);
-- ---------------------------------------------------------------------
-- Funções auxiliares para RLS (security definer para evitar recursão nas
-- políticas de profiles/user_roles).
-- ---------------------------------------------------------------------
create or replace function public.current_organization_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select organization_id from public.profiles where id = auth.uid();
$$;
create or replace function public.has_role(role_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.roles r on r.id = ur.role_id
    where ur.profile_id = auth.uid() and r.key = role_key
  );
$$;
-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------
alter table public.organizations enable row level security;
alter table public.roles enable row level security;
alter table public.profiles enable row level security;
alter table public.user_roles enable row level security;
alter table public.app_settings enable row level security;
alter table public.audit_logs enable row level security;
create policy "organizations: select own" on public.organizations
  for select to authenticated
  using (id = public.current_organization_id());
create policy "roles: select all authenticated" on public.roles
  for select to authenticated
  using (true);
create policy "profiles: select within org" on public.profiles
  for select to authenticated
  using (organization_id = public.current_organization_id());
create policy "profiles: update own" on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());
create policy "profiles: admin manage within org" on public.profiles
  for all to authenticated
  using (organization_id = public.current_organization_id() and public.has_role('admin'))
  with check (organization_id = public.current_organization_id() and public.has_role('admin'));
create policy "user_roles: select within org" on public.user_roles
  for select to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = user_roles.profile_id
        and p.organization_id = public.current_organization_id()
    )
  );
create policy "user_roles: admin manage within org" on public.user_roles
  for all to authenticated
  using (
    public.has_role('admin')
    and exists (
      select 1 from public.profiles p
      where p.id = user_roles.profile_id
        and p.organization_id = public.current_organization_id()
    )
  )
  with check (
    public.has_role('admin')
    and exists (
      select 1 from public.profiles p
      where p.id = user_roles.profile_id
        and p.organization_id = public.current_organization_id()
    )
  );
create policy "app_settings: select within org" on public.app_settings
  for select to authenticated
  using (organization_id = public.current_organization_id());
create policy "app_settings: admin manage within org" on public.app_settings
  for all to authenticated
  using (organization_id = public.current_organization_id() and public.has_role('admin'))
  with check (organization_id = public.current_organization_id() and public.has_role('admin'));
create policy "audit_logs: admin select within org" on public.audit_logs
  for select to authenticated
  using (organization_id = public.current_organization_id() and public.has_role('admin'));
-- Inserts em audit_logs são feitos pelo backend com a service role key
-- (que ignora RLS), nunca diretamente pelo client autenticado.

-- ---------------------------------------------------------------------
-- Trigger: criar profile automaticamente ao criar um usuário no Auth.
-- O usuário é vinculado à organização única da Fase 1. Nenhum papel é
-- atribuído automaticamente — um administrador deve atribuir o papel
-- explicitamente em public.user_roles.
-- ---------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  default_org_id uuid;
begin
  select id into default_org_id from public.organizations order by created_at limit 1;

  insert into public.profiles (id, organization_id, full_name, email)
  values (
    new.id,
    default_org_id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.email),
    new.email
  );

  return new;
end;
$$;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
-- ---------------------------------------------------------------------
-- Seed de referência (não é dado fictício de demonstração): organização
-- real da empresa e catálogo fixo de papéis.
-- ---------------------------------------------------------------------
insert into public.organizations (name) values ('Pedro Granado Imóveis');
insert into public.roles (key, label) values
  ('admin', 'Administrador'),
  ('marketing', 'Marketing'),
  ('comercial', 'Comercial'),
  ('diretoria', 'Diretoria');
