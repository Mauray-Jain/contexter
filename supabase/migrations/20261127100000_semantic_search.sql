-- Semantic search: pgvector embeddings next to the existing full-text search.
--
-- Embeddings come from gte-small (384 dims), which Supabase Edge Functions run built in, so
-- there is no API key and no model call outside the project. They are filled lazily: the
-- `embed` Edge Function and the MCP server ask embedding_backlog() for what's missing or stale,
-- embed a few items within a time budget, and hand them to store_embeddings(). Anything not
-- embedded yet is still found by full-text search, so search never waits for a backlog.
--
-- No HNSW/IVFFlat index on purpose: every query filters to one workspace, which is small (a
-- team's units, records and turns), and an approximate index would filter *after* the nearest
-- neighbours are chosen, silently dropping matches. An exact scan per workspace is correct and
-- fast at this size. Revisit if one workspace grows past ~100k chunks.

create extension if not exists vector with schema extensions;

create table public.search_embeddings (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  source       text not null check (source in ('unit', 'record', 'event')),
  source_id    text not null,           -- units.id, records.id or events.id
  chunk        int  not null check (chunk >= 0),
  content_hash text not null,           -- md5 of the whole source text when it was embedded
  content      text not null,           -- this chunk's text (the snippet for meaning matches)
  embedding    extensions.vector(384) not null,
  created_at   timestamptz not null default now(),
  primary key (workspace_id, source, source_id, chunk)
);

alter table public.search_embeddings enable row level security;

-- Members read their workspace's embeddings (search runs as the caller). Nobody writes directly:
-- store_embeddings() checks membership and that the text still matches before it stores.
create policy search_embeddings_select on public.search_embeddings for select to authenticated
  using ((select private.is_member(workspace_id)));

-- The text each source is embedded from. One place, so the backlog, the store check and search
-- agree on it. Only prompts and replies among events: the rest are generated notices.
create function private.embedding_sources(p_workspace uuid)
returns table (source text, source_id text, body text)
language sql stable security invoker set search_path = ''
as $$
  select 'unit'::text, u.id::text, v.content
    from public.units u
    join public.unit_versions v on v.unit_id = u.id and v.version = u.current_version
   where u.workspace_id = p_workspace and u.current_version > 0 and btrim(v.content) <> ''
  union all
  select 'record', r.id::text, r.title || E'\n\n' || r.body
    from public.records r
   where r.workspace_id = p_workspace
  union all
  select 'event', e.id::text, btrim(coalesce(e.payload->>'text', '') || E'\n' || coalesce(e.payload->>'summary', ''))
    from public.events e
   where e.workspace_id = p_workspace and e.kind in ('prompt', 'reply')
     and btrim(coalesce(e.payload->>'text', '') || coalesce(e.payload->>'summary', '')) <> '';
$$;

-- What still needs embedding: sources with no embedding, or whose text changed since.
-- Newest first, so a fresh backlog makes recent work searchable soonest.
create function public.embedding_backlog(p_workspace uuid, p_limit int default 16)
returns table (source text, source_id text, body text, content_hash text, remaining bigint)
language sql stable security invoker set search_path = ''
as $$
  with pending as (
    select s.source, s.source_id, s.body, md5(s.body) as content_hash
      from private.embedding_sources(p_workspace) s
     where not exists (
       select 1 from public.search_embeddings x
        where x.workspace_id = p_workspace and x.source = s.source and x.source_id = s.source_id
          and x.chunk = 0 and x.content_hash = md5(s.body))
  )
  select p.source, p.source_id, p.body, p.content_hash, count(*) over ()
    from pending p
   order by case p.source when 'unit' then 0 when 'record' then 1 else 2 end,
            p.source_id desc
   limit least(greatest(p_limit, 1), 64);
$$;

-- Store one source's chunks, replacing what it had. p_chunks: [{chunk, content, embedding}].
-- Refused unless the caller is a member and p_hash is still the source's current text, so a
-- slow embedder can't overwrite a newer version with an old one.
create function public.store_embeddings(p_workspace uuid, p_source text, p_source_id text, p_hash text, p_chunks jsonb)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if not (select private.is_member(p_workspace)) then
    raise exception 'not a member of this workspace' using errcode = '42501';
  end if;
  if jsonb_typeof(p_chunks) <> 'array' or jsonb_array_length(p_chunks) = 0 or jsonb_array_length(p_chunks) > 64 then
    raise exception 'chunks must be a list of 1 to 64 items' using errcode = '22023';
  end if;
  if not exists (
    select 1 from private.embedding_sources(p_workspace) s
     where s.source = p_source and s.source_id = p_source_id and md5(s.body) = p_hash
  ) then
    return false; -- changed or gone since it was read; the next sweep picks up the new text
  end if;

  delete from public.search_embeddings
   where workspace_id = p_workspace and source = p_source and source_id = p_source_id;
  insert into public.search_embeddings (workspace_id, source, source_id, chunk, content_hash, content, embedding)
  select p_workspace, p_source, p_source_id, (c->>'chunk')::int, p_hash, c->>'content',
         (c->'embedding')::text::extensions.vector(384)
    from jsonb_array_elements(p_chunks) c;
  return true;
end;
$$;

-- Hybrid search: full-text and meaning, fused by reciprocal rank (k = 60). With no embedding
-- (older clients, or the embedder unavailable) it is exactly the old full-text search.
-- `match` says why a hit was returned: 'text', 'meaning' or 'both'.
drop function public.search_workspace(uuid, text, int);

create function public.search_workspace(
  p_workspace uuid, p_query text, p_limit int default 20,
  p_embedding extensions.vector(384) default null, p_min_similarity float default 0.8
)
returns table (kind text, ref text, title text, snippet text, rank real, created_at timestamptz, match text)
language sql stable security invoker set search_path = ''
as $$
  with q as (select websearch_to_tsquery('english', p_query) as tsq),
  fts as (
    select hits.*, row_number() over (order by hits.score desc, hits.created_at desc) as r
    from (
      select 'unit'::text as kind, u.collection || '/' || u.key as ref, v.summary as title,
             ts_headline('english', v.content, q.tsq, 'MaxWords=30, MinWords=10') as snippet,
             ts_rank(to_tsvector('english', v.content), q.tsq) as score, v.created_at
        from public.units u
        join public.unit_versions v on v.unit_id = u.id and v.version = u.current_version, q
       where u.workspace_id = p_workspace and to_tsvector('english', v.content) @@ q.tsq
      union all
      select 'record', upper(left(r.type, 1)) || '-' || lpad(r.number::text, 4, '0'), r.title,
             ts_headline('english', r.body, q.tsq, 'MaxWords=30, MinWords=10'),
             ts_rank(to_tsvector('english', r.title || ' ' || r.body), q.tsq), r.created_at
        from public.records r, q
       where r.workspace_id = p_workspace and to_tsvector('english', r.title || ' ' || r.body) @@ q.tsq
      union all
      select 'event', 'event/' || e.id, e.kind,
             ts_headline('english', coalesce(e.payload->>'text', '') || ' ' || coalesce(e.payload->>'summary', ''),
                         q.tsq, 'MaxWords=30, MinWords=10'),
             ts_rank(to_tsvector('english', coalesce(e.payload->>'text', '') || ' ' || coalesce(e.payload->>'summary', '')), q.tsq),
             e.created_at
        from public.events e, q
       where e.workspace_id = p_workspace
         and to_tsvector('english', coalesce(e.payload->>'text', '') || ' ' || coalesce(e.payload->>'summary', '')) @@ q.tsq
    ) hits
    order by hits.score desc
    limit 50
  ),
  -- The best chunk per source, then the sources ranked by it.
  nearest as (
    select distinct on (x.source, x.source_id)
           x.source, x.source_id, x.content, 1 - (x.embedding operator(extensions.<=>) p_embedding) as similarity
      from public.search_embeddings x
     where p_embedding is not null and x.workspace_id = p_workspace
     order by x.source, x.source_id, x.embedding operator(extensions.<=>) p_embedding
  ),
  vec as (
    select hits.*, row_number() over (order by hits.score desc) as r
    from (
      select 'unit'::text as kind, u.collection || '/' || u.key as ref, v.summary as title,
             n.content as snippet, n.similarity as score, v.created_at
        from nearest n
        join public.units u on n.source = 'unit' and u.id::text = n.source_id
        join public.unit_versions v on v.unit_id = u.id and v.version = u.current_version
      union all
      select 'record', upper(left(r.type, 1)) || '-' || lpad(r.number::text, 4, '0'), r.title,
             n.content, n.similarity, r.created_at
        from nearest n
        join public.records r on n.source = 'record' and r.id::text = n.source_id
      union all
      select 'event', 'event/' || e.id, e.kind, n.content, n.similarity, e.created_at
        from nearest n
        join public.events e on n.source = 'event' and e.id::text = n.source_id
    ) hits
    where hits.score >= p_min_similarity
    order by hits.score desc
    limit 50
  )
  select coalesce(f.kind, v.kind), coalesce(f.ref, v.ref), coalesce(f.title, v.title),
         coalesce(f.snippet, v.snippet),
         (coalesce(1.0 / (60 + f.r), 0) + coalesce(1.0 / (60 + v.r), 0))::real,
         coalesce(f.created_at, v.created_at),
         case when f.ref is not null and v.ref is not null then 'both'
              when f.ref is not null then 'text' else 'meaning' end
    from fts f
    full join vec v on v.kind = f.kind and v.ref = f.ref
   order by 5 desc, 6 desc
   limit p_limit;
$$;

revoke execute on function
  private.embedding_sources(uuid),
  public.embedding_backlog(uuid, int),
  public.store_embeddings(uuid, text, text, text, jsonb),
  public.search_workspace(uuid, text, int, extensions.vector, float)
  from public, anon;
grant execute on function
  private.embedding_sources(uuid),
  public.embedding_backlog(uuid, int),
  public.store_embeddings(uuid, text, text, text, jsonb),
  public.search_workspace(uuid, text, int, extensions.vector, float)
  to authenticated;
