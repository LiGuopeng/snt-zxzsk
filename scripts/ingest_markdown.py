from __future__ import annotations

# 这个脚本负责把 knowledge/ 目录里的 Markdown 知识库导入 Supabase。
#
# 当前 MVP 阶段只做两件事：
# 1. 把整篇 Markdown 写入 knowledge_documents。
# 2. 把 Markdown 按标题切成 chunk 后写入 knowledge_chunks。
#
# 当前暂不生成 embedding，所以导入后还不能做真正的向量检索。
# 后面会单独增加 embedding 脚本或在本脚本里追加 embedding 步骤。

import hashlib
import argparse
import os
import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import httpx
from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parents[1]
KNOWLEDGE_DIR = PROJECT_ROOT / "knowledge"
WEB_ENV_FILE = PROJECT_ROOT / "apps" / "web" / ".env.local"

# chunk 的长度规则。
# 少于 MIN_CHUNK_CHARS 的片段会尽量合并到上一个 chunk。
# 超过 MAX_CHUNK_CHARS 的片段会继续按段落拆开。
MIN_CHUNK_CHARS = 80
MAX_CHUNK_CHARS = 1500


@dataclass
class Chunk:
    """一个可入库的知识片段。

    title：文档标题。
    section：当前片段所在的标题路径，例如「水电验收标准 > 强电验收」。
    content：真正要给 AI 检索和阅读的正文。
    chunk_index：当前文件里的第几个 chunk，从 0 开始。
    """

    title: str
    section: str
    content: str
    chunk_index: int


class SupabaseRestClient:
    """一个很小的 Supabase REST 客户端。

    为什么不用 supabase-py SDK：
    当前项目拿到的是 Supabase 新格式密钥，例如 sb_secret_...。
    当前本机安装的 supabase-py 对这种 key 会报 Invalid API key。

    Next.js 端的 @supabase/supabase-js 已经验证可连接。
    Python 入库脚本这里直接调用 Supabase REST API，更直观，也更容易解释。
    """

    def __init__(self, url: str, key: str) -> None:
        self.rest_url = f"{url.rstrip('/')}/rest/v1"
        self.headers = {
            "apikey": key,
            "authorization": f"Bearer {key}",
            "content-type": "application/json",
        }
        self.client = httpx.Client(timeout=30)

    def request_with_retry(self, method: str, url: str, **kwargs: object) -> httpx.Response:
        """执行 HTTP 请求，并对临时网络问题做简单重试。

        MVP 阶段不引入复杂任务队列。
        这里做 3 次重试，能处理偶发的 TLS 握手慢、连接超时等问题。
        """

        last_error: Exception | None = None
        for attempt in range(1, 4):
            try:
                response = self.client.request(method, url, **kwargs)
                response.raise_for_status()
                return response
            except (httpx.HTTPError, httpx.TimeoutException) as error:
                last_error = error
                if attempt == 3:
                    break
                wait_seconds = attempt * 2
                print(
                    f"Request failed, retrying in {wait_seconds}s "
                    f"({attempt}/3): {error}",
                    flush=True,
                )
                time.sleep(wait_seconds)

        raise RuntimeError(f"Supabase request failed after retries: {last_error}")

    def upsert_document(self, payload: dict[str, object]) -> dict[str, object]:
        """按 source_file upsert document，并返回写入后的记录。"""

        response = self.request_with_retry(
            "POST",
            f"{self.rest_url}/knowledge_documents",
            params={"on_conflict": "source_file"},
            headers={
                **self.headers,
                "prefer": "resolution=merge-duplicates,return=representation",
            },
            json=payload,
        )
        data = response.json()
        if not data:
            raise RuntimeError(f"Failed to upsert document: {payload.get('source_file')}")
        return data[0]

    def delete_chunks(self, document_id: str) -> None:
        """删除某篇文档旧的 chunks。"""

        self.request_with_retry(
            "DELETE",
            f"{self.rest_url}/knowledge_chunks",
            params={"document_id": f"eq.{document_id}"},
            headers=self.headers,
        )

    def insert_chunks(self, rows: list[dict[str, object]]) -> None:
        """批量插入新的 chunks。"""

        self.request_with_retry(
            "POST",
            f"{self.rest_url}/knowledge_chunks",
            headers={
                **self.headers,
                "prefer": "return=minimal",
            },
            json=rows,
        )

    def fetch_document_hashes(self) -> dict[str, str]:
        """读取数据库里已有文档的 content_hash。

        用途：
        --changed-only 模式下，脚本会比较本地 Markdown hash 和数据库 hash。
        如果完全一致，就跳过这个文件，避免重复删除 chunks、重复生成 embedding。
        """

        response = self.request_with_retry(
            "GET",
            f"{self.rest_url}/knowledge_documents",
            params={"select": "source_file,content_hash"},
            headers=self.headers,
        )
        rows = response.json()
        return {
            str(row["source_file"]): str(row.get("content_hash") or "")
            for row in rows
            if row.get("source_file")
        }


