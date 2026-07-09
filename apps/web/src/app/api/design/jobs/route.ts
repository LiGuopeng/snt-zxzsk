import { randomUUID } from "crypto";

import { NextResponse } from "next/server";

import { generateInteriorDesignImage } from "@/lib/ai/dashscope-images";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

const DESIGN_ASSETS_BUCKET = "design-assets";

type CreateDesignJobBody = {
  projectId?: unknown;
  floorPlanId?: unknown;
  intentText?: unknown;
};

type ParsedSpace = {
  name?: unknown;
  type?: unknown;
};

type RenderTarget = {
  spaceName: string;
  viewName: string;
  promptFocus: string;
  sortOrder: number;
};

function getStringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeSpaces(spaces: unknown) {
  if (!Array.isArray(spaces)) {
    return [];
  }

  return spaces
    .filter((space): space is ParsedSpace => Boolean(space) && typeof space === "object")
    .map((space) => ({
      name: typeof space.name === "string" && space.name.trim() ? space.name.trim() : "未命名空间",
      type: typeof space.type === "string" && space.type.trim() ? space.type.trim() : "unknown",
    }));
}

function createSpacesText(spaces: unknown) {
  const normalizedSpaces = normalizeSpaces(spaces);

  if (!normalizedSpaces.length) {
    return "空间未明确识别，请按常见住宅全屋空间组织。";
  }

  return normalizedSpaces.map((space) => `${space.name}(${space.type})`).join("、");
}

function normalizeSpaceType(space: { name: string; type: string }) {
  const value = `${space.type} ${space.name}`.toLowerCase();

  if (value.includes("living") || space.name.includes("客厅")) {
    return "living_room";
  }

  if (value.includes("dining") || space.name.includes("餐厅")) {
    return "dining_room";
  }

  if (value.includes("master") || space.name.includes("主卧")) {
    return "master_bedroom";
  }

  if (value.includes("bedroom") || space.name.includes("卧")) {
    return "bedroom";
  }

  if (value.includes("kitchen") || space.name.includes("厨房")) {
    return "kitchen";
  }

  if (value.includes("bath") || value.includes("toilet") || space.name.includes("卫生间") || space.name.includes("卫")) {
    return "bathroom";
  }

  if (value.includes("study") || space.name.includes("书房")) {
    return "study";
  }

  if (value.includes("balcony") || space.name.includes("阳台")) {
    return "balcony";
  }

  return "default";
}

const SPACE_PRIORITY: Record<string, number> = {
  living_room: 1,
  dining_room: 2,
  master_bedroom: 3,
  bedroom: 4,
  kitchen: 5,
  bathroom: 6,
  study: 7,
  balcony: 8,
  default: 20,
};

const SPACE_VIEW_NAME: Record<string, string> = {
  living_room: "客餐厅效果图",
  dining_room: "餐厅效果图",
  master_bedroom: "主卧效果图",
  bedroom: "卧室效果图",
  kitchen: "厨房效果图",
  bathroom: "卫生间效果图",
  study: "书房效果图",
  balcony: "阳台效果图",
  default: "空间效果图",
};

const SPACE_PROMPT_FOCUS: Record<string, string> = {
  living_room: "重点展示客厅与餐厅的联动关系、沙发布局、电视墙、餐桌、采光和全屋主色调。",
  dining_room: "重点展示餐桌、餐边柜、餐厨关系、灯光和材质搭配。",
  master_bedroom: "重点展示主卧床区、床头背景、衣柜、柔和灯光和睡眠氛围。",
  bedroom: "重点展示卧室床区、收纳、书桌或衣柜，以及舒适耐看的居住氛围。",
  kitchen: "重点展示橱柜、台面、烹饪动线、收纳和现代厨房材质。",
  bathroom: "重点展示干湿分区、浴室柜、淋浴区、瓷砖和灯光。",
  study: "重点展示书桌、书柜、收纳和安静的工作学习氛围。",
  balcony: "重点展示阳台采光、休闲区、洗晒区和植物软装。",
  default: "重点展示该空间的功能分区、家具布置、材质和灯光。",
};

