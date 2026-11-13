-- update_run: once a run has ended, a later report of an end changes nothing. Before, it kept the
-- first status but overwrote progress, log tail and exit code, so two reporters of the same end
-- (the contexter hook closing a background command's run, and Claude calling update_run) could mix
-- their details. Same signature, so grants and callers are unchanged.
create or replace function public.update_run(
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
  -- The first report of an end wins, whole.
  if r.status <> 'running' and coalesce(p_status, 'running') <> 'running' then
    return r;
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
