from __future__ import annotations

# 这个脚本负责给 knowledge_chunks 生成 embedding。
#
# 当前 MVP 阶段：
# 1. 读取 embedding 为空的 chunks。
# 2. 调用阿里通义 DashScope text-embedding-v4。
# 3. 把生成的 1536 维向量写回 knowledge_chunks.embedding。
#
# 建议第一次运行时使用 --limit 小批量测试：
# python3 scripts/generate_embeddings.py --limit 5

import argparse
import os
import time
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parents[1]
WEB_ENV_FILE = PROJECT_ROOT / "apps" / "web" / ".env.local"
DEFAULT_MODEL = "text-embedding-v4"
DEFAULT_DIMENSION = 1536
DEFAULT_BATCH_SIZE = 50
DASHSCOPE_EMBEDDINGS_URL = (
    "https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding"
)


class SupabaseRestClient:
    """用于读取和更新 Supabase knowledge_chunks 的小型 REST 客户端。"""

    def __init__(self, url: str, key: str) -> None:
        self.rest_url = f"{url.rstrip('/')}/rest/v1"
        self.headers = {
            "apikey": key,
            "authorization": f"Bearer {key}",
            "content-type": "application/json",
        }
        self.client = httpx.Client(timeout=60, trust_env=False)

    def request_with_retry(self, method: str, url: str, **kwargs: object) -> httpx.Response:
        """执行 HTTP 请求，并对临时网络问题做简单重试。"""

        last_error: Exception | None = None
        for attempt in range(1, 7):
            try:
                response = self.client.request(method, url, **kwargs)
                response.raise_for_status()
                return response
            except (httpx.HTTPError, httpx.TimeoutException) as error:
                last_error = error
                self.client.close()
                self.client = httpx.Client(timeout=60, trust_env=False)
                if attempt == 6:
                    break
                wait_seconds = min(attempt * 3, 15)
                print(
                    f"Supabase request failed, retrying in {wait_seconds}s "
                    f"({attempt}/6): {error}",
                    flush=True,
                )
                time.sleep(wait_seconds)

        raise RuntimeError(f"Supabase request failed after retries: {last_error}")

    def fetch_chunks_without_embedding(self, limit: int) -> list[dict[str, Any]]:
        """读取 embedding 为空的 chunks。

        只取 id、content、source_file、chunk_index，避免拉取不必要字段。
        """

        response = self.request_with_retry(
            "GET",
            f"{self.rest_url}/knowledge_chunks",
            params={
                "select": "id,content,source_file,chunk_index",
                "embedding": "is.null",
                "order": "source_file.asc,chunk_index.asc",
                "limit": str(limit),
            },
            headers=self.headers,
        )
        return list(response.json())

    def update_chunk_embedding(self, chunk_id: str, embedding: list[float]) -> None:
        """把一个 chunk 的 embedding 写回数据库。"""

        self.request_with_retry(
            "PATCH",
            f"{self.rest_url}/knowledge_chunks",
            params={"id": f"eq.{chunk_id}"},
            headers={
                **self.headers,
                "prefer": "return=minimal",
            },
            json={"embedding": embedding},
        )

    def count_missing_embeddings(self) -> int:
        """统计还有多少 chunks 没有 embedding。"""

        response = self.request_with_retry(
            "GET",
            f"{self.rest_url}/knowledge_chunks",
            params={"select": "id", "embedding": "is.null"},
            headers={**self.headers, "prefer": "count=exact"},
        )
        content_range = response.headers.get("content-range", "0-0/0")
        return int(content_range.rsplit("/", 1)[-1])


