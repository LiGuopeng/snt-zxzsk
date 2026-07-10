import { NextResponse } from "next/server";

import { writeChatRequestLog } from "@/lib/ai/chat-logs";
import { createQueryEmbedding, generateChatAnswer } from "@/lib/ai/dashscope";
import { detectIntentProfile } from "@/lib/ai/intent";
import { buildChatMessages, type PromptHistoryMessage } from "@/lib/ai/prompt";
import {
  prepareRetrievedKnowledge,
  retrieveKnowledgeForQuestion,
} from "@/lib/ai/retrieval";
import { createPostgresClient } from "@/lib/db/postgres";

type ChatRequestBody = {
  // 用户本次输入的原始问题。
  message?: unknown;
  // 前端传入已有会话 ID 时，表示继续旧会话；不传则后端创建新会话。
  sessionId?: unknown;
};

// 单条用户输入最大长度，防止超长文本拖慢 embedding、检索和最终回答。
const MAX_MESSAGE_CHARS = 1000;
// 进入 prompt 的历史消息条数上限；只取最近上下文，避免 prompt 无限膨胀。
const HISTORY_LIMIT = 6;
// 追问改写是辅助步骤，必须比最终回答更短超时，避免拖垮主链路。
const QUESTION_REWRITE_TIMEOUT_MS = Number(process.env.CHAT_REWRITE_TIMEOUT_MS || 8000);

// stage_timings 会写入 chat_request_logs，用来定位“到底是哪一步慢”。
// 例如 answer 很高说明模型生成慢，retrieval 很高说明数据库/pgvector 慢。
type ChatStage =
  | "parse_request"
  | "session"
  | "history"
  | "write_user_message"
  | "rewrite_question"
  | "intent"
  | "embedding"
  | "retrieval"
  | "prepare_knowledge"
  | "prompt"
  | "answer"
  | "write_assistant_message"
  | "update_session"
  | "write_log";

/**
 * 创建本次 /api/chat 请求的阶段计时器。
 * 用于把关键步骤耗时写入 chat_request_logs.stage_timings，方便线上排查慢请求。
 */
function createStageTimer() {
  // timings 保存每个阶段累计耗时；同一阶段可能被调用多次，所以用累加。
  const timings: Partial<Record<ChatStage, number>> = {};

  async function track<T>(stage: ChatStage, action: () => Promise<T>) {
    // track 包住异步阶段，成功或失败都会记录耗时，方便排查异常路径。
    const startedAt = Date.now();

    try {
      return await action();
    } finally {
      timings[stage] = (timings[stage] || 0) + Date.now() - startedAt;
    }
  }

  function mark(stage: ChatStage, startedAt: number) {
    // mark 用于同步阶段，例如解析 body、组装 prompt。
    timings[stage] = (timings[stage] || 0) + Date.now() - startedAt;
  }

  function snapshot() {
    return Object.fromEntries(
      Object.entries(timings).map(([stage, durationMs]) => [stage, Math.max(0, Math.round(durationMs || 0))]),
    );
  }

  return {
    mark,
    snapshot,
    timings,
    track,
  };
}

/**
 * 把未知异常统一转成可记录、可返回的字符串。
 * 避免 catch 到非 Error 对象时日志里出现空错误。
 */
function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error";
}

/**
 * 判断异常是否属于超时类问题。
 * DashScope、fetch、AbortSignal 在不同环境下的超时文案不完全一致，所以这里做宽松匹配。
 */
function isTimeoutError(error: unknown) {
  const message = getErrorMessage(error).toLowerCase();

  return (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("aborted") ||
    (error instanceof DOMException && error.name === "TimeoutError")
  );
}

/**
 * 把底层异常转换成前端可理解的错误响应。
 * 当前先区分 AI_TIMEOUT 和 CHAT_FAILED，后续可以继续细分 DB_TIMEOUT、RETRIEVAL_FAILED。
 */
function createChatErrorResponse(error: unknown) {
  if (isTimeoutError(error)) {
    return {
      status: 504,
      body: {
        ok: false,
        error: "AI 服务响应超时，请稍后重试或缩短问题后再问。",
        errorCode: "AI_TIMEOUT",
      },
    };
  }

  return {
    status: 500,
    body: {
      ok: false,
      error: getErrorMessage(error),
      errorCode: "CHAT_FAILED",
    },
  };
}

