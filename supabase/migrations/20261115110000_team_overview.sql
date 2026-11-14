-- One call for the team dashboard: the team's projects and roster with each person's access.
-- Team admins only. Emails and per-project roles are otherwise hidden from people who are not
-- members of every project, so this goes through a definer function rather than loosening RLS.
create function public.team_overview(p_team uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not (select private.is_team_admin(p_team)) then
    raise exception 'only team admins can see the roster' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'projects', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', w.id, 'slug', w.slug, 'name', w.name, 'template', w.template,
        'members', (select count(*) from public.members m where m.workspace_id = w.id)
      ) order by w.name)
      from public.workspaces w where w.team_id = p_team), '[]'::jsonb),
    'roster', coalesce((
      select jsonb_agg(jsonb_build_object(
        'user_id', tm.user_id, 'email', u.email, 'role', tm.role, 'joined_at', tm.joined_at,
        'projects', coalesce((
          select jsonb_agg(jsonb_build_object(
            'workspace_id', m.workspace_id, 'role', m.role, 'source', m.source, 'handle', m.handle))
          from public.members m join public.workspaces w on w.id = m.workspace_id
          where w.team_id = p_team and m.user_id = tm.user_id), '[]'::jsonb)
      ) order by tm.joined_at)
      from public.team_members tm join auth.users u on u.id = tm.user_id
      where tm.team_id = p_team), '[]'::jsonb)
  );
end;
$$;

revoke execute on function public.team_overview(uuid) from public, anon;
grant execute on function public.team_overview(uuid) to authenticated;
