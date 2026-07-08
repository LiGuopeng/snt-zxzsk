import type { ChatMessage } from "@/lib/ai/dashscope";
import type { IntentProfile } from "@/lib/ai/intent";
import type { KnowledgeChunk } from "@/lib/ai/retrieval";

const MAX_CONTEXT_CHARS = 9000;
const MAX_HISTORY_CHARS = 3000;

export type PromptHistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

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

function buildAnswerPolicyContext(intentProfile: IntentProfile) {
  return [
    `回答模式：${intentProfile.detailLevel === "detailed" ? "详细步骤" : "简洁回答"}`,
    `命中标签：${intentProfile.labels.length > 0 ? intentProfile.labels.join("、") : "普通装修问题"}`,
    "策略要求：",
    ...intentProfile.guidance.map((item) => `- ${item}`),
  ].join("\n");
}

export function buildChatMessages(
  question: string,
  chunks: KnowledgeChunk[],
  history: PromptHistoryMessage[] = [],
  intentProfile: IntentProfile,
): ChatMessage[] {
  const context = buildKnowledgeContext(chunks);
  const historyContext = buildHistoryContext(history);
  const answerPolicyContext = buildAnswerPolicyContext(intentProfile);

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
