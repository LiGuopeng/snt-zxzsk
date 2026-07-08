# 装修问答 Agent 上线实施备注

本文用于记录本项目从 Markdown 知识库到可上线装修问答 Agent 的实施路线。

## 目标

做一个用户可以在线随便输入装修问题的 AI Agent。

第一版重点：

1. 用户能在网页输入装修问题。
2. 系统能从现有 Markdown 知识库召回相关内容。
3. 回答要包含结论、判断依据、检查清单、下一步动作和风险提醒。
4. 高风险、合同、维权、安全类问题不能乱下结论。
5. 回答可追溯到知识来源。

第一版暂不做：

1. 户型图识别。
2. 装修报价自动算价。
3. 商家推荐。
4. 复杂后台 CMS。
5. 多 Agent 协作。

## 推荐技术栈

MVP 阶段：

```text
前端和产品接口：Next.js
知识处理：Python scripts
数据库：Supabase PostgreSQL
向量检索：Supabase pgvector
大模型：OpenAI 或 DeepSeek
Embedding：OpenAI text-embedding-3-small 或 bge-m3
部署：Vercel
知识源：Git + Markdown
```

正式阶段：

```text
前端产品层：Next.js
AI 服务层：Python FastAPI
知识处理层：Python scripts
数据库：PostgreSQL
向量检索：pgvector，后期可升级 Qdrant / Milvus
缓存和队列：Redis
对象存储：S3 / R2 / 阿里云 OSS
部署：Vercel + 云服务器
CI/CD：GitHub Actions
```

## 职责分工

### Next.js

负责用户能看到和使用的产品部分：

1. 聊天页面。
2. 用户输入框。
3. 聊天历史。
4. 登录注册。
5. 会员或付费。
6. 管理后台。
7. 调用后端 AI 问答接口。

### Python

负责知识库和 AI 处理：

1. 扫描 Markdown 文件。
2. 清洗文本。
3. 按标题和段落切 chunk。
4. 生成 embedding。
5. 写入 PostgreSQL / pgvector。
6. 批量测试问答质量。
7. 后期升级为 FastAPI AI 服务。

### PostgreSQL + pgvector

负责存储：

1. Markdown 原文。
2. 知识 chunk。
3. embedding 向量。
4. 用户信息。
5. 聊天记录。
6. 召回记录。
7. 测试集和评测结果。

### Markdown + Git

负责知识源管理：

1. Markdown 原文件放在 Git 仓库。
2. 数据库存解析后的文档和 chunk。
3. Git 用于版本管理、回滚和审核。
4. 数据库用于线上检索和回答。

## 推荐项目结构

```text
ai-decoration-agent
├── apps
│   └── web
│       ├── app
│       ├── components
│       └── lib
│
├── services
│   └── ai
│       ├── app
│       ├── retriever
│       ├── prompts
│       └── rules
│
├── scripts
│   ├── ingest_markdown.py
│   ├── chunk_markdown.py
│   ├── generate_embeddings.py
│   └── eval_answers.py
│
├── knowledge
│   ├── 00_知识库总控
│   ├── 01_标准知识库
│   ├── 02_民间装修知识库
│   ├── 03_装修决策案例库
│   ├── 04_AI问答模板库
│   └── 05_知识规则与风险控制
│
├── infra
│   ├── supabase
│   └── docker
│
└── docs
```

当前仓库已经有 `00_知识库总控` 到 `05_知识规则与风险控制`，后续可以迁移到 `knowledge/`，也可以先保持现状，入库脚本直接扫描当前目录。

## 知识库组装方式

Markdown 原文件不直接作为主要检索对象。

正确链路：

```text
Markdown 文件
  ↓
按标题和段落切片
  ↓
生成 chunk metadata
  ↓
生成 embedding
  ↓
写入 knowledge_documents 和 knowledge_chunks
  ↓
线上问答时检索 chunks
```

建议：

```text
01_标准知识库：全部切片入库，作为专业依据。
02_民间装修知识库：全部切片入库，但回答时必须用标准库和规则库校正。
03_装修决策案例库：全部切片入库，重点用于场景判断。
04_AI问答模板库：不主要做向量检索，按意图调用。
05_知识规则与风险控制：不只靠向量检索，高风险场景要强制召回。
```

## 数据库核心表

### knowledge_documents

存 Markdown 原文级别的信息。

```sql
create table knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  source_file text unique not null,
  layer text,
  module text,
  raw_markdown text not null,
  content_hash text,
  version int default 1,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);
```

### knowledge_chunks

存可检索的知识片段。

```sql
create table knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid references knowledge_documents(id) on delete cascade,
  title text,
  section text,
  content text not null,
  source_file text not null,
  layer text,
  module text,
  doc_type text,
  stage text,
  risk_level text,
  keywords text[],
  chunk_index int,
  embedding vector(1536),
  created_at timestamp with time zone default now()
);
```

### chat_sessions

存用户会话。

```sql
create table chat_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  title text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);
```

### chat_messages

存聊天消息。

```sql
create table chat_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references chat_sessions(id) on delete cascade,
  role text not null,
  content text not null,
  sources jsonb,
  created_at timestamp with time zone default now()
);
```

## 问答链路

```text
用户输入问题
  ↓
识别问题类型和风险等级
  ↓
向量检索 01/02/03 知识 chunk
  ↓
按意图强制召回 04 模板和 05 规则
  ↓
拼接 Prompt
  ↓
调用大模型
  ↓
做安全边界检查
  ↓
返回答案和来源
```

## 第一阶段操作顺序

1. 创建 Next.js 项目。
2. 创建 Supabase 项目。
3. 启用 pgvector。
4. 建数据库表。
5. 写 Python 入库脚本。
6. 把当前 Markdown 导入数据库。
7. 写 `/api/chat`。
8. 写聊天页面。
9. 准备 50 条测试问题。
10. 部署到 Vercel。

## 逐步操作手册

本章节用于记录每一步怎么操作、在哪里操作、如何验证。

### Step 1：检查本机环境

操作目录：

```bash
cd /Users/liguopeng/Desktop/Project/ai-decoration-a-gen-t
```

执行命令：

```bash
node -v
npm -v
python3 --version
git status --short
```

当前结果：

```text
Node.js：v20.10.0
npm：10.2.3
Python：3.9.6
```

说明：

1. Node.js 用于运行 Next.js。
2. npm 用于安装前端依赖。
3. Python 用于后续扫描 Markdown、切 chunk、入库和评测。
4. Node.js 当前版本可以使用，但 Supabase 新版 SDK 推荐后续升级到 Node.js 22+。

验证标准：

```text
能正常输出 node、npm、python3 版本。
```

### Step 2：创建 Next.js 项目

操作目录：

```bash
cd /Users/liguopeng/Desktop/Project/ai-decoration-a-gen-t
```

执行命令：

```bash
mkdir -p apps
npx create-next-app@latest apps/web --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm
```

创建结果：

```text
apps/web
```

项目选项：

```text
TypeScript：是
Tailwind CSS：是
ESLint：是
App Router：是
src 目录：是
npm：是
```

验证命令：

```bash
cd /Users/liguopeng/Desktop/Project/ai-decoration-a-gen-t/apps/web
npm run lint
npm run build
```

当前结果：

```text
npm run lint：通过
npm run build：通过
```

### Step 3：修正 Next.js workspace root

问题：

```text
Next.js 构建时误把用户主目录识别为 workspace root。
```

修改文件：

```text
apps/web/next.config.ts
```

关键配置：

```ts
const nextConfig: NextConfig = {
  turbopack: {
    root: __dirname,
  },
};
```

验证命令：

```bash
npm run build
```

验证标准：

```text
不再出现 workspace root 误判导致的构建失败。
```

### Step 4：修正 TypeScript types

问题：

```text
TypeScript 构建时加载外部隐式类型，出现 minimatch 类型错误。
```

修改文件：

```text
apps/web/tsconfig.json
```

关键配置：

```json
"types": ["node", "react", "react-dom"]
```

验证命令：

```bash
npm run build
```

验证标准：

```text
TypeScript 检查通过。
```

### Step 5：启动本地开发服务

操作目录：

```bash
cd /Users/liguopeng/Desktop/Project/ai-decoration-a-gen-t/apps/web
```

执行命令：

```bash
npm run dev
```

访问地址：

```text
http://localhost:3000
```

当前结果：

```text
Next.js dev server 已成功启动。
```

验证标准：

```text
浏览器能打开 http://localhost:3000。
```

### Step 6：创建 Supabase schema 文件

新增文件：

```text
infra/supabase/schema.sql
```

文件用途：

```text
初始化 Supabase 数据库。
```

包含内容：

```text
1. vector 扩展。
2. knowledge_documents 表。
3. knowledge_chunks 表。
4. chat_sessions 表。
5. chat_messages 表。
6. match_knowledge_chunks 向量检索函数。
```

在 Supabase 控制台操作：

```text
Supabase Project
  ↓
SQL Editor
  ↓
New query
  ↓
复制 infra/supabase/schema.sql 全部内容
  ↓
Run
```

验证方式：

```text
Supabase Table Editor 中能看到：
knowledge_documents
knowledge_chunks
chat_sessions
chat_messages
```

### Step 7：安装 Supabase SDK

操作目录：

```bash
cd /Users/liguopeng/Desktop/Project/ai-decoration-a-gen-t/apps/web
```

执行命令：

```bash
npm install @supabase/supabase-js
```

当前提示：

```text
Supabase SDK 新版本推荐 Node.js 22+。
当前本机 Node.js 为 20.10.0，现阶段仍可运行。
```

验证命令：

```bash
npm run lint
npm run build
```

当前结果：

```text
npm run lint：通过
npm run build：通过
```

### Step 8：创建环境变量文件

新增模板：

```text
apps/web/.env.example
```

创建本地环境变量文件：

```bash
cd /Users/liguopeng/Desktop/Project/ai-decoration-a-gen-t/apps/web
cp .env.example .env.local
```

需要配置：

```env
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
OPENAI_API_KEY=
DEEPSEEK_API_KEY=
EMBEDDING_PROVIDER=openai
EMBEDDING_MODEL=text-embedding-3-small
```

当前已配置：

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
```

安全要求：

```text
.env.local 不能提交到 Git。
SUPABASE_SERVICE_ROLE_KEY 只能在服务端使用。
正式上线前，如果 secret key 曾出现在聊天或截图中，建议去 Supabase 后台 rotate。
```

### Step 9：创建 Supabase 连接 helper

新增文件：

```text
apps/web/src/lib/supabase/server.ts
apps/web/src/lib/supabase/client.ts
```

用途：

```text
server.ts：给 Next.js 服务端 API 使用，读取 SUPABASE_SERVICE_ROLE_KEY。
client.ts：给浏览器端使用，读取 NEXT_PUBLIC_SUPABASE_ANON_KEY。
```

验证方式：

```bash
npm run lint
npm run build
```

### Step 10：创建 Supabase 健康检查 API

新增文件：

```text
apps/web/src/app/api/health/supabase/route.ts
```

用途：

```text
检查 Next.js 是否能连接 Supabase。
```

访问地址：

```text
http://localhost:3000/api/health/supabase
```

终端验证命令：

```bash
curl -s http://localhost:3000/api/health/supabase
```

成功返回：

```json
{"ok":true,"message":"Supabase connection is ready."}
```

当前验证结果：

```text
Supabase 已连通。
```

### Step 11：下一步，编写 Python Markdown 入库脚本

目标：

```text
把当前仓库里的 Markdown 知识库写入 Supabase。
```

第一版先做：

```text
1. 扫描 00_知识库总控 到 05_知识规则与风险控制。
2. 读取每个 Markdown 文件。
3. 写入 knowledge_documents。
4. 按标题切成 chunk。
5. 写入 knowledge_chunks。
```

第一版暂不做：

```text
1. embedding。
2. 向量检索。
3. 大模型问答。
```

完成标准：

```text
Supabase 的 knowledge_documents 和 knowledge_chunks 表里能看到数据。
```

#### Step 11.1：确认 Markdown 原文件位置

决策：

```text
现在迁移到 knowledge/ 目录。
```

迁移前位置：

```text
00_知识库总控
01_标准知识库
02_民间装修知识库
03_装修决策案例库
04_AI问答模板库
05_知识规则与风险控制
```

迁移后位置：

```text
knowledge/00_知识库总控
knowledge/01_标准知识库
knowledge/02_民间装修知识库
knowledge/03_装修决策案例库
knowledge/04_AI问答模板库
knowledge/05_知识规则与风险控制
```

原因：

```text
正式项目中 Git 仓库保留 Markdown 原始知识源，knowledge/ 目录作为统一知识源入口。
Python 入库脚本后续固定扫描 knowledge/，路径稳定。
```

注意：

```text
此操作会移动现有知识库目录，Git 会记录大量路径变更。
```

执行结果：

```text
已创建 knowledge/。
已移动 00_知识库总控 到 05_知识规则与风险控制 六个目录。
knowledge/ 下当前共有 190 个 Markdown 文件。
```

#### Step 11.2：确认 chunk 切片规则

决策：

```text
按 Markdown 标题切片，超长再按段落拆。
```

具体规则：

```text
1. 优先以 #、##、### 作为切片边界。
2. 每个 chunk 尽量控制在 300-1200 中文字。
3. 少于 80 字的 chunk 可以和上一个 chunk 合并。
4. 超过 1500 字的 chunk 按空行继续拆。
5. 每个 chunk 必须保留来源文件和标题路径。
```

选择原因：

```text
当前知识库本身是结构化 Markdown，按标题切片能保留语义完整性。
用户问题通常是具体局部问题，按标题切片比整篇文档检索更准。
固定字数硬切容易切断完整判断逻辑，因此只作为超长内容的兜底规则。
```

不采用：

```text
1. 不采用整篇 Markdown 直接作为主要检索对象。
2. 不采用固定每 500 字硬切。
```

#### Step 11.3：确认 metadata 提取规则

定义：

```text
metadata 是每个知识 chunk 附带的结构化标签。
它用于告诉系统：这段内容来自哪里、属于哪一层知识库、哪个模块、什么文档类型、哪个标题段落。
```

作用：

```text
1. 方便检索过滤。
2. 方便回答时引用来源。
3. 方便判断知识类型。
4. 方便后续后台管理。
5. 方便高风险问题强制召回规则库。
```

每个 chunk 需要提取的字段：

```text
source_file：原始 Markdown 文件路径。
layer：知识库层级。
module：模块名称。
title：文档标题。
section：当前 chunk 所属标题。
doc_type：文档类型。
chunk_index：当前文件里的第几个 chunk。
```

示例：

```json
{
  "content": "强电验收时，应检查线管固定、强弱电间距、回路设置、接线规范……",
  "source_file": "knowledge/01_标准知识库/03_水电工程/03-12-水电验收标准.md",
  "layer": "标准知识库",
  "module": "水电工程",
  "title": "水电验收标准",
  "section": "强电验收要点",
  "doc_type": "验收标准",
  "chunk_index": 3
}
```

提取规则：

```text
1. source_file
   从文件路径直接保存，例如：
   knowledge/01_标准知识库/03_水电工程/03-12-水电验收标准.md

