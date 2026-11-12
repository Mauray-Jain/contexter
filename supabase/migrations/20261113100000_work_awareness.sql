-- Work awareness: what each session is doing right now, which files it is touching, and which
-- earlier work a new request overlaps with, so teammates' Claudes don't do the same work twice.

-- ─────────────────────────────────────────────────────────────── current task per session

-- A task is one user request in one session: it starts when the prompt is sent and finishes when
-- Claude's reply ends. current_task is null for !private turns (the team sees "something private").
alter table public.sessions
  add column current_task     text,
  add column task_started_at  timestamptz,
  add column task_finished_at timestamptz,
  add column task_files       text[] not null default '{}';

-- A session counts as mid-task for this long without any sign of life (prompt, file edit).
create function private.task_is_live(s public.sessions)
returns boolean
language sql stable set search_path = ''
as $$
  select s.ended_at is null and s.task_started_at is not null and s.task_finished_at is null
     and s.last_seen_at > now() - interval '60 minutes';
$$;

create function public.start_task(p_session uuid, p_task text)
returns void
language plpgsql security invoker set search_path = ''
as $$
#variable_conflict use_column
begin
  update public.sessions
     set current_task = left(nullif(trim(p_task), ''), 500), task_started_at = now(),
         task_finished_at = null, task_files = '{}', last_seen_at = now()
   where id = p_session and user_id = (select auth.uid());
  if not found then
    raise exception 'session not found' using errcode = 'P0002';
  end if;
end;
$$;

create function public.finish_task(p_session uuid)
returns void
language sql security invoker set search_path = ''
as $$
  update public.sessions
     set task_finished_at = coalesce(task_finished_at, now()), last_seen_at = now()
   where id = p_session and user_id = (select auth.uid()) and task_started_at is not null;
$$;

-- ─────────────────────────────────────────────────────────────── file activity

-- Record that this session is about to change p_path (a path relative to the project root) and
-- return who else is on it: sessions mid-task that touched it (active) and finished turns that
-- changed it within p_since.
create function public.touch_file(p_session uuid, p_path text, p_since interval default interval '24 hours')
returns table (author_id uuid, session_id uuid, task text, touched_at timestamptz, active boolean)
language plpgsql security invoker set search_path = ''
as $$
#variable_conflict use_column
declare
  s public.sessions;
begin
  update public.sessions o
     set task_files = case when p_path = any(o.task_files) then o.task_files
                           else (o.task_files || p_path)[greatest(1, cardinality(o.task_files) - 48):] end,
         last_seen_at = now()
   where o.id = p_session and o.user_id = (select auth.uid())
  returning o.* into s;
  if not found then
    raise exception 'session not found' using errcode = 'P0002';
  end if;

  return query
    select o.user_id, o.id, coalesce(o.current_task, '(private)'), o.last_seen_at, true
      from public.sessions o
     where o.workspace_id = s.workspace_id and o.id <> s.id
       and private.task_is_live(o) and p_path = any(o.task_files)
    union all
    (select e.author_id, e.session_id, coalesce(e.payload->>'summary', ''), e.created_at, false
       from public.events e
      where e.workspace_id = s.workspace_id and e.kind = 'reply'
        and e.session_id is distinct from s.id
        and e.created_at > now() - p_since
        and e.payload->'files' ? p_path
      order by e.created_at desc
      limit 10);
end;
$$;

-- ─────────────────────────────────────────────────────────────── overlapping requests

-- Earlier prompts and reply summaries (other sessions, within p_since), plus other sessions' live
-- tasks (a chat task is only posted as a prompt when its turn ends), that share most of their words
-- with p_text. Score = shared lexemes / the smaller lexeme count; at least 3 shared lexemes.
-- For a matched prompt, outcome is the summary of the reply that followed it in that session.
create function public.find_overlap(
  p_workspace uuid, p_text text, p_session uuid default null,
  p_since interval default interval '7 days', p_min_score real default 0.5, p_limit int default 5
)
returns table (event_id bigint, author_id uuid, session_id uuid, kind text, text text, outcome text,
               files jsonb, created_at timestamptz, score real, active boolean)
language plpgsql stable security invoker set search_path = ''
as $$
#variable_conflict use_column
declare
  words text[] := tsvector_to_array(to_tsvector('english', coalesce(p_text, '')));
begin
  if not (select private.is_member(p_workspace)) then
    raise exception 'not a member of this workspace' using errcode = '42501';
  end if;
  if cardinality(words) < 3 then
    return;
  end if;

  return query
  with cand as (
    select e.id, e.author_id, e.session_id, e.kind, e.created_at,
           case when e.kind = 'prompt' then coalesce(e.payload->>'text', '')
                else coalesce(e.payload->>'summary', '') end as body,
           coalesce(e.payload->'files', '[]'::jsonb) as files
      from public.events e
     where e.workspace_id = p_workspace and e.kind in ('prompt', 'reply')
       and e.session_id is distinct from p_session
       and e.created_at > now() - p_since
    union all
    select null::bigint, o.user_id, o.id, 'task', o.task_started_at, o.current_task, to_jsonb(o.task_files)
      from public.sessions o
     where o.workspace_id = p_workspace and o.id is distinct from p_session
       and o.current_task is not null and private.task_is_live(o)
  ), scored as (
    select c.*, lx.lex, (select count(*) from unnest(lx.lex) l where l = any(words)) as shared
      from cand c
      cross join lateral (select tsvector_to_array(to_tsvector('english', c.body)) as lex) lx
     where cardinality(lx.lex) > 0
  )
  select sc.id, sc.author_id, sc.session_id, sc.kind, sc.body,
         case when sc.kind = 'prompt' then
           (select r.payload->>'summary' from public.events r
             where r.session_id = sc.session_id and r.kind = 'reply' and r.id > sc.id
             order by r.id limit 1) end,
         sc.files,
         sc.created_at,
         (sc.shared::real / least(cardinality(words), cardinality(sc.lex)))::real,
         sc.kind = 'task'
           or coalesce((select private.task_is_live(o) from public.sessions o where o.id = sc.session_id), false)
    from scored sc
   where sc.shared >= 3
     and sc.shared::real / least(cardinality(words), cardinality(sc.lex)) >= p_min_score
   order by 9 desc, sc.created_at desc
   limit p_limit;
end;
$$;

-- ─────────────────────────────────────────────────────────────── grants

revoke execute on function
  public.start_task(uuid, text), public.finish_task(uuid), public.touch_file(uuid, text, interval),
  public.find_overlap(uuid, text, uuid, interval, real, int)
  from public, anon;
grant execute on function
  public.start_task(uuid, text), public.finish_task(uuid), public.touch_file(uuid, text, interval),
  public.find_overlap(uuid, text, uuid, interval, real, int)
  to authenticated;
revoke execute on function private.task_is_live(public.sessions) from public, anon;
grant execute on function private.task_is_live(public.sessions) to authenticated;
