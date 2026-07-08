"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

type Source = {
  source_file: string;
  section: string | null;
  layer: string | null;
  module: string | null;
  similarity: number;
};

type ChatResponse = {
  ok: boolean;
  sessionId?: string;
  answer?: string;
  sources?: Source[];
  error?: string;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
};

type Conversation = {
  id: string;
  title: string;
  updated_at: string;
};

type SessionsResponse = {
  ok: boolean;
  sessions?: Conversation[];
  session?: Conversation;
  error?: string;
};

type MessagesResponse = {
  ok: boolean;
  messages?: Array<{
    id: string;
    role: "user" | "assistant" | "system";
    content: string;
    sources?: Source[];
  }>;
  error?: string;
};

const EXAMPLE_QUESTIONS = [
  "水电增项 8000 是不是被坑了？",
  "卫生间门口地板发黑是不是漏水？",
  "瓷砖空鼓一点要不要重铺？",
  "装修公司让我先付尾款再整改，可以吗？",
];

const NEW_CHAT_ID = "__new_chat__";

function createMessageId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatConversationTime(updatedAt: string) {
  // 左侧列表只需要一个轻量时间提示，具体时间仍以数据库 updated_at 为准。
  const updatedTime = new Date(updatedAt).getTime();

  if (Number.isNaN(updatedTime)) {
    return "";
  }

  const diffMinutes = Math.max(1, Math.floor((Date.now() - updatedTime) / 60000));

  if (diffMinutes < 60) {
    return `${diffMinutes} 分`;
  }

  const diffHours = Math.floor(diffMinutes / 60);

  if (diffHours < 24) {
    return `${diffHours} 时`;
  }

  const diffDays = Math.floor(diffHours / 24);

  if (diffDays < 7) {
    return `${diffDays} 天`;
  }

  return `${Math.floor(diffDays / 7)} 周`;
}

