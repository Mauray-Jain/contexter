-- Runs and handoffs.
-- * A run is a long job a member started (a stress test on a shared machine, a training job…).
--   `contexter run` reports its status, progress and log tail while it runs; Claude can also
--   register and update runs through MCP. Teammates can watch a run: they hear when it ends.
-- * A handoff passes a member's unfinished work to a teammate's Claude (e.g. before a usage limit
--   runs out): what's done, what's next, the files involved. The recipient watches the sender's
--   running jobs at once, and takes over their unit locks when they accept.

-- ─────────────────────────────────────────────────────────────── feed kinds

set lock_timeout = '5s';
alter table public.events drop constraint events_kind_check;
alter table public.events add constraint events_kind_check check (kind in
  ('prompt', 'reply', 'edit', 'record', 'status', 'presence',
   'mention', 'compaction', 'member', 'lock', 'run', 'handoff')) not valid;
alter table public.events validate constraint events_kind_check;
reset lock_timeout;

-- ─────────────────────────────────────────────────────────────── tables

create table public.runs (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  number       int not null,
  started_by   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  session_id   uuid references public.sessions (id) on delete set null,
  title        text not null check (length(title) between 1 and 200),
  host         text check (length(host) <= 100),
  command      text check (length(command) <= 2000),
  -- 'wrapper': `contexter run` sends a heartbeat every minute, so silence means the machine or
  -- process died. 'claude': registered by Claude, updated only when Claude checks on it.
  reporter     text not null default 'claude' check (reporter in ('wrapper', 'claude')),
  status       text not null default 'running' check (status in ('running', 'succeeded', 'failed', 'cancelled')),
  progress     text check (length(progress) <= 300),
  log_tail     text check (length(log_tail) <= 4000),
  exit_code    int,
  started_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  finished_at  timestamptz,
  unique (workspace_id, number)
);
create index runs_workspace_status_idx on public.runs (workspace_id, status, updated_at desc);
create index runs_started_by_idx on public.runs (started_by);
create index runs_session_id_idx on public.runs (session_id);

