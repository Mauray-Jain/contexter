-- Team projects: create a project from a template on the web, and transfer project ownership.
-- Templates live in the database so the web and the CLI offer the same ones. The rows below are
-- generated from packages/cli/src/templates.ts; scripts/projects-test.ts fails if they drift apart.

create table public.templates (
  name        text primary key check (name ~ '^[a-z0-9-]{1,40}$'),
  description text not null,
  manifest    jsonb not null default '{}'::jsonb,
  units       jsonb not null default '[]'::jsonb,   -- [{collection, key, status?, position?}]
  position    int not null default 0
);
alter table public.templates enable row level security;
create policy templates_select on public.templates for select to authenticated using (true);
revoke all on public.templates from anon, authenticated;
grant select on public.templates to authenticated;

insert into public.templates (name, description, manifest, units, position) values
  ('blank', 'No structure; define collections as you go', '{"collections":{},"rules":[]}'::jsonb, '[]'::jsonb, 0),
  ('research-paper', 'Ordered paper sections, notes and references', '{"collections":{"sections":{"kind":"managed","ordered":true,"statuses":["outline","drafting","review","final"]},"notes":{"kind":"managed","ordered":false,"statuses":["open","done"]},"refs":{"kind":"managed","ordered":false,"statuses":["active"]}},"rules":["Use pandoc citations [@key]; every key must exist in refs/bibliography","Write in present tense, first person plural"],"export":{"pipeline":"pandoc","include_records":"optional"}}'::jsonb, '[{"collection":"sections","key":"abstract","status":"outline","position":1},{"collection":"sections","key":"introduction","status":"outline","position":2},{"collection":"sections","key":"related-work","status":"outline","position":3},{"collection":"sections","key":"method","status":"outline","position":4},{"collection":"sections","key":"experiments","status":"outline","position":5},{"collection":"sections","key":"results","status":"outline","position":6},{"collection":"sections","key":"discussion","status":"outline","position":7},{"collection":"sections","key":"conclusion","status":"outline","position":8},{"collection":"refs","key":"bibliography","status":"active"}]'::jsonb, 1),
  ('software', 'Specs and design docs; code lives in your git repo and is linked by path', '{"collections":{"specs":{"kind":"managed","ordered":false,"statuses":["draft","review","accepted","superseded"]},"modules":{"kind":"linked","ordered":false,"statuses":["planned","building","done"]},"notes":{"kind":"managed","ordered":false,"statuses":["open","done"]}},"rules":["Code changes go through the project''s git repo; record why in contexter (decision / rationale)","Every accepted spec links the decisions it depends on"],"export":{"pipeline":"pandoc","collection":"specs","include_records":"optional"}}'::jsonb, '[{"collection":"specs","key":"overview","status":"draft","position":1},{"collection":"specs","key":"architecture","status":"draft","position":2}]'::jsonb, 2),
  ('book', 'Ordered chapters plus characters and world notes', '{"collections":{"chapters":{"kind":"managed","ordered":true,"statuses":["outline","drafting","editing","final"]},"characters":{"kind":"managed","ordered":false,"statuses":["sketch","settled"]},"world":{"kind":"managed","ordered":false,"statuses":["sketch","settled"]}},"rules":["Check characters/ and world/ before writing; record any change to canon as a decision","Keep tense and point of view consistent with chapter 1"],"export":{"pipeline":"pandoc","collection":"chapters","include_records":"never"}}'::jsonb, '[{"collection":"chapters","key":"chapter-01","status":"outline","position":1},{"collection":"world","key":"setting","status":"sketch"}]'::jsonb, 3),
  ('spec', 'Requirements and designs, each requirement traced to decisions', '{"collections":{"requirements":{"kind":"managed","ordered":true,"statuses":["proposed","accepted","rejected"]},"designs":{"kind":"managed","ordered":false,"statuses":["draft","review","accepted"]}},"rules":["Number requirements as R1, R2…; never renumber","Every accepted requirement links at least one decision record"],"export":{"pipeline":"pandoc","collection":"requirements","include_records":"optional"}}'::jsonb, '[{"collection":"requirements","key":"goals","status":"proposed","position":1},{"collection":"designs","key":"approach","status":"draft"}]'::jsonb, 4),
  ('knowledge-base', 'Unordered topics that grow over time', '{"collections":{"topics":{"kind":"managed","ordered":false,"statuses":["stub","useful","complete"]}},"rules":["One topic per unit; link related topics in the text as topics/<key>"],"export":{"pipeline":"pandoc","collection":"topics","include_records":"never"}}'::jsonb, '[{"collection":"topics","key":"index","status":"stub"}]'::jsonb, 5);