function createRenderTargets(spaces: unknown): RenderTarget[] {
  const uniqueSpaces = new Map<string, { name: string; type: string; normalizedType: string }>();

  for (const space of normalizeSpaces(spaces)) {
    const normalizedType = normalizeSpaceType(space);
    const key = normalizedType === "default" ? space.name : normalizedType;

    if (!uniqueSpaces.has(key)) {
      uniqueSpaces.set(key, {
        ...space,
        normalizedType,
      });
    }
  }

  const spaceTargets = Array.from(uniqueSpaces.values())
    .sort((a, b) => {
      const priorityA = SPACE_PRIORITY[a.normalizedType] || SPACE_PRIORITY.default;
      const priorityB = SPACE_PRIORITY[b.normalizedType] || SPACE_PRIORITY.default;

      return priorityA - priorityB;
    })
    .map((space, index) => ({
      spaceName: space.name,
      viewName: SPACE_VIEW_NAME[space.normalizedType] || SPACE_VIEW_NAME.default,
      promptFocus: SPACE_PROMPT_FOCUS[space.normalizedType] || SPACE_PROMPT_FOCUS.default,
      sortOrder: index + 1,
    }));

  if (!spaceTargets.length) {
    throw new Error("户型解析结果没有可生成的空间，请重新解析户型图后再生成效果图");
  }

  return [
    {
      spaceName: "全屋",
      viewName: "全屋效果图",
      promptFocus: "重点展示全屋统一风格、客餐厅与相邻空间的整体关系、主要家具搭配、灯光氛围和空间动线。",
      sortOrder: 0,
    },
    ...spaceTargets,
  ];
}

function buildPrompt(
  intentText: string | null,
  floorPlan: {
    house_type: string | null;
    area: number | null;
    spaces: unknown;
    circulation: string | null;
  },
  target: RenderTarget,
) {
  if (target.spaceName === "全屋") {
    return [
      "根据用户上传的户型图，生成一张三维俯视/轴测视角的全屋装修效果图。",
      "固定默认风格：现代简约、明亮通透、暖白与浅木色为主、真实家具软装、干净耐看的家装产品质感。",
      "画面必须像建筑室内可视化模型：完整户型全部入镜，所有主要房间同时可见，墙体、门洞、窗洞、地面、家具、灯光、软装、厨卫和阳台关系清楚。",
      "视角要求：bird's-eye view, isometric interior render, 3D cutaway apartment visualization, top-down whole-home furnished model。",
      "请严格参考户型解析结果保持空间数量、空间邻接关系、动线和面积比例，不要把户型改成单个房间。",
      "不要生成普通客厅照片，不要生成单空间局部图，不要生成平面户型图，不要生成 2D 图纸，不要生成手绘图，不要生成施工图。",
      `当前生成目标：${target.spaceName} · ${target.viewName}`,
      `画面重点：${target.promptFocus}`,
      `户型：${floorPlan.house_type || "未识别"}`,
      `面积：${floorPlan.area ? `${floorPlan.area} 平方米` : "未识别"}`,
      `空间：${createSpacesText(floorPlan.spaces)}`,
      `动线：${floorPlan.circulation || "未识别"}`,
      `用户补充需求：${intentText || "无补充，使用固定默认风格"}`,
      "最终输出只能是一张完整全屋三维总览效果图。",
    ].join("\n");
  }

  return [
    `生成一张真实可用的${target.spaceName}装修效果图。`,
    "画面要求：室内设计摄影级渲染、真实材质、自然光线、广角视角、完整空间关系、客餐厅与相邻空间联动、现代家装产品图质感。",
    "不要生成户型平面图，不要生成 2D 图纸，不要生成手绘图，不要生成施工图。",
    "请根据户型解析结果保持空间关系合理，重点表现全屋统一风格、家具搭配、灯光氛围、收纳设计和空间动线。",
    `当前生成目标：${target.spaceName} · ${target.viewName}`,
    `画面重点：${target.promptFocus}`,
    `户型：${floorPlan.house_type || "未识别"}`,
    `面积：${floorPlan.area ? `${floorPlan.area} 平方米` : "未识别"}`,
    `空间：${createSpacesText(floorPlan.spaces)}`,
    `动线：${floorPlan.circulation || "未识别"}`,
    `用户需求：${intentText || "现代简约，明亮通透，耐脏好打理，预算中等"}`,
    target.spaceName === "全屋"
      ? "输出必须是一张全屋装修效果图，不能只展示单个局部角落。"
      : `输出必须聚焦${target.spaceName}，但风格、材质和色系统一于全屋方案。`,
  ].join("\n");
}

