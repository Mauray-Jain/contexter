-- Team onboarding: permissions, abuse and edge cases. Run: npx supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000001a1', 'owner@edge.local',  now()),
  ('00000000-0000-0000-0000-0000000001a2', 'admin@edge.local',  now()),
  ('00000000-0000-0000-0000-0000000001a3', 'member@edge.local', now()),
  ('00000000-0000-0000-0000-0000000001a4', 'rival@edge.local',  now()),   -- owns another team
  ('00000000-0000-0000-0000-0000000001a5', 'sam@one.local',     now()),
  ('00000000-0000-0000-0000-0000000001a6', 'sam@two.local',     now()),
  ('00000000-0000-0000-0000-0000000001a7', 'Mixed@Edge.local',  now()),   -- stored with capitals
  ('00000000-0000-0000-0000-0000000001a8', 'direct@edge.local', now());

create function pg_temp.act_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on function pg_temp.act_as(uuid) to authenticated, anon;

-- ── set-up: owner's team with two projects; rival has a separate team and project
select pg_temp.act_as('00000000-0000-0000-0000-0000000001a1');
select public.create_team('edge', 'Edge');
select public.create_workspace('paper', 'Paper', 'owner');
select public.create_workspace('code', 'Code', 'owner');
select public.create_workspace('legacy', 'Legacy', 'owner');          -- never joins a team
select public.attach_workspace_to_team(id, (select id from public.teams where slug = 'edge'))
  from public.workspaces where slug in ('paper', 'code');
create temp table ids as
  select (select id from public.teams where slug = 'edge') as team,
         (select id from public.workspaces where slug = 'paper') as paper,
         (select id from public.workspaces where slug = 'code') as code,
         (select id from public.workspaces where slug = 'legacy') as legacy;
grant select on ids to authenticated;
insert into public.invites (workspace_id, role, code)                  -- a direct (non-team) viewer invite
  select paper, 'viewer', 'direct-viewer' from ids;
select public.invite_to_team((select team from ids), array['admin@edge.local'], 'admin');
select public.invite_to_team((select team from ids),
  array['member@edge.local', 'sam@one.local', 'sam@two.local', 'mixed@edge.local', 'direct@edge.local'], 'member',
  jsonb_build_array(jsonb_build_object('workspace_id', (select paper from ids), 'role', 'viewer')));
reset role;

select pg_temp.act_as('00000000-0000-0000-0000-0000000001a4');
select public.create_team('rival', 'Rival');
select public.create_workspace('rivalproj', 'Rival project', 'rival');
select public.attach_workspace_to_team(id, (select id from public.teams where slug = 'rival'))
  from public.workspaces where slug = 'rivalproj';
create temp table rival as
  select (select id from public.teams where slug = 'rival') as team,
         (select id from public.workspaces where slug = 'rivalproj') as proj;
grant select on rival to authenticated;
reset role;

-- ── nobody can bypass the RPCs by writing the tables directly
select pg_temp.act_as('00000000-0000-0000-0000-0000000001a1');
select throws_ok($$ insert into public.team_members (team_id, user_id, role)
                    values ((select team from ids), '00000000-0000-0000-0000-0000000001a3', 'owner') $$,
  '42501', null, 'even a team owner cannot insert team_members directly');
select throws_ok($$ update public.team_members set role = 'owner' $$, '42501', null, 'or update roles directly');
select throws_ok($$ delete from public.team_members $$, '42501', null, 'or delete members directly');
select throws_ok($$ insert into public.email_invites (team_id, email) values ((select team from ids), 'a@b.co') $$,
  '42501', null, 'or write invites directly');