2. layer
   从 knowledge/ 下的第一层目录提取，并去掉数字前缀。
   例如：
   01_标准知识库 -> 标准知识库
   02_民间装修知识库 -> 民间装修知识库
   03_装修决策案例库 -> 装修决策案例库
   04_AI问答模板库 -> AI问答模板库
   05_知识规则与风险控制 -> 知识规则与风险控制

3. module
   优先从第二层目录提取，并去掉数字前缀。
   例如：
   03_水电工程 -> 水电工程
   04_防水工程 -> 防水工程
   09_验收标准 -> 验收标准
   如果没有第二层目录，则使用文件名主题或 layer。

4. title
   优先使用 Markdown 第一个一级标题。
   如果没有一级标题，则使用文件名去掉编号和 .md。
   例如：
   03-12-水电验收标准.md -> 水电验收标准

5. section
   使用当前 chunk 所属的标题路径。
   例如：
   水电验收标准 > 强电验收要点

6. doc_type
   从文件名和标题关键词推断。
   常见类型包括：
   基础知识、施工标准、验收标准、风险规则、问答模板、决策案例、接口索引、建设规范、推进清单。

7. chunk_index
   按同一文件内 chunk 生成顺序，从 0 开始递增。
```

示例路径解析：

```text
输入路径：
knowledge/01_标准知识库/03_水电工程/03-12-水电验收标准.md

解析结果：
layer = 标准知识库
module = 水电工程
title = 水电验收标准
doc_type = 验收标准
source_file = knowledge/01_标准知识库/03_水电工程/03-12-水电验收标准.md
```

重要原则：

```text
1. metadata 不能依赖大模型生成，第一版用规则自动提取。
2. metadata 可以不完美，但必须稳定、可复现。
3. 后续可以人工补充 stage、risk_level、keywords。
4. 没有 metadata 的知识片段不应进入正式检索链路。
```

#### Step 11.4：确认入库更新策略

**重点决策：MVP 阶段采用 `按 source_file 覆盖更新`。**

策略定义：

```text
同一个 Markdown 文件重新入库时：
1. 根据 source_file 找到对应 document。
2. 如果 document 不存在，则新增。
3. 如果 document 已存在，则更新 raw_markdown、title、layer、module、content_hash、updated_at。
4. 删除该 document 原有的所有 chunks。
5. 根据最新 Markdown 内容重新切片。
6. 写入新的 chunks。
```

数据库行为：

```text
knowledge_documents：按 source_file upsert。
knowledge_chunks：按 document_id delete + insert。
```

选择原因：

```text
1. 当前知识库仍在频繁调整，覆盖更新最简单稳定。
2. 避免重复 chunk 和过期 chunk 被检索出来。
3. 方便调试：Markdown 改完后重新运行脚本，数据库就是最新内容。
4. 适合当前优先目标：先跑通入库、检索和问答链路。
```

不采用追加写入：

```text
每次运行都追加 chunks 会导致旧知识残留，AI 可能召回过期内容。
```

后期升级方向：

```text
正式版本可以升级为版本化更新：
1. version 版本号。
2. is_active 当前生效版本。
3. content_hash 判断文件是否变化。
4. 保留历史 chunks。
5. 支持知识回滚和差异比较。
```

当前结论：

```text
第一版只做覆盖更新，不做复杂版本管理。
source_file 是文档唯一标识。
```

**重点标记：后期优化方向**

后期当项目进入正式运营、知识库多人维护、需要审核和回滚时，入库策略应升级为版本化策略。

建议升级项：

```text
1. knowledge_documents 增加 version 管理。
2. knowledge_chunks 增加 version 和 is_active 字段。
3. content_hash 用于判断 Markdown 是否发生变化。
4. 每次入库只处理发生变化的 Markdown 文件。
5. 保留历史 chunks，用于回滚和审计。
6. 增加 knowledge_import_jobs 表，记录每次入库任务。
7. 增加 knowledge_import_logs 表，记录成功、失败、跳过的文件。
8. 增加后台审核流程，避免未经确认的知识直接上线。
9. 增加灰度发布能力，让新版知识先只对测试环境生效。
10. 增加知识质量评分，用于发现过短、过长、缺少 metadata 的 chunk。
```

后期推荐表：

```text
knowledge_versions
knowledge_import_jobs
knowledge_import_logs
knowledge_quality_checks
```

后期推荐流程：

```text
Markdown 修改
  ↓
生成新 version
  ↓
入库到非 active 状态
  ↓
运行质量检查和问答评测
  ↓
人工审核
  ↓
切换 is_active
  ↓
线上生效
```

当前不做这些优化的原因：

```text
MVP 阶段最重要的是跑通知识入库、检索和问答链路。
过早加入版本、审核、灰度和审计会显著增加复杂度，拖慢上线。
```

### Step 12：编写 Python Markdown 入库脚本

当前执行：

```text
第一版做命令行入库脚本。
运行方式：
python3 scripts/ingest_markdown.py
```

**重点标记：脚本运行方式**

```bash
# 只预览扫描和切片结果，不写入 Supabase
python3 scripts/ingest_markdown.py --dry-run

# 正式入库，会写入 Supabase
python3 scripts/ingest_markdown.py
```

说明：

```text
1. 日常修改 Markdown 后，先运行 --dry-run 检查切片数量。
2. 确认没有异常后，再运行正式入库命令。
3. 正式入库采用按 source_file 覆盖更新，不会重复追加旧 chunks。
```

脚本职责：

```text
1. 扫描 knowledge/ 下所有 .md 文件。
2. 读取 Markdown 原文。
3. 提取 metadata。
4. 按标题切 chunk。
5. 写入 Supabase。
6. 打印导入结果。
```

重点决策：

```text
MVP 阶段先做命令行脚本，不做后台按钮和自动任务。
```

选择原因：

```text
1. 实现简单。
2. 调试方便。
3. 报错清晰。
4. 适合当前先跑通知识入库链路。
```

当前不做：

```text
1. 不做 embedding。
2. 不做向量检索。
3. 不做大模型回答。
4. 不做版本管理。
5. 不做后台按钮触发。
6. 不做定时任务。
7. 不做失败重试队列。
```

**重点标记：后期优化方向**

```text
1. 升级为 FastAPI 入库接口。
2. 接入后台管理按钮，一键同步知识库。
3. 接入 GitHub Actions，在 Markdown 变更后自动入库。
4. 增加定时同步任务。
5. 增加入库任务表和入库日志表。
6. 增加失败重试机制。
7. 增加 embedding 增量生成。
8. 增加知识质量检查。
9. 增加版本审核和灰度发布。
```

脚本备注要求：

```text
用户对 Python 不太熟，因此 Python 脚本需要保留详细注释。
注释重点说明：
1. 这个函数做什么。
2. 为什么这样做。
3. 当前 MVP 做到哪里。
4. 哪些能力后期再升级。
```

已创建文件：

```text
scripts/requirements.txt
scripts/ingest_markdown.py
```

当前脚本能力：

```text
1. 支持 --dry-run，只扫描和切片，不写数据库。
2. 支持正式运行，写入 Supabase。
3. 支持按 source_file 覆盖更新。
4. 支持按标题切片。
5. 支持 metadata 自动提取。
```

执行前检查：

```text
python3 -m py_compile scripts/ingest_markdown.py：通过。
python3 scripts/ingest_markdown.py --dry-run：通过。
dry-run 结果：扫描 190 个 Markdown 文件，切出 3535 个 chunks。
```

正式入库命令：

```bash
python3 scripts/ingest_markdown.py
```

执行说明：

```text
本次会写入 Supabase。
knowledge_documents 按 source_file upsert。
knowledge_chunks 按 document_id 删除旧 chunks 后重新插入。
```

第一次正式入库结果：

```text
失败。
错误：supabase-py 报 Invalid API key。
原因：当前 Supabase 使用 sb_secret_... 新格式密钥，Python supabase-py 当前版本不兼容该 key 格式。
```

修正方案：

```text
将 Python 入库脚本从 supabase-py SDK 改为直接调用 Supabase REST API。
```

修正后的依赖：

```text
python-dotenv
httpx
```

重点决策：

```text
Python 入库脚本使用 REST API 写入 Supabase。
Next.js 线上应用继续使用 @supabase/supabase-js。
```

**重点标记：后期优化方向**

```text
后期如果 supabase-py 完整支持当前 key 格式，可以再评估是否切回 SDK。
当前 REST API 方案更透明，适合调试入库流程。
```

修正后检查：

```text
python3 -m py_compile scripts/ingest_markdown.py：通过。
python3 scripts/ingest_markdown.py --dry-run：通过。
dry-run 结果：扫描 190 个 Markdown 文件，切出 3535 个 chunks。
```

第二次正式入库结果：

```text
中途手动中断。
中断前已处理到第 24 个 Markdown 文件。
原因：网络请求长时间无输出，卡在一次 TLS/HTTP 请求上。
```

修正方案：

```text
1. Python 脚本改为复用 httpx.Client 连接。
2. 增加请求失败重试。
3. 增加 print(..., flush=True)，保证入库进度实时显示。
```

说明：

```text
由于当前入库策略是按 source_file 覆盖更新，重新运行脚本不会造成重复数据。
已写入的文件会被重新 upsert，旧 chunks 会被删除后重建。
```

**重点标记：后期优化方向**

```text
后期正式入库任务应增加：
1. 断点续跑。
2. 每个文件单独记录导入状态。
3. 失败文件列表。
4. 后台可视化进度。
5. 任务队列和失败重试。
```

第三次正式入库结果：

```text
成功。
导入 Markdown documents：190。
导入 knowledge chunks：3535。
```

过程说明：

```text
运行过程中出现过 1 次 Server disconnected without sending a response。
脚本自动重试后继续执行，最终成功完成。
```

数据库验证：

```text
knowledge_documents：190 条。
knowledge_chunks：3535 条。
```

当前结论：

```text
Markdown 原始知识库已经成功写入 Supabase。
下一步可以开始做 embedding 生成和向量检索。
```

### Step 13：生成 embedding 和语义检索

当前状态：

```text
knowledge_documents 已有 190 条。
knowledge_chunks 已有 3535 条。
knowledge_chunks.embedding 当前还没有生成。
```

本阶段目标：

```text
把每个知识 chunk 的 content 转成 embedding 向量，写回 knowledge_chunks.embedding。
完成后，系统才能根据用户问题做语义检索。
```

embedding 的作用：

```text
embedding 是把文字转成一串数字，让数据库可以判断两段文字在语义上是否相似。
```

示例：

```text
用户问：瓷砖敲起来有空声怎么办？

即使知识库里写的是“瓷砖空鼓处理”，embedding 也能判断它们语义接近。
```

本阶段操作步骤：

```text
Step 13.1：确认 embedding 模型
作用：决定用哪个模型把文本转成向量。

Step 13.2：配置模型 API Key
作用：让脚本可以调用 embedding 模型。

Step 13.3：编写 generate_embeddings.py
作用：读取没有 embedding 的 chunks，批量生成向量并写回 Supabase。

Step 13.4：先小批量测试
作用：避免一次性处理 3535 条导致费用、速率或格式问题。

Step 13.5：正式生成全部 embedding
作用：让所有 knowledge_chunks 都可参与语义检索。

Step 13.6：验证 embedding 数量
作用：确认数据库里 embedding 不为空的 chunks 数量正确。