async function uploadGeneratedImage(params: {
  imageBuffer: Buffer;
  projectId: string;
  jobId: string;
}) {
  const supabase = createSupabaseAdminClient();
  const storagePath = `renders/${params.projectId}/${params.jobId}-${randomUUID()}.png`;

  const { error: uploadError } = await supabase.storage
    .from(DESIGN_ASSETS_BUCKET)
    .upload(storagePath, params.imageBuffer, {
      contentType: "image/png",
      upsert: false,
    });

  if (uploadError) {
    throw new Error(`保存生成图片失败：${uploadError.message}`);
  }

  const {
    data: { publicUrl },
  } = supabase.storage.from(DESIGN_ASSETS_BUCKET).getPublicUrl(storagePath);

  return {
    publicUrl,
    storagePath,
  };
}

async function markJobFailed(params: {
  projectId: string;
  jobId?: string;
  errorMessage: string;
}) {
  const supabase = createSupabaseAdminClient();
  const now = new Date().toISOString();

  if (params.jobId) {
    await supabase
      .from("design_generation_jobs")
      .update({
        status: "failed",
        progress: 100,
        error_message: params.errorMessage,
        completed_at: now,
        updated_at: now,
      })
      .eq("id", params.jobId);
  }

  await supabase
    .from("design_projects")
    .update({
      status: "failed",
      updated_at: now,
    })
    .eq("id", params.projectId);
}

async function generateRenderForTarget(params: {
  floorPlan: {
    house_type: string | null;
    area: number | null;
    spaces: unknown;
    circulation: string | null;
  };
  intentText: string | null;
  jobId: string;
  projectId: string;
  target: RenderTarget;
}) {
  const targetPrompt = buildPrompt(params.intentText, params.floorPlan, params.target);
  const generatedImage = await generateInteriorDesignImage(targetPrompt);
  const uploadedImage = await uploadGeneratedImage({
    imageBuffer: generatedImage.imageBuffer,
    projectId: params.projectId,
    jobId: params.jobId,
  });

  return {
    renderRow: {
      project_id: params.projectId,
      job_id: params.jobId,
      space_name: params.target.spaceName,
      view_name: params.target.viewName,
      image_url: uploadedImage.publicUrl,
      thumbnail_url: uploadedImage.publicUrl,
      sort_order: params.target.sortOrder,
      metadata: {
        source: "dashscope_image_generation",
        task_id: generatedImage.taskId,
        storage_path: uploadedImage.storagePath,
        prompt_focus: params.target.promptFocus,
      },
    },
    task: {
      space_name: params.target.spaceName,
      view_name: params.target.viewName,
      task_id: generatedImage.taskId,
      model: generatedImage.model,
    },
  };
}

