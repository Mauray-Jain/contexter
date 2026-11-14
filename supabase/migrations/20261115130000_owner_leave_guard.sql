-- Nobody leaves a team while owning one of its projects: removal deletes team-granted access, and an
-- owner's row may be team-granted (after a transfer), which would leave the project with no owner.
-- The error names the projects, so the caller knows what to transfer first.
create or replace function public.remove_team_member(p_team uuid, p_user uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  uid   uuid := (select auth.uid());
  cur   text;
  owned text;
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
  select string_agg(w.slug, ', ' order by w.slug) into owned
    from public.members m join public.workspaces w on w.id = m.workspace_id
    where w.team_id = p_team and m.user_id = p_user and m.role = 'owner';
  if owned is not null then
    raise exception 'they still own %; transfer ownership first', owned using errcode = '23514';
  end if;
  delete from public.members m
    using public.workspaces w
    where m.workspace_id = w.id and w.team_id = p_team and m.user_id = p_user and m.source = 'team';
  delete from public.team_members where team_id = p_team and user_id = p_user;
end;
$$;
