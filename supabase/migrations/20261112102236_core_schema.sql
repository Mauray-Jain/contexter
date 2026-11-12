-- contexter core schema: workspaces, members, invites, sessions, the shared event feed,
-- versioned units, reasoning records and shared memory.
--
-- Access model: every row belongs to a workspace; only members of that workspace can see it.
-- Viewers read, owners/editors write. Events, unit versions and records are append-only.

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

-- ─────────────────────────────────────────────────────────────── tables

create table public.workspaces (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,48}$'),
  name        text not null check (length(name) between 1 and 200),
  template    text not null default 'blank',
  manifest    jsonb not null default '{}'::jsonb,
  created_by  uuid not null default auth.uid() references auth.users (id),
  created_at  timestamptz not null default now()
);

create table public.members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  handle       text not null check (handle ~ '^[a-z0-9_-]{2,32}$'),
  role         text not null default 'editor' check (role in ('owner', 'editor', 'viewer')),
  joined_at    timestamptz not null default now(),
  primary key (workspace_id, user_id),
  unique (workspace_id, handle)
);
create index members_user_id_idx on public.members (user_id);

create table public.invites (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  code         text not null unique default translate(encode(extensions.gen_random_bytes(9), 'base64'), '+/', '-_'),
  role         text not null default 'editor' check (role in ('editor', 'viewer')),
  max_uses     int not null default 1 check (max_uses > 0),
  uses         int not null default 0,
  expires_at   timestamptz not null default now() + interval '7 days',
  created_by   uuid not null default auth.uid() references auth.users (id),
  created_at   timestamptz not null default now()
);
create index invites_workspace_id_idx on public.invites (workspace_id);

create table public.sessions (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  client       text not null check (client in ('claude-code', 'claude-chat', 'cli', 'other')),
  title        text,
  focus_unit   uuid,
  started_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  ended_at     timestamptz
);
create index sessions_workspace_seen_idx on public.sessions (workspace_id, last_seen_at desc);
create index sessions_user_id_idx on public.sessions (user_id);

create table public.events (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  session_id   uuid references public.sessions (id) on delete set null,
  author_id    uuid not null default auth.uid() references auth.users (id),
  kind         text not null check (kind in
                 ('prompt', 'reply', 'edit', 'record', 'status', 'presence',
                  'mention', 'compaction', 'member', 'lock')),
  payload      jsonb not null default '{}'::jsonb,
  mentions     text[] not null default '{}',
  created_at   timestamptz not null default now()
);
create index events_workspace_id_id_idx on public.events (workspace_id, id);
create index events_session_id_idx on public.events (session_id);
create index events_mentions_idx on public.events using gin (mentions);

