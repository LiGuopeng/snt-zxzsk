import { NextResponse } from "next/server";

import { createPostgresClient } from "@/lib/db/postgres";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const sql = createPostgresClient();

    // 删除单个对话时，只处理聊天表。
    // 知识库 documents/chunks 不会受影响。
    await sql.begin(async (transaction) => {
      await transaction`
        delete from public.chat_messages
        where session_id = ${id}
      `;
      await transaction`
        delete from public.chat_sessions
        where id = ${id}
      `;
    });

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
