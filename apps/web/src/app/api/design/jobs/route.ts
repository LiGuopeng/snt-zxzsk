import { randomUUID } from "crypto";

import { NextResponse } from "next/server";

import { generateInteriorDesignImage } from "@/lib/ai/dashscope-images";
import { createPostgresClient } from "@/lib/db/postgres";
import { saveDesignAsset } from "@/lib/storage/design-assets";

// 创建全屋覆盖封面图的请求体；所有字段都按 unknown 接收，再通过工具函数做白名单收敛。
type CreateDesignJobBody = {
  projectId?: unknown;
  floorPlanId?: unknown;
  intentText?: unknown;
  designPreferences?: unknown;
};

// 用户生成偏好会同时进入 prompt 和 design_projects.extracted_preferences，后续可复盘生成依据。
type DesignPreferences = {
  feeling: string | null;
  family: string | null;
  priority: string | null;
  budget: string | null;
  custom_text: string | null;
  intent_text: string | null;
};

// 户型解析返回的空间结构不完全受控，这里只声明当前生成链路需要的最小字段。
type ParsedSpace = {
  name?: unknown;
  type?: unknown;
};

// RenderTarget 是内部生成目标。当前接口只真正生成第一张“全屋覆盖封面图”，其余 target 作为可按需生成空间列表。
type RenderTarget = {
  spaceName: string;
  viewName: string;
  promptFocus: string;
  sortOrder: number;
};

// 生成主图前只读取户型图的必要字段，避免接口和数据库表字段强耦合。
type FloorPlanForRender = {
  id: string;
  project_id: string;
  analysis_status: string;
  house_type: string | null;
  area: number | null;
  spaces: unknown;
  circulation: string | null;
};

// design_generation_jobs 的核心返回字段，供前端展示任务状态。
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

function parseDesignPreferences(value: unknown, fallbackIntentText: string | null): DesignPreferences {
  // 兼容旧版本只传 intentText 的情况；没有结构化偏好时使用 fallbackIntentText 兜底。
  if (!value || typeof value !== "object") {
    return {
      feeling: null,
      family: null,
      priority: null,
      budget: null,
      custom_text: null,
      intent_text: fallbackIntentText,
    };
  }

  const record = value as Record<string, unknown>;
  const preferences = {
    feeling: getStringValue(record.feeling),
    family: getStringValue(record.family),
    priority: getStringValue(record.priority),
    budget: getStringValue(record.budget),
    custom_text: getStringValue(record.custom_text),
    intent_text: getStringValue(record.intent_text) || fallbackIntentText,
  };

  return preferences;
}

function createPreferenceText(preferences: DesignPreferences) {
  // prompt 中用自然语言描述结构化偏好，模型比读 JSON 更稳定。
  const lines = [
    preferences.feeling ? `居住感觉：${preferences.feeling}` : null,
    preferences.family ? `居住成员：${preferences.family}` : null,
    preferences.priority ? `重点诉求：${preferences.priority}` : null,
    preferences.budget ? `预算倾向：${preferences.budget}` : null,
    preferences.custom_text ? `补充要求：${preferences.custom_text}` : null,
  ].filter(Boolean);

  return lines.length ? lines.join("；") : preferences.intent_text || "现代简约，明亮通透，耐脏好打理，预算中等";
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
  // 即使当前只生成全屋主图，也先构造完整空间列表，供 response_payload 和右侧按钮使用。
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

  // 第一张图要“正式全屋覆盖”，但真实室内单镜头天然无法同时看到所有房间。
  // 所以这里把解析出的主要空间收敛成封面图覆盖清单，让模型生成同一风格下的多分镜真实效果图。
  const coverSpaceNames = spaceTargets.map((target) => target.spaceName).slice(0, 8).join("、");

  return [
    // 第一张是全屋覆盖封面图：用多分镜真实效果覆盖主要空间，不再用单个客餐厅镜头冒充全屋。
    {
      spaceName: "全屋",
      viewName: "全屋覆盖封面图",
      promptFocus: `一张图内以多分镜覆盖解析出的主要空间：${coverSpaceNames}。每个分镜都必须是真实装修后的室内效果图，并保持同一套风格、材质、色系、灯光和家具语言。`,
      sortOrder: 0,
    },
    ...spaceTargets,
  ];
}

