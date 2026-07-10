import type { IntentProfile } from "@/lib/ai/intent";
import { createPostgresClient, toVectorLiteral } from "@/lib/db/postgres";

export type KnowledgeChunk = {
  // knowledge_chunks 主键。
  id: string;
  // 所属知识文档 ID。
  document_id: string;
  // chunk 标题，可能来自 markdown 标题。
  title: string | null;
  // chunk 所在章节。
  section: string | null;
  // 真正进入 prompt 的知识正文。
  content: string;
  // 原始 markdown 文件路径，用于前端展示来源和排查知识库。
  source_file: string;
  // 知识库层级，例如标准、合同、预算、工艺等。
  layer: string | null;
  // 业务模块，例如水电、泥瓦、合同等。
  module: string | null;
  // 文档类型，用于辅助模型理解资料性质。
  doc_type: string | null;
  // 装修阶段，例如签约、施工、验收。
  stage: string | null;
  // 风险等级，用于回答时判断是否需要提醒用户谨慎。
  risk_level: string | null;
  // 关键词兜底检索使用的结构化关键词。
  keywords: string[];
  // 向量召回相似度；关键词兜底结果用 0 表示无向量相似度。
  similarity: number;
};

export type KnowledgeSource = {
  // 前端展示的来源文件。
  source_file: string;
  // 前端展示的章节。
  section: string | null;
  // 来源所属知识层级。
  layer: string | null;
  // 来源所属业务模块。
  module: string | null;
  // 来源相似度，用于调试召回质量。
  similarity: number;
};

export type RetrievalStats = {
  // 普通向量召回命中的条数。
  baseVectorCount: number;
  // 普通召回是否使用了关键词兜底。
  usedKeywordFallback: boolean;
  // 每个强制召回层级的召回统计。
  forcedLayers: Array<{
    layer: string;
    vectorCount: number;
    usedKeywordFallback: boolean;
    finalCount: number;
  }>;
  // 合并去重后的总 chunk 数量。
  mergedCount: number;
};

export type RetrievalResult = {
  // 最终候选知识片段。
  chunks: KnowledgeChunk[];
  // 召回统计，写入 chat_request_logs 方便排查。
  stats: RetrievalStats;
};

// 普通向量召回数量。数量越大资料越全，但 prompt 越长、回答越慢。
const DEFAULT_MATCH_COUNT = 6;
// 返回给前端展示的来源数量。
const DEFAULT_SOURCE_COUNT = 4;
// 命中特定意图时，每个强制知识层级额外召回的数量。
const FORCED_MATCH_COUNT = 3;
// 过滤过短 chunk 的阈值。
const MIN_CONTENT_CHARS = 30;
// 向量召回为空时关键词兜底保留的数量。
const KEYWORD_FALLBACK_COUNT = 8;
// 每个关键词在数据库里最多扫描返回的候选数量。
const KEYWORD_QUERY_LIMIT = 30;

/**
 * 判断一个知识 chunk 是否足够用于回答。
 * 过滤掉只有标题或内容过短的片段，减少无效上下文占用 prompt。
 */
function isUsefulChunk(chunk: KnowledgeChunk) {
  // 第一版先做一个很朴素的质量过滤：
  // 有些 chunk 只有标题，例如“水电增项风险”，这类内容对最终回答帮助不大。
  // 后续可以升级成更细的 chunk 质量评分或 rerank。
  return chunk.content.trim().length >= MIN_CONTENT_CHARS;
}

/**
 * 对 sources 做去重和截断。
 * 前端只需要展示足够代表性的来源，不需要把同一文件同一章节重复列出。
 */