def clean_number_prefix(value: str) -> str:
    """去掉目录或文件名前面的编号。

    例如：
    01_标准知识库 -> 标准知识库
    03_水电工程 -> 水电工程
    03-12-水电验收标准 -> 水电验收标准
    """

    value = re.sub(r"^\d+[-_]", "", value)
    return value.strip()


def title_from_filename(path: Path) -> str:
    """当 Markdown 里没有一级标题时，用文件名生成标题。"""

    return clean_number_prefix(path.stem)


def infer_doc_type(text: str) -> str | None:
    """根据文件名和标题里的关键词，粗略判断文档类型。

    第一版不用大模型做分类，避免不稳定和额外成本。
    后期如果需要更准确，可以加人工标签或后台编辑。
    """

    candidates = [
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
    ]
    for candidate in candidates:
        if candidate in text:
            return candidate
    return None


def extract_metadata(path: Path, markdown: str) -> dict[str, str | None]:
    """从文件路径、文件名和 Markdown 标题里提取 metadata。

    metadata 是知识片段的标签，用于后续检索过滤和回答引用。

    示例路径：
    knowledge/01_标准知识库/03_水电工程/03-12-水电验收标准.md

    会提取出：
    layer = 标准知识库
    module = 水电工程
    title = 水电验收标准
    source_file = knowledge/01_标准知识库/03_水电工程/03-12-水电验收标准.md
    """

    relative_path = path.relative_to(PROJECT_ROOT)
    parts = relative_path.parts

    layer = clean_number_prefix(parts[1]) if len(parts) > 1 else None
    module = clean_number_prefix(parts[2]) if len(parts) > 2 and path.parent != KNOWLEDGE_DIR else None
    if not module:
        module = layer

    heading_match = re.search(r"^#\s+(.+)$", markdown, flags=re.MULTILINE)
    title = heading_match.group(1).strip() if heading_match else title_from_filename(path)
    doc_type = infer_doc_type(f"{title} {path.name}")

    return {
        "source_file": str(relative_path),
        "layer": layer,
        "module": module,
        "title": title,
        "doc_type": doc_type,
    }


def split_long_content(content: str) -> list[str]:
    """把过长的内容继续按段落拆开。

    为什么需要这个函数：
    如果一个标题下面内容特别长，直接作为一个 chunk 会影响检索精度。
    这里优先按空行拆，尽量不破坏原本的段落语义。
    """

    if len(content) <= MAX_CHUNK_CHARS:
        return [content]

    pieces: list[str] = []
    current: list[str] = []
    current_len = 0

    for paragraph in re.split(r"\n\s*\n", content):
        paragraph = paragraph.strip()
        if not paragraph:
            continue

        paragraph_len = len(paragraph)
        if current and current_len + paragraph_len > MAX_CHUNK_CHARS:
            pieces.append("\n\n".join(current).strip())
            current = []
            current_len = 0

        if paragraph_len > MAX_CHUNK_CHARS:
            for start in range(0, paragraph_len, MAX_CHUNK_CHARS):
                pieces.append(paragraph[start : start + MAX_CHUNK_CHARS].strip())
        else:
            current.append(paragraph)
            current_len += paragraph_len

    if current:
        pieces.append("\n\n".join(current).strip())

    return [piece for piece in pieces if piece]


