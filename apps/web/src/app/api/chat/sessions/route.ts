import { NextResponse } from "next/server";

import { createPostgresClient } from "@/lib/db/postgres";

function createDefaultTitle() {
  // 新建会话时先用默认标题。
  // 后续用户第一次提问后，再用第一句话更新标题。
  return "新对话";
}

export async function GET() {
  try {
    const sql = createPostgresClient();
    // 左侧栏只需要会话列表，不需要把每条消息都查出来。
    // 这样页面首次加载更轻，点击某个会话时再单独加载 messages。
    const sessions = await sql`
      select id, title, created_at, updated_at
      from public.chat_sessions
      order by updated_at desc
      limit 30
    `;

    return NextResponse.json({
      ok: true,
      sessions,
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
    const sql = createPostgresClient();
    // 点击“新对话”时创建真实 chat_session。
    // 当前还没有登录系统，所以 user_id 暂时为空。
    const [session] = await sql`
      insert into public.chat_sessions (title, updated_at)
      values (${createDefaultTitle()}, now())
      returning id, title, created_at, updated_at
    `;

    return NextResponse.json({
      ok: true,
      session,
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
