-- Fixes to work awareness (20261113100000):
-- * Chat tasks end on their own. Claude chat only finishes a task through post_turn, which it skips
--   for replies that did no real work, so a chat task counts as live for 10 minutes after the last
--   contexter call instead of 60.
-- * touch_file can check a file without recording it (private turns don't publish their files).
-- * find_overlap pairs a prompt only with the reply of its own turn, and marks a match "still being
--   worked on" only when it is that session's current task.

-- ─────────────────────────────────────────────────────────────── liveness

create or replace function private.task_is_live(s public.sessions)
returns boolean
language sql stable set search_path = ''
as $$
  select s.ended_at is null and s.task_started_at is not null and s.task_finished_at is null
     and s.last_seen_at > now() - case when s.client = 'claude-chat' then interval '10 minutes'
                                       else interval '60 minutes' end;
$$;

-- ─────────────────────────────────────────────────────────────── file activity

drop function public.touch_file(uuid, text, interval);

-- With p_record false (a private turn), nothing about the file is stored: the caller only learns
-- who else is on it.
create function public.touch_file(
  p_session uuid, p_path text, p_since interval default interval '24 hours', p_record boolean default true
)
returns table (author_id uuid, session_id uuid, task text, touched_at timestamptz, active boolean)
language plpgsql security invoker set search_path = ''
as $$
#variable_conflict use_column
declare
  s public.sessions;
begin
  if p_record then
    update public.sessions o
       set task_files = case when p_path = any(o.task_files) then o.task_files
                             else (o.task_files || p_path)[greatest(1, cardinality(o.task_files) - 48):] end,
           last_seen_at = now()
     where o.id = p_session and o.user_id = (select auth.uid())
    returning o.* into s;
  else
    select * into s from public.sessions o where o.id = p_session and o.user_id = (select auth.uid());
  end if;
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

create or replace function public.find_overlap(
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
         -- The reply that ended this prompt's turn: the first reply before the session's next prompt.
         case when sc.kind = 'prompt' then
           (select r.payload->>'summary' from public.events r
             where r.session_id = sc.session_id and r.kind = 'reply' and r.id > sc.id
               and not exists (select 1 from public.events n
                                where n.session_id = sc.session_id and n.kind = 'prompt'
                                  and n.id > sc.id and n.id < r.id)
             order by r.id limit 1) end,
         sc.files,
         sc.created_at,
         (sc.shared::real / least(cardinality(words), cardinality(sc.lex)))::real,
         -- Still being worked on: a live task itself, or the prompt that started its session's live
         -- task (the session's latest prompt, posted when the task started, with no reply yet).
         sc.kind = 'task' or (
           sc.kind = 'prompt'
           and exists (select 1 from public.sessions o
                        where o.id = sc.session_id and private.task_is_live(o)
                          and sc.created_at >= o.task_started_at - interval '1 minute')
           and not exists (select 1 from public.events n
                            where n.session_id = sc.session_id and n.kind in ('prompt', 'reply')
                              and n.id > sc.id))
    from scored sc
   where sc.shared >= 3
     and sc.shared::real / least(cardinality(words), cardinality(sc.lex)) >= p_min_score
   order by 9 desc, sc.created_at desc
   limit p_limit;
end;
$$;

-- ─────────────────────────────────────────────────────────────── grants

revoke execute on function public.touch_file(uuid, text, interval, boolean) from public, anon;
grant execute on function public.touch_file(uuid, text, interval, boolean) to authenticated;
