-- Access model + concurrency tests for the core schema. Run: npx supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(84);

-- Three people: alice (owner), bob (editor via invite), carol (viewer via invite), eve (outsider).
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'alice@pgtap.local'),
  ('00000000-0000-0000-0000-00000000000b', 'bob@pgtap.local'),
  ('00000000-0000-0000-0000-00000000000c', 'carol@pgtap.local'),
  ('00000000-0000-0000-0000-00000000000e', 'eve@pgtap.local');

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

select matches((select code from public.invites where role = 'editor'), '^[0-9a-f]{18}$',
  'invite codes are plain hex (never start with a dash)');

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


-- ── live collaboration (migration 2)
select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
create temp table sess as select (public.ensure_session((select id from public.workspaces), 'claude-code', 'bob code', 'claude-1')).id as id;
grant select on sess to authenticated;
select is((public.ensure_session((select id from public.workspaces), 'claude-code', null, 'claude-1')).id, (select id from sess),
  'same external id reuses the session');
select isnt((public.ensure_session((select id from public.workspaces), 'claude-chat')).id, (select id from sess),
  'chat gets its own session');
select is((public.ensure_session((select id from public.workspaces), 'claude-chat')).id,
          (select id from public.sessions where client = 'claude-chat' and user_id = '00000000-0000-0000-0000-00000000000b'),
  'chat session is reused within the window');
-- bob's lock was broken by alice; bob claims sections/intro-style unit via his code session, then ends it
insert into public.units (workspace_id, collection, key) select id, 'sections', 'results' from public.workspaces;
select lives_ok($$ select public.claim_unit((select id from public.units where key = 'results'), (select id from sess)) $$,
  'claim with a session');
select lives_ok($$ select public.end_session((select id from sess)) $$, 'end session');
select is((select lock_holder from public.units where key = 'results'), null, 'ending a session releases its locks');
-- feed across own sessions: bob's code-session events are visible to bob's chat session
insert into public.events (workspace_id, session_id, author_id, kind, payload)
  select id, (select id from sess), '00000000-0000-0000-0000-00000000000b', 'prompt', '{"text":"from code"}' from public.workspaces;
select ok(exists(select 1 from public.pull_feed((select id from public.workspaces), 100,
  (select id from public.sessions where client = 'claude-chat' and user_id = '00000000-0000-0000-0000-00000000000b'))
  where payload->>'text' = 'from code'), 'own events from another session show up in this session''s feed');
-- status trigger
update public.units set status = 'drafting' where key = 'results';
select ok(exists(select 1 from public.events where kind = 'status' and payload->>'to' = 'drafting'),
  'status changes are announced');
-- shared memory
select throws_ok($$ select public.compact_memory((select id from public.workspaces), 'too short', 1) $$, '22023', null,
  'tiny summaries are rejected');
select is((public.compact_memory((select id from public.workspaces), 'The team set up the paper and drafted the method section.', 5)).version,
  1, 'compaction creates memory v1');
select is((select covers_up_to_event from public.memory_status((select id from public.workspaces))), 5::bigint,
  'memory_status reports coverage');
-- search
select ok(exists(select 1 from public.search_workspace((select id from public.workspaces), 'text') where kind = 'unit'),
  'search finds unit content');
-- profiles: can't point the default at a workspace you're not in
select throws_ok($$ insert into public.profiles (active_workspace) values (gen_random_uuid()) $$, null, null,
  'default workspace must be one you belong to');
reset role;

-- ── work awareness: tasks, file activity, overlapping requests
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
create temp table asess as
  select (public.ensure_session((select id from public.workspaces), 'claude-code', 'alice code', 'alice-ext')).id;
grant select on asess to authenticated;
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
create temp table bsess as
  select (public.ensure_session((select id from public.workspaces), 'claude-code', 'bob code', 'bob-ext')).id;
grant select on bsess to authenticated;
select lives_ok($$ select public.start_task((select id from bsess), 'Rewrite the results table with the new reranker runs') $$,
  'members start tasks on their own session');
select throws_ok($$ select public.start_task((select id from asess), 'hijack') $$, 'P0002', null,
  'nobody can set the task of someone else''s session');
select is((select count(*)::int from public.touch_file((select id from bsess), 'tables/results.tex')), 0,
  'the first member on a file sees nobody else');
insert into public.events (workspace_id, session_id, kind, payload)
  select id, (select id from bsess), 'prompt', '{"text":"Rewrite the results table with the new reranker runs"}' from public.workspaces;
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select ok((select active from public.touch_file((select id from asess), 'tables/results.tex') limit 1),
  'a teammate mid-task on the same file is reported as active');
select ok(exists(select 1 from public.find_overlap((select id from public.workspaces),
  'update the results table using the reranker runs', (select id from asess)) where active),
  'an overlapping request finds the teammate''s live task');
