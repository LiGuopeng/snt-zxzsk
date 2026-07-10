# AI 装修顾问优化文档

## 1. 项目链路调用关系

AI 装修顾问当前是一条 RAG 链路：前端负责会话交互，后端负责会话管理、知识库检索、模型调用和日志记录，PostgreSQL 负责保存知识库、会话和审计数据，DashScope 负责 embedding 与回答生成。

### 1.1 总体调用链路

```mermaid
flowchart TD
  U["用户"] --> FE["前端聊天界面"]
  FE --> API["POST /api/chat"]
  API --> S1["创建或读取 chat_sessions"]
  API --> S2["写入 user chat_messages"]
  API --> H["读取最近历史 chat_messages"]
  H --> RW["追问改写"]
  RW --> EMB["DashScope Embedding"]
  EMB --> RET["PostgreSQL pgvector 检索 knowledge_chunks"]
  RET --> SRC["整理 chunks 和 sources"]
  SRC --> PROMPT["组装 prompt"]
  PROMPT --> LLM["DashScope Chat"]
  LLM --> SAVE["写入 assistant chat_messages"]
  SAVE --> LOG["写入 chat_request_logs"]
  LOG --> FE
```

### 1.2 前端到后端

```text
前端聊天组件
-> POST /api/chat
-> body: { message, sessionId? }
-> response: { ok, sessionId, answer, sources }
```

说明：

```text
message 是用户当前问题。
sessionId 存在时继续旧会话。
sessionId 不存在时后端创建新会话。
answer 是 AI 装修顾问回答。
sources 是本次回答引用的知识库来源。
```

### 1.3 后端内部模块调用

```text
apps/web/src/app/api/chat/route.ts
-> apps/web/src/lib/ai/intent.ts
-> apps/web/src/lib/ai/dashscope.ts
-> apps/web/src/lib/ai/retrieval.ts
-> apps/web/src/lib/ai/prompt.ts
-> apps/web/src/lib/ai/chat-logs.ts
-> apps/web/src/lib/db/postgres.ts
```

职责关系：

```text
route.ts：串联整个聊天请求生命周期。
intent.ts：识别用户问题意图，决定回答策略和强制召回层级。
dashscope.ts：调用 DashScope embedding、chat 和 vision 能力。
retrieval.ts：执行 pgvector 检索、关键词兜底、sources 去重。
prompt.ts：拼装知识库上下文、历史上下文和回答规则。
chat-logs.ts：记录每次请求的耗时、召回统计和错误。
postgres.ts：提供 PostgreSQL 连接池。
```

### 1.4 方法级调用链

下面按一次正常提问的执行顺序说明方法之间的来回调用关系。

```text
POST /api/chat
  -> request.json()
  -> getRequestMessage(body)
  -> getSessionId(body)
  -> createPostgresClient()
  -> createTitleFromMessage(message)
  -> insert chat_sessions
  -> insert chat_messages(user)
  -> rewriteQuestionForRetrieval(message, history)
       -> buildHistoryText(history)
       -> generateChatAnswer(messages, { timeoutMs: CHAT_REWRITE_TIMEOUT_MS })
            -> getDashScopeChatCompletionsUrl()
            -> getDashScopeApiKey()
            -> getChatModel()
            -> createTimeoutSignal(timeoutMs)
            -> parseDashScopeResponse(response)
  -> detectIntentProfile(retrievalQuestion)
  -> createQueryEmbedding(retrievalQuestion)
       -> getDashScopeEmbeddingsUrl()
       -> getDashScopeApiKey()
       -> getEmbeddingModel()
       -> getEmbeddingDimension()
       -> createTimeoutSignal()
       -> parseDashScopeResponse(response)
  -> retrieveKnowledgeForQuestion(queryEmbedding, intentProfile)
       -> matchKnowledgeChunks(queryEmbedding)
            -> createPostgresClient()
            -> toVectorLiteral(queryEmbedding)
            -> public.match_knowledge_chunks(...)
       -> matchKnowledgeChunks(queryEmbedding, { layerFilter })
       -> matchKeywordKnowledgeChunks(intentProfile) 兜底
            -> escapeIlikeValue(keyword)
            -> scoreKeywordChunk(chunk, keywords)
       -> mergeChunks([baseChunks, forcedGroups])
  -> prepareRetrievedKnowledge(retrievalResult.chunks)
       -> isUsefulChunk(chunk)
       -> dedupeSources(chunks, DEFAULT_SOURCE_COUNT)
  -> buildChatMessages(message, chunks, history, intentProfile)
       -> buildKnowledgeContext(chunks)
            -> formatChunk(chunk, index)
       -> buildHistoryContext(history)
       -> buildAnswerPolicyContext(intentProfile)
  -> generateChatAnswer(messages)
       -> getDashScopeChatCompletionsUrl()
       -> getDashScopeApiKey()
       -> getChatModel()
       -> createTimeoutSignal()
       -> parseDashScopeResponse(response)
  -> insert chat_messages(assistant)
  -> update chat_sessions
  -> writeChatRequestLog(...)
       -> createPostgresClient()
       -> insert chat_request_logs
  -> NextResponse.json({ ok, sessionId, answer, sources })
```