Step 13.7：编写检索测试脚本
作用：输入一个装修问题，检查能否召回相关知识 chunk。
```

原推荐模型：

```text
OpenAI text-embedding-3-small
```

推荐原因：

```text
1. 向量维度是 1536，和当前 knowledge_chunks.embedding vector(1536) 匹配。
2. 效果稳定。
3. 接入简单。
4. 适合 MVP 阶段快速跑通。
```

当前不做：

```text
1. 不同时接多个 embedding 模型。
2. 不做 embedding 版本管理。
3. 不做按 layer/module 单独重算。
4. 不做成本统计后台。
5. 不做国产模型适配。
```

**重点标记：后期优化方向**

```text
1. 支持国产 embedding 模型，例如 bge-m3、通义、智谱等。
2. 支持不同 embedding 维度的 schema 迁移。
3. 支持 embedding_model 和 embedding_version 字段。
4. 支持只重算指定 layer、module 或 source_file。
5. 支持内容 hash 未变化时跳过 embedding。
6. 支持 embedding 生成成本统计。
7. 支持失败重试和失败 chunk 列表。
8. 支持后台一键重新生成 embedding。
```

#### Step 13.1：确认 embedding 模型

当前执行：

```text
MVP 阶段改为使用阿里通义 DashScope text-embedding-v4。
```

重点决策：

```text
当前数据库字段是 embedding vector(1536)。
DashScope text-embedding-v4 支持 1536 维，和当前 schema 匹配。
国内正式项目优先使用国内可访问的 embedding 服务。
```

需要配置：

```text
apps/web/.env.local 中需要填写 DASHSCOPE_API_KEY。
```

当前不做：

```text
1. 不使用 OpenAI embedding 作为国内上线的唯一依赖。
2. 不修改 embedding 向量维度。
3. 不同时维护多套向量。
```

**重点标记：后期优化方向**

```text
后期如果切换 bge-m3、智谱或其他 embedding 模型，需要确认模型输出维度。
如果维度不是 1536，需要新增字段或迁移 knowledge_chunks.embedding 的 vector 维度。
```

#### Step 13.2：编写 embedding 生成脚本

当前执行：

```text
已创建 scripts/generate_embeddings.py。
已更新 scripts/requirements.txt。
脚本已从 OpenAI embedding 改为 DashScope text-embedding-v4。
```

脚本运行方式：

```bash
# 小批量测试，只处理 5 条
python3 scripts/generate_embeddings.py --limit 5

# 默认处理 50 条
python3 scripts/generate_embeddings.py

# 指定处理 500 条，每批 10 条
python3 scripts/generate_embeddings.py --limit 500 --batch-size 10
```

脚本作用：

```text
1. 读取 embedding 为空的 knowledge_chunks。
2. 调用阿里通义 DashScope text-embedding-v4。
3. 把生成的 1536 维向量写回 knowledge_chunks.embedding。
4. 支持 limit 小批量测试。
5. 支持 batch-size 批量调用 embedding API。
```

执行检查：

```text
python3 -m pip install -r scripts/requirements.txt：通过。
python3 -m py_compile scripts/generate_embeddings.py：通过。
```

当前阻塞：

```text
apps/web/.env.local 中 DASHSCOPE_API_KEY 为空。
需要先配置 DASHSCOPE_API_KEY，才能真正生成 embedding。
```

当前不做：

```text
1. 不在没有 API Key 的情况下生成 embedding。
2. 不把 API Key 写入代码。
3. 不在文档中记录真实 API Key。
```

**重点标记：后期优化方向**

```text
1. 增加 embedding 任务日志。
2. 增加失败 chunk 重试。
3. 增加 embedding 成本统计。
4. 增加按 source_file/layer/module 重算的参数。
5. 增加 embedding_model 字段记录模型来源。
```

#### Step 13.3：小批量生成 embedding 测试

当前执行：

```bash
python3 scripts/generate_embeddings.py --limit 5
```

执行结果：

```text
成功。
使用模型：text-embedding-v4。
向量维度：1536。
执行前缺失 embedding：3535。
本次处理 chunks：5。
执行后缺失 embedding：3530。
```

过程说明：

```text
Supabase 请求出现过 2 次 Connection reset by peer。
脚本自动重试后继续执行，最终成功。
```

当前结论：

```text
DashScope embedding 调用正常。
Supabase embedding 写入正常。
可以继续分批生成剩余 3530 条 embedding。
```

**重点标记：后期优化方向**

```text
后期需要增加更稳定的 embedding 任务管理：
1. 任务进度记录。
2. 失败 chunk 单独记录。
3. 自动断点续跑。
4. 可视化任务状态。
5. 成本和耗时统计。
```

#### Step 13.4：第一批批量生成 embedding

当前执行：

```bash
python3 scripts/generate_embeddings.py --limit 500 --batch-size 10
```

执行结果：

```text
成功。
本批处理 chunks：500。
执行前缺失 embedding：3530。
执行后缺失 embedding：3030。
```

过程说明：

```text
开始时 Supabase 请求出现过 2 次 Connection reset by peer。
脚本自动重试后继续执行，最终成功。
```

#### Step 13.5：第二批批量生成 embedding

当前执行：

```bash
python3 scripts/generate_embeddings.py --limit 500 --batch-size 10
```

第一次执行结果：

```text
失败。
执行前缺失 embedding：3030。
中途已成功写入 35 条左右。
失败原因：Supabase 多次 Connection reset by peer，3 次重试后仍失败。
```

修正方案：

```text
1. 将 Supabase 请求重试次数从 3 次增加到 6 次。
2. 每次请求失败后重建 httpx.Client 连接。
3. 重试等待时间调整为 3、6、9、12、15 秒。
```

说明：

```text
embedding 脚本只查询 embedding 为空的 chunks。
已经成功写入 embedding 的 chunk 不会重复处理。
重新运行脚本可以从剩余未完成部分继续。
```

**重点标记：后期优化方向**

```text
当前是轻量断点续跑。
后期应改成任务表记录每个 chunk 的状态：pending、processing、done、failed。
```

修正后执行策略：

```text
由于当前网络到 Supabase 偶发 Connection reset，批量从 500 条调整为 100 条一批。
```

当前执行：

```bash
python3 scripts/generate_embeddings.py --limit 100 --batch-size 10
```

执行结果：

```text
成功。
执行前缺失 embedding：2995。
本批处理 chunks：100。
执行后缺失 embedding：2895。
```

网络稳定性修正：

```text
Python httpx 默认会读取系统代理环境变量。
当前环境下，访问 Supabase 时系统代理路径多次触发 Connection reset by peer。
已将 generate_embeddings.py 中的 httpx.Client 改为 trust_env=False，避免自动使用系统代理。
```

修正后执行结果：

```text
继续按 100 条一批生成 embedding。
当前已从 2695 条缺失继续处理到 2095 条缺失。
说明 trust_env=False 后稳定性明显改善。
```

#### Step 13.6：完成全部 embedding 生成并验收

本步骤作用：

```text
确认所有知识库 chunk 都已经生成向量。
只有 embedding 全部完成后，后续语义检索才有完整的知识范围。
```

最终执行方式：

```bash
python3 scripts/generate_embeddings.py --limit 100 --batch-size 10
```

补充验证方式：

```bash
python3 scripts/generate_embeddings.py --limit 1 --batch-size 1
```

验证结果：

```text
Embedding model: text-embedding-v4
Embedding dimension: 1536
Chunks missing embedding before run: 0
Chunks selected this run: 0
Nothing to do.
```

数据库实查结果：

```text
knowledge_chunks 总数：3535。
已完成 embedding：3535。
缺失 embedding：0。
使用模型：阿里通义 DashScope text-embedding-v4。
向量维度：1536。
```

当前结论：

```text
Markdown 知识库已经完成入库。
knowledge_documents 已有 190 条。
knowledge_chunks 已有 3535 条。
3535 条 chunk 已全部生成 embedding。
下一步可以开始做“用户问题 -> query embedding -> Supabase 向量检索 -> 返回相关知识片段”的检索测试。
```

**重点标记：后期优化方向**

```text
1. 增加 embedding 任务表，记录每个 chunk 的 pending、processing、done、failed 状态。
2. 增加断点续跑的可视化状态，不只依赖 embedding 是否为空。
3. 增加失败列表，把失败 chunk、失败原因、重试次数记录下来。
4. 增加成本统计，记录每次 embedding 消耗的 token、费用和模型。
5. 增加后台管理按钮，支持一键重新生成指定目录或指定文件的 embedding。
6. 增加 embedding_model、embedding_dimension、embedding_version 字段，方便后期切换模型。
7. 增加内容 hash，Markdown 内容没有变化时跳过重复 embedding。
```

### Step 14：做第一版语义检索测试

本步骤作用：

```text
验证用户随便输入一个装修问题时，系统能不能从 5 块知识库里找出相关内容。
这一步还不是最终问答 Agent，只是先验证“找资料”这一步准不准。
```

计划新增脚本：

```text
scripts/test_retrieval.py
```

脚本要做的事：

```text
1. 接收一个用户问题。
2. 调用 DashScope text-embedding-v4，把用户问题转成 query embedding。
3. 调用 Supabase 的 match_knowledge_chunks RPC。
4. 打印 top-k 个最相关的知识片段。
5. 显示每个片段来自哪个 source_file、section、layer、module。
```

第一批测试问题：

```text
水电增项 8000 是不是被坑了？
卫生间门口地板发黑是不是漏水？
瓷砖空鼓一点要不要重铺？
```

验收标准：

```text
1. 脚本能正常运行。
2. 每个问题都能返回 5 到 8 条相关 chunk。
3. 返回结果能覆盖问题相关的业务知识，而不是随机内容。
4. 返回结果里能看到来源文件，方便后续排查答案依据。
```

**重点标记：后期优化方向**

```text
后期需要做检索质量评测集。
例如准备 50 到 100 个真实装修问题，为每个问题标注应该命中的知识文件。
这样每次调整 chunk、embedding 模型、召回数量、rerank 策略时，都能量化判断效果有没有变好。
```

#### Step 14.1：编写语义检索测试脚本

已新增文件：

```text
scripts/test_retrieval.py
```

脚本作用：

```text
输入一个用户装修问题。
调用 DashScope text-embedding-v4 生成 query embedding。
调用 Supabase RPC：match_knowledge_chunks。
打印最相关的知识片段、相似度、来源文件、layer、module、section、doc_type、risk_level。
```

运行方式：

```bash
python3 scripts/test_retrieval.py "水电增项 8000 是不是被坑了？"
python3 scripts/test_retrieval.py "卫生间门口地板发黑是不是漏水？" --top-k 5
python3 scripts/test_retrieval.py "瓷砖空鼓一点要不要重铺？" --top-k 5
```

可选参数：

```bash
--top-k 5
```

说明：

```text
控制返回多少条相关知识片段。
```

```bash
--layer 标准知识库
```

说明：

```text
只检索某一个 layer。
MVP 阶段一般不加 layer，让系统从 5 块知识库里一起召回。
```

语法检查：

```bash
python3 -m py_compile scripts/test_retrieval.py
```

结果：

```text
通过。
```

#### Step 14.2：检索测试结果

测试问题一：

```text
水电增项 8000 是不是被坑了？
```

结果摘要：

```text
成功返回 5 条。
命中内容包括：
1. knowledge/01_标准知识库/03_水电工程/03-13-水电增项风险.md
2. knowledge/04_AI问答模板库/04-01-预算类问答模板.md
3. knowledge/02_民间装修知识库/02-02-预算增项与报价避坑.md
4. knowledge/01_标准知识库/03_水电工程/03-14-水电常见问题.md
```

测试问题二：

```text
卫生间门口地板发黑是不是漏水？
```

结果摘要：

```text
成功返回 5 条。
命中内容包括：
1. knowledge/03_装修决策案例库/03-04-漏水渗水决策案例.md
2. knowledge/01_标准知识库/01-00-标准知识库调用接口索引.md
3. knowledge/00_知识库总控/00-03-装修AI知识库五层架构设计.md
4. knowledge/00_知识库总控/00-08-意图召回链路表.md
5. knowledge/00_知识库总控/00-04-标准知识库接口索引.md
```

测试问题三：

```text
瓷砖空鼓一点要不要重铺？
```

结果摘要：

```text
成功返回 5 条。
命中内容包括：
1. knowledge/01_标准知识库/05_瓦工工程/05-06-瓷砖空鼓处理.md
2. knowledge/02_民间装修知识库/02-09-师傅工长经验说法.md
3. knowledge/01_标准知识库/05_瓦工工程/05-05-瓷砖铺贴标准.md
```

当前结论：

```text
语义检索链路已经跑通。
用户问题可以被转成 query embedding。
Supabase 可以根据向量相似度召回相关知识片段。
5 块知识库之间已经可以通过“同一个用户问题”被关联召回。
```

发现的问题：

```text
部分 top 1 结果只有标题，例如“水电增项风险”“瓷砖空鼓处理”。
这类 chunk 对检索有帮助，但对最终回答提供的信息量不足。
```

**重点标记：后期优化方向**

```text
后期需要优化 chunk 质量：
1. 过滤只有标题、正文过短的 chunk。
2. 或者把只有标题的 chunk 自动合并到下一段正文。
3. 检索结果进入问答前，可以过滤 content 长度过短的片段。
4. 后期增加 rerank，把“标题相关但内容不足”的结果排到后面。
```

### Step 15：做第一版问答接口 `/api/chat`

本步骤作用：

```text
把 Step 14 已经跑通的“检索结果”，交给大模型生成用户能直接看的装修回答。

Step 14 只负责找资料。
Step 15 开始生成答案。

