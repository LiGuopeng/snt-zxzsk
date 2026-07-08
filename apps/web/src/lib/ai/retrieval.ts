import { createSupabaseAdminClient } from "@/lib/supabase/server";

import type { IntentProfile } from "@/lib/ai/intent";

export type KnowledgeChunk = {
  id: string;
  document_id: string;
  title: string | null;
  section: string | null;
  content: string;
  source_file: string;
  layer: string | null;
  module: string | null;
  doc_type: string | null;
  stage: string | null;
  risk_level: string | null;
  keywords: string[];
  similarity: number;
};

export type KnowledgeSource = {
  source_file: string;
  section: string | null;
  layer: string | null;
  module: string | null;
  similarity: number;
};

export type RetrievalStats = {
  baseVectorCount: number;
  usedKeywordFallback: boolean;
  forcedLayers: Array<{
    layer: string;
    vectorCount: number;
    usedKeywordFallback: boolean;
    finalCount: number;
  }>;
  mergedCount: number;
};

export type RetrievalResult = {
  chunks: KnowledgeChunk[];
  stats: RetrievalStats;
};

const DEFAULT_MATCH_COUNT = 8;
const DEFAULT_SOURCE_COUNT = 6;
const FORCED_MATCH_COUNT = 4;
const MIN_CONTENT_CHARS = 30;
const KEYWORD_FALLBACK_COUNT = 12;
const KEYWORD_QUERY_LIMIT = 50;

function isUsefulChunk(chunk: KnowledgeChunk) {
  // 第一版先做一个很朴素的质量过滤：
  // 有些 chunk 只有标题，例如“水电增项风险”，这类内容对最终回答帮助不大。
  // 后续可以升级成更细的 chunk 质量评分或 rerank。
  return chunk.content.trim().length >= MIN_CONTENT_CHARS;
}

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

export async function matchKnowledgeChunks(
  queryEmbedding: number[],
  options?: {
    matchCount?: number;
    layerFilter?: string | null;
  },
) {
  // 这里调用 infra/supabase/schema.sql 里已经创建好的 RPC：
  // public.match_knowledge_chunks(query_embedding, match_count, layer_filter)
  //
  // 它会在 Supabase pgvector 中按 cosine similarity 找最相关的知识片段。
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc("match_knowledge_chunks", {
    query_embedding: queryEmbedding,
    match_count: options?.matchCount || DEFAULT_MATCH_COUNT,
    layer_filter: options?.layerFilter || null,
  });

  if (error) {
    throw new Error(`Failed to match knowledge chunks: ${error.message}`);
  }

  return (data || []) as KnowledgeChunk[];
}

function escapeIlikeValue(value: string) {
  // Supabase PostgREST 的 ilike 过滤里会用到用户问题派生出的关键词。
  // 这里做最小转义，避免逗号、百分号等字符影响查询语法。
  return value.replace(/[%_,]/g, "").trim();
}

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

async function matchKeywordKnowledgeChunks(
  intentProfile: IntentProfile,
  options?: {
    limit?: number;
    layerFilter?: string | null;
  },
) {
  const supabase = createSupabaseAdminClient();
  const keywords = intentProfile.fallbackKeywords.map(escapeIlikeValue).filter(Boolean);
  const merged: KnowledgeChunk[] = [];
  const seen = new Set<string>();

  for (const keyword of keywords) {
    let query = supabase
      .from("knowledge_chunks")
      .select(
        "id,document_id,title,section,content,source_file,layer,module,doc_type,stage,risk_level,keywords",
      )
      .or(
        `content.ilike.%${keyword}%,title.ilike.%${keyword}%,section.ilike.%${keyword}%,source_file.ilike.%${keyword}%,module.ilike.%${keyword}%`,
      )
      .limit(KEYWORD_QUERY_LIMIT);

    if (options?.layerFilter) {
      query = query.eq("layer", options.layerFilter);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to keyword match knowledge chunks: ${error.message}`);
    }

    for (const chunk of data || []) {
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
