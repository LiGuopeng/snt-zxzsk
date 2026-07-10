# 阿里 PostgreSQL 迁移记录

## 2026-07-10 知识库/聊天模块接入阿里 PostgreSQL

### 本次范围

- 只迁移知识库咨询相关链路。
- 暂不迁移效果图生成模块、Supabase Storage、设计图相关表。
- 保留 Supabase SDK，继续服务尚未迁移的效果图模块。

### 已完成的数据库准备

- 在宝塔 PostgreSQL 中使用数据库 `snt_zxzsk`。
- 已启用 `vector` 扩展。
- 已确认 `gen_random_uuid()` 可用。
- 已执行 `infra/supabase/schema.sql`，创建知识库/聊天相关结构：
  - `knowledge_documents`：知识库文档主表，记录上传/导入的装修知识文档、分类、来源、处理状态等元信息。
  - `knowledge_chunks`：知识库切片表，记录文档拆分后的知识片段、向量 embedding、标签、阶段、风险级别，用于 RAG 检索。
  - `chat_sessions`：聊天会话表，记录用户每一次知识库咨询会话，支撑左侧历史会话列表。
  - `chat_messages`：聊天消息表，记录会话内用户问题、AI 回复、引用知识片段、模型和耗时等消息数据。
  - `chat_request_logs`：聊天请求日志表，记录每次问答请求的输入输出、检索命中、错误信息和性能数据，便于排查问题。
  - `match_knowledge_chunks(...)`：知识库向量检索函数。
- 已给应用用户 `snt_zxzsk` 授权读写表、使用序列、执行函数。
- 已给表和函数补充数据库备注。

### 已完成的代码改造

- 新增 `apps/web/src/lib/db/postgres.ts`，统一管理 `DATABASE_URL` 和 PostgreSQL 连接。
- 新增 npm 依赖 `postgres`。
- `/api/chat` 已改为使用 PostgreSQL 创建会话、写入消息、读取最近上下文、更新会话标题。
- `/api/chat/sessions` 已改为使用 PostgreSQL 读取/创建左侧会话。
- `/api/chat/sessions/[id]/messages` 已改为使用 PostgreSQL 读取会话消息。
- `/api/chat/sessions/[id]` 已改为使用 PostgreSQL 删除会话和消息。
- 知识库向量检索已改为直连 PostgreSQL 调用 `match_knowledge_chunks(...)`。
- 关键词兜底检索已改为 PostgreSQL 参数化查询。
- `chat_request_logs` 已改为写入 PostgreSQL。
- `/api/health/knowledge` 已改为检查 PostgreSQL 知识库表。
- `/api/health/supabase` 暂时保留路径，但返回 PostgreSQL 连接检查结果，避免旧调用断掉。

### 部署时必须配置

在阿里服务器的应用环境变量中配置：

```bash
DATABASE_URL=postgres://snt_zxzsk:你的密码@127.0.0.1:5432/snt_zxzsk
```

### 验证结果

- `npm run lint` 通过。
- `npm run build` 通过。
- 本地 Node 20 会出现 Supabase SDK 的 Node 版本警告；项目要求 Node >= 22，服务器部署应使用 Node 22。

### 下一步

- 在阿里服务器上配置 `DATABASE_URL`。
- 拉取最新代码并重新安装依赖。
- 重新构建并重启 PM2。
- 测试 `/api/health/knowledge`、左侧会话、新建对话、发送问题、删除对话。
- 后续再单独迁移效果图模块和文件存储。
