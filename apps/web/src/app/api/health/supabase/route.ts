import { NextResponse } from "next/server";

import { createSupabaseAdminClient } from "@/lib/supabase/server";

export async function GET() {
  try {
    const supabase = createSupabaseAdminClient();
    const { error } = await supabase
      .from("knowledge_documents")
      .select("id")
      .limit(1);

    if (error) {
      return NextResponse.json(
        {
          ok: false,
          error: error.message,
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      ok: true,
      message: "Supabase connection is ready.",
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