### 1.5 route.ts 内部关键方法职责

```text
createStageTimer()
记录本次请求每个阶段耗时，最后写入 chat_request_logs.stage_timings。

getErrorMessage(error)
把 unknown 异常统一变成字符串，保证日志和接口响应可读。

isTimeoutError(error)
判断是否为超时类异常，用于返回 AI_TIMEOUT。

createChatErrorResponse(error)
把底层异常转换成前端可识别的错误结构。

getRequestMessage(body)
校验并截断用户问题。

getSessionId(body)
读取前端传入的会话 ID。

createTitleFromMessage(message)
用第一句话生成默认会话标题。

loadRecentHistory(sessionId)
读取已有会话最近几条 user/assistant 消息。

buildHistoryText(history)
把历史消息转换成追问改写 prompt 使用的文本。

rewriteQuestionForRetrieval(question, history)
把追问改写成完整检索问题；超时则降级为原问题。

POST(request)
AI 装修顾问主入口，串联会话、检索、prompt、模型回答和日志。
```

### 1.6 retrieval.ts 内部关键方法职责

```text
matchKnowledgeChunks(queryEmbedding, options)
调用 PostgreSQL 函数 public.match_knowledge_chunks 做向量召回。

matchKeywordKnowledgeChunks(intentProfile, options)
向量召回为空时，用关键词 ilike 兜底检索。

retrieveKnowledgeForQuestion(queryEmbedding, intentProfile)
检索主入口：普通向量召回 + 意图强制召回 + 关键词兜底。

prepareRetrievedKnowledge(chunks)
过滤过短 chunk，整理进入 prompt 的 chunks 和返回前端的 sources。
```

### 1.7 dashscope.ts 内部关键方法职责

```text
createQueryEmbedding(question)
调用 DashScope embedding，把用户问题转成 query embedding。

generateChatAnswer(messages, options)
调用 DashScope chat 模型，生成追问改写或最终回答。

parseDashScopeResponse(response)
统一解析 DashScope 响应；失败时保留服务端错误 body。

createTimeoutSignal(timeoutMs)
为 DashScope 请求创建超时控制。
```

### 1.8 prompt.ts 内部关键方法职责

```text
buildKnowledgeContext(chunks)
把知识库 chunks 拼成模型上下文，并控制最大长度。

buildHistoryContext(history)
把最近对话整理成简短上下文。

buildAnswerPolicyContext(intentProfile)
根据用户意图生成回答策略。

buildChatMessages(question, chunks, history, intentProfile)
组装最终传给 DashScope chat 的 system/user messages。
```

### 1.9 成功路径的数据写入顺序

```text
1. 如果没有 sessionId：
   insert chat_sessions

2. 先保存用户问题：
   insert chat_messages(role = 'user')

3. 检索、组装 prompt、生成回答。

4. 保存 AI 回复：
   insert chat_messages(role = 'assistant', sources = ...)

5. 更新会话更新时间：
   update chat_sessions set updated_at = now()

6. 保存请求日志：
   insert chat_request_logs(status = 'ok', retrieval_stats, stage_timings, sources)
```

这样设计的原因：

```text
即使模型回答失败，也能看到用户问了什么。
即使日志写入失败，也不影响用户拿到回答。
会话消息和请求日志分开，方便前端恢复会话，也方便后台排查。
```

### 1.10 失败路径的数据写入顺序