最终用户体验：
用户输入：水电增项 8000 是不是被坑了？
系统返回：先解释不能只看金额，再列核对点、风险点、下一步建议，并附上来源。
```

这一步要完成的链路：

```text
用户问题
-> 生成 query embedding
-> Supabase 检索相关 chunks
-> 过滤太短或低质量 chunks
-> 拼接成上下文 context
-> 调用大模型
-> 返回 answer + sources
```

本步骤为什么重要：

```text
装修问答 Agent 不能只靠大模型自由发挥。
必须先从知识库召回依据，再让大模型基于依据回答。
这样可以减少胡说，也方便后续给用户展示“答案来源”。
```

#### Step 15.1：确认大模型供应商

当前建议：

```text
继续使用阿里通义。
原因：
1. embedding 已经使用 DashScope。
2. 国内访问更稳定。
3. 后续部署到国内或服务国内用户时更省心。
```

MVP 推荐模型：

```text
qwen-plus
```

说明：

```text
qwen-plus 成本和效果比较均衡，适合第一版装修问答 Agent。
如果后期回答质量不够，再评估 qwen-max 或其他更强模型。
```

需要新增环境变量：

```env
CHAT_MODEL=qwen-plus
```

说明：

```text
DASHSCOPE_API_KEY 已经配置过。
CHAT_MODEL 只记录聊天模型名称。
```

**重点标记：后期优化方向**

```text
后期要支持模型可切换：
1. qwen-plus 用于普通问题。
2. qwen-max 用于复杂争议、维权、合同、报价审核。
3. 小模型用于意图识别、问题改写、风险分类。
4. 后台记录每次调用的模型、token、耗时和费用。
```

#### Step 15.2：新增服务端工具函数

计划新增目录：

```text
apps/web/src/lib/ai/
```

计划新增文件：

```text
apps/web/src/lib/ai/dashscope.ts
apps/web/src/lib/ai/retrieval.ts
apps/web/src/lib/ai/prompt.ts
```

文件职责：

```text
dashscope.ts
负责调用 DashScope：
1. 生成 query embedding。
2. 调用聊天模型生成答案。

retrieval.ts
负责调用 Supabase：
1. 调用 match_knowledge_chunks。
2. 过滤 content 太短的 chunk。
3. 整理 sources。

prompt.ts
负责组装提示词：
1. 告诉模型只能基于知识库回答。
2. 告诉模型遇到风险问题要提醒用户保留证据、暂停付款、找专业人士。
3. 告诉模型不要把民间经验当成唯一依据。
```

#### Step 15.3：设计 `/api/chat` 请求和响应格式

请求格式：

```json
{
  "message": "水电增项 8000 是不是被坑了？"
}
```

响应格式：

```json
{
  "answer": "这里是给用户看的装修回答",
  "sources": [
    {
      "source_file": "knowledge/01_标准知识库/03_水电工程/03-13-水电增项风险.md",
      "section": "水电增项风险",
      "layer": "标准知识库",
      "module": "水电工程",
      "similarity": 0.8281
    }
  ]
}
```

为什么要返回 sources：

```text
1. 方便前端展示“参考来源”。
2. 方便调试回答是否真的基于知识库。
3. 后期做答案质量评估时，可以判断召回依据是否正确。
```

#### Step 15.4：第一版回答规则

第一版系统提示词要包含这些规则：

```text
1. 你是装修问答 Agent，回答要面向普通业主。
2. 必须优先依据提供的知识库片段回答。
3. 不要编造知识库里没有的国家标准、法律条款、品牌参数。
4. 如果证据不足，要说“目前不能直接判断”，再告诉用户还需要补充什么信息。
5. 遇到漏水、用电、燃气、结构、安全、维权、付款争议，要明确提醒风险。
6. 民间经验只能作为参考，不能单独作为结论依据。
7. 回答结构尽量固定：先给判断，再给原因，再给操作步骤，最后给注意事项。
```

推荐回答结构：

```text
1. 先给结论：能不能初步判断。
2. 解释依据：为什么这么判断。
3. 给检查清单：用户现在该看哪些点。
4. 给下一步动作：先暂停、拍照、要明细、复验、找第三方等。
5. 风险提醒：哪些情况必须找专业人员或保留证据。
```

#### Step 15.5：接口验收方式

本地启动 Next.js：

```bash
cd apps/web
npm run dev
```

用 curl 测试：

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"水电增项 8000 是不是被坑了？"}'
```

验收标准：

```text
1. 接口返回 200。
2. 返回 JSON 里有 answer。
3. 返回 JSON 里有 sources。
4. sources 至少包含 3 条相关知识来源。
5. answer 不能只说空话，必须有具体核对步骤。
6. answer 不能说“肯定被坑了”这种过度判断。
7. 遇到争议类问题，要提醒用户保留明细、合同、照片、聊天记录。
```

#### Step 15.6：第一批接口测试问题

测试问题：

```text
水电增项 8000 是不是被坑了？
卫生间门口地板发黑是不是漏水？
瓷砖空鼓一点要不要重铺？
装修公司让我先付尾款再整改，可以吗？
全屋定制板材味道很大，是甲醛超标吗？
```

每个问题要检查：

```text
1. 是否召回正确知识库。
2. 是否给出明确但不过度的判断。
3. 是否给出用户能执行的下一步。
4. 是否在高风险场景提醒证据和专业检测。
5. 是否返回 sources。
```

#### Step 15.7：本步骤完成后的项目状态

完成 Step 15 后，项目会从：

```text
能检索知识库
```

升级为：

```text
能基于知识库回答装修问题
```

也就是第一版真正可用的装修问答 Agent 后端雏形。

**重点标记：后期优化方向**

```text
1. 增加多轮对话记忆，支持用户追问“那我现在怎么办”。
2. 增加意图识别，先判断是预算、施工、验收、售后、维权还是材料问题。
3. 增加强制规则召回，高风险问题必须召回 05_知识规则与风险控制。
4. 增加 rerank，让更有回答价值的片段排在前面。
5. 增加答案评分，判断回答是否引用了知识库、是否遗漏风险提醒。
6. 增加用户反馈按钮：有用、没用、答非所问、风险提示不足。
7. 增加日志表，记录问题、召回 chunks、最终答案、模型、耗时、token。
```

### Step 16：开始实现第一版 `/api/chat`

本步骤作用：

```text
把“能检索知识库”的能力，继续推进到“能生成用户可读回答”。
```

当前执行范围：

```text
本次先执行 3 件事：
1. 确认聊天模型。
2. 补环境变量。
3. 新增 DashScope 调用工具。

暂不实现 /api/chat route。
暂不实现 retrieval.ts。
暂不实现 prompt.ts。
```

#### Step 16.1：确认聊天模型

当前确认：

```text
聊天模型使用阿里通义 qwen-plus。
```

选择原因：

```text
1. 当前 embedding 已经使用 DashScope text-embedding-v4。
2. 聊天模型继续使用 DashScope，供应商更统一。
3. qwen-plus 适合作为 MVP 阶段的问答模型，成本和效果比较均衡。
```

当前模型分工：

```text
text-embedding-v4：负责把用户问题和知识片段转成向量，用于检索。
qwen-plus：负责把检索到的知识片段组织成用户能看的回答。
```

#### Step 16.2：补环境变量

已修改：

```text
apps/web/.env.example
apps/web/.env.local
```

新增环境变量：

```env
CHAT_MODEL=qwen-plus
```

说明：

```text
DASHSCOPE_API_KEY 继续复用之前 embedding 使用的 Key。
CHAT_MODEL 只记录当前聊天模型名称。
```

安全备注：

```text
apps/web/.env.local 里是真实密钥，不要提交到 Git。
apps/web/.env.example 只保留变量名和示例值，用来说明项目需要哪些配置。
```

#### Step 16.3：新增 DashScope 调用工具

已新增文件：

```text
apps/web/src/lib/ai/dashscope.ts
```

文件作用：

```text
统一封装 Next.js 后端对 DashScope 的调用。
后续 /api/chat 不直接散落 fetch 调用，而是调用这里的函数。
```

当前包含函数：

```text
createQueryEmbedding(question)
```

作用：

```text
把用户问题转成 query embedding。
后续用于调用 Supabase match_knowledge_chunks 做向量检索。
```

```text
generateChatAnswer(messages)
```

作用：

```text
调用 qwen-plus，根据 system/user/assistant messages 生成最终回答。
```

实现说明：

```text
1. embedding 使用 DashScope text embedding REST API。
2. chat 使用 DashScope OpenAI 兼容模式 chat completions API。
3. temperature 设置为 0.2，让装修问答回答更稳，不要过度发散。
4. 如果响应格式异常，会主动抛错，方便接口层返回错误信息。
```

验证命令：

```bash
cd apps/web
npm run lint
npm run build
```

验证结果：

```text
npm run lint：通过。
npm run build：通过。
```

构建备注：

```text
构建时 Supabase SDK 提醒 Node.js 20 后续会弃用，建议以后升级到 Node.js 22+。
当前不影响本阶段功能。
```

下一步：

```text
继续实现 Step 16.4：新增 retrieval.ts。
作用是把 createQueryEmbedding 生成的向量拿去 Supabase 检索知识库。
```

#### Step 16.4：新增检索工具 `retrieval.ts`

已新增文件：

```text
apps/web/src/lib/ai/retrieval.ts
```

本步骤作用：

```text
把用户问题生成的 query embedding，拿去 Supabase 检索 knowledge_chunks。
```

这个文件负责：

```text
1. 调用 Supabase RPC：match_knowledge_chunks。
2. 获取最相关的知识 chunks。
3. 过滤 content 太短的 chunk。
4. 整理 sources，方便接口返回给前端。
```

当前默认规则：

```text
默认召回数量：8 条。
过滤规则：content 少于 30 个字符的 chunk 不进入最终 prompt。
sources 数量：最多返回 6 条。
去重规则：同一个 source_file + section 只保留一次。
```

为什么要过滤太短 chunk：

```text
之前检索测试发现，有些 top 1 结果只有标题。
例如“水电增项风险”“瓷砖空鼓处理”。
这类 chunk 对检索有帮助，但直接给大模型生成答案时信息量不足。
所以第一版先过滤掉正文太短的 chunk。
```

当前导出的能力：

```text
matchKnowledgeChunks(queryEmbedding)
```

作用：

```text
调用 Supabase match_knowledge_chunks，返回原始召回结果。
```

```text
prepareRetrievedKnowledge(chunks)
```

作用：

```text
对召回结果做过滤、去重，并生成 sources。
```

验证命令：

```bash
cd apps/web
npm run lint
npm run build
```

验证结果：

```text
npm run lint：通过。
npm run build：通过。
```

构建备注：

```text
仍然有 Supabase SDK 关于 Node.js 20 的提醒。
这是环境版本提醒，不影响当前检索工具。
```

**重点标记：后期优化方向**

```text
1. 增加相似度阈值，例如 similarity 低于 0.65 的结果不进入 prompt。
2. 增加 rerank，把“更适合回答”的 chunk 排到前面。
3. 增加强制规则召回，高风险问题必须额外召回 05_知识规则与风险控制。
4. 增加 layer 权重，例如标准知识库权重高于民间经验库。
5. 增加来源多样性控制，避免 8 条结果都来自同一个文件。
6. 增加调试日志，记录每次问题召回了哪些 chunks。
```

下一步：

```text
继续实现 Step 16.5：新增 prompt.ts。
作用是把用户问题、检索到的 chunks、回答规则组装成大模型 messages。
```

#### Step 16.4.1：DashScope API URL 改为环境变量

调整原因：

```text
之前 DashScope embedding URL 和 chat completions URL 写在代码常量里。
正式项目更建议放到环境变量里。
这样后期如果切换阿里官方地址、内网代理、自建网关或兼容服务，不需要改代码。
```

已修改文件：

```text
apps/web/.env.example
apps/web/.env.local
apps/web/src/lib/ai/dashscope.ts
```

新增环境变量：

```env
DASHSCOPE_EMBEDDINGS_URL=https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding
DASHSCOPE_CHAT_COMPLETIONS_URL=https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
```

代码策略：

```text
优先读取环境变量。
如果环境变量没有配置，则使用代码里的默认 URL 兜底。
```

**重点标记：后期优化方向**

```text
后期如果接入企业网关、API 代理、私有化模型或多供应商模型路由，只需要调整环境变量或配置中心。
不要把供应商 URL 写死在业务代码里。
```

#### Step 16.5：新增 Prompt 组装工具 `prompt.ts`

已新增文件：

```text
apps/web/src/lib/ai/prompt.ts
```

本步骤作用：

```text
把用户问题、检索到的知识 chunks、装修问答规则，组装成可以发给 qwen-plus 的 messages。
```

为什么要单独做 prompt.ts：

```text
prompt 是问答 Agent 的行为规则中心。
如果直接把提示词散落在 /api/chat 里，后期很难维护。
单独放到 prompt.ts 后，后面优化回答结构、风险提醒、多轮对话，都更清晰。
```

当前包含函数：

```text
buildKnowledgeContext(chunks)
```

作用：

```text
把多个知识 chunk 整理成模型容易阅读的知识库上下文。
每个 chunk 会带上来源文件、知识层级、模块、章节、文档类型、风险等级、相似度和正文内容。
```

```text
buildChatMessages(question, chunks)
```

作用：

```text
把用户问题和知识库上下文，组装成 system + user 两条 messages。
后续直接传给 generateChatAnswer(messages)。
```

当前 prompt 规则：

```text
1. 你是装修问答 Agent，面向普通业主回答装修问题。
2. 必须优先依据提供的知识库资料回答。
3. 不要编造知识库里没有的国家标准、法律条款、品牌参数或检测结论。
4. 如果资料不足以直接判断，要明确说“目前不能直接判断”。
5. 遇到漏水、用电、燃气、结构安全、付款争议、维权、甲醛或人身安全问题，要主动提醒风险。
6. 民间经验只能作为参考，不能单独作为最终结论依据。
7. 回答要具体、克制、可执行，不要为了显得确定而过度判断。
8. 回答结构固定为：初步判断、判断依据、你现在可以怎么做、风险提醒。
```

