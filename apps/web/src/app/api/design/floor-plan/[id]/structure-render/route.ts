import { randomUUID } from "crypto";

import { NextResponse } from "next/server";

import { generateInteriorDesignImage } from "@/lib/ai/dashscope-images";
import { createPostgresClient } from "@/lib/db/postgres";
import { saveDesignAsset } from "@/lib/storage/design-assets";

// Next.js 动态路由参数。这里的 id 是 design_floor_plans.id。
type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

// 生成户型立体结构图只需要解析后的户型字段，不读取装修效果图表，避免两个模块混用。
type FloorPlanForStructureRender = {
  id: string;
  project_id: string;
  file_url: string;
  file_type: string | null;
  house_type: string | null;
  area: number | null;
  spaces: unknown;
  circulation: string | null;
  analysis_result: Record<string, unknown>;
};

function normalizeSpaces(spaces: unknown) {
  // 户型解析结果来自视觉模型，先只收敛前端和 prompt 真正需要的字段，避免脏 JSON 影响生图。
  if (!Array.isArray(spaces)) {
    return [];
  }

  return spaces
    .filter((space): space is Record<string, unknown> => Boolean(space) && typeof space === "object")
    .map((space) => ({
      name: typeof space.name === "string" && space.name.trim() ? space.name.trim() : "未命名空间",
      type: typeof space.type === "string" && space.type.trim() ? space.type.trim() : "unknown",
      estimated_area:
        typeof space.estimated_area === "number" && Number.isFinite(space.estimated_area)
          ? space.estimated_area
          : null,
    }));
}

function createSpacesText(spaces: unknown) {
  // prompt 里用“空间名 + 类型 + 估算面积”描述户型结构，帮助模型保持房间比例。
  const normalizedSpaces = normalizeSpaces(spaces);

  if (!normalizedSpaces.length) {
    return "空间未明确识别，请按常见住宅户型组织。";
  }

  return normalizedSpaces
    .map((space) => `${space.name}(${space.type}${space.estimated_area ? `，约${space.estimated_area}平` : ""})`)
    .join("、");
}

function getStructureRenderUrl(analysisResult: Record<string, unknown>) {
  // structure_render 存在时直接复用，避免刷新页面或重复点击时重新消耗一次生图。
  const structureRender = analysisResult.structure_render;

  if (!structureRender || typeof structureRender !== "object") {
    return null;
  }

  const imageUrl = (structureRender as Record<string, unknown>).image_url;

  return typeof imageUrl === "string" && imageUrl ? imageUrl : null;
}

function buildStructureRenderPrompt(floorPlan: FloorPlanForStructureRender) {
  // 这里生成的是“户型立体结构图”，不是装修效果图。prompt 明确要求保留平面户型的空间关系，
  // 避免模型生成成普通客厅照片或风格化装修图。
  return [
    "根据用户上传的平面户型图解析结果，生成一张高质量户型立体结构图。",
    "画面风格参考专业房产/装修产品里的 3D floor plan visualization。",
    "必须是整套房子的三维俯视轴测图：完整户型全部入镜，墙体有厚度，房间分区清楚，门洞、窗洞、阳台、厨房、卫生间位置清楚。",
    "表现形式：clean 3D isometric apartment floor plan, white walls, light wood floors, soft shadows, architectural model, top-down cutaway view。",
    "可以放少量极简家具作为比例参照，但不要生成真实装修效果图，不要生成单个客厅照片，不要生成施工蓝图，不要生成手绘草图。",
    "严格参考解析出的房间数量、空间邻接关系、面积比例和动线，不要把户型改成单空间。",
    `户型：${floorPlan.house_type || "未识别"}`,
    `面积：${floorPlan.area ? `${floorPlan.area} 平方米` : "未识别"}`,
    `空间：${createSpacesText(floorPlan.spaces)}`,
    `动线：${floorPlan.circulation || "未识别"}`,
    "最终输出只能是一张户型立体结构图。",
  ].join("\n");
}

export async function POST(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const sql = createPostgresClient();

  try {
    // 户型立体结构图基于已经解析完成的 floorPlan 生成，不依赖 design_generation_jobs。
    const [floorPlan] = await sql<FloorPlanForStructureRender[]>`
      select id,project_id,file_url,file_type,house_type,area,spaces,circulation,analysis_result
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

    if (getStructureRenderUrl(floorPlan.analysis_result || {})) {
      // 已经生成过结构图时直接返回数据库记录，保证顶部预览稳定，不重复请求 DashScope。
      return NextResponse.json({
        ok: true,
        floorPlan,
        structureRender: (floorPlan.analysis_result || {}).structure_render,
      });
    }

    const prompt = buildStructureRenderPrompt(floorPlan);
    const generatedImage = await generateInteriorDesignImage(prompt);
    // 结构图虽然不写入 design_renders，但图片文件仍统一保存到 design-assets/renders 目录。
    const uploadedImage = await saveDesignAsset({
      buffer: generatedImage.imageBuffer,
      contentType: "image/png",
      extension: `-structure-${randomUUID()}.png`,
      prefix: "renders",
      projectId: floorPlan.project_id,
    });

    const nextAnalysisResult = {
      // 保留原 analysis_result 中的门窗、动线、诊断等字段，只追加 structure_render。
      ...(floorPlan.analysis_result || {}),
      structure_render: {
        image_url: uploadedImage.publicUrl,
        storage_path: uploadedImage.storagePath,
        provider: "dashscope",
        model: generatedImage.model,
        task_id: generatedImage.taskId,
        prompt,
        generated_at: new Date().toISOString(),
      },
    };

    const [updatedFloorPlan] = await sql`
      update public.design_floor_plans
      set analysis_result = ${sql.json(nextAnalysisResult)}, updated_at = now()
      where id = ${floorPlan.id}
      returning id,project_id,file_url,storage_path,file_name,file_type,file_size,upload_status,analysis_status,house_type,area,spaces,circulation,analysis_result,created_at,updated_at
    `;

    return NextResponse.json({
      ok: true,
      floorPlan: updatedFloorPlan,
      structureRender: nextAnalysisResult.structure_render,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "生成户型立体图失败",
      },
      { status: 500 },
    );
  }
}