function dedupeSources(chunks: KnowledgeChunk[], limit: number) {
  const sources: KnowledgeSource[] = [];
  const seen = new Set<string>();

  for (const chunk of chunks) {
    // 同一个文件、同一个 section 只保留一次，避免 sources 重复刷屏。
    const key = `${chunk.source_file}::${chunk.section || ""}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    sources.push({
      source_file: chunk.source_file,
      section: chunk.section,
      layer: chunk.layer,
      module: chunk.module,
      similarity: chunk.similarity,
    });

    if (sources.length >= limit) {
      break;
    }
  }

  return sources;
}

/**
 * 使用 PostgreSQL pgvector 函数做向量召回。
 * queryEmbedding 是本次用户问题的向量，layerFilter 用于按知识库层级强制召回。
 */
export async function matchKnowledgeChunks(
  queryEmbedding: number[],
  options?: {
    matchCount?: number;
    layerFilter?: string | null;
  },
) {
  // 这里调用 PostgreSQL 里已经创建好的数据库函数：
  // public.match_knowledge_chunks(query_embedding, match_count, layer_filter)
  //
  // 它会在 pgvector 中按 cosine similarity 找最相关的知识片段。
  const sql = createPostgresClient();
  const rows = await sql<KnowledgeChunk[]>`
    select *
    from public.match_knowledge_chunks(
      ${toVectorLiteral(queryEmbedding)}::vector,
      ${options?.matchCount || DEFAULT_MATCH_COUNT},
      ${options?.layerFilter || null}
    )
  `;

  return rows as KnowledgeChunk[];
}

/**
 * 清理 ILIKE 查询中的通配符。
 * 关键词兜底只做模糊匹配，不允许用户输入里的 %/_ 扩大匹配范围。
 */
function escapeIlikeValue(value: string) {
  return value.replace(/[%_]/g, "").trim();
}

/**
 * 给关键词兜底结果打分。
 * 因为关键词召回没有向量相似度，所以用文件名、标题、章节、模块、正文命中位置做可解释排序。
 */
function scoreKeywordChunk(chunk: KnowledgeChunk, keywords: string[]) {
  // 关键词兜底没有向量相似度，所以用可解释的权重排序。
  // 文件名、标题、章节命中更可信；正文命中只作为弱信号。
  let score = 0;
  const sourceFile = chunk.source_file || "";
  const title = chunk.title || "";
  const section = chunk.section || "";
  const moduleName = chunk.module || "";
  const content = chunk.content || "";

  for (const keyword of keywords) {
    if (sourceFile.includes(keyword)) score += 6;
    if (title.includes(keyword)) score += 5;
    if (section.includes(keyword)) score += 4;
    if (moduleName.includes(keyword)) score += 3;
    if (content.includes(keyword)) score += 1;
  }

  return score;
}

/**
 * 当向量召回为空时，用关键词在 knowledge_chunks 中做兜底检索。
 * 这是服务可用性保护：embedding 缺失或向量索引异常时，AI 顾问仍能尽量回答。
 */
async function matchKeywordKnowledgeChunks(
  intentProfile: IntentProfile,
  options?: {
    limit?: number;
    layerFilter?: string | null;
  },
) {
  const sql = createPostgresClient();
  const keywords = intentProfile.fallbackKeywords.map(escapeIlikeValue).filter(Boolean);
  const merged: KnowledgeChunk[] = [];
  const seen = new Set<string>();

  for (const keyword of keywords) {
    const pattern = `%${keyword}%`;
    const rows = await sql<Omit<KnowledgeChunk, "similarity">[]>`
      select
        id,
        document_id,
        title,
        section,
        content,
        source_file,
        layer,
        module,
        doc_type,
        stage,
        risk_level,
        keywords
      from public.knowledge_chunks
      where
        (${options?.layerFilter || null}::text is null or layer = ${options?.layerFilter || null})
        and (
          content ilike ${pattern}
          or title ilike ${pattern}
          or section ilike ${pattern}
          or source_file ilike ${pattern}
          or module ilike ${pattern}
        )
      limit ${KEYWORD_QUERY_LIMIT}
    `;

    for (const chunk of rows) {
      if (seen.has(chunk.id)) {
        continue;
      }

      seen.add(chunk.id);
      merged.push({
        ...chunk,
        similarity: 0,
      } as KnowledgeChunk);
    }
  }

  return merged
    .sort((left, right) => scoreKeywordChunk(right, keywords) - scoreKeywordChunk(left, keywords))
    .slice(0, options?.limit || KEYWORD_FALLBACK_COUNT);
}

/**
 * 合并多组召回结果并按 chunk id 去重。
 * 用于把普通向量召回和意图强制召回合并成最终候选上下文。
 */
function mergeChunks(groups: KnowledgeChunk[][]) {
  const merged: KnowledgeChunk[] = [];
  const seen = new Set<string>();

  for (const chunks of groups) {
    for (const chunk of chunks) {
      if (seen.has(chunk.id)) {
        continue;
      }

      seen.add(chunk.id);
      merged.push(chunk);
    }
  }

  return merged;
}

/**
 * AI 装修顾问的主检索入口。
 * 先做普通向量召回，再根据意图强制召回关键知识层级，最后必要时关键词兜底。
 */
export async function retrieveKnowledgeForQuestion(
  queryEmbedding: number[],
  intentProfile: IntentProfile,
): Promise<RetrievalResult> {
  // 正式上线第一版：普通向量召回保证相关性；意图策略保证关键规则和模板不漏。
  // 如果 embedding 还没补齐导致向量召回为空，则用关键词兜底，保证服务不中断。
  let baseChunks = await matchKnowledgeChunks(queryEmbedding, {
    matchCount: DEFAULT_MATCH_COUNT,
  });
  const baseVectorCount = baseChunks.length;
  let usedKeywordFallback = false;

  if (baseChunks.length === 0) {
    baseChunks = await matchKeywordKnowledgeChunks(intentProfile);
    usedKeywordFallback = baseChunks.length > 0;
  }

  const forcedGroups: KnowledgeChunk[][] = [];
  const forcedLayerStats: RetrievalStats["forcedLayers"] = [];

  for (const layer of intentProfile.forceLayers) {
    const layerChunks = await matchKnowledgeChunks(queryEmbedding, {
      matchCount: FORCED_MATCH_COUNT,
      layerFilter: layer,
    });
    let finalLayerChunks = layerChunks;
    let layerUsedKeywordFallback = false;

    if (finalLayerChunks.length === 0) {
      finalLayerChunks = await matchKeywordKnowledgeChunks(intentProfile, {
        limit: FORCED_MATCH_COUNT,
        layerFilter: layer,
      });
      layerUsedKeywordFallback = finalLayerChunks.length > 0;
    }

    forcedGroups.push(finalLayerChunks);
    forcedLayerStats.push({
      layer,
      vectorCount: layerChunks.length,
      usedKeywordFallback: layerUsedKeywordFallback,
      finalCount: finalLayerChunks.length,
    });
  }

  const mergedChunks = mergeChunks([baseChunks, ...forcedGroups]);

  return {
    chunks: mergedChunks,
    stats: {
      baseVectorCount,
      usedKeywordFallback,
      forcedLayers: forcedLayerStats,
      mergedCount: mergedChunks.length,
    },
  };
}

/**
 * 将召回结果整理成最终可进入 prompt 的 chunks 和可展示的 sources。
 * rawChunks 保留原始召回结果，便于后续调试召回质量。
 */
export function prepareRetrievedKnowledge(chunks: KnowledgeChunk[]) {
  // rawChunks：保留数据库原始召回结果，方便后续调试。
  // chunks：过滤后的结果，准备用来组装 prompt。
  // sources：给前端和接口响应展示的来源列表。
  const usefulChunks = chunks.filter(isUsefulChunk);

  return {
    rawChunks: chunks,
    chunks: usefulChunks,
    sources: dedupeSources(usefulChunks, DEFAULT_SOURCE_COUNT),
  };
}