当前上下文限制：

```text
MAX_CONTEXT_CHARS = 9000
```

说明：

```text
第一版先限制知识库上下文长度，避免一次塞给模型太多内容。
后期可以改成按 token 计算，而不是按字符数计算。
```

验证命令：

```bash
cd apps/web
npm run lint
npm run build
```

验证结果：

```text
npm run lint：通过。
npm run build：通过。
```

**重点标记：后期优化方向**

```text
1. prompt 版本化，例如 prompt_version=v1、v2。
2. 不同意图使用不同 prompt，例如预算、施工、验收、售后、维权。
3. 高风险问题自动追加更严格的安全和证据规则。
4. context 长度改为按 token 计算。
5. 增加回答质量自检，让模型生成后检查是否遗漏风险提醒和下一步建议。
6. 增加引用格式，让前端可以把 sources 和回答段落对应起来。
```

下一步：

```text
继续实现 Step 16.6：新增 /api/chat route。
作用是把 dashscope.ts、retrieval.ts、prompt.ts 串起来，形成真正可调用的问答接口。
```

#### Step 16.6：新增 `/api/chat` 问答接口

已新增文件：

```text
apps/web/src/app/api/chat/route.ts
```

本步骤作用：

```text
把前面已经完成的 3 个能力串起来：
1. dashscope.ts：生成 query embedding，并调用 qwen-plus。
2. retrieval.ts：调用 Supabase 检索知识库 chunks。
3. prompt.ts：组装用户问题、知识资料和回答规则。

最终形成一个可以被前端调用的问答接口。
```

接口地址：

```text
POST /api/chat
```

请求格式：

```json
{
  "message": "水电增项 8000 是不是被坑了？"
}
```

响应格式：

```json
{
  "ok": true,
  "answer": "装修问答回答",
  "sources": []
}
```

接口内部执行链路：

```text
1. 校验 message。
2. 给用户问题生成 query embedding。
3. 调用 Supabase match_knowledge_chunks。
4. 过滤太短的 chunks。
5. 整理 sources。
6. 组装 qwen-plus messages。
7. 调用 qwen-plus 生成 answer。
8. 返回 answer + sources。
```

输入限制：

```text
message 最多取前 1000 个字符。
```

说明：

```text
第一版先限制问题长度，避免用户一次提交超长内容导致成本和响应时间不可控。
后期可以改成更精细的 token 限制。
```

空结果处理：

```text
如果没有可用 chunks，接口不会强行让模型回答。
会返回“目前没有检索到足够相关的知识库资料，暂时不能直接判断”。
```

验证命令：

```bash
cd apps/web
npm run lint
npm run build
```

验证结果：

```text
npm run lint：通过。
npm run build：通过。
```

本地启动：

```bash
cd apps/web
npm run dev
```

接口测试命令：

```bash
curl -s -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"水电增项 8000 是不是被坑了？"}'
```

实际测试结果：

```text
HTTP：200。
ok：true。
answer：已返回。
sources：已返回 6 条。
耗时：约 20 秒。
```

测试命中的 sources 摘要：

```text
1. knowledge/04_AI问答模板库/04-01-预算类问答模板.md
2. knowledge/02_民间装修知识库/02-02-预算增项与报价避坑.md
3. knowledge/01_标准知识库/03_水电工程/03-13-水电增项风险.md
4. knowledge/01_标准知识库/03_水电工程/03-14-水电常见问题.md
5. knowledge/00_知识库总控/00-08-意图召回链路表.md
6. knowledge/00_知识库总控/00-06-知识库调用与用户输出规则.md
```

当前结论：

```text
第一版 /api/chat 已经跑通。
项目已经从“能检索知识库”，推进到“能基于知识库生成装修回答”。
这是可用装修问答 Agent 后端的第一版雏形。
```

当前发现的问题：

```text
模型回答整体可用，但会主动举一些具体材料或工程量示例。
这些示例有助于用户理解，但后期需要在 prompt 中明确要求：
如果是示例，必须写明“例如”，不能让用户误以为这是已核实事实。
```

**重点标记：后期优化方向**

```text
1. 增加接口日志，记录 question、sources、answer、模型、耗时、错误信息。
2. 增加 token 和费用统计。
3. 增加 streaming 流式输出，避免用户等待 20 秒才看到结果。
4. 增加强制风险规则召回，高风险问题必须额外召回 05_知识规则与风险控制。
5. 收紧 prompt：模型举例时必须标注“例如”，不能把示例说成事实。
6. 增加相似度阈值和 rerank，提升 sources 质量。
7. 增加异常分类，区分 DashScope 错误、Supabase 错误、输入错误。
```

下一步：

```text
开始 Step 17：做前端聊天页面。
让用户可以在浏览器里输入装修问题，并看到 answer 和 sources。
```

### Step 17：做第一版前端聊天页面

本步骤作用：

```text
把后端 /api/chat 接口接到浏览器页面上。
让用户不需要 curl，也能直接在页面里输入装修问题、查看回答和知识来源。
```

已修改文件：

```text
apps/web/src/app/page.tsx
apps/web/src/app/layout.tsx
```

#### Step 17.1：替换默认首页

原状态：

```text
首页还是 create-next-app 默认页面。
用户无法输入装修问题。
```

当前状态：

```text
首页已经改成装修问答诊断台。
```

页面包含：

```text
1. 用户问题输入框。
2. 提交分析按钮。
3. 示例问题按钮。
4. 回答结果区域。
5. 参考来源 sources 区域。
6. loading 状态。
7. error 状态。
```

#### Step 17.2：前端调用 `/api/chat`

页面调用方式：

```text
fetch("/api/chat", {
  method: "POST",
  headers: {
    "content-type": "application/json"
  },
  body: JSON.stringify({ message })
})
```

说明：

```text
前端只负责把用户输入提交给后端。
embedding、知识检索、prompt 组装、qwen-plus 调用都在服务端完成。
这样不会把 DASHSCOPE_API_KEY、SUPABASE_SERVICE_ROLE_KEY 暴露到浏览器。
```

#### Step 17.3：页面展示规则

回答展示：

```text
answer 使用 whitespace-pre-wrap 展示。
这样模型返回的换行、分段、列表能保留。
```

来源展示：

```text
每条 source 展示：
1. layer。
2. module。
3. similarity。
4. source_file。
5. section。
```

第一版示例问题：

```text
水电增项 8000 是不是被坑了？
卫生间门口地板发黑是不是漏水？
瓷砖空鼓一点要不要重铺？
```

#### Step 17.4：页面元信息

已修改：

```text
apps/web/src/app/layout.tsx
```

调整内容：

```text
title：装修问答 Agent
description：基于装修知识库的问答工具
html lang：zh-CN
```

#### Step 17.5：验证方式

代码检查：

```bash
cd apps/web
npm run lint
npm run build
```

验证结果：

```text
npm run lint：通过。
npm run build：通过。
```

本地启动：

```bash
cd apps/web
npm run dev
```

访问地址：

```text
http://localhost:3000
```

页面访问验证：

```bash
curl -s http://localhost:3000 | rg -n "装修问题诊断台|用户问题|回答结果|参考来源"
```

验证结果：

```text
页面可以访问。
HTML 中可以看到“装修问题诊断台”“用户问题”“回答结果”等内容。
```

接口联调验证：

```bash
curl -s -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"瓷砖空鼓一点要不要重铺？"}'
```

验证结果：

```text
POST /api/chat：200。
answer：已返回。
sources：已返回。
耗时：约 18 秒。
```

当前结论：

```text
第一版前端聊天页面已经可用。
项目现在已经具备：
1. 前端输入装修问题。
2. 后端检索知识库。
3. 后端调用 qwen-plus 生成回答。
4. 前端展示 answer 和 sources。
```

**重点标记：后期优化方向**

```text
1. 增加 streaming 流式输出，让用户不用等 18 到 20 秒才看到完整答案。
2. 增加多轮对话 UI，支持用户继续追问。
3. 增加 sources 折叠和复制按钮。
4. 增加“有用/没用/答非所问/风险提示不足”反馈按钮。
5. 增加移动端细节优化，例如输入框固定到底部。
6. 增加问题分类标签，例如预算、施工、验收、售后、维权、材料。
7. 增加回答中的来源引用标记，让用户知道每段回答来自哪些 sources。
```

下一步：

```text
开始 Step 18：做接口日志和调试记录。
作用是把每次用户问题、召回 sources、回答、耗时和错误记录下来，方便后期优化和上线排错。
```

### Step 17.1：调整回答模板为简洁版

调整原因：

```text
第一版 prompt 要求固定输出：
初步判断、判断依据、你现在可以怎么做、风险提醒。

实际效果偏像专业报告，回答太长。
真实用户更适合先看到短结论和少量可执行动作。
```

已修改文件：

```text
apps/web/src/lib/ai/prompt.ts
```

调整内容：

```text
1. 去掉固定四段标题。
2. 默认要求用简洁自然的口吻回答。
3. 除非用户要求详细分析，否则控制在 300 到 500 字。
4. 先用 1 到 2 句话直接回答用户最关心的问题。
5. 再给 3 个以内最关键的核对点或下一步动作。
6. 涉及风险、争议或售后时，用 1 句话提醒保留证据。
7. 如果需要举例，必须明确写“例如”，避免把示例说成事实。
```

重要说明：

```text
这次只改回答模板，不改检索链路。
系统仍然会先查知识库，再生成回答。
```

不变的链路：

```text
用户问题
-> query embedding
-> Supabase 检索 knowledge_chunks
-> prompt.ts 组装 messages
-> qwen-plus 生成简洁回答
-> 返回 answer + sources
```

验证命令：

```bash
cd apps/web
npm run lint
npm run build
```

验证结果：

```text
npm run lint：通过。
npm run build：通过。
```

接口实测问题：

```text
水电增项 8000 是不是被坑了？
```

实测结果：

```text
ok：true。
answer 字数：约 304 字。
sources：6 条。
```

回答效果：

```text
比之前明显更短。
仍然有结论、核对点、付款建议和证据提醒。
仍然返回知识来源 sources。
```

**重点标记：后期优化方向**

```text
1. 增加“简洁 / 详细”模式切换。
2. 默认简洁回答，用户点击“展开分析”后再请求详细版。
3. 对高风险问题自动放宽字数限制，避免风险提醒不充分。
4. 增加前端回答长度选择，例如 200 字、500 字、详细分析。
5. 记录用户反馈，判断简洁版是否足够解决问题。
```

### Step 17.2：按参考图优化前端页面

调整目标：

```text
把页面从普通表单工具，优化成更像 AI 装修顾问产品的工作台。
参考方向：
1. 左侧深色会话栏。
2. 右侧大面积 AI 顾问欢迎区。
3. 能力卡片展示。
4. 底部大输入框作为主要操作入口。
5. 回答和 sources 在页面中直接展示。
```

已修改文件：

```text
apps/web/src/app/page.tsx
```

当前页面结构：

```text
1. 左侧 Sidebar
   - genengi 品牌名。
   - 新建对话按钮。
   - 最近对话列表。
   - 用户入口。
   - 设置入口。

2. 主工作区
   - AI 装修顾问标签。
   - 欢迎标题。
   - 高频问题入口。
   - 能力卡片：专属装修方案、预算清单、报价合同风险分析、施工现场问题识别。
   - 底部输入框。
   - 上传图片、上传文件按钮。
   - 发送按钮。

3. 回答区
   - 提交后展示 answer。
   - 展示 sources。
```

保留不变的能力：

```text
1. 仍然调用 /api/chat。
2. 仍然使用知识库检索。
3. 仍然返回 answer + sources。
4. 仍然保持简洁版回答模板。
```

当前说明：

```text
上传图片、上传文件按钮目前只是 UI 占位。
第一版还没有真正实现文件上传、OCR、图片识别或图纸解析。
```

验证命令：

```bash
cd apps/web
npm run lint
npm run build
```

验证结果：

```text
npm run lint：通过。
npm run build：通过。
```

页面验证：

```bash
curl -s http://localhost:3000 | rg -n "genengi|AI 装修顾问|上传图片|上传文件|报价、合同风险分析|施工现场问题识别"
```

验证结果：

```text
页面内容已渲染。
```

接口联调验证：

```text
问题：卫生间门口地板发黑是不是漏水？
ok：true。
answer：约 302 字。
sources：6 条。
```

**重点标记：后期优化方向**

```text
1. 实现真实多会话，而不是静态最近对话列表。
2. 新建对话按钮要创建 chat_session。
3. 每次问答要写入 chat_messages。
4. 上传图片按钮后期接入图片识别、现场问题识别。
5. 上传文件按钮后期支持报价单、合同、图纸解析。
6. 首页右上角的建筑/图纸视觉元素后期建议换成真实生成图或品牌视觉资产。
7. 移动端后期可以把侧边栏做成抽屉。
8. 发送按钮后期建议换成正式图标库，例如 lucide-react。
```

### Step 17.3：改成 ChatGPT 式对话页面

调整原因：

```text
用户希望页面更像 ChatGPT 这种对话产品。
重点从“工作台首页”改为“连续聊天界面”。
```

已修改文件：

```text
apps/web/src/app/page.tsx
```

当前页面结构：

