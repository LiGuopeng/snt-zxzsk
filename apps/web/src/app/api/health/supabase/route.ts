import { NextResponse } from "next/server";

import { createPostgresClient } from "@/lib/db/postgres";

export async function GET() {
  try {
    const sql = createPostgresClient();
    await sql`
      select id
      from public.knowledge_documents
      limit 1
    `;

    return NextResponse.json({
      ok: true,
      message: "PostgreSQL connection is ready.",
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
