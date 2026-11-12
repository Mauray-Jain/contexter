-- Live collaboration: per-client sessions and presence, per-session feed reads, shared memory
-- compaction, workspace search, and a per-user default workspace for stateless clients.

-- ─────────────────────────────────────────────────────────────── profiles

create table public.profiles (
  user_id          uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  active_workspace uuid references public.workspaces (id) on delete set null,
  updated_at       timestamptz not null default now()
);
alter table public.profiles enable row level security;

create policy profiles_select on public.profiles for select to authenticated
  using (user_id = (select auth.uid()));
create policy profiles_insert on public.profiles for insert to authenticated
  with check (user_id = (select auth.uid())
              and (active_workspace is null or (select private.is_member(active_workspace))));
create policy profiles_update on public.profiles for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid())
              and (active_workspace is null or (select private.is_member(active_workspace))));

revoke all on public.profiles from anon;
grant select, insert, update on public.profiles to authenticated;

-- ─────────────────────────────────────────────────────────────── sessions

-- Claude Code sessions are keyed by Claude's own session id; chat sessions are reused by time window.
-- Each session has its own feed cursor, so one client reading the feed doesn't hide events
-- from the member's other clients.
alter table public.sessions add column external_id text;
alter table public.sessions add column last_event_id bigint not null default 0;
create unique index sessions_user_external_idx on public.sessions (user_id, external_id)
  where external_id is not null;

-- Find or start the caller's session. With p_external_id, one contexter session per Claude
-- session; without it, reuse the caller's open session for this client if seen within p_reuse.
create function public.ensure_session(
  p_workspace uuid, p_client text, p_title text default null,
  p_external_id text default null, p_reuse interval default interval '2 hours'
)
returns public.sessions
language plpgsql security invoker set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  s   public.sessions;
begin
  if not (select private.is_member(p_workspace)) then
    raise exception 'not a member of this workspace' using errcode = '42501';
  end if;

  if p_external_id is not null then
    select * into s from public.sessions
     where user_id = uid and external_id = p_external_id;
  else
    select * into s from public.sessions
     where user_id = uid and workspace_id = p_workspace and client = p_client
       and ended_at is null and external_id is null and last_seen_at > now() - p_reuse
     order by last_seen_at desc limit 1;
  end if;

  if found then
    update public.sessions
       set last_seen_at = now(), ended_at = null, title = coalesce(p_title, title)
     where id = s.id
     returning * into s;
    return s;
  end if;

  -- A new session starts where the member last read; older history comes from shared memory.
  insert into public.sessions (workspace_id, user_id, client, title, external_id, last_event_id)
  values (p_workspace, uid, p_client, p_title, p_external_id,
          coalesce((select c.last_event_id from public.cursors c
                     where c.workspace_id = p_workspace and c.user_id = uid), 0))
  returning * into s;

  insert into public.events (workspace_id, session_id, author_id, kind, payload)
  values (p_workspace, s.id, uid, 'presence',
          jsonb_build_object('action', 'started', 'client', p_client, 'title', p_title));
  return s;
end;
$$;

-- End a session: mark it ended, release any locks it held, tell the team.
create function public.end_session(p_session uuid)
returns void
language plpgsql security invoker set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  s   public.sessions;
  u   record;
begin
  select * into s from public.sessions where id = p_session and user_id = uid;
  if not found or s.ended_at is not null then
    return;
  end if;

  update public.sessions set ended_at = now(), last_seen_at = now() where id = s.id;

  for u in select id, current_version from public.units
            where lock_session = s.id and lock_holder = uid for update loop
    perform private.set_unit_state(u.id, u.current_version, null, null, null);
  end loop;

  insert into public.events (workspace_id, session_id, author_id, kind, payload)
  values (s.workspace_id, s.id, uid, 'presence', jsonb_build_object('action', 'ended', 'client', s.client));
end;
$$;

-- ─────────────────────────────────────────────────────────────── feed

-- Same as before, but with a session the session's own cursor is used, and the member's
-- *other* sessions count as teammates: work done in your Claude Code session shows up in your
-- chat session and vice versa. The member cursor still advances (it seeds new sessions).
drop function public.pull_feed(uuid, int);

create function public.pull_feed(p_workspace uuid, p_limit int default 100, p_session uuid default null)
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

  if p_session is not null then
    select last_event_id into cur from public.sessions
     where id = p_session and user_id = uid and workspace_id = p_workspace for update;
    if not found then
      raise exception 'session not found' using errcode = 'P0002';
    end if;
  else
    select last_event_id into cur from public.cursors
     where workspace_id = p_workspace and user_id = uid for update;
  end if;

  select max(id) into last from (
    select id from public.events
     where workspace_id = p_workspace and id > cur
     order by id limit p_limit
  ) page;

  if p_session is not null then
    update public.sessions set last_seen_at = now(), last_event_id = coalesce(last, cur)
     where id = p_session;
  end if;

  if last is not null then
    update public.cursors set last_event_id = greatest(last_event_id, last), updated_at = now()
     where workspace_id = p_workspace and user_id = uid;
  end if;

  return query
    select * from public.events e
     where e.workspace_id = p_workspace and e.id > cur and e.id <= coalesce(last, cur)
       and not (e.author_id = uid
                and (p_session is null or e.session_id is null or e.session_id = p_session))
     order by e.id;
end;
$$;