```text
1. 左侧深色会话栏。
   - genengi 品牌。
   - 新对话按钮。
   - 最近会话列表。
   - 用户入口。

2. 顶部栏。
   - AI 装修顾问。
   - 基于 3535 个知识片段回答。
   - 当前模型 qwen-plus。

3. 中间消息流。
   - 用户消息。
   - AI 回答。
   - loading 状态。
   - sources 折叠展示。

4. 空会话欢迎态。
   - 今天想解决哪个装修问题？
   - 示例问题快捷入口。

5. 底部输入框。
   - 输入装修问题。
   - Enter 发送。
   - Shift + Enter 换行。
   - 上传图片、上传文件 UI 占位。
```

数据结构调整：

```text
之前页面只保存 answer 和 sources。
现在页面改为 messages 数组。

这样可以展示多轮对话的视觉形态：
用户一条消息。
AI 一条回复。
每条 AI 回复可以带自己的 sources。
```

保留不变：

```text
1. 仍然调用 /api/chat。
2. 仍然先检索知识库。
3. 仍然调用 qwen-plus 生成回答。
4. 仍然返回 answer + sources。
```

验证命令：

```bash
cd apps/web
npm run lint
npm run build
```

验证结果：

```text
npm run lint：通过。
npm run build：通过。
```

页面验证：

```bash
curl -s http://localhost:3000 | rg -n "今天想解决哪个装修问题|新对话|参考来源|询问装修预算|qwen-plus"
```

接口联调验证：

```text
问题：装修公司让我先付尾款再整改，可以吗？
ok：true。
answer：约 220 字。
sources：6 条。
```

**重点标记：后期优化方向**

```text
1. 当前 messages 只存在浏览器内存，刷新页面会丢失。
2. 后期要把每次对话写入 chat_sessions 和 chat_messages。
3. 左侧最近会话现在是静态假数据，后期要从数据库读取。
4. 新对话按钮后期要真正创建 session。
5. 多轮追问时，/api/chat 需要传入 history 或 sessionId。
6. sources 后期可以改成每段回答的引用标记。
7. 后期加入流式输出，体验会更像 ChatGPT。
```

#### Step 17.3.1：左侧会话栏按参考图细化

调整目标：

```text
让左侧栏更接近 ChatGPT 风格：
1. 更窄的深色侧栏。
2. 顶部品牌 genengi + 小加号。
3. 边框式“新对话”按钮。
4. 最近会话使用简洁小圆点列表。
5. 减少卡片感和复杂信息。
```

已修改文件：

```text
apps/web/src/app/page.tsx
```

调整内容：

```text
1. 侧栏宽度调整为 276px。
2. 背景色调整为更接近参考图的 #0b0b10。
3. 顶部品牌区减少高度。
4. 新对话按钮改为细边框样式。
5. 最近会话列表去掉摘要和时间，只保留标题。
6. 最近会话前缀改为小圆点。
7. hover 状态更轻。
```

验证命令：

```bash
cd apps/web
npm run lint
npm run build
```

验证结果：

```text
npm run lint：通过。
npm run build：通过。
```

**重点标记：后期优化方向**

```text
1. 左侧最近会话仍然是静态展示，后期要接 chat_sessions。
2. 新对话按钮后期要创建真实 session。
3. 会话标题后期可以根据用户第一句话自动生成。
4. 移动端后期需要把左侧栏改成抽屉。
```

#### Step 17.3.2：左侧会话加入前期记忆功能

调整原因：

```text
左侧不应该前期就展示假会话。
更合理的是：
1. 初始状态左侧为空。
2. 用户真正提问后，自动生成一条会话记录。
3. 刷新页面后还能看到之前的本机会话。
```

当前实现方式：

```text
使用浏览器 localStorage 做前期轻量记忆。
不需要新增数据库表。
不影响 /api/chat。
```

已修改文件：

```text
apps/web/src/app/page.tsx
```

新增数据结构：

```text
Conversation
- id
- title
- messages
- updatedAt
```

当前功能：

```text
1. 左侧最近会话前期为空。
2. 用户第一次提问时自动创建 conversation。
3. conversation 标题使用用户第一句话自动截断生成。
4. AI 回复会保存到当前 conversation。
5. 点击左侧会话可以恢复消息。
6. 新对话按钮会清空当前 activeConversationId，让下一次提问创建新会话。
7. 刷新页面后，会从 localStorage 恢复会话。
```

localStorage key：

```text
ai-decoration-agent-conversations
```

验证命令：

```bash
cd apps/web
npm run lint
npm run build
```

验证结果：

```text
npm run lint：通过。
npm run build：通过。
```

页面验证：

```text
初始左侧显示：还没有对话，提一个装修问题后会自动保存到这里。
```

接口联调验证：

```text
问题：水电增项 8000 是不是被坑了？
ok：true。
answer：已返回。
sources：6 条。
```

**重点标记：后期优化方向**

```text
1. localStorage 只适合前期 MVP，本质是浏览器本地记忆。
2. 用户换电脑、换浏览器、清缓存后，本地会话会丢失。
3. 正式上线要迁移到 Supabase chat_sessions 和 chat_messages。
4. 后期 /api/chat 要接收 sessionId，把每次问答写入数据库。
5. 左侧最近会话要从数据库读取，而不是从 localStorage 读取。
6. 会话标题后期可以用模型根据第一轮问答自动总结。
```

#### Step 17.3.3：调整聊天消息左右排列

调整原因：

```text
用户消息和 AI 回复不应该都左对齐。
更符合聊天产品习惯的是：
用户提问在右侧。
AI 回复在左侧。
```

已修改文件：

```text
apps/web/src/app/page.tsx
```

当前消息布局：

```text
用户消息：
1. 靠右展示。
2. 蓝色气泡。
3. 右侧头像显示“你”。

AI 回复：
1. 靠左展示。
2. 左侧头像显示“G”。
3. 正文保持宽排版，方便阅读长回答。
4. sources 仍然折叠显示在 AI 回复下方。
```

验证命令：

```bash
cd apps/web
npm run lint
npm run build
```

验证结果：

```text
npm run lint：通过。
npm run build：通过。
```

**重点标记：后期优化方向**

```text
1. 用户消息后期可以增加复制、编辑、重新发送。
2. AI 回复后期可以增加复制、重新生成、展开详细分析。
3. sources 后期可以做成右侧抽屉或悬浮引用面板。
```

#### Step 17.3.4：修复 localStorage 导致的 Hydration mismatch

问题现象：

```text
Next.js 报错：
Hydration failed because the server rendered HTML didn't match the client.
```

原因：

```text
服务端渲染时不能读取浏览器 localStorage，所以左侧会话栏渲染为空。
客户端第一次渲染时如果马上读取 localStorage，会渲染出已有会话按钮。
这样服务端 HTML 和客户端首屏 HTML 不一致，就会触发 hydration mismatch。
```

修复方式：

```text
改用 React useSyncExternalStore 订阅 localStorage。
服务端 snapshot 固定返回 []。
客户端 hydration 首屏也先使用同样的 []。
等客户端完成挂载后，再读取 localStorage 并触发正常更新。
```

已修改文件：

```text
apps/web/src/app/page.tsx
```

当前 localStorage 机制：

```text
1. getServerConversationsSnapshot：服务端固定返回 []。
2. getConversationsSnapshot：客户端读取 localStorage。
3. subscribeToConversations：订阅 storage 和自定义事件。
4. saveConversations：写入 localStorage 后派发 ai-decoration-conversations-change。
```

验证命令：

```bash
cd apps/web
npm run lint
npm run build
```

验证结果：

```text
npm run lint：通过。
npm run build：通过。
```

**重点标记：后期优化方向**

```text
等会话迁移到 Supabase 后，localStorage 只保留草稿或最近本地缓存。
正式会话历史应由服务端返回，避免不同设备之间不一致。
```

### Step 18：左侧栏改为 Supabase 会话系统

调整原因：

```text
localStorage 只适合前期 MVP。
正式上线项目需要由服务端数据库管理会话。
这样刷新页面、换设备、后期登录用户后，都可以恢复历史对话。
```

本步骤目标：

```text
先改左侧侧边栏：
1. 左侧会话列表从 Supabase chat_sessions 读取。
2. 点击“新对话”创建真实 chat_session。
3. 点击左侧会话加载 chat_messages。
4. 发送消息时，把 user 和 assistant 消息写入 Supabase。
```

已新增接口：

```text
apps/web/src/app/api/chat/sessions/route.ts
apps/web/src/app/api/chat/sessions/[id]/messages/route.ts
```

已修改接口：

```text
apps/web/src/app/api/chat/route.ts
```

已修改前端：

```text
apps/web/src/app/page.tsx
```

#### Step 18.1：会话列表接口

接口：

```text
GET /api/chat/sessions
```

作用：

```text
读取 chat_sessions，用于左侧最近会话列表。
只读取 session，不一次性读取 messages，避免首页变慢。
```

返回：

```json
{
  "ok": true,
  "sessions": []
}
```

#### Step 18.2：新建会话接口

接口：

```text
POST /api/chat/sessions
```

作用：

```text
点击“新对话”时创建真实 chat_session。
当前没有登录系统，所以 user_id 暂时为空。
```

默认标题：

```text
新对话
```

#### Step 18.3：会话消息接口

接口：

```text
GET /api/chat/sessions/:id/messages
```

作用：

```text
点击左侧某个会话时，根据 session_id 加载这个会话的完整消息。
assistant 消息里的 sources 也会返回，用于前端折叠展示参考来源。
```

#### Step 18.4：/api/chat 支持 sessionId

请求格式调整为：

```json
{
  "sessionId": "uuid",
  "message": "瓷砖空鼓一点要不要重铺？"
}
```

处理逻辑：

```text
1. 如果有 sessionId，就写入这个会话。
2. 如果没有 sessionId，就后端自动创建一个新会话。
3. 先写入 user message。
4. 再做 query embedding。
5. 检索知识库。
6. 调用 qwen-plus 生成 answer。
7. 写入 assistant message 和 sources。
8. 更新 chat_sessions.updated_at 和 title。
```

#### Step 18.5：前端侧边栏调整

当前前端逻辑：

```text
页面加载：
GET /api/chat/sessions

点击新对话：
POST /api/chat/sessions

点击左侧会话：
GET /api/chat/sessions/:id/messages

发送消息：
POST /api/chat，带 sessionId
```

当前 localStorage 状态：

```text
左侧会话和消息历史不再依赖 localStorage。
会话数据来自 Supabase。
```

#### Step 18.6：验证结果

验证命令：

```bash
cd apps/web
npm run lint
npm run build
```

验证结果：

```text
npm run lint：通过。
npm run build：通过。
```

接口联调：

```text
POST /api/chat/sessions：成功创建 session。
POST /api/chat：成功写入 user 和 assistant message。
GET /api/chat/sessions/:id/messages：成功返回 2 条消息。
```

测试结果：

```text
chat_ok：true。
answer：已返回。
sources：6 条。
messages：2 条。
```

**重点标记：后期优化方向**

```text
1. 当前 chat_sessions 还没有绑定真实 user_id。
2. 后期接登录后，需要按 user_id 过滤会话列表。
3. 新对话如果用户没发送消息，后期可以自动清理空 session。
4. 会话标题目前用第一句话截断，后期可以用模型总结标题。
5. 后期要给 /api/chat 增加多轮 history 和问题改写。
6. 后期要增加删除会话、重命名会话、归档会话。
```

### Step 19：/api/chat 使用数据库历史上下文

问题说明：

```text
前端请求仍然只传 message + sessionId。
这本身是正确的。
正式项目不应该让前端每次传全部 history。
history 应该由后端根据 sessionId 从数据库读取。
```

本步骤目标：

```text
/api/chat 收到 sessionId 后：
1. 查询该 session 最近几条 chat_messages。
2. 把历史消息放进 prompt。
3. 让模型回答时能理解追问。
```

已修改文件：

```text
apps/web/src/app/api/chat/route.ts
apps/web/src/lib/ai/prompt.ts
```

#### Step 19.1：后端读取最近历史

当前规则：

```text
HISTORY_LIMIT = 6
```

说明：

```text
读取最近 6 条 user/assistant 消息。
当前问题写入数据库之前先查询历史。
这样历史里不会重复包含当前问题。
```

查询来源：

```text
chat_messages
```

过滤：

```text
role in ["user", "assistant"]
```

排序：

```text
先按 created_at desc 取最近 6 条。
再 reverse 成正常对话顺序。
```

#### Step 19.2：prompt 支持历史上下文

已新增类型：

```text
PromptHistoryMessage
```

prompt 新增内容：

```text
【最近对话历史】
用户：瓷砖空鼓一点要不要重铺？
genengi：要看位置、面积、是否松动...
```

限制：

```text
MAX_HISTORY_CHARS = 3000
```

说明：

```text
防止历史太长导致 token 成本失控。
sources 不放进 history，只保留 role + content。
```

#### Step 19.3：当前完整流程

```text
前端：
POST /api/chat
{
  "sessionId": "xxx",
  "message": "那如果在卫生间墙上呢？"
}

后端：
1. 根据 sessionId 查询最近 6 条历史消息。
2. 写入当前 user message。
3. 用当前 message 生成 query embedding。
4. 检索 knowledge_chunks。
5. 把 history + 当前问题 + chunks 组装 prompt。
6. 调用 qwen-plus。
7. 写入 assistant message。
8. 返回 answer + sources。
```

当前能力：

```text
模型回答时能看到最近上文。
例如上一轮问“瓷砖空鼓一点要不要重铺？”
下一轮问“那如果在卫生间墙上呢？”
模型可以理解“那”指的是瓷砖空鼓。
```

验证命令：

```bash
cd apps/web
npm run lint
npm run build
```

验证结果：

