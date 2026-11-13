-- Modal jobs that outlive the machine that started them.
-- `modal run --detach` keeps a job running on Modal after the local process is gone (a laptop
-- closes, a usage limit runs out). Such a run records its Modal app id and profile name (never a
-- token). When its owner hands it off, the recipient's machine takes over watching it: a small
-- background watcher there polls Modal and reports progress, log tail and the final status.
-- Only one machine watches a job at a time: runs.watcher_user.

-- ─────────────────────────────────────────────────────────────── columns

set lock_timeout = '5s';
alter table public.runs drop constraint runs_reporter_check;
alter table public.runs add constraint runs_reporter_check
  check (reporter in ('wrapper', 'claude', 'modal')) not valid;
alter table public.runs validate constraint runs_reporter_check;

alter table public.runs
  -- {"modal": {"app_id": "ap-…", "profile": "…", "environment": "…"}}
  add column external     jsonb not null default '{}'::jsonb,
  -- reporter 'modal': whose machine watches the job, when it last looked, what went wrong.
  add column watcher_user uuid references auth.users (id) on delete set null,
  add column watched_at   timestamptz,
  add column watch_error  text check (length(watch_error) <= 300);
reset lock_timeout;

create index runs_watcher_user_idx on public.runs (watcher_user) where watcher_user is not null;

-- 20261114100000 granted column-level UPDATE on runs and handoffs, but authenticated still held
-- table-wide UPDATE from Supabase's default privileges, so any column could be changed directly.
-- Revoke it (as the core schema does for units) and grant back only the columns members may set.
revoke update on public.runs, public.handoffs from authenticated;
grant update (status, progress, log_tail, exit_code, updated_at, finished_at) on public.runs to authenticated;
grant update (status, resolved_by, resolved_at) on public.handoffs to authenticated;

-- ─────────────────────────────────────────────────────────────── watcher state
-- Columns members can't update directly; these RPCs check access and change them.

create function private.set_run_watch(
  p_run uuid, p_reporter text, p_watcher uuid, p_external jsonb, p_watched_at timestamptz, p_error text
)
returns void
language sql security definer set search_path = ''
as $$
  update public.runs
     set reporter = p_reporter, watcher_user = p_watcher, external = p_external,
         watched_at = p_watched_at, watch_error = left(p_error, 300)
   where id = p_run and (select private.can_write(workspace_id));
$$;
revoke execute on function private.set_run_watch(uuid, text, uuid, jsonb, timestamptz, text) from public, anon;
grant execute on function private.set_run_watch(uuid, text, uuid, jsonb, timestamptz, text) to authenticated;

-- Record the Modal job behind a run. With p_watch, the caller's machine watches it from now on
-- (`contexter modal track`); otherwise whatever reports it now (e.g. `contexter run`) carries on.
create function public.set_run_modal(
  p_run uuid, p_app_id text, p_profile text default null, p_environment text default null,
  p_watch boolean default false
)
returns public.runs
language plpgsql security invoker set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  r   public.runs;
begin
  if p_app_id !~ '^ap-[A-Za-z0-9]{4,64}$' then
    raise exception 'not a Modal app id: %', p_app_id using errcode = '22023';
  end if;
  if p_profile is not null and p_profile !~ '^[A-Za-z0-9_.-]{1,64}$' then
    raise exception 'not a Modal profile name: %', p_profile using errcode = '22023';
  end if;
  select * into r from public.runs where id = p_run for update;
  if not found or not (select private.can_write(r.workspace_id)) then
    raise exception 'run not found or not writable' using errcode = 'P0002';
  end if;

  perform private.set_run_watch(
    r.id,
    case when p_watch then 'modal' else r.reporter end,
    case when p_watch then uid else r.watcher_user end,
    r.external || jsonb_build_object('modal', jsonb_strip_nulls(jsonb_build_object(
      'app_id', p_app_id, 'profile', p_profile, 'environment', p_environment))),
    case when p_watch then now() else r.watched_at end,
    null);
  select * into r from public.runs where id = p_run;
  return r;
end;
$$;

-- The watcher's check-in: it looked at the job just now (p_error: why it couldn't). Returns false
-- once the job is no longer this user's to watch, so a stale watcher stops.
create function public.report_run_watch(p_run uuid, p_error text default null)
returns boolean
language plpgsql security invoker set search_path = ''
as $$
declare
  r public.runs;
begin
  select * into r from public.runs where id = p_run for update;
  if not found or r.watcher_user is distinct from (select auth.uid()) or r.status <> 'running' then
    return false;
  end if;
  perform private.set_run_watch(r.id, r.reporter, r.watcher_user, r.external, now(), nullif(trim(p_error), ''));
  return true;
end;
$$;

-- ─────────────────────────────────────────────────────────────── handoffs move Modal jobs

-- As before, plus: accepting moves the sender's running Modal jobs (ones they started or were
-- watching) to the caller's watcher.
create or replace function public.resolve_handoff(p_handoff uuid, p_action text, p_session uuid default null)
returns public.handoffs
language plpgsql security invoker set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  h   public.handoffs;
  u   record;
  r   record;
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
    select rr.id, uid, uid from public.runs rr
     where rr.workspace_id = h.workspace_id and rr.started_by = h.from_user and rr.status = 'running'
    on conflict do nothing;
    for r in select id, external from public.runs
              where workspace_id = h.workspace_id and status = 'running' and external ? 'modal'
                and (watcher_user = h.from_user or (watcher_user is null and started_by = h.from_user))
              for update loop
      perform private.set_run_watch(r.id, 'modal', uid, r.external, null, null);
    end loop;
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

revoke execute on function public.set_run_modal(uuid, text, text, text, boolean), public.report_run_watch(uuid, text)
  from public, anon;
grant execute on function public.set_run_modal(uuid, text, text, text, boolean), public.report_run_watch(uuid, text)
  to authenticated;
