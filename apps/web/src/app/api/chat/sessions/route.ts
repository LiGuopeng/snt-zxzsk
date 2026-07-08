import { NextResponse } from "next/server";

import { createSupabaseAdminClient } from "@/lib/supabase/server";

function createDefaultTitle() {
  // 新建会话时先用默认标题。
  // 后续用户第一次提问后，再用第一句话更新标题。
  return "新对话";
}

export async function GET() {
  try {
    const supabase = createSupabaseAdminClient();
    // 左侧栏只需要会话列表，不需要把每条消息都查出来。
    // 这样页面首次加载更轻，点击某个会话时再单独加载 messages。
    const { data, error } = await supabase
      .from("chat_sessions")
      .select("id,title,created_at,updated_at")
      .order("updated_at", { ascending: false })
      .limit(30);

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      sessions: data || [],
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

export async function POST() {
  try {
    const supabase = createSupabaseAdminClient();
    // 点击“新对话”时创建真实 chat_session。
    // 当前还没有登录系统，所以 user_id 暂时为空。
    const { data, error } = await supabase
      .from("chat_sessions")
      .insert({
        title: createDefaultTitle(),
        updated_at: new Date().toISOString(),
      })
      .select("id,title,created_at,updated_at")
      .single();

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      session: data,
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
