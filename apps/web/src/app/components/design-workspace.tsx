"use client";

import { ChangeEvent, useRef, useState } from "react";

const DEFAULT_OUTPUTS = ["全屋效果图", "空间视角预览", "统一风格", "放大预览"];
const MAX_FLOOR_PLAN_SIZE = 15 * 1024 * 1024;
const ALLOWED_FLOOR_PLAN_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);

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

type DesignRender = {
  id: string;
  project_id: string;
  job_id: string;
  space_name: string;
  view_name: string;
  image_url: string;
  thumbnail_url: string | null;
  sort_order: number;
  created_at: string;
};

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

type CreateDesignJobResponse = {
  ok: boolean;
  job?: DesignJob;
  renders?: DesignRender[];
  error?: string;
};

type CreateSpaceRenderResponse = {
  ok: boolean;
  render?: DesignRender;
  error?: string;
};

const EXAMPLE_INTENTS = [
  "现代简约 · 明亮通透 · 有小孩",
  "奶油风 · 温柔耐看 · 收纳多",
  "原木风 · 自然放松 · 预算中等",
];

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
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRenderableImageUrl(render: DesignRender) {
  return render.thumbnail_url || render.image_url;
}

function getRecordValue(value: unknown) {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function getStringList(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item)) : [];
}

function getObjectList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : [];
}

function getTextValue(value: unknown, fallback = "待识别") {
  return typeof value === "string" && value.trim() ? value : fallback;
}

