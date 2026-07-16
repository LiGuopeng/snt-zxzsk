import { NextResponse } from "next/server";

import { createPostgresClient } from "@/lib/db/postgres";

// Next.js 动态路由参数。这里的 id 是 design_generation_jobs.id。
type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const sql = createPostgresClient();

    // 轮询接口先查任务本身，前端根据 status/progress 决定继续等待还是展示失败。
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

    // renders 必须返回 metadata；前端依赖 metadata.render_mode 把 2D 和 3D 分开展示。
    const renders = await sql`
      select id,project_id,job_id,space_name,view_name,image_url,thumbnail_url,sort_order,metadata,created_at
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
