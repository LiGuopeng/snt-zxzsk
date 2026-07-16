"use client";

import { ChangeEvent, useRef, useState } from "react";

// 右侧“输出”模块展示的是效果图能力边界，不参与接口参数计算。
const DEFAULT_OUTPUTS = ["2D真实效果图", "3D立体效果图", "统一风格", "放大预览"];
// 户型图上传大小限制要和后端保持一致，避免前端放过、后端拒绝造成体验割裂。
const MAX_FLOOR_PLAN_SIZE = 15 * 1024 * 1024;
// PDF 允许上传是为了兼容用户从售楼处/设计师拿到的原始户型资料。
const ALLOWED_FLOOR_PLAN_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);

// 前端持有的户型图状态，字段和 design_floor_plans 返回值保持一致。
// analysis_result 是 JSONB 扩展字段，用于承载门窗、动线、结构风险和户型立体图结果。
type UploadedFloorPlan = {
  id: string;
  project_id: string;
  file_url: string;
  storage_path: string | null;
  file_name: string;
  file_type: string | null;
  file_size: number | null;
  upload_status: string;
  analysis_status: string;
  house_type?: string | null;
  area?: number | null;
  spaces?: Array<{
    name: string;
    type: string;
    confidence?: number;
    estimated_area?: number | null;
    area_ratio?: number | null;
    connections?: string[];
  }>;
  circulation?: string | null;
  analysis_result?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

// 上传接口返回 project + floorPlan；project 负责把后续效果图任务串到同一条业务链路。
type FloorPlanUploadResponse = {
  ok: boolean;
  project?: {
    id: string;
    title: string;
    status: string;
    intent_text: string | null;
    created_at: string;
    updated_at: string;
  };
  floorPlan?: UploadedFloorPlan;
  error?: string;
};

// 解析接口返回结构化户型结果；这些字段会同时用于诊断面板、效果图 prompt 和右侧空间按钮。
type FloorPlanAnalyzeResponse = {
  ok: boolean;
  floorPlan?: UploadedFloorPlan;
  analysis?: {
    house_type: string | null;
    area: number | null;
    spaces: Array<{
      name: string;
      type: string;
      confidence?: number;
      estimated_area?: number | null;
      area_ratio?: number | null;
      connections?: string[];
    }>;
    spaces_summary?: string;
    circulation: string | null;
    orientation: string | null;
    doors?: Array<Record<string, unknown>>;
    windows?: Array<Record<string, unknown>>;
    walls?: Array<Record<string, unknown>>;
    wet_areas?: Array<Record<string, unknown>>;
    balconies?: Array<Record<string, unknown>>;
    circulation_analysis?: Record<string, unknown>;
    area_ratio_analysis?: Record<string, unknown>;
    structure_risk_warnings?: string[];
    confidence: number;
    warnings: string[];
  };
  error?: string;
};

// 户型立体结构图接口返回值。它只更新 floorPlan.analysis_result，不写入 design_renders。
type StructureRenderResponse = {
  ok: boolean;
  floorPlan?: UploadedFloorPlan;
  structureRender?: {
    image_url?: string;
    storage_path?: string;
    provider?: string;
    model?: string;
    task_id?: string;
    generated_at?: string;
  };
  error?: string;
};

// 装修效果图记录，对应 design_renders。metadata.render_mode 用来区分 2D 和 3D。
type DesignRender = {
  id: string;
  project_id: string;
  job_id: string;
  space_name: string;
  view_name: string;
  image_url: string;
  thumbnail_url: string | null;
  sort_order: number;
  metadata?: Record<string, unknown> | null;
  created_at: string;
};

// 生图任务记录，对应 design_generation_jobs，用于前端展示进度和失败原因。
type DesignJob = {
  id: string;
  project_id: string;
  floor_plan_id: string;
  status: string;
  progress: number;
  prompt: string | null;
  provider: string | null;
  model: string | null;
  error_message?: string | null;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
};

// 创建全屋覆盖封面图接口返回值。
type CreateDesignJobResponse = {
  ok: boolean;
  job?: DesignJob;
  renders?: DesignRender[];
  error?: string;
};

// 单空间按需生成接口返回值；点击一个空间只会追加这一张 render。
type CreateSpaceRenderResponse = {
  ok: boolean;
  render?: DesignRender;
  error?: string;
};

// 示例需求只用于快速填充引导输入，不会覆盖用户已经选择的户型解析结果。
const EXAMPLE_INTENTS = [
  "现代简约 · 明亮通透 · 有小孩",
  "奶油风 · 温柔耐看 · 收纳多",
  "原木风 · 自然放松 · 预算中等",
];

// 引导式问题把用户自由描述收敛成稳定字段，后端可以把这些字段写入 prompt 和数据库。
const GUIDE_QUESTIONS = [
  {
    id: "feeling",
    title: "你更希望家里是什么感觉？",
    options: ["明亮通透", "温暖松弛", "高级简洁", "自然放松"],
  },
  {
    id: "family",
    title: "主要居住成员是？",
    options: ["独居", "两口之家", "有小孩", "和父母同住"],
  },
  {
    id: "priority",
    title: "这次更在意什么？",
    options: ["收纳", "显大", "好打理", "预算控制", "氛围感"],
  },
  {
    id: "budget",
    title: "预算倾向是？",
    options: ["经济实用", "中等预算", "品质升级"],
  },
];

type GuideQuestion = (typeof GUIDE_QUESTIONS)[number];
// key 是 GUIDE_QUESTIONS.id，value 是用户选中的选项。
type GuideSelections = Record<string, string>;
// 效果图方案区的模式：2D 看真实室内视角，3D 看装修后的立体轴测关系。
type RenderMode = "2d" | "3d";

// 结构化偏好会写入 design_projects.extracted_preferences，方便后续追溯一次生成为什么这样出图。
type DesignPreferences = {
  feeling: string | null;
  family: string | null;
  priority: string | null;
  budget: string | null;
  custom_text: string | null;
  intent_text: string;
};

function buildIntentFromGuide(selections: GuideSelections, customText: string) {
  // 最终 intentText 仍保持一个字符串，兼容原有接口和数据库字段。
  const selectedParts = GUIDE_QUESTIONS.map((question) => selections[question.id]).filter(Boolean);
  const trimmedCustomText = customText.trim();

  return [...selectedParts, trimmedCustomText].filter(Boolean).join(" · ");
}

function buildDesignPreferences(selections: GuideSelections, customText: string): DesignPreferences {
  // 后端既需要结构化字段，也需要完整 intent_text；这里一次性组装，避免两边口径不一致。
  const intentText = buildIntentFromGuide(selections, customText);

  return {
    feeling: selections.feeling || null,
    family: selections.family || null,
    priority: selections.priority || null,
    budget: selections.budget || null,
    custom_text: customText.trim() || null,
    intent_text: intentText,
  };
}

function getGenerationStatusLabel(status: string | null) {
  if (status === "running") {
    return "生成中";
  }

  if (status === "completed") {
    return "已完成";
  }

  if (status === "failed") {
    return "生成失败";
  }

  return "待生成";
}

function getGenerationStatusClassName(status: string | null) {
  if (status === "completed") {
    return "text-[#13875a]";
  }

  if (status === "failed") {
    return "text-[#ef3349]";
  }

  if (status === "running") {
    return "text-[#0969ff]";
  }

  return "text-[#7d8aa6]";
}

function formatFileSize(size: number | null) {
  if (!size) {
    return "";
  }

  if (size < 1024 * 1024) {
    return `${Math.max(1, Math.round(size / 1024))}KB`;
  }

  return `${(size / 1024 / 1024).toFixed(1)}MB`;
}

function wait(ms: number) {
  // 生成任务轮询使用轻量 sleep，避免引入额外依赖。
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRenderableImageUrl(render: DesignRender) {
  // 当前缩略图和原图暂时同源，保留这个方法是为了后续接入真正缩略图时不改 JSX。
  return render.thumbnail_url || render.image_url;
}

function getRenderMode(render: DesignRender): RenderMode {
  // 新数据优先读 metadata.render_mode；历史数据没有 metadata 时，用 view_name 兜底判断。
  const metadataMode = render.metadata?.render_mode;

  if (metadataMode === "3d") {
    return "3d";
  }

  if (metadataMode === "2d") {
    return "2d";
  }

  return render.view_name.includes("3D") || render.view_name.includes("立体") ? "3d" : "2d";
}

function getRenderModeLabel(mode: RenderMode) {
  return mode === "3d" ? "3D立体" : "2D效果";
}

function createRenderSpaceKey(mode: RenderMode, spaceName: string) {
  // 同一个空间允许同时生成 2D 和 3D，所以按钮去重必须把模式也纳入 key。
  return `${mode}:${spaceName}`;
}

function getRecordValue(value: unknown) {
  // analysis_result 来自 JSONB，读取前统一收敛，避免空值或数组导致运行时报错。
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function getStringList(value: unknown) {
  // 模型返回的数组可能混有非字符串，展示前过滤掉无效项。
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item)) : [];
}

function getObjectList(value: unknown) {
  // 门窗、墙体等识别结果是对象数组；这里做最小形态校验，UI 不关心内部字段是否完整。
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : [];
}

function getTextValue(value: unknown, fallback = "待识别") {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function getStructureRenderImageUrl(analysisResult: Record<string, unknown>) {
  // 户型立体图是独立于装修效果图的真实生图结果，保存在 floor_plan.analysis_result.structure_render。
  // 这里集中读取 URL，避免 JSX 里反复判断未知 JSON 结构。
  const structureRender = getRecordValue(analysisResult.structure_render);
  const imageUrl = structureRender.image_url;

  return typeof imageUrl === "string" && imageUrl ? imageUrl : null;
}

export function DesignWorkspace() {
  // fileInputRef 用于触发隐藏的原生文件选择框；renderTrackRef 用于控制底部缩略图横向滚动。
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const renderTrackRef = useRef<HTMLDivElement | null>(null);
  // intentText 保留旧自由输入链路；guidedIntentText 会优先覆盖它。
  const [intentText, setIntentText] = useState("");
  // guideSelections 保存引导问题答案，保证不同用户输入也能落到稳定的结构化偏好。
  const [guideSelections, setGuideSelections] = useState<GuideSelections>({});
  // customIntentText 是引导问题之外的补充要求，会和选项一起组成最终生成意图。
  const [customIntentText, setCustomIntentText] = useState("");
  // floorPlan 是本页面的核心数据源：上传、解析、诊断、结构图和效果图生成都围绕它展开。
  const [floorPlan, setFloorPlan] = useState<UploadedFloorPlan | null>(null);
  // uploading/analyzing/structureRendering/generating 分别对应四条异步链路，UI 需要分别展示 loading。
  const [uploading, setUploading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [structureRendering, setStructureRendering] = useState(false);
  const [generating, setGenerating] = useState(false);
  // 错误状态拆开存储，避免户型上传失败、户型解析失败、生图失败互相覆盖。
  const [uploadError, setUploadError] = useState("");
  const [analysisError, setAnalysisError] = useState("");
  const [structureRenderError, setStructureRenderError] = useState("");
  const [generationError, setGenerationError] = useState("");
  // generationJob 表示一次全屋覆盖封面图任务；空间图必须挂在这个任务下面。
  const [generationJob, setGenerationJob] = useState<DesignJob | null>(null);
  // renders 同时保存 2D 和 3D 结果，展示时通过 metadata.render_mode 过滤。
  const [renders, setRenders] = useState<DesignRender[]>([]);
  // activeRenderMode 决定主图区域展示哪一类图，也决定右侧空间按钮生成 2D 还是 3D。
  const [activeRenderMode, setActiveRenderMode] = useState<RenderMode>("2d");
  // activeRenderId 只在当前模式内生效；切换 2D/3D 时会自动定位该模式第一张图。
  const [activeRenderId, setActiveRenderId] = useState<string | null>(null);
  // previewRender 控制效果图放大弹窗；户型立体结构图使用单独的 structurePreviewOpen，避免两个模块混用。
  const [previewRender, setPreviewRender] = useState<DesignRender | null>(null);
  // previewRotation 只影响放大预览里的 CSS 旋转，不修改原始图片和数据库。
  const [previewRotation, setPreviewRotation] = useState(0);
  const [structurePreviewOpen, setStructurePreviewOpen] = useState(false);
  // failedImageIds 记录加载失败的图片，避免整块 UI 因单张图失效而空白。
  const [failedImageIds, setFailedImageIds] = useState<Set<string>>(new Set());
  // generatingSpaceKey 用 mode + spaceName 锁住当前正在生成的空间，防止用户连续点击发出多笔请求。
  const [generatingSpaceKey, setGeneratingSpaceKey] = useState<string | null>(null);

  const hasFloorPlan = Boolean(floorPlan);
  const analysisCompleted = floorPlan?.analysis_status === "completed";
  const analysisFailed = floorPlan?.analysis_status === "failed";
  const uploadStatusLabel = uploading
    ? "上传中"
    : analyzing
      ? "解析中"
      : analysisCompleted
        ? "已解析"
        : analysisFailed
          ? "解析失败"
        : hasFloorPlan
          ? "已上传"
          : "待上传";
  const uploadStatusClassName = uploading
    ? "rounded-full bg-[#eef6ff] px-2.5 py-1 text-xs font-medium text-[#0969ff]"
    : analyzing
      ? "rounded-full bg-[#eef6ff] px-2.5 py-1 text-xs font-medium text-[#0969ff]"
      : analysisCompleted
      ? "rounded-full bg-[#e6f8ef] px-2.5 py-1 text-xs font-medium text-[#13945f]"
      : analysisFailed
        ? "rounded-full bg-[#fff0f2] px-2.5 py-1 text-xs font-medium text-[#ef3349]"
      : hasFloorPlan
        ? "rounded-full bg-[#fff4e5] px-2.5 py-1 text-xs font-medium text-[#b76a00]"
        : "rounded-full bg-[#fff4e5] px-2.5 py-1 text-xs font-medium text-[#b76a00]";

  const spacesSummary = floorPlan?.spaces?.length
    ? floorPlan.spaces.map((space) => space.name).join("、")
    : null;
  const canGenerate = analysisCompleted;
  // 户型上传链路是连续流程：上传原图 -> 解析平面户型 -> 生成户型立体图。
  // 任一阶段进行中都禁用上传按钮，避免用户重复点击造成多条 floor_plan/project 记录交叉。
  const floorPlanBusy = uploading || analyzing || structureRendering;
  const floorPlanUploadButtonLabel = uploading
    ? "上传中..."
    : analyzing
      ? "解析中..."
      : structureRendering
        ? "生成立体图..."
        : hasFloorPlan
          ? "重新上传"
          : "上传户型图";
  // guidedIntentText 是前端最终展示和提交给后端的生成意图；为空时允许后端使用默认风格兜底。
  const guidedIntentText = buildIntentFromGuide(guideSelections, customIntentText);
  // designPreferences 是结构化版本，后端会写入 project，方便后续根据用户偏好追溯效果图。
  const designPreferences = buildDesignPreferences(guideSelections, customIntentText);
  // 当前模式下的图片列表；2D 和 3D 不混在一个 swiper 里展示。
  const modeRenders = renders.filter((render) => getRenderMode(render) === activeRenderMode);
  const activeRender = modeRenders.find((render) => render.id === activeRenderId) || modeRenders[0] || null;
  // 已生成空间集合按模式区分，确保“客厅 2D 已生成”不会阻止用户继续生成“客厅 3D”。
  const renderedSpaceKeys = new Set(renders.map((render) => createRenderSpaceKey(getRenderMode(render), render.space_name)));
  const analysisResult = getRecordValue(floorPlan?.analysis_result);
  const circulationAnalysis = getRecordValue(analysisResult.circulation_analysis);
  const areaRatioAnalysis = getRecordValue(analysisResult.area_ratio_analysis);
  const doors = getObjectList(analysisResult.doors);
  const windows = getObjectList(analysisResult.windows);
  const structureRiskWarnings = getStringList(analysisResult.structure_risk_warnings);
  const structureRenderImageUrl = getStructureRenderImageUrl(analysisResult);
  const potentialWaste = getStringList(areaRatioAnalysis.potential_waste);
  const areaSuggestions = getStringList(areaRatioAnalysis.suggestions);
  const circulationIssues = getStringList(circulationAnalysis.issues);
  const generationStatus = generating
    ? "running"
    : generationError
      ? "failed"
      : renders.length
        ? "completed"
        : null;
  const generationActionLabel = generating
    ? "生成中..."
    : renders.length
      ? "重新生成"
      : analyzing
        ? "解析中..."
        : "生成全屋覆盖图";
  const floorPlanStatusDescription =
    analysisError ||
    (analyzing
      ? "户型图已保存，正在解析面积、空间数量和动线。"
      : analysisCompleted
        ? "户型图解析完成，可以继续生成全屋覆盖封面图。"
        : analysisFailed
          ? "户型图解析失败，请重新解析或重新上传更清晰的图片。"
        : hasFloorPlan
          ? "户型图已保存，等待进入户型解析。"
          : "上传后系统会自动解析户型、面积、空间数量和动线，再生成统一风格的全屋覆盖图。");

  async function createStructureRender(floorPlanId: string) {
    // 户型立体结构图只在解析完成后生成一次，用于顶部结构预览，不参与装修效果图列表。
    setStructureRendering(true);
    setStructureRenderError("");

    try {
      const response = await fetch(`/api/design/floor-plan/${floorPlanId}/structure-render`, {
        method: "POST",
      });
      const payload = (await response.json()) as StructureRenderResponse;

      if (!response.ok || !payload.ok || !payload.floorPlan) {
        throw new Error(payload.error || "生成户型立体图失败");
      }

      setFloorPlan(payload.floorPlan);
    } catch (error) {
      setStructureRenderError(error instanceof Error ? error.message : "生成户型立体图失败");
    } finally {
      setStructureRendering(false);
    }
  }

  async function analyzeFloorPlan(floorPlanId: string) {
    // 上传成功后进入真实解析链路：解析结果会回填户型、面积、空间、门窗、动线和诊断数据。
    setAnalyzing(true);
    setAnalysisError("");
    setStructureRenderError("");

    try {
      const response = await fetch(`/api/design/floor-plan/${floorPlanId}/analyze`, {
        method: "POST",
      });
      const payload = (await response.json()) as FloorPlanAnalyzeResponse;

      if (!response.ok || !payload.ok || !payload.floorPlan) {
        throw new Error(payload.error || "户型图解析失败");
      }

      setFloorPlan(payload.floorPlan);
      // 解析完成后自动生成“户型立体图”。这张图是独立结构预览，不占用装修效果图 renders。
      void createStructureRender(payload.floorPlan.id);
    } catch (error) {
      setAnalysisError(error instanceof Error ? error.message : "户型图解析失败");
      setFloorPlan((current) =>
        current
          ? {
              ...current,
              analysis_status: "failed",
            }
          : current,
      );
    } finally {
      setAnalyzing(false);
    }
  }

  async function uploadFloorPlan(file: File) {
    // 上传会创建新的 design_project 和 design_floor_plan，因此成功后必须清空旧的效果图和旧任务。
    setUploading(true);
    setUploadError("");
    setAnalysisError("");
    setStructureRenderError("");
    setGenerationError("");

    const formData = new FormData();
    formData.append("file", file);

    const finalIntentText = guidedIntentText || intentText.trim();

    if (finalIntentText) {
      formData.append("intentText", finalIntentText);
    }

    try {
      const response = await fetch("/api/design/floor-plan", {
        method: "POST",
        body: formData,
      });
      const payload = (await response.json()) as FloorPlanUploadResponse;

      if (!response.ok || !payload.ok || !payload.floorPlan) {
        throw new Error(payload.error || "上传户型图失败");
      }

      setFloorPlan(payload.floorPlan);
      // 上传成功后立即启动真实户型解析，解析结果会回填户型、面积、空间列表和动线。
      void analyzeFloorPlan(payload.floorPlan.id);
      setRenders([]);
      setGenerationJob(null);
      setActiveRenderId(null);
      setFailedImageIds(new Set());
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "上传户型图失败");
    } finally {
      setUploading(false);

      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    // 前端先做类型和大小校验，减少无效请求；后端仍会做同样校验保证安全。
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    if (!ALLOWED_FLOOR_PLAN_TYPES.has(file.type)) {
      setUploadError("只支持 JPG、PNG、WEBP 或 PDF 户型图");
      return;
    }

    if (file.size > MAX_FLOOR_PLAN_SIZE) {
      setUploadError("户型图不能超过 15MB");
      return;
    }

    void uploadFloorPlan(file);
  }

  function scrollRenderTrack(direction: "prev" | "next") {
    // 缩略图区域用原生 scrollBy 实现轻量 swiper 效果，不额外引入轮播库。
    renderTrackRef.current?.scrollBy({
      left: direction === "next" ? 260 : -260,
      behavior: "smooth",
    });
  }

  function switchRenderMode(mode: RenderMode) {
    // 切换模式时优先选中该模式已有的第一张图；没有结果则展示对应模式的生成入口。
    const firstRenderInMode = renders.find((render) => getRenderMode(render) === mode);

    setActiveRenderMode(mode);
    setActiveRenderId(firstRenderInMode?.id || null);
  }

  function openRenderPreview(render: DesignRender) {
    // 每次打开大图都从 0 度开始，避免上一张图的旋转角度影响当前预览。
    setPreviewRotation(0);
    setPreviewRender(render);
  }

  function closeRenderPreview() {
    // 关闭弹窗时重置旋转角度，保证下一次打开图片从正常方向开始。
    setPreviewRotation(0);
    setPreviewRender(null);
  }

  function rotatePreview(degrees: number) {
    // 使用 0-359 范围内的角度，避免连续旋转后 transform 数值无限增长。
    setPreviewRotation((current) => (current + degrees + 360) % 360);
  }

  async function pollGenerationJob(jobId: string) {
    // 兼容后续改成异步队列的场景；当前接口通常会在请求内完成并直接返回 completed。
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await wait(3000);

      const response = await fetch(`/api/design/jobs/${jobId}`);
      const payload = (await response.json()) as CreateDesignJobResponse;

      if (!response.ok || !payload.ok || !payload.job) {
        throw new Error(payload.error || "查询生成任务失败");
      }

      setGenerationJob(payload.job);

      if (payload.job.status === "completed") {
        if (!payload.renders?.length) {
          throw new Error("生成完成但没有返回效果图，请重新生成");
        }

        setRenders(payload.renders);
        setActiveRenderMode("2d");
        setActiveRenderId(payload.renders[0].id);
        setFailedImageIds(new Set());
        return;
      }

      if (payload.job.status === "failed") {
        throw new Error(payload.job.error_message || payload.error || "生成效果图失败");
      }
    }

    throw new Error("生成时间过长，请稍后刷新或重新生成");
  }

  async function createGenerationJob() {
    if (!floorPlan || !canGenerate || generating) {
      return;
    }

    setGenerating(true);
    setGenerationError("");
    setGenerationJob({
      id: "pending",
      project_id: floorPlan.project_id,
      floor_plan_id: floorPlan.id,
      status: "running",
      progress: renders.length ? 40 : 20,
      prompt: null,
      provider: "dashscope",
      model: "wan2.7-image",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    try {
      const finalIntentText = guidedIntentText || intentText.trim();
      // 这里只生成全屋覆盖封面图；各空间效果图由用户在右侧按需手动触发，避免一次性请求过多生图任务。
      const response = await fetch("/api/design/jobs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          projectId: floorPlan.project_id,
          floorPlanId: floorPlan.id,
          intentText: finalIntentText,
          designPreferences,
        }),
      });
      const payload = (await response.json()) as CreateDesignJobResponse;

      if (!response.ok || !payload.ok || !payload.job) {
        throw new Error(payload.error || "创建生成任务失败");
      }

      setGenerationJob(payload.job);
      if (payload.job.status === "completed") {
        if (!payload.renders?.length) {
          throw new Error("生成完成但没有返回效果图，请重新生成");
        }

        setRenders(payload.renders);
        setActiveRenderMode("2d");
        setActiveRenderId(payload.renders[0].id);
        setFailedImageIds(new Set());
      } else {
        await pollGenerationJob(payload.job.id);
      }
    } catch (error) {
      setGenerationError(error instanceof Error ? error.message : "创建生成任务失败");
      setGenerationJob((current) =>
        current
          ? {
              ...current,
              status: "failed",
              progress: 100,
              updated_at: new Date().toISOString(),
            }
          : current,
      );
    } finally {
      setGenerating(false);
    }
  }

  async function createSpaceRenderForJob(
    jobId: string,
    space: { name: string; type: string },
    renderMode: RenderMode,
    activateRender: boolean,
  ) {
    const renderKey = createRenderSpaceKey(renderMode, space.name);

    setGeneratingSpaceKey(renderKey);
    setGenerationError("");

    try {
      // 空间名称来自户型解析结果；后端会强制要求已有全屋覆盖封面图，再把单空间作为同源方案的拆分视角生成。
      const response = await fetch(`/api/design/jobs/${jobId}/spaces`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          renderMode,
          spaceName: space.name,
          spaceType: space.type,
        }),
      });
      const payload = (await response.json()) as CreateSpaceRenderResponse;

      if (!response.ok || !payload.ok || !payload.render) {
        throw new Error(payload.error || "生成空间效果图失败");
      }

      setRenders((current) => {
        if (current.some((render) => render.id === payload.render?.id)) {
          return current;
        }

        return [...current, payload.render as DesignRender].sort((a, b) => a.sort_order - b.sort_order);
      });
      if (activateRender) {
        setActiveRenderMode(renderMode);
        setActiveRenderId(payload.render.id);
      }
    } catch (error) {
      setGenerationError(error instanceof Error ? error.message : "生成空间效果图失败");
    } finally {
      setGeneratingSpaceKey(null);
    }
  }

  async function createSpaceRender(space: { name: string; type: string }, renderMode: RenderMode) {
    if (!generationJob || generationJob.status !== "completed" || generatingSpaceKey) {
      return;
    }

    await createSpaceRenderForJob(generationJob.id, space, renderMode, true);
  }

  async function create3dRenders() {
    if (!generationJob || generationJob.status !== "completed" || !floorPlan || generating) {
      return;
    }

    setGenerating(true);
    setGenerationError("");

    try {
      // 3D 模式只生成“全屋 3D 立体效果图”；各空间 3D 由用户在右侧手动生成，避免一次性请求过多。
      await createSpaceRenderForJob(generationJob.id, { name: "全屋", type: "whole_home" }, "3d", true);
    } catch (error) {
      setGenerationError(error instanceof Error ? error.message : "生成全屋3D立体图失败");
    } finally {
      setGenerating(false);
    }
  }

  function markImageFailed(renderId: string) {
    setFailedImageIds((current) => {
      const next = new Set(current);
      next.add(renderId);
      return next;
    });
  }

  return (
    <section className="grid min-h-0 flex-1 gap-4 overflow-hidden p-4 lg:grid-cols-[minmax(0,1fr)_300px] xl:grid-cols-[minmax(0,1fr)_330px]">
      <div className="flex min-w-0 flex-col gap-4 overflow-y-auto pr-1">
        <section className="rounded-lg border border-[#d9e4f7] bg-white p-4 shadow-[0_10px_30px_rgba(22,56,117,0.06)]">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-[#16213d]">
                户型图 <span className="text-[#ef3349]">（必传）*</span>
              </div>
              <div className="mt-1 text-xs text-[#7685a5]">
                生成全屋覆盖图前必须上传，用于识别空间比例、房间数量和动线。
              </div>
            </div>
            <span className={uploadStatusClassName}>{uploadStatusLabel}</span>
          </div>

          <div className="grid gap-3 lg:grid-cols-[320px_minmax(0,1fr)]">
            <div className="flex min-h-24 items-center gap-3 rounded-lg border border-dashed border-[#b8cdf5] bg-[#f7fbff] p-3">
              <div className="grid h-20 w-24 shrink-0 grid-cols-3 grid-rows-3 gap-1 rounded-md border border-[#c9d8ef] bg-white p-1">
                <div className="col-span-2 rounded bg-[#eaf1fb]" />
                <div className="rounded bg-[#dce9f8]" />
                <div className="rounded bg-[#f2f6fc]" />
                <div className="col-span-2 rounded bg-[#e5eefb]" />
                <div className="col-span-3 rounded bg-[#eef4fc]" />
              </div>
              <div className="min-w-0">
                <input
                  accept="image/jpeg,image/png,image/webp,application/pdf"
                  className="hidden"
                  onChange={handleFileChange}
                  ref={fileInputRef}
                  type="file"
                />
                <button
                  className={
                    floorPlanBusy
                      ? "inline-flex h-9 cursor-not-allowed items-center gap-2 rounded-md border border-[#d8e4f5] bg-white px-3 text-sm font-medium text-[#7d8aa6]"
                      : "inline-flex h-9 items-center gap-2 rounded-md border border-[#8eb8ff] bg-white px-3 text-sm font-medium text-[#0969ff] transition hover:bg-[#eef6ff]"
                  }
                  disabled={floorPlanBusy}
                  onClick={() => fileInputRef.current?.click()}
                  type="button"
                >
                  {floorPlanBusy ? (
                    <span className="size-3.5 animate-spin rounded-full border-2 border-[#b8c7df] border-t-[#0969ff]" />
                  ) : null}
                  {floorPlanUploadButtonLabel}
                </button>
                <div
                  className={
                    uploadError
                      ? "mt-2 text-xs leading-5 text-[#ef3349]"
                      : hasFloorPlan
                        ? "mt-2 text-xs leading-5 text-[#13875a]"
                        : "mt-2 text-xs leading-5 text-[#ef3349]"
                  }
                >
                  {uploadError ||
                    (hasFloorPlan
                      ? `${floorPlan?.file_name} · ${formatFileSize(floorPlan?.file_size || null)}`
                      : "生成全屋覆盖图前必须上传")}
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-[#d9e4f7] bg-white p-3">
              <div className="flex min-h-24 items-center rounded-lg border border-[#cfe0fb] bg-[#f8fbff] p-3">
                <div className="min-w-0 flex-1 text-sm leading-6 text-[#667799]">
                  {analysisCompleted ? (
                    <div>
                      <div className="mb-2 flex items-center justify-between">
                        <div className="text-sm font-semibold text-[#17233f]">平面户型 · 立体图</div>
                        <span className="rounded-full bg-[#eaf3ff] px-2.5 py-1 text-xs font-medium text-[#0969ff]">
                          {structureRenderImageUrl ? "已生成" : structureRendering ? "生成中" : "待生成"}
                        </span>
                      </div>
                      <div className="relative min-h-48 overflow-hidden rounded-lg border border-[#d9e4f7] bg-[radial-gradient(circle_at_30%_10%,#ffffff_0%,#eef5ff_42%,#dfeafb_100%)]">
                        {structureRenderImageUrl ? (
                          <button
                            className="group block h-48 w-full text-left"
                            onClick={() => setStructurePreviewOpen(true)}
                            type="button"
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              alt="户型立体图"
                              className="h-48 w-full object-cover transition duration-300 group-hover:scale-[1.02]"
                              src={structureRenderImageUrl}
                            />
                            <span className="absolute right-3 top-3 grid size-9 place-items-center rounded-lg bg-black/42 text-white backdrop-blur transition group-hover:bg-black/58">
                              <svg aria-hidden="true" className="size-4" fill="none" viewBox="0 0 24 24">
                                <path
                                  d="M8 3H3v5M16 3h5v5M8 21H3v-5M21 16v5h-5"
                                  stroke="currentColor"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth="2"
                                />
                              </svg>
                            </span>
                            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-[#061a3d]/70 to-transparent px-3 py-2 text-xs font-semibold text-white">
                              AI 生成户型立体图 · 点击放大
                            </div>
                          </button>
                        ) : (
                          <div className="grid min-h-48 place-items-center p-4 text-center">
                            <div>
                              <div className="mx-auto grid size-12 place-items-center rounded-xl border border-[#cfe0fb] bg-white shadow-[0_12px_26px_rgba(31,70,126,0.12)]">
                                <svg aria-hidden="true" className="size-6 text-[#0969ff]" fill="none" viewBox="0 0 24 24">
                                  <path
                                    d="m4 8 8-4 8 4-8 4-8-4Zm0 4 8 4 8-4M4 16l8 4 8-4"
                                    stroke="currentColor"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth="1.8"
                                  />
                                </svg>
                              </div>
                              <div className="mt-3 text-sm font-semibold text-[#17233f]">
                                {structureRendering ? "正在生成户型立体图" : "等待生成户型立体图"}
                              </div>
                              <div className="mt-1 text-xs leading-5 text-[#7685a5]">
                                {structureRenderError || "会按上传的平面户型图解析结果生成一张真实图片。"}
                              </div>
                              {!structureRendering ? (
                                <button
                                  className="mt-3 h-8 rounded-md border border-[#8eb8ff] bg-white px-3 text-xs font-semibold text-[#0969ff] transition hover:bg-[#eef6ff]"
                                  onClick={() => floorPlan && void createStructureRender(floorPlan.id)}
                                  type="button"
                                >
                                  生成户型立体图
                                </button>
                              ) : null}
                            </div>
                          </div>
                        )}
                      </div>
                      <div className="mt-2 text-xs leading-5 text-[#7685a5]">
                        这张图是根据平面户型图解析结果生成的户型立体图，和下面的装修效果图分开保存。
                      </div>
                    </div>
                  ) : (
                    <div>
                      <div className="font-semibold text-[#17233f]">平面户型 · 立体图</div>
                      <div className="mt-1">{floorPlanStatusDescription}</div>
                    </div>
                  )}
                  {analysisFailed && floorPlan ? (
                    <button
                      className="mt-2 h-8 rounded-md border border-[#8eb8ff] bg-white px-3 text-xs font-semibold text-[#0969ff] transition hover:bg-[#eef6ff]"
                      disabled={analyzing}
                      onClick={() => void analyzeFloorPlan(floorPlan.id)}
                      type="button"
                    >
                      重新解析
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          </div>

          <div className="mt-4 rounded-lg border border-[#d9e4f7] bg-[#fbfdff] p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-[#17233f]">AI 引导生成</div>
                <div className="mt-1 text-xs text-[#7685a5]">
                  先按问题选择偏好，系统会结合户型图解析结果生成全屋方案。
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {[
                  floorPlan?.house_type || (analyzing ? "户型解析中" : "户型待识别"),
                  floorPlan?.area ? `${floorPlan.area}平` : analyzing ? "面积解析中" : "面积待识别",
                ].map((item) => (
                  <span
                    className="rounded-full border border-[#d9e4f7] bg-white px-3 py-1 text-xs font-medium text-[#667799]"
                    key={item}
                  >
                    {item}
                  </span>
                ))}
              </div>
            </div>

            <div className="mt-4 rounded-lg border border-[#cfe0fb] bg-white p-3 shadow-[0_12px_30px_rgba(22,56,117,0.05)]">
              <div className="grid gap-3 md:grid-cols-2">
                {GUIDE_QUESTIONS.map((question: GuideQuestion) => (
                  <div className="rounded-lg border border-[#edf2fa] bg-[#fbfdff] p-3" key={question.id}>
                    <div className="text-sm font-semibold text-[#17233f]">{question.title}</div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {question.options.map((option) => {
                        const selected = guideSelections[question.id] === option;

                        return (
                          <button
                            className={
                              selected
                                ? "rounded-full border border-[#0969ff] bg-[#eaf3ff] px-3 py-1.5 text-xs font-semibold text-[#0969ff]"
                                : "rounded-full border border-[#d9e4f7] bg-white px-3 py-1.5 text-xs font-medium text-[#42557d] transition hover:border-[#8eb8ff] hover:bg-[#eef6ff] hover:text-[#0969ff]"
                            }
                            key={option}
                            onClick={() =>
                              setGuideSelections((current) => ({
                                ...current,
                                [question.id]: option,
                              }))
                            }
                            type="button"
                          >
                            {option}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-3 rounded-lg border border-[#edf2fa] bg-[#fbfdff] p-3">
                <div className="text-sm font-semibold text-[#17233f]">还有什么特别要求？</div>
                <textarea
                  aria-label="补充全屋覆盖图生成要求"
                  className="mt-2 h-16 w-full resize-none bg-transparent text-[14px] leading-6 text-[#17233f] outline-none placeholder:text-[#8b9ab6]"
                  onChange={(event) => {
                    setCustomIntentText(event.target.value);
                    setIntentText(buildIntentFromGuide(guideSelections, event.target.value));
                  }}
                  placeholder="例如：要预留儿童活动区、餐边柜多一些、不要太多开放格"
                  value={customIntentText}
                />
              </div>

              <div className="mt-3 flex flex-wrap items-end justify-between gap-3 border-t border-[#edf2fa] pt-3">
                <div className="min-w-0 flex-1">
                  <div className="mb-2 text-xs font-medium text-[#6b7894]">当前生成意图</div>
                  <div className="min-h-9 rounded-lg bg-[#f6f9ff] px-3 py-2 text-sm leading-6 text-[#42557d]">
                    {guidedIntentText || "按上面问题选择后，系统会自动整理生成意图。"}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {EXAMPLE_INTENTS.map((example) => (
                      <button
                        className="rounded-full border border-[#d9e4f7] bg-[#f8fbff] px-3 py-1.5 text-xs font-medium text-[#42557d] transition hover:border-[#8eb8ff] hover:bg-[#eef6ff] hover:text-[#0969ff]"
                        key={example}
                        onClick={() => {
                          setGuideSelections({});
                          setCustomIntentText(example);
                          setIntentText(example);
                        }}
                        type="button"
                      >
                        {example}
                      </button>
                    ))}
                  </div>
                </div>
                <button
                  className={
                    canGenerate && !generating
                      ? "h-10 rounded-lg bg-[#0969ff] px-5 text-sm font-semibold text-white shadow-[0_12px_26px_rgba(9,105,255,0.26)] transition hover:bg-[#005bed]"
                      : "h-10 cursor-not-allowed rounded-lg bg-[#b8c7df] px-5 text-sm font-semibold text-white shadow-none"
                  }
                  disabled={!canGenerate || generating}
                  onClick={() => void createGenerationJob()}
                  type="button"
                >
                  {generationActionLabel}
                </button>
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-lg border border-[#d9e4f7] bg-white p-4 shadow-[0_10px_30px_rgba(22,56,117,0.06)]">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-[#17233f]">全屋效果图方案</h2>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                <span className="font-semibold text-[#17233f]">
                  {generating && activeRender
                    ? "正在生成新方案"
                    : activeRender
                    ? `${activeRender.space_name} · ${activeRender.view_name}`
                    : generating
                      ? "正在生成"
                      : generationError
                        ? "生成失败"
                      : "等待生成"}
                </span>
                {(activeRender
                  ? ["已生成", `${modeRenders.length} 个${getRenderModeLabel(activeRenderMode)}视角`, "空间匹配"]
                  : generationStatus === "running"
                    ? ["生成中", "空间匹配", "稍后展示"]
                    : generationStatus === "failed"
                      ? ["生成失败", "可重新生成", "保留已解析户型"]
                      : activeRenderMode === "3d" && renders.length
                        ? ["3D待生成", "基于2D生成", "按需生成"]
                    : ["需先上传户型图", "自动解析空间", "生成全屋覆盖图"]
                ).map((chip) => (
                  <span className="rounded-md bg-[#eef4ff] px-2 py-1 text-xs font-medium text-[#48628c]" key={chip}>
                    {chip}
                  </span>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 rounded-lg border border-[#d9e4f7] bg-[#f7fbff] p-1">
              {(["2d", "3d"] as RenderMode[]).map((mode) => (
                <button
                  className={
                    activeRenderMode === mode
                      ? "h-9 rounded-md bg-[#0969ff] px-4 text-sm font-semibold text-white shadow-[0_8px_18px_rgba(9,105,255,0.22)]"
                      : "h-9 rounded-md px-4 text-sm font-semibold text-[#48628c] transition hover:bg-white hover:text-[#0969ff]"
                  }
                  key={mode}
                  onClick={() => switchRenderMode(mode)}
                  type="button"
                >
                  {mode === "2d" ? "2D效果" : "3D立体"}
                </button>
              ))}
            </div>
          </div>

          <div className="relative grid min-h-[420px] place-items-center overflow-hidden rounded-lg border border-dashed border-[#bfd1ee] bg-[#f8fbff] px-6 py-12 lg:min-h-[500px]">
            {activeRender ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  alt={`${activeRender.space_name}${activeRender.view_name}`}
                  className="absolute inset-0 h-full w-full object-cover"
                  onError={() => markImageFailed(activeRender.id)}
                  src={getRenderableImageUrl(activeRender)}
                />
                <div className="absolute inset-0 bg-gradient-to-t from-[#061a3d]/75 via-transparent to-transparent" />
                {failedImageIds.has(activeRender.id) ? (
                  <div className="absolute inset-0 grid place-items-center bg-[#101827]/86 p-6 text-center text-white">
                    <div>
                      <div className="text-base font-semibold">图片加载失败</div>
                      <div className="mt-2 text-sm text-white/70">可以切换其他视角，或点击重新生成。</div>
                    </div>
                  </div>
                ) : null}
                {generating ? (
                  <div className="absolute left-4 top-4 rounded-lg bg-[#0969ff]/90 px-3 py-2 text-xs font-semibold text-white shadow-[0_12px_28px_rgba(9,105,255,0.28)] backdrop-blur">
                    正在生成新方案，完成后自动替换
                  </div>
                ) : null}
                <button
                  aria-label="放大效果图"
                  className="absolute right-4 top-4 grid size-10 place-items-center rounded-lg bg-black/42 text-white backdrop-blur transition hover:bg-black/58"
                  onClick={() => openRenderPreview(activeRender)}
                  type="button"
                >
                  <svg aria-hidden="true" className="size-5" fill="none" viewBox="0 0 24 24">
                    <path
                      d="M8 3H3v5M16 3h5v5M8 21H3v-5M21 16v5h-5"
                      stroke="currentColor"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                    />
                  </svg>
                </button>
                <div className="absolute bottom-4 left-4 right-4">
                  <div className="flex items-center gap-2 rounded-lg bg-[#101827]/88 p-3 backdrop-blur">
                    <button
                      aria-label="向左切换视角"
                      className="grid size-9 shrink-0 place-items-center rounded-lg border border-white/12 bg-white/10 text-white transition hover:bg-white/18"
                      onClick={() => scrollRenderTrack("prev")}
                      type="button"
                    >
                      <svg aria-hidden="true" className="size-4" fill="none" viewBox="0 0 24 24">
                        <path
                          d="m15 18-6-6 6-6"
                          stroke="currentColor"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="2"
                        />
                      </svg>
                    </button>
                    <div
                      className="flex min-w-0 flex-1 snap-x snap-mandatory gap-3 overflow-x-auto scroll-smooth pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                      ref={renderTrackRef}
                    >
                      {modeRenders.map((render) => (
                        <button
                          className={
                            render.id === activeRender.id
                              ? "w-[220px] shrink-0 snap-start rounded-lg border-2 border-[#2d8cff] bg-white/16 p-1 text-left shadow-[0_0_0_1px_rgba(45,140,255,0.18)]"
                              : "w-[220px] shrink-0 snap-start rounded-lg border border-white/12 bg-white/10 p-1 text-left transition hover:bg-white/16"
                          }
                          key={render.id}
                          onClick={() => setActiveRenderId(render.id)}
                          type="button"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            alt={`${render.space_name}${render.view_name}`}
                            className="h-20 w-full rounded-md object-cover"
                            onError={() => markImageFailed(render.id)}
                            src={getRenderableImageUrl(render)}
                          />
                          <div className="mt-1 truncate px-1 text-xs font-medium text-white">
                            {failedImageIds.has(render.id)
                              ? `${render.space_name}-加载失败`
                              : `${render.space_name} · ${render.view_name}`}
                          </div>
                        </button>
                      ))}
                    </div>
                    <button
                      aria-label="向右切换视角"
                      className="grid size-9 shrink-0 place-items-center rounded-lg border border-white/12 bg-white/10 text-white transition hover:bg-white/18"
                      onClick={() => scrollRenderTrack("next")}
                      type="button"
                    >
                      <svg aria-hidden="true" className="size-4" fill="none" viewBox="0 0 24 24">
                        <path
                          d="m9 18 6-6-6-6"
                          stroke="currentColor"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="2"
                        />
                      </svg>
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="w-full max-w-xl text-center">
                <div className="mx-auto grid h-24 w-24 place-items-center rounded-2xl border border-[#d9e4f7] bg-white shadow-[0_16px_40px_rgba(22,56,117,0.08)]">
                  <svg aria-hidden="true" className="size-11 text-[#0969ff]" fill="none" viewBox="0 0 24 24">
                    <path
                      d="M4 5h16v14H4zM8 15l2.6-3 2 2.2 1.8-1.8L18 16M8 9h.01"
                      stroke="currentColor"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="1.8"
                    />
                  </svg>
                </div>
                <h3 className="mt-6 text-xl font-semibold text-[#17233f]">
                  {activeRenderMode === "3d" && renders.length
                    ? generating
                      ? "正在生成全屋3D立体图"
                      : "生成全屋3D立体图"
                    : generating
                      ? "正在生成全屋覆盖封面图"
                      : "上传户型图后生成全屋覆盖图"}
                </h3>
                <p className="mx-auto mt-3 max-w-md text-sm leading-7 text-[#667799]">
                  {generationError ||
                    (activeRenderMode === "3d" && renders.length
                      ? generating
                        ? "正在基于2D全屋覆盖封面图生成装修后的全屋3D立体视角。"
                        : "3D模式会基于2D全屋覆盖封面图继续生成全屋装修立体效果，不和顶部户型结构图混用。"
                      : generating
                        ? "已创建生成任务，正在写入效果图结果。"
                        : "系统会先解析户型结构，再生成真实装修后的全屋覆盖封面图；各空间效果图在右侧按需手动生成。这里不会展示假效果图，避免和真实结果混淆。")}
                </p>
                {activeRenderMode === "3d" && renders.length && !modeRenders.length && generationJob?.status === "completed" ? (
                  <button
                    className="mt-5 h-10 rounded-lg bg-[#0969ff] px-5 text-sm font-semibold text-white shadow-[0_12px_26px_rgba(9,105,255,0.22)] transition hover:bg-[#005bed] disabled:cursor-not-allowed disabled:bg-[#b8c7df] disabled:shadow-none"
                    disabled={generating}
                    onClick={() => void create3dRenders()}
                    type="button"
                  >
                    {generating ? "生成中..." : "生成全屋3D立体图"}
                  </button>
                ) : generationError && canGenerate ? (
                  <button
                    className="mt-5 h-10 rounded-lg bg-[#0969ff] px-5 text-sm font-semibold text-white shadow-[0_12px_26px_rgba(9,105,255,0.22)] transition hover:bg-[#005bed]"
                    onClick={() => void createGenerationJob()}
                    type="button"
                  >
                    重新生成
                  </button>
                ) : null}
                <div className="mt-6 grid gap-3 text-left sm:grid-cols-3">
                  {["户型解析", "覆盖封面", "空间效果"].map((step, index) => (
                    <div className="rounded-lg border border-[#d9e4f7] bg-white p-3" key={step}>
                      <div className="text-xs font-semibold text-[#0969ff]">0{index + 1}</div>
                      <div className="mt-2 text-sm font-medium text-[#17233f]">{step}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

        </section>

        <section className="rounded-lg border border-[#d9e4f7] bg-white p-4 shadow-[0_10px_30px_rgba(22,56,117,0.06)]">
          <div className="mb-4">
            <div className="text-base font-semibold text-[#17233f]">户型诊断</div>
            <div className="mt-1 text-xs text-[#7d8aa6]">
              基于户型图解析结果展示动线、面积、门窗、采光和结构边界信息。
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-lg border border-[#d9e4f7] bg-[#f8fbff] p-3">
              <div className="text-xs font-semibold text-[#0969ff]">动线</div>
              <div className="mt-2 text-sm leading-6 text-[#17233f]">
                {getTextValue(circulationAnalysis.summary, floorPlan?.circulation || "待解析后生成")}
              </div>
              {circulationIssues.length ? (
                <div className="mt-2 space-y-1 text-xs leading-5 text-[#667799]">
                  {circulationIssues.slice(0, 2).map((issue) => (
                    <div key={issue}>- {issue}</div>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="rounded-lg border border-[#d9e4f7] bg-[#f8fbff] p-3">
              <div className="text-xs font-semibold text-[#0969ff]">面积</div>
              <div className="mt-2 text-sm leading-6 text-[#17233f]">
                {getTextValue(areaRatioAnalysis.summary, floorPlan?.area ? `${floorPlan.area} 平，待进一步分析比例` : "待解析后生成")}
              </div>
              {potentialWaste.length ? (
                <div className="mt-2 space-y-1 text-xs leading-5 text-[#667799]">
                  {potentialWaste.slice(0, 2).map((item) => (
                    <div key={item}>- {item}</div>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="rounded-lg border border-[#d9e4f7] bg-[#f8fbff] p-3">
              <div className="text-xs font-semibold text-[#0969ff]">门窗采光</div>
              <div className="mt-2 text-sm leading-6 text-[#17233f]">
                {floorPlan?.analysis_result
                  ? `${doors.length} 个门位，${windows.length} 个窗位`
                  : "待解析后生成"}
              </div>
              <div className="mt-2 text-xs leading-5 text-[#667799]">
                {floorPlan?.analysis_result
                  ? getTextValue(floorPlan.analysis_result.orientation, "朝向或采光未明确")
                  : "上传户型图后识别门窗和采光"}
              </div>
            </div>

            <div className="rounded-lg border border-[#d9e4f7] bg-[#fffafb] p-3">
              <div className="text-xs font-semibold text-[#ef3349]">结构边界</div>
              <div className="mt-2 text-sm leading-6 text-[#17233f]">
                {structureRiskWarnings[0] || "承重墙、梁柱需结构图确认"}
              </div>
              <div className="mt-2 text-xs leading-5 text-[#667799]">
                AI 仅做疑似识别，不能替代物业审批和专业结构判断。
              </div>
            </div>
          </div>

          {areaSuggestions.length ? (
            <div className="mt-3 rounded-lg border border-[#d9e4f7] bg-white p-3">
              <div className="text-xs font-semibold text-[#42557d]">优化建议</div>
              <div className="mt-2 grid gap-2 text-xs leading-5 text-[#667799] md:grid-cols-2">
                {areaSuggestions.slice(0, 4).map((suggestion) => (
                  <div className="rounded-md bg-[#f8fbff] px-3 py-2" key={suggestion}>
                    {suggestion}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      </div>

      <aside className="flex min-h-0 flex-col gap-4 overflow-y-auto rounded-lg border border-[#d9e4f7] bg-white p-4 shadow-[0_10px_30px_rgba(22,56,117,0.06)]">
        <h2 className="text-base font-semibold text-[#17233f]">户型解析</h2>
        <div className="border-t border-[#edf2fa] pt-4">
          <div className="mb-3 text-sm font-medium text-[#42557d]">识别结果</div>
          <div className="grid gap-3 text-sm">
            {[
              ["户型", floorPlan?.house_type || (analyzing ? "解析中" : "待上传后识别")],
              [
                "面积",
                floorPlan?.area ? `${floorPlan.area}平` : analyzing ? "解析中" : "待上传后识别",
              ],
              ["空间", spacesSummary || (analyzing ? "解析中" : "待上传后识别")],
              ["动线", floorPlan?.circulation || (analyzing ? "解析中" : "待上传后识别")],
            ].map(([label, value]) => (
              <div className="rounded-lg bg-[#f7fbff] p-3" key={label}>
                <div className="text-xs text-[#7d8aa6]">{label}</div>
                <div className="mt-1 leading-6 text-[#17233f]">{value}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="border-t border-[#edf2fa] pt-4">
          <div className="mb-3 text-sm font-medium text-[#42557d]">生成规则</div>
          <div className="rounded-lg border border-[#d9e4f7] bg-white p-3 text-xs leading-6 text-[#667799]">
            系统按户型图自动识别空间并生成全屋方案，默认保持户型结构、统一全屋风格和色系。
          </div>
        </div>

        <div className="border-t border-[#edf2fa] pt-4">
          <div className="mb-3 text-sm font-medium text-[#42557d]">生成队列</div>
          {generationJob ? (
            <div className="rounded-lg border border-[#d9e4f7] bg-[#f8fbff] p-3 text-xs leading-6 text-[#667799]">
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium text-[#17233f]">全屋覆盖生成任务</span>
                <span className={getGenerationStatusClassName(generationStatus || generationJob.status)}>
                  {getGenerationStatusLabel(generationStatus || generationJob.status)}
                </span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#dce8fa]">
                <div
                  className={
                    generationStatus === "failed"
                      ? "h-full rounded-full bg-[#ef3349]"
                      : generationStatus === "completed"
                        ? "h-full rounded-full bg-[#13a66b]"
                        : "h-full rounded-full bg-[#0969ff] transition-all"
                  }
                  style={{ width: `${generationStatus === "failed" ? 100 : generationJob.progress}%` }}
                />
              </div>
              {generationError ? (
                <div className="mt-2 text-[#ef3349]">{generationError}</div>
              ) : (
                <div className="mt-2">
                  {generationStatus === "running"
                    ? "正在根据户型解析结果生成真实装修后的全屋覆盖封面图。"
                    : generationStatus === "completed"
                      ? "主图生成完成，可在左侧查看；各空间图可在下方手动生成。"
                      : "等待生成任务开始。"}
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-[#cddbf0] bg-[#f8fbff] p-3 text-xs leading-6 text-[#667799]">
              上传户型图并点击生成后，先创建全屋主图任务；空间图由你按需手动生成。
            </div>
          )}
        </div>

        <div className="border-t border-[#edf2fa] pt-4">
          <div className="mb-3">
            <div className="text-sm font-medium text-[#42557d]">空间效果图</div>
            <div className="mt-1 text-xs leading-5 text-[#7d8aa6]">
              当前为{getRenderModeLabel(activeRenderMode)}模式，点击某个空间时只生成该空间。
            </div>
          </div>
          {floorPlan?.spaces?.length ? (
            <div className="grid gap-2">
              {floorPlan.spaces.map((space) => {
                const spaceRenderKey = createRenderSpaceKey(activeRenderMode, space.name);
                const generated = renderedSpaceKeys.has(spaceRenderKey);
                const generatingThisSpace = generatingSpaceKey === spaceRenderKey;
                const disabled = !generationJob || generationJob.status !== "completed" || Boolean(generatingSpaceKey) || generated;

                return (
                  <button
                    className={
                      generated
                        ? "flex items-center justify-between rounded-lg border border-[#d9e4f7] bg-[#f8fbff] px-3 py-2 text-left text-xs text-[#667799]"
                        : disabled
                          ? "flex cursor-not-allowed items-center justify-between rounded-lg border border-[#edf2fa] bg-[#f8fafc] px-3 py-2 text-left text-xs text-[#97a5bd]"
                          : "flex items-center justify-between rounded-lg border border-[#8eb8ff] bg-white px-3 py-2 text-left text-xs text-[#0969ff] transition hover:bg-[#eef6ff]"
                    }
                    disabled={disabled}
                    key={`${space.name}-${space.type}`}
                    onClick={() => void createSpaceRender(space, activeRenderMode)}
                    type="button"
                  >
                    <span className="font-medium">{space.name}</span>
                    <span>{generated ? "已生成" : generatingThisSpace ? "生成中" : `生成${activeRenderMode.toUpperCase()}`}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-[#cddbf0] bg-[#f8fbff] p-3 text-xs leading-6 text-[#667799]">
              户型解析完成后会显示可生成的空间。
            </div>
          )}
        </div>

        <div className="border-t border-[#edf2fa] pt-4">
          <div className="mb-3 text-sm font-medium text-[#42557d]">输出</div>
          <div className="grid gap-2 text-sm text-[#17233f]">
            {DEFAULT_OUTPUTS.map((item) => (
              <div className="flex items-center gap-2" key={item}>
                <span className="size-1.5 rounded-full bg-[#0969ff]" />
                {item}
              </div>
            ))}
          </div>
        </div>

      </aside>

      {previewRender ? (
        <div className="fixed inset-0 z-50 bg-[#061a3d]/88 p-4 backdrop-blur">
          <div className="flex h-full flex-col">
            <div className="mb-3 flex items-center justify-between gap-3 text-white">
              <div className="min-w-0">
                <div className="truncate text-base font-semibold">
                  {previewRender.space_name} · {previewRender.view_name}
                </div>
                <div className="mt-1 text-xs text-white/62">效果图预览 · {previewRotation}°</div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  aria-label="向左旋转预览图"
                  className="grid size-10 place-items-center rounded-lg bg-white/10 text-white transition hover:bg-white/18"
                  onClick={() => rotatePreview(-90)}
                  type="button"
                >
                  ↺
                </button>
                <button
                  aria-label="复位预览图旋转"
                  className="h-10 rounded-lg bg-white/10 px-3 text-xs font-semibold text-white transition hover:bg-white/18"
                  onClick={() => setPreviewRotation(0)}
                  type="button"
                >
                  复位
                </button>
                <button
                  aria-label="向右旋转预览图"
                  className="grid size-10 place-items-center rounded-lg bg-white/10 text-white transition hover:bg-white/18"
                  onClick={() => rotatePreview(90)}
                  type="button"
                >
                  ↻
                </button>
                <button
                  aria-label="关闭预览"
                  className="grid size-10 place-items-center rounded-lg bg-white/10 text-white transition hover:bg-white/18"
                  onClick={closeRenderPreview}
                  type="button"
                >
                  ×
                </button>
              </div>
            </div>
            <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg bg-black">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                alt={`${previewRender.space_name}${previewRender.view_name}`}
                className="h-full w-full object-contain transition-transform duration-300"
                onError={() => markImageFailed(previewRender.id)}
                src={getRenderableImageUrl(previewRender)}
                style={{ transform: `rotate(${previewRotation}deg) scale(${previewRotation % 180 === 0 ? 1 : 0.72})` }}
              />
              {failedImageIds.has(previewRender.id) ? (
                <div className="absolute inset-0 grid place-items-center bg-black p-6 text-center text-white">
                  <div>
                    <div className="text-base font-semibold">图片加载失败</div>
                    <div className="mt-2 text-sm text-white/62">关闭预览后可以切换视角或重新生成。</div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {structurePreviewOpen && structureRenderImageUrl ? (
        <div className="fixed inset-0 z-50 bg-[#061a3d]/88 p-4 backdrop-blur">
          <div className="flex h-full flex-col">
            <div className="mb-3 flex items-center justify-between gap-3 text-white">
              <div className="min-w-0">
                <div className="truncate text-base font-semibold">平面户型 · 立体图</div>
                <div className="mt-1 text-xs text-white/62">户型立体图预览</div>
              </div>
              <button
                aria-label="关闭户型立体图预览"
                className="grid size-10 shrink-0 place-items-center rounded-lg bg-white/10 text-white transition hover:bg-white/18"
                onClick={() => setStructurePreviewOpen(false)}
                type="button"
              >
                ×
              </button>
            </div>
            <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg bg-black">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img alt="户型立体图预览" className="h-full w-full object-contain" src={structureRenderImageUrl} />
            </div>
          </div>
        </div>
      ) : null}

    </section>
  );
}