export async function POST(request: Request) {
  let projectIdForFailure: string | undefined;

  try {
    const body = (await request.json().catch(() => null)) as CreateDesignJobBody | null;
    const projectId = getStringValue(body?.projectId);
    const floorPlanId = getStringValue(body?.floorPlanId);
    const intentText = getStringValue(body?.intentText);

    if (!projectId || !floorPlanId) {
      return NextResponse.json(
        {
          ok: false,
          error: "projectId and floorPlanId are required",
        },
        { status: 400 },
      );
    }

    projectIdForFailure = projectId;
    const supabase = createSupabaseAdminClient();
    const { data: floorPlan, error: floorPlanError } = await supabase
      .from("design_floor_plans")
      .select("id,project_id,analysis_status,house_type,area,spaces,circulation")
      .eq("id", floorPlanId)
      .eq("project_id", projectId)
      .single();

    if (floorPlanError || !floorPlan) {
      return NextResponse.json(
        {
          ok: false,
          error: floorPlanError?.message || "户型图不存在",
        },
        { status: 404 },
      );
    }

    if (floorPlan.analysis_status !== "completed") {
      return NextResponse.json(
        {
          ok: false,
          error: "户型图解析完成后才能生成全屋效果图",
        },
        { status: 400 },
      );
    }

    const now = new Date().toISOString();
    const renderTargets = createRenderTargets(floorPlan.spaces);
    const wholeHomeTarget = renderTargets[0];
    const prompt = [
      "全屋效果图生成任务。",
      `本次先生成主图：${wholeHomeTarget.spaceName} · ${wholeHomeTarget.viewName}`,
      `可选空间：${renderTargets
        .slice(1)
        .map((target) => `${target.spaceName} · ${target.viewName}`)
        .join("、") || "无"}`,
      `户型：${floorPlan.house_type || "未识别"}`,
      `面积：${floorPlan.area ? `${floorPlan.area} 平方米` : "未识别"}`,
      `空间：${createSpacesText(floorPlan.spaces)}`,
      `用户需求：${intentText || "现代简约，明亮通透，耐脏好打理，预算中等"}`,
    ].join("\n");

    await supabase
      .from("design_projects")
      .update({
        status: "generating",
        intent_text: intentText,
        updated_at: now,
      })
      .eq("id", projectId);

    const { data: job, error: jobError } = await supabase
      .from("design_generation_jobs")
      .insert({
        project_id: projectId,
        floor_plan_id: floorPlanId,
        status: "running",
        progress: 20,
        prompt,
        provider: "dashscope",
        model: process.env.DASHSCOPE_IMAGE_MODEL || "wan2.7-image",
        started_at: now,
        updated_at: now,
      })
      .select("id,project_id,floor_plan_id,status,progress,prompt,provider,model,created_at,updated_at")
      .single();

    if (jobError || !job) {
      return NextResponse.json(
        {
          ok: false,
          error: jobError?.message || "创建生成任务失败",
        },
        { status: 500 },
      );
    }

    const generatedRender = await generateRenderForTarget({
      floorPlan,
      intentText,
      jobId: job.id,
      projectId,
      target: wholeHomeTarget,
    });

    const { data: render, error: renderError } = await supabase
      .from("design_renders")
      .insert(generatedRender.renderRow)
      .select("id,project_id,job_id,space_name,view_name,image_url,thumbnail_url,sort_order,created_at")
      .single();

    if (renderError || !render) {
      throw new Error(renderError?.message || "保存全屋效果图失败");
    }

    const completedAt = new Date().toISOString();
    const { data: completedJob, error: completeJobError } = await supabase
      .from("design_generation_jobs")
      .update({
        status: "completed",
        progress: 100,
        completed_at: completedAt,
        updated_at: completedAt,
        response_payload: {
          provider: "dashscope",
          primary_render: generatedRender.task,
          available_spaces: renderTargets.slice(1).map((target) => ({
            space_name: target.spaceName,
            view_name: target.viewName,
            sort_order: target.sortOrder,
          })),
        },
      })
      .eq("id", job.id)
      .select("id,project_id,floor_plan_id,status,progress,prompt,provider,model,created_at,updated_at,completed_at")
      .single();

    if (completeJobError || !completedJob) {
      throw new Error(completeJobError?.message || "更新生成任务失败");
    }

    await supabase
      .from("design_projects")
      .update({
        status: "completed",
        updated_at: completedAt,
      })
      .eq("id", projectId);

    return NextResponse.json({
      ok: true,
      job: completedJob,
      renders: [render],
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "创建生成任务失败";

    if (projectIdForFailure) {
      await markJobFailed({
        projectId: projectIdForFailure,
        errorMessage,
      });
    }

    return NextResponse.json(
      {
        ok: false,
        error: errorMessage,
      },
      { status: 500 },
    );
  }
}
