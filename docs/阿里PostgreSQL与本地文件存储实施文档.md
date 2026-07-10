# 阿里 PostgreSQL 与本地文件存储实施文档

## 1. 当前目标

本项目已经从原来的托管数据库/对象存储方案，调整为：

```text
Next.js 应用
  -> 阿里服务器 PostgreSQL
  -> PostgreSQL pgvector 做知识库向量检索
  -> 应用本地文件目录保存户型图和效果图
  -> DashScope 负责文本 embedding、聊天模型、户型解析、生图
```

这次调整的核心目标是把主要数据和运行链路收回到阿里服务器，减少外部平台依赖，让本地开发、服务器部署、数据库排查、后续迁移到前后端分离都更清楚。

## 2. 为什么这样做

### 2.1 数据库统一

知识库、聊天记录、效果图任务、户型图解析结果、效果图结果都放到同一个 PostgreSQL 数据库里。

这样做的原因：

- 后端只需要维护一个 `DATABASE_URL`。
- DBeaver 可以直接查看所有业务表。
- 知识库检索使用 `pgvector`，和 PostgreSQL 天然匹配。
- 聊天、知识库、效果图之间后续可以做联合查询和数据追踪。
- 部署到阿里服务器后，应用访问数据库可以走 `127.0.0.1`，减少公网数据库暴露。

### 2.2 文件存储本地化

户型图和生成后的效果图不再上传外部对象存储，而是保存到：

```text
apps/web/public/uploads/design-assets/
```

浏览器访问路径是：

```text
/uploads/design-assets/...
```

这样做的原因：

- 本地开发不需要额外配置对象存储。
- 上传和展示链路更短，方便排查图片加载失败。
- 生成图结果和数据库记录都在当前项目可控范围内。

注意：如果后续文件量变大，或者需要 CDN、权限隔离、长期归档，再单独迁移到阿里 OSS 会更合适。

## 3. 当前数据库

数据库连接变量：

```env
DATABASE_URL=postgres://snt_zxzsk:你的密码@127.0.0.1:5432/snt_zxzsk
```

本地连接阿里服务器时使用：

```env
DATABASE_URL=postgres://snt_zxzsk:你的密码@8.141.116.16:5432/snt_zxzsk
```

服务器部署时使用：

```env
DATABASE_URL=postgres://snt_zxzsk:你的密码@127.0.0.1:5432/snt_zxzsk
```

原因是线上应用和 PostgreSQL 在同一台服务器上，走本机地址即可。

## 4. 数据表说明

### 4.1 知识库表

```text
knowledge_documents
```

作用：保存每一篇 Markdown 知识文档的元信息和原文。

主要字段：

- `title`：文档标题。
- `source_file`：本地知识库文件路径。
- `layer`：知识库层级。
- `module`：所属模块。
- `raw_markdown`：原始 Markdown 内容。
- `content_hash`：内容哈希，用于判断文档是否变化。

```text
knowledge_chunks
```

作用：保存文档切分后的知识片段，并保存向量 embedding。

主要字段：

- `document_id`：关联 `knowledge_documents`。
- `content`：可被检索的知识片段正文。
- `source_file`：来源文件。
- `chunk_index`：片段顺序。
- `embedding`：`vector(1536)`，用于语义检索。

```text
match_knowledge_chunks(...)
```

作用：根据用户问题的 query embedding，在 `knowledge_chunks` 中召回相关片段。

### 4.2 聊天表

```text
chat_sessions
```

作用：保存左侧会话列表。

```text
chat_messages
```

作用：保存用户问题、AI 回复、引用来源。

```text
chat_request_logs
```

作用：保存每次问答请求的过程日志，包括检索结果、意图识别、错误信息、耗时等。

### 4.3 效果图表

```text
design_projects
```

作用：效果图项目主表。一套户型图和生成任务都挂在一个 project 下。

```text
design_floor_plans
```

作用：保存上传的户型图文件信息和户型解析结果。

主要字段：

- `file_url`：前端可访问的户型图 URL。
- `storage_path`：应用本地文件存储路径。
- `analysis_status`：解析状态。
- `house_type`：户型摘要。
- `area`：面积。
- `spaces`：识别出的空间列表。
- `circulation`：动线描述。
- `analysis_result`：完整解析 JSON。

```text
design_generation_jobs
```

作用：保存效果图生成任务。

主要字段：

