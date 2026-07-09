type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

type VisionContent =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image_url";
      image_url: {
        url: string;
      };
    };

type VisionMessage = {
  role: ChatRole;
  content: string | VisionContent[];
};

export type FloorPlanAnalysis = {
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
  circulation: string | null;
  orientation: string | null;
  doors: Array<{
    location: string;
    connects?: string[];
    confidence?: number;
  }>;
  windows: Array<{
    location: string;
    related_space?: string | null;
    orientation?: string | null;
    confidence?: number;
  }>;
  walls: Array<{
    location: string;
    type: string;
    confidence?: number;
    note?: string | null;
  }>;
  wet_areas: Array<{
    name: string;
    type: string;
    location?: string | null;
  }>;
  balconies: Array<{
    name: string;
    location?: string | null;
    related_space?: string | null;
  }>;
  circulation_analysis: {
    summary: string | null;
    issues: string[];
    score: number | null;
  };
  area_ratio_analysis: {
    summary: string | null;
    potential_waste: string[];
    suggestions: string[];
  };
  structure_risk_warnings: string[];
  confidence: number;
  warnings: string[];
};

const DEFAULT_EMBEDDING_MODEL = "text-embedding-v4";
const DEFAULT_EMBEDDING_DIMENSION = 1536;
const DEFAULT_CHAT_MODEL = "qwen-plus";
const DEFAULT_VISION_MODEL = "qwen-vl-plus";
const DEFAULT_DASHSCOPE_TIMEOUT_MS = 30000;
const DEFAULT_DASHSCOPE_EMBEDDINGS_URL =
  "https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding";
const DEFAULT_DASHSCOPE_CHAT_COMPLETIONS_URL =
  "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";

function getDashScopeApiKey() {
  const apiKey = process.env.DASHSCOPE_API_KEY;

  if (!apiKey) {
    throw new Error("Missing DASHSCOPE_API_KEY");
  }

  return apiKey;
}

function getEmbeddingModel() {
  return process.env.EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;
}

function getEmbeddingDimension() {
  return Number(process.env.EMBEDDING_DIMENSION || DEFAULT_EMBEDDING_DIMENSION);
}

function getChatModel() {
  return process.env.CHAT_MODEL || DEFAULT_CHAT_MODEL;
}

function getVisionModel() {
  return process.env.VISION_MODEL || DEFAULT_VISION_MODEL;
}

function getDashScopeEmbeddingsUrl() {
  // URL 放到环境变量里，方便上线后切换阿里官方地址、内网代理或自建网关。
  return process.env.DASHSCOPE_EMBEDDINGS_URL || DEFAULT_DASHSCOPE_EMBEDDINGS_URL;
}

function getDashScopeChatCompletionsUrl() {
  // 聊天接口也用环境变量控制，避免以后换模型网关时改代码。
  return process.env.DASHSCOPE_CHAT_COMPLETIONS_URL || DEFAULT_DASHSCOPE_CHAT_COMPLETIONS_URL;
}

function getDashScopeTimeoutMs() {
  const timeoutMs = Number(process.env.DASHSCOPE_TIMEOUT_MS || DEFAULT_DASHSCOPE_TIMEOUT_MS);

  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_DASHSCOPE_TIMEOUT_MS;
}

function createTimeoutSignal() {
  return AbortSignal.timeout(getDashScopeTimeoutMs());
}

async function parseDashScopeResponse(response: Response) {
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      `DashScope request failed: ${response.status} ${JSON.stringify(payload)}`,
    );
  }

  return payload;
}

export async function createQueryEmbedding(question: string) {
  const response = await fetch(getDashScopeEmbeddingsUrl(), {
    method: "POST",
    headers: {
      authorization: `Bearer ${getDashScopeApiKey()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: getEmbeddingModel(),
      input: {
        texts: [question],
      },
      parameters: {
        text_type: "query",
        dimension: getEmbeddingDimension(),
        output_type: "dense",
      },
    }),
    signal: createTimeoutSignal(),
  });

  const payload = await parseDashScopeResponse(response);
  const embedding = payload?.output?.embeddings?.[0]?.embedding;

  if (!Array.isArray(embedding)) {
    throw new Error("DashScope embedding response is missing output.embeddings[0].embedding");
  }

  return embedding as number[];
}

export async function generateChatAnswer(messages: ChatMessage[]) {
  const response = await fetch(getDashScopeChatCompletionsUrl(), {
    method: "POST",
    headers: {
      authorization: `Bearer ${getDashScopeApiKey()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: getChatModel(),
      messages,
      temperature: 0.2,
    }),
    signal: createTimeoutSignal(),
  });

  const payload = await parseDashScopeResponse(response);
  const answer = payload?.choices?.[0]?.message?.content;

  if (typeof answer !== "string") {
    throw new Error("DashScope chat response is missing choices[0].message.content");
  }

  return answer;
}

