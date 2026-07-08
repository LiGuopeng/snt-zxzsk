import { NextResponse } from "next/server";

import { createSupabaseAdminClient } from "@/lib/supabase/server";

async function getTableCount(tableName: string) {
  const supabase = createSupabaseAdminClient();
  const { count, error } = await supabase
    .from(tableName)
    .select("*", { count: "exact", head: true });

  if (error) {
    throw new Error(`Failed to count ${tableName}: ${error.message}`);
  }

  return count || 0;
}

async function getMissingEmbeddingCount() {
  const supabase = createSupabaseAdminClient();
  const { count, error } = await supabase
    .from("knowledge_chunks")
    .select("*", { count: "exact", head: true })
    .is("embedding", null);

  if (error) {
    throw new Error(`Failed to count missing embeddings: ${error.message}`);
  }

  return count || 0;
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
