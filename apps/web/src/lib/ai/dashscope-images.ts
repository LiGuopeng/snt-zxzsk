// 普通文生图默认模型：用于全屋覆盖封面图和户型立体结构图。
const DEFAULT_DASHSCOPE_IMAGE_MODEL = "wan2.7-image";
// 带参考图输入时默认走 image-pro，空间图需要参考全屋封面图来保持同源风格。
const DEFAULT_DASHSCOPE_REFERENCE_IMAGE_MODEL = "wan2.7-image-pro";
// 默认 1K 优先保证速度和可用性；高清图后续可以做单独的放大链路。
const DEFAULT_DASHSCOPE_IMAGE_SIZE = "1K";
const DEFAULT_DASHSCOPE_IMAGE_CREATE_URL =
  "https://dashscope.aliyuncs.com/api/v1/services/aigc/image-generation/generation";
const DEFAULT_DASHSCOPE_TASK_URL = "https://dashscope.aliyuncs.com/api/v1/tasks";
// 效果图接口是同步等待 DashScope 异步任务完成，超时要足够覆盖常见排队时间。
const DEFAULT_DASHSCOPE_IMAGE_TIMEOUT_MS = 180000;
const DEFAULT_DASHSCOPE_IMAGE_POLL_INTERVAL_MS = 3000;
// 默认关闭 thinking mode，优先减少图片生成耗时；需要更强推理时可通过环境变量打开。
const DEFAULT_DASHSCOPE_IMAGE_THINKING_MODE = false;

// DashScope 万相 2.7 的 messages.content 可以混合 image 和 text。
// 全屋主图只传 text，空间图会把全屋封面图作为 image 参考输入。
type DashScopeImageMessageContent = {
  image: string;
} | {
  text: string;
};

function getDashScopeApiKey() {
  // 真实生图服务必须显式配置 API Key，不提供 mock 兜底，避免线上出现假图。
  const apiKey = process.env.DASHSCOPE_API_KEY;

  if (!apiKey) {
    throw new Error("未配置真实生图服务：缺少 DASHSCOPE_API_KEY");
  }

  return apiKey;
}

function getDashScopeImageModel(hasReferenceImages = false) {
  // 生图模型通过环境变量控制，方便在速度/质量之间切换，不需要改业务代码。
  // 严格参考图生成需要图像编辑能力，默认使用 Wan 2.7 的 image-pro 模型。
  if (hasReferenceImages) {
    return process.env.DASHSCOPE_REFERENCE_IMAGE_MODEL || DEFAULT_DASHSCOPE_REFERENCE_IMAGE_MODEL;
  }

  return process.env.DASHSCOPE_IMAGE_MODEL || DEFAULT_DASHSCOPE_IMAGE_MODEL;
}

function getDashScopeImageSize() {
  // 默认 1K 是为了控制生成耗时；后续如果做高清下载，可以单独开二次放大流程。
  return process.env.DASHSCOPE_IMAGE_SIZE || DEFAULT_DASHSCOPE_IMAGE_SIZE;
}

function getDashScopeImageCreateUrl() {
  // 允许通过环境变量切换网关地址，方便私有网络或代理部署。
  return process.env.DASHSCOPE_IMAGE_CREATE_URL || DEFAULT_DASHSCOPE_IMAGE_CREATE_URL;
}

function getDashScopeTaskUrl(taskId: string) {
  // 查询地址按 taskId 拼接，和 create 接口分离，便于后续替换任务查询网关。
  const baseUrl = process.env.DASHSCOPE_TASK_URL || DEFAULT_DASHSCOPE_TASK_URL;

  return `${baseUrl}/${taskId}`;
}

function getDashScopeImageTimeoutMs() {
  // 环境变量可能被误填成非数字；这里做兜底，避免轮询逻辑直接失效。
  const timeoutMs = Number(process.env.DASHSCOPE_IMAGE_TIMEOUT_MS || DEFAULT_DASHSCOPE_IMAGE_TIMEOUT_MS);

  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_DASHSCOPE_IMAGE_TIMEOUT_MS;
}

function getDashScopeImageThinkingMode() {
  // DashScope 参数需要 boolean，这里只把字符串 "true" 识别为开启。
  const value = process.env.DASHSCOPE_IMAGE_THINKING_MODE;

  if (typeof value !== "string") {
    return DEFAULT_DASHSCOPE_IMAGE_THINKING_MODE;
  }

  return value.toLowerCase() === "true";
}

function sleep(ms: number) {
  // 轮询任务状态使用固定间隔，简单可控，不阻塞事件循环。
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseJsonResponse(response: Response) {
  // DashScope 错误信息通常在 JSON body 里，保留下来方便前端和日志定位具体参数问题。
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(`DashScope 生图服务调用失败：${response.status} ${JSON.stringify(payload)}`);
  }

  return payload as Record<string, unknown>;
}

function getTaskId(payload: Record<string, unknown>) {
  // create task 成功后必须拿到 task_id，否则后续无法轮询任务结果。
  const output = payload.output;

  if (!output || typeof output !== "object") {
    throw new Error("DashScope 生图服务没有返回任务信息");
  }

  const taskId = (output as Record<string, unknown>).task_id;

  if (typeof taskId !== "string" || !taskId) {
    throw new Error("DashScope 生图服务没有返回 task_id");
  }

  return taskId;
}

