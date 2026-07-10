import { NextResponse } from "next/server";

import { createPostgresClient } from "@/lib/db/postgres";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const sql = createPostgresClient();
    // 点击左侧某个会话时，根据 session_id 加载这个会话的完整消息。
    // sources 存在 assistant 消息里，用于前端折叠展示“参考来源”。
    const messages = await sql`
      select id, role, content, sources, created_at
      from public.chat_messages
      where session_id = ${id}
      order by created_at asc
    `;

    return NextResponse.json({
      ok: true,
      messages,
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