create table public.cursors (
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  last_event_id bigint not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table public.units (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces (id) on delete cascade,
  collection      text not null check (collection ~ '^[a-z0-9_-]{1,64}$'),
  key             text not null check (key ~ '^[a-z0-9_.-]{1,128}$'),
  kind            text not null default 'managed' check (kind in ('managed', 'linked')),
  status          text not null default 'outline',
  position        int,
  owner_id        uuid references auth.users (id),
  meta            jsonb not null default '{}'::jsonb,
  current_version int not null default 0,
  lock_holder     uuid references auth.users (id),
  lock_session    uuid references public.sessions (id) on delete set null,
  lock_expires_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (workspace_id, collection, key)
);

create table public.unit_versions (
  unit_id    uuid not null references public.units (id) on delete cascade,
  version    int not null,
  content    text not null,
  summary    text not null,
  author_id  uuid not null default auth.uid() references auth.users (id),
  event_id   bigint references public.events (id),
  created_at timestamptz not null default now(),
  primary key (unit_id, version)
);

create table public.records (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  type          text not null check (type in
                  ('decision', 'rationale', 'alternative', 'finding', 'question', 'session')),
  number        int not null,
  title         text not null,
  body          text not null,
  links         jsonb not null default '[]'::jsonb,
  status        text not null default 'open',
  superseded_by uuid references public.records (id),
  author_id     uuid not null default auth.uid() references auth.users (id),
  event_id      bigint references public.events (id),
  created_at    timestamptz not null default now(),
  unique (workspace_id, type, number)
);
create index records_workspace_created_idx on public.records (workspace_id, created_at desc);

create table public.shared_memory (
  workspace_id       uuid not null references public.workspaces (id) on delete cascade,
  version            int not null,
  summary            text not null,
  covers_up_to_event bigint not null,
  created_by         uuid not null default auth.uid() references auth.users (id),
  created_at         timestamptz not null default now(),
  primary key (workspace_id, version)
);

-- ─────────────────────────────────────────────────────────────── membership helpers
-- SECURITY DEFINER so policies on `members` don't recurse into themselves. Kept in the
-- unexposed `private` schema; each checks the caller via auth.uid().

create function private.is_member(ws uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.members m
    where m.workspace_id = ws and m.user_id = (select auth.uid())
  );
$$;

create function private.can_write(ws uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.members m
    where m.workspace_id = ws and m.user_id = (select auth.uid())
      and m.role in ('owner', 'editor')
  );
$$;

create function private.is_owner(ws uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.members m
    where m.workspace_id = ws and m.user_id = (select auth.uid()) and m.role = 'owner'
  );
$$;

revoke execute on function private.is_member(uuid), private.can_write(uuid), private.is_owner(uuid)
  from public, anon;
grant execute on function private.is_member(uuid), private.can_write(uuid), private.is_owner(uuid)
  to authenticated;

-- ─────────────────────────────────────────────────────────────── RLS

alter table public.workspaces    enable row level security;
alter table public.members       enable row level security;
alter table public.invites       enable row level security;
alter table public.sessions      enable row level security;
alter table public.events        enable row level security;
alter table public.cursors       enable row level security;
alter table public.units         enable row level security;
alter table public.unit_versions enable row level security;
alter table public.records       enable row level security;
alter table public.shared_memory enable row level security;

-- workspaces: created through create_workspace(); members read, owners update.
create policy workspaces_select on public.workspaces for select to authenticated
  using ((select private.is_member(id)));
create policy workspaces_update on public.workspaces for update to authenticated
  using ((select private.is_owner(id)))
  with check ((select private.is_owner(id)));

-- members: joined through join_workspace(); members see each other, owners manage roles.
create policy members_select on public.members for select to authenticated
  using ((select private.is_member(workspace_id)));
create policy members_update on public.members for update to authenticated
  using ((select private.is_owner(workspace_id)))
  with check ((select private.is_owner(workspace_id)));
create policy members_delete on public.members for delete to authenticated
  using ((select private.is_owner(workspace_id)) or user_id = (select auth.uid()));

-- invites: owners only.
create policy invites_select on public.invites for select to authenticated
  using ((select private.is_owner(workspace_id)));
create policy invites_insert on public.invites for insert to authenticated
  with check ((select private.is_owner(workspace_id)) and created_by = (select auth.uid()));
create policy invites_delete on public.invites for delete to authenticated
  using ((select private.is_owner(workspace_id)));

-- sessions: members see all (presence); you manage your own.
create policy sessions_select on public.sessions for select to authenticated
  using ((select private.is_member(workspace_id)));
create policy sessions_insert on public.sessions for insert to authenticated
  with check ((select private.is_member(workspace_id)) and user_id = (select auth.uid()));
create policy sessions_update on public.sessions for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and (select private.is_member(workspace_id)));

-- events: append-only feed. Any member (including viewers) may post as themselves.
create policy events_select on public.events for select to authenticated
  using ((select private.is_member(workspace_id)));
create policy events_insert on public.events for insert to authenticated
  with check ((select private.is_member(workspace_id)) and author_id = (select auth.uid()));

-- cursors: strictly your own.
create policy cursors_select on public.cursors for select to authenticated
  using (user_id = (select auth.uid()));
create policy cursors_insert on public.cursors for insert to authenticated
  with check (user_id = (select auth.uid()) and (select private.is_member(workspace_id)));
create policy cursors_update on public.cursors for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- units: members read, writers create/update (content goes through write_unit()).
create policy units_select on public.units for select to authenticated
  using ((select private.is_member(workspace_id)));
create policy units_insert on public.units for insert to authenticated
  with check ((select private.can_write(workspace_id)));
create policy units_update on public.units for update to authenticated
  using ((select private.can_write(workspace_id)))
  with check ((select private.can_write(workspace_id)));
create policy units_delete on public.units for delete to authenticated
  using ((select private.is_owner(workspace_id)));