export default function Home() {
  const [input, setInput] = useState("");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [deletingConversationId, setDeletingConversationId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loadingConversationIds, setLoadingConversationIds] = useState<string[]>([]);
  const activeConversationIdRef = useRef<string | null>(null);

  const activeConversationLoading = activeConversationId
    ? loadingConversationIds.includes(activeConversationId)
    : loadingConversationIds.includes(NEW_CHAT_ID);
  const canSubmit = useMemo(
    () => input.trim().length > 0 && !activeConversationLoading,
    [activeConversationLoading, input],
  );
  const hasMessages = messages.length > 0;
  const confirmingConversation = useMemo(
    () =>
      conversations.find((conversation) => conversation.id === confirmingDeleteId) || null,
    [confirmingDeleteId, conversations],
  );

  async function loadSessions() {
    // 左侧栏会话列表从 Supabase chat_sessions 读取。
    // 这一步替代之前的 localStorage 本地假记忆。
    const response = await fetch("/api/chat/sessions");
    const payload = (await response.json()) as SessionsResponse;

    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || "加载会话失败");
    }

    setConversations(payload.sessions || []);
  }

  async function loadMessages(sessionId: string) {
    // 点击左侧某个会话时，再读取该会话下的 messages。
    // 不在列表接口里一次性读取所有消息，避免会话多了以后首页变慢。
    const response = await fetch(`/api/chat/sessions/${sessionId}/messages`);
    const payload = (await response.json()) as MessagesResponse;

    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || "加载消息失败");
    }

    setMessages(
      (payload.messages || [])
        .filter((message) => message.role === "user" || message.role === "assistant")
        .map((message) => ({
          id: message.id,
          role: message.role as "user" | "assistant",
          content: message.content,
          sources: message.sources || [],
        })),
    );
  }

  useEffect(() => {
    // 页面首次加载时拉取真实会话列表。
    // 这里不自动打开第一条会话，避免用户进来就被旧对话打断。
    // 这是客户端从服务端 API 同步会话列表的入口，必须在挂载后更新页面状态。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadSessions().catch((loadError) => {
      setError(loadError instanceof Error ? loadError.message : "加载会话失败");
    });
  }, []);

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);

  async function submitQuestion(event?: FormEvent<HTMLFormElement>, presetQuestion?: string) {
    event?.preventDefault();

    const question = (presetQuestion || input).trim();

    const requestActiveConversationId = activeConversationId;
    const requestSessionId =
      requestActiveConversationId === NEW_CHAT_ID ? null : requestActiveConversationId;
    const requestConversationKey = requestSessionId || NEW_CHAT_ID;

    if (!question || loadingConversationIds.includes(requestConversationKey)) {
      return;
    }

    const userMessage: ChatMessage = {
      id: createMessageId(),
      role: "user",
      content: question,
    };
    // 同一个对话的上下文依赖 sessionId。
    // 这里直接使用 activeConversationId，避免左侧会话列表尚未刷新时 activeConversation 查不到，
    // 导致后端误以为是新会话，从而丢失上一轮上下文。
    // 先把用户消息放到页面里，减少等待感。
    // 真正的持久化由 /api/chat 写入 Supabase。
    setMessages((current) => [...current, userMessage]);

    setInput("");
    setError("");
    setLoadingConversationIds((current) =>
      current.includes(requestConversationKey) ? current : [...current, requestConversationKey],
    );

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          message: question,
          sessionId: requestSessionId,
        }),
      });

      const payload = (await response.json()) as ChatResponse;

      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "请求失败");
      }

      const assistantMessage: ChatMessage = {
        id: createMessageId(),
        role: "assistant",
        content: payload.answer || "",
        sources: payload.sources || [],
      };

      // 不同会话允许同时生成。
      // 只有当用户仍停留在发起请求的那个会话时，才把回答追加到当前消息流。
      // 如果用户已经切到新对话，旧回答只保存在数据库里，稍后点回旧会话再加载。
      if (activeConversationIdRef.current === requestActiveConversationId) {
        setMessages((current) => [...current, assistantMessage]);

        if (!requestSessionId && payload.sessionId) {
          setActiveConversationId(payload.sessionId);
        }
      }

      // 刷新左侧会话列表，让新会话或更新时间立即出现在侧边栏。
      await loadSessions();
    } catch (requestError) {
      if (activeConversationIdRef.current === requestActiveConversationId) {
        setError(requestError instanceof Error ? requestError.message : "请求失败");
      }
    } finally {
      setLoadingConversationIds((current) =>
        current.filter((conversationId) => conversationId !== requestConversationKey),
      );
    }
  }

  async function startNewChat() {
    // 创建真实 session。
    // 后续用户发送第一条消息时，/api/chat 会把消息写入这个 session。
    setError("");
    setInput("");
    setMessages([]);
    setActiveConversationId(NEW_CHAT_ID);

    try {
      const response = await fetch("/api/chat/sessions", {
        method: "POST",
      });
      const payload = (await response.json()) as SessionsResponse;

      if (!response.ok || !payload.ok || !payload.session) {
        throw new Error(payload.error || "创建会话失败");
      }

      setActiveConversationId(payload.session.id);
      await loadSessions();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "创建会话失败");
    }

    setInput("");
  }

  async function deleteConversation(sessionId: string) {
    // 左侧删除只删除该 session 的聊天记录，不会删除知识库内容。
    if (deletingConversationId) {
      return;
    }

    setError("");
    setDeletingConversationId(sessionId);

    try {
      const response = await fetch(`/api/chat/sessions/${sessionId}`, {
        method: "DELETE",
      });
      const payload = (await response.json()) as { ok: boolean; error?: string };

      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "删除对话失败");
      }

      setConversations((current) =>
        current.filter((conversation) => conversation.id !== sessionId),
      );

      if (activeConversationId === sessionId) {
        setActiveConversationId(null);
        setMessages([]);
        setInput("");
      }

      setConfirmingDeleteId(null);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "删除对话失败");
    } finally {
      setDeletingConversationId(null);
    }
  }

  return (
    <main className="min-h-screen bg-[#f4f8ff] text-[#091b3d]">
      <div className="flex h-screen overflow-hidden">
        <aside className="hidden w-[300px] shrink-0 flex-col bg-[#061a3d] text-white md:flex">
          <div className="flex h-20 items-center justify-between px-5">
            <div className="text-2xl font-semibold tracking-normal">genengi</div>
            <button
              className="grid size-9 place-items-center rounded-full bg-white/10 text-lg text-white/80 transition hover:bg-white/15"
              type="button"
            >
              «
            </button>
          </div>

          <div className="px-5">
            <button
              className="flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-[#0969ff] px-4 text-sm font-medium text-white shadow-[0_12px_30px_rgba(9,105,255,0.35)] transition hover:bg-[#005bed]"
              onClick={() => void startNewChat()}
              type="button"
            >
              <span className="text-xl leading-none">+</span>
              新对话
            </button>
          </div>

          <div className="mt-8 flex-1 overflow-y-auto px-4">
            <div className="mb-3 px-1 text-sm font-semibold text-white/75">对话</div>

            <div className="space-y-2">
              {conversations.length === 0 ? (
                <div className="px-1 py-2 text-sm leading-6 text-white/45">暂无对话</div>
              ) : null}

              {conversations.map((conversation) => (
                <div
                  className={
                    conversation.id === activeConversationId
                      ? "group flex h-11 w-full items-center gap-1 rounded-lg bg-white/14 px-1.5 text-sm text-white"
                      : "group flex h-11 w-full items-center gap-1 rounded-lg px-1.5 text-sm text-white/78 transition hover:bg-white/10 hover:text-white"
                  }
                  key={conversation.id}
                >
                  <button
                    className="flex min-w-0 flex-1 items-center justify-between gap-3 px-1.5 text-left"
                    onClick={() => {
                      setActiveConversationId(conversation.id);
                      setConfirmingDeleteId(null);
                      setError("");
                      void loadMessages(conversation.id).catch((loadError) => {
                        setError(loadError instanceof Error ? loadError.message : "加载消息失败");
                      });
                    }}
                    type="button"
                  >
                    <span className="min-w-0 flex-1 truncate">{conversation.title}</span>
                    {loadingConversationIds.includes(conversation.id) ? (
                      <span className="shrink-0 rounded-full bg-white/12 px-2 py-0.5 text-xs text-white/72">
                        生成中
                      </span>
                    ) : (
                      <span className="shrink-0 text-xs text-white/45">
                        {formatConversationTime(conversation.updated_at)}
                      </span>
                    )}
                  </button>
                  <button
                    aria-label="删除对话"
                    className="grid size-8 shrink-0 place-items-center rounded-md text-white/45 opacity-0 transition hover:bg-white/12 hover:text-white group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={deletingConversationId === conversation.id}
                    onClick={() => setConfirmingDeleteId(conversation.id)}
                    type="button"
                  >
                    <svg
                      aria-hidden="true"
                      className="size-4"
                      fill="none"
                      viewBox="0 0 24 24"
                    >
                      <path
                        d="M9 4h6m-8 4h10m-9 0 .7 11h6.6L16 8"
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                      />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="border-t border-white/10 p-4">
            <button
              className="flex h-11 w-full items-center gap-3 rounded-lg px-2 text-sm text-white/82 transition hover:bg-white/10"
              type="button"
            >
              <span className="grid size-8 place-items-center rounded-full bg-white/12 text-white">
                设
              </span>
              <span className="truncate">设置</span>
            </button>
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col bg-[radial-gradient(circle_at_80%_12%,rgba(62,133,255,0.18),transparent_30%),linear-gradient(180deg,#ffffff_0%,#f5f8ff_48%,#eef5ff_100%)]">
          <header className="flex h-14 shrink-0 items-center justify-between px-4 md:px-8">
            <div className="flex items-center gap-3">
              <button
                className="grid size-9 place-items-center rounded-lg border border-[#c9dcff] text-lg text-[#0969ff] md:hidden"
                onClick={() => void startNewChat()}
                type="button"
              >
                +
              </button>
              <div>
                <div className="text-sm font-semibold text-[#091b3d]">AI 装修顾问</div>
                <div className="text-xs text-[#647399]">基于 3535 个知识片段回答</div>
              </div>
            </div>
            <div className="rounded-full border border-[#c9dcff] bg-white/70 px-3 py-1 text-xs text-[#42557d] shadow-sm">
              qwen-plus
            </div>
          </header>

          <div className="flex-1 overflow-y-auto">
            {!hasMessages ? (
              <section className="mx-auto flex min-h-full w-full max-w-6xl flex-col justify-center px-6 py-10">
                <div className="grid items-center gap-10 lg:grid-cols-[1fr_360px]">
                  <div>
                    <div className="inline-flex w-fit items-center gap-2 rounded-full border border-[#c9dcff] bg-white/80 px-4 py-2 text-sm font-medium text-[#0969ff] shadow-sm">
                      <span>✦</span>
                      AI 装修顾问
                    </div>

                    <h1 className="mt-7 max-w-4xl text-4xl font-semibold tracking-normal text-[#071a44] md:text-5xl">
                      今天想解决哪个装修问题？
                    </h1>
                    <p className="mt-5 max-w-3xl text-[15px] leading-8 text-[#405176]">
                      直接描述房子、阶段、报价、合同或现场现象。我会先检索你的装修知识库，再给出简洁建议和参考来源。
                    </p>

                    <div className="mt-8 grid w-full gap-3 sm:grid-cols-2">
                      {EXAMPLE_QUESTIONS.map((question, index) => (
                        <button
                          className="group flex min-h-20 items-center gap-4 rounded-xl border border-[#d8e6ff] bg-white/82 p-4 text-left shadow-[0_14px_36px_rgba(38,96,190,0.07)] transition hover:-translate-y-0.5 hover:border-[#8ebcff] hover:bg-white hover:shadow-[0_18px_42px_rgba(38,96,190,0.12)]"
                          key={question}
                          onClick={() => submitQuestion(undefined, question)}
                          type="button"
                        >
                          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[#eaf3ff] text-sm font-semibold text-[#0969ff] group-hover:bg-[#0969ff] group-hover:text-white">
                            {index + 1}
                          </span>
                          <span className="min-w-0 text-sm leading-6 text-[#20345d]">
                            {question}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="hidden lg:block">
                    <div className="relative overflow-hidden rounded-2xl border border-[#d8e6ff] bg-white/70 p-5 shadow-[0_24px_70px_rgba(38,96,190,0.12)]">
                      <div className="absolute inset-0 bg-[linear-gradient(#dbe9ff_1px,transparent_1px),linear-gradient(90deg,#dbe9ff_1px,transparent_1px)] bg-[size:22px_22px] opacity-45" />
                      <div className="relative">
                        <div className="flex items-center justify-between">
                          <div>
                            <div className="text-sm font-semibold text-[#071a44]">装修问题整理</div>
                            <div className="mt-1 text-xs text-[#647399]">预算 / 合同 / 施工 / 验收</div>
                          </div>
                          <div className="grid size-11 place-items-center rounded-xl bg-[#0969ff] text-lg font-semibold text-white shadow-[0_12px_30px_rgba(9,105,255,0.28)]">
                            G
                          </div>
                        </div>

                        <div className="mt-8 rounded-xl border border-[#c9dcff] bg-white/80 p-4">
                          <div className="mb-4 h-2 w-24 rounded-full bg-[#0969ff]" />
                          <div className="grid grid-cols-2 gap-3">
                            <div className="h-20 rounded-lg border border-[#c9dcff] bg-[#f6faff]" />
                            <div className="h-20 rounded-lg border border-[#c9dcff] bg-[#f6faff]" />
                            <div className="h-14 rounded-lg border border-[#c9dcff] bg-white" />
                            <div className="h-14 rounded-lg border border-[#c9dcff] bg-white" />
                          </div>
                        </div>

                        <div className="mt-4 grid grid-cols-3 gap-3 text-center text-xs text-[#42557d]">
                          <div className="rounded-lg bg-white/86 px-2 py-3 shadow-sm">找依据</div>
                          <div className="rounded-lg bg-white/86 px-2 py-3 shadow-sm">判风险</div>
                          <div className="rounded-lg bg-white/86 px-2 py-3 shadow-sm">给建议</div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </section>
            ) : (
              <section className="mx-auto w-full max-w-3xl px-4 py-6">
                {messages.map((message) => (
                  <article className="group py-5" key={message.id}>
                    {message.role === "user" ? (
                      <div className="flex justify-end">
                        <div className="flex max-w-[78%] flex-row-reverse items-start gap-3">
                          <div className="grid size-8 shrink-0 place-items-center rounded-full bg-[#2563eb] text-sm font-semibold text-white">
                            你
                          </div>
                          <div className="min-w-0">
                            <div className="mb-1 text-right text-sm font-semibold text-[#091b3d]">
                              你
                            </div>
                            <div className="rounded-2xl rounded-tr-md bg-[#0969ff] px-4 py-3 text-left text-[15px] leading-7 text-white shadow-[0_10px_24px_rgba(9,105,255,0.24)]">
                              {message.content}
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="flex gap-4">
                        <div className="grid size-8 shrink-0 place-items-center rounded-full bg-[#061a3d] text-sm font-semibold text-white">
                          G
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="mb-1 text-sm font-semibold text-[#091b3d]">genengi</div>
                          <div className="whitespace-pre-wrap text-[15px] leading-8 text-[#233657]">
                            {message.content}
                          </div>

                          {message.sources?.length ? (
                            <details className="mt-4 rounded-xl border border-[#d8e6ff] bg-white/80 p-3">
                              <summary className="cursor-pointer text-sm font-medium text-[#20345d]">
                                参考来源 {message.sources.length} 条
                              </summary>
                              <div className="mt-3 grid gap-2">
                                {message.sources.map((source, index) => (
                                  <div
                                    className="rounded-lg bg-[#f6f9ff] p-3 text-xs leading-5 text-[#42557d]"
                                    key={`${source.source_file}-${source.section}-${index}`}
                                  >
                                    <div className="mb-1 flex flex-wrap gap-2">
                                      <span className="rounded bg-[#e9f2ff] px-2 py-0.5 text-[#0969ff]">
                                        {source.layer || "未标注"}
                                      </span>
                                      <span>{source.module || "未标注"}</span>
                                      <span>{source.similarity.toFixed(4)}</span>
                                    </div>
                                    <div className="break-all font-medium">
                                      {source.source_file}
                                    </div>
                                    <div className="mt-1 text-[#647399]">
                                      {source.section || "未标注章节"}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </details>
                          ) : null}
                        </div>
                      </div>
                    )}
                  </article>
                ))}

                {activeConversationLoading ? (
                  <article className="py-5">
                    <div className="flex gap-4">
                      <div className="grid size-8 shrink-0 place-items-center rounded-full bg-[#061a3d] text-sm font-semibold text-white">
                        G
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="mb-1 text-sm font-semibold text-[#091b3d]">genengi</div>
                        <div className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-2 text-sm text-[#647399] shadow-sm">
                          <span className="size-2 animate-pulse rounded-full bg-[#0969ff]" />
                          正在检索知识库并生成回答...
                        </div>
                      </div>
                    </div>
                  </article>
                ) : null}
              </section>
            )}
          </div>

          <div className="shrink-0 px-5 pb-5">
            <div className="mx-auto w-full max-w-5xl">
              {error ? (
                <div className="mb-3 rounded-xl border border-[#fecaca] bg-[#fef2f2] px-4 py-3 text-sm text-[#991b1b]">
                  {error}
                </div>
              ) : null}

              <form
                className="rounded-2xl border border-[#9fc5ff] bg-white/90 p-3 shadow-[0_18px_60px_rgba(9,105,255,0.14)] backdrop-blur"
                onSubmit={submitQuestion}
              >
                <div className="flex gap-3">
                  <textarea
                    aria-label="输入装修问题"
                    className="max-h-36 min-h-20 flex-1 resize-none bg-transparent px-2 py-2 text-[15px] leading-7 text-[#091b3d] outline-none placeholder:text-[#7d8db3]"
                    onChange={(event) => setInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        if (canSubmit) {
                          void submitQuestion();
                        }
                      }
                    }}
                    placeholder="询问装修预算、合同、施工、验收、售后问题..."
                    value={input}
                  />
                  <button
                    aria-label="发送问题"
                    className={
                      activeConversationLoading
                        ? "mt-auto grid size-12 shrink-0 cursor-not-allowed place-items-center rounded-full bg-[#e8f0ff] text-[#7f96c4] shadow-none transition"
                        : canSubmit
                          ? "mt-auto grid size-12 shrink-0 place-items-center rounded-full bg-[#0969ff] text-white shadow-[0_12px_30px_rgba(9,105,255,0.32)] transition hover:bg-[#005bed]"
                          : "mt-auto grid size-12 shrink-0 cursor-not-allowed place-items-center rounded-full bg-[#eef4ff] text-[#9fb2d6] shadow-none transition"
                    }
                    disabled={!canSubmit}
                    type="submit"
                  >
                    {activeConversationLoading ? (
                      <span className="size-2.5 animate-pulse rounded-full bg-current" />
                    ) : (
                      <svg
                        aria-hidden="true"
                        className="size-5"
                        fill="none"
                        viewBox="0 0 24 24"
                      >
                        <path
                          d="M12 19V5m0 0-6 6m6-6 6 6"
                          stroke="currentColor"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="2.4"
                        />
                      </svg>
                    )}
                  </button>
                </div>

              </form>
              <p className="mt-2 text-center text-xs text-[#7d8db3]">
                回答由知识库检索增强生成，关键装修决策建议结合合同和现场情况复核。
              </p>
            </div>
          </div>
        </section>
      </div>

      {confirmingConversation ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-[#061a3d]/35 px-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl border border-[#d8e6ff] bg-white p-5 shadow-[0_24px_80px_rgba(6,26,61,0.24)]">
            <div className="flex items-start gap-3">
              <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-[#fff1f2] text-[#ff3348]">
                <svg aria-hidden="true" className="size-5" fill="none" viewBox="0 0 24 24">
                  <path
                    d="M9 4h6m-8 4h10m-9 0 .7 11h6.6L16 8"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                  />
                </svg>
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-base font-semibold text-[#091b3d]">删除这条对话？</div>
                <p className="mt-2 text-sm leading-6 text-[#647399]">
                  “{confirmingConversation.title}” 删除后不能恢复，但不会影响知识库和
                  embedding。
                </p>
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                className="h-10 rounded-lg border border-[#d8e6ff] bg-white px-4 text-sm font-medium text-[#42557d] transition hover:bg-[#f7fbff]"
                onClick={() => setConfirmingDeleteId(null)}
                type="button"
              >
                取消
              </button>
              <button
                className="h-10 rounded-lg bg-[#ff4d5e] px-4 text-sm font-medium text-white transition hover:bg-[#ff3348] disabled:cursor-not-allowed disabled:bg-[#f3a0a9]"
                disabled={deletingConversationId === confirmingConversation.id}
                onClick={() => void deleteConversation(confirmingConversation.id)}
                type="button"
              >
                {deletingConversationId === confirmingConversation.id ? "删除中" : "删除"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
