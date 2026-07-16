import { randomUUID } from "crypto";

import { NextResponse } from "next/server";

import { generateInteriorDesignImage } from "@/lib/ai/dashscope-images";
import { createPostgresClient } from "@/lib/db/postgres";
import { readDesignAssetAsDataUrl, saveDesignAsset } from "@/lib/storage/design-assets";

// Next.js 动态路由参数。这里的 id 是 design_generation_jobs.id，空间图必须挂在同一个 job 下。
type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

// 单空间生成请求体。renderMode 决定生成 2D 室内效果图还是 3D 立体效果图。
type GenerateSpaceBody = {
  renderMode?: unknown;
  spaceName?: unknown;
  spaceType?: unknown;
};

// 2D 和 3D 共用同一张 design_renders 表，通过 metadata.render_mode 区分。
type RenderMode = "2d" | "3d";

// 结构化偏好来自 project.extracted_preferences 或 job.response_payload，用于保证空间图和主图风格一致。
type DesignPreferences = {
  feeling: string | null;
  family: string | null;
  priority: string | null;
  budget: string | null;
  custom_text: string | null;
  intent_text: string | null;
};

// 空间图生成必须参考已经生成的“全屋 · 全屋覆盖封面图”，这些字段用于读取参考图片。
type WholeHomeReferenceRender = {
  id: string;
  image_url: string;
  storage_path: string | null;
  thumbnail_url: string | null;
  space_name: string;
  view_name: string;
};

