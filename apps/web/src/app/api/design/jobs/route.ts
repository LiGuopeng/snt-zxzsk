import { randomUUID } from "crypto";

import { NextResponse } from "next/server";

import { generateInteriorDesignImage } from "@/lib/ai/dashscope-images";
import { createPostgresClient } from "@/lib/db/postgres";
import { saveDesignAsset } from "@/lib/storage/design-assets";

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

type FloorPlanForRender = {
  id: string;
  project_id: string;
  analysis_status: string;
  house_type: string | null;
  area: number | null;
  spaces: unknown;
  circulation: string | null;
};

type DesignJobRow = {
  id: string;
  project_id: string;
  floor_plan_id: string;
  status: string;
  progress: number;
  prompt: string | null;
  provider: string | null;
  model: string | null;
  created_at: string;
  updated_at: string;
};

function getStringValue(value: unknown) {
  // API body 是外部输入，先收敛成 string | null，再参与 SQL 查询和 prompt 拼接。
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeSpaces(spaces: unknown) {
  // 户型解析由模型返回，结构可能不稳定；生成前只提取空间名和类型这两个必需字段。
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
  // 将模型解析出的中英文空间名称归一化，保证前端展示顺序和生成 prompt 稳定。
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
  // 结果展示顺序：先公共空间，再卧室、厨卫和其他空间，符合用户看全屋方案的习惯。
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
  // viewName 会写入 design_renders 并展示在前端卡片上，保持中文可读。
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
  // 各空间 prompt 重点不同，避免所有空间都生成成相似的通用室内图。
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

  // 同一类空间只生成一个入口，避免“卧室/次卧/Bedroom”重复挤满结果列表。
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
    // 第一张必须是全屋主图：先让用户快速看到总体方案，再按需补单个空间，减少一次性等待时间。
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
    // 全屋图要求 3D 轴测/俯视总览，重点是户型关系完整，不是单个房间摄影图。
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
    // 空间图是局部 2D 室内效果图，但仍引用户型解析结果，保持风格和空间关系一致。
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
  // 文件名携带 jobId，后续排查某张图片来源时可以从文件路径反查生成任务。
  return saveDesignAsset({
    buffer: params.imageBuffer,
    contentType: "image/png",
    extension: `-${params.jobId}-${randomUUID()}.png`,
    prefix: "renders",
    projectId: params.projectId,
  });
}

async function markJobFailed(params: {
  projectId: string;
  jobId?: string;
  errorMessage: string;
}) {
  const sql = createPostgresClient();

  // 任一生成阶段失败都同步回写任务和项目状态，前端据此退出“生成中”。
  if (params.jobId) {
    await sql`
      update public.design_generation_jobs
      set status = 'failed',
          progress = 100,
          error_message = ${params.errorMessage},
          completed_at = now(),
          updated_at = now()
      where id = ${params.jobId}
    `;
  }

  await sql`
    update public.design_projects
    set status = 'failed', updated_at = now()
    where id = ${params.projectId}
  `;
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
  // 这里调用真实 DashScope 生图服务，生成完成后下载图片并转存到本地 public/uploads。
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
    // 生成任务必须同时绑定 project 和 floor_plan，防止跨项目复用户型图生成。
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
    const sql = createPostgresClient();
    const [floorPlan] = await sql<FloorPlanForRender[]>`
      select id,project_id,analysis_status,house_type,area,spaces,circulation
      from public.design_floor_plans
      where id = ${floorPlanId} and project_id = ${projectId}
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

    if (floorPlan.analysis_status !== "completed") {
      return NextResponse.json(
        {
          ok: false,
          error: "户型图解析完成后才能生成全屋效果图",
        },
        { status: 400 },
      );
    }

    const renderTargets = createRenderTargets(floorPlan.spaces);
    const wholeHomeTarget = renderTargets[0];
    // 任务 prompt 保存的是本次生成概要，单张图片的完整 prompt 写入 DashScope 请求和 render metadata。
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

    await sql`
      update public.design_projects
      set status = 'generating', intent_text = ${intentText}, updated_at = now()
      where id = ${projectId}
    `;

    // design_generation_jobs 记录一次生成任务的生命周期；即使生图失败，也能回查 prompt 和错误状态。
    const [job] = await sql<DesignJobRow[]>`
      insert into public.design_generation_jobs (
        project_id,
        floor_plan_id,
        status,
        progress,
        prompt,
        provider,
        model,
        started_at,
        updated_at
      )
      values (
        ${projectId},
        ${floorPlanId},
        'running',
        20,
        ${prompt},
        'dashscope',
        ${process.env.DASHSCOPE_IMAGE_MODEL || "wan2.7-image"},
        now(),
        now()
      )
      returning id,project_id,floor_plan_id,status,progress,prompt,provider,model,created_at,updated_at
    `;

    // 创建任务接口只生成全屋主图；各空间图由 /spaces 接口按用户点击再生成，避免首屏等待过长。
    const generatedRender = await generateRenderForTarget({
      floorPlan,
      intentText,
      jobId: job.id,
      projectId,
      target: wholeHomeTarget,
    });

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
        ${generatedRender.renderRow.project_id},
        ${generatedRender.renderRow.job_id},
        ${generatedRender.renderRow.space_name},
        ${generatedRender.renderRow.view_name},
        ${generatedRender.renderRow.image_url},
        ${generatedRender.renderRow.thumbnail_url},
        ${generatedRender.renderRow.metadata.storage_path},
        ${generatedRender.renderRow.metadata.storage_path},
        ${generatedRender.renderRow.sort_order},
        ${sql.json(generatedRender.renderRow.metadata)}
      )
      returning id,project_id,job_id,space_name,view_name,image_url,thumbnail_url,storage_path,thumbnail_storage_path,sort_order,created_at
    `;

    const responsePayload = {
      provider: "dashscope",
      primary_render: generatedRender.task,
      // available_spaces 给前端渲染“可继续生成”的空间按钮，不代表这些图片已经生成。
      available_spaces: renderTargets.slice(1).map((target) => ({
        space_name: target.spaceName,
        view_name: target.viewName,
        sort_order: target.sortOrder,
      })),
    };
    const [completedJob] = await sql`
      update public.design_generation_jobs
      set status = 'completed',
          progress = 100,
          completed_at = now(),
          updated_at = now(),
          response_payload = ${sql.json(responsePayload)}
      where id = ${job.id}
      returning id,project_id,floor_plan_id,status,progress,prompt,provider,model,created_at,updated_at,completed_at
    `;

    await sql`
      update public.design_projects
      set status = 'completed', updated_at = now()
      where id = ${projectId}
    `;

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
