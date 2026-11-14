-- Team onboarding: teams above workspaces, email-bound invites, project grants.
-- `members` stays the single source of project access. Team grants are materialised there
-- with source = 'team', so no existing policy or helper changes. See specs/architecture.

-- ─────────────────────────────────────────────────────────────── tables

create table public.teams (
  id                uuid primary key default gen_random_uuid(),
  slug              text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,48}$'),
  name              text not null check (length(name) between 1 and 200),
  new_member_access text not null default 'none' check (new_member_access in ('none', 'all_projects')),
  created_by        uuid not null default auth.uid() references auth.users (id),
  created_at        timestamptz not null default now()
);

create table public.team_members (
  team_id   uuid not null references public.teams (id) on delete cascade,
  user_id   uuid not null references auth.users (id) on delete cascade,
  role      text not null default 'member' check (role in ('owner', 'admin', 'member')),
  joined_at timestamptz not null default now(),
  primary key (team_id, user_id)
);
create index team_members_user_id_idx on public.team_members (user_id);

alter table public.workspaces add column team_id uuid references public.teams (id) on delete set null;
create index workspaces_team_id_idx on public.workspaces (team_id);

alter table public.members add column source text not null default 'direct'
  check (source in ('direct', 'team'));

create table public.email_invites (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references public.teams (id) on delete cascade,
  email       text not null check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+$'),
  team_role   text not null default 'member' check (team_role in ('admin', 'member')),
  grants      jsonb not null default '[]'::jsonb,   -- [{workspace_id, role}]
  status      text not null default 'pending' check (status in ('pending', 'accepted', 'revoked', 'expired')),
  invited_by  uuid not null default auth.uid() references auth.users (id),
  accepted_by uuid references auth.users (id),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '14 days',
  accepted_at timestamptz
);
create unique index email_invites_one_pending on public.email_invites (team_id, email) where status = 'pending';
create index email_invites_email_idx on public.email_invites (email) where status = 'pending';

-- ─────────────────────────────────────────────────────────────── helpers

create function private.is_team_member(t uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.team_members m
    where m.team_id = t and m.user_id = (select auth.uid())
  );
$$;

create function private.is_team_admin(t uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.team_members m
    where m.team_id = t and m.user_id = (select auth.uid()) and m.role in ('owner', 'admin')
  );
$$;

create function private.is_team_owner(t uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.team_members m
    where m.team_id = t and m.user_id = (select auth.uid()) and m.role = 'owner'
  );
$$;

-- A handle from the email's local part, free in this workspace. Reuses the person's
-- handle from another project of the same team when it is still free here.
create function private.derive_handle(ws uuid, uid uuid, email text)
returns text
language plpgsql stable security definer set search_path = ''
as $$
declare
  base text;
  h    text;
  n    int := 1;
begin
  select m.handle into h
  from public.members m
  join public.workspaces w on w.id = m.workspace_id
  where m.user_id = uid
    and w.team_id = (select team_id from public.workspaces where id = ws)
    and not exists (select 1 from public.members x where x.workspace_id = ws and x.handle = m.handle)
  order by m.joined_at limit 1;
  if h is not null then return h; end if;

  base := left(regexp_replace(lower(split_part(email, '@', 1)), '[^a-z0-9_-]', '', 'g'), 28);
  if length(base) < 2 then base := 'user'; end if;
  h := base;
  while exists (select 1 from public.members where workspace_id = ws and handle = h) loop
    n := n + 1;
    h := base || n;
  end loop;
  return h;
end;
$$;

