import type { ChatMessage } from "@/lib/ai/dashscope";
import type { IntentProfile } from "@/lib/ai/intent";
import type { KnowledgeChunk } from "@/lib/ai/retrieval";

// 知识库资料进入 prompt 的最大字符数；控制模型耗时和 token 成本。
const MAX_CONTEXT_CHARS = 6000;
// 历史对话进入 prompt 的最大字符数；只保留必要上下文，避免旧对话污染当前回答。
const MAX_HISTORY_CHARS = 1800;

export type PromptHistoryMessage = {
  // 只允许用户和助手消息进入最终 prompt，system 消息不作为会话历史恢复。
  role: "user" | "assistant";
  // 历史消息正文。
  content: string;
};

export type ChatPromptContext = {
  // 会话摘要来自 chat_sessions.summary，用来承接更早的房屋背景、预算、阶段和已讨论问题。
  sessionSummary?: string | null;
};

/**
 * 将单个知识库 chunk 格式化为模型可读文本。
 * 保留来源、层级、模块、章节和风险等级，帮助模型知道资料的上下文和可信边界。
 */
function formatChunk(chunk: KnowledgeChunk, index: number) {
  // 把一个知识 chunk 整理成模型容易阅读的格式。
  // 这里保留来源信息，是为了让模型知道这段知识来自哪一层知识库。
  return [
    `【资料 ${index}】`,
    `来源文件：${chunk.source_file}`,
    `知识层级：${chunk.layer || "未标注"}`,
    `模块：${chunk.module || "未标注"}`,
    `章节：${chunk.section || chunk.title || "未标注"}`,
    `文档类型：${chunk.doc_type || "未标注"}`,
    `风险等级：${chunk.risk_level || "未标注"}`,
    `相似度：${chunk.similarity.toFixed(4)}`,
    "内容：",
    chunk.content.trim(),
  ].join("\n");
}

/**
 * 构建知识库上下文。
 * 使用 MAX_CONTEXT_CHARS 做硬限制，避免过长资料导致模型响应慢、超时或成本过高。
 */
export function buildKnowledgeContext(chunks: KnowledgeChunk[]) {
  // 把多个 chunks 拼成一段 context。
  // MAX_CONTEXT_CHARS 是第一版保护措施，避免一次塞给模型太多内容。
  const parts: string[] = [];
  let totalChars = 0;

  for (const [index, chunk] of chunks.entries()) {
    const text = formatChunk(chunk, index + 1);
    const nextTotal = totalChars + text.length;

    if (nextTotal > MAX_CONTEXT_CHARS) {
      break;
    }

    parts.push(text);
    totalChars = nextTotal;
  }

  return parts.join("\n\n---\n\n");
}

/**
 * 构建最近对话历史上下文。
 * 历史只保留文字内容，不带 sources，目的是让模型理解追问而不是扩大 prompt。
 */
function buildHistoryContext(history: PromptHistoryMessage[]) {
  // 把数据库里最近几轮对话整理成简短上下文。
  // 这里不传 sources，避免 prompt 过长；sources 只用于前端展示和审计。
  const parts: string[] = [];
  let totalChars = 0;

  for (const item of history) {
    const roleName = item.role === "user" ? "用户" : "genengi";
    const text = `${roleName}：${item.content.trim()}`;
    const nextTotal = totalChars + text.length;

    if (nextTotal > MAX_HISTORY_CHARS) {
      break;
    }

    parts.push(text);
    totalChars = nextTotal;
  }

  return parts.join("\n");
}

/**
 * 根据意图识别结果生成回答策略。
 * 例如详细问题给步骤，普通问题保持简洁，合同/风险类问题补充对应提醒。
 */
function buildAnswerPolicyContext(intentProfile: IntentProfile) {
  return [
    `回答模式：${intentProfile.detailLevel === "detailed" ? "详细步骤" : "简洁回答"}`,
    `命中标签：${intentProfile.labels.length > 0 ? intentProfile.labels.join("、") : "普通装修问题"}`,
    "策略要求：",
    ...intentProfile.guidance.map((item) => `- ${item}`),
  ].join("\n");
}

