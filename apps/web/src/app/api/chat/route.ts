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
  message?: unknown;
  sessionId?: unknown;
};

const MAX_MESSAGE_CHARS = 1000;
const HISTORY_LIMIT = 6;

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

function getSessionId(body: ChatRequestBody) {
  if (typeof body.sessionId !== "string") {
    return null;
  }

  const sessionId = body.sessionId.trim();

  return sessionId || null;
}

function createTitleFromMessage(message: string) {
  // 第一版用用户第一句话生成会话标题。
  // 后期可以用模型总结标题，比如“卫生间墙砖空鼓整改判断”。
  const title = message.replace(/\s+/g, " ").trim();

  if (title.length <= 18) {
    return title;
  }

  return `${title.slice(0, 18)}...`;
}

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

function buildHistoryText(history: PromptHistoryMessage[]) {
  return history
    .map((item) => `${item.role === "user" ? "用户" : "genengi"}：${item.content.trim()}`)
    .join("\n");
}

async function rewriteQuestionForRetrieval(question: string, history: PromptHistoryMessage[]) {
  // RAG 里有两次“理解问题”：
  // 1. 先把当前问题改写成完整问题，用于 embedding 检索知识库。
  // 2. 再把历史、知识库资料和原始问题交给聊天模型生成回答。
  // 这样用户追问“那卫生间墙上呢？”时，检索会变成“卫生间墙砖空鼓是否需要重铺”这类完整问题。
  if (history.length === 0) {
    return question;
  }

  const rewritten = await generateChatAnswer([
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
  ]);

  return rewritten.replace(/^["“]|["”]$/g, "").trim().slice(0, MAX_MESSAGE_CHARS) || question;
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  let activeSessionIdForLog: string | null = null;
  let messageForLog = "";
  let retrievalQuestionForLog: string | undefined;
  let intentProfileForLog: ReturnType<typeof detectIntentProfile> | undefined;
  let retrievalStatsForLog: Awaited<ReturnType<typeof retrieveKnowledgeForQuestion>>["stats"] | undefined;

  try {
    const body = (await request.json().catch(() => null)) as ChatRequestBody | null;
    const message = body ? getRequestMessage(body) : null;
    const sessionId = body ? getSessionId(body) : null;

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
    let activeSessionId = sessionId;
    let history: PromptHistoryMessage[] = [];

    // 正式会话链路：
    // 如果前端没有传 sessionId，就在后端创建一个新会话。
    // 这样 /api/chat 既支持“已有会话继续问”，也支持“直接发第一句话创建会话”。
    if (!activeSessionId) {
      const [session] = await sql<{ id: string }[]>`
        insert into public.chat_sessions (title, updated_at)
        values (${createTitleFromMessage(message)}, now())
        returning id
      `;

      activeSessionId = session.id;
    } else {
      history = await loadRecentHistory(activeSessionId);
    }
    activeSessionIdForLog = activeSessionId;

    // 先写入用户消息，保证即使后面模型调用失败，也能在后台看到用户问了什么。
    await sql`
      insert into public.chat_messages (session_id, role, content)
      values (${activeSessionId}, 'user', ${message})
    `;

    // 1. 把用户问题转成 query embedding。
    // 这一步不是重复生成知识库 embedding，而是给“本次用户问题”生成查询向量。
    // 如果是追问，会先结合历史改写成完整检索问题，再生成 query embedding。
    const retrievalQuestion = await rewriteQuestionForRetrieval(message, history);
    retrievalQuestionForLog = retrievalQuestion;
    const intentProfile = detectIntentProfile(retrievalQuestion);
    intentProfileForLog = intentProfile;
    const queryEmbedding = await createQueryEmbedding(retrievalQuestion);

    // 2. 用 query embedding 去 PostgreSQL pgvector 检索相关知识片段。
    // 正式上线第一版：普通向量召回 + 意图强制召回 + embedding 缺失时关键词兜底。
    const retrievalResult = await retrieveKnowledgeForQuestion(queryEmbedding, intentProfile);
    retrievalStatsForLog = retrievalResult.stats;

    // 3. 过滤太短 chunk，并整理 sources。
    // sources 会返回给前端，用来展示答案依据。
    const { chunks, sources } = prepareRetrievedKnowledge(retrievalResult.chunks);

    if (chunks.length === 0) {
      const fallbackAnswer =
        "目前没有检索到足够相关的知识库资料，暂时不能直接判断。你可以补充装修阶段、现场照片描述、合同或报价明细，我再帮你继续分析。";

      await sql`
        insert into public.chat_messages (session_id, role, content, sources)
        values (${activeSessionId}, 'assistant', ${fallbackAnswer}, ${sql.json(sources)})
      `;

      await writeChatRequestLog({
        sessionId: activeSessionId,
        userMessage: message,
        retrievalQuestion,
        intentProfile,
        retrievalStats: retrievalResult.stats,
        sources,
        answer: fallbackAnswer,
        status: "ok",
        durationMs: Date.now() - startedAt,
      });

      return NextResponse.json({
        ok: true,
        sessionId: activeSessionId,
        answer: fallbackAnswer,
        sources,
      });
    }

    // 4. 把历史对话、用户问题、知识片段、回答规则组装成 messages。
    // 现在模型能看到最近上文，例如用户追问“那如果在卫生间墙上呢？”。
    const messages = buildChatMessages(message, chunks, history, intentProfile);

    // 5. 调用 qwen-plus 生成最终回答。
    const answer = await generateChatAnswer(messages);

    // 写入 AI 回复和来源，左侧点击会话恢复时会用到。
    await sql`
      insert into public.chat_messages (session_id, role, content, sources)
      values (${activeSessionId}, 'assistant', ${answer}, ${sql.json(sources)})
    `;

    // 更新会话标题和更新时间。
    // 如果还是“新对话”，用用户第一句话替换；已有标题则只更新时间。
    await sql`
      update public.chat_sessions
      set title = ${createTitleFromMessage(message)}, updated_at = now()
      where id = ${activeSessionId}
    `;

    await writeChatRequestLog({
      sessionId: activeSessionId,
      userMessage: message,
      retrievalQuestion,
      intentProfile,
      retrievalStats: retrievalResult.stats,
      sources,
      answer,
      status: "ok",
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json({
      ok: true,
      sessionId: activeSessionId,
      answer,
      sources,
    });
  } catch (error) {
    await writeChatRequestLog({
      sessionId: activeSessionIdForLog,
      userMessage: messageForLog || "unknown",
      retrievalQuestion: retrievalQuestionForLog,
      intentProfile: intentProfileForLog,
      retrievalStats: retrievalStatsForLog,
      status: "error",
      errorMessage: error instanceof Error ? error.message : "Unknown error",
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
