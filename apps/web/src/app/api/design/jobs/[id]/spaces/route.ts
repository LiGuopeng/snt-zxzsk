import { randomUUID } from "crypto";

import { NextResponse } from "next/server";

import { generateInteriorDesignImage } from "@/lib/ai/dashscope-images";
import { createPostgresClient } from "@/lib/db/postgres";
import { saveDesignAsset } from "@/lib/storage/design-assets";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

type GenerateSpaceBody = {
  spaceName?: unknown;
  spaceType?: unknown;
};

function getStringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeSpaceType(spaceName: string, spaceType: string | null) {
  // 空间图的标题由解析出的空间名称决定，不再使用固定默认空间列表。
  const value = `${spaceType || ""} ${spaceName}`.toLowerCase();

  if (value.includes("living") || spaceName.includes("客厅")) return "客厅效果图";
  if (value.includes("dining") || spaceName.includes("餐厅")) return "餐厅效果图";
  if (value.includes("master") || spaceName.includes("主卧")) return "主卧效果图";
  if (value.includes("bedroom") || spaceName.includes("卧")) return "卧室效果图";
  if (value.includes("kitchen") || spaceName.includes("厨房")) return "厨房效果图";
  if (value.includes("bath") || value.includes("toilet") || spaceName.includes("卫生间") || spaceName.includes("卫")) return "卫生间效果图";
  if (value.includes("study") || spaceName.includes("书房")) return "书房效果图";
  if (value.includes("balcony") || spaceName.includes("阳台")) return "阳台效果图";

  return "空间效果图";
}

function createSpacesText(spaces: unknown) {
  if (!Array.isArray(spaces)) {
    return "空间未明确识别";
  }

  return spaces
    .filter((space) => Boolean(space) && typeof space === "object")
    .map((space) => {
      const record = space as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name : "未命名空间";
      const type = typeof record.type === "string" ? record.type : "unknown";

      return `${name}(${type})`;
    })
    .join("、");
}

function buildPrompt(params: {
  area: number | null;
  circulation: string | null;
  houseType: string | null;
  intentText: string | null;
  spaceName: string;
  spaceType: string | null;
  spaces: unknown;
  viewName: string;
}) {
  return [
    // 空间图只生成当前房间的 2D 室内效果，不和全屋 3D 总览混在同一个 prompt 里。
    `生成一张真实可用的${params.spaceName} 2D 室内装修效果图。`,
    "画面要求：普通室内效果图视角，摄影级渲染，真实材质，自然光线，合理广角，现代家装产品图质感。",
    "空间效果图只表现当前房间或功能区，不使用全屋 3D 轴测视角。",
    "不要生成户型平面图，不要生成施工图，不要生成手绘图，不要生成三维全屋俯视模型。",
    `当前生成目标：${params.spaceName} · ${params.viewName}`,
    "必须聚焦当前空间，但风格、色系、材质和全屋方案保持统一。",
    `户型：${params.houseType || "未识别"}`,
    `面积：${params.area ? `${params.area} 平方米` : "未识别"}`,
    `全部空间：${createSpacesText(params.spaces)}`,
    `动线：${params.circulation || "未识别"}`,
    `用户需求：${params.intentText || "现代简约，明亮通透，耐脏好打理，预算中等"}`,
  ].join("\n");
}

async function uploadGeneratedImage(params: {
  imageBuffer: Buffer;
  jobId: string;
  projectId: string;
}) {
  return saveDesignAsset({
    buffer: params.imageBuffer,
    contentType: "image/png",
    extension: `-${params.jobId}-${randomUUID()}.png`,
    prefix: "renders",
    projectId: params.projectId,
  });
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = (await request.json().catch(() => null)) as GenerateSpaceBody | null;
    const spaceName = getStringValue(body?.spaceName);
    const spaceType = getStringValue(body?.spaceType);

    if (!spaceName) {
      return NextResponse.json(
        {
          ok: false,
          error: "spaceName is required",
        },
        { status: 400 },
      );
    }

    const sql = createPostgresClient();
    const [job] = await sql`
      select id,project_id,floor_plan_id,status
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

    const [existingRender] = await sql`
      select id,project_id,job_id,space_name,view_name,image_url,thumbnail_url,sort_order,created_at
      from public.design_renders
      where job_id = ${id} and space_name = ${spaceName}
      limit 1
    `;

    if (existingRender) {
      // 同一任务同一空间只生成一次；重复点击直接返回已有图片，减少生图费用和等待时间。
      return NextResponse.json({
        ok: true,
        render: existingRender,
      });
    }

    const [project] = await sql`
      select intent_text
      from public.design_projects
      where id = ${job.project_id}
      limit 1
    `;

    const [floorPlan] = await sql`
      select house_type,area,spaces,circulation
      from public.design_floor_plans
      where id = ${job.floor_plan_id}
      limit 1
    `;

    if (!floorPlan) {
      return NextResponse.json(
        {
          ok: false,
          error: "户型解析结果不存在",
        },
        { status: 404 },
      );
    }

    const viewName = normalizeSpaceType(spaceName, spaceType);
    // 空间图仍引用户型解析结果，保证单空间效果与全屋方案的面积、动线和风格一致。
    const prompt = buildPrompt({
      area: floorPlan.area,
      circulation: floorPlan.circulation,
      houseType: floorPlan.house_type,
      intentText: project?.intent_text || null,
      spaceName,
      spaceType,
      spaces: floorPlan.spaces,
      viewName,
    });
    const generatedImage = await generateInteriorDesignImage(prompt);
    // DashScope 返回的是临时图片 URL，下载后保存到本项目本地存储，前端只加载自己的 /uploads 路径。
    const uploadedImage = await uploadGeneratedImage({
      imageBuffer: generatedImage.imageBuffer,
      jobId: id,
      projectId: job.project_id,
    });

    const [maxRender] = await sql`
      select sort_order
      from public.design_renders
      where job_id = ${id}
      order by sort_order desc
      limit 1
    `;

    const [render] = await sql`
      insert into public.design_renders (
        project_id,
        job_id,
        space_name,
        view_name,
        image_url,
        thumbnail_url,
        storage_path,
        thumbnail_storage_path,
        sort_order,
        metadata
      )
      values (
        ${job.project_id},
        ${id},
        ${spaceName},
        ${viewName},
        ${uploadedImage.publicUrl},
        ${uploadedImage.publicUrl},
        ${uploadedImage.storagePath},
        ${uploadedImage.storagePath},
        ${typeof maxRender?.sort_order === "number" ? maxRender.sort_order + 1 : 1},
        ${sql.json({
          source: "dashscope_image_generation",
          task_id: generatedImage.taskId,
          storage_path: uploadedImage.storagePath,
          space_type: spaceType,
        })}
      )
      returning id,project_id,job_id,space_name,view_name,image_url,thumbnail_url,storage_path,thumbnail_storage_path,sort_order,created_at
    `;

    return NextResponse.json({
      ok: true,
      render,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "生成空间效果图失败",
      },
      { status: 500 },
    );
  }
}
