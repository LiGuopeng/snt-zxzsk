import { NextResponse } from "next/server";

import { analyzeFloorPlanImage } from "@/lib/ai/dashscope";
import { createPostgresClient } from "@/lib/db/postgres";
import { readDesignAssetAsDataUrl } from "@/lib/storage/design-assets";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

type FloorPlanRecord = {
  id: string;
  project_id: string;
  file_url: string;
  storage_path: string | null;
  file_type: string | null;
};

function createSpacesSummary(spaces: Array<{ name: string }>) {
  // 给前端一个轻量空间摘要；完整结构仍以 spaces/analysis_result 为准。
  return spaces.map((space) => space.name).filter(Boolean).join("、");
}

export async function POST(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const sql = createPostgresClient();

  try {
    const [floorPlan] = await sql<FloorPlanRecord[]>`
      select id,project_id,file_url,storage_path,file_type
      from public.design_floor_plans
      where id = ${id}
      limit 1
    `;

    if (!floorPlan) {
      return NextResponse.json(
        {
          ok: false,
          error: "户型图不存在",
        },
        { status: 404 },
      );
    }

    if (!floorPlan.storage_path) {
      return NextResponse.json(
        {
          ok: false,
          error: "户型图文件路径不存在，请重新上传户型图",
        },
        { status: 400 },
      );
    }

    if (floorPlan.file_type === "application/pdf") {
      // PDF 需要先转图片再给视觉模型；当前阶段明确拒绝，避免任务长时间停在 analyzing。
      const errorMessage = "暂不支持直接解析 PDF，请先上传 JPG、PNG 或 WEBP 户型图";

      await sql`
        update public.design_floor_plans
        set analysis_status = 'failed', error_message = ${errorMessage}, updated_at = now()
        where id = ${floorPlan.id}
      `;

      return NextResponse.json(
        {
          ok: false,
          error: errorMessage,
        },
        { status: 400 },
      );
    }

    // 解析状态先落库，前端可以立刻展示“解析中”，避免用户误以为上传后卡住。
    await sql`
      update public.design_floor_plans
      set analysis_status = 'analyzing', error_message = null, updated_at = now()
      where id = ${floorPlan.id}
    `;

    await sql`
      update public.design_projects
      set status = 'analyzing', updated_at = now()
      where id = ${floorPlan.project_id}
    `;

    const imageDataUrl = await readDesignAssetAsDataUrl({
      contentType: floorPlan.file_type,
      storagePath: floorPlan.storage_path,
    });

    // DashScope 云端不能访问本机 /uploads 相对路径，所以这里传 data URL 图片内容。
    // 真实户型解析入口：DashScope 视觉模型根据户型图识别房间、面积、门窗、厨卫、阳台和动线。
    const analysis = await analyzeFloorPlanImage(imageDataUrl);
    const spacesSummary = createSpacesSummary(analysis.spaces);

    // 将结构化解析结果写回 floor_plan，生成效果图时必须从这里读取空间数量和空间关系。
    const [updatedFloorPlan] = await sql`
      update public.design_floor_plans
      set
        analysis_status = 'completed',
        house_type = ${analysis.house_type},
        area = ${analysis.area},
        spaces = ${sql.json(analysis.spaces)},
        circulation = ${analysis.circulation},
        analysis_result = ${sql.json(analysis)},
        error_message = null,
        updated_at = now()
      where id = ${floorPlan.id}
      returning id,project_id,file_url,storage_path,file_name,file_type,file_size,upload_status,analysis_status,house_type,area,spaces,circulation,analysis_result,created_at,updated_at
    `;

    const [updatedProject] = await sql`
      update public.design_projects
      set
        status = 'ready',
        house_type = ${analysis.house_type},
        area = ${analysis.area},
        updated_at = now()
      where id = ${floorPlan.project_id}
      returning id,title,status,intent_text,house_type,area,created_at,updated_at
    `;

    return NextResponse.json({
      ok: true,
      project: updatedProject,
      floorPlan: updatedFloorPlan,
      analysis: {
        ...analysis,
        spaces_summary: spacesSummary,
      },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "户型图解析失败";

    // 解析失败只影响当前户型图，不删除原图，方便用户重试或排查图片清晰度问题。
    await sql`
      update public.design_floor_plans
      set analysis_status = 'failed', error_message = ${errorMessage}, updated_at = now()
      where id = ${id}
    `;

    return NextResponse.json(
      {
        ok: false,
        error: errorMessage,
      },
      { status: 500 },
    );
  }
}