function getStringValue(value: unknown) {
  // 请求体来自浏览器，所有字符串都先 trim，空字符串统一按 null 处理。
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getRenderModeValue(value: unknown): RenderMode {
  // 默认走 2D，只有明确传入 "3d" 才生成 3D，避免历史调用意外进入慢模型链路。
  return value === "3d" ? "3d" : "2d";
}

function getRecordValue(value: unknown) {
  // 数据库 JSONB 可能为空，统一转成安全对象后再读取字段。
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function parseDesignPreferences(value: unknown, fallbackIntentText: string | null): DesignPreferences {
  // 空间图使用和全屋封面图相同的偏好信息，避免单空间重新跑出另一套风格。
  const record = getRecordValue(value);

  return {
    feeling: getStringValue(record.feeling),
    family: getStringValue(record.family),
    priority: getStringValue(record.priority),
    budget: getStringValue(record.budget),
    custom_text: getStringValue(record.custom_text),
    intent_text: getStringValue(record.intent_text) || fallbackIntentText,
  };
}

function createPreferenceText(preferences: DesignPreferences) {
  // 将结构化偏好转成人类语言放入 prompt，模型理解更稳定。
  const lines = [
    preferences.feeling ? `居住感觉：${preferences.feeling}` : null,
    preferences.family ? `居住成员：${preferences.family}` : null,
    preferences.priority ? `重点诉求：${preferences.priority}` : null,
    preferences.budget ? `预算倾向：${preferences.budget}` : null,
    preferences.custom_text ? `补充要求：${preferences.custom_text}` : null,
  ].filter(Boolean);

  return lines.length ? lines.join("；") : preferences.intent_text || "现代简约，明亮通透，耐脏好打理，预算中等";
}

async function createReferenceImageInput(referenceRender: WholeHomeReferenceRender) {
  // 严格标准：空间图必须使用全屋覆盖封面图作为真实图片参考输入。
  // 本项目把图片保存在 public/uploads，本地相对 URL 不能直接给 DashScope 云端访问，所以优先读取 storage_path 转 data URL。
  if (referenceRender.storage_path) {
    return readDesignAssetAsDataUrl({
      contentType: "image/png",
      storagePath: referenceRender.storage_path,
    });
  }

  // 兼容历史数据：如果某些旧记录没有 storage_path，但 image_url 已经是公网地址，也允许作为参考图输入。
  if (/^https?:\/\//.test(referenceRender.image_url)) {
    return referenceRender.image_url;
  }

  throw new Error("缺少可作为参考输入的全屋覆盖封面图文件，请先重新生成全屋覆盖封面图");
}

function normalizeSpaceType(spaceName: string, spaceType: string | null, renderMode: RenderMode) {
  // 空间图的标题由解析出的空间名称决定，不再使用固定默认空间列表。
  if (spaceName === "全屋") {
    return renderMode === "3d" ? "全屋3D立体效果图" : "全屋覆盖封面图";
  }

  const value = `${spaceType || ""} ${spaceName}`.toLowerCase();
  const suffix = renderMode === "3d" ? "3D立体效果图" : "效果图";

  if (value.includes("living") || spaceName.includes("客厅")) return `客厅${suffix}`;
  if (value.includes("dining") || spaceName.includes("餐厅")) return `餐厅${suffix}`;
  if (value.includes("master") || spaceName.includes("主卧")) return `主卧${suffix}`;
  if (value.includes("bedroom") || spaceName.includes("卧")) return `卧室${suffix}`;
  if (value.includes("kitchen") || spaceName.includes("厨房")) return `厨房${suffix}`;
  if (value.includes("bath") || value.includes("toilet") || spaceName.includes("卫生间") || spaceName.includes("卫")) return `卫生间${suffix}`;
  if (value.includes("study") || spaceName.includes("书房")) return `书房${suffix}`;
  if (value.includes("balcony") || spaceName.includes("阳台")) return `阳台${suffix}`;

  return `空间${suffix}`;
}

function createSpacesText(spaces: unknown) {
  // 户型解析的 spaces 只用于给 prompt 提供全屋上下文，不直接决定本次生成数量。
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
  masterRenderUrl: string;
  preferences: DesignPreferences;
  renderMode: RenderMode;
  spaceName: string;
  spaceType: string | null;
  spaces: unknown;
  viewName: string;
}) {
  if (params.renderMode === "3d") {
    return [
      // 3D 模式输出的是装修后的立体效果图，不是顶部户型结构图，也不是可交互模型文件。
      `从已经生成的全屋覆盖封面图方案中，延展出一张${params.spaceName} 3D 装修立体效果图，风格参考高端装修平台里的 3D furnished apartment cutaway render。`,
      params.spaceName === "全屋"
        ? "画面必须像参考图一样完整展示整套房：45度斜俯视轴测视角、开顶户型、低矮墙体、所有主要房间同时入镜，能清楚看到客餐厅、卧室、厨房、卫生间、阳台、走廊和窗户位置。"
        : "画面必须像参考图一样使用 45度斜俯视轴测视角，聚焦当前空间，同时保留局部墙体、门洞、窗户、相邻空间入口和家具布置。",
      "画面必须是装修完成后的 3D 全屋立体效果图：暖白墙体、浅木/浅米色地面、真实柜体、沙发、餐桌、床、厨房橱柜、卫浴、绿植、灯光、窗帘和软装都要完整呈现。",
      "空间表现要接近专业建筑可视化：isometric 3D furnished apartment, open-top cutaway, low white walls, transparent glass windows, realistic furniture, warm natural lighting, soft shadows, clean white background。",
      "墙体要有厚度和高度，但不能遮挡室内；家具和软装要有真实装修质感，不能是白盒结构、不能是毛坯模型、不能是纯户型结构图。",
      "全屋 3D 图必须是一个完整的单套住宅立体模型，不要拆成多宫格，不要只生成单个客厅或卧室。",
      "不要生成平面户型图，不要生成蓝图，不要生成施工图，不要生成文字标签，不要生成尺寸标注，不要生成纯结构模型，不要生成普通室内摄影单镜头。",
      `当前生成目标：${params.spaceName} · ${params.viewName}`,
      "必须和参考的全屋覆盖封面图保持同一套风格、色系、材质、灯光和家具语言。",
      `全屋覆盖封面图地址：${params.masterRenderUrl}`,
      `户型：${params.houseType || "未识别"}`,
      `面积：${params.area ? `${params.area} 平方米` : "未识别"}`,
      `全部空间：${createSpacesText(params.spaces)}`,
      `动线：${params.circulation || "未识别"}`,
      `结构化偏好：${createPreferenceText(params.preferences)}`,
      `用户需求：${params.intentText || params.preferences.intent_text || "现代简约，明亮通透，耐脏好打理，预算中等"}`,
    ].join("\n");
  }

  return [
    // 空间图不是独立方案，而是“全屋覆盖封面图”的同源延展视角。
    // 当前 DashScope 生图接口是文生图能力，不能物理裁剪封面图；所以这里通过主方案约束和 metadata 绑定保证同源关系。
    `从已经生成的全屋覆盖封面图方案中，拆分/延展出一张${params.spaceName} 2D 室内装修效果图。`,
    "画面要求：真实落地装修后的室内效果图视角，摄影级渲染，真实材质，自然光线，合理广角，真实家具、灯具、地面、墙面、柜体和软装。",
    "空间效果图只表现当前房间或功能区，不使用全屋 3D 轴测视角，但必须像是从同一套全屋覆盖封面方案中拆出来的局部视角。",
    "不要生成户型平面图，不要生成施工图，不要生成手绘图，不要生成三维全屋俯视模型，不要生成模型图或白盒图。",
    `当前生成目标：${params.spaceName} · ${params.viewName}`,
    "必须聚焦当前空间，且风格、色系、材质、灯光、家具语言、收纳设计和全屋覆盖封面图保持统一。",
    `全屋覆盖封面图地址：${params.masterRenderUrl}`,
    `户型：${params.houseType || "未识别"}`,
    `面积：${params.area ? `${params.area} 平方米` : "未识别"}`,
    `全部空间：${createSpacesText(params.spaces)}`,
    `动线：${params.circulation || "未识别"}`,
    `结构化偏好：${createPreferenceText(params.preferences)}`,
    `用户需求：${params.intentText || params.preferences.intent_text || "现代简约，明亮通透，耐脏好打理，预算中等"}`,
  ].join("\n");
}

async function uploadGeneratedImage(params: {
  imageBuffer: Buffer;
  jobId: string;
  projectId: string;
}) {
  // DashScope 图片是临时地址，必须落到本项目存储，前端才能稳定加载和部署迁移。
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
    // 本接口是按需生成：一次请求只处理一个 spaceName，不循环 floorPlan.spaces。
    const renderMode = getRenderModeValue(body?.renderMode);
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
    // 只有全屋主图任务完成后才允许生成空间图，否则没有统一方案可参考。
    const [job] = await sql`
      select id,project_id,floor_plan_id,status,response_payload
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

    if (job.status !== "completed") {
      return NextResponse.json(
        {
          ok: false,
          error: "全屋覆盖封面图生成完成后才能拆分空间效果图",
        },
        { status: 400 },
      );
    }

    // 全屋覆盖封面图是空间图的父级参考图；没有它就拒绝生成，避免空间图变成独立方案。
    const [wholeHomeRender] = await sql<WholeHomeReferenceRender[]>`
      select id,image_url,storage_path,thumbnail_url,space_name,view_name
      from public.design_renders
      where job_id = ${id} and space_name = '全屋'
      order by sort_order asc, created_at asc
      limit 1
    `;

    if (!wholeHomeRender) {
      return NextResponse.json(
        {
          ok: false,
          error: "缺少全屋覆盖封面图，不能拆分空间效果图",
        },
        { status: 400 },
      );
    }

    // 同一个 job + spaceName + renderMode 只生成一次，重复点击直接返回旧结果，降低费用和等待时间。
    const [existingRender] = await sql`
      select id,project_id,job_id,space_name,view_name,image_url,thumbnail_url,sort_order,metadata,created_at
      from public.design_renders
      where job_id = ${id}
        and space_name = ${spaceName}
        and coalesce(metadata->>'render_mode', '2d') = ${renderMode}
      limit 1
    `;

    if (existingRender) {
      // 同一任务同一空间只生成一次；重复点击直接返回已有图片，减少生图费用和等待时间。
      return NextResponse.json({
        ok: true,
        render: existingRender,
      });
    }

    const referenceImageInput = await createReferenceImageInput(wholeHomeRender);

    // project 提供用户偏好，floorPlan 提供户型结构；两者共同约束空间图。
    const [project] = await sql`
      select intent_text, extracted_preferences
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

    const viewName = normalizeSpaceType(spaceName, spaceType, renderMode);
    const jobPayload = getRecordValue(job.response_payload);
    const designPreferences = parseDesignPreferences(
      jobPayload.design_preferences || project?.extracted_preferences,
      project?.intent_text || null,
    );
    // 空间图仍引用户型解析结果，保证单空间效果与全屋覆盖封面方案的面积、动线和风格一致。
    const prompt = buildPrompt({
      area: floorPlan.area,
      circulation: floorPlan.circulation,
      houseType: floorPlan.house_type,
      intentText: project?.intent_text || designPreferences.intent_text || null,
      masterRenderUrl: wholeHomeRender.image_url,
      preferences: designPreferences,
      renderMode,
      spaceName,
      spaceType,
      spaces: floorPlan.spaces,
      viewName,
    });
    const generatedImage = await generateInteriorDesignImage(prompt, {
      referenceImages: [referenceImageInput],
    });
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
          // metadata 是后续追溯和前端过滤的关键：能看出这张图从哪个全屋封面派生、属于 2D 还是 3D。
          source: "dashscope_image_generation",
          task_id: generatedImage.taskId,
          storage_path: uploadedImage.storagePath,
          space_type: spaceType,
          parent_render_id: wholeHomeRender.id,
          parent_render_url: wholeHomeRender.image_url,
          generation_relation: "strict_reference_from_whole_home_cover",
          reference_input_mode: referenceImageInput.startsWith("data:") ? "data_url" : "public_url",
          render_mode: renderMode,
          design_preferences: designPreferences,
        })}
      )
      returning id,project_id,job_id,space_name,view_name,image_url,thumbnail_url,storage_path,thumbnail_storage_path,sort_order,metadata,created_at
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
