import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const postgres = require("../apps/web/node_modules/postgres");

const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const KNOWLEDGE_DIR = path.join(PROJECT_ROOT, "knowledge");
const ENV_FILE = path.join(PROJECT_ROOT, "apps", "web", ".env.local");
const MIN_CHUNK_CHARS = 80;
const MAX_CHUNK_CHARS = 1500;

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

function cleanNumberPrefix(value) {
  return value.replace(/^\d+[-_]/, "").trim();
}

function titleFromFilename(filePath) {
  return cleanNumberPrefix(path.basename(filePath, path.extname(filePath)));
}

function inferDocType(text) {
  const candidates = [
    "验收标准",
    "施工标准",
    "基础知识",
    "风险规则",
    "问答模板",
    "决策案例",
    "接口索引",
    "建设规范",
    "推进清单",
    "维权",
    "报价审核",
    "材料清单",
    "常见问题",
  ];
  return candidates.find((candidate) => text.includes(candidate)) ?? null;
}

function extractMetadata(filePath, markdown) {
  const relativePath = path.relative(PROJECT_ROOT, filePath);
  const parts = relativePath.split(path.sep);
  const layer = parts.length > 1 ? cleanNumberPrefix(parts[1]) : null;
  let module = parts.length > 2 && path.dirname(filePath) !== KNOWLEDGE_DIR ? cleanNumberPrefix(parts[2]) : null;
  if (!module) module = layer;

  const headingMatch = markdown.match(/^#\s+(.+)$/m);
  const title = headingMatch ? headingMatch[1].trim() : titleFromFilename(filePath);

  return {
    source_file: relativePath.split(path.sep).join("/"),
    layer,
    module,
    title,
    doc_type: inferDocType(`${title} ${path.basename(filePath)}`),
  };
}

function splitLongContent(content) {
  if (content.length <= MAX_CHUNK_CHARS) return [content];

  const pieces = [];
  let current = [];
  let currentLen = 0;

  for (const rawParagraph of content.split(/\n\s*\n/)) {
    const paragraph = rawParagraph.trim();
    if (!paragraph) continue;

    if (current.length && currentLen + paragraph.length > MAX_CHUNK_CHARS) {
      pieces.push(current.join("\n\n").trim());
      current = [];
      currentLen = 0;
    }

    if (paragraph.length > MAX_CHUNK_CHARS) {
      for (let start = 0; start < paragraph.length; start += MAX_CHUNK_CHARS) {
        pieces.push(paragraph.slice(start, start + MAX_CHUNK_CHARS).trim());
      }
    } else {
      current.push(paragraph);
      currentLen += paragraph.length;
    }
  }

  if (current.length) pieces.push(current.join("\n\n").trim());
  return pieces.filter(Boolean);
}

function chunkMarkdown(markdown, fallbackTitle) {
  const headingRe = /^(#{1,3})\s+(.+)$/gm;
  const matches = [...markdown.matchAll(headingRe)];

  if (!matches.length) {
    return splitLongContent(markdown.trim()).map((content, index) => ({
      title: fallbackTitle,
      section: fallbackTitle,
      content,
      chunk_index: index,
    }));
  }

  const rawSections = [];
  const headingStack = [];

  matches.forEach((match, index) => {
    const level = match[1].length;
    const heading = match[2].trim();
    const start = match.index + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : markdown.length;
    const body = markdown.slice(start, end).trim();

    while (headingStack.length && headingStack[headingStack.length - 1].level >= level) {
      headingStack.pop();
    }
    headingStack.push({ level, title: heading });

    rawSections.push({
      section: headingStack.map((item) => item.title).join(" > "),
      content: body ? `${heading}\n\n${body}`.trim() : heading,
    });
  });

  const mergedSections = [];
  for (const section of rawSections) {
    if (mergedSections.length && section.content.length < MIN_CHUNK_CHARS) {
      const previous = mergedSections[mergedSections.length - 1];
      previous.content = `${previous.content}\n\n${section.content}`.trim();
    } else {
      mergedSections.push({ ...section });
    }
  }

  const chunks = [];
  for (const section of mergedSections) {
    for (const piece of splitLongContent(section.content)) {
      chunks.push({
        title: fallbackTitle,
        section: section.section,
        content: piece,
        chunk_index: chunks.length,
      });
    }
  }
  return chunks;
}

function contentHash(markdown) {
  return crypto.createHash("sha256").update(markdown, "utf8").digest("hex");
}

function walkMarkdownFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkMarkdownFiles(fullPath));
    if (entry.isFile() && entry.name.endsWith(".md")) files.push(fullPath);
  }
  return files.sort();
}

async function main() {
  loadEnv(ENV_FILE);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("Missing DATABASE_URL in apps/web/.env.local");

  const dryRun = process.argv.includes("--dry-run");
  const sql = dryRun
    ? null
    : postgres(databaseUrl, {
        max: 5,
        idle_timeout: 20,
        connect_timeout: 10,
      });

  const files = walkMarkdownFiles(KNOWLEDGE_DIR);
  let importedDocuments = 0;
  let totalChunks = 0;

  console.log(`Found ${files.length} Markdown files under ${KNOWLEDGE_DIR}`);

  try {
    for (const [index, filePath] of files.entries()) {
      const markdown = fs.readFileSync(filePath, "utf8");
      const metadata = extractMetadata(filePath, markdown);
      const chunks = chunkMarkdown(markdown, metadata.title);

      if (sql) {
        const [document] = await sql`
          insert into public.knowledge_documents (
            title,
            source_file,
            layer,
            module,
            raw_markdown,
            content_hash,
            updated_at
          )
          values (
            ${metadata.title},
            ${metadata.source_file},
            ${metadata.layer},
            ${metadata.module},
            ${markdown},
            ${contentHash(markdown)},
            now()
          )
          on conflict (source_file)
          do update set
            title = excluded.title,
            layer = excluded.layer,
            module = excluded.module,
            raw_markdown = excluded.raw_markdown,
            content_hash = excluded.content_hash,
            updated_at = now()
          returning id
        `;

        await sql`
          delete from public.knowledge_chunks
          where document_id = ${document.id}
        `;

        if (chunks.length) {
          await sql.begin(async (tx) => {
            for (const chunk of chunks) {
              await tx`
                insert into public.knowledge_chunks (
                  document_id,
                  title,
                  section,
                  content,
                  source_file,
                  layer,
                  module,
                  doc_type,
                  chunk_index
                )
                values (
                  ${document.id},
                  ${metadata.title},
                  ${chunk.section},
                  ${chunk.content},
                  ${metadata.source_file},
                  ${metadata.layer},
                  ${metadata.module},
                  ${metadata.doc_type},
                  ${chunk.chunk_index}
                )
              `;
            }
          });
        }
      }

      importedDocuments += 1;
      totalChunks += chunks.length;
      console.log(`[${index + 1}/${files.length}] ${metadata.source_file} -> ${chunks.length} chunks`);
    }
  } finally {
    if (sql) await sql.end();
  }

  console.log(`Done. Imported ${importedDocuments} documents and wrote ${totalChunks} chunks.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
