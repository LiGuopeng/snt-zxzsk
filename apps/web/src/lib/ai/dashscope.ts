type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  // OpenAI 兼容 chat/completions 的角色。
  role: ChatRole;
  // 当前消息文本内容。
  content: string;
};

type VisionContent =
  | {
      // 视觉模型里的文本指令。
      type: "text";
      text: string;
    }
  | {
      // 视觉模型里的图片输入，可以是公网 URL 或 data URL。
      type: "image_url";
      image_url: {
        url: string;
      };
    };

type VisionMessage = {
  // 视觉模型同样使用 chat message 结构。
  role: ChatRole;
  // system 可以是字符串；user 需要同时携带图片和文本数组。
  content: string | VisionContent[];
};

export type FloorPlanAnalysis = {
  // 户型摘要，例如 3室2厅2卫。
  house_type: string | null;
  // 模型识别出的面积，无法确认时为 null。
  area: number | null;
  // 识别出的空间列表，后续效果图按这个列表生成空间图。
  spaces: Array<{
    name: string;
    type: string;
    confidence?: number;
    estimated_area?: number | null;
    area_ratio?: number | null;
    connections?: string[];
  }>;
  // 户型动线总结。
  circulation: string | null;
  // 朝向或采光判断。
  orientation: string | null;
  // 门的位置和连接关系。
  doors: Array<{
    location: string;
    connects?: string[];
    confidence?: number;
  }>;
  // 窗的位置、关联空间和朝向。
  windows: Array<{
    location: string;
    related_space?: string | null;
    orientation?: string | null;
    confidence?: number;
  }>;
  // 墙体疑似结构信息；普通户型图不能确认承重，只能做候选判断。
  walls: Array<{
    location: string;
    type: string;
    confidence?: number;
    note?: string | null;
  }>;
  // 厨房、卫生间等湿区。
  wet_areas: Array<{
    name: string;
    type: string;
    location?: string | null;
  }>;
  // 阳台或设备平台等外接空间。
  balconies: Array<{
    name: string;
    location?: string | null;
    related_space?: string | null;
  }>;
  // 动线诊断结构化结果。
  circulation_analysis: {
    summary: string | null;
    issues: string[];
    score: number | null;
  };
  // 面积比例和浪费空间诊断结构化结果。
  area_ratio_analysis: {
    summary: string | null;
    potential_waste: string[];
    suggestions: string[];
  };
  // 结构风险提醒，强调不能仅凭户型图确定承重墙。
  structure_risk_warnings: string[];
  // 模型自评置信度，0 到 1。
  confidence: number;
  // 解析限制或不确定性说明。
  warnings: string[];
};

// 默认文本向量模型，需和知识库 embedding 生成脚本保持一致。
const DEFAULT_EMBEDDING_MODEL = "text-embedding-v4";
// PostgreSQL knowledge_chunks.embedding 当前是 vector(1536)，这里必须保持一致。
const DEFAULT_EMBEDDING_DIMENSION = 1536;
// AI 装修顾问默认聊天模型。
const DEFAULT_CHAT_MODEL = "qwen-plus";
// 户型图解析默认视觉模型。
const DEFAULT_VISION_MODEL = "qwen-vl-plus";
// DashScope 默认超时，最终回答可使用更长时间，辅助步骤可单独传短超时。
const DEFAULT_DASHSCOPE_TIMEOUT_MS = 30000;
// DashScope embedding 官方接口。
const DEFAULT_DASHSCOPE_EMBEDDINGS_URL =
  "https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding";
// DashScope OpenAI 兼容 chat/completions 接口。
const DEFAULT_DASHSCOPE_CHAT_COMPLETIONS_URL =
  "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";

/**
 * 读取 DashScope API Key。
 * 所有 DashScope 调用都走这个入口，缺失时直接抛错，避免请求发出后才失败。
 */
function getDashScopeApiKey() {
  const apiKey = process.env.DASHSCOPE_API_KEY;

  if (!apiKey) {
    throw new Error("Missing DASHSCOPE_API_KEY");
  }

  return apiKey;
}

/**
 * 获取文本向量模型名称。
 * AI 装修顾问用它给用户问题生成 query embedding。
 */
function getEmbeddingModel() {
  return process.env.EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;
}

/**
 * 获取 embedding 维度。
 * 必须和 PostgreSQL pgvector 字段维度一致，目前 knowledge_chunks.embedding 是 vector(1536)。
 */
function getEmbeddingDimension() {
  return Number(process.env.EMBEDDING_DIMENSION || DEFAULT_EMBEDDING_DIMENSION);
}

/**
 * 获取聊天模型名称。
 * AI 装修顾问最终回答和追问改写都通过这个模型生成。
 */
function getChatModel() {
  return process.env.CHAT_MODEL || DEFAULT_CHAT_MODEL;
}

/**
 * 获取视觉模型名称。
 * 主要用于户型图解析，不属于 AI 装修顾问聊天主链路。
 */
function getVisionModel() {
  return process.env.VISION_MODEL || DEFAULT_VISION_MODEL;
}

/**
 * 获取 DashScope embedding 接口地址。
 * 地址放环境变量中，方便生产环境切代理或网关。
 */
function getDashScopeEmbeddingsUrl() {
  // URL 放到环境变量里，方便上线后切换阿里官方地址、内网代理或自建网关。
  return process.env.DASHSCOPE_EMBEDDINGS_URL || DEFAULT_DASHSCOPE_EMBEDDINGS_URL;
}

/**
 * 获取 DashScope chat completions 接口地址。
 * 聊天、追问改写和视觉兼容调用都复用这个 OpenAI 兼容接口。
 */
