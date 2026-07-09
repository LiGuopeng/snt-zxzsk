const DEFAULT_DASHSCOPE_IMAGE_MODEL = "wan2.7-image";
const DEFAULT_DASHSCOPE_IMAGE_SIZE = "1K";
const DEFAULT_DASHSCOPE_IMAGE_CREATE_URL =
  "https://dashscope.aliyuncs.com/api/v1/services/aigc/image-generation/generation";
const DEFAULT_DASHSCOPE_TASK_URL = "https://dashscope.aliyuncs.com/api/v1/tasks";
const DEFAULT_DASHSCOPE_IMAGE_TIMEOUT_MS = 180000;
const DEFAULT_DASHSCOPE_IMAGE_POLL_INTERVAL_MS = 3000;
const DEFAULT_DASHSCOPE_IMAGE_THINKING_MODE = false;

function getDashScopeApiKey() {
  const apiKey = process.env.DASHSCOPE_API_KEY;

  if (!apiKey) {
    throw new Error("未配置真实生图服务：缺少 DASHSCOPE_API_KEY");
  }

  return apiKey;
}

function getDashScopeImageModel() {
  return process.env.DASHSCOPE_IMAGE_MODEL || DEFAULT_DASHSCOPE_IMAGE_MODEL;
}

function getDashScopeImageSize() {
  return process.env.DASHSCOPE_IMAGE_SIZE || DEFAULT_DASHSCOPE_IMAGE_SIZE;
}

function getDashScopeImageCreateUrl() {
  return process.env.DASHSCOPE_IMAGE_CREATE_URL || DEFAULT_DASHSCOPE_IMAGE_CREATE_URL;
}

function getDashScopeTaskUrl(taskId: string) {
  const baseUrl = process.env.DASHSCOPE_TASK_URL || DEFAULT_DASHSCOPE_TASK_URL;

  return `${baseUrl}/${taskId}`;
}

function getDashScopeImageTimeoutMs() {
  const timeoutMs = Number(process.env.DASHSCOPE_IMAGE_TIMEOUT_MS || DEFAULT_DASHSCOPE_IMAGE_TIMEOUT_MS);

  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_DASHSCOPE_IMAGE_TIMEOUT_MS;
}

function getDashScopeImageThinkingMode() {
  const value = process.env.DASHSCOPE_IMAGE_THINKING_MODE;

  if (typeof value !== "string") {
    return DEFAULT_DASHSCOPE_IMAGE_THINKING_MODE;
  }

  return value.toLowerCase() === "true";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseJsonResponse(response: Response) {
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(`DashScope 生图服务调用失败：${response.status} ${JSON.stringify(payload)}`);
  }

  return payload as Record<string, unknown>;
}

function getTaskId(payload: Record<string, unknown>) {
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
  const output = payload.output;

  if (!output || typeof output !== "object") {
    throw new Error("DashScope 生图任务结果缺少 output");
  }

  const status = (output as Record<string, unknown>).task_status;

  return typeof status === "string" ? status : null;
}

function getImageUrl(payload: Record<string, unknown>) {
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

async function createImageTask(prompt: string) {
  const response = await fetch(getDashScopeImageCreateUrl(), {
    method: "POST",
    headers: {
      authorization: `Bearer ${getDashScopeApiKey()}`,
      "content-type": "application/json",
      "X-DashScope-Async": "enable",
    },
    body: JSON.stringify({
      model: getDashScopeImageModel(),
      input: {
        messages: [
          {
            role: "user",
            content: [
              {
                text: prompt,
              },
            ],
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

  return getTaskId(await parseJsonResponse(response));
}

async function queryImageTask(taskId: string) {
  const response = await fetch(getDashScopeTaskUrl(taskId), {
    method: "GET",
    headers: {
      authorization: `Bearer ${getDashScopeApiKey()}`,
    },
  });

  return parseJsonResponse(response);
}

export async function generateInteriorDesignImage(prompt: string) {
  const taskId = await createImageTask(prompt);
  const deadline = Date.now() + getDashScopeImageTimeoutMs();

  while (Date.now() < deadline) {
    const payload = await queryImageTask(taskId);
    const status = getTaskStatus(payload);

    if (status === "SUCCEEDED") {
      const imageUrl = getImageUrl(payload);
      const imageResponse = await fetch(imageUrl);

      if (!imageResponse.ok) {
        throw new Error(`下载生成图片失败：${imageResponse.status}`);
      }

      return {
        imageBuffer: Buffer.from(await imageResponse.arrayBuffer()),
        model: getDashScopeImageModel(),
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
