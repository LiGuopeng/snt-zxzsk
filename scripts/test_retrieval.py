from __future__ import annotations

# 这个脚本用于测试“语义检索”是否可用。
#
# 它解决的问题是：
# 用户随便输入一句装修问题后，系统能不能从 Supabase 的 knowledge_chunks
# 里找出最相关的知识片段。
#
# 注意：
# 这个脚本还不是最终问答 Agent。
# 它只负责“找资料”，不负责“组织最终答案”。
#
# 常用运行方式：
# python3 scripts/test_retrieval.py "水电增项 8000 是不是被坑了？"
# python3 scripts/test_retrieval.py "卫生间门口地板发黑是不是漏水？" --top-k 8

import argparse
import os
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parents[1]
WEB_ENV_FILE = PROJECT_ROOT / "apps" / "web" / ".env.local"

DEFAULT_MODEL = "text-embedding-v4"
DEFAULT_DIMENSION = 1536
DASHSCOPE_EMBEDDINGS_URL = (
    "https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding"
)


class SupabaseRpcClient:
    """调用 Supabase RPC 的小型客户端。

    这里直接使用 Supabase REST API：
    POST /rest/v1/rpc/match_knowledge_chunks

    原因：
    1. 当前项目 Python 脚本已经采用 REST API。
    2. 不额外引入 supabase-py，减少环境复杂度。
    3. 对新手更直观：本质就是一次 HTTP 请求。
    """

    def __init__(self, url: str, key: str) -> None:
        self.rest_url = f"{url.rstrip('/')}/rest/v1"
        self.headers = {
            "apikey": key,
            "authorization": f"Bearer {key}",
            "content-type": "application/json",
        }
        # trust_env=False：不读取系统代理环境变量。
        # 之前生成 embedding 时遇到过代理导致的 Connection reset，
        # 所以这里也保持同样设置。
        self.client = httpx.Client(timeout=60, trust_env=False)

    def match_chunks(
        self,
        query_embedding: list[float],
        match_count: int,
        layer_filter: str | None = None,
    ) -> list[dict[str, Any]]:
        """调用 match_knowledge_chunks，返回最相似的知识片段。

        query_embedding：
        用户问题转成的 1536 维向量。

        match_count：
        希望返回多少条结果，例如 5 或 8。

        layer_filter：
        可选，只检索某一层知识库。
        例如只检索“标准知识库”。
        第一版通常不传，让系统在 5 块知识库里一起找。
        """

        response = self.client.post(
            f"{self.rest_url}/rpc/match_knowledge_chunks",
            headers=self.headers,
            json={
                "query_embedding": query_embedding,
                "match_count": match_count,
                "layer_filter": layer_filter,
            },
        )
        response.raise_for_status()
        return list(response.json())


class DashScopeEmbeddingClient:
    """阿里通义 DashScope embedding 客户端。

    生成知识库 embedding 时，document 使用 text_type=document。
    现在用户问题是检索查询，所以使用 text_type=query。
    这样更符合 embedding 模型的设计。
    """

    def __init__(self, api_key: str, model: str, dimension: int) -> None:
        self.api_key = api_key
        self.model = model
        self.dimension = dimension
        self.client = httpx.Client(timeout=60, trust_env=False)

    def create_query_embedding(self, question: str) -> list[float]:
        """把用户问题转成 query embedding。"""

        response = self.client.post(
            DASHSCOPE_EMBEDDINGS_URL,
            headers={
                "authorization": f"Bearer {self.api_key}",
                "content-type": "application/json",
            },
            json={
                "model": self.model,
                "input": {
                    "texts": [question],
                },
                "parameters": {
                    "text_type": "query",
                    "dimension": self.dimension,
                    "output_type": "dense",
                },
            },
        )
        response.raise_for_status()
        payload = response.json()
        return payload["output"]["embeddings"][0]["embedding"]


def load_config() -> tuple[SupabaseRpcClient, DashScopeEmbeddingClient, str, int]:
    """读取 apps/web/.env.local，创建 Supabase 和 DashScope 客户端。"""

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
        SupabaseRpcClient(supabase_url, supabase_key),
        DashScopeEmbeddingClient(dashscope_key, model, dimension),
        model,
        dimension,
    )


def compact_text(value: str, max_chars: int = 220) -> str:
    """把 chunk 内容压缩成单行，方便在终端查看。"""

    text = " ".join(value.split())
    if len(text) <= max_chars:
        return text
    return f"{text[:max_chars]}..."


def print_results(question: str, results: list[dict[str, Any]]) -> None:
    """把检索结果打印成适合人工检查的格式。"""

    print()
    print(f"Question: {question}")
    print(f"Matched chunks: {len(results)}")
    print()

    if not results:
        print("No results.")
        return

    for index, item in enumerate(results, start=1):
        similarity = item.get("similarity")
        similarity_text = f"{similarity:.4f}" if isinstance(similarity, (int, float)) else "unknown"

        print(f"[{index}] similarity={similarity_text}")
        print(f"    source_file: {item.get('source_file')}")
        print(f"    layer: {item.get('layer')}")
        print(f"    module: {item.get('module')}")
        print(f"    section: {item.get('section')}")
        print(f"    doc_type: {item.get('doc_type')}")
        print(f"    risk_level: {item.get('risk_level')}")
        print(f"    content: {compact_text(item.get('content') or '')}")
        print()


def main() -> None:
    """脚本入口。"""

    parser = argparse.ArgumentParser(description="Test semantic retrieval from Supabase.")
    parser.add_argument("question", help="用户输入的装修问题")
    parser.add_argument("--top-k", type=int, default=8, help="返回多少条相关知识片段")
    parser.add_argument("--layer", default=None, help="可选，只检索某个 layer")
    args = parser.parse_args()

    supabase, embedding_client, model, dimension = load_config()

    print(f"Embedding model: {model}", flush=True)
    print(f"Embedding dimension: {dimension}", flush=True)
    print("Generating query embedding...", flush=True)
    query_embedding = embedding_client.create_query_embedding(args.question)

    print("Searching knowledge chunks...", flush=True)
    results = supabase.match_chunks(
        query_embedding=query_embedding,
        match_count=args.top_k,
        layer_filter=args.layer,
    )

    print_results(args.question, results)


if __name__ == "__main__":
    main()