- `status`：任务状态。
- `progress`：任务进度。
- `prompt`：最终生图 prompt。
- `provider`：模型提供方。
- `model`：生图模型。
- `response_payload`：模型结果和可生成空间信息。

```text
design_renders
```

作用：保存生成后的效果图。

主要字段：

- `space_name`：全屋、客厅、主卧等。
- `view_name`：全屋效果图、客厅效果图等。
- `image_url`：前端展示地址。
- `thumbnail_url`：缩略图地址。
- `storage_path`：本地文件存储路径。
- `sort_order`：展示排序。
- `metadata`：模型任务 ID、prompt focus、空间类型等。

## 5. 已完成的代码调整

### 5.1 数据库连接

新增：

```text
apps/web/src/lib/db/postgres.ts
```

作用：

- 统一读取 `DATABASE_URL`。
- 创建 PostgreSQL 连接。
- 提供向量字面量转换工具。

### 5.2 知识库和聊天模块

以下 API 已使用 PostgreSQL：

```text
/api/chat
/api/chat/sessions
/api/chat/sessions/[id]
/api/chat/sessions/[id]/messages
/api/health/knowledge
```

知识库检索代码：

```text
apps/web/src/lib/ai/retrieval.ts
```

现在直接调用 PostgreSQL 函数 `match_knowledge_chunks(...)`。

### 5.3 知识库导入脚本

新增：

```text
scripts/ingest_knowledge_postgres.mjs
scripts/generate_embeddings_postgres.mjs
```

作用：

- `ingest_knowledge_postgres.mjs`：读取 `knowledge/` 下的 Markdown，写入 `knowledge_documents` 和 `knowledge_chunks`。
- `generate_embeddings_postgres.mjs`：读取 embedding 为空的 chunks，调用 DashScope 生成向量并写回 PostgreSQL。

旧的外部平台 REST 版脚本已经删除，避免误跑到旧库。

### 5.4 效果图模块

新增：

```text
apps/web/src/lib/storage/design-assets.ts
```

作用：

- 保存上传户型图。
- 保存生成后的效果图。
- 返回前端可访问的 `/uploads/design-assets/...` 路径。

以下 API 已改为 PostgreSQL + 本地文件存储：

```text
/api/design/floor-plan
/api/design/floor-plan/[id]/analyze
/api/design/jobs
/api/design/jobs/[id]
/api/design/jobs/[id]/spaces
```

## 6. 知识库重跑流程

### 6.1 导入 Markdown

```bash
cd /Users/liguopeng/Desktop/Project/snt-zxzsk
node scripts/ingest_knowledge_postgres.mjs
```

当前导入结果：

```text
knowledge_documents: 190
knowledge_chunks: 3649
```

### 6.2 生成 embedding

建议分批执行：

```bash
node scripts/generate_embeddings_postgres.mjs --limit 200 --batch-size 10
```

重复执行，直到：

```text
Chunks missing embedding after run: 0
```

当前结果：

```text
embeddedChunksCount: 3649
missingEmbeddingCount: 0
embeddingReady: true
```

### 6.3 健康检查

```bash
curl http://127.0.0.1:3000/api/health/knowledge
```

期望结果：

```json
{
  "ok": true,
  "embeddingReady": true,
  "documentsCount": 190,
  "chunksCount": 3649,
  "embeddedChunksCount": 3649,
  "missingEmbeddingCount": 0
}
```

## 7. 效果图流程

### 7.1 上传户型图

前端提交文件到：

```text
POST /api/design/floor-plan
```

后端执行：

```text
创建 design_projects
保存文件到 public/uploads/design-assets/floor-plans
创建 design_floor_plans
返回 project 和 floorPlan
```

### 7.2 解析户型图

前端调用：

```text
POST /api/design/floor-plan/[id]/analyze
```

后端执行：

```text
读取 design_floor_plans
调用 DashScope 解析户型图
回填 house_type、area、spaces、circulation、analysis_result
更新 project 状态为 ready
```

### 7.3 生成全屋效果图

前端调用：

```text
POST /api/design/jobs
```

后端执行：

```text
读取户型解析结果
生成全屋 prompt
创建 design_generation_jobs
调用 DashScope 生图
保存图片到 public/uploads/design-assets/renders
写入 design_renders
更新 job/project 状态
```

### 7.4 生成单空间效果图

前端调用：

```text
POST /api/design/jobs/[id]/spaces
```

后端执行：