/**
 * 组装最终传给聊天模型的 messages。
 * system 负责约束 Agent 边界，user 负责携带问题、历史、策略和知识库资料。
 */
export function buildChatMessages(
  question: string,
  chunks: KnowledgeChunk[],
  history: PromptHistoryMessage[] = [],
  intentProfile: IntentProfile,
  promptContext: ChatPromptContext = {},
): ChatMessage[] {
  const context = buildKnowledgeContext(chunks);
  const historyContext = buildHistoryContext(history);
  const answerPolicyContext = buildAnswerPolicyContext(intentProfile);
  const sessionSummary = promptContext.sessionSummary?.trim();

  // system message：写死 Agent 的行为边界。
  // 重点是让模型基于知识库回答，而不是凭空发挥。
  const systemPrompt = [
    "你是一个装修问答 Agent，面向普通业主回答装修问题。",
    "你必须优先依据提供的知识库资料回答。",
    "不要编造知识库里没有的国家标准、法律条款、品牌参数或检测结论。",
    "如果资料不足以直接判断，要明确说“目前不能直接判断”，并说明还需要用户补充哪些信息。",
    "遇到漏水、用电、燃气、结构安全、付款争议、维权、甲醛或人身安全问题，要主动提醒风险。",
    "民间经验只能作为参考，不能单独作为最终结论依据。",
    "回答要具体、克制、可执行，不要为了显得确定而过度判断。",
    "默认用简洁自然的口吻回答，不要写成报告。",
    "除非用户要求详细分析，否则回答控制在 300 到 500 字。",
    "如果用户明确要求“具体怎么做”“详细”“一步一步”“清单”“流程”“怎么操作”，可以超过 500 字，优先输出可照着执行的步骤清单。",
  ].join("\n");

  // user message：把本次问题和检索资料一起交给模型。
  // 后续如果做多轮对话，可以在这里追加历史消息摘要。
  const userPrompt = [
    "请根据下面的历史对话和知识库资料回答用户问题。",
    "",
    "【会话摘要】",
    sessionSummary || "暂无会话摘要。",
    "",
    "【最近对话历史】",
    historyContext || "暂无历史对话。",
    "",
    "【用户问题】",
    question,
    "",
    "【本次回答策略】",
    answerPolicyContext,
    "",
    "【知识库资料】",
    context || "没有检索到可用资料。",
    "",
    "【输出要求】",
    "1. 不要使用“初步判断、判断依据、你现在可以怎么做、风险提醒”这类固定标题。",
    "2. 先用 1 到 2 句话直接回答用户最关心的问题。",
    "3. 再给 3 个以内最关键的核对点或下一步动作。",
    "4. 如果用户要求具体步骤、详细流程或清单，上一条的“3 个以内”限制不适用；这时要按实际流程分步骤回答，并把关键核对项写完整。",
    "5. 合同、报价、付款、验收、维权类问题如果用户问“具体如何做”，必须包含：签前准备、条款核对、附件确认、付款节点、风险信号和证据留存。",
    "6. 合同签约类详细回答要尽量按真实操作顺序写：签前准备 -> 核对主体 -> 核对报价附件 -> 核对材料和增项 -> 核对付款验收 -> 签字付款留证。",
    "7. 如果涉及风险、争议或售后，用 1 句话提醒保留合同、报价单、照片、视频和聊天记录。",
    "8. 如果需要举例，必须明确写“例如”，不要把示例说成已经发生的事实。",
    "9. 不要输出资料编号列表，不要说“根据资料 1/2/3”。",
  ].join("\n");

  return [
    {
      role: "system",
      content: systemPrompt,
    },
    {
      role: "user",
      content: userPrompt,
    },
  ];
}