-- Give a user access to a project through the team. Never downgrades an existing role.
create function private.grant_project(ws uuid, uid uuid, p_role text, email text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  h text;
begin
  if exists (select 1 from public.members where workspace_id = ws and user_id = uid) then
    return false;
  end if;
  h := private.derive_handle(ws, uid, email);
  insert into public.members (workspace_id, user_id, handle, role, source)
  values (ws, uid, h, p_role, 'team');
  insert into public.events (workspace_id, author_id, kind, payload)
  values (ws, uid, 'member', jsonb_build_object('action', 'joined', 'handle', h, 'via', 'team'));
  return true;
end;
$$;

revoke execute on function private.is_team_member(uuid), private.is_team_admin(uuid), private.is_team_owner(uuid),
  private.derive_handle(uuid, uuid, text), private.grant_project(uuid, uuid, text, text) from public, anon;
grant execute on function private.is_team_member(uuid), private.is_team_admin(uuid), private.is_team_owner(uuid)
  to authenticated;

-- ─────────────────────────────────────────────────────────────── RLS

alter table public.teams         enable row level security;
alter table public.team_members  enable row level security;
alter table public.email_invites enable row level security;

create policy teams_select on public.teams for select to authenticated
  using ((select private.is_team_member(id)));
create policy teams_update on public.teams for update to authenticated
  using ((select private.is_team_admin(id)))
  with check ((select private.is_team_admin(id)));

create policy team_members_select on public.team_members for select to authenticated
  using ((select private.is_team_member(team_id)));

create policy email_invites_select on public.email_invites for select to authenticated
  using ((select private.is_team_admin(team_id)));

revoke all on public.teams, public.team_members, public.email_invites from anon, authenticated;
grant select on public.teams, public.team_members, public.email_invites to authenticated;
grant update (name, new_member_access) on public.teams to authenticated;

-- ─────────────────────────────────────────────────────────────── RPCs

create function public.create_team(p_slug text, p_name text)
returns public.teams
language plpgsql security definer set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  t   public.teams;
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  insert into public.teams (slug, name, created_by) values (p_slug, p_name, uid) returning * into t;
  insert into public.team_members (team_id, user_id, role) values (t.id, uid, 'owner');
  return t;
end;
$$;

create function public.attach_workspace_to_team(p_workspace uuid, p_team uuid)
returns public.workspaces
language plpgsql security definer set search_path = ''
as $$
declare
  ws public.workspaces;
begin
  if not (select private.is_owner(p_workspace)) or not (select private.is_team_admin(p_team)) then
    raise exception 'need to own the project and administer the team' using errcode = '42501';
  end if;
  update public.workspaces set team_id = p_team where id = p_workspace returning * into ws;
  return ws;
end;
$$;

-- Record invites. Grants are [{workspace_id, role}] and must be projects of this team.
-- Sending the email is the Edge Function's job; accepting happens on sign-in.
create function public.invite_to_team(
  p_team uuid, p_emails text[], p_team_role text default 'member', p_grants jsonb default '[]'::jsonb
)
returns setof public.email_invites
language plpgsql security definer set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  e   text;
  g   jsonb;
  inv public.email_invites;
begin
  if not (select private.is_team_admin(p_team)) then
    raise exception 'only team admins can invite' using errcode = '42501';
  end if;
  if p_team_role not in ('admin', 'member') then
    raise exception 'invalid team role' using errcode = '22023';
  end if;
  if p_team_role = 'admin' and not (select private.is_team_owner(p_team)) then
    raise exception 'only team owners can invite admins' using errcode = '42501';
  end if;
  if coalesce(array_length(p_emails, 1), 0) not between 1 and 50 then
    raise exception 'invite between 1 and 50 emails at a time' using errcode = '22023';
  end if;
  if jsonb_typeof(p_grants) <> 'array' then
    raise exception 'grants must be an array' using errcode = '22023';
  end if;
  for g in select * from jsonb_array_elements(p_grants) loop
    if coalesce(g ->> 'role', '') not in ('editor', 'viewer')
       or not exists (select 1 from public.workspaces w
                      where w.id::text = g ->> 'workspace_id' and w.team_id = p_team) then
      raise exception 'each grant needs an editor or viewer role on a project of this team' using errcode = '22023';
    end if;
  end loop;

  foreach e in array p_emails loop
    e := lower(btrim(e));
    insert into public.email_invites (team_id, email, team_role, grants, invited_by)
    values (p_team, e, p_team_role, p_grants, uid)
    on conflict (team_id, email) where status = 'pending'
    do update set team_role = excluded.team_role, grants = excluded.grants,
                  invited_by = excluded.invited_by, expires_at = now() + interval '14 days'
    returning * into inv;
    return next inv;
  end loop;
end;
$$;

create function public.revoke_invite(p_invite uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  t uuid;
begin
  select team_id into t from public.email_invites where id = p_invite and status = 'pending';
  if t is null then
    raise exception 'no pending invite' using errcode = 'P0002';
  end if;
  if not (select private.is_team_admin(t)) then
    raise exception 'only team admins can revoke invites' using errcode = '42501';
  end if;
  update public.email_invites set status = 'revoked' where id = p_invite;
end;
$$;

-- Apply every pending invite addressed to the caller's verified email.
-- Returns [{team, workspaces: [slug…]}] for what was just applied.
create function public.accept_pending_invites()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  uid     uuid := (select auth.uid());
  em      text;
  inv     public.email_invites;
  t       public.teams;
  g       jsonb;
  w       record;
  slugs   text[];
  result  jsonb := '[]'::jsonb;
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  select lower(u.email) into em from auth.users u where u.id = uid and u.email_confirmed_at is not null;
  if em is null then
    return result;
  end if;

  for inv in
    select * from public.email_invites where email = em and status = 'pending' order by created_at for update
  loop
    if inv.expires_at < now() then
      update public.email_invites set status = 'expired' where id = inv.id;
      continue;
    end if;
    select * into t from public.teams where id = inv.team_id;
    slugs := '{}';

    insert into public.team_members (team_id, user_id, role) values (inv.team_id, uid, inv.team_role)
    on conflict (team_id, user_id) do nothing;

    for g in select * from jsonb_array_elements(inv.grants) loop
      for w in select id, slug from public.workspaces
               where id::text = g ->> 'workspace_id' and team_id = inv.team_id loop
        if private.grant_project(w.id, uid, g ->> 'role', em) then
          slugs := slugs || w.slug;
        end if;
      end loop;
    end loop;

    if t.new_member_access = 'all_projects' then
      for w in select id, slug from public.workspaces where team_id = inv.team_id loop
        if private.grant_project(w.id, uid, 'editor', em) then
          slugs := slugs || w.slug;
        end if;
      end loop;
    end if;

    update public.email_invites
      set status = 'accepted', accepted_by = uid, accepted_at = now()
      where id = inv.id;
    result := result || jsonb_build_object('team', t.slug, 'workspaces', to_jsonb(slugs));
  end loop;
  return result;
end;
$$;

create function public.set_team_member_role(p_team uuid, p_user uuid, p_role text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  cur text;
begin
  if p_role not in ('owner', 'admin', 'member') then
    raise exception 'invalid team role' using errcode = '22023';
  end if;
  if not (select private.is_team_owner(p_team)) then
    raise exception 'only team owners change roles' using errcode = '42501';
  end if;
  select role into cur from public.team_members where team_id = p_team and user_id = p_user for update;
  if cur is null then
    raise exception 'not a team member' using errcode = 'P0002';
  end if;
  if cur = 'owner' and p_role <> 'owner'
     and (select count(*) from public.team_members where team_id = p_team and role = 'owner') = 1 then
    raise exception 'a team needs at least one owner' using errcode = '23514';
  end if;
  update public.team_members set role = p_role where team_id = p_team and user_id = p_user;
end;
$$;

-- Admins remove anyone below owner; anyone can leave. Removes team-granted project access only.
create function public.remove_team_member(p_team uuid, p_user uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  cur text;
begin
  select role into cur from public.team_members where team_id = p_team and user_id = p_user for update;
  if cur is null then
    raise exception 'not a team member' using errcode = 'P0002';
  end if;
  if p_user <> uid then
    if not (select private.is_team_admin(p_team)) or (cur <> 'member' and not (select private.is_team_owner(p_team))) then
      raise exception 'not allowed to remove this member' using errcode = '42501';
    end if;
  end if;
  if cur = 'owner' and (select count(*) from public.team_members where team_id = p_team and role = 'owner') = 1 then
    raise exception 'a team needs at least one owner' using errcode = '23514';
  end if;
  delete from public.members m
    using public.workspaces w
    where m.workspace_id = w.id and w.team_id = p_team and m.user_id = p_user and m.source = 'team';
  delete from public.team_members where team_id = p_team and user_id = p_user;
end;
$$;

create function public.grant_project_access(p_workspace uuid, p_user uuid, p_role text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  t uuid;
  em text;
begin
  if p_role not in ('editor', 'viewer') then
    raise exception 'role must be editor or viewer' using errcode = '22023';
  end if;
  select team_id into t from public.workspaces where id = p_workspace;
  if not ((select private.is_owner(p_workspace)) or (t is not null and (select private.is_team_admin(t)))) then
    raise exception 'only project owners or team admins can grant access' using errcode = '42501';
  end if;
  if t is not null and not exists (select 1 from public.team_members where team_id = t and user_id = p_user) then
    raise exception 'that person is not on the team' using errcode = 'P0002';
  end if;
  select u.email into em from auth.users u where u.id = p_user;
  if not private.grant_project(p_workspace, p_user, p_role, coalesce(em, 'user')) then
    -- already a member: change the role unless they own the project
    update public.members set role = p_role
      where workspace_id = p_workspace and user_id = p_user and role <> 'owner';
  end if;
end;
$$;

create function public.revoke_project_access(p_workspace uuid, p_user uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  t uuid;
  cur text;
begin
  select team_id into t from public.workspaces where id = p_workspace;
  if not ((select private.is_owner(p_workspace)) or (t is not null and (select private.is_team_admin(t)))) then
    raise exception 'only project owners or team admins can revoke access' using errcode = '42501';
  end if;
  select role into cur from public.members where workspace_id = p_workspace and user_id = p_user;
  if cur is null then
    raise exception 'not a project member' using errcode = 'P0002';
  end if;
  if cur = 'owner' then
    raise exception 'remove the project owner by transferring ownership first' using errcode = '23514';
  end if;
  delete from public.members where workspace_id = p_workspace and user_id = p_user;
end;
$$;

revoke execute on function
  public.create_team(text, text), public.attach_workspace_to_team(uuid, uuid),
  public.invite_to_team(uuid, text[], text, jsonb), public.revoke_invite(uuid),
  public.accept_pending_invites(), public.set_team_member_role(uuid, uuid, text),
  public.remove_team_member(uuid, uuid), public.grant_project_access(uuid, uuid, text),
  public.revoke_project_access(uuid, uuid)
  from public, anon;
grant execute on function
  public.create_team(text, text), public.attach_workspace_to_team(uuid, uuid),
  public.invite_to_team(uuid, text[], text, jsonb), public.revoke_invite(uuid),
  public.accept_pending_invites(), public.set_team_member_role(uuid, uuid, text),
  public.remove_team_member(uuid, uuid), public.grant_project_access(uuid, uuid, text),
  public.revoke_project_access(uuid, uuid)
  to authenticated;
