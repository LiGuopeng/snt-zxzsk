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

    const { data: job, error: jobError } = await supabase
      .from("design_generation_jobs")
      .select(
        "id,project_id,floor_plan_id,status,progress,prompt,provider,model,error_message,created_at,updated_at,started_at,completed_at",
      )
      .eq("id", id)
      .single();

    if (jobError || !job) {
      return NextResponse.json(
        {
          ok: false,
          error: jobError?.message || "生成任务不存在",
        },
        { status: 404 },
      );
    }

    const { data: renders, error: rendersError } = await supabase
      .from("design_renders")
      .select("id,project_id,job_id,space_name,view_name,image_url,thumbnail_url,sort_order,created_at")
      .eq("job_id", id)
      .order("sort_order", { ascending: true });

    if (rendersError) {
      return NextResponse.json(
        {
          ok: false,
          error: rendersError.message,
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      ok: true,
      job,
      renders: renders || [],
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