function buildPrompt(
  intentText: string | null,
  preferences: DesignPreferences,
  floorPlan: {
    house_type: string | null;
    area: number | null;
    spaces: unknown;
    circulation: string | null;
  },
  target: RenderTarget,
) {
  if (target.spaceName === "全屋") {
    // 全屋覆盖封面图用“多分镜真实室内图”解决覆盖问题：
    // 既能让第一张图覆盖全屋主要空间，又避免退化成户型图、模型图或俯视结构图。
    return [
      "根据用户上传的户型图和解析结果，生成一张装修完成后的真实全屋覆盖封面图。",
      "这不是单个房间镜头，而是一张室内设计作品集封面式多分镜图。",
      "同一张图片中必须用多个真实摄影级室内分镜覆盖解析出的主要空间，例如客厅/餐厅公共区、主卧、次卧或儿童房、厨房、卫生间、阳台或书房。",
      "每个分镜都必须像真实装修效果图，有真实家具、灯具、墙面、地面、柜体、软装和居住尺度。",
      "所有分镜必须保持同一套装修风格、材质、色系、灯光和家具语言，让用户能看出这是同一个家的完整方案。",
      "默认风格：现代轻奢、明亮通透、暖白墙面、浅米色软装、深色木地板或木饰面、拱形门洞/壁龛、嵌入式灯带、真实家具软装、干净耐看的家装产品质感。",
      "画面质量：photorealistic interior rendering, interior design portfolio cover, multi-panel realistic home render, cinematic lighting, realistic materials, soft shadows。",
      "构图要求：画面可以是 4-6 个整齐分区的真实室内分镜组合，但不要出现文字标题、房间标签、尺寸标注或图纸符号。",
      "禁止生成户型立体图、俯视轴测图、剖切模型图、dollhouse、平面户型图、2D 图纸、施工图、手绘图、带标签的空间示意图。",
      "不要只生成客厅或餐厅；如果只出现单个空间，就不符合全屋覆盖封面图要求。",
      `当前生成目标：${target.spaceName} · ${target.viewName}`,
      `画面重点：${target.promptFocus}`,
      `户型：${floorPlan.house_type || "未识别"}`,
      `面积：${floorPlan.area ? `${floorPlan.area} 平方米` : "未识别"}`,
      `空间：${createSpacesText(floorPlan.spaces)}`,
      `动线：${floorPlan.circulation || "未识别"}`,
      `结构化偏好：${createPreferenceText(preferences)}`,
      `用户补充需求：${intentText || preferences.intent_text || "无补充，使用固定默认风格"}`,
      "最终输出只能是一张真实装修后的全屋覆盖封面图：既要覆盖主要空间，也必须真实、可落地、像室内摄影或高质量效果图。",
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
    `结构化偏好：${createPreferenceText(preferences)}`,
    `用户需求：${intentText || preferences.intent_text || "现代简约，明亮通透，耐脏好打理，预算中等"}`,
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
  preferences: DesignPreferences;
  jobId: string;
  projectId: string;
  target: RenderTarget;
}) {
  // 一个 target 对应一次真实 DashScope 生图 + 一条 design_renders 记录。
  // 当前主接口只调用一次，空间图改由 /jobs/[id]/spaces 手动按需生成。
  const targetPrompt = buildPrompt(params.intentText, params.preferences, params.floorPlan, params.target);
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
        render_role: params.target.spaceName === "全屋" ? "whole_home_cover" : "space_derived",
        render_mode: "2d",
        design_preferences: params.preferences,
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
    const designPreferences = parseDesignPreferences(body?.designPreferences, intentText);

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
          error: "户型图解析完成后才能生成全屋覆盖封面图",
        },
        { status: 400 },
      );
    }

    const renderTargets = createRenderTargets(floorPlan.spaces);
    const wholeHomeTarget = renderTargets[0];
    // 任务 prompt 保存的是本次生成概要，单张图片的完整 prompt 写入 DashScope 请求和 render metadata。
    const prompt = [
      "全屋覆盖封面图生成任务。",
      `本次先生成主图：${wholeHomeTarget.spaceName} · ${wholeHomeTarget.viewName}`,
      `可选空间：${renderTargets
        .slice(1)
        .map((target) => `${target.spaceName} · ${target.viewName}`)
        .join("、") || "无"}`,
      `户型：${floorPlan.house_type || "未识别"}`,
      `面积：${floorPlan.area ? `${floorPlan.area} 平方米` : "未识别"}`,
      `空间：${createSpacesText(floorPlan.spaces)}`,
      `结构化偏好：${createPreferenceText(designPreferences)}`,
      `用户需求：${intentText || designPreferences.intent_text || "现代简约，明亮通透，耐脏好打理，预算中等"}`,
    ].join("\n");

    await sql`
      update public.design_projects
      set status = 'generating',
          intent_text = ${intentText || designPreferences.intent_text},
          extracted_preferences = ${sql.json(designPreferences)},
          updated_at = now()
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
        request_payload,
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
        ${sql.json({
          intent_text: intentText || designPreferences.intent_text,
          design_preferences: designPreferences,
          floor_plan_id: floorPlanId,
        })},
        now(),
        now()
      )
      returning id,project_id,floor_plan_id,status,progress,prompt,provider,model,created_at,updated_at
    `;

    // 创建任务接口只生成第一张全屋覆盖封面图；空间图由用户在右侧点击某个空间后按需生成。
    const generatedRender = await generateRenderForTarget({
      floorPlan,
      intentText,
      preferences: designPreferences,
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
      returning id,project_id,job_id,space_name,view_name,image_url,thumbnail_url,storage_path,thumbnail_storage_path,sort_order,metadata,created_at
    `;

    const responsePayload = {
      provider: "dashscope",
      primary_render: generatedRender.task,
      // available_spaces 给前端渲染“可继续生成”的空间按钮，不代表这些图片已经生成，也不会触发自动批量生图。
      available_spaces: renderTargets.slice(1).map((target) => ({
        space_name: target.spaceName,
        view_name: target.viewName,
        sort_order: target.sortOrder,
      })),
      design_preferences: designPreferences,
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