```text
1. 如果失败发生在用户消息写入之后：
   chat_messages 中至少保留 user 消息。

2. catch 分支调用 createChatErrorResponse(error)：
   超时返回 AI_TIMEOUT。
   普通异常返回 CHAT_FAILED。

3. catch 分支调用 writeChatRequestLog：
   写入 status = 'error'
   写入 error_message
   写入已采集到的 retrieval_question / intent_profile / retrieval_stats
   写入 stage_timings

4. 返回前端：
   { ok: false, error, errorCode }
```

失败路径的核心目标：

```text
用户能看到可理解错误。
程序员能从 chat_request_logs.stage_timings 判断慢在哪一步。
错误不会静默丢失。
```

### 1.11 数据库调用关系

```mermaid
flowchart LR
  API["/api/chat"] --> CS["chat_sessions"]
  API --> CM["chat_messages"]
  API --> CRL["chat_request_logs"]
  API --> KC["knowledge_chunks"]
  KC --> KD["knowledge_documents"]
```

表作用：

```text
chat_sessions：左侧会话列表。
chat_messages：用户消息、AI 回复和 sources。
chat_request_logs：请求审计、错误排查和阶段耗时。
knowledge_documents：知识库原始文档。
knowledge_chunks：知识库切片和 embedding，是 RAG 检索核心表。
```

### 1.12 外部服务调用关系

```text
DashScope Embedding
用途：把用户问题转成 query embedding。
调用位置：createQueryEmbedding。

DashScope Chat
用途：追问改写、最终回答生成。
调用位置：generateChatAnswer。

PostgreSQL pgvector
用途：按向量相似度检索 knowledge_chunks。
调用位置：matchKnowledgeChunks。
```

### 1.13 当前与效果图模块的边界

```text
AI 装修顾问：负责知识库问答、咨询判断、解释和建议。
效果图生成模块：负责户型图上传、户型解析、全屋效果图、空间效果图。
```

本优化文档只处理 AI 装修顾问链路，不改效果图生成模块。

## 2. 优化目标

AI 装修顾问的目标不是单纯“能回答”，而是做到接近 GPT 类产品的使用体验：

```text
用户输入问题
系统理解问题
自动检索知识库
结合历史上下文
生成专业、克制、可执行的回答
保存会话记录
失败时能明确告诉用户卡在哪一步
```

本阶段只优化 AI 装修顾问，不改效果图生成模块。

## 3. 当前现状

### 3.1 当前功能链路

当前 `/api/chat` 的主流程如下：

```mermaid
flowchart TD
  A["用户输入装修问题"] --> B["创建或读取 chat_session"]
  B --> C["保存用户消息 chat_messages"]
  C --> D["读取最近历史消息"]
  D --> E["追问改写成检索问题"]
  E --> F["调用 DashScope 生成 query embedding"]
  F --> G["PostgreSQL pgvector 检索 knowledge_chunks"]
  G --> H["过滤 chunk 并整理 sources"]
  H --> I["拼装 prompt"]
  I --> J["调用 DashScope chat 模型生成回答"]
  J --> K["保存 assistant 消息和 sources"]
  K --> L["返回 answer + sources"]
```

### 3.2 当前涉及代码

```text
apps/web/src/app/api/chat/route.ts
聊天主接口，负责会话、历史、检索、回答、日志。

apps/web/src/lib/ai/dashscope.ts
DashScope embedding 和 chat 模型调用。

apps/web/src/lib/ai/retrieval.ts
知识库向量检索、关键词兜底、sources 整理。

apps/web/src/lib/ai/prompt.ts
知识库上下文、历史上下文、回答策略 prompt 组装。

apps/web/src/lib/ai/intent.ts
识别用户问题意图，决定回答策略和强制召回层级。

apps/web/src/lib/ai/chat-logs.ts
记录每次请求的检索问题、召回统计、错误和耗时。
```

### 3.3 当前数据表

```text
chat_sessions
保存左侧会话记录。

chat_messages
保存用户消息、AI 回复和 sources。

chat_request_logs
保存接口请求日志、检索统计、错误信息和耗时。

knowledge_documents
保存知识库文档。

knowledge_chunks
保存知识库切片、embedding、层级、模块、关键词等检索字段。
```

## 4. 当前主要问题

### 4.1 用户体感慢

当前接口是一次性 JSON 返回：

```text
模型没有完整生成完之前，前端看不到任何内容。
如果模型 20 到 30 秒才返回，用户会感觉页面卡死。
```

这和 GPT 的体验差距最大。GPT 是边生成边展示。

