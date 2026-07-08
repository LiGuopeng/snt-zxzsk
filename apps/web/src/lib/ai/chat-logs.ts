import type { IntentProfile } from "@/lib/ai/intent";
import type { KnowledgeSource, RetrievalStats } from "@/lib/ai/retrieval";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

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
  // 但日志表属于上线增强项，如果 Supabase 还没执行最新 schema，不能影响用户正常聊天。
  try {
    const supabase = createSupabaseAdminClient();
    const { error } = await supabase.from("chat_request_logs").insert({
      session_id: input.sessionId,
      user_message: input.userMessage,
      retrieval_question: input.retrievalQuestion || null,
      intent_labels: input.intentProfile?.labels || [],
      detail_level: input.intentProfile?.detailLevel || null,
      force_layers: input.intentProfile?.forceLayers || [],
      retrieval_stats: input.retrievalStats || null,
      sources: input.sources || [],
      answer_preview: input.answer ? input.answer.slice(0, 500) : null,
      answer_chars: input.answer ? input.answer.length : null,
      status: input.status,
      error_message: input.errorMessage || null,
      duration_ms: Math.max(0, Math.round(input.durationMs)),
    });

    if (error) {
      console.warn("[chat_request_logs] skipped:", error.message);
    }
  } catch (error) {
    console.warn(
      "[chat_request_logs] skipped:",
      error instanceof Error ? error.message : "Unknown log error",
    );
  }
}
