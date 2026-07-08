# Supabase Production Notes

## chat_request_logs table

上线前请确认线上 Supabase 已执行 `infra/supabase/schema.sql` 中的 `chat_request_logs` 表结构。

如果线上日志出现下面提示，说明该表还没有建好，但不会影响正常聊天：

```text
[chat_request_logs] skipped: Could not find the table 'public.chat_request_logs' in the schema cache
```

可在 Supabase SQL Editor 单独执行下面补丁：

```sql
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
```

备注：当前本地只有 Supabase service role key，它可以读写数据，但不能通过 REST API 直接执行建表 DDL。建表需要在 Supabase SQL Editor 执行，或使用数据库直连串配合 `psql` / Supabase CLI 执行。