-- Status changes on units are announced automatically.
create function private.announce_status()
returns trigger
language plpgsql security invoker set search_path = ''
as $$
begin
  insert into public.events (workspace_id, author_id, kind, payload)
  values (new.workspace_id, (select auth.uid()), 'status',
          jsonb_build_object('unit', new.id, 'collection', new.collection, 'key', new.key,
                             'from', old.status, 'to', new.status));
  return new;
end;
$$;

create trigger units_announce_status
  after update of status on public.units
  for each row when (old.status is distinct from new.status and auth.uid() is not null)
  execute function private.announce_status();

-- ─────────────────────────────────────────────────────────────── shared memory

-- Where the team's running summary stands, and how much has happened since.
create function public.memory_status(p_workspace uuid)
returns table (version int, summary text, covers_up_to_event bigint, events_since bigint, latest_event bigint)
language sql stable security invoker set search_path = ''
as $$
  with m as (
    select sm.version, sm.summary, sm.covers_up_to_event
      from public.shared_memory sm
     where sm.workspace_id = p_workspace
     order by sm.version desc limit 1
  )
  select m.version, m.summary, coalesce(m.covers_up_to_event, 0),
         (select count(*) from public.events e
           where e.workspace_id = p_workspace and e.id > coalesce(m.covers_up_to_event, 0)
             and e.kind not in ('presence', 'lock')),
         (select coalesce(max(e.id), 0) from public.events e where e.workspace_id = p_workspace)
    from (select 1) one left join m on true;
$$;

create function public.compact_memory(
  p_workspace uuid, p_summary text, p_covers_up_to bigint, p_session uuid default null
)
returns public.shared_memory
language plpgsql security invoker set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  v   int;
  m   public.shared_memory;
begin
  if length(trim(coalesce(p_summary, ''))) < 20 then
    raise exception 'summary is too short to replace the shared memory' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_workspace::text || ':memory', 0));
  select coalesce(max(version), 0) + 1 into v from public.shared_memory where workspace_id = p_workspace;

  insert into public.shared_memory (workspace_id, version, summary, covers_up_to_event, created_by)
  values (p_workspace, v, p_summary, p_covers_up_to, uid)
  returning * into m;

  insert into public.events (workspace_id, session_id, author_id, kind, payload)
  values (p_workspace, p_session, uid, 'compaction',
          jsonb_build_object('version', v, 'covers_up_to', p_covers_up_to));
  return m;
end;
$$;

-- ─────────────────────────────────────────────────────────────── search

create index unit_versions_fts_idx on public.unit_versions
  using gin (to_tsvector('english', content));
create index records_fts_idx on public.records
  using gin (to_tsvector('english', title || ' ' || body));
create index events_fts_idx on public.events
  using gin (to_tsvector('english', coalesce(payload->>'text', '') || ' ' || coalesce(payload->>'summary', '')));
create index records_links_idx on public.records using gin (links jsonb_path_ops);

create function public.search_workspace(p_workspace uuid, p_query text, p_limit int default 20)
returns table (kind text, ref text, title text, snippet text, rank real, created_at timestamptz)
language sql stable security invoker set search_path = ''
as $$
  with q as (select websearch_to_tsquery('english', p_query) as tsq)
  select * from (
    select 'unit'::text, u.collection || '/' || u.key, v.summary,
           ts_headline('english', v.content, q.tsq, 'MaxWords=30, MinWords=10'),
           ts_rank(to_tsvector('english', v.content), q.tsq), v.created_at
      from public.units u
      join public.unit_versions v on v.unit_id = u.id and v.version = u.current_version, q
     where u.workspace_id = p_workspace and to_tsvector('english', v.content) @@ q.tsq
    union all
    select 'record', upper(left(r.type, 1)) || '-' || lpad(r.number::text, 4, '0'), r.title,
           ts_headline('english', r.body, q.tsq, 'MaxWords=30, MinWords=10'),
           ts_rank(to_tsvector('english', r.title || ' ' || r.body), q.tsq), r.created_at
      from public.records r, q
     where r.workspace_id = p_workspace and to_tsvector('english', r.title || ' ' || r.body) @@ q.tsq
    union all
    select 'event', 'event/' || e.id, e.kind,
           ts_headline('english', coalesce(e.payload->>'text', '') || ' ' || coalesce(e.payload->>'summary', ''),
                       q.tsq, 'MaxWords=30, MinWords=10'),
           ts_rank(to_tsvector('english', coalesce(e.payload->>'text', '') || ' ' || coalesce(e.payload->>'summary', '')), q.tsq),
           e.created_at
      from public.events e, q
     where e.workspace_id = p_workspace
       and to_tsvector('english', coalesce(e.payload->>'text', '') || ' ' || coalesce(e.payload->>'summary', '')) @@ q.tsq
  ) hits
  order by 5 desc, 6 desc
  limit p_limit;
$$;

-- ─────────────────────────────────────────────────────────────── grants + realtime

revoke execute on function
  public.ensure_session(uuid, text, text, text, interval), public.end_session(uuid),
  public.pull_feed(uuid, int, uuid), public.memory_status(uuid),
  public.compact_memory(uuid, text, bigint, uuid), public.search_workspace(uuid, text, int)
  from public, anon;
grant execute on function
  public.ensure_session(uuid, text, text, text, interval), public.end_session(uuid),
  public.pull_feed(uuid, int, uuid), public.memory_status(uuid),
  public.compact_memory(uuid, text, bigint, uuid), public.search_workspace(uuid, text, int)
  to authenticated;

alter publication supabase_realtime add table public.records;