### 4.2 超时错误不够清楚

当前用户可能看到：

```text
The operation was aborted due to timeout
```

这个错误不能告诉用户到底是：

```text
数据库慢
知识库检索慢
DashScope embedding 慢
DashScope chat 慢
网络慢
```

### 4.3 检索和回答耦合较重

当前 `/api/chat` 同时负责：

```text
会话创建
历史读取
追问改写
embedding
知识库检索
prompt 拼接
模型回答
消息保存
日志记录
```

功能能跑，但后续扩展流式输出、工具调用、阶段状态会越来越难维护。

### 4.4 Prompt 上下文可能过长

知识库 chunks、历史消息、回答策略都拼进 prompt。上下文越长：

```text
模型响应越慢
超时概率越高
回答可能变啰嗦
成本也更高
```

### 4.5 缺少阶段状态

当前用户只看到“等待回答”。更好的体验应该展示：

```text
正在理解问题
正在检索知识库
正在生成回答
```

## 5. 优化原则

### 5.1 以装修顾问核心体验为优先

优化目标不是照搬 GPT 的所有能力，而是优先把装修顾问场景里的核心体验做好。所有能力都要服务于下面这些目标：

```text
回答准确
依据清楚
响应可感知
出错可解释
会话可追溯
结果可继续追问
```

流式输出、记忆、工具调用和 Agent Router 都是手段，不是目标。只有当它们能提升装修咨询体验时，才进入实施范围。

### 5.2 知识库优先

AI 装修顾问必须优先基于知识库回答，不直接凭模型常识乱判断。

```text
知识库有依据：结合资料回答。
知识库不足：说明不能直接判断，并让用户补充信息。
```

### 5.3 先优化体验，再做复杂 Agent

当前优化顺序：

```text
第一步：先解决超时和错误不清楚的问题。
第二步：把回答改成流式输出，减少用户等待感。
第三步：增加阶段状态，让用户知道系统正在检索、思考还是生成。
第四步：优化短期记忆，让多轮追问更自然。
第五步：沉淀项目记忆，记录用户户型、预算、风格和重点问题。
第六步：再做 Agent Router，让系统自动判断是否调用知识库、项目记忆或其他工具。
```

这个顺序的原因：

```text
稳定性是底座。
流式输出最能改善用户体感。
阶段状态能降低用户焦虑。
记忆能力决定多轮对话质量。
Agent Router 复杂度最高，必须等前面链路稳定后再做。
```

## 6. 分阶段优化步骤

## 第 1 阶段：稳定性和超时优化

目标：

```text
减少接口 30 秒超时
错误信息更清楚
日志能定位是哪一步慢
```

要做：

```text
1. 给追问改写设置更短超时。
2. 追问改写失败时自动降级为原问题，不阻断主回答。
3. 降低默认召回 chunk 数量。
4. 限制 prompt 上下文长度。
5. 区分 AI_TIMEOUT、CHAT_FAILED 等错误码。
6. chat_request_logs 记录每个阶段耗时。
```

预期效果：

```text
用户不再只看到笼统 timeout。
开发者能从日志知道是检索慢还是模型慢。
简单问题回答速度更快。
```

已落地：

```text
1. CHAT_REWRITE_TIMEOUT_MS 控制追问改写超时，默认 8000ms。
2. 追问改写超时自动降级为原问题，不阻断主回答链路。
3. 默认向量召回从 8 条降到 6 条。
4. sources 默认从 6 条降到 4 条。
5. 强制层级召回从 4 条降到 3 条。
6. prompt 知识库上下文从 9000 字降到 6000 字。
7. 历史上下文从 3000 字降到 1800 字。
8. 超时统一返回 errorCode = AI_TIMEOUT。
9. 普通失败返回 errorCode = CHAT_FAILED。
10. chat_request_logs 新增 stage_timings，记录 parse_request、session、history、rewrite_question、embedding、retrieval、prompt、answer、write_log 等阶段耗时。
```

排查方式：

```sql
select
  created_at,
  status,
  error_message,
  duration_ms,
  stage_timings
from public.chat_request_logs
order by created_at desc
limit 20;
```

## 第 2 阶段：流式输出

目标：

```text
让 AI 装修顾问像 GPT 一样边生成边显示。
```

要做：