select is((select count(*)::int from public.find_overlap((select id from public.workspaces),
  'draft the conclusion about future datasets', (select id from asess))), 0,
  'an unrelated request finds nothing');
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
select public.finish_task((select id from bsess));
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select ok(not (select active from public.touch_file((select id from asess), 'tables/results.tex') limit 1) is true,
  'a finished task is no longer active on the file');
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000e');
select throws_ok($$ select * from public.find_overlap((select id from public.workspaces limit 1), 'anything at all here') $$,
  null, null, 'outsiders can''t search for overlaps');
reset role;

-- bob: an interrupted request, a finished one, then an unrelated live task, all in one session
select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
create temp table bsess2 as
  select (public.ensure_session((select id from public.workspaces), 'claude-code', 'bob code 2', 'bob-ext2')).id;
grant select on bsess2 to authenticated;
select public.start_task((select id from bsess2), 'Plot the latency histogram for the reranker');
insert into public.events (workspace_id, session_id, kind, payload)
  select id, (select id from bsess2), 'prompt', '{"text":"Plot the latency histogram for the reranker"}' from public.workspaces;
select public.start_task((select id from bsess2), 'Summarize the related work on dense retrieval');
insert into public.events (workspace_id, session_id, kind, payload)
  select id, (select id from bsess2), 'prompt', '{"text":"Summarize the related work on dense retrieval"}' from public.workspaces;
insert into public.events (workspace_id, session_id, kind, payload)
  select id, (select id from bsess2), 'reply', '{"summary":"Wrote up the prior literature section."}' from public.workspaces;
select public.finish_task((select id from bsess2));
select public.start_task((select id from bsess2), 'Fix typos in the abstract wording');
insert into public.events (workspace_id, session_id, kind, payload)
  select id, (select id from bsess2), 'prompt', '{"text":"Fix typos in the abstract wording"}' from public.workspaces;
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
create temp table hist as
  select * from public.find_overlap((select id from public.workspaces), 'plot a latency histogram of the reranker', (select id from asess))
   where kind = 'prompt';
create temp table hist2 as
  select * from public.find_overlap((select id from public.workspaces), 'summarize related work about dense retrieval', (select id from asess))
   where kind = 'prompt';
select is((select outcome from hist), null, 'an interrupted request doesn''t borrow a later turn''s outcome');
select is((select active from hist), false, 'an old request isn''t "still being worked on" because its session has a new task');
select is((select outcome from hist2), 'Wrote up the prior literature section.', 'a finished request shows its own outcome');
select is((select count(*)::int from public.find_overlap((select id from public.workspaces), 'fix the typos in abstract wording', (select id from asess))
            where active), 1, 'the current task matches as live, once per session');
reset role;

-- one session with many matches can't crowd out another session's match
select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
insert into public.events (workspace_id, session_id, kind, payload)
  select w.id, (select id from bsess2), 'prompt', jsonb_build_object('text', 'Tune the batch size of the indexing job, attempt ' || g)
    from public.workspaces w, generate_series(1, 6) g;
-- a public prompt that was interrupted, then a private turn in the same session
select public.start_task((select id from bsess), 'Benchmark the indexing job memory usage');
insert into public.events (workspace_id, session_id, kind, payload)
  select id, (select id from bsess), 'prompt', '{"text":"Benchmark the indexing job memory usage"}' from public.workspaces;
select public.start_task((select id from bsess), null);
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select is((select count(distinct session_id)::int from public.find_overlap((select id from public.workspaces),
  'tune the indexing job batch size and memory usage', (select id from asess))), 2,
  'each matching session gets a result, however many matches one session has');
select is((select active from public.find_overlap((select id from public.workspaces),
  'benchmark memory usage of the indexing job', (select id from asess)) where session_id = (select id from bsess)), false,
  'an interrupted public prompt isn''t "still being worked on" during a later private turn');
reset role;

-- chat tasks end on their own after 10 quiet minutes; Claude Code tasks after an hour
update public.sessions set client = 'claude-chat', last_seen_at = now() - interval '11 minutes' where id = (select id from bsess2);
select ok(not private.task_is_live((select s from public.sessions s where id = (select id from bsess2))),
  'a chat task with no activity for 10 minutes is no longer live');
update public.sessions set client = 'claude-code' where id = (select id from bsess2);
select ok(private.task_is_live((select s from public.sessions s where id = (select id from bsess2))),
  'a Claude Code task stays live for up to an hour');

-- ── runs: writers start them, watchers hear when they end, outsiders see nothing
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select throws_ok($$ select public.start_run((select id from public.workspaces), 'carol job') $$,
  '42501', null, 'viewers cannot start runs');
reset role;

select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
create temp table run1 as
  select * from public.start_run((select id from public.workspaces), 'stress test', 'watermax', './stress.sh',
                                 null, array['alice'], 'wrapper');
select is((select number from run1), 1, 'runs are numbered per workspace');
select is((select mentions from public.events where kind = 'run' and payload->>'action' = 'started'),
  array['alice'], 'starting a run mentions its watchers');
select throws_ok($$ select public.start_run((select id from public.workspaces), 'x', null, null, null, array['nobody']) $$,
  'P0002', null, 'unknown watcher handles are rejected');
