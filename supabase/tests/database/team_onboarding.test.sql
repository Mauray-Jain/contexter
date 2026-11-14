-- Teams, email invites and project grants. Run: npx supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000a1', 'alice@team.local', now()),
  ('00000000-0000-0000-0000-0000000000b1', 'bob@team.local',   now()),
  ('00000000-0000-0000-0000-0000000000c1', 'carol@team.local', now()),
  ('00000000-0000-0000-0000-0000000000d1', 'dave@team.local',  null),   -- never verified
  ('00000000-0000-0000-0000-0000000000e1', 'eve@team.local',   now()),
  ('00000000-0000-0000-0000-0000000000f1', 'fay@team.local',   now());

create function pg_temp.act_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on function pg_temp.act_as(uuid) to authenticated, anon;

-- ── alice builds a team with two projects
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select lives_ok($$ select public.create_team('acme', 'Acme') $$, 'anyone signed in can create a team');
select is((select role from public.team_members), 'owner', 'creator is team owner');
select lives_ok($$ select public.create_workspace('paper', 'Paper', 'alice') $$, 'owner creates project 1');
select lives_ok($$ select public.create_workspace('code', 'Code', 'alice') $$, 'owner creates project 2');
select lives_ok(
  $$ select public.attach_workspace_to_team(w.id, (select id from public.teams)) from public.workspaces w $$,
  'projects attach to the team');
create temp table ids as
  select (select id from public.teams) as team,
         (select id from public.workspaces where slug = 'paper') as paper,
         (select id from public.workspaces where slug = 'code') as code;
grant select on ids to authenticated;

select lives_ok(
  $$ select public.invite_to_team((select team from ids), array['Bob@team.local', ' carol@team.local '], 'member',
       jsonb_build_array(jsonb_build_object('workspace_id', (select paper from ids), 'role', 'editor'))) $$,
  'admin invites several emails with a project grant');
select is((select count(*)::int from public.email_invites where status = 'pending'), 2, 'two pending invites');
select is((select count(*)::int from public.email_invites where email = 'bob@team.local'), 1, 'emails are lower-cased and trimmed');
select lives_ok(
  $$ select public.invite_to_team((select team from ids), array['bob@team.local'], 'member',
       jsonb_build_array(jsonb_build_object('workspace_id', (select paper from ids), 'role', 'viewer'))) $$,
  're-inviting the same email updates the pending invite');
select is((select count(*)::int from public.email_invites where email = 'bob@team.local'), 1, 'still one pending invite for bob');
select lives_ok(
  $$ select public.invite_to_team((select team from ids), array['bob@team.local'], 'member',
       jsonb_build_array(jsonb_build_object('workspace_id', (select paper from ids), 'role', 'editor'))) $$,
  'grants can be changed before acceptance');

select throws_ok(
  $$ select public.invite_to_team((select team from ids), array['x@team.local'], 'member',
       jsonb_build_array(jsonb_build_object('workspace_id', gen_random_uuid(), 'role', 'editor'))) $$,
  '22023', null, 'grants must name a project of this team');
select throws_ok(
  $$ select public.invite_to_team((select team from ids), array['x@team.local'], 'member',
       jsonb_build_array(jsonb_build_object('workspace_id', (select paper from ids), 'role', 'owner'))) $$,
  '22023', null, 'cannot grant project ownership by invite');
select throws_ok($$ select public.invite_to_team((select team from ids), '{}', 'member') $$, '22023', null, 'empty invite list rejected');
select lives_ok(
  $$ select public.invite_to_team((select team from ids), array['dave@team.local', 'fay@team.local'], 'member') $$,
  'invite with no grants is allowed');
reset role;

-- ── outsiders and members cannot see or send invites
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e1');
select is((select count(*)::int from public.teams), 0, 'outsider sees no teams');
select is((select count(*)::int from public.email_invites), 0, 'outsider sees no invites');
select throws_ok($$ select public.invite_to_team((select team from ids), array['z@team.local']) $$, '42501', null,
  'outsider cannot invite');
select is(public.accept_pending_invites(), '[]'::jsonb, 'no invite for eve, nothing applied');
reset role;

-- ── bob accepts: team member plus project access with a derived handle
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is(public.accept_pending_invites() -> 0 ->> 'team', 'acme', 'bob accepts the acme invite');
select is((select role from public.members where handle = 'bob'), 'editor', 'bob is an editor on the granted project');
select is((select source from public.members where handle = 'bob'), 'team', 'access is marked as team-granted');
select is((select count(*)::int from public.members m join public.workspaces w on w.id = m.workspace_id
           where m.user_id = auth.uid() and w.slug = 'code'), 0, 'bob has no access to the other project');