def chunk_markdown(markdown: str, fallback_title: str) -> list[Chunk]:
    """把 Markdown 切成多个 chunk。

    当前切片策略：
    1. 优先按 #、##、### 标题切。
    2. 太短的 chunk 合并到上一个 chunk。
    3. 太长的 chunk 按段落继续拆。

    fallback_title 是兜底标题：
    如果文件里没有可用标题，就用文件名生成的标题。
    """

    heading_re = re.compile(r"^(#{1,3})\s+(.+)$", flags=re.MULTILINE)
    matches = list(heading_re.finditer(markdown))

    if not matches:
        contents = split_long_content(markdown.strip())
        return [
            Chunk(
                title=fallback_title,
                section=fallback_title,
                content=content,
                chunk_index=index,
            )
            for index, content in enumerate(contents)
        ]

    raw_sections: list[tuple[str, str]] = []
    heading_stack: list[tuple[int, str]] = []

    for index, match in enumerate(matches):
        level = len(match.group(1))
        heading = match.group(2).strip()
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(markdown)
        body = markdown[start:end].strip()

        heading_stack = [(item_level, item_title) for item_level, item_title in heading_stack if item_level < level]
        heading_stack.append((level, heading))
        section = " > ".join(item_title for _, item_title in heading_stack)

        content = f"{heading}\n\n{body}".strip() if body else heading
        raw_sections.append((section, content))

    merged_sections: list[tuple[str, str]] = []
    for section, content in raw_sections:
        if merged_sections and len(content) < MIN_CHUNK_CHARS:
            previous_section, previous_content = merged_sections[-1]
            merged_sections[-1] = (
                previous_section,
                f"{previous_content}\n\n{content}".strip(),
            )
        else:
            merged_sections.append((section, content))

    chunks: list[Chunk] = []
    for section, content in merged_sections:
        for piece in split_long_content(content):
            chunks.append(
                Chunk(
                    title=fallback_title,
                    section=section,
                    content=piece,
                    chunk_index=len(chunks),
                )
            )

    return chunks


def content_hash(markdown: str) -> str:
    """计算 Markdown 内容的 hash。

    当前 MVP 只是存起来，后期可用于判断文件有没有变化。
    """

    return hashlib.sha256(markdown.encode("utf-8")).hexdigest()


def load_supabase() -> SupabaseRestClient:
    """读取 apps/web/.env.local 并创建 Supabase 客户端。

    这里使用 SUPABASE_SERVICE_ROLE_KEY，因为入库脚本需要写入数据库。
    注意：service role key 权限很高，不能放到浏览器端。
    """

    load_dotenv(WEB_ENV_FILE)
    url = os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise RuntimeError("Missing Supabase env. Check apps/web/.env.local")
    return SupabaseRestClient(url, key)


def upsert_document(
    supabase: SupabaseRestClient,
    metadata: dict[str, str | None],
    markdown: str,
) -> str:
    """写入或更新 knowledge_documents。

    这里使用 source_file 作为唯一标识：
    - 第一次入库：新增 document。
    - 再次入库：更新同一个 document。
    """

    now = datetime.now(timezone.utc).isoformat()
    payload = {
        "title": metadata["title"],
        "source_file": metadata["source_file"],
        "layer": metadata["layer"],
        "module": metadata["module"],
        "raw_markdown": markdown,
        "content_hash": content_hash(markdown),
        "updated_at": now,
    }
    data = supabase.upsert_document(payload)
    return str(data["id"])


