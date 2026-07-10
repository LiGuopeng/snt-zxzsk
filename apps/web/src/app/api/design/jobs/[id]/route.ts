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

    const [job] = await sql`
      select id,project_id,floor_plan_id,status,progress,prompt,provider,model,error_message,created_at,updated_at,started_at,completed_at
      from public.design_generation_jobs
      where id = ${id}
      limit 1
    `;

    if (!job) {
      return NextResponse.json(
        {
          ok: false,
          error: "生成任务不存在",
        },
        { status: 404 },
      );
    }

    const renders = await sql`
      select id,project_id,job_id,space_name,view_name,image_url,thumbnail_url,sort_order,created_at
      from public.design_renders
      where job_id = ${id}
      order by sort_order asc
    `;

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