class DashScopeEmbeddingClient:
    """阿里通义 DashScope embedding 客户端。

    当前使用 text-embedding-v4，并显式指定 1536 维。
    这样可以继续使用 Supabase 里的 embedding vector(1536) 字段。
    """

    def __init__(self, api_key: str, model: str, dimension: int) -> None:
        self.api_key = api_key
        self.model = model
        self.dimension = dimension
        self.client = httpx.Client(timeout=60, trust_env=False)

    def create_embeddings(self, texts: list[str]) -> list[list[float]]:
        """调用 DashScope，把文本列表转成向量列表。

        DashScope 文本向量 API 的批量大小上限是 10。
        脚本会在 main 中把 batch-size 限制到 10 以内。
        """

        response = self.client.post(
            DASHSCOPE_EMBEDDINGS_URL,
            headers={
                "authorization": f"Bearer {self.api_key}",
                "content-type": "application/json",
            },
            json={
                "model": self.model,
                "input": {
                    "texts": texts,
                },
                "parameters": {
                    "text_type": "document",
                    "dimension": self.dimension,
                    "output_type": "dense",
                },
            },
        )
        response.raise_for_status()
        payload = response.json()
        embeddings = payload["output"]["embeddings"]
        embeddings = sorted(embeddings, key=lambda item: item["text_index"])
        return [item["embedding"] for item in embeddings]


def load_config() -> tuple[SupabaseRestClient, DashScopeEmbeddingClient, str, int]:
    """读取环境变量并创建 Supabase/DashScope 客户端。"""

    load_dotenv(WEB_ENV_FILE)

    supabase_url = os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
    supabase_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    dashscope_key = os.environ.get("DASHSCOPE_API_KEY")
    model = os.environ.get("EMBEDDING_MODEL") or DEFAULT_MODEL
    dimension = int(os.environ.get("EMBEDDING_DIMENSION") or DEFAULT_DIMENSION)

    if not supabase_url or not supabase_key:
        raise RuntimeError("Missing Supabase env. Check apps/web/.env.local")

    if not dashscope_key:
        raise RuntimeError("Missing DASHSCOPE_API_KEY. Fill it in apps/web/.env.local")

    return (
        SupabaseRestClient(supabase_url, supabase_key),
        DashScopeEmbeddingClient(dashscope_key, model, dimension),
        model,
        dimension,
    )


def batched(items: list[dict[str, Any]], batch_size: int) -> list[list[dict[str, Any]]]:
    """把 chunks 分成多个批次，减少 API 调用次数。"""

    return [items[index : index + batch_size] for index in range(0, len(items), batch_size)]


def main() -> None:
    """脚本入口。

    常用命令：

    python3 scripts/generate_embeddings.py --limit 5
      只处理 5 条，用于小批量测试。

    python3 scripts/generate_embeddings.py
      默认处理 50 条。

    python3 scripts/generate_embeddings.py --limit 500 --batch-size 10
      处理 500 条，每 10 条调用一次 embedding API。
    """

    parser = argparse.ArgumentParser(description="Generate embeddings for knowledge_chunks.")
    parser.add_argument("--limit", type=int, default=DEFAULT_BATCH_SIZE)
    parser.add_argument("--batch-size", type=int, default=10)
    args = parser.parse_args()

    if args.batch_size > 10:
        raise RuntimeError("DashScope text embedding batch-size must be <= 10")

    supabase, embedding_client, model, dimension = load_config()
    missing_before = supabase.count_missing_embeddings()
    chunks = supabase.fetch_chunks_without_embedding(args.limit)

    print(f"Embedding model: {model}", flush=True)
    print(f"Embedding dimension: {dimension}", flush=True)
    print(f"Chunks missing embedding before run: {missing_before}", flush=True)
    print(f"Chunks selected this run: {len(chunks)}", flush=True)

    if not chunks:
        print("Nothing to do.", flush=True)
        return

    processed = 0
    for batch in batched(chunks, args.batch_size):
        texts = [item["content"] for item in batch]
        embeddings = embedding_client.create_embeddings(texts)

        for chunk, embedding in zip(batch, embeddings):
            supabase.update_chunk_embedding(chunk["id"], embedding)
            processed += 1
            print(
                f"[{processed}/{len(chunks)}] embedded "
                f"{chunk['source_file']}#{chunk['chunk_index']}",
                flush=True,
            )

    missing_after = supabase.count_missing_embeddings()
    print(f"Done. Chunks missing embedding after run: {missing_after}", flush=True)


if __name__ == "__main__":
    main()