create table public.run_watchers (
  run_id     uuid not null references public.runs (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  added_by   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (run_id, user_id)
);
create index run_watchers_user_id_idx on public.run_watchers (user_id);
create index run_watchers_added_by_idx on public.run_watchers (added_by);

create table public.handoffs (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  number       int not null,
  from_user    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  to_user      uuid references auth.users (id) on delete cascade, -- null: anyone may take it
  session_id   uuid references public.sessions (id) on delete set null,
  title        text not null check (length(title) between 1 and 200),
  summary      text not null check (length(summary) between 1 and 6000),
  next_steps   text check (length(next_steps) <= 4000),
  files        text[] not null default '{}',
  status       text not null default 'open' check (status in ('open', 'accepted', 'declined', 'cancelled')),
  resolved_by  uuid references auth.users (id) on delete set null,
  resolved_at  timestamptz,
  created_at   timestamptz not null default now(),
  unique (workspace_id, number)
);
create index handoffs_workspace_status_idx on public.handoffs (workspace_id, status);
create index handoffs_from_user_idx on public.handoffs (from_user);
create index handoffs_to_user_idx on public.handoffs (to_user);
create index handoffs_session_id_idx on public.handoffs (session_id);
create index handoffs_resolved_by_idx on public.handoffs (resolved_by);

-- ─────────────────────────────────────────────────────────────── RLS

alter table public.runs         enable row level security;
alter table public.run_watchers enable row level security;
alter table public.handoffs     enable row level security;

-- runs: members read; writers start runs as themselves and update any run in their workspace
-- (whoever took a run over through a handoff may need to mark it cancelled or finished).
create policy runs_select on public.runs for select to authenticated
  using ((select private.is_member(workspace_id)));
create policy runs_insert on public.runs for insert to authenticated
  with check ((select private.can_write(workspace_id)) and started_by = (select auth.uid()));
create policy runs_update on public.runs for update to authenticated
  using ((select private.can_write(workspace_id)))
  with check ((select private.can_write(workspace_id)));

create function private.run_workspace(p_run uuid)
returns uuid
language sql stable security definer set search_path = ''
as $$
  select workspace_id from public.runs where id = p_run;
$$;
revoke execute on function private.run_workspace(uuid) from public, anon;
grant execute on function private.run_workspace(uuid) to authenticated;

-- run_watchers: members see who watches what; writers add watchers; you can stop watching, and
-- whoever added a watcher can take it back.
create policy run_watchers_select on public.run_watchers for select to authenticated
  using ((select private.is_member(private.run_workspace(run_id))));
create policy run_watchers_insert on public.run_watchers for insert to authenticated
  with check (added_by = (select auth.uid()) and (select private.can_write(private.run_workspace(run_id))));
create policy run_watchers_delete on public.run_watchers for delete to authenticated
  using (user_id = (select auth.uid()) or added_by = (select auth.uid()));

-- handoffs: members read; writers create them as themselves; the recipient (anyone, for an open
-- handoff to nobody in particular) accepts or declines, and the sender can cancel.
create policy handoffs_select on public.handoffs for select to authenticated
  using ((select private.is_member(workspace_id)));
create policy handoffs_insert on public.handoffs for insert to authenticated
  with check ((select private.can_write(workspace_id)) and from_user = (select auth.uid()));
create policy handoffs_update on public.handoffs for update to authenticated
  using ((select private.can_write(workspace_id))
         and (to_user is null or to_user = (select auth.uid()) or from_user = (select auth.uid())))
  with check ((select private.can_write(workspace_id)));

revoke all on public.runs, public.run_watchers, public.handoffs from anon;
grant select, insert on public.runs to authenticated;
grant update (status, progress, log_tail, exit_code, updated_at, finished_at) on public.runs to authenticated;
grant select, insert, delete on public.run_watchers to authenticated;
grant select, insert on public.handoffs to authenticated;
grant update (status, resolved_by, resolved_at) on public.handoffs to authenticated;

-- ─────────────────────────────────────────────────────────────── helpers

-- user ids for handles in a workspace; unknown handles are an error.
create function private.member_ids(p_workspace uuid, p_handles text[])
returns uuid[]
language plpgsql stable security invoker set search_path = ''
as $$
declare
  ids uuid[];
  missing text[];
begin
  select array_agg(m.user_id), array(select h from unnest(coalesce(p_handles, '{}')) h
                                      where h not in (select handle from public.members where workspace_id = p_workspace))
    into ids, missing
    from public.members m
   where m.workspace_id = p_workspace and m.handle = any(coalesce(p_handles, '{}'));
  if cardinality(missing) > 0 then
    raise exception 'unknown member(s): %', array_to_string(missing, ', ') using errcode = 'P0002';
  end if;
  return coalesce(ids, '{}');
end;
$$;
revoke execute on function private.member_ids(uuid, text[]) from public, anon;
grant execute on function private.member_ids(uuid, text[]) to authenticated;

-- Handles of a run's watchers, for the mentions on its feed events.
create function private.watcher_handles(p_run uuid)
returns text[]
language sql stable security invoker set search_path = ''
as $$
  select coalesce(array_agg(m.handle order by m.handle), '{}')
    from public.run_watchers w
    join public.runs r on r.id = w.run_id
    join public.members m on m.workspace_id = r.workspace_id and m.user_id = w.user_id
   where w.run_id = p_run;
$$;
revoke execute on function private.watcher_handles(uuid) from public, anon;
grant execute on function private.watcher_handles(uuid) to authenticated;

-- ─────────────────────────────────────────────────────────────── runs

-- Register a run. p_watchers: handles who should hear when it ends (they're mentioned now too).
create function public.start_run(
  p_workspace uuid, p_title text, p_host text default null, p_command text default null,
  p_session uuid default null, p_watchers text[] default '{}', p_reporter text default 'claude'
)
returns public.runs
language plpgsql security invoker set search_path = ''
as $$
declare
  uid      uuid := (select auth.uid());
  n        int;
  r        public.runs;
  watchers uuid[];
begin
  if not (select private.can_write(p_workspace)) then
    raise exception 'not a writer in this workspace' using errcode = '42501';
  end if;
  watchers := private.member_ids(p_workspace, p_watchers);

  perform pg_advisory_xact_lock(hashtextextended(p_workspace::text || ':run', 0));
  select coalesce(max(number), 0) + 1 into n from public.runs where workspace_id = p_workspace;

  insert into public.runs (workspace_id, number, started_by, session_id, title, host, command, reporter)
  values (p_workspace, n, uid, p_session, left(trim(p_title), 200), left(nullif(trim(p_host), ''), 100),
          left(nullif(trim(p_command), ''), 2000), p_reporter)
  returning * into r;

  insert into public.run_watchers (run_id, user_id, added_by)
  select r.id, w, uid from unnest(watchers) w where w <> uid
  on conflict do nothing;

  insert into public.events (workspace_id, session_id, author_id, kind, payload, mentions)
  values (p_workspace, p_session, uid, 'run',
          jsonb_build_object('action', 'started', 'run', r.id, 'number', n, 'title', r.title, 'host', r.host),
          private.watcher_handles(r.id));
  return r;
end;
$$;

-- Report on a run: progress and log tail any time (a heartbeat), status once it ends. The first
-- report of an end is announced to the team, mentioning the watchers.
create function public.update_run(
  p_run uuid, p_status text default null, p_progress text default null,
  p_log_tail text default null, p_exit_code int default null
)
returns public.runs
language plpgsql security invoker set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  r   public.runs;
  ended boolean;
begin
  select * into r from public.runs where id = p_run for update;
  if not found or not (select private.can_write(r.workspace_id)) then
    raise exception 'run not found or not writable' using errcode = 'P0002';
  end if;
  ended := r.status = 'running' and coalesce(p_status, 'running') <> 'running';

  update public.runs
     set status      = case when r.status = 'running' then coalesce(p_status, status) else status end,
         progress    = coalesce(left(p_progress, 300), progress),
         log_tail    = coalesce(right(p_log_tail, 4000), log_tail),
         exit_code   = coalesce(p_exit_code, exit_code),
         updated_at  = now(),
         finished_at = case when ended then now() else finished_at end
   where id = p_run
  returning * into r;

  if ended then
    insert into public.events (workspace_id, session_id, author_id, kind, payload, mentions)
    values (r.workspace_id, r.session_id, uid, 'run',
            jsonb_build_object('action', 'finished', 'run', r.id, 'number', r.number, 'title', r.title,
                               'host', r.host, 'status', r.status, 'exit_code', r.exit_code,
                               'progress', r.progress, 'started_by', r.started_by,
                               'seconds', extract(epoch from r.finished_at - r.started_at)::int),
            private.watcher_handles(r.id));
  end if;
  return r;
end;
$$;

-- Ask teammates to watch a run (or yourself, with no handles). They're mentioned once now and
-- again when it ends.
create function public.watch_run(p_run uuid, p_handles text[] default null, p_session uuid default null)
returns public.runs
language plpgsql security invoker set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  r   public.runs;
  ids uuid[];
  added text[];
begin
  select * into r from public.runs where id = p_run;
  if not found or not (select private.can_write(r.workspace_id)) then
    raise exception 'run not found or not writable' using errcode = 'P0002';
  end if;
  ids := case when p_handles is null or cardinality(p_handles) = 0 then array[uid]
              else private.member_ids(r.workspace_id, p_handles) end;

  with ins as (
    insert into public.run_watchers (run_id, user_id, added_by)
    select r.id, w, uid from unnest(ids) w
    on conflict do nothing
    returning user_id
  )
  select coalesce(array_agg(m.handle), '{}') into added
    from ins join public.members m on m.workspace_id = r.workspace_id and m.user_id = ins.user_id
   where ins.user_id <> uid;

  if cardinality(added) > 0 then
    insert into public.events (workspace_id, session_id, author_id, kind, payload, mentions)
    values (r.workspace_id, p_session, uid, 'run',
            jsonb_build_object('action', 'shared', 'run', r.id, 'number', r.number, 'title', r.title,
                               'host', r.host, 'status', r.status),
            added);
  end if;
  return r;
end;
$$;

-- ─────────────────────────────────────────────────────────────── handoffs

-- Hand unfinished work to a teammate (p_to null: whoever picks it up). The recipient starts
-- watching the sender's running runs right away; unit locks move when they accept.
create function public.create_handoff(
  p_workspace uuid, p_to text, p_title text, p_summary text,
  p_next_steps text default null, p_files text[] default '{}', p_session uuid default null
)
returns public.handoffs
language plpgsql security invoker set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  n   int;
  h   public.handoffs;
  to_id uuid;
begin
  if not (select private.can_write(p_workspace)) then
    raise exception 'not a writer in this workspace' using errcode = '42501';
  end if;
  if p_to is not null then
    to_id := (private.member_ids(p_workspace, array[p_to]))[1];
    if to_id = uid then
      raise exception 'hand off to a teammate, not yourself' using errcode = '22023';
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_workspace::text || ':handoff', 0));
  select coalesce(max(number), 0) + 1 into n from public.handoffs where workspace_id = p_workspace;

  insert into public.handoffs (workspace_id, number, from_user, to_user, session_id, title, summary, next_steps, files)
  values (p_workspace, n, uid, to_id, p_session, left(trim(p_title), 200), trim(p_summary),
          nullif(trim(p_next_steps), ''), coalesce(p_files[1:50], '{}'))
  returning * into h;

  if to_id is not null then
    insert into public.run_watchers (run_id, user_id, added_by)
    select r.id, to_id, uid from public.runs r
     where r.workspace_id = p_workspace and r.started_by = uid and r.status = 'running'
    on conflict do nothing;
  end if;

  insert into public.events (workspace_id, session_id, author_id, kind, payload, mentions)
  values (p_workspace, p_session, uid, 'handoff',
          jsonb_build_object('action', 'created', 'handoff', h.id, 'number', n, 'title', h.title),
          case when p_to is null then '{}' else array[p_to] end);
  return h;