/**
 * 从请求 body 中提取用户问题。
 * 这里做 trim 和最大长度限制，避免超长输入直接拖慢 embedding、检索和模型回答。
 */
function getRequestMessage(body: ChatRequestBody) {
  // 第一版只接收 message 字段。
  // 后续做多轮对话时，可以扩展 sessionId、history、userId 等字段。
  if (typeof body.message !== "string") {
    return null;
  }

  const message = body.message.trim();

  if (!message) {
    return null;
  }

  return message.slice(0, MAX_MESSAGE_CHARS);
}

/**
 * 从请求 body 中提取会话 ID。
 * 为空表示创建新会话；有值表示继续左侧已有会话。
 */
function getSessionId(body: ChatRequestBody) {
  if (typeof body.sessionId !== "string") {
    return null;
  }

  const sessionId = body.sessionId.trim();

  return sessionId || null;
}

/**
 * 根据用户第一句话生成默认会话标题。
 * 这是轻量标题策略，避免每次新会话都额外调用模型生成标题。
 */
function createTitleFromMessage(message: string) {
  // 第一版用用户第一句话生成会话标题。
  // 后期可以用模型总结标题，比如“卫生间墙砖空鼓整改判断”。
  const title = message.replace(/\s+/g, " ").trim();

  if (title.length <= 18) {
    return title;
  }

  return `${title.slice(0, 18)}...`;
}

/**
 * 读取当前会话最近的用户/助手消息，作为多轮追问上下文。
 * 查询发生在写入当前 user message 之前，因此不会把当前问题重复放进历史。
 */
