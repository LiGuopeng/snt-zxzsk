from __future__ import annotations

# 知识库同步总控脚本。
#
# 你之前需要记住多条命令：
# 1. python3 scripts/ingest_markdown.py --dry-run
# 2. python3 scripts/ingest_markdown.py
# 3. python3 scripts/generate_embeddings.py --limit 100 --batch-size 10
# 4. 重复第 3 步，直到 missing embedding = 0
#
# 这个脚本把这些步骤串起来，减少人工漏步骤的概率。
# 默认采用“改谁同步谁”的增量模式：
# 1. 用 content_hash 判断 Markdown 是否变化。
# 2. 只重建变化文件的 chunks。
# 3. 只给新生成、embedding 为空的 chunks 补 embedding。
# 正式上线前，知识库更新应该以这个脚本为主入口。

import argparse
import subprocess
import sys
import time
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_EMBEDDING_LIMIT = 100
DEFAULT_EMBEDDING_BATCH_SIZE = 10
DEFAULT_MAX_EMBEDDING_ROUNDS = 100


def run_command(command: list[str]) -> str:
    """执行一个子命令，并把输出实时打印出来。

    为什么不直接 import ingest_markdown.py / generate_embeddings.py：
    当前两个脚本已经各自有清晰的命令行入口和异常处理。
    总控脚本只负责编排流程，这样后期某一步替换实现时，不会互相牵连。
    """

    print("", flush=True)
    print(f"$ {' '.join(command)}", flush=True)
    process = subprocess.Popen(
        command,
        cwd=PROJECT_ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    output_lines: list[str] = []
    assert process.stdout is not None

    for line in process.stdout:
        print(line, end="", flush=True)
        output_lines.append(line)

    return_code = process.wait()
    output = "".join(output_lines)

    if return_code != 0:
        raise RuntimeError(f"Command failed with exit code {return_code}: {' '.join(command)}")

    return output


def get_git_changed_knowledge_files() -> list[str]:
    """读取 Git 当前变更里的 knowledge/*.md 文件。

    用途：
    python3 scripts/sync_knowledge.py --git-changed

    这样你修改了哪几个 Markdown，脚本就只同步哪几个。
    """

    output = run_command(["git", "status", "--short", "--", "knowledge"])
    files: list[str] = []

    for line in output.splitlines():
        if not line.strip():
            continue

        # git status --short 格式示例：
        # M  knowledge/xxx.md
        # ?? knowledge/xxx.md
        # R  old.md -> knowledge/new.md
        path = line[3:].strip()
        if " -> " in path:
            path = path.rsplit(" -> ", 1)[-1].strip()

        if path.startswith("knowledge/") and path.endswith(".md"):
            files.append(path)

    return sorted(set(files))


def parse_missing_embedding_count(output: str) -> int | None:
    """从 generate_embeddings.py 输出中提取剩余缺失 embedding 数量。

    目标输出示例：
    Done. Chunks missing embedding after run: 3648
    或：
    Chunks missing embedding before run: 0
    """

    for line in reversed(output.splitlines()):
        if "Chunks missing embedding after run:" in line:
            return int(line.rsplit(":", 1)[-1].strip())
        if "Chunks missing embedding before run:" in line:
            return int(line.rsplit(":", 1)[-1].strip())
    return None


def build_ingest_command(
    *,
    dry_run: bool,
    changed_only: bool,
    source_files: list[str],
) -> list[str]:
    command = ["python3", "scripts/ingest_markdown.py"]

    if dry_run:
      command.append("--dry-run")

    if changed_only and not dry_run:
        command.append("--changed-only")

    for source_file in source_files:
        command.extend(["--source-file", source_file])

    return command


def run_dry_run(source_files: list[str]) -> None:
    """第一步：只预览 Markdown 扫描和切片结果，不写数据库。"""

    print("Step 1/4: dry-run scan and chunk Markdown files.", flush=True)
    run_command(
        build_ingest_command(
            dry_run=True,
            changed_only=False,
            source_files=source_files,
        )
    )


def run_ingest(changed_only: bool, source_files: list[str]) -> None:
    """第二步：正式入库，写入 knowledge_documents 和 knowledge_chunks。

    changed_only=True 时，只同步 content_hash 变化过的文件。
    """

    mode = "changed files only" if changed_only else "all files"
    print(f"Step 2/4: ingest Markdown files into Supabase ({mode}).", flush=True)
    run_command(
        build_ingest_command(
            dry_run=False,
            changed_only=changed_only,
            source_files=source_files,
        )
    )


def run_embeddings(limit: int, batch_size: int, max_rounds: int) -> None:
    """第三步：循环生成 embedding，直到缺失数量为 0。

    为什么要循环：
    generate_embeddings.py 每次只处理 limit 条，避免一次请求太多导致超时或费用不可控。
    总控脚本会一轮一轮跑，直到脚本输出 missing embedding = 0。
    """

    print("Step 3/4: generate embeddings until missing count becomes 0.", flush=True)

    for round_index in range(1, max_rounds + 1):
        print("", flush=True)
        print(f"Embedding round {round_index}/{max_rounds}", flush=True)
        output = run_command(
            [
                "python3",
                "scripts/generate_embeddings.py",
                "--limit",
                str(limit),
                "--batch-size",
                str(batch_size),
            ]
        )
        missing_count = parse_missing_embedding_count(output)

        if missing_count is None:
            raise RuntimeError("Could not parse missing embedding count from output.")

        if missing_count == 0:
            print("All chunks have embeddings.", flush=True)
            return

        print(f"Still missing embeddings: {missing_count}", flush=True)
        time.sleep(1)

    raise RuntimeError(
        "Embedding generation did not finish within max rounds. "
        "Increase --max-embedding-rounds or rerun this script."
    )


def run_health_check() -> None:
    """第四步：用脚本级检查确认 embedding 是否已经全部补齐。

    这里复用 generate_embeddings.py --limit 1。
    如果它输出 Nothing to do，并且 missing before run 是 0，就说明索引已经完整。
    """

    print("Step 4/4: verify knowledge embedding health.", flush=True)
    run_command(
        [
            "python3",
            "scripts/generate_embeddings.py",
            "--limit",
            "1",
            "--batch-size",
            "1",
        ]
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Sync Markdown knowledge and embeddings.")
    parser.add_argument(
        "--dry-run-only",
        action="store_true",
        help="Only preview Markdown scan/chunk result. Do not write Supabase or embeddings.",
    )
    parser.add_argument(
        "--skip-ingest",
        action="store_true",
        help="Skip dry-run and ingest. Only continue generating missing embeddings.",
    )
    parser.add_argument(
        "--skip-embeddings",
        action="store_true",
        help="Only run dry-run and ingest. Do not generate embeddings.",
    )
    parser.add_argument(
        "--full",
        action="store_true",
        help="Force full ingest for all Markdown files instead of changed-only ingest.",
    )
    parser.add_argument(
        "--source-file",
        action="append",
        default=[],
        help="Only sync a specific knowledge/... Markdown file. Can be repeated.",
    )
    parser.add_argument(
        "--git-changed",
        action="store_true",
        help="Only sync Markdown files changed in git status under knowledge/.",
    )
    parser.add_argument("--embedding-limit", type=int, default=DEFAULT_EMBEDDING_LIMIT)
    parser.add_argument("--embedding-batch-size", type=int, default=DEFAULT_EMBEDDING_BATCH_SIZE)
    parser.add_argument("--max-embedding-rounds", type=int, default=DEFAULT_MAX_EMBEDDING_ROUNDS)
    args = parser.parse_args()

    if args.embedding_batch_size > 10:
        raise RuntimeError("DashScope embedding batch size must be <= 10.")

    print("Knowledge sync started.", flush=True)
    changed_only = not args.full
    source_files = list(args.source_file)

    if args.git_changed:
        source_files.extend(get_git_changed_knowledge_files())
        source_files = sorted(set(source_files))
        if not source_files:
            print("No changed Markdown files found under knowledge/.", flush=True)
            return
        print("Git changed knowledge files:", flush=True)
        for source_file in source_files:
            print(f"- {source_file}", flush=True)

    if args.dry_run_only:
        run_dry_run(source_files)
        print("Dry-run finished. No database changes were made.", flush=True)
        return

    if not args.skip_ingest:
        run_dry_run(source_files)
        run_ingest(changed_only, source_files)
    else:
        print("Step 1/4 and 2/4 skipped: ingest was skipped by --skip-ingest.", flush=True)

    if not args.skip_embeddings:
        run_embeddings(args.embedding_limit, args.embedding_batch_size, args.max_embedding_rounds)
        run_health_check()
    else:
        print("Step 3/4 and 4/4 skipped: embeddings were skipped by --skip-embeddings.", flush=True)

    print("Knowledge sync finished.", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Knowledge sync failed: {error}", file=sys.stderr, flush=True)
        raise
