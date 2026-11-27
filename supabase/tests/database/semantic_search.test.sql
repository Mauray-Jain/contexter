-- Semantic search: the embedding backlog, the store_embeddings() guards, RLS on embeddings and
-- hybrid ranking. Vectors here are synthetic one-hot directions, so "similar" is exact.
begin;
create extension if not exists pgtap with schema extensions;
select plan(20);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'alice@vec.local'),
  ('00000000-0000-0000-0000-0000000000b1', 'bob@vec.local'),
  ('00000000-0000-0000-0000-0000000000e1', 'eve@vec.local');

create function pg_temp.act_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on function pg_temp.act_as(uuid) to authenticated, anon;

-- A unit vector along axis i (1-based), as JSON (for store) or as a vector (for search).
create function pg_temp.axis(i int) returns jsonb language sql as $$
  select jsonb_agg(case when n = i then 1 else 0 end order by n) from generate_series(1, 384) n
$$;
create function pg_temp.vaxis(i int) returns extensions.vector language sql as $$
  select (pg_temp.axis(i))::text::extensions.vector(384)
$$;
grant execute on function pg_temp.axis(int), pg_temp.vaxis(int) to authenticated;

-- ── alice's workspace with a unit, a record and a prompt; bob is a viewer
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select public.create_workspace('vec', 'Vectors', 'alice', 'blank');
create temp table ids as select id as ws from public.workspaces where slug = 'vec';
grant select on ids to authenticated;
insert into public.invites (workspace_id, role, code) select ws, 'viewer', 'vec-viewer' from ids;
insert into public.units (workspace_id, collection, key) select ws, 'sections', 'method' from ids;
select public.write_unit((select id from public.units where key = 'method'),
  'We rerank candidates with a cross-encoder.', 0, 'first draft');
select public.add_record((select ws from ids), 'decision', 'Drop BM25', 'It is redundant with the dense-only ablation.', '[]'::jsonb);
insert into public.events (workspace_id, kind, payload)
  select ws, 'prompt', '{"text": "how slow is the pipeline end to end?"}' from ids;
insert into public.events (workspace_id, kind, payload)
  select ws, 'status', '{"text": "a generated notice"}' from ids;
-- an empty outline unit has nothing to embed
insert into public.units (workspace_id, collection, key) select ws, 'sections', 'empty' from ids;

select is((select count(*)::int from public.embedding_backlog((select ws from ids), 64)), 3,
  'backlog: the written unit, the record and the prompt (not notices, not empty units)');
select is((select max(remaining)::int from public.embedding_backlog((select ws from ids), 1)), 3,
  'backlog reports how many are waiting beyond the page');
select is((select source from public.embedding_backlog((select ws from ids), 1)), 'unit', 'units come first');

create temp table b as select * from public.embedding_backlog((select ws from ids), 64);
grant select on b to authenticated;

-- ── storing
select is(public.store_embeddings((select ws from ids), 'unit', (select source_id from b where source = 'unit'),
  (select content_hash from b where source = 'unit'),
  jsonb_build_array(jsonb_build_object('chunk', 0, 'content', 'We rerank candidates', 'embedding', pg_temp.axis(1)))),
  true, 'a member stores a unit''s embedding');
select is(public.store_embeddings((select ws from ids), 'record', (select source_id from b where source = 'record'),
  (select content_hash from b where source = 'record'),
  jsonb_build_array(jsonb_build_object('chunk', 0, 'content', 'Drop BM25', 'embedding', pg_temp.axis(2)))),
  true, 'and a record''s');
select is(public.store_embeddings((select ws from ids), 'event', (select source_id from b where source = 'event'),
  'not-the-current-hash',
  jsonb_build_array(jsonb_build_object('chunk', 0, 'content', 'old text', 'embedding', pg_temp.axis(3)))),
  false, 'a stale hash is refused (the text changed since it was read)');
select throws_ok($$ select public.store_embeddings((select ws from ids), 'unit', 'x', 'h', '[]'::jsonb) $$,
  '22023', null, 'chunks must not be empty');
select throws_ok($$ select public.store_embeddings((select ws from ids), 'unit', 'x', 'h', '{}'::jsonb) $$,
  '22023', null, 'chunks must be a list');
select throws_ok($$ insert into public.search_embeddings (workspace_id, source, source_id, chunk, content_hash, content, embedding)
  select ws, 'unit', 'x', 0, 'h', 'c', pg_temp.vaxis(1) from ids $$,
  '42501', null, 'nobody writes embeddings directly');
select is((select count(*)::int from public.embedding_backlog((select ws from ids), 64)), 1,
  'stored sources leave the backlog');

-- ── a new version makes the unit stale, and storing for the new text replaces the old chunks
select public.write_unit((select id from public.units where key = 'method'),
  E'We rerank candidates with a cross-encoder.\n\nLatency is 40ms per query.', 1, 'latency');
select ok(exists(select 1 from public.embedding_backlog((select ws from ids), 64) where source = 'unit'),
  'a new unit version is back in the backlog');
select is(public.store_embeddings((select ws from ids), 'unit', (select source_id from b where source = 'unit'),
  (select content_hash from public.embedding_backlog((select ws from ids), 64) where source = 'unit'),
  jsonb_build_array(
    jsonb_build_object('chunk', 0, 'content', 'We rerank candidates', 'embedding', pg_temp.axis(1)),
    jsonb_build_object('chunk', 1, 'content', 'Latency is 40ms per query.', 'embedding', pg_temp.axis(4)))),
  true, 'the new text is stored');
select is((select count(*)::int from public.search_embeddings where source = 'unit'), 2, 'its chunks replace the old ones');

-- ── hybrid search
select is((select match from public.search_workspace((select ws from ids), 'cross-encoder', 10) where kind = 'unit'),
  'text', 'without an embedding, search is full-text as before');
select is((select ref from public.search_workspace((select ws from ids), 'speed', 10, pg_temp.vaxis(4))),
  'sections/method', 'a query with no matching words finds the unit by meaning');
select is((select snippet from public.search_workspace((select ws from ids), 'speed', 10, pg_temp.vaxis(4))),
  'Latency is 40ms per query.', 'the snippet is the closest chunk');
select is((select match from public.search_workspace((select ws from ids), 'BM25', 10, pg_temp.vaxis(2)) where kind = 'record'),
  'both', 'words and meaning together are marked both');
select is((select count(*)::int from public.search_workspace((select ws from ids), 'zebra', 10, pg_temp.vaxis(200))), 0,
  'nothing dissimilar is returned by meaning');

-- ── access
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select public.join_workspace('vec-viewer', 'bob');
select is((select ref from public.search_workspace((select id from public.workspaces where slug = 'vec'), 'speed', 10, pg_temp.vaxis(4))),
  'sections/method', 'a viewer searches by meaning too');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000e1');
select throws_ok($$ select public.store_embeddings((select ws from ids), 'unit', 'x', 'h',
  jsonb_build_array(jsonb_build_object('chunk', 0, 'content', 'c', 'embedding', pg_temp.axis(1)))) $$,
  '42501', null, 'outsiders can''t store embeddings');

select * from finish();
rollback;
