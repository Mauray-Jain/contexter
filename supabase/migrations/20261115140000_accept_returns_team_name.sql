-- accept_pending_invites() also returns the team's display name, for friendlier messages.
create or replace function public.accept_pending_invites()
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
    result := result || jsonb_build_object('team', t.slug, 'name', t.name, 'workspaces', to_jsonb(slugs));
  end loop;
  return result;
end;
$$;