end;
$$;

-- Accept, decline (recipient) or cancel (sender) an open handoff. Accepting moves the sender's
-- live unit locks to the caller and makes them a watcher of the sender's running runs.
create function public.resolve_handoff(p_handoff uuid, p_action text, p_session uuid default null)
returns public.handoffs
language plpgsql security invoker set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  h   public.handoffs;
  u   record;
  sender text;
begin
  if p_action not in ('accepted', 'declined', 'cancelled') then
    raise exception 'action must be accepted, declined or cancelled' using errcode = '22023';
  end if;
  select * into h from public.handoffs where id = p_handoff for update;
  if not found or not (select private.can_write(h.workspace_id)) then
    raise exception 'handoff not found' using errcode = 'P0002';
  end if;
  if h.status <> 'open' then
    raise exception 'handoff #% is already %', h.number, h.status using errcode = 'P0001';
  end if;
  if p_action = 'cancelled' and h.from_user <> uid then
    raise exception 'only the sender can cancel a handoff' using errcode = '42501';
  end if;
  if p_action <> 'cancelled' and (h.from_user = uid or (h.to_user is not null and h.to_user <> uid)) then
    raise exception 'handoff #% is for someone else', h.number using errcode = '42501';
  end if;

  update public.handoffs set status = p_action, resolved_by = uid, resolved_at = now()
   where id = h.id returning * into h;

  if p_action = 'accepted' then
    for u in select id, current_version, lock_expires_at from public.units
              where workspace_id = h.workspace_id and lock_holder = h.from_user and lock_expires_at > now()
              for update loop
      perform private.set_unit_state(u.id, u.current_version, uid, p_session,
                                     greatest(u.lock_expires_at, now() + interval '2 hours'));
    end loop;
    insert into public.run_watchers (run_id, user_id, added_by)
    select r.id, uid, uid from public.runs r
     where r.workspace_id = h.workspace_id and r.started_by = h.from_user and r.status = 'running'
    on conflict do nothing;
  end if;

  select handle into sender from public.members where workspace_id = h.workspace_id and user_id = h.from_user;
  insert into public.events (workspace_id, session_id, author_id, kind, payload, mentions)
  values (h.workspace_id, p_session, uid, 'handoff',
          jsonb_build_object('action', p_action, 'handoff', h.id, 'number', h.number, 'title', h.title),
          case when p_action = 'cancelled' or sender is null then '{}' else array[sender] end);
  return h;
end;
$$;

-- ─────────────────────────────────────────────────────────────── grants

revoke execute on function
  public.start_run(uuid, text, text, text, uuid, text[], text),
  public.update_run(uuid, text, text, text, int),
  public.watch_run(uuid, text[], uuid),
  public.create_handoff(uuid, text, text, text, text, text[], uuid),
  public.resolve_handoff(uuid, text, uuid)
  from public, anon;
grant execute on function
  public.start_run(uuid, text, text, text, uuid, text[], text),
  public.update_run(uuid, text, text, text, int),
  public.watch_run(uuid, text[], uuid),
  public.create_handoff(uuid, text, text, text, text, text[], uuid),
  public.resolve_handoff(uuid, text, uuid)
  to authenticated;

alter publication supabase_realtime add table public.runs;