def replace_chunks(
    supabase: SupabaseRestClient,
    document_id: str,
    metadata: dict[str, str | None],
    chunks: list[Chunk],
) -> None:
    """替换某篇文档下的所有 chunks。

    当前 MVP 的入库策略是覆盖更新：
    1. 删除这个 document 旧的 chunks。
    2. 插入最新切出来的 chunks。

    这样可以避免旧知识残留。
    """

    supabase.delete_chunks(document_id)

    if not chunks:
        return

    rows = [
        {
            "document_id": document_id,
            "title": metadata["title"],
            "section": chunk.section,
            "content": chunk.content,
            "source_file": metadata["source_file"],
            "layer": metadata["layer"],
            "module": metadata["module"],
            "doc_type": metadata["doc_type"],
            "chunk_index": chunk.chunk_index,
        }
        for chunk in chunks
    ]

    supabase.insert_chunks(rows)


def iter_markdown_files() -> list[Path]:
    """扫描 knowledge/ 目录下的所有 Markdown 文件。"""

    return sorted(KNOWLEDGE_DIR.rglob("*.md"))


def normalize_source_file(value: str) -> str:
    """把用户输入的文件路径统一成 knowledge/... 格式。"""

    path = Path(value)
    if path.is_absolute():
        return str(path.relative_to(PROJECT_ROOT))
    return str(path)


def filter_markdown_files(files: list[Path], source_files: list[str]) -> list[Path]:
    """根据 --source-file 过滤需要同步的 Markdown 文件。"""

    if not source_files:
        return files

    wanted = {normalize_source_file(item) for item in source_files}
    filtered = [path for path in files if str(path.relative_to(PROJECT_ROOT)) in wanted]
    missing = sorted(wanted - {str(path.relative_to(PROJECT_ROOT)) for path in filtered})

    if missing:
        raise RuntimeError(f"Source files not found: {', '.join(missing)}")

    return filtered


def main() -> None:
    """脚本入口。

    常用命令：
    python3 scripts/ingest_markdown.py --dry-run
      只扫描和切片，不写数据库。

    python3 scripts/ingest_markdown.py
      真正写入 Supabase。
    """

    parser = argparse.ArgumentParser(description="Ingest Markdown knowledge files into Supabase.")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Scan and chunk Markdown files without writing to Supabase.",
    )
    parser.add_argument(
        "--changed-only",
        action="store_true",
        help="Only ingest Markdown files whose content_hash changed.",
    )
    parser.add_argument(
        "--source-file",
        action="append",
        default=[],
        help="Only ingest a specific knowledge/... Markdown file. Can be repeated.",
    )
    args = parser.parse_args()

    if not KNOWLEDGE_DIR.exists():
        raise RuntimeError(f"Knowledge directory not found: {KNOWLEDGE_DIR}")

    supabase = None if args.dry_run else load_supabase()
    existing_hashes = supabase.fetch_document_hashes() if supabase and args.changed_only else {}
    files = filter_markdown_files(iter_markdown_files(), args.source_file)
    total_chunks = 0
    imported_documents = 0
    skipped_documents = 0

    print(f"Found {len(files)} Markdown files under {KNOWLEDGE_DIR}", flush=True)

    for index, path in enumerate(files, start=1):
        markdown = path.read_text(encoding="utf-8")
        metadata = extract_metadata(path, markdown)
        markdown_hash = content_hash(markdown)
        source_file = str(metadata["source_file"])

        if args.changed_only and existing_hashes.get(source_file) == markdown_hash:
            skipped_documents += 1
            print(
                f"[{index}/{len(files)}] {source_file} -> skipped unchanged",
                flush=True,
            )
            continue

        chunks = chunk_markdown(markdown, str(metadata["title"]))
        if supabase:
            document_id = upsert_document(supabase, metadata, markdown)
            replace_chunks(supabase, document_id, metadata, chunks)
        imported_documents += 1
        total_chunks += len(chunks)

        print(
            f"[{index}/{len(files)}] {metadata['source_file']} "
            f"-> {len(chunks)} chunks",
            flush=True,
        )

    print(
        f"Done. Imported {imported_documents} documents, skipped {skipped_documents}, "
        f"and wrote {total_chunks} chunks.",
        flush=True,
    )


if __name__ == "__main__":
    main()
