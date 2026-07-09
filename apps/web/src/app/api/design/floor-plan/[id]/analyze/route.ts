import { NextResponse } from "next/server";

import { analyzeFloorPlanImage } from "@/lib/ai/dashscope";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

type FloorPlanRecord = {
  id: string;
  project_id: string;
  file_url: string;
  file_type: string | null;
};

function createSpacesSummary(spaces: Array<{ name: string }>) {
  return spaces.map((space) => space.name).filter(Boolean).join("、");
}

export async function POST(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const supabase = createSupabaseAdminClient();

  try {
    const { data: floorPlan, error: loadError } = await supabase
      .from("design_floor_plans")
      .select("id,project_id,file_url,file_type")
      .eq("id", id)
      .single<FloorPlanRecord>();

    if (loadError || !floorPlan) {
      return NextResponse.json(
        {
          ok: false,
          error: loadError?.message || "户型图不存在",
        },
        { status: 404 },
      );
    }

    if (floorPlan.file_type === "application/pdf") {
      const errorMessage = "暂不支持直接解析 PDF，请先上传 JPG、PNG 或 WEBP 户型图";

      await supabase
        .from("design_floor_plans")
        .update({
          analysis_status: "failed",
          error_message: errorMessage,
          updated_at: new Date().toISOString(),
        })
        .eq("id", floorPlan.id);

      return NextResponse.json(
        {
          ok: false,
          error: errorMessage,
        },
        { status: 400 },
      );
    }

    await supabase
      .from("design_floor_plans")
      .update({
        analysis_status: "analyzing",
        error_message: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", floorPlan.id);

    await supabase
      .from("design_projects")
      .update({
        status: "analyzing",
        updated_at: new Date().toISOString(),
      })
      .eq("id", floorPlan.project_id);

    const analysis = await analyzeFloorPlanImage(floorPlan.file_url);
    const now = new Date().toISOString();
    const spacesSummary = createSpacesSummary(analysis.spaces);

    const { data: updatedFloorPlan, error: updateFloorPlanError } = await supabase
      .from("design_floor_plans")
      .update({
        analysis_status: "completed",
        house_type: analysis.house_type,
        area: analysis.area,
        spaces: analysis.spaces,
        circulation: analysis.circulation,
        analysis_result: analysis,
        error_message: null,
        updated_at: now,
      })
      .eq("id", floorPlan.id)
      .select(
        "id,project_id,file_url,storage_path,file_name,file_type,file_size,upload_status,analysis_status,house_type,area,spaces,circulation,analysis_result,created_at,updated_at",
      )
      .single();

    if (updateFloorPlanError || !updatedFloorPlan) {
      throw new Error(updateFloorPlanError?.message || "保存户型解析结果失败");
    }

    const { data: updatedProject, error: updateProjectError } = await supabase
      .from("design_projects")
      .update({
        status: "ready",
        house_type: analysis.house_type,
        area: analysis.area,
        updated_at: now,
      })
      .eq("id", floorPlan.project_id)
      .select("id,title,status,intent_text,house_type,area,created_at,updated_at")
      .single();

    if (updateProjectError || !updatedProject) {
      throw new Error(updateProjectError?.message || "更新效果图项目失败");
    }

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

    await supabase
      .from("design_floor_plans")
      .update({
        analysis_status: "failed",
        error_message: errorMessage,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);

    return NextResponse.json(
      {
        ok: false,
        error: errorMessage,
      },
      { status: 500 },
    );
  }
}
