type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

const DEFAULT_EMBEDDING_MODEL = "text-embedding-v4";
const DEFAULT_EMBEDDING_DIMENSION = 1536;
const DEFAULT_CHAT_MODEL = "qwen-plus";
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

function getDashScopeEmbeddingsUrl() {
  // URL 放到环境变量里，方便上线后切换阿里官方地址、内网代理或自建网关。
  return process.env.DASHSCOPE_EMBEDDINGS_URL || DEFAULT_DASHSCOPE_EMBEDDINGS_URL;
}

function getDashScopeChatCompletionsUrl() {
  // 聊天接口也用环境变量控制，避免以后换模型网关时改代码。
  return process.env.DASHSCOPE_CHAT_COMPLETIONS_URL || DEFAULT_DASHSCOPE_CHAT_COMPLETIONS_URL;
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
  });

  const payload = await parseDashScopeResponse(response);
  const answer = payload?.choices?.[0]?.message?.content;

  if (typeof answer !== "string") {
    throw new Error("DashScope chat response is missing choices[0].message.content");
  }

  return answer;
}
