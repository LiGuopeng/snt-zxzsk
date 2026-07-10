import { writeChatRequestLog } from "@/lib/ai/chat-logs";
import { createQueryEmbedding, generateChatAnswer, generateChatAnswerStream } from "@/lib/ai/dashscope";
import { detectIntentProfile } from "@/lib/ai/intent";
import { buildChatMessages, type PromptHistoryMessage } from "@/lib/ai/prompt";
import {
  type KnowledgeChunk,
  type KnowledgeSource,
  prepareRetrievedKnowledge,
  retrieveKnowledgeForQuestion,
} from "@/lib/ai/retrieval";
import { createPostgresClient } from "@/lib/db/postgres";

type ChatStreamRequestBody = {
  // 用户本次输入的原始问题。
  message?: unknown;
  // 前端传入已有会话 ID 时，表示继续旧会话；不传则后端创建新会话。
  sessionId?: unknown;
};

type ChatStreamStage =
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
  | "evidence"
  | "write_assistant_message"
  | "update_session"
  | "write_log";

const MAX_MESSAGE_CHARS = 1000;
const HISTORY_LIMIT = 6;
const QUESTION_REWRITE_TIMEOUT_MS = Number(process.env.CHAT_REWRITE_TIMEOUT_MS || 8000);
const ANSWER_EVIDENCE_TIMEOUT_MS = Number(process.env.CHAT_EVIDENCE_TIMEOUT_MS || 10000);
const SIMPLE_EVIDENCE_SOURCE_LIMIT = 2;
const NORMAL_EVIDENCE_SOURCE_LIMIT = 3;
const COMPLEX_EVIDENCE_SOURCE_LIMIT = 4;

/**
 * 创建流式接口使用的阶段计时器。
 * 计时字段和 /api/chat 保持一致，方便 JSON 接口与 stream 接口统一排查。
 */
function createStageTimer() {
  const timings: Partial<Record<ChatStreamStage, number>> = {};

  async function track<T>(stage: ChatStreamStage, action: () => Promise<T>) {
    const startedAt = Date.now();

    try {
      return await action();
    } finally {
      timings[stage] = (timings[stage] || 0) + Date.now() - startedAt;
    }
  }

  function mark(stage: ChatStreamStage, startedAt: number) {
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
    track,
  };
}

/**
 * 将服务端事件编码成 SSE 文本。
 * 前端按 event/data 解析，分别处理 stage、session、token、done、error。
 */