```text
读取 job、project、floorPlan
根据 spaceName 构造空间 prompt
调用 DashScope 生图
保存图片
写入 design_renders
返回 render
```

## 8. 本地启动流程

```bash
cd /Users/liguopeng/Desktop/Project/snt-zxzsk/apps/web
pnpm dev
```

访问：

```text
http://localhost:3000
```

## 9. 线上部署流程

### 9.1 拉代码

```bash
cd /www/snt-zxzsk
git pull
```

### 9.2 安装依赖

```bash
cd /www/snt-zxzsk/apps/web
pnpm install
```

### 9.3 配置环境变量

服务器 `.env.local` 至少需要：

```env
DATABASE_URL=postgres://snt_zxzsk:你的密码@127.0.0.1:5432/snt_zxzsk
DASHSCOPE_API_KEY=你的千问Key
EMBEDDING_PROVIDER=dashscope
EMBEDDING_MODEL=text-embedding-v4
EMBEDDING_DIMENSION=1536
DASHSCOPE_EMBEDDINGS_URL=https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding
CHAT_MODEL=qwen-plus
DASHSCOPE_CHAT_COMPLETIONS_URL=https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
```

### 9.4 执行数据库结构

首次部署或新库部署时执行：

```bash
psql "$DATABASE_URL" -f infra/postgres/schema.sql
psql "$DATABASE_URL" -f infra/postgres/design-render-schema.sql
```

### 9.5 构建

```bash
pnpm build
```

### 9.6 重启

```bash
pm2 restart snt-zxzsk-web --update-env
```

## 10. 验证清单

### 10.1 数据库连接

```bash
curl http://127.0.0.1:3000/api/health/knowledge
```

### 10.2 知识库咨询

页面里提问：

```text
水电增项 8000 是不是被坑了？
```

预期：

```text
能返回回答
能生成 sources
chat_sessions 有会话
chat_messages 有消息
chat_request_logs 有日志
```

### 10.3 效果图

预期：

```text
户型图可上传
上传后进入解析中
解析完成回填户型、面积、空间、动线
全屋效果图生成后能展示
单空间效果图能按空间生成
图片 URL 为 /uploads/design-assets/...
```

## 11. 后续注意事项

1. 当前文件存储是应用本地目录，部署时要确保 `apps/web/public/uploads` 可写。
2. 如果以后多机部署，需要把文件存储迁到共享存储或阿里 OSS。
3. 生产环境不建议长期开放 PostgreSQL 5432 到 `0.0.0.0/0`。
4. 本地开发可临时把当前公网 IP 加入 `pg_hba.conf` 和阿里安全组。
5. 如果公网 IP 变化，DBeaver 或本地接口可能报 `no pg_hba.conf entry`，需要重新加白名单。
6. 如果报 `password authentication failed`，说明 PostgreSQL 内部用户密码和环境变量不一致。
7. 如果报 `CONNECT_TIMEOUT`，优先检查阿里安全组、宝塔防火墙、PostgreSQL `listen_addresses`。

## 12. 运行检测与修复记录

### 12.1 户型解析失败：DashScope URL 参数无效

现象：

```text
POST /api/design/floor-plan/[id]/analyze
DashScope request failed: 400 InternalError.Algo.InvalidParameter
The provided URL does not appear to be valid.
```

原因：

```text
户型图上传后保存在本地 public/uploads/design-assets。
前端可以通过 /uploads/design-assets/... 加载图片。
但 DashScope 运行在云端，无法访问本机相对路径 /uploads/...。
所以把相对 URL 直接传给视觉模型会被判定为无效 URL。
```

修复：

```text
解析接口不再直接把 file_url 传给 DashScope。
后端根据 design_floor_plans.storage_path 读取本地图片文件。
读取后转成 data:image/...;base64,... 再传给 DashScope 视觉模型。
```

涉及代码：

```text
apps/web/src/lib/storage/design-assets.ts
apps/web/src/app/api/design/floor-plan/[id]/analyze/route.ts
apps/web/src/lib/ai/dashscope.ts
```

补充处理：

```text
如果模型把提示词里的“无法确认则为 null”占位文字原样返回，
后端会归一化为 null，避免前端展示假结果。
```

验证结果：

```text
pnpm lint 通过
pnpm build 通过
重新调用 /api/design/floor-plan/[id]/analyze 成功
analysis_status = completed
已能返回 house_type、spaces、circulation、orientation 等结构化字段
```
