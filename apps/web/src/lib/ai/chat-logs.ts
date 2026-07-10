import type { IntentProfile } from "@/lib/ai/intent";
import type { KnowledgeSource, RetrievalStats } from "@/lib/ai/retrieval";
import { createPostgresClient } from "@/lib/db/postgres";

export type ChatRequestLogInput = {
  sessionId: string | null;
  userMessage: string;
  retrievalQuestion?: string;
  intentProfile?: IntentProfile;
  retrievalStats?: RetrievalStats;
  sources?: KnowledgeSource[];
  answer?: string;
  status: "ok" | "error";
  errorMessage?: string;
  durationMs: number;
};

export async function writeChatRequestLog(input: ChatRequestLogInput) {
  // 正式上线需要知道每次回答为什么这么答：命中了什么意图、召回了哪些资料、耗时多久。
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
        duration_ms
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
        ${Math.max(0, Math.round(input.durationMs))}
      )
    `;
  } catch (error) {
    console.warn(
      "[chat_request_logs] skipped:",
      error instanceof Error ? error.message : "Unknown log error",
    );
  }
}