function extractJsonObject(content: string) {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonText = fenced?.[1]?.trim() || trimmed;
  const start = jsonText.indexOf("{");
  const end = jsonText.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Vision response does not contain a JSON object");
  }

  return JSON.parse(jsonText.slice(start, end + 1)) as unknown;
}

function normalizeFloorPlanAnalysis(payload: unknown): FloorPlanAnalysis {
  if (!payload || typeof payload !== "object") {
    throw new Error("Floor plan analysis payload is not an object");
  }

  const record = payload as Record<string, unknown>;
  const spaces = Array.isArray(record.spaces)
    ? record.spaces
        .filter((space): space is Record<string, unknown> => Boolean(space) && typeof space === "object")
        .map((space) => ({
          name: typeof space.name === "string" ? space.name : "未命名空间",
          type: typeof space.type === "string" ? space.type : "unknown",
          estimated_area:
            typeof space.estimated_area === "number" && Number.isFinite(space.estimated_area)
              ? space.estimated_area
              : null,
          area_ratio:
            typeof space.area_ratio === "number" && Number.isFinite(space.area_ratio)
              ? space.area_ratio
              : null,
          connections: Array.isArray(space.connections)
            ? space.connections.filter((connection): connection is string => typeof connection === "string")
            : [],
          confidence:
            typeof space.confidence === "number" && Number.isFinite(space.confidence)
              ? space.confidence
              : undefined,
        }))
    : [];
  const doors = Array.isArray(record.doors)
    ? record.doors
        .filter((door): door is Record<string, unknown> => Boolean(door) && typeof door === "object")
        .map((door) => ({
          location: typeof door.location === "string" ? door.location : "未知位置",
          connects: Array.isArray(door.connects)
            ? door.connects.filter((connection): connection is string => typeof connection === "string")
            : [],
          confidence:
            typeof door.confidence === "number" && Number.isFinite(door.confidence)
              ? door.confidence
              : undefined,
        }))
    : [];
  const windows = Array.isArray(record.windows)
    ? record.windows
        .filter((window): window is Record<string, unknown> => Boolean(window) && typeof window === "object")
        .map((window) => ({
          location: typeof window.location === "string" ? window.location : "未知位置",
          related_space:
            typeof window.related_space === "string" && window.related_space.trim()
              ? window.related_space
              : null,
          orientation:
            typeof window.orientation === "string" && window.orientation.trim()
              ? window.orientation
              : null,
          confidence:
            typeof window.confidence === "number" && Number.isFinite(window.confidence)
              ? window.confidence
              : undefined,
        }))
    : [];
  const walls = Array.isArray(record.walls)
    ? record.walls
        .filter((wall): wall is Record<string, unknown> => Boolean(wall) && typeof wall === "object")
        .map((wall) => ({
          location: typeof wall.location === "string" ? wall.location : "未知位置",
          type: typeof wall.type === "string" ? wall.type : "unknown",
          note: typeof wall.note === "string" && wall.note.trim() ? wall.note : null,
          confidence:
            typeof wall.confidence === "number" && Number.isFinite(wall.confidence)
              ? wall.confidence
              : undefined,
        }))
    : [];
  const wetAreas = Array.isArray(record.wet_areas)
    ? record.wet_areas
        .filter((area): area is Record<string, unknown> => Boolean(area) && typeof area === "object")
        .map((area) => ({
          name: typeof area.name === "string" ? area.name : "未命名湿区",
          type: typeof area.type === "string" ? area.type : "unknown",
          location: typeof area.location === "string" && area.location.trim() ? area.location : null,
        }))
    : [];
  const balconies = Array.isArray(record.balconies)
    ? record.balconies
        .filter((balcony): balcony is Record<string, unknown> => Boolean(balcony) && typeof balcony === "object")
        .map((balcony) => ({
          name: typeof balcony.name === "string" ? balcony.name : "阳台",
          location:
            typeof balcony.location === "string" && balcony.location.trim() ? balcony.location : null,
          related_space:
            typeof balcony.related_space === "string" && balcony.related_space.trim()
              ? balcony.related_space
              : null,
        }))
    : [];
  const circulationAnalysis =
    record.circulation_analysis && typeof record.circulation_analysis === "object"
      ? (record.circulation_analysis as Record<string, unknown>)
      : {};
  const areaRatioAnalysis =
    record.area_ratio_analysis && typeof record.area_ratio_analysis === "object"
      ? (record.area_ratio_analysis as Record<string, unknown>)
      : {};

  return {
    house_type: typeof record.house_type === "string" && record.house_type.trim() ? record.house_type : null,
    area: typeof record.area === "number" && Number.isFinite(record.area) ? record.area : null,
    spaces,
    circulation:
      typeof record.circulation === "string" && record.circulation.trim()
        ? record.circulation
        : null,
    orientation:
      typeof record.orientation === "string" && record.orientation.trim()
        ? record.orientation
        : null,
    doors,
    windows,
    walls,
    wet_areas: wetAreas,
    balconies,
    circulation_analysis: {
      summary:
        typeof circulationAnalysis.summary === "string" && circulationAnalysis.summary.trim()
          ? circulationAnalysis.summary
          : null,
      issues: Array.isArray(circulationAnalysis.issues)
        ? circulationAnalysis.issues.filter((issue): issue is string => typeof issue === "string")
        : [],
      score:
        typeof circulationAnalysis.score === "number" && Number.isFinite(circulationAnalysis.score)
          ? Math.max(0, Math.min(100, circulationAnalysis.score))
          : null,
    },
    area_ratio_analysis: {
      summary:
        typeof areaRatioAnalysis.summary === "string" && areaRatioAnalysis.summary.trim()
          ? areaRatioAnalysis.summary
          : null,
      potential_waste: Array.isArray(areaRatioAnalysis.potential_waste)
        ? areaRatioAnalysis.potential_waste.filter((item): item is string => typeof item === "string")
        : [],
      suggestions: Array.isArray(areaRatioAnalysis.suggestions)
        ? areaRatioAnalysis.suggestions.filter((item): item is string => typeof item === "string")
        : [],
    },
    structure_risk_warnings: Array.isArray(record.structure_risk_warnings)
      ? record.structure_risk_warnings.filter((warning): warning is string => typeof warning === "string")
      : [],
    confidence:
      typeof record.confidence === "number" && Number.isFinite(record.confidence)
        ? Math.max(0, Math.min(1, record.confidence))
        : 0,
    warnings: Array.isArray(record.warnings)
      ? record.warnings.filter((warning): warning is string => typeof warning === "string")
      : [],
  };
}