```text
npm run lint：通过。
npm run build：通过。
```

接口联调：

```text
第一轮：瓷砖空鼓一点要不要重铺？
第二轮：那如果在卫生间墙上呢？
```

测试结果：

```text
first_ok：true。
second_ok：true。
messages：4 条。
第二轮回答已结合上一轮“瓷砖空鼓”的上下文。
```

**重点标记：后期优化方向**

```text
1. 当前检索 embedding 仍然只使用当前 message。
2. 后期要增加“问题改写”：
   历史 + 当前追问 -> 完整检索问题。
   例如“那如果在卫生间墙上呢？”改写成“卫生间墙砖空鼓一点要不要重铺？”
3. 后期要增加 session_summary，避免长对话只靠最近 6 条。
4. 高风险追问要强制召回 05_知识规则与风险控制。
```

### Step 20：左侧栏改成项目树展示

调整目标：

```text
左侧栏改成类似 Codex 项目列表的浅色结构。
同一个项目下缩进展示该项目的会话。
```

已修改文件：

```text
apps/web/src/app/page.tsx
```

当前结构：

```text
顶部：
1. mac 风格窗口圆点。
2. 新对话。
3. 搜索。
4. 已安排。
5. 插件。

项目区：
1. 标题：项目。
2. 父级项目：ai-decoration-a-gen-t。
3. 子级会话：当前项目下的 chat_sessions。
4. 无会话时显示：暂无对话。
```

数据来源：

```text
父级项目名目前是前端固定展示：ai-decoration-a-gen-t。
子级会话来自 Supabase chat_sessions。
点击子级会话会调用 GET /api/chat/sessions/:id/messages 加载消息。
```

验证命令：

```bash
cd apps/web
npm run lint
npm run build
```

验证结果：

```text
npm run lint：通过。
npm run build：通过。
```

页面验证：

```text
页面已渲染：
项目
ai-decoration-a-gen-t
暂无对话 / 会话列表
```

**重点标记：后期优化方向**

```text
1. 当前项目列表里的其他项目是 UI 占位。
2. 后期如果支持多项目，需要新增 projects 表。
3. chat_sessions 后期应该带 project_id。
4. 左侧项目树要按 project_id 分组展示 sessions。
5. 当前红色边框是按参考图临时模拟，后期可以改成选中态而不是固定红框。
```

### Step 21：第一优先级优化：正式上线版回答质量

调整原因：

```text
项目已经能回答装修问题，但正式上线前，第一优先级必须先优化回答质量。
用户问“签合同具体如何做”时，不能只给 300 到 500 字的短建议。
合同、付款、维权、安全类问题也不能只靠普通向量相似度召回。
```

本步骤目标：

```text
1. 建立统一意图策略层。
2. 让检索和 prompt 使用同一套意图结果。
3. 合同、付款、维权、安全类问题强制召回关键知识层。
4. 用户要求“具体/详细/一步一步/清单/流程”时，自动切换为详细步骤回答。
5. embedding 未完成或向量检索为空时，使用关键词兜底，保证线上服务不直接失效。
```

已新增文件：

```text
apps/web/src/lib/ai/intent.ts
```

已修改文件：

```text
apps/web/src/lib/ai/retrieval.ts
apps/web/src/lib/ai/prompt.ts
apps/web/src/app/api/chat/route.ts
```

#### Step 21.1：新增意图策略中心

新增函数：

```text
detectIntentProfile(question)
```

作用：

```text
把用户问题识别成可执行策略。
后续 retrieval 和 prompt 都读取同一个 IntentProfile。
```

当前 IntentProfile 包含：

```text
detailLevel：brief / detailed。
labels：命中的意图标签。
forceLayers：必须额外召回的知识层。
fallbackKeywords：向量检索失败时的关键词兜底。
guidance：传给 prompt 的回答策略说明。
```

当前支持的重点标签：

```text
1. 详细步骤。
2. 合同签约。
3. 付款报价。
4. 维权争议。
5. 安全风险。
6. 瓷砖瓦工。
```

选择原因：

```text
正式上线项目不能让 prompt 和 retrieval 各写一套关键词。
统一意图策略后，后期可以把这部分升级为：
1. 数据库配置。
2. 后台可维护规则。
3. 小模型意图识别。
4. 00-08 意图召回链路表的可执行版本。
```

#### Step 21.2：检索层增加强制召回

新增函数：

```text
retrieveKnowledgeForQuestion(queryEmbedding, intentProfile)
```

当前检索链路：

```text
query embedding
  ↓
普通向量召回
  ↓
根据 intentProfile.forceLayers 额外召回标准库/模板库/规则库
  ↓
去重合并 chunks
  ↓
交给 prompt 生成回答
```

强制召回规则：

```text
合同签约：标准知识库 + AI问答模板库 + 知识规则与风险控制。
付款报价：标准知识库 + AI问答模板库 + 知识规则与风险控制。
维权争议：AI问答模板库 + 知识规则与风险控制。
安全风险：标准知识库 + 知识规则与风险控制。
瓷砖瓦工：标准知识库。
```

这样做的目的：

```text
普通向量召回负责“语义相关”。
强制召回负责“风险边界、回答模板、责任规则不漏掉”。
```

#### Step 21.3：增加关键词兜底检索

发现问题：

```text
当前知识库有 chunk 缺 embedding。
如果完全依赖向量检索，可能出现 matched chunks = 0。
```

兜底策略：

```text
当向量检索返回 0 条时，使用 intentProfile.fallbackKeywords 从 knowledge_chunks 做关键词检索。
```

关键词兜底排序：

```text
文件名命中 > 标题命中 > 章节命中 > 模块命中 > 正文命中。
```

示例：

```text
用户问：签合同具体如何做

兜底检索会优先命中：
1. knowledge/01_标准知识库/01_装修准备/01-03-装修合同签订.md
2. knowledge/04_AI问答模板库/04-02-合同类问答模板.md
3. knowledge/01_标准知识库/01_装修准备/01-06-装修报价单审核.md
```

重要说明：

```text
关键词兜底是正式上线前的可用性保护，不是最终替代 embedding。
正式上线仍然要确保所有 knowledge_chunks.embedding 完整。
```

#### Step 21.4：prompt 接入回答策略

prompt 新增：

```text
【本次回答策略】
```

内容包括：

```text
回答模式：简洁回答 / 详细步骤。
命中标签：合同签约、付款报价、安全风险等。
策略要求：本次问题必须怎么回答。
```

详细模式触发词：

```text
具体、详细、一步一步、步骤、清单、流程、怎么做、如何做、怎么操作。
```

合同签约类问题必须覆盖：

```text
1. 合同正文。
2. 报价单附件。
3. 材料清单。
4. 增项规则。
5. 付款节点。
6. 验收整改。
7. 保修售后。
8. 证据留存。
9. 先别签的风险信号。
```

#### Step 21.5：/api/chat 接入正式链路

调整后链路：

```text
用户问题
  ↓
读取历史并改写追问
  ↓
detectIntentProfile
  ↓
createQueryEmbedding
  ↓
retrieveKnowledgeForQuestion
  ↓
prepareRetrievedKnowledge
  ↓
buildChatMessages(question, chunks, history, intentProfile)
  ↓
qwen-plus 生成回答
  ↓
写入 chat_messages
```

#### Step 21.6：验收结果

验证命令：

```bash
cd apps/web
npm run lint
npm run build
```

验证结果：

```text
npm run lint：通过。
npm run build：通过。
```

接口验收问题一：

```text
签合同具体如何做
```

结果：

```text
ok：true。
answer_len：2373。
回答进入 12 步签约清单。
sources 命中 01-03-装修合同签订.md。
```

接口验收问题二：

```text
装修公司让我先付尾款再整改，可以吗
```

结果：

```text
ok：true。
answer_len：224。
回答明确不建议先付尾款，并要求整改清单、复验合格、保留证据。
sources 命中 01-07-装修付款方式.md。
```

接口验收问题三：

```text
卫生间门口地板发黑是不是漏水
```

结果：

```text
ok：true。
answer_len：190。
回答进入安全风险处理，提醒停止用水、留证、联系物业和施工方查漏。
sources 命中 11-03-漏水渗水售后处理.md。
```

**重点标记：后期优化方向**

```text
1. 把 intent.ts 的关键词规则迁移到数据库或后台配置。
2. 把 00-08 意图召回链路表转成可执行召回配置。
3. 增加 retrieval_logs 表，记录普通召回、强制召回、关键词兜底分别命中的 chunks。
4. 增加 answer_eval_cases，沉淀 50 到 100 条真实问题做回归测试。
5. 增加 rerank，避免关键词兜底时泛文档排到前面。
6. 高风险问题增加二次安全审查，避免过度判断责任、赔偿或法律结论。
7. embedding 任务必须补齐，后台要显示“知识库索引是否完整”。
8. 正式上线建议加 streaming，避免复杂回答等待时间过长。
```

### Step 22：第一优先级优化：上线可观测性

调整原因：

```text
正式上线后，不能只靠用户反馈“回答好不好”。
需要记录每次问答：
1. 用户问了什么。
2. 追问被改写成了什么。
3. 命中了哪些意图。
4. 是否用了强制召回。
5. 是否用了关键词兜底。
6. 返回了哪些 sources。
7. 回答耗时多久。
8. 是否发生错误。
```

本步骤目标：

```text
给回答质量优化增加可观测性。
后期如果用户说“回答不准”，可以从日志里反查：
是意图识别错了，还是知识没召回，还是 prompt 组织得不好。
```

已修改文件：

```text
infra/supabase/schema.sql
apps/web/src/lib/ai/retrieval.ts
apps/web/src/app/api/chat/route.ts
```

已新增文件：

```text
apps/web/src/lib/ai/chat-logs.ts
apps/web/src/app/api/health/knowledge/route.ts
```

#### Step 22.1：新增 chat_request_logs 表

新增表：

```text
chat_request_logs
```

用途：

```text
记录每一次 /api/chat 请求的关键调试信息。
```

核心字段：

```text
session_id：对应会话。
user_message：用户原始问题。
retrieval_question：结合历史改写后的检索问题。
intent_labels：命中的意图标签。
detail_level：brief / detailed。
force_layers：强制召回的知识层。
retrieval_stats：召回统计。
sources：最终返回前端的来源。
answer_preview：回答前 500 字。
answer_chars：回答字数。
status：ok / error。
error_message：错误信息。
duration_ms：总耗时。
```

重要说明：

```text
需要在 Supabase SQL Editor 重新执行 infra/supabase/schema.sql 里的新增表部分。
代码会尝试写日志，但如果线上数据库还没建 chat_request_logs，不会影响正常聊天。
```

#### Step 22.2：retrieval 返回召回统计

新增类型：

```text
RetrievalStats
```

记录内容：

```text
baseVectorCount：普通向量召回数量。
usedKeywordFallback：普通召回是否使用关键词兜底。
forcedLayers：每个强制层的召回情况。
mergedCount：最终合并后的 chunk 数量。
```

示例用途：

```text
如果某次回答 sources 很奇怪，可以看：
1. baseVectorCount 是否为 0。
2. 是否走了 keyword fallback。
3. 哪个 force layer 没召回到内容。
4. 最终 chunks 是否过少。
```

#### Step 22.3：/api/chat 写入请求日志

当前记录范围：

```text
1. 正常回答。
2. 没有检索到资料时的 fallback 回答。
3. 接口异常。
```

容错策略：

```text
日志写入失败只 console.warn，不影响用户正常聊天。
```

选择原因：

```text
日志是上线增强能力，不能因为日志表没建、字段没同步或网络异常，导致核心问答接口不可用。
```

#### Step 22.4：新增知识库健康检查接口

新增接口：

```text
GET /api/health/knowledge
```

返回内容：

```json
{
  "ok": true,
  "embeddingReady": false,
  "documentsCount": 190,
  "chunksCount": 3649,
  "embeddedChunksCount": 1,
  "missingEmbeddingCount": 3648,
  "message": "Knowledge index is not fully embedded yet."
}
```

作用：

```text
上线前检查知识库索引是否完整。
如果 missingEmbeddingCount > 0，说明向量检索不完整，必须补跑 embedding。
```

#### Step 22.5：上线前验收标准

必须检查：

```bash
curl -s http://localhost:3000/api/health/knowledge
```

正式上线标准：

```text
embeddingReady 必须为 true。
missingEmbeddingCount 必须为 0。
documentsCount 和 chunksCount 不应为 0。
```

当前允许状态：

```text
开发阶段如果 embeddingReady 为 false，系统会通过关键词兜底保证基本可用。
但这不是正式上线状态。
```

**重点标记：后期优化方向**

```text
1. 给 chat_request_logs 增加后台页面，按问题查看召回详情。
2. 增加 answer_feedbacks 表，记录用户点“有用/没用/答非所问”。
3. 增加 answer_eval_cases 表，做固定测试集回归。
4. 增加 token、模型、费用、耗时分段统计。
5. 把 retrieval_stats 展示成可读的调试面板。
6. 日志量变大后，要设置保留周期和归档策略。
```

### Step 23：优化知识更新流程：一键同步知识库

问题说明：

```text
每次新增或修改 Markdown 知识后，不能只执行：
python3 scripts/ingest_markdown.py --dry-run
python3 scripts/ingest_markdown.py

原因：
ingest_markdown.py 只负责把 Markdown 写入数据库并切 chunk。
新生成的 chunk 没有 embedding。
如果不继续生成 embedding，向量检索就搜不到这些新知识。
```

正确链路：