select public.update_run((select id from run1), null, 'step 10/100', 'line 1\nstep 10/100');
select is((select count(*)::int from public.events where kind = 'run'), 1, 'a heartbeat posts nothing to the feed');
select is((select progress from public.runs where id = (select id from run1)), 'step 10/100', 'a heartbeat stores progress');
select public.update_run((select id from run1), 'failed', 'Killed', null, 137);
select public.update_run((select id from run1), 'succeeded', 'done', 'all good', 0);
select is((select count(*)::int from public.events where kind = 'run' and payload->>'action' = 'finished'), 1,
  'the end of a run is announced once');
select is((select status || ' ' || exit_code from public.runs where id = (select id from run1)), 'failed 137',
  'a finished run keeps its first final status');
select is((select progress from public.runs where id = (select id from run1)), 'Killed',
  'a later report of an end changes nothing, details included');
select is((select mentions from public.events where kind = 'run' and payload->>'action' = 'finished'),
  array['alice'], 'the end of a run mentions its watchers');
select public.watch_run((select id from run1), array['carol']);
select is((select mentions from public.events where kind = 'run' and payload->>'action' = 'shared'),
  array['carol'], 'sharing a run mentions the new watcher');
reset role;

select pg_temp.act_as('00000000-0000-0000-0000-00000000000e');
select is((select count(*)::int from public.runs), 0, 'outsiders see no runs');
select is((select count(*)::int from public.run_watchers), 0, 'outsiders see no run watchers');
reset role;

-- ── handoffs: the recipient watches the sender's running jobs at once and takes their locks on accepting
select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
create temp table run2 as select * from public.start_run((select id from public.workspaces), 'training', 'watermax');
select public.claim_unit((select id from public.units where key = 'results'));
create temp table h1 as
  select * from public.create_handoff((select id from public.workspaces), 'alice', 'Finish the results',
                                      'Stress test is running; results section half done.', 'Check run 2, then write it up.',
                                      array['sections/results']);
select throws_ok($$ select public.create_handoff((select id from public.workspaces), 'bob', 'x', 'yyy') $$,
  '22023', null, 'you cannot hand off to yourself');
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select ok(exists (select 1 from public.run_watchers where run_id = (select id from run2)
                   and user_id = '00000000-0000-0000-0000-00000000000a'),
  'the recipient watches the sender''s running runs as soon as it''s handed off');
select is((select mentions from public.events where kind = 'handoff' and payload->>'action' = 'created'),
  array['alice'], 'a handoff mentions its recipient');
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
select throws_ok($$ select public.resolve_handoff((select id from h1), 'accepted') $$,
  null, null, 'someone else cannot take a handoff addressed to a teammate');
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select is((public.resolve_handoff((select id from h1), 'accepted')).status, 'accepted', 'the recipient accepts');
select is((select lock_holder from public.units where key = 'results'), '00000000-0000-0000-0000-00000000000a'::uuid,
  'accepting moves the sender''s unit locks to the recipient');
select is((select mentions from public.events where kind = 'handoff' and payload->>'action' = 'accepted'),
  array['bob'], 'accepting tells the sender');
select throws_ok($$ select public.resolve_handoff((select id from h1), 'declined') $$,
  'P0001', null, 'a resolved handoff cannot be resolved again');
reset role;

-- ── Modal jobs: a handoff moves the watching of the sender's Modal jobs to the recipient
select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
create temp table run3 as select * from public.start_run((select id from public.workspaces), 'detached sweep', 'Modal');
select is((public.set_run_modal((select id from run3), 'ap-Abc123', 'venice67')).external->'modal',
  '{"app_id": "ap-Abc123", "profile": "venice67"}'::jsonb, 'a run records its Modal app id and profile name');
select throws_ok($$ select public.set_run_modal((select id from run3), 'not-an-app') $$,
  '22023', null, 'anything but a Modal app id is rejected');
select throws_ok($$ select public.set_run_modal((select id from run3), 'ap-Abc123', 'tok token=secret') $$,
  '22023', null, 'a profile must be a plain profile name');
create temp table h2 as
  select * from public.create_handoff((select id from public.workspaces), 'alice', 'Watch the sweep', 'Sweep runs detached on Modal.');
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select public.resolve_handoff((select id from h2), 'accepted');
select is((select reporter || ' ' || watcher_user from public.runs where id = (select id from run3)),
  'modal 00000000-0000-0000-0000-00000000000a', 'accepting moves the sender''s Modal job to the recipient''s watcher');
select is((select watcher_user from public.runs where id = (select id from run2)), null,
  'jobs without a Modal app aren''t given a watcher');
select ok(public.report_run_watch((select id from run3)), 'the watcher checks in');
select ok((select watched_at is not null from public.runs where id = (select id from run3)), 'a check-in is recorded');
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
select ok(not public.report_run_watch((select id from run3)), 'the previous watcher is told the job isn''t theirs any more');
select throws_ok($$ update public.runs set watcher_user = auth.uid() $$, '42501', null,
  'nobody can grab the watching of a job directly');
reset role;

select * from finish();
rollback;