-- unit_versions: append-only, inserted by write_unit().
create policy unit_versions_select on public.unit_versions for select to authenticated
  using (exists (select 1 from public.units u
                 where u.id = unit_id and (select private.is_member(u.workspace_id))));
create policy unit_versions_insert on public.unit_versions for insert to authenticated
  with check (author_id = (select auth.uid())
              and exists (select 1 from public.units u
                          where u.id = unit_id and (select private.can_write(u.workspace_id))));

-- records: append-only reasoning; writers may update status / superseded_by.
create policy records_select on public.records for select to authenticated
  using ((select private.is_member(workspace_id)));
create policy records_insert on public.records for insert to authenticated
  with check ((select private.can_write(workspace_id)) and author_id = (select auth.uid()));
create policy records_update on public.records for update to authenticated
  using ((select private.can_write(workspace_id)))
  with check ((select private.can_write(workspace_id)));

-- shared_memory: append-only, any writer can compact.
create policy shared_memory_select on public.shared_memory for select to authenticated
  using ((select private.is_member(workspace_id)));
create policy shared_memory_insert on public.shared_memory for insert to authenticated
  with check ((select private.can_write(workspace_id)) and created_by = (select auth.uid()));

-- ─────────────────────────────────────────────────────────────── grants (Data API)

revoke all on public.workspaces, public.members, public.invites, public.sessions, public.events,
  public.cursors, public.units, public.unit_versions, public.records, public.shared_memory
  from anon;

grant select, update                 on public.workspaces    to authenticated;
grant select, update, delete         on public.members       to authenticated;
grant select, insert, delete         on public.invites       to authenticated;
grant select, insert, update         on public.sessions      to authenticated;
grant select, insert                 on public.events        to authenticated;
grant select, insert, update         on public.cursors       to authenticated;
grant select, insert, update, delete on public.units         to authenticated;
grant select, insert                 on public.unit_versions to authenticated;
grant select, insert, update         on public.records       to authenticated;
grant select, insert                 on public.shared_memory to authenticated;

-- Column-level guard: members may only change these on units directly; versions and
-- locks change only through write_unit() / claim_unit() / release_unit().
revoke update on public.units from authenticated;
grant update (status, position, owner_id, meta, updated_at) on public.units to authenticated;
revoke update on public.records from authenticated;
grant update (status, superseded_by) on public.records to authenticated;
revoke update on public.members from authenticated;
grant update (role) on public.members to authenticated;

-- ─────────────────────────────────────────────────────────────── RPCs: membership
-- These two need SECURITY DEFINER: the caller is not yet a member, so RLS would hide
-- everything. Both check auth.uid() and are only executable by `authenticated`.

create function public.create_workspace(
  p_slug text, p_name text, p_handle text,
  p_template text default 'blank', p_manifest jsonb default '{}'::jsonb
)
returns public.workspaces
language plpgsql security definer set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  ws  public.workspaces;
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  insert into public.workspaces (slug, name, template, manifest, created_by)
  values (p_slug, p_name, p_template, p_manifest, uid)
  returning * into ws;

  insert into public.members (workspace_id, user_id, handle, role)
  values (ws.id, uid, p_handle, 'owner');

  insert into public.events (workspace_id, author_id, kind, payload)
  values (ws.id, uid, 'member', jsonb_build_object('action', 'created', 'handle', p_handle));

  return ws;
end;
$$;

create function public.join_workspace(p_code text, p_handle text)
returns public.workspaces
language plpgsql security definer set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  inv public.invites;
  ws  public.workspaces;
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  select * into inv from public.invites where code = p_code for update;
  if not found or inv.expires_at < now() or inv.uses >= inv.max_uses then
    raise exception 'invite is invalid, expired or used up' using errcode = 'P0002';
  end if;

  if exists (select 1 from public.members where workspace_id = inv.workspace_id and user_id = uid) then
    raise exception 'already a member of this workspace' using errcode = '23505';
  end if;

  insert into public.members (workspace_id, user_id, handle, role)
  values (inv.workspace_id, uid, p_handle, inv.role);

  update public.invites set uses = uses + 1 where id = inv.id;

  insert into public.events (workspace_id, author_id, kind, payload)
  values (inv.workspace_id, uid, 'member', jsonb_build_object('action', 'joined', 'handle', p_handle));

  select * into ws from public.workspaces where id = inv.workspace_id;
  return ws;
