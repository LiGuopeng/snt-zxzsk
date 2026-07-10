import type { IntentProfile } from "@/lib/ai/intent";
import type { KnowledgeSource, RetrievalStats } from "@/lib/ai/retrieval";
import { createPostgresClient } from "@/lib/db/postgres";

export type ChatRequestLogInput = {
  // 本次请求关联的会话；如果会话创建前失败，允许为 null。
  sessionId: string | null;
  // 用户原始问题。
  userMessage: string;
  // 用于知识库检索的问题，可能是结合历史改写后的问题。
  retrievalQuestion?: string;
  // 意图识别结果，记录后可复盘为什么强制召回某些知识层级。
  intentProfile?: IntentProfile;
  // 检索统计，记录向量召回、关键词兜底和强制层级召回情况。
  retrievalStats?: RetrievalStats;
  // 返回给前端的答案来源。
  sources?: KnowledgeSource[];
  // AI 最终回答；日志里只保存 preview 和字符数。
  answer?: string;
  // 请求结果状态。
  status: "ok" | "error";
  // 失败原因。
  errorMessage?: string;
  // 整个请求总耗时，单位 ms。
  durationMs: number;
  // 每个阶段的耗时，单位 ms。用于定位 timeout 是发生在检索、embedding 还是模型回答。
  stageTimings?: Record<string, number>;
};

/**
 * 写入 AI 装修顾问请求日志。
 * 日志用于审计回答依据、排查慢请求和定位失败阶段；写日志失败不能影响用户正常聊天。
 */
export async function writeChatRequestLog(input: ChatRequestLogInput) {
  // 正式上线需要知道每次回答为什么这么答：命中了什么意图、召回了哪些资料、耗时多久。
  // stage_timings 是排查慢请求的核心字段，线上看到 timeout 后先看这里。
  // 但日志表属于上线增强项，如果数据库还没执行最新 schema，不能影响用户正常聊天。
  try {
    const sql = createPostgresClient();
    await sql`
      insert into public.chat_request_logs (
        session_id,
        user_message,
        retrieval_question,
        intent_labels,
        detail_level,
        force_layers,
        retrieval_stats,
        sources,
        answer_preview,
        answer_chars,
        status,
        error_message,
        duration_ms,
        stage_timings
      )
      values (
        ${input.sessionId},
        ${input.userMessage},
        ${input.retrievalQuestion || null},
        ${input.intentProfile?.labels || []},
        ${input.intentProfile?.detailLevel || null},
        ${input.intentProfile?.forceLayers || []},
        ${input.retrievalStats ? sql.json(input.retrievalStats) : null},
        ${sql.json(input.sources || [])},
        ${input.answer ? input.answer.slice(0, 500) : null},
        ${input.answer ? input.answer.length : null},
        ${input.status},
        ${input.errorMessage || null},
        ${Math.max(0, Math.round(input.durationMs))},
        ${sql.json(input.stageTimings || {})}
      )
    `;
  } catch (error) {
    console.warn(
      "[chat_request_logs] skipped:",
      error instanceof Error ? error.message : "Unknown log error",
    );
  }
}