function getTaskStatus(payload: Record<string, unknown>) {
  // task_status 是轮询分支判断的唯一依据：SUCCEEDED/FAILED/CANCELED/UNKNOWN。
  const output = payload.output;

  if (!output || typeof output !== "object") {
    throw new Error("DashScope 生图任务结果缺少 output");
  }

  const status = (output as Record<string, unknown>).task_status;

  return typeof status === "string" ? status : null;
}

function getImageUrl(payload: Record<string, unknown>) {
  // 不同 DashScope 生图模型返回结构可能是 output.results，也可能兼容 OpenAI 风格 choices。
  // 这里兼容两类结构，避免以后切模型时接口直接失效。
  const output = payload.output;

  if (!output || typeof output !== "object") {
    throw new Error("DashScope 生图任务结果缺少 output");
  }

  const outputRecord = output as Record<string, unknown>;
  const results = outputRecord.results;

  if (!Array.isArray(results)) {
    const choices = outputRecord.choices;

    if (!Array.isArray(choices)) {
      throw new Error("DashScope 生图任务没有返回图片结果");
    }

    for (const choice of choices) {
      if (!choice || typeof choice !== "object") {
        continue;
      }

      const message = (choice as Record<string, unknown>).message;

      if (!message || typeof message !== "object") {
        continue;
      }

      const content = (message as Record<string, unknown>).content;

      if (!Array.isArray(content)) {
        continue;
      }

      for (const item of content) {
        if (!item || typeof item !== "object") {
          continue;
        }

        const image = (item as Record<string, unknown>).image;

        if (typeof image === "string" && image) {
          return image;
        }
      }
    }

    throw new Error("DashScope 生图任务没有返回图片 URL");
  }

  const firstResult = results.find((result) => Boolean(result) && typeof result === "object") as
    | Record<string, unknown>
    | undefined;
  const url = firstResult?.url;

  if (typeof url !== "string" || !url) {
    throw new Error("DashScope 生图任务没有返回图片 URL");
  }

  return url;
}

async function createImageTask(prompt: string, referenceImages: string[] = []) {
  // 生图走异步任务：先创建 task_id，再轮询结果。同步等待会更容易超时。
  // 万相 2.7 的 input.messages.content 支持 image + text 混合输入；空间效果图会把全屋覆盖封面图作为参考图传入。
  const model = getDashScopeImageModel(referenceImages.length > 0);
  const content: DashScopeImageMessageContent[] = [
    ...referenceImages.map((image) => ({ image })),
    {
      text: prompt,
    },
  ];

  const response = await fetch(getDashScopeImageCreateUrl(), {
    method: "POST",
    headers: {
      authorization: `Bearer ${getDashScopeApiKey()}`,
      "content-type": "application/json",
      "X-DashScope-Async": "enable",
    },
    body: JSON.stringify({
      model,
      input: {
        messages: [
          {
            role: "user",
            content,
          },
        ],
      },
      parameters: {
        size: getDashScopeImageSize(),
        n: 1,
        watermark: false,
        thinking_mode: getDashScopeImageThinkingMode(),
      },
    }),
  });

  return {
    model,
    taskId: getTaskId(await parseJsonResponse(response)),
  };
}

async function queryImageTask(taskId: string) {
  // DashScope 生图是异步任务，查询接口只负责取当前任务状态，不做业务解释。
  const response = await fetch(getDashScopeTaskUrl(taskId), {
    method: "GET",
    headers: {
      authorization: `Bearer ${getDashScopeApiKey()}`,
    },
  });

  return parseJsonResponse(response);
}

export async function generateInteriorDesignImage(prompt: string, options?: { referenceImages?: string[] }) {
  // 统一出口：业务层只关心 prompt 和可选参考图，不直接接触 DashScope 的任务创建/轮询细节。
  const createdTask = await createImageTask(prompt, options?.referenceImages || []);
  const taskId = createdTask.taskId;
  const deadline = Date.now() + getDashScopeImageTimeoutMs();

  // 轮询直到成功、失败或超时。接口层会把失败状态写入 design_generation_jobs。
  while (Date.now() < deadline) {
    const payload = await queryImageTask(taskId);
    const status = getTaskStatus(payload);

    if (status === "SUCCEEDED") {
      const imageUrl = getImageUrl(payload);
      // DashScope 返回的是临时图片地址，必须下载并转存到本项目文件目录，避免链接过期。
      const imageResponse = await fetch(imageUrl);

      if (!imageResponse.ok) {
        throw new Error(`下载生成图片失败：${imageResponse.status}`);
      }

      return {
        imageBuffer: Buffer.from(await imageResponse.arrayBuffer()),
        model: createdTask.model,
        taskId,
        responsePayload: payload,
      };
    }

    if (status === "FAILED" || status === "CANCELED" || status === "UNKNOWN") {
      throw new Error(`DashScope 生图任务失败：${JSON.stringify(payload)}`);
    }

    await sleep(DEFAULT_DASHSCOPE_IMAGE_POLL_INTERVAL_MS);
  }

  throw new Error("DashScope 生图任务超时，请稍后重试");
}