select is(public.accept_pending_invites(), '[]'::jsonb, 'accepting twice applies nothing');
select is((select count(*)::int from public.workspaces), 1, 'bob sees only his project');
select throws_ok($$ select public.invite_to_team((select team from ids), array['y@team.local']) $$, '42501', null,
  'plain team members cannot invite');
select throws_ok($$ select public.set_team_member_role((select team from ids), auth.uid(), 'owner') $$, '42501', null,
  'members cannot change roles');
select is((select count(*)::int from public.email_invites), 0, 'members cannot read invites');
reset role;

-- ── unverified email never matches
select pg_temp.act_as('00000000-0000-0000-0000-0000000000d1');
select is(public.accept_pending_invites(), '[]'::jsonb, 'unverified email accepts nothing');
select is((select count(*)::int from public.team_members where user_id = auth.uid()), 0, 'and does not join the team');
reset role;

-- ── expired invites are not applied
update public.email_invites set expires_at = now() - interval '1 day' where email = 'fay@team.local';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f1');
select is(public.accept_pending_invites(), '[]'::jsonb, 'expired invite is not applied');
reset role;
select is((select status from public.email_invites where email = 'fay@team.local'), 'expired', 'and is marked expired');

-- ── team default access: all_projects
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
update public.teams set new_member_access = 'all_projects';
select is((select new_member_access from public.teams), 'all_projects', 'admin changes the team default');
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
select is(jsonb_array_length(public.accept_pending_invites() -> 0 -> 'workspaces'), 2,
  'carol gets every project through the team default');
select is((select count(*)::int from public.members where user_id = auth.uid() and role = 'editor'), 2, 'as editor');
reset role;

-- ── project grants and revokes by a team admin
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select lives_ok($$ select public.grant_project_access((select code from ids), '00000000-0000-0000-0000-0000000000b1', 'viewer') $$,
  'admin grants a team member another project');
select is((select role from public.members where handle = 'bob' and workspace_id = (select code from ids)), 'viewer', 'as viewer');
select lives_ok($$ select public.grant_project_access((select code from ids), '00000000-0000-0000-0000-0000000000b1', 'editor') $$,
  'role can be raised');
select is((select role from public.members where handle = 'bob' and workspace_id = (select code from ids)), 'editor', 'to editor');
select throws_ok($$ select public.grant_project_access((select code from ids), '00000000-0000-0000-0000-0000000000e1', 'editor') $$,
  'P0002', null, 'cannot grant access to someone outside the team');
select lives_ok($$ select public.revoke_project_access((select code from ids), '00000000-0000-0000-0000-0000000000b1') $$,
  'admin revokes one project');
select is((select count(*)::int from public.members where workspace_id = (select code from ids) and user_id = '00000000-0000-0000-0000-0000000000b1'), 0,
  'bob loses that project');
select throws_ok($$ select public.revoke_project_access((select paper from ids), '00000000-0000-0000-0000-0000000000a1') $$,
  '23514', null, 'the project owner cannot be revoked');

-- ── last-owner guards
select throws_ok($$ select public.set_team_member_role((select team from ids), '00000000-0000-0000-0000-0000000000a1', 'member') $$,
  '23514', null, 'the last team owner cannot be demoted');
select throws_ok($$ select public.remove_team_member((select team from ids), '00000000-0000-0000-0000-0000000000a1') $$,
  '23514', null, 'or removed');
select lives_ok($$ select public.set_team_member_role((select team from ids), '00000000-0000-0000-0000-0000000000c1', 'admin') $$,
  'owner promotes carol to admin');
select lives_ok($$ select public.set_team_member_role((select team from ids), '00000000-0000-0000-0000-0000000000c1', 'owner') $$,
  'and then to owner');
select lives_ok($$ select public.set_team_member_role((select team from ids), '00000000-0000-0000-0000-0000000000a1', 'member') $$,
  'with two owners, one can step down');

-- ── removing a member removes their team-granted access only
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
select lives_ok($$ select public.remove_team_member((select team from ids), '00000000-0000-0000-0000-0000000000b1') $$,
  'team owner removes bob');
select is((select count(*)::int from public.members where user_id = '00000000-0000-0000-0000-0000000000b1'), 0,
  'bob has no project access left');
select is((select count(*)::int from public.team_members where user_id = '00000000-0000-0000-0000-0000000000b1'), 0,
  'and is off the team');
reset role;

select * from finish();
rollback;
