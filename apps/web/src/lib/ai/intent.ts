export type AnswerDetailLevel = "brief" | "detailed";

export type IntentProfile = {
  detailLevel: AnswerDetailLevel;
  labels: string[];
  forceLayers: string[];
  fallbackKeywords: string[];
  guidance: string[];
};

function normalizeQuestion(question: string) {
  return question.replace(/\s+/g, "");
}

function includesAny(text: string, keywords: string[]) {
  return keywords.some((keyword) => text.includes(keyword));
}

export function detectIntentProfile(question: string): IntentProfile {
  // 正式上线前的第一版意图策略中心。
  // 这里先用可解释的关键词规则，后期可以替换成数据库配置或小模型分类。
  // 重点：prompt 和 retrieval 都使用这份结果，避免两边规则不一致。
  const normalizedQuestion = normalizeQuestion(question);
  const labels: string[] = [];
  const forceLayers = new Set<string>();
  const fallbackKeywords = new Set<string>();
  const guidance: string[] = [];

  const needsDetailedSteps = includesAny(normalizedQuestion, [
    "具体",
    "详细",
    "一步一步",
    "步骤",
    "清单",
    "流程",
    "怎么做",
    "如何做",
    "怎么操作",
  ]);

  if (needsDetailedSteps) {
    labels.push("详细步骤");
    guidance.push("用户要求详细步骤，回答可以超过默认字数，要输出能照着执行的清单。");
  }

  const isContractLike = includesAny(normalizedQuestion, [
    "合同",
    "签约",
    "签合同",
    "补充协议",
    "条款",
    "定金",
  ]);

  if (isContractLike) {
    labels.push("合同签约");
    ["标准知识库", "AI问答模板库", "知识规则与风险控制"].forEach((layer) =>
      forceLayers.add(layer),
    );
    ["合同", "签约", "补充协议", "报价单", "材料清单", "付款", "增项"].forEach((keyword) =>
      fallbackKeywords.add(keyword),
    );
    guidance.push(
      "合同签约类回答必须覆盖合同正文、报价单附件、材料清单、增项规则、付款节点、验收整改、保修售后和证据留存。",
    );
  }

  const isPaymentLike = includesAny(normalizedQuestion, [
    "付款",
    "尾款",
    "首款",
    "增项",
    "报价",
    "预算",
    "收款",
  ]);

  if (isPaymentLike) {
    labels.push("付款报价");
    ["标准知识库", "AI问答模板库", "知识规则与风险控制"].forEach((layer) =>
      forceLayers.add(layer),
    );
    ["付款", "尾款", "首款", "增项", "报价", "预算"].forEach((keyword) =>
      fallbackKeywords.add(keyword),
    );
    guidance.push("付款报价类回答必须先统一口径，再判断明细、节点、验收和证据。");
  }

  const isDisputeLike = includesAny(normalizedQuestion, [
    "维权",
    "投诉",
    "拒付",
    "赔偿",
    "责任",
    "拖工期",
    "整改",
  ]);

  if (isDisputeLike) {
    labels.push("维权争议");
    ["AI问答模板库", "知识规则与风险控制"].forEach((layer) => forceLayers.add(layer));
    ["维权", "投诉", "拒付", "赔偿", "责任", "拖工期", "整改"].forEach((keyword) =>
      fallbackKeywords.add(keyword),
    );
    guidance.push("维权争议类回答必须克制，不要替用户下绝对法律结论，要先整理证据和沟通路径。");
  }

  const isSafetyLike = includesAny(normalizedQuestion, [
    "漏水",
    "渗水",
    "电",
    "燃气",
    "承重墙",
    "结构",
    "火花",
    "甲醛",
    "安全",
  ]);

  if (isSafetyLike) {
    labels.push("安全风险");
    ["标准知识库", "知识规则与风险控制"].forEach((layer) => forceLayers.add(layer));
    ["漏水", "渗水", "卫生间", "防水", "电", "燃气", "承重墙", "结构", "甲醛"].forEach(
      (keyword) => fallbackKeywords.add(keyword),
    );
    guidance.push("安全风险类回答必须优先提醒暂停高风险操作、留证、复验或找专业人员。");
  }

  const isTileLike = includesAny(normalizedQuestion, ["瓷砖", "空鼓", "瓦工", "铺贴"]);

  if (isTileLike) {
    labels.push("瓷砖瓦工");
    forceLayers.add("标准知识库");
    ["瓷砖", "空鼓", "瓦工", "铺贴", "验收"].forEach((keyword) =>
      fallbackKeywords.add(keyword),
    );
  }

  if (normalizedQuestion.length >= 2 && normalizedQuestion.length <= 12) {
    fallbackKeywords.add(normalizedQuestion);
  }

  return {
    detailLevel: needsDetailedSteps ? "detailed" : "brief",
    labels,
    forceLayers: [...forceLayers],
    fallbackKeywords: [...fallbackKeywords].slice(0, 12),
    guidance:
      guidance.length > 0
        ? guidance
        : ["未命中特殊意图，默认简洁回答，但仍必须基于知识库资料。"],
  };
}
