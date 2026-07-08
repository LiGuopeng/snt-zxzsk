import { NextResponse } from "next/server";

import { createSupabaseAdminClient } from "@/lib/supabase/server";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const supabase = createSupabaseAdminClient();
    // 点击左侧某个会话时，根据 session_id 加载这个会话的完整消息。
    // sources 存在 assistant 消息里，用于前端折叠展示“参考来源”。
    const { data, error } = await supabase
      .from("chat_messages")
      .select("id,role,content,sources,created_at")
      .eq("session_id", id)
      .order("created_at", { ascending: true });

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      messages: data || [],
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