export function DesignWorkspace() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const renderTrackRef = useRef<HTMLDivElement | null>(null);
  const [intentText, setIntentText] = useState("");
  const [floorPlan, setFloorPlan] = useState<UploadedFloorPlan | null>(null);
  const [uploading, setUploading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [analysisError, setAnalysisError] = useState("");
  const [generationError, setGenerationError] = useState("");
  const [generationJob, setGenerationJob] = useState<DesignJob | null>(null);
  const [renders, setRenders] = useState<DesignRender[]>([]);
  const [activeRenderId, setActiveRenderId] = useState<string | null>(null);
  const [previewRender, setPreviewRender] = useState<DesignRender | null>(null);
  const [failedImageIds, setFailedImageIds] = useState<Set<string>>(new Set());
  const [generatingSpaceName, setGeneratingSpaceName] = useState<string | null>(null);

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
  const activeRender = renders.find((render) => render.id === activeRenderId) || renders[0] || null;
  const renderedSpaceNames = new Set(renders.map((render) => render.space_name));
  const analysisResult = getRecordValue(floorPlan?.analysis_result);
  const circulationAnalysis = getRecordValue(analysisResult.circulation_analysis);
  const areaRatioAnalysis = getRecordValue(analysisResult.area_ratio_analysis);
  const doors = getObjectList(analysisResult.doors);
  const windows = getObjectList(analysisResult.windows);
  const structureRiskWarnings = getStringList(analysisResult.structure_risk_warnings);
  const potentialWaste = getStringList(areaRatioAnalysis.potential_waste);
  const areaSuggestions = getStringList(areaRatioAnalysis.suggestions);
  const circulationIssues = getStringList(circulationAnalysis.issues);
  const generationStatus = generating
    ? "running"
    : generationError
      ? "failed"
      : activeRender
        ? "completed"
        : null;
  const generationActionLabel = generating
    ? "生成中..."
    : renders.length
      ? "重新生成"
      : analyzing
        ? "解析中..."
        : "生成全屋效果图";
  const floorPlanStatusDescription =
    analysisError ||
    (analyzing
      ? "户型图已保存，正在解析面积、空间数量和动线。"
      : analysisCompleted
        ? "户型图解析完成，可以继续生成全屋效果图。"
        : analysisFailed
          ? "户型图解析失败，请重新解析或重新上传更清晰的图片。"
        : hasFloorPlan
          ? "户型图已保存，等待进入户型解析。"
          : "上传后系统会自动解析户型、面积、空间数量和动线，再生成统一风格的全屋效果图。");

  async function analyzeFloorPlan(floorPlanId: string) {
    setAnalyzing(true);
    setAnalysisError("");

    try {
      const response = await fetch(`/api/design/floor-plan/${floorPlanId}/analyze`, {
        method: "POST",
      });
      const payload = (await response.json()) as FloorPlanAnalyzeResponse;

      if (!response.ok || !payload.ok || !payload.floorPlan) {
        throw new Error(payload.error || "户型图解析失败");
      }

      setFloorPlan(payload.floorPlan);
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
    setUploading(true);
    setUploadError("");
    setAnalysisError("");
    setGenerationError("");

    const formData = new FormData();
    formData.append("file", file);

    if (intentText.trim()) {
      formData.append("intentText", intentText.trim());
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
    renderTrackRef.current?.scrollBy({
      left: direction === "next" ? 260 : -260,
      behavior: "smooth",
    });
  }

  async function pollGenerationJob(jobId: string) {
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
      const response = await fetch("/api/design/jobs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          projectId: floorPlan.project_id,
          floorPlanId: floorPlan.id,
          intentText,
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

  async function createSpaceRender(space: { name: string; type: string }) {
    if (!generationJob || generationJob.status !== "completed" || generatingSpaceName) {
      return;
    }

    setGeneratingSpaceName(space.name);
    setGenerationError("");

    try {
      const response = await fetch(`/api/design/jobs/${generationJob.id}/spaces`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
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
      setActiveRenderId(payload.render.id);
    } catch (error) {
      setGenerationError(error instanceof Error ? error.message : "生成空间效果图失败");
    } finally {
      setGeneratingSpaceName(null);
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
                生成全屋效果图前必须上传，用于识别空间比例、房间数量和动线。
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
                    uploading
                      ? "h-9 cursor-not-allowed rounded-md border border-[#d8e4f5] bg-white px-3 text-sm font-medium text-[#7d8aa6]"
                      : "h-9 rounded-md border border-[#8eb8ff] bg-white px-3 text-sm font-medium text-[#0969ff] transition hover:bg-[#eef6ff]"
                  }
                  disabled={uploading}
                  onClick={() => fileInputRef.current?.click()}
                  type="button"
                >
                  {hasFloorPlan ? "重新上传" : uploading ? "上传中..." : "上传户型图"}
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
                      : "生成全屋效果图前必须上传")}
                </div>
              </div>
            </div>

            <div className="flex items-center rounded-lg border border-[#d9e4f7] bg-white p-3">
              <div className="min-w-0 flex-1 text-sm leading-6 text-[#667799]">
                <div>{floorPlanStatusDescription}</div>
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

          <div className="mt-4 rounded-lg border border-[#d9e4f7] bg-[#fbfdff] p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-[#17233f]">AI 生成意图</div>
                <div className="mt-1 text-xs text-[#7685a5]">
                  用一句话描述偏好，系统会结合户型图自动补全风格、预算、色系和空间方案。
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
              <textarea
                aria-label="描述全屋生成意图"
                className="h-24 w-full resize-none bg-transparent px-1 py-1 text-[15px] leading-7 text-[#17233f] outline-none placeholder:text-[#8b9ab6]"
                onChange={(event) => setIntentText(event.target.value)}
                placeholder="比如：想要明亮通透的现代简约风，有小孩，希望耐脏好打理，预算中等"
                value={intentText}
              />
              <div className="mt-3 flex flex-wrap items-end justify-between gap-3 border-t border-[#edf2fa] pt-3">
                <div className="min-w-0 flex-1">
                  <div className="mb-2 text-xs font-medium text-[#6b7894]">示例需求</div>
                  <div className="flex flex-wrap gap-2">
                    {EXAMPLE_INTENTS.map((example) => (
                      <button
                        className="rounded-full border border-[#d9e4f7] bg-[#f8fbff] px-3 py-1.5 text-xs font-medium text-[#42557d] transition hover:border-[#8eb8ff] hover:bg-[#eef6ff] hover:text-[#0969ff]"
                        key={example}
                        onClick={() => setIntentText(example)}
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
                {(generationStatus === "completed"
                  ? ["已生成", `${renders.length} 个视角`, "空间匹配"]
                  : generationStatus === "running"
                    ? ["生成中", "空间匹配", "稍后展示"]
                    : generationStatus === "failed"
                      ? ["生成失败", "可重新生成", "保留已解析户型"]
                      : ["需先上传户型图", "自动解析空间", "生成全屋方案"]
                ).map((chip) => (
                  <span className="rounded-md bg-[#eef4ff] px-2 py-1 text-xs font-medium text-[#48628c]" key={chip}>
                    {chip}
                  </span>
                ))}
              </div>
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
                  aria-label="放大全屋效果图"
                  className="absolute right-4 top-4 grid size-10 place-items-center rounded-lg bg-black/42 text-white backdrop-blur transition hover:bg-black/58"
                  onClick={() => setPreviewRender(activeRender)}
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
                      {renders.map((render) => (
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
                  {generating ? "正在生成全屋效果图" : "上传户型图后生成全屋效果图"}
                </h3>
                <p className="mx-auto mt-3 max-w-md text-sm leading-7 text-[#667799]">
                  {generationError ||
                    (generating
                      ? "已创建生成任务，正在写入效果图结果。"
                      : "系统会先解析户型结构，再按默认风格和你的补充需求生成全屋方案。这里不会展示假效果图，避免和真实结果混淆。")}
                </p>
                {generationError && canGenerate ? (
                  <button
                    className="mt-5 h-10 rounded-lg bg-[#0969ff] px-5 text-sm font-semibold text-white shadow-[0_12px_26px_rgba(9,105,255,0.22)] transition hover:bg-[#005bed]"
                    onClick={() => void createGenerationJob()}
                    type="button"
                  >
                    重新生成
                  </button>
                ) : null}
                <div className="mt-6 grid gap-3 text-left sm:grid-cols-3">
                  {["户型解析", "全屋生成", "多视角预览"].map((step, index) => (
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
                <span className="font-medium text-[#17233f]">全屋生成任务</span>
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
                    ? "正在根据户型解析结果生成多视角方案。"
                    : generationStatus === "completed"
                      ? "生成完成，可在左侧查看和放大预览。"
                      : "等待生成任务开始。"}
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-[#cddbf0] bg-[#f8fbff] p-3 text-xs leading-6 text-[#667799]">
              上传户型图并点击生成后，会按解析出的空间自动创建生成任务。
            </div>
          )}
        </div>

        <div className="border-t border-[#edf2fa] pt-4">
          <div className="mb-3 text-sm font-medium text-[#42557d]">空间效果图</div>
          {floorPlan?.spaces?.length ? (
            <div className="grid gap-2">
              {floorPlan.spaces.map((space) => {
                const generated = renderedSpaceNames.has(space.name);
                const generatingThisSpace = generatingSpaceName === space.name;
                const disabled = !generationJob || generationJob.status !== "completed" || Boolean(generatingSpaceName) || generated;

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
                    onClick={() => void createSpaceRender(space)}
                    type="button"
                  >
                    <span className="font-medium">{space.name}</span>
                    <span>{generated ? "已生成" : generatingThisSpace ? "生成中" : "生成"}</span>
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
                <div className="mt-1 text-xs text-white/62">全屋效果图预览</div>
              </div>
              <button
                aria-label="关闭预览"
                className="grid size-10 shrink-0 place-items-center rounded-lg bg-white/10 text-white transition hover:bg-white/18"
                onClick={() => setPreviewRender(null)}
                type="button"
              >
                ×
              </button>
            </div>
            <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg bg-black">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                alt={`${previewRender.space_name}${previewRender.view_name}`}
                className="h-full w-full object-contain"
                onError={() => markImageFailed(previewRender.id)}
                src={getRenderableImageUrl(previewRender)}
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
    </section>
  );
}