end;
$$;

revoke execute on function public.create_workspace(text, text, text, text, jsonb) from public, anon;
revoke execute on function public.join_workspace(text, text) from public, anon;
grant execute on function public.create_workspace(text, text, text, text, jsonb) to authenticated;
grant execute on function public.join_workspace(text, text) to authenticated;

-- ─────────────────────────────────────────────────────────────── RPCs: content
-- SECURITY INVOKER: they run as the caller, so RLS still decides what they can touch.
-- Locks and versions are owned by these functions; plain UPDATE can't reach those columns,
-- so the updates below go through a narrowly scoped definer helper.

create function private.set_unit_state(
  p_unit uuid, p_version int, p_lock_holder uuid, p_lock_session uuid, p_lock_expires timestamptz
)
returns void
language sql security definer set search_path = ''
as $$
  update public.units
     set current_version = p_version,
         lock_holder     = p_lock_holder,
         lock_session    = p_lock_session,
         lock_expires_at = p_lock_expires,
         updated_at      = now()
   where id = p_unit and (select private.can_write(workspace_id));
$$;
revoke execute on function private.set_unit_state(uuid, int, uuid, uuid, timestamptz) from public, anon;
grant execute on function private.set_unit_state(uuid, int, uuid, uuid, timestamptz) to authenticated;

-- Claim a unit for editing. Succeeds if it is free, expired, already yours, or p_force is set
-- (a forced break is logged to the feed). Returns the unit.
create function public.claim_unit(
  p_unit uuid, p_session uuid default null,
  p_ttl interval default interval '2 hours', p_force boolean default false, p_reason text default null
)
returns public.units
language plpgsql security invoker set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  u   public.units;
begin
  select * into u from public.units where id = p_unit for update;
  if not found or not (select private.can_write(u.workspace_id)) then
    raise exception 'unit not found or not writable' using errcode = 'P0002';
  end if;

  if u.lock_holder is not null and u.lock_holder <> uid and u.lock_expires_at > now() then
    if not p_force then
      raise exception 'unit is locked by another member until %', u.lock_expires_at
        using errcode = 'P0001', hint = 'locked';
    end if;
    insert into public.events (workspace_id, session_id, author_id, kind, payload)
    values (u.workspace_id, p_session, uid, 'lock',
            jsonb_build_object('action', 'broken', 'unit', u.id, 'previous_holder', u.lock_holder,
                               'reason', p_reason));
  end if;

  perform private.set_unit_state(u.id, u.current_version, uid, p_session, now() + p_ttl);

  insert into public.events (workspace_id, session_id, author_id, kind, payload)
  values (u.workspace_id, p_session, uid, 'lock',
          jsonb_build_object('action', 'claimed', 'unit', u.id,
                             'collection', u.collection, 'key', u.key, 'until', now() + p_ttl));

  select * into u from public.units where id = p_unit;
  return u;
end;
$$;

create function public.release_unit(p_unit uuid, p_session uuid default null)
returns public.units
language plpgsql security invoker set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  u   public.units;
begin
  select * into u from public.units where id = p_unit for update;
  if not found then
    raise exception 'unit not found' using errcode = 'P0002';
  end if;
  if u.lock_holder is distinct from uid then
    return u;
  end if;

  perform private.set_unit_state(u.id, u.current_version, null, null, null);
  insert into public.events (workspace_id, session_id, author_id, kind, payload)
  values (u.workspace_id, p_session, uid, 'lock',
          jsonb_build_object('action', 'released', 'unit', u.id,
                             'collection', u.collection, 'key', u.key));

  select * into u from public.units where id = p_unit;
  return u;
end;
$$;

-- Write new content with optimistic concurrency. Fails with hint 'version_conflict' if
-- someone else wrote since p_expected_version, or 'locked' if another member holds the lock.
-- Records an 'edit' event; returns the new version number.
create function public.write_unit(
  p_unit uuid, p_content text, p_expected_version int, p_summary text, p_session uuid default null
)
returns int
language plpgsql security invoker set search_path = ''
as $$
declare
  uid   uuid := (select auth.uid());
  u     public.units;
  ev_id bigint;
  v     int;
