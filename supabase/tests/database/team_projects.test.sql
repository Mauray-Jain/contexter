-- Team projects: create from a template, team defaults, ownership transfer. Run: npx supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000002a1', 'owner@proj.local',  now()),
  ('00000000-0000-0000-0000-0000000002a2', 'admin@proj.local',  now()),
  ('00000000-0000-0000-0000-0000000002a3', 'member@proj.local', now()),
  ('00000000-0000-0000-0000-0000000002a4', 'outsider@proj.local', now());

create function pg_temp.act_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on function pg_temp.act_as(uuid) to authenticated, anon;

select pg_temp.act_as('00000000-0000-0000-0000-0000000002a1');
select public.create_team(p_slug => 'proj', p_name => 'Proj');
select public.invite_to_team((select id from public.teams), array['admin@proj.local'], 'admin');
select public.invite_to_team((select id from public.teams), array['member@proj.local'], 'member');
create temp table t as select id from public.teams where slug = 'proj';
grant select on t to authenticated;
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000002a2'); select public.accept_pending_invites(); reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000002a3'); select public.accept_pending_invites(); reset role;

-- ── templates are readable, and match what the CLI ships
select pg_temp.act_as('00000000-0000-0000-0000-0000000002a3');
select ok((select count(*) from public.templates) >= 6, 'templates are readable by signed-in users');
select throws_ok($$ insert into public.templates (name, description) values ('x', 'x') $$, '42501', null, 'but not writable');
reset role;
set local role anon;
select throws_ok($$ select count(*) from public.templates $$, '42501', null, 'anonymous callers cannot read templates');
reset role;

-- ── who can create
select pg_temp.act_as('00000000-0000-0000-0000-0000000002a3');
select throws_ok($$ select public.create_team_project((select id from t), 'nope', 'Nope') $$, '42501', null, 'plain members cannot create projects');
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000002a4');
select throws_ok($$ select public.create_team_project((select id from t), 'nope', 'Nope') $$, '42501', null, 'outsiders cannot create projects');
reset role;

select pg_temp.act_as('00000000-0000-0000-0000-0000000002a2');
select throws_ok($$ select public.create_team_project((select id from t), 'x1', 'X', 'no-such-template') $$, '22023', null, 'unknown templates are refused');
select lives_ok($$ select public.create_team_project((select id from t), 'paper', 'Paper', 'research-paper') $$, 'a team admin creates a project from a template');
select is((select role from public.members m join public.workspaces w on w.id = m.workspace_id where w.slug = 'paper' and m.user_id = auth.uid()), 'owner',
  'the creator owns it');
select is((select team_id from public.workspaces where slug = 'paper'), (select id from t), 'it belongs to the team');
select is((select count(*)::int from public.units u join public.workspaces w on w.id = u.workspace_id where w.slug = 'paper'),
  (select jsonb_array_length(units) from public.templates where name = 'research-paper'), 'the template seeds its units');
select is((select position from public.units u join public.workspaces w on w.id = u.workspace_id where w.slug = 'paper' and u.key = 'method'), 4,
  'ordered units keep their positions');
select is((select manifest from public.workspaces where slug = 'paper'), (select manifest from public.templates where name = 'research-paper'),
  'the manifest comes from the template');
select throws_ok($$ select public.create_team_project((select id from t), 'paper', 'Again') $$, '23505', null, 'project short names are unique');
select is((select count(*)::int from public.members m join public.workspaces w on w.id = m.workspace_id where w.slug = 'paper'), 1,
  'with the team default off, nobody else gets access');
reset role;

-- ── team default "all projects" reaches projects created later
select pg_temp.act_as('00000000-0000-0000-0000-0000000002a1');
update public.teams set new_member_access = 'all_projects';
select lives_ok($$ select public.create_team_project((select id from t), 'code', 'Code', 'software') $$, 'owner creates a second project');
select is((select count(*)::int from public.members m join public.workspaces w on w.id = m.workspace_id where w.slug = 'code'), 3,
  'with the team default on, every team member gets the new project');
select is((select role from public.members m join public.workspaces w on w.id = m.workspace_id
           where w.slug = 'code' and m.user_id = '00000000-0000-0000-0000-0000000002a3'), 'editor', 'as editors');
reset role;

-- ── ownership transfer
select pg_temp.act_as('00000000-0000-0000-0000-0000000002a3');
select throws_ok($$ select public.transfer_project_ownership((select id from public.workspaces where slug = 'code'), auth.uid()) $$,
  '42501', null, 'a plain member cannot take ownership');
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000002a2');
select lives_ok($$ select public.transfer_project_ownership((select id from public.workspaces where slug = 'paper'), '00000000-0000-0000-0000-0000000002a3') $$,
  'the owner hands a project to a team member who had no access');
reset role;
select is((select role from public.members m join public.workspaces w on w.id = m.workspace_id
           where w.slug = 'paper' and m.user_id = '00000000-0000-0000-0000-0000000002a3'), 'owner', 'they become the owner');
select is((select role from public.members m join public.workspaces w on w.id = m.workspace_id
           where w.slug = 'paper' and m.user_id = '00000000-0000-0000-0000-0000000002a2'), 'editor', 'the previous owner becomes an editor');
select is((select count(*)::int from public.members m join public.workspaces w on w.id = m.workspace_id where w.slug = 'paper' and m.role = 'owner'), 1,
  'there is exactly one owner');
select pg_temp.act_as('00000000-0000-0000-0000-0000000002a2');
select lives_ok($$ select public.transfer_project_ownership((select id from public.workspaces where slug = 'paper'), auth.uid()) $$,
  'a team admin who is no longer owner can still move ownership (here, back to themselves)');
select throws_ok($$ select public.transfer_project_ownership((select id from public.workspaces where slug = 'paper'), '00000000-0000-0000-0000-0000000002a4') $$,
  'P0002', null, 'ownership cannot go to someone outside the team');
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000002a2');
select public.transfer_project_ownership((select id from public.workspaces where slug = 'paper'), '00000000-0000-0000-0000-0000000002a3');
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000002a3');
select throws_like($$ select public.remove_team_member((select id from t), auth.uid()) $$, '%still own paper%',
  'someone who owns a team project cannot leave until they transfer it');
reset role;
create temp table pw as select id from public.workspaces where slug = 'paper';  -- the team owner isn't on 'paper', so look it up here
grant select on pw to authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000002a1');
select throws_like($$ select public.remove_team_member((select id from t), '00000000-0000-0000-0000-0000000002a3') $$, '%transfer ownership first%',
  'nor can an owner remove them');
select lives_ok($$ select public.transfer_project_ownership((select id from pw), '00000000-0000-0000-0000-0000000002a2') $$,
  'a team owner who is not on the project can still move its ownership');
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000002a3');
select lives_ok($$ select public.remove_team_member((select id from t), auth.uid()) $$, 'after the transfer, the former owner can leave cleanly');
reset role;
select is((select count(*)::int from public.members m join public.workspaces w on w.id = m.workspace_id where w.slug = 'paper' and m.role = 'owner'), 1,
  'and the project still has its owner');

select * from finish();
rollback;
