-- PostgreSQL schema for the decoration Q&A Agent.
-- Run this file on the application PostgreSQL database.

create extension if not exists vector;

create table if not exists public.knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  source_file text unique not null,
  layer text,
  module text,
  raw_markdown text not null,
  content_hash text,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid references public.knowledge_documents(id) on delete cascade,
  title text,
  section text,
  content text not null,
  source_file text not null,
  layer text,
  module text,
  doc_type text,
  stage text,
  risk_level text,
  keywords text[] not null default '{}',
  chunk_index integer not null default 0,
  embedding vector(1536),
  created_at timestamptz not null default now()
);

create index if not exists knowledge_documents_source_file_idx
  on public.knowledge_documents(source_file);

create index if not exists knowledge_chunks_document_id_idx
  on public.knowledge_chunks(document_id);

create index if not exists knowledge_chunks_layer_idx
  on public.knowledge_chunks(layer);

create index if not exists knowledge_chunks_module_idx
  on public.knowledge_chunks(module);

create index if not exists knowledge_chunks_embedding_idx
  on public.knowledge_chunks
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

create table if not exists public.chat_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references public.chat_sessions(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  sources jsonb,
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_session_id_idx
  on public.chat_messages(session_id);

create table if not exists public.chat_request_logs (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references public.chat_sessions(id) on delete set null,
  user_message text not null,
  retrieval_question text,
  intent_labels text[] not null default '{}',
  detail_level text,
  force_layers text[] not null default '{}',
  retrieval_stats jsonb,
  sources jsonb,
  answer_preview text,
  answer_chars integer,
  status text not null default 'ok',
  error_message text,
  duration_ms integer,
  created_at timestamptz not null default now()
);

create index if not exists chat_request_logs_session_id_idx
  on public.chat_request_logs(session_id);

create index if not exists chat_request_logs_created_at_idx
  on public.chat_request_logs(created_at desc);

create or replace function public.match_knowledge_chunks(
  query_embedding vector(1536),
  match_count integer default 8,
  layer_filter text default null
)
returns table (
  id uuid,
  document_id uuid,
  title text,
  section text,
  content text,
  source_file text,
  layer text,
  module text,
  doc_type text,
  stage text,
  risk_level text,
  keywords text[],
  similarity double precision
)
language sql
stable
as $$
  select
    kc.id,
    kc.document_id,
    kc.title,
    kc.section,
    kc.content,
    kc.source_file,
    kc.layer,
    kc.module,
    kc.doc_type,
    kc.stage,
    kc.risk_level,
    kc.keywords,
    1 - (kc.embedding <=> query_embedding) as similarity
  from public.knowledge_chunks kc
  where kc.embedding is not null
    and (layer_filter is null or kc.layer = layer_filter)
  order by kc.embedding <=> query_embedding
  limit match_count;
$$;