select throws_ok($$ update public.email_invites set status = 'accepted' $$, '42501', null, 'or fake an accepted invite');
select throws_ok($$ update public.teams set slug = 'hijack' $$, '42501', null, 'team slug is not editable');
select lives_ok($$ update public.teams set name = 'Edge Inc' $$, 'name is editable by an admin');
reset role;
set local role anon;
select throws_ok($$ select public.create_team('anon', 'Anon') $$, '42501', null, 'anonymous callers cannot use the RPCs');
select throws_ok($$ select public.accept_pending_invites() $$, '42501', null, 'including accept');
reset role;

-- ── a team admin who is not an owner
select pg_temp.act_as('00000000-0000-0000-0000-0000000001a2');
select is(jsonb_array_length(public.accept_pending_invites()), 1, 'admin accepts their invite');
select is((select role from public.team_members where user_id = auth.uid()), 'admin', 'as admin');
select is((select count(*)::int from public.email_invites where status = 'pending'), 5, 'admin can read the invites');
select lives_ok($$ select public.invite_to_team((select team from ids), array['new@edge.local']) $$, 'admin can invite members');
select throws_ok($$ select public.invite_to_team((select team from ids), array['boss@edge.local'], 'admin') $$,
  '42501', null, 'but not admins');
select throws_ok($$ select public.set_team_member_role((select team from ids), auth.uid(), 'owner') $$,
  '42501', null, 'admin cannot promote themselves');
select throws_ok($$ select public.remove_team_member((select team from ids), '00000000-0000-0000-0000-0000000001a1') $$,
  '42501', null, 'admin cannot remove the owner');
select lives_ok($$ select public.grant_project_access((select code from ids), auth.uid(), 'editor') $$,
  'admin can grant project access without owning the project');
select lives_ok($$ select public.revoke_invite((select id from public.email_invites where email = 'new@edge.local')) $$,
  'admin can revoke an invite');
select throws_ok($$ select public.revoke_invite((select id from public.email_invites where email = 'new@edge.local')) $$,
  'P0002', null, 'a revoked invite cannot be revoked again');
select throws_ok($$ select public.invite_to_team((select team from rival), array['x@edge.local']) $$,
  '42501', null, 'admin of one team cannot invite to another');
select throws_ok($$ select public.invite_to_team((select team from ids), array['x@edge.local'], 'member',
    jsonb_build_array(jsonb_build_object('workspace_id', (select proj from rival), 'role', 'editor'))) $$,
  '22023', null, 'or grant access to another team''s project');
reset role;

-- ── plain member: viewer on the project, cannot write, cannot manage anything
select pg_temp.act_as('00000000-0000-0000-0000-0000000001a3');
select is(public.accept_pending_invites() -> 0 -> 'workspaces', '["paper"]'::jsonb, 'member accepted with one project');
select is((select role from public.members where workspace_id = (select paper from ids) and user_id = auth.uid()), 'viewer',
  'granted as viewer');
select throws_ok($$ insert into public.units (workspace_id, collection, key) values ((select paper from ids), 'sections', 'x') $$,
  '42501', null, 'a team-granted viewer cannot create units');
select throws_ok($$ select public.grant_project_access((select code from ids), auth.uid(), 'editor') $$, '42501', null,
  'member cannot grant themselves access');
select throws_ok($$ select public.remove_team_member((select team from ids), '00000000-0000-0000-0000-0000000001a2') $$, '42501', null,
  'member cannot remove others');
select throws_ok($$ select public.attach_workspace_to_team((select legacy from ids), (select team from ids)) $$, '42501', null,
  'member cannot attach projects');
reset role;

-- ── handles: collisions are numbered, reused across the team's projects
select pg_temp.act_as('00000000-0000-0000-0000-0000000001a5');
select public.accept_pending_invites();
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000001a6');
select public.accept_pending_invites();
reset role;
select is((select handle from public.members where user_id = '00000000-0000-0000-0000-0000000001a5' and workspace_id = (select paper from ids)), 'sam',
  'first sam gets sam');
select is((select handle from public.members where user_id = '00000000-0000-0000-0000-0000000001a6' and workspace_id = (select paper from ids)), 'sam2',
  'second sam gets sam2');