-- A team admin creates a project in the team. The creator owns it; the template seeds its units;
-- when the team gives new members every project, existing members get this one as editors too.
create function public.create_team_project(p_team uuid, p_slug text, p_name text, p_template text default 'blank')
returns public.workspaces
language plpgsql security definer set search_path = ''
as $$
declare
  uid  uuid := (select auth.uid());
  tpl  public.templates;
  t    public.teams;
  ws   public.workspaces;
  em   text;
  h    text;
  u    jsonb;
  m    record;
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if not (select private.is_team_admin(p_team)) then
    raise exception 'only team admins can create projects' using errcode = '42501';
  end if;
  select * into tpl from public.templates where name = p_template;
  if not found then
    raise exception 'unknown template %', p_template using errcode = '22023';
  end if;
  select * into t from public.teams where id = p_team;
  select u2.email into em from auth.users u2 where u2.id = uid;

  insert into public.workspaces (slug, name, template, manifest, created_by, team_id)
  values (p_slug, p_name, tpl.name, tpl.manifest, uid, p_team)
  returning * into ws;

  h := private.derive_handle(ws.id, uid, coalesce(em, 'owner'));
  insert into public.members (workspace_id, user_id, handle, role, source) values (ws.id, uid, h, 'owner', 'direct');
  insert into public.events (workspace_id, author_id, kind, payload)
  values (ws.id, uid, 'member', jsonb_build_object('action', 'created', 'handle', h));

  for u in select * from jsonb_array_elements(tpl.units) loop
    insert into public.units (workspace_id, collection, key, status, position)
    values (ws.id, u ->> 'collection', u ->> 'key', coalesce(u ->> 'status', 'outline'), (u ->> 'position')::int);
  end loop;

  if t.new_member_access = 'all_projects' then
    for m in select tm.user_id, au.email from public.team_members tm join auth.users au on au.id = tm.user_id
             where tm.team_id = p_team and tm.user_id <> uid loop
      perform private.grant_project(ws.id, m.user_id, 'editor', coalesce(m.email, 'user'));
    end loop;
  end if;
  return ws;
end;
$$;

-- Make someone else the owner. Allowed for the project's owner, or a team admin when the project is
-- in a team. The new owner gets access if they had none (team projects only: they must be on the team).
-- Every previous owner becomes an editor, so a project always has exactly one owner after this.
create function public.transfer_project_ownership(p_workspace uuid, p_user uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  t   uuid;
  em  text;
begin
  select team_id into t from public.workspaces where id = p_workspace;
  if not found then
    raise exception 'no such project' using errcode = 'P0002';
  end if;
  if not ((select private.is_owner(p_workspace)) or (t is not null and (select private.is_team_admin(t)))) then
    raise exception 'only the project owner or a team admin can transfer ownership' using errcode = '42501';
  end if;
  if not exists (select 1 from public.members where workspace_id = p_workspace and user_id = p_user) then
    if t is null or not exists (select 1 from public.team_members where team_id = t and user_id = p_user) then
      raise exception 'the new owner must be on the project or its team' using errcode = 'P0002';
    end if;
    select u.email into em from auth.users u where u.id = p_user;
    perform private.grant_project(p_workspace, p_user, 'editor', coalesce(em, 'user'));
  end if;
  update public.members set role = 'editor' where workspace_id = p_workspace and role = 'owner' and user_id <> p_user;
  update public.members set role = 'owner' where workspace_id = p_workspace and user_id = p_user;
  insert into public.events (workspace_id, author_id, kind, payload)
  values (p_workspace, uid, 'member', jsonb_build_object('action', 'became owner',
    'handle', (select handle from public.members where workspace_id = p_workspace and user_id = p_user)));
end;
$$;

revoke execute on function public.create_team_project(uuid, text, text, text), public.transfer_project_ownership(uuid, uuid) from public, anon;
grant execute on function public.create_team_project(uuid, text, text, text), public.transfer_project_ownership(uuid, uuid) to authenticated;