export async function analyzeFloorPlanImage(imageUrl: string) {
  const messages: VisionMessage[] = [
    {
      role: "system",
      content: [
        "你是专业的住宅户型图解析助手。",
        "你只根据图片可见信息识别户型，不要臆测。",
        "只返回 JSON，不要输出 Markdown、解释或额外文字。",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        {
          type: "image_url",
          image_url: {
            url: imageUrl,
          },
        },
        {
          type: "text",
          text: [
            "请解析这张住宅户型图，返回严格 JSON：",
            "{",
            '  "house_type": "例如 3室2厅1卫，无法确认则为 null",',
            '  "area": 98 或 null,',
            '  "spaces": [{"name": "客厅", "type": "living_room", "estimated_area": 28, "area_ratio": 0.28, "connections": ["餐厅", "阳台"], "confidence": 0.9}],',
            '  "doors": [{"location": "入户门位于户型左下侧", "connects": ["玄关", "客厅"], "confidence": 0.8}],',
            '  "windows": [{"location": "客厅外侧大窗", "related_space": "客厅", "orientation": "南向或图纸下方", "confidence": 0.7}],',
            '  "walls": [{"location": "客厅与卧室之间墙体", "type": "unknown/load_bearing_candidate/non_load_bearing_candidate", "confidence": 0.5, "note": "普通户型图无法确认承重，仅做疑似判断"}],',
            '  "wet_areas": [{"name": "厨房", "type": "kitchen", "location": "户型右侧"}],',
            '  "balconies": [{"name": "生活阳台", "location": "客厅外侧", "related_space": "客厅"}],',
            '  "circulation": "动线说明，无法确认则为 null",',
            '  "circulation_analysis": {"summary": "动线总体判断", "issues": ["餐厨距离偏远"], "score": 80},',
            '  "area_ratio_analysis": {"summary": "面积比例判断", "potential_waste": ["过道偏长"], "suggestions": ["增加过道收纳"]},',
            '  "orientation": "朝向或采光判断，无法确认则为 null",',
            '  "structure_risk_warnings": ["承重墙需要结构图确认，不能仅凭户型图判断"],',
            '  "confidence": 0 到 1,',
            '  "warnings": ["无法确认面积时说明原因"]',
            "}",
            "空间 type 使用英文枚举，例如 living_room、bedroom、kitchen、bathroom、dining_room、balcony、study、storage、unknown。",
            "门窗、墙体、承重墙、梁柱如果图纸没有明确标注，只能输出 unknown 或 candidate，不要输出确定结论。",
          ].join("\n"),
        },
      ],
    },
  ];

  const response = await fetch(getDashScopeChatCompletionsUrl(), {
    method: "POST",
    headers: {
      authorization: `Bearer ${getDashScopeApiKey()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: getVisionModel(),
      messages,
      temperature: 0,
    }),
    signal: createTimeoutSignal(),
  });

  const payload = await parseDashScopeResponse(response);
  const content = payload?.choices?.[0]?.message?.content;

  if (typeof content !== "string") {
    throw new Error("DashScope vision response is missing choices[0].message.content");
  }

  return normalizeFloorPlanAnalysis(extractJsonObject(content));
}