begin
  if coalesce(trim(p_summary), '') = '' then
    raise exception 'a summary of the change is required' using errcode = '22023';
  end if;

  select * into u from public.units where id = p_unit for update;
  if not found or not (select private.can_write(u.workspace_id)) then
    raise exception 'unit not found or not writable' using errcode = 'P0002';
  end if;

  if u.lock_holder is not null and u.lock_holder <> uid and u.lock_expires_at > now() then
    raise exception 'unit is locked by another member until %', u.lock_expires_at
      using errcode = 'P0001', hint = 'locked';
  end if;

  if u.current_version <> p_expected_version then
    raise exception 'version conflict: expected %, current is %', p_expected_version, u.current_version
      using errcode = 'P0001', hint = 'version_conflict';
  end if;

  v := u.current_version + 1;

  insert into public.events (workspace_id, session_id, author_id, kind, payload)
  values (u.workspace_id, p_session, uid, 'edit',
          jsonb_build_object('unit', u.id, 'collection', u.collection, 'key', u.key,
                             'from', u.current_version, 'to', v, 'summary', p_summary,
                             'chars', length(p_content)))
  returning id into ev_id;

  insert into public.unit_versions (unit_id, version, content, summary, author_id, event_id)
  values (u.id, v, p_content, p_summary, uid, ev_id);

  perform private.set_unit_state(u.id, v, u.lock_holder, u.lock_session, u.lock_expires_at);
  return v;
end;
$$;

-- Add a reasoning record with the next per-workspace number for its type (D-0001, F-0001…).
create function public.add_record(
  p_workspace uuid, p_type text, p_title text, p_body text,
  p_links jsonb default '[]'::jsonb, p_session uuid default null
)
returns public.records
language plpgsql security invoker set search_path = ''
as $$
declare
  uid   uuid := (select auth.uid());
  n     int;
  ev_id bigint;
  r     public.records;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_workspace::text || ':' || p_type, 0));

  select coalesce(max(number), 0) + 1 into n
    from public.records where workspace_id = p_workspace and type = p_type;

  insert into public.events (workspace_id, session_id, author_id, kind, payload)
  values (p_workspace, p_session, uid, 'record',
          jsonb_build_object('type', p_type, 'number', n, 'title', p_title, 'links', p_links))
  returning id into ev_id;

  insert into public.records (workspace_id, type, number, title, body, links, author_id, event_id)
  values (p_workspace, p_type, n, p_title, p_body, p_links, uid, ev_id)
  returning * into r;

  return r;
end;
$$;

-- Return feed events after the caller's cursor (excluding their own), and advance the cursor.
create function public.pull_feed(p_workspace uuid, p_limit int default 100)
returns setof public.events
language plpgsql security invoker set search_path = ''
as $$
declare
  uid  uuid := (select auth.uid());
  cur  bigint;
  last bigint;
begin
  if not (select private.is_member(p_workspace)) then
    raise exception 'not a member of this workspace' using errcode = '42501';
  end if;

  insert into public.cursors (workspace_id, user_id) values (p_workspace, uid)
  on conflict (workspace_id, user_id) do nothing;

  select last_event_id into cur from public.cursors
   where workspace_id = p_workspace and user_id = uid for update;

  select max(id) into last from (
    select id from public.events
     where workspace_id = p_workspace and id > cur
     order by id limit p_limit
  ) page;

  if last is not null then
    update public.cursors set last_event_id = last, updated_at = now()
     where workspace_id = p_workspace and user_id = uid;
  end if;

  return query
    select * from public.events
     where workspace_id = p_workspace and id > cur and id <= coalesce(last, cur)
       and author_id <> uid
     order by id;
end;
$$;

revoke execute on function public.claim_unit(uuid, uuid, interval, boolean, text),
  public.release_unit(uuid, uuid), public.write_unit(uuid, text, int, text, uuid),
  public.add_record(uuid, text, text, text, jsonb, uuid), public.pull_feed(uuid, int)
  from public, anon;
grant execute on function public.claim_unit(uuid, uuid, interval, boolean, text),
  public.release_unit(uuid, uuid), public.write_unit(uuid, text, int, text, uuid),
  public.add_record(uuid, text, text, text, jsonb, uuid), public.pull_feed(uuid, int)
  to authenticated;

-- ─────────────────────────────────────────────────────────────── realtime

alter publication supabase_realtime add table public.events, public.units, public.sessions;