```text
1. 新增或改造 /api/chat 为 streaming response。
2. 后端使用 ReadableStream 输出 token 或文本片段。
3. 前端聊天组件读取 stream。
4. 回答生成过程中显示光标和加载状态。
5. 流结束后再保存完整 assistant 消息。
6. 流失败时保存错误日志，并允许用户重试。
```

接口形态：

```text
POST /api/chat
返回 text/event-stream 或 ReadableStream
```

前端体验：

```text
用户发送问题后立即看到“正在检索知识库”。
检索完成后开始逐字显示回答。
用户不再面对长时间空白等待。
```

## 第 3 阶段：阶段状态反馈

目标：

```text
让用户知道系统正在做什么，而不是只看到一个 loading。
```

要做：

```text
1. 后端在 stream 中输出阶段事件。
2. 前端展示阶段文案。
3. 阶段失败时返回明确错误。
```

阶段建议：

```text
thinking: 正在理解问题
retrieving: 正在检索知识库
answering: 正在生成回答
done: 回答完成
error: 回答失败
```

## 第 4 阶段：短期记忆优化

目标：

```text
让多轮追问更自然。
```

当前只取最近 6 条消息。后续可以优化为：

```text
1. 最近消息保留。
2. 超长历史做摘要。
3. 会话摘要保存到 chat_sessions 或独立表。
4. 追问改写优先使用摘要 + 最近几条消息。
```

新增字段建议：

```sql
alter table public.chat_sessions
add column if not exists summary text,
add column if not exists memory jsonb not null default '{}'::jsonb;
```

## 第 5 阶段：装修项目记忆

目标：

```text
AI 装修顾问能记住用户的房屋信息、预算、风格和当前问题背景。
```

建议记忆内容：

```text
房屋户型
装修阶段
装修方式
预算区间
偏好风格
重点担忧
已经咨询过的问题
```

后续可新增：

```text
user_project_profiles
```

但本阶段先不建表，先把 chat 稳定性和流式体验做好。

## 第 6 阶段：Agent Router

目标：

```text
让 AI 装修顾问能判断该调用知识库、项目记忆、户型解析结果，还是普通回答。
```

示例：

```text
用户问“水电增项 8000 合理吗？”
-> 检索知识库

用户问“我这个户型厨房动线是不是不好？”
-> 读取户型解析结果 + 检索知识库

用户问“帮我重新生成厨房”
-> 不由装修顾问直接回答，提示去效果图模块或调用空间生成工具
```

本阶段暂不实现，等基础聊天体验稳定后再做。

## 6. 推荐立即执行的改动

第一批先做这些：

```text
1. /api/chat 增加错误分类。
2. 追问改写设置短超时，失败降级。
3. 降低知识库召回数量。
4. 降低 prompt 最大上下文长度。
5. 新增前端错误提示文案。
6. 准备流式输出改造方案。
```

## 7. 验证标准

### 7.1 基础问题

问题：

```text
水电增项 8000 是不是被坑了？
```

预期：

```text
能返回回答
能返回 sources
chat_messages 有 user 和 assistant 两条记录
chat_request_logs 状态为 ok
```

### 7.2 追问

第一问：

```text
卫生间墙砖空鼓怎么办？
```

追问：

```text
那如果已经贴完很久了呢？
```

预期：

```text
系统能结合上文理解“已经贴完很久”的对象是卫生间墙砖空鼓。
```

### 7.3 超时

人为降低超时测试：

```env
DASHSCOPE_TIMEOUT_MS=1000
```

预期：

```text
接口返回 errorCode = AI_TIMEOUT
用户看到“AI 服务响应超时，请稍后重试或缩短问题后再问”
chat_request_logs 有错误记录
```

## 8. 上线注意事项

服务器 `.env.local` 建议：

```env
DASHSCOPE_TIMEOUT_MS=90000
CHAT_REWRITE_TIMEOUT_MS=8000
```

如果只改环境变量：

```bash
pm2 restart snt-zxzsk-web --update-env
```

如果改了代码：

```bash
cd /www/snt-zxzsk
bash scripts/deploy-baota.sh
```

## 9. 当前结论

AI 装修顾问已经具备基础 RAG 能力，但离 GPT 式体验还差：

```text
流式输出
阶段状态
更强记忆
更清楚的错误恢复
更标准的 Agent 调度
```

短期最优先做：

```text
先把 /api/chat 稳定性和超时处理做好。
然后改造成流式输出。
```