function encodeEvent(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * 从请求 body 中提取用户问题。
 * 和 JSON 接口保持同样的长度限制，避免两条链路行为不一致。
 */
function getRequestMessage(body: ChatStreamRequestBody) {
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
 * 为空表示本次流式请求需要后端创建新会话。
 */
function getSessionId(body: ChatStreamRequestBody) {
  if (typeof body.sessionId !== "string") {
    return null;
  }

  const sessionId = body.sessionId.trim();

  return sessionId || null;
}

/**
 * 生成轻量会话标题。
 * 保持和 /api/chat 一致，避免流式和非流式创建出的会话标题规则不同。
 */
function createTitleFromMessage(message: string) {
  const title = message.replace(/\s+/g, " ").trim();

  if (title.length <= 18) {
    return title;
  }

  return `${title.slice(0, 18)}...`;
}

/**
 * 加载当前会话最近历史消息。
 * 流式输出仍然需要历史上下文，否则多轮追问会退化成单轮问答。
 */
async function loadRecentHistory(sessionId: string) {
  const sql = createPostgresClient();
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
 * 把历史消息整理成追问改写模型需要的文本。
 * 这里只服务 retrieval question rewrite，不直接展示给用户。
 */
function buildHistoryText(history: PromptHistoryMessage[]) {
  return history
    .map((item) => `${item.role === "user" ? "用户" : "genengi"}：${item.content.trim()}`)
    .join("\n");
}

/**
 * 流式链路中的追问改写。
 * 如果改写超时，直接使用原问题继续检索，保证用户能尽快看到后续阶段。
 */
async function rewriteQuestionForRetrieval(question: string, history: PromptHistoryMessage[]) {
  if (history.length === 0) {
    return question;
  }

  try {
    const rewritten = await generateChatAnswer(
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

    return rewritten.replace(/^["“]|["”]$/g, "").trim().slice(0, MAX_MESSAGE_CHARS) || question;
  } catch (error) {
    if (isTimeoutError(error)) {
      return question;
    }

    throw error;
  }
}

/**
 * 将未知异常转换成字符串，保证 SSE error 事件和日志都有可读错误信息。
 */
function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error";
}

/**
 * 判断是否为超时类异常。
 * 和 JSON 接口保持一致，方便前端统一展示 AI_TIMEOUT。
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
 * 将异常转换成流式接口的错误事件体。
 * 流式请求中途失败时 HTTP 状态通常已经是 200，所以错误要通过 SSE 事件通知前端。
 */
function createStreamError(error: unknown) {
  if (isTimeoutError(error)) {
    return {
      error: "AI 服务响应超时，请稍后重试或缩短问题后再问。",
      errorCode: "AI_TIMEOUT",
    };
  }

  return {
    error: getErrorMessage(error),
    errorCode: "CHAT_FAILED",
  };
}

/**
 * 判断本次问题需要展示多少条依据。
 * 这里故意用可解释规则，而不是再调用一次模型：快、稳定，也方便后期按业务反馈调整。
 */
function getEvidenceSourceLimit(question: string, intentProfile: ReturnType<typeof detectIntentProfile>) {
  const compactQuestion = question.replace(/\s+/g, "");
  const complexLabels = ["合同签约", "付款报价", "维权争议", "安全风险"];
  const hasComplexLabel = intentProfile.labels.some((label) => complexLabels.includes(label));
  const asksForProcess = intentProfile.detailLevel === "detailed";
  const isLongQuestion = compactQuestion.length >= 40;
  const hasMultipleSignals = intentProfile.labels.length >= 2;

  if (asksForProcess || isLongQuestion || hasComplexLabel || hasMultipleSignals) {
    return COMPLEX_EVIDENCE_SOURCE_LIMIT;
  }

  if (compactQuestion.length >= 18 || intentProfile.labels.length === 1) {
    return NORMAL_EVIDENCE_SOURCE_LIMIT;
  }

  return SIMPLE_EVIDENCE_SOURCE_LIMIT;
}

/**
 * 给检索兜底来源补充 retrieved 模式并按复杂度截断。
 * 当二次依据筛选失败时，前端会据此显示“知识库检索依据”，避免误称“实际采用依据”。
 */
function createRetrievedFallbackSources(sources: KnowledgeSource[], sourceLimit: number) {
  return sources.slice(0, sourceLimit).map((source) => ({
    ...source,
    mode: "retrieved" as const,
  }));
}

/**
 * 把候选知识片段整理成“引用判定”模型可读的短文本。
 * 这里只保留 chunk id、来源和截断正文，避免二次判定 prompt 过长。
 */
function buildEvidenceCandidateText(chunks: KnowledgeChunk[]) {
  return chunks
    .slice(0, 10)
    .map((chunk, index) =>
      [
        `【候选 ${index + 1}】`,
        `chunk_id：${chunk.id}`,
        `来源文件：${chunk.source_file}`,
        `章节：${chunk.section || chunk.title || "未标注"}`,
        `层级：${chunk.layer || "未标注"}`,
        `模块：${chunk.module || "未标注"}`,
        "内容：",
        chunk.content.trim().slice(0, 700),
      ].join("\n"),
    )
    .join("\n\n---\n\n");
}

/**
 * 从模型返回中提取 JSON 对象。
 * 引用判定要求模型只返回 JSON，但这里仍兼容 ```json code fence，提升稳定性。
 */
function parseEvidenceJson(content: string) {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonText = fenced?.[1]?.trim() || trimmed;
  const start = jsonText.indexOf("{");
  const end = jsonText.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Evidence response does not contain a JSON object");
  }

  return JSON.parse(jsonText.slice(start, end + 1)) as {
    sources?: Array<{
      chunk_id?: unknown;
      reason?: unknown;
    }>;
  };
}

/**
 * 在回答生成完成后，反向判断“哪些知识片段真正支撑了本次答案”。
 * 注意：这一步不重新检索知识库，只在已经传给回答模型的候选 chunks 里筛选。
 */
async function selectAnswerSources(
  answer: string,
  chunks: KnowledgeChunk[],
  fallbackSources: KnowledgeSource[],
  sourceLimit: number,
) {
  const retrievedFallbackSources = createRetrievedFallbackSources(fallbackSources, sourceLimit);

  if (!answer.trim() || chunks.length === 0) {
    return retrievedFallbackSources;
  }

  try {
    const payloadText = await generateChatAnswer(
      [
        {
          role: "system",
          content: [
            "你负责判断装修问答答案实际使用了哪些知识库候选资料。",
            "只能从候选资料里选择，不能新增来源。",
            "只选择能直接支撑答案关键结论或建议的资料。",
            "如果某条资料只是相似但答案没有使用，不要选择。",
            `最多选择 ${sourceLimit} 条。`,
            "必须只返回 JSON，不要解释。",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            "【AI 最终回答】",
            answer,
            "",
            "【候选知识资料】",
            buildEvidenceCandidateText(chunks),
            "",
            "请返回 JSON，格式：",
            '{"sources":[{"chunk_id":"knowledge_chunks.id","reason":"这条资料支撑了答案里的哪个判断，20字以内"}]}',
          ].join("\n"),
        },
      ],
      {
        timeoutMs: ANSWER_EVIDENCE_TIMEOUT_MS,
      },
    );
    const payload = parseEvidenceJson(payloadText);
    const chunkById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    const selectedSources: KnowledgeSource[] = [];
    const seen = new Set<string>();

    for (const item of payload.sources || []) {
      if (typeof item.chunk_id !== "string" || seen.has(item.chunk_id)) {
        continue;
      }

      const chunk = chunkById.get(item.chunk_id);

      if (!chunk) {
        continue;
      }

      seen.add(item.chunk_id);
      selectedSources.push({
        mode: "used",
        chunk_id: chunk.id,
        source_file: chunk.source_file,
        section: chunk.section,
        layer: chunk.layer,
        module: chunk.module,
        similarity: chunk.similarity,
        reason: typeof item.reason === "string" ? item.reason.trim().slice(0, 60) : undefined,
      });

      if (selectedSources.length >= sourceLimit) {
        break;
      }
    }

    return selectedSources.length > 0 ? selectedSources : retrievedFallbackSources;
  } catch {
    return retrievedFallbackSources;
  }
}

/**
 * AI 装修顾问流式接口。
 * 和 /api/chat 共享同一套 RAG 思路，但回答阶段改为 token 级增量输出。
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as ChatStreamRequestBody | null;
  const message = body ? getRequestMessage(body) : null;
  const sessionId = body ? getSessionId(body) : null;

  if (!message) {
    return Response.json(
      {
        ok: false,
        error: "message is required",
      },
      { status: 400 },
    );
  }

  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      async start(controller) {
        const startedAt = Date.now();
        const stageTimer = createStageTimer();
        const writeEvent = (event: string, data: unknown) => controller.enqueue(encoder.encode(encodeEvent(event, data)));
        let activeSessionIdForLog: string | null = null;
        let retrievalQuestionForLog: string | undefined;
        let intentProfileForLog: ReturnType<typeof detectIntentProfile> | undefined;
        let retrievalStatsForLog: Awaited<ReturnType<typeof retrieveKnowledgeForQuestion>>["stats"] | undefined;
        let answer = "";

        try {
          const sql = createPostgresClient();
          let activeSessionId = sessionId;
          let history: PromptHistoryMessage[] = [];

          writeEvent("stage", { stage: "session", label: "正在准备会话" });
          if (!activeSessionId) {
            const [session] = await stageTimer.track("session", () => sql<{ id: string }[]>`
                insert into public.chat_sessions (title, updated_at)
                values (${createTitleFromMessage(message)}, now())
                returning id
              `);

            activeSessionId = session.id;
            writeEvent("session", { sessionId: activeSessionId });
          } else {
            const existingSessionId = activeSessionId;
            history = await stageTimer.track("history", () => loadRecentHistory(existingSessionId));
            writeEvent("session", { sessionId: activeSessionId });
          }
          activeSessionIdForLog = activeSessionId;

          await stageTimer.track("write_user_message", () => sql`
              insert into public.chat_messages (session_id, role, content)
              values (${activeSessionId}, 'user', ${message})
            `);

          writeEvent("stage", { stage: "rewrite_question", label: "正在理解问题" });
          const retrievalQuestion = await stageTimer.track("rewrite_question", () =>
            rewriteQuestionForRetrieval(message, history),
          );
          retrievalQuestionForLog = retrievalQuestion;

          const intentStartedAt = Date.now();
          const intentProfile = detectIntentProfile(retrievalQuestion);
          stageTimer.mark("intent", intentStartedAt);
          intentProfileForLog = intentProfile;

          writeEvent("stage", { stage: "embedding", label: "正在生成检索向量" });
          const queryEmbedding = await stageTimer.track("embedding", () => createQueryEmbedding(retrievalQuestion));

          writeEvent("stage", { stage: "retrieval", label: "正在检索知识库" });
          const retrievalResult = await stageTimer.track("retrieval", () =>
            retrieveKnowledgeForQuestion(queryEmbedding, intentProfile),
          );
          retrievalStatsForLog = retrievalResult.stats;

          const prepareStartedAt = Date.now();
          const { chunks, sources } = prepareRetrievedKnowledge(retrievalResult.chunks);
          const evidenceSourceLimit = getEvidenceSourceLimit(retrievalQuestion, intentProfile);
          let answerSources: KnowledgeSource[] = createRetrievedFallbackSources(sources, evidenceSourceLimit);
          stageTimer.mark("prepare_knowledge", prepareStartedAt);

          if (chunks.length === 0) {
            answer =
              "目前没有检索到足够相关的知识库资料，暂时不能直接判断。你可以补充装修阶段、现场照片描述、合同或报价明细，我再帮你继续分析。";
            writeEvent("token", { token: answer });
          } else {
            writeEvent("stage", { stage: "prompt", label: "正在整理回答依据" });
            const promptStartedAt = Date.now();
            const messages = buildChatMessages(message, chunks, history, intentProfile);
            stageTimer.mark("prompt", promptStartedAt);

            writeEvent("stage", { stage: "answer", label: "正在生成回答" });
            answer = await stageTimer.track("answer", () =>
              generateChatAnswerStream(messages, {
                onToken: (token) => writeEvent("token", { token }),
              }),
            );
          }

          writeEvent("stage", { stage: "evidence", label: "正在确认回答依据" });
          answerSources = await stageTimer.track("evidence", () =>
            selectAnswerSources(answer, chunks, sources, evidenceSourceLimit),
          );

          await stageTimer.track("write_assistant_message", () => sql`
              insert into public.chat_messages (session_id, role, content, sources)
              values (${activeSessionId}, 'assistant', ${answer}, ${sql.json(answerSources)})
            `);

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
            sources: answerSources,
            answer,
            status: "ok",
            durationMs: Date.now() - startedAt,
            stageTimings: stageTimer.snapshot(),
          }));

          writeEvent("done", {
            answer,
            sessionId: activeSessionId,
            sources: answerSources,
          });
        } catch (error) {
          const streamError = createStreamError(error);

          await stageTimer.track("write_log", () => writeChatRequestLog({
            sessionId: activeSessionIdForLog,
            userMessage: message,
            retrievalQuestion: retrievalQuestionForLog,
            intentProfile: intentProfileForLog,
            retrievalStats: retrievalStatsForLog,
            status: "error",
            errorMessage: getErrorMessage(error),
            durationMs: Date.now() - startedAt,
            stageTimings: stageTimer.snapshot(),
          }));

          writeEvent("error", streamError);
        } finally {
          controller.close();
        }
      },
    }),
    {
      headers: {
        "cache-control": "no-cache, no-transform",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
      },
    },
  );
}