select pg_temp.act_as('00000000-0000-0000-0000-0000000001a1');
select public.grant_project_access((select code from ids), '00000000-0000-0000-0000-0000000001a6', 'viewer');
reset role;
select is((select handle from public.members where user_id = '00000000-0000-0000-0000-0000000001a6' and workspace_id = (select code from ids)), 'sam2',
  'a person keeps the same handle across the team''s projects');

-- ── emails match case-insensitively
select pg_temp.act_as('00000000-0000-0000-0000-0000000001a7');
select is(jsonb_array_length(public.accept_pending_invites()), 1, 'Mixed@Edge.local matches the lower-cased invite');
reset role;

-- ── a direct member keeps their access and role when removed from the team
select pg_temp.act_as('00000000-0000-0000-0000-0000000001a8');
select public.join_workspace('direct-viewer', 'dee');
select is(public.accept_pending_invites() -> 0 -> 'workspaces', '[]'::jsonb, 'a team grant never downgrades or duplicates existing access');
select is((select source from public.members where user_id = auth.uid() and workspace_id = (select paper from ids)), 'direct', 'direct stays direct');
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000001a1');
select public.remove_team_member((select team from ids), '00000000-0000-0000-0000-0000000001a8');
select is((select handle from public.members where user_id = '00000000-0000-0000-0000-0000000001a8'), 'dee',
  'removing them from the team keeps their direct membership');
reset role;

-- ── leaving a team
select pg_temp.act_as('00000000-0000-0000-0000-0000000001a3');
select lives_ok($$ select public.remove_team_member((select team from ids), auth.uid()) $$, 'a member can leave');
select is((select count(*)::int from public.members where user_id = auth.uid() and source = 'team'), 0, 'and loses team-granted access');
reset role;

-- ── two teams invite the same person
select pg_temp.act_as('00000000-0000-0000-0000-0000000001a1');
select public.invite_to_team((select team from ids), array['rival@edge.local']);
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000001a4');
select public.invite_to_team((select team from rival), array['owner@edge.local']);
select is(jsonb_array_length(public.accept_pending_invites()), 1, 'rival accepts edge''s invite');
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000001a1');
select is(jsonb_array_length(public.accept_pending_invites()), 1, 'and owner accepts rival''s invite');
select is((select count(*)::int from public.team_members where user_id = auth.uid()), 2, 'owner is now on two teams');
reset role;

-- ── workspaces outside any team behave exactly as before
select pg_temp.act_as('00000000-0000-0000-0000-0000000001a1');
select lives_ok($$ select public.grant_project_access((select legacy from ids), '00000000-0000-0000-0000-0000000001a3', 'viewer') $$,
  'a project owner can grant access on a team-less project');
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000001a5');
select throws_ok($$ select public.grant_project_access((select legacy from ids), auth.uid(), 'editor') $$, '42501', null,
  'but nobody else can');
reset role;

-- ── the dashboard overview: admins only
select pg_temp.act_as('00000000-0000-0000-0000-0000000001a1');
select is(jsonb_array_length(public.team_overview((select team from ids)) -> 'projects'), 2, 'overview lists the team''s two projects');
select ok((select bool_or(r ->> 'email' = 'admin@edge.local') from jsonb_array_elements(public.team_overview((select team from ids)) -> 'roster') r),
  'overview shows member emails to admins');
select is((select jsonb_array_length(r -> 'projects') from jsonb_array_elements(public.team_overview((select team from ids)) -> 'roster') r
           where r ->> 'email' = 'sam@two.local'), 2, 'and each person''s project access');
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000001a5');
select throws_ok($$ select public.team_overview((select team from ids)) $$, '42501', null, 'a plain member cannot see the roster');
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000001a4');
select throws_ok($$ select public.team_overview((select team from ids)) $$, '42501', null, 'and neither can another team''s admin');
reset role;

select * from finish();
rollback;
