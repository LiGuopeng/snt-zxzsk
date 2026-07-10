import { NextResponse } from "next/server";

import { createPostgresClient } from "@/lib/db/postgres";

async function getTableCount(tableName: string) {
  const sql = createPostgresClient();
  const [row] = await sql<{ count: string }[]>`
    select count(*)::text as count
    from ${sql("public", tableName)}
  `;

  return Number(row?.count || 0);
}

async function getMissingEmbeddingCount() {
  const sql = createPostgresClient();
  const [row] = await sql<{ count: string }[]>`
    select count(*)::text as count
    from public.knowledge_chunks
    where embedding is null
  `;

  return Number(row?.count || 0);
}

export async function GET() {
  try {
    const [documentsCount, chunksCount, missingEmbeddingCount] = await Promise.all([
      getTableCount("knowledge_documents"),
      getTableCount("knowledge_chunks"),
      getMissingEmbeddingCount(),
    ]);
    const embeddedChunksCount = Math.max(0, chunksCount - missingEmbeddingCount);
    const embeddingReady = chunksCount > 0 && missingEmbeddingCount === 0;

    return NextResponse.json({
      ok: true,
      embeddingReady,
      documentsCount,
      chunksCount,
      embeddedChunksCount,
      missingEmbeddingCount,
      message: embeddingReady
        ? "Knowledge index is ready."
        : "Knowledge index is not fully embedded yet.",
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