function getDashScopeChatCompletionsUrl() {
  // 聊天接口也用环境变量控制，避免以后换模型网关时改代码。
  return process.env.DASHSCOPE_CHAT_COMPLETIONS_URL || DEFAULT_DASHSCOPE_CHAT_COMPLETIONS_URL;
}

/**
 * 获取默认 DashScope 请求超时。
 * 最终回答可以用全局超时，追问改写等辅助步骤可以传入更短 timeout。
 */
function getDashScopeTimeoutMs() {
  const timeoutMs = Number(process.env.DASHSCOPE_TIMEOUT_MS || DEFAULT_DASHSCOPE_TIMEOUT_MS);

  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_DASHSCOPE_TIMEOUT_MS;
}

/**
 * 创建 AbortSignal 超时控制。
 * 统一从这里控制 fetch 超时，避免各处手写 setTimeout。
 */
function createTimeoutSignal(timeoutMs?: number) {
  // 不同调用场景允许不同超时：追问改写要短，最终回答可以长一些。
  return AbortSignal.timeout(timeoutMs || getDashScopeTimeoutMs());
}

/**
 * 解析 DashScope JSON 响应。
 * 非 2xx 时保留服务端返回体，方便排查 InvalidParameter、限流、鉴权等问题。
 */
async function parseDashScopeResponse(response: Response) {
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      `DashScope request failed: ${response.status} ${JSON.stringify(payload)}`,
    );
  }

  return payload;
}

/**
 * 为用户问题生成 query embedding。
 * 返回值直接传给 PostgreSQL pgvector 检索，不会写回知识库表。
 */
export async function createQueryEmbedding(question: string) {
  // 知识库检索先把用户问题转成 query embedding，再去 PostgreSQL/pgvector 做相似度召回。
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

/**
 * 调用聊天模型生成文本。
 * 上层负责 prompt 组装；本函数只关心模型调用、超时和返回结构校验。
 */
export async function generateChatAnswer(
  messages: ChatMessage[],
  options?: {
    timeoutMs?: number;
  },
) {
  // 回答生成只负责调用模型；知识库上下文、系统提示词等在上层 prompt 组装，职责分开。
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
    signal: createTimeoutSignal(options?.timeoutMs),
  });

  const payload = await parseDashScopeResponse(response);
  const answer = payload?.choices?.[0]?.message?.content;

  if (typeof answer !== "string") {
    throw new Error("DashScope chat response is missing choices[0].message.content");
  }

  return answer;
}

/**
 * 以流式方式调用聊天模型。
 * 用于 GPT 式逐步输出体验；调用方通过 onToken 接收增量文本，函数返回完整回答。
 */
export async function generateChatAnswerStream(
  messages: ChatMessage[],
  options?: {
    onToken?: (token: string) => void | Promise<void>;
    timeoutMs?: number;
  },
) {
  const response = await fetch(getDashScopeChatCompletionsUrl(), {
    method: "POST",
    headers: {
      authorization: `Bearer ${getDashScopeApiKey()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: getChatModel(),
      messages,
      stream: true,
      temperature: 0.2,
    }),
    signal: createTimeoutSignal(options?.timeoutMs),
  });

  if (!response.ok || !response.body) {
    await parseDashScopeResponse(response);
    throw new Error("DashScope stream response is missing body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const rawLine of lines) {
      const line = rawLine.trim();

      if (!line || !line.startsWith("data:")) {
        continue;
      }

      const data = line.replace(/^data:\s*/, "");

      if (data === "[DONE]") {
        continue;
      }

      const payload = JSON.parse(data) as {
        choices?: Array<{
          delta?: {
            content?: string;
          };
          message?: {
            content?: string;
          };
        }>;
      };
      const token = payload.choices?.[0]?.delta?.content || payload.choices?.[0]?.message?.content || "";

      if (!token) {
        continue;
      }

      answer += token;
      await options?.onToken?.(token);
    }
  }

  return answer;
}

/**
 * 从视觉模型返回文本中提取 JSON 对象。
 * 模型偶尔会包 Markdown code fence，因此需要先截取 JSON 再 parse。
 */
function extractJsonObject(content: string) {
  // 视觉模型偶尔会包一层 ```json，这里只截取 JSON 对象，后续再做结构化归一化。
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

/**
 * 清洗模型返回的可空文本字段。
 * 用于把空字符串或 prompt 示例占位文字转换成 null，防止假信息进入数据库。
 */
function normalizeNullableText(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const text = value.trim();

  // 避免模型把 prompt 示例里的占位说明原样返回，前端误以为这是有效解析结论。
  if (!text || text.includes("无法确认则为 null")) {
    return null;
  }

  return text;
}

/**
 * 将户型图视觉模型返回值归一化成 FloorPlanAnalysis。
 * 视觉模型输出不稳定，所以所有数组、数字和文本字段都要逐项校验。
 */
function normalizeFloorPlanAnalysis(payload: unknown): FloorPlanAnalysis {
  if (!payload || typeof payload !== "object") {
    throw new Error("Floor plan analysis payload is not an object");
  }

  const record = payload as Record<string, unknown>;
  // 视觉模型返回值不完全稳定，所有数组字段都要逐项清洗，保证写入数据库的是可控结构。
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
    circulation: normalizeNullableText(record.circulation),
    orientation: normalizeNullableText(record.orientation),
    doors,
    windows,
    walls,
    wet_areas: wetAreas,
    balconies,
    circulation_analysis: {
      summary: normalizeNullableText(circulationAnalysis.summary),
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

/**
 * 调用 DashScope 视觉模型解析户型图。
 * imageUrl 可以是公网 URL，也可以是后端生成的 data URL；当前本地存储方案使用 data URL。
 */
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
