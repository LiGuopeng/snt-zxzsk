import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const postgres = require("../apps/web/node_modules/postgres");

const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const ENV_FILE = path.join(PROJECT_ROOT, "apps", "web", ".env.local");
const DEFAULT_MODEL = "text-embedding-v4";
const DEFAULT_DIMENSION = 1536;
const DEFAULT_LIMIT = 100;
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_URL = "https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding";

function loadEnv(file) {
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

function getArg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function toVectorLiteral(values) {
  return `[${values.map((value) => Number(value).toFixed(8)).join(",")}]`;
}

function batched(items, batchSize) {
  const batches = [];
  for (let index = 0; index < items.length; index += batchSize) {
    batches.push(items.slice(index, index + batchSize));
  }
  return batches;
}

async function createEmbeddings({ apiKey, url, model, dimension, texts }) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: { texts },
      parameters: {
        text_type: "document",
        dimension,
        output_type: "dense",
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`DashScope embedding failed: ${response.status} ${await response.text()}`);
  }

  const payload = await response.json();
  return payload.output.embeddings
    .sort((a, b) => a.text_index - b.text_index)
    .map((item) => item.embedding);
}

async function main() {
  loadEnv(ENV_FILE);
  const databaseUrl = process.env.DATABASE_URL;
  const apiKey = process.env.DASHSCOPE_API_KEY;
  const model = process.env.EMBEDDING_MODEL || DEFAULT_MODEL;
  const dimension = Number(process.env.EMBEDDING_DIMENSION || DEFAULT_DIMENSION);
  const url = process.env.DASHSCOPE_EMBEDDINGS_URL || DEFAULT_URL;
  const limit = Number(getArg("--limit", DEFAULT_LIMIT));
  const batchSize = Number(getArg("--batch-size", DEFAULT_BATCH_SIZE));

  if (!databaseUrl) throw new Error("Missing DATABASE_URL in apps/web/.env.local");
  if (!apiKey) throw new Error("Missing DASHSCOPE_API_KEY in apps/web/.env.local");
  if (batchSize > 10) throw new Error("DashScope text embedding batch-size must be <= 10");

  const sql = postgres(databaseUrl, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
  });

  try {
    const [before] = await sql`
      select count(*)::int as count
      from public.knowledge_chunks
      where embedding is null
    `;
    const chunks = await sql`
      select id, content, source_file, chunk_index
      from public.knowledge_chunks
      where embedding is null
      order by source_file asc, chunk_index asc
      limit ${limit}
    `;

    console.log(`Embedding model: ${model}`);
    console.log(`Embedding dimension: ${dimension}`);
    console.log(`Chunks missing embedding before run: ${before.count}`);
    console.log(`Chunks selected this run: ${chunks.length}`);

    if (!chunks.length) {
      console.log("Nothing to do.");
      return;
    }

    let processed = 0;
    for (const batch of batched(chunks, batchSize)) {
      const embeddings = await createEmbeddings({
        apiKey,
        url,
        model,
        dimension,
        texts: batch.map((chunk) => chunk.content),
      });

      for (const [index, chunk] of batch.entries()) {
        await sql`
          update public.knowledge_chunks
          set embedding = ${toVectorLiteral(embeddings[index])}::vector
          where id = ${chunk.id}
        `;
        processed += 1;
        console.log(`[${processed}/${chunks.length}] embedded ${chunk.source_file}#${chunk.chunk_index}`);
      }
    }

    const [after] = await sql`
      select count(*)::int as count
      from public.knowledge_chunks
      where embedding is null
    `;
    console.log(`Done. Chunks missing embedding after run: ${after.count}`);
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