```text
Markdown 修改
  ↓
dry-run 预览扫描和切片
  ↓
正式入库 knowledge_documents / knowledge_chunks
  ↓
为缺失 embedding 的 chunks 生成向量
  ↓
确认 missingEmbeddingCount = 0
  ↓
线上问答可正常召回新知识
```

已新增文件：

```text
scripts/sync_knowledge.py
```

脚本作用：

```text
知识库同步总控脚本。
把 dry-run、正式入库、循环生成 embedding、最终健康检查串成一个流程。
默认采用“改谁同步谁”的增量模式。
```

#### Step 23.1：推荐日常使用方式

日常推荐：

```bash
python3 scripts/sync_knowledge.py
```

它会自动执行：

```text
1. python3 scripts/ingest_markdown.py --dry-run
2. python3 scripts/ingest_markdown.py --changed-only
3. python3 scripts/generate_embeddings.py --limit 100 --batch-size 10
4. 循环第 3 步，直到缺失 embedding = 0
5. 再执行一次健康检查
```

说明：

```text
--changed-only 会比较本地 Markdown 的 content_hash 和数据库里的 content_hash。
只有新增或内容变化的 Markdown 才会重新入库。
没有变化的文件会显示 skipped unchanged。
```

#### Step 23.2：只预览，不写数据库

使用场景：

```text
你刚改完 Markdown，想先看看会扫描多少文件、切出多少 chunks。
```

命令：

```bash
python3 scripts/sync_knowledge.py --dry-run-only
```

等价于：

```bash
python3 scripts/ingest_markdown.py --dry-run
```

#### Step 23.3：只同步 Git 里改过的 Markdown

使用场景：

```text
你只想同步当前 Git 工作区里 knowledge/ 下发生变化的 Markdown。
```

命令：

```bash
python3 scripts/sync_knowledge.py --git-changed
```

脚本会执行：

```text
1. git status --short -- knowledge
2. 找出变更的 .md 文件
3. 只对这些文件做 dry-run
4. 只对这些文件做正式入库
5. 只给新生成的 chunks 补 embedding
```

如果没有变更：

```text
No changed Markdown files found under knowledge/.
```

#### Step 23.4：只同步指定文件

使用场景：

```text
你明确知道只改了某一个知识文件。
```

命令：

```bash
python3 scripts/sync_knowledge.py --source-file knowledge/04_AI问答模板库/04-02-合同类问答模板.md
```

可以重复指定：

```bash
python3 scripts/sync_knowledge.py \
  --source-file knowledge/04_AI问答模板库/04-02-合同类问答模板.md \
  --source-file knowledge/01_标准知识库/01_装修准备/01-03-装修合同签订.md
```

#### Step 23.5：强制全量同步

使用场景：

```text
数据库状态不可信，或者你主动想重建全部 chunks。
```

命令：

```bash
python3 scripts/sync_knowledge.py --full
```

说明：

```text
--full 会取消 changed-only，所有 Markdown 都会重新入库。
这会导致大量 chunks 被重建，需要重新生成 embedding。
不要作为日常命令。
```

#### Step 23.6：只补 embedding

使用场景：

```text
之前入库已经完成，但 embedding 中断了。
不想重新入库，只想继续补缺失 embedding。
```

命令：

```bash
python3 scripts/sync_knowledge.py --skip-ingest
```

说明：

```text
脚本会跳过 dry-run 和正式入库，只循环执行 generate_embeddings.py。
直到缺失 embedding = 0。
```

#### Step 23.7：只入库，不生成 embedding

使用场景：

```text
只想验证入库流程，不想消耗 embedding API。
不建议正式上线前这样做。
```

命令：

```bash
python3 scripts/sync_knowledge.py --skip-embeddings
```

#### Step 23.8：可调整参数

默认：

```text
每轮处理 100 条 chunk。
每批调用 DashScope 10 条。
最多循环 100 轮。
```

自定义：

```bash
python3 scripts/sync_knowledge.py --embedding-limit 200 --embedding-batch-size 10 --max-embedding-rounds 50
```

注意：

```text
DashScope text embedding batch-size 必须 <= 10。
```

#### Step 23.9：正式上线标准

执行完同步后，检查：

```bash
curl -s http://localhost:3000/api/health/knowledge
```

上线标准：

```text
embeddingReady = true
missingEmbeddingCount = 0
documentsCount > 0
chunksCount > 0
```

**重点标记：后期优化方向**

```text
1. 当前 sync_knowledge.py 还是命令行脚本。
2. 后期可以接入后台按钮：一键同步知识库。
3. 后期增加 knowledge_import_jobs 表，记录每次同步任务。
4. 后期增加失败文件列表和失败 chunk 列表。
5. 后期根据 content_hash 只处理变更过的 Markdown 文件。
6. 后期只给新增/变更 chunk 生成 embedding，避免重复消耗。
7. 后期接入 CI/CD，在 knowledge/ 改动后自动跑 dry-run 和质量检查。
```

## 当前实施进度

### 2026-07-03

已完成：

1. 检查本机环境。
   - Node.js：20.10.0。
   - npm：10.2.3。
   - Python：3.9.6。
2. 创建 Next.js 项目。
   - 路径：`apps/web`。
   - 技术选项：TypeScript、Tailwind CSS、ESLint、App Router、src 目录。
3. 修正 Next.js workspace root 配置。
   - 文件：`apps/web/next.config.ts`。
   - 原因：避免 Next.js 误把用户主目录识别为 workspace root。
4. 修正 TypeScript types 配置。
   - 文件：`apps/web/tsconfig.json`。
   - 原因：避免加载外部隐式类型导致构建失败。
5. 验证项目骨架。
   - `npm run lint` 通过。
   - `npm run build` 通过。

待做：

1. 创建 Supabase 项目并执行 schema。
2. 编写 Python Markdown 入库脚本。
3. 编写第一版问答接口。
4. 改造前端聊天页面。

新增文件：

1. `infra/supabase/schema.sql`
   - 用途：Supabase 数据库初始化。
   - 包含：`knowledge_documents`、`knowledge_chunks`、`chat_sessions`、`chat_messages`。
   - 包含：`match_knowledge_chunks` 向量检索函数。
   - 依赖：Supabase PostgreSQL 开启 `vector` 扩展。
2. `apps/web/.env.example`
   - 用途：记录 Next.js 项目需要的环境变量。
   - 注意：真实密钥写入 `.env.local`，不要提交到 Git。
3. `apps/web/src/lib/supabase/server.ts`
   - 用途：创建服务端 Supabase Admin client。
   - 使用：后端 API、入库触发、服务端检索。
4. `apps/web/src/lib/supabase/client.ts`
   - 用途：创建浏览器端 Supabase client。
   - 使用：后续登录、前端读取公开数据。
5. `apps/web/src/app/api/health/supabase/route.ts`
   - 用途：检查 Next.js 是否能连接 Supabase。
   - 访问：`/api/health/supabase`。

配置注意：

1. 当前 `@supabase/supabase-js` 已安装。
2. 本机 Node.js 是 20.10.0，Supabase 新版 SDK 提示后续推荐 Node.js 22+。
3. 当前 `npm run lint` 通过。
4. 当前 `npm run build` 通过。

Supabase 连接验证：

1. 已创建 `apps/web/.env.local`。
2. 已配置 Supabase URL、publishable key、secret key。
3. 已重启 Next.js dev server。
4. 已访问 `/api/health/supabase`。
5. 返回：`{"ok":true,"message":"Supabase connection is ready."}`。

安全备注：

1. Supabase secret key 已经在本地 `.env.local` 中使用。
2. `.env.local` 不应提交到 Git。
3. 如果 secret key 曾在聊天、截图或公开位置出现，正式上线前建议在 Supabase 后台轮换密钥。

## 每一步验收标准

### Next.js 项目

验收：

1. 本地能打开页面。
2. 页面有输入框。
3. 能调用 `/api/chat`。

### Supabase

验收：

1. pgvector 已启用。
2. 表创建成功。
3. 能写入和读取测试数据。

### Python 入库

验收：

1. 能扫描所有 Markdown。
2. 能生成 documents。
3. 能生成 chunks。
4. 能生成 embedding。
5. 能写入数据库。

### 问答接口

验收：

1. 输入装修问题能返回答案。
2. 答案不是纯模型瞎答。
3. 返回 sources。
4. 涉及风险时有提醒。

### 部署上线

验收：

1. Vercel 域名可访问。
2. 线上能提问。
3. 环境变量配置正确。
4. 数据库连接正常。

## 重要原则

1. Markdown 是知识源，不要丢。
2. 数据库是检索索引，不要手工改 chunk。
3. 知识更新后，用脚本重新入库。
4. 高风险问题必须召回规则库。
5. 民间经验不能单独作为答案依据。
6. 第一版先做问答，不做太多功能。
7. 每一步都要有可运行结果。

## 同一对话上下文关联规则

当前同一对话的上下文依赖 `sessionId`。

实际链路：

1. 前端每次发送问题时，把当前对话的 `sessionId` 一起传给 `/api/chat`。
2. 后端根据 `sessionId` 从 `chat_messages` 读取最近 6 条历史消息。
3. 如果用户是追问，例如“那如果在卫生间墙上呢？”，后端会先结合历史把它改写成完整检索问题。
4. 改写后的完整问题用于生成 query embedding，并去 `knowledge_chunks` 做向量检索。
5. 最终回答时，模型会同时看到历史对话、用户原始问题和召回的知识库资料。

本次修正：

1. 前端发送问题时直接使用当前 `activeConversationId` 作为 `sessionId`。
2. 避免左侧会话列表未及时刷新时，`sessionId` 丢失导致后端创建新会话。
3. 后端新增追问改写逻辑，让历史不仅影响最终回答，也影响知识库召回。

【后期优化重点】上下文能力继续增强：

1. 把追问改写结果保存到日志表，方便排查召回为什么偏。
2. 给 `chat_messages` 增加 token 统计，避免历史过长。
3. 增加 session 摘要表，长期对话不只依赖最近 6 条消息。
4. 检索时同时使用“原始问题 + 改写问题”做混合召回。
5. 对合同、漏水、电路、燃气等高风险问题增加强制规则库召回。

## 当前侧边栏对话显示规则

当前页面左侧采用“对话列表”的展示方式。

现在的真实情况：

1. 左侧不再显示外层项目名。
2. 聊天记录来自 Supabase 的 `chat_sessions` 表。
3. 点击某条聊天记录后，再从 `chat_messages` 表读取这个会话的消息。
4. 每条会话右侧显示一个轻量时间提示，例如“1 分 / 4 天 / 1 周”。
5. 鼠标悬停某条会话时显示删除按钮。
6. 删除会话会调用 `DELETE /api/chat/sessions/:id`，先删除 `chat_messages`，再删除 `chat_sessions`。
7. 删除对话不会影响知识库表和 embedding。
8. 之前页面里出现的 `zxzsk`、`new-chat`、`2026-07-01`、`demo` 是前端演示占位，不是数据库数据，已删除。

本次数据库处理：

1. 已清空对话表 `chat_messages`。
2. 已清空会话表 `chat_sessions`。
3. 未清空知识库表，`knowledge_documents` 和 `knowledge_chunks` 保留。

为什么先这样做：

1. 当前第一版核心是装修问答，不先增加项目管理复杂度。
2. 当前数据库还没有 `projects` 项目表。
3. 当前 `chat_sessions` 也还没有 `project_id` 字段。
4. 所以第一版先用对话历史承载所有装修问答会话。

【后期优化重点】正式多项目支持：

1. 新增 `projects` 表，存项目名称、项目描述、项目归属用户。
2. 给 `chat_sessions` 增加 `project_id` 字段。
3. 左侧项目列表从数据库读取，而不是写死在前端。
4. 切换项目时，接口按 `project_id` 过滤该项目下的聊天记录。
5. 如果不同项目要使用不同知识库，还需要给知识库或检索配置增加 `project_id` / `knowledge_scope`。

## 对话请求未完成时的新建/切换规则

问题现象：

```text
用户前一个问题还在生成回答时，立即点击“新对话”并继续提问，页面可能出现请求失败或旧回答写入新对话的问题。
```

原因：

```text
前端原来只有一个全局 isLoading。
旧的 /api/chat 请求未完成时，如果用户新建对话，旧请求返回后仍可能执行：
1. setMessages
2. setActiveConversationId
3. setIsLoading(false)

这样会污染当前新对话的 UI 状态。
```

本次修正：

```text
已在 apps/web/src/app/page.tsx 增加：
1. loadingConversationIds：按会话记录生成状态，而不是全局 isLoading。
2. activeConversationIdRef：判断请求返回时用户是否仍停留在原会话。
3. 新建对话时不取消旧对话生成，旧对话可以继续在后台完成。
4. 切换左侧会话时不取消旧请求，旧回答只写入原 session，不污染当前 UI。
5. 左侧会话生成中时显示“生成中”状态。
```

当前规则：

```text
1. 前一个回答没生成完，可以点击新对话。
2. 不同对话可以同时生成回答。
3. 同一个对话生成中时，暂时不能重复发送第二条，避免同一会话上下文乱序。
4. 旧对话完成后会刷新左侧列表。
5. 如果用户不在旧对话页面，旧回答不会插入当前新对话。
```

【后期优化重点】：

```text
1. 增加“停止生成”按钮，让用户主动中断某个会话的当前回答。
2. /api/chat 后期支持真正的服务端任务取消。
3. 改成 streaming 后，需要按 messageId/sessionId 管理流式写入，避免串话。
4. 左侧可以增加更明显的队列状态，例如生成中、失败、已完成。
```
