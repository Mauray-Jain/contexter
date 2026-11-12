-- Access model + concurrency tests for the core schema. Run: npx supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(24);

-- Three people: alice (owner), bob (editor via invite), carol (viewer via invite), eve (outsider).
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'alice@test.local'),
  ('00000000-0000-0000-0000-00000000000b', 'bob@test.local'),
  ('00000000-0000-0000-0000-00000000000c', 'carol@test.local'),
  ('00000000-0000-0000-0000-00000000000e', 'eve@test.local');

create function pg_temp.act_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on function pg_temp.act_as(uuid) to authenticated, anon;

-- ── alice creates a workspace
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select lives_ok(
  $$ select public.create_workspace('paper', 'Retrieval paper', 'alice', 'research-paper') $$,
  'owner can create a workspace');
select is((select count(*)::int from public.workspaces), 1, 'owner sees their workspace');
select is((select role from public.members where handle = 'alice'), 'owner', 'creator is owner');

insert into public.invites (workspace_id, role, max_uses)
  select id, 'editor', 1 from public.workspaces where slug = 'paper';
insert into public.invites (workspace_id, role, code)
  select id, 'viewer', 'viewer-code' from public.workspaces where slug = 'paper';
select is((select count(*)::int from public.invites), 2, 'owner can create invites');

-- stash the editor code where other roles can't read it
create temp table codes as select code from public.invites where role = 'editor';
grant select on codes to authenticated;
reset role;

-- ── eve (outsider) sees nothing and can't join with a bad code
select pg_temp.act_as('00000000-0000-0000-0000-00000000000e');
select is((select count(*)::int from public.workspaces), 0, 'outsider sees no workspaces');
select is((select count(*)::int from public.members), 0, 'outsider sees no members');
select is((select count(*)::int from public.invites), 0, 'outsider cannot read invite codes');
select throws_ok($$ select public.join_workspace('nope', 'eve') $$, 'P0002', null, 'bad invite code is rejected');
reset role;

-- ── bob joins as editor, carol as viewer
select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
select lives_ok($$ select public.join_workspace((select code from codes), 'bob') $$, 'editor joins with invite');
select is((select count(*)::int from public.members), 2, 'new member sees the member list');
reset role;

select pg_temp.act_as('00000000-0000-0000-0000-00000000000e');
select throws_ok($$ select public.join_workspace((select code from codes), 'eve') $$, 'P0002', null,
  'single-use invite cannot be reused');
reset role;

select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select lives_ok($$ select public.join_workspace('viewer-code', 'carol') $$, 'viewer joins');
select throws_ok(
  $$ insert into public.units (workspace_id, collection, key)
     select id, 'sections', 'intro' from public.workspaces $$,
  '42501', null, 'viewer cannot create units');
reset role;

-- ── alice creates a unit and writes v1
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
insert into public.units (workspace_id, collection, key)
  select id, 'sections', 'method' from public.workspaces;
create temp table u as select id from public.units where key = 'method';
grant select on u to authenticated;
select is(public.write_unit((select id from u), 'v1 text', 0, 'first draft'), 1, 'write returns version 1');
select throws_ok($$ select public.write_unit((select id from u), 'x', 1, '  ') $$, '22023', null,
  'write without a summary is rejected');
reset role;

-- ── bob writes from a stale version → conflict; from current → ok
select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
select throws_ok($$ select public.write_unit((select id from u), 'stale', 0, 'stale write') $$, 'P0001', null,
  'stale expected_version is a conflict');
select is(public.write_unit((select id from u), 'v2 text', 1, 'tightened'), 2, 'write from current version works');
select is((select current_version from public.units where id = (select id from u)), 2,
  'direct column update of current_version is impossible, function updated it');
select throws_ok($$ update public.units set current_version = 99 $$, '42501', null,
  'members cannot update version/lock columns directly');

-- bob claims the unit
select lives_ok($$ select public.claim_unit((select id from u)) $$, 'editor can claim a free unit');
reset role;

-- ── alice is blocked by bob's lock unless she forces it
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select throws_ok($$ select public.write_unit((select id from u), 'mine', 2, 'overwrite') $$, 'P0001', null,
  'writing a unit locked by someone else fails');
select is((public.claim_unit((select id from u), null, interval '1 hour', true, 'bob is away')).lock_holder,
  '00000000-0000-0000-0000-00000000000a'::uuid, 'forced claim takes the lock');

-- ── feed: alice sees bob's events but not her own, and the cursor advances
select ok((select count(*) from public.pull_feed((select id from public.workspaces))) > 0,
  'pull_feed returns teammates'' events');
select is((select count(*)::int from public.pull_feed((select id from public.workspaces))), 0,
  'second pull returns nothing new (cursor advanced)');
reset role;

select * from finish();
rollback;