async function loadRecentHistory(sessionId: string) {
  const sql = createPostgresClient();

  // 查询当前 session 最近几条历史消息。
  // 注意：这个函数在写入当前 user message 之前调用，
  // 所以查到的是“真正的上文”，不会把当前问题重复放进历史。
  const rows = await sql<PromptHistoryMessage[]>`
    select role, content
    from (
      select role, content, created_at
      from public.chat_messages
      where session_id = ${sessionId}
        and role in ('user', 'assistant')
      order by created_at desc
      limit ${HISTORY_LIMIT}
    ) recent_messages
    order by created_at asc
  `;

  return rows.map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

/**
 * 把历史消息压缩成追问改写 prompt 可读的纯文本。
 * 这里只用于检索问题改写，不参与最终 sources 展示。
 */
function buildHistoryText(history: PromptHistoryMessage[]) {
  return history
    .map((item) => `${item.role === "user" ? "用户" : "genengi"}：${item.content.trim()}`)
    .join("\n");
}

/**
 * 将用户追问改写成适合知识库检索的完整问题。
 * 如果改写模型超时，则降级使用原问题，保证主回答链路不断。
 */
async function rewriteQuestionForRetrieval(question: string, history: PromptHistoryMessage[]) {
  // RAG 里有两次“理解问题”：
  // 1. 先把当前问题改写成完整问题，用于 embedding 检索知识库。
  // 2. 再把历史、知识库资料和原始问题交给聊天模型生成回答。
  // 这样用户追问“那卫生间墙上呢？”时，检索会变成“卫生间墙砖空鼓是否需要重铺”这类完整问题。
  if (history.length === 0) {
    return question;
  }

  let rewritten: string;

  try {
    rewritten = await generateChatAnswer(
      [
        {
          role: "system",
          content: [
            "你负责把装修问答里的追问改写成适合知识库检索的完整问题。",
            "只能输出改写后的一个问题，不要解释，不要回答问题。",
            "如果当前问题已经完整，就原样输出。",
            "保留装修对象、空间、阶段、风险点、合同或报价等关键信息。",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            "【最近对话历史】",
            buildHistoryText(history) || "暂无历史对话。",
            "",
            "【当前用户问题】",
            question,
            "",
            "请输出适合检索装修知识库的完整问题：",
          ].join("\n"),
        },
      ],
      {
        timeoutMs: QUESTION_REWRITE_TIMEOUT_MS,
      },
    );
  } catch (error) {
    // 改写只是提升检索质量的辅助步骤，失败或超时不能阻断主回答链路。
    if (isTimeoutError(error)) {
      return question;
    }

    throw error;
  }

  return rewritten.replace(/^["“]|["”]$/g, "").trim().slice(0, MAX_MESSAGE_CHARS) || question;
}

/**
 * AI 装修顾问主入口。
 * 负责会话管理、问题改写、embedding、知识库检索、prompt 组装、模型回答、消息落库和请求日志。
 */
export async function POST(request: Request) {
  // startedAt 用于计算整次 /api/chat 请求总耗时。
  const startedAt = Date.now();
  // stageTimer 记录细分阶段耗时，最终写入 chat_request_logs.stage_timings。
  const stageTimer = createStageTimer();
  // 以下 *_ForLog 变量用于 catch 分支；即使中途失败，也尽量把已知上下文写进日志。
  let activeSessionIdForLog: string | null = null;
  let messageForLog = "";
  let retrievalQuestionForLog: string | undefined;
  let intentProfileForLog: ReturnType<typeof detectIntentProfile> | undefined;
  let retrievalStatsForLog: Awaited<ReturnType<typeof retrieveKnowledgeForQuestion>>["stats"] | undefined;

  try {
    const parseStartedAt = Date.now();
    const body = (await request.json().catch(() => null)) as ChatRequestBody | null;
    const message = body ? getRequestMessage(body) : null;
    const sessionId = body ? getSessionId(body) : null;
    stageTimer.mark("parse_request", parseStartedAt);

    if (!message) {
      return NextResponse.json(
        {
          ok: false,
          error: "message is required",
        },
        { status: 400 },
      );
    }

    messageForLog = message;
    const sql = createPostgresClient();
    // activeSessionId 是本次请求最终使用的会话 ID：来自前端或后端新建。
    let activeSessionId = sessionId;
    // history 是当前问题之前的最近对话，用于追问改写和最终回答上下文。
    let history: PromptHistoryMessage[] = [];

    // 正式会话链路：
    // 如果前端没有传 sessionId，就在后端创建一个新会话。
    // 这样 /api/chat 既支持“已有会话继续问”，也支持“直接发第一句话创建会话”。
    if (!activeSessionId) {
      const [session] = await stageTimer.track("session", () => sql<{ id: string }[]>`
          insert into public.chat_sessions (title, updated_at)
          values (${createTitleFromMessage(message)}, now())
          returning id
        `);

      activeSessionId = session.id;
    } else {
      const existingSessionId = activeSessionId;
      history = await stageTimer.track("history", () => loadRecentHistory(existingSessionId));
    }
    activeSessionIdForLog = activeSessionId;

    // 先写入用户消息，保证即使后面模型调用失败，也能在后台看到用户问了什么。
    await stageTimer.track("write_user_message", () => sql`
        insert into public.chat_messages (session_id, role, content)
        values (${activeSessionId}, 'user', ${message})
      `);

    // 1. 把用户问题转成 query embedding。
    // 这一步不是重复生成知识库 embedding，而是给“本次用户问题”生成查询向量。
    // 如果是追问，会先结合历史改写成完整检索问题，再生成 query embedding。
    // retrievalQuestion 是用于知识库检索的问题；可能是原问题，也可能是结合历史改写后的完整问题。
    const retrievalQuestion = await stageTimer.track("rewrite_question", () =>
      rewriteQuestionForRetrieval(message, history),
    );
    retrievalQuestionForLog = retrievalQuestion;
    const intentStartedAt = Date.now();
    // intentProfile 决定回答策略、强制召回层级和关键词兜底词。
    const intentProfile = detectIntentProfile(retrievalQuestion);
    stageTimer.mark("intent", intentStartedAt);
    intentProfileForLog = intentProfile;
    // queryEmbedding 只用于本次检索，不写入数据库。
    const queryEmbedding = await stageTimer.track("embedding", () => createQueryEmbedding(retrievalQuestion));

    // 2. 用 query embedding 去 PostgreSQL pgvector 检索相关知识片段。
    // 正式上线第一版：普通向量召回 + 意图强制召回 + embedding 缺失时关键词兜底。
    // retrievalResult 包含候选知识片段和召回统计，用于回答和日志审计。
    const retrievalResult = await stageTimer.track("retrieval", () =>
      retrieveKnowledgeForQuestion(queryEmbedding, intentProfile),
    );
    retrievalStatsForLog = retrievalResult.stats;

    // 3. 过滤太短 chunk，并整理 sources。
    // sources 会返回给前端，用来展示答案依据。
    const prepareStartedAt = Date.now();
    // chunks 进入 prompt，sources 返回前端展示；两者都来自同一批召回结果。
    const { chunks, sources } = prepareRetrievedKnowledge(retrievalResult.chunks);
    stageTimer.mark("prepare_knowledge", prepareStartedAt);

    if (chunks.length === 0) {
      const fallbackAnswer =
        "目前没有检索到足够相关的知识库资料，暂时不能直接判断。你可以补充装修阶段、现场照片描述、合同或报价明细，我再帮你继续分析。";

      await stageTimer.track("write_assistant_message", () => sql`
          insert into public.chat_messages (session_id, role, content, sources)
          values (${activeSessionId}, 'assistant', ${fallbackAnswer}, ${sql.json(sources)})
        `);

      await stageTimer.track("write_log", () => writeChatRequestLog({
        sessionId: activeSessionId,
        userMessage: message,
        retrievalQuestion,
        intentProfile,
        retrievalStats: retrievalResult.stats,
        sources,
        answer: fallbackAnswer,
        status: "ok",
        durationMs: Date.now() - startedAt,
        stageTimings: stageTimer.snapshot(),
      }));

      return NextResponse.json({
        ok: true,
        sessionId: activeSessionId,
        answer: fallbackAnswer,
        sources,
      });
    }

    // 4. 把历史对话、用户问题、知识片段、回答规则组装成 messages。
    // 现在模型能看到最近上文，例如用户追问“那如果在卫生间墙上呢？”。
    const promptStartedAt = Date.now();
    const messages = buildChatMessages(message, chunks, history, intentProfile);
    stageTimer.mark("prompt", promptStartedAt);

    // 5. 调用 qwen-plus 生成最终回答。
    const answer = await stageTimer.track("answer", () => generateChatAnswer(messages));

    // 写入 AI 回复和来源，左侧点击会话恢复时会用到。
    await stageTimer.track("write_assistant_message", () => sql`
        insert into public.chat_messages (session_id, role, content, sources)
        values (${activeSessionId}, 'assistant', ${answer}, ${sql.json(sources)})
      `);

    // 更新会话标题和更新时间。
    // 如果还是“新对话”，用用户第一句话替换；已有标题则只更新时间。
    await stageTimer.track("update_session", () => sql`
        update public.chat_sessions
        set title = ${createTitleFromMessage(message)}, updated_at = now()
        where id = ${activeSessionId}
      `);

    await stageTimer.track("write_log", () => writeChatRequestLog({
      sessionId: activeSessionId,
      userMessage: message,
      retrievalQuestion,
      intentProfile,
      retrievalStats: retrievalResult.stats,
      sources,
      answer,
      status: "ok",
      durationMs: Date.now() - startedAt,
      stageTimings: stageTimer.snapshot(),
    }));

    return NextResponse.json({
      ok: true,
      sessionId: activeSessionId,
      answer,
      sources,
    });
  } catch (error) {
    const response = createChatErrorResponse(error);

    await stageTimer.track("write_log", () => writeChatRequestLog({
      sessionId: activeSessionIdForLog,
      userMessage: messageForLog || "unknown",
      retrievalQuestion: retrievalQuestionForLog,
      intentProfile: intentProfileForLog,
      retrievalStats: retrievalStatsForLog,
      status: "error",
      errorMessage: getErrorMessage(error),
      durationMs: Date.now() - startedAt,
      stageTimings: stageTimer.snapshot(),
    }));

    return NextResponse.json(
      response.body,
      { status: response.status },
    );
  }
}
