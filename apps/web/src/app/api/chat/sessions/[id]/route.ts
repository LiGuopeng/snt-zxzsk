import { NextResponse } from "next/server";

import { createSupabaseAdminClient } from "@/lib/supabase/server";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const supabase = createSupabaseAdminClient();

    // 删除单个对话时，只处理聊天表。
    // 知识库 documents/chunks 不会受影响。
    const { error: messagesError } = await supabase
      .from("chat_messages")
      .delete()
      .eq("session_id", id);

    if (messagesError) {
      return NextResponse.json({ ok: false, error: messagesError.message }, { status: 500 });
    }

    const { error: sessionError } = await supabase
      .from("chat_sessions")
      .delete()
      .eq("id", id);

    if (sessionError) {
      return NextResponse.json({ ok: false, error: sessionError.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
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
