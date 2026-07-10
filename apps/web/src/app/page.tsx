"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

import { ChatWorkspace, type ChatMessage } from "./components/chat-workspace";
import { DesignWorkspace } from "./components/design-workspace";

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
  const [activeWorkspace, setActiveWorkspace] = useState<"chat" | "design">("design");
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
  const confirmingConversation = useMemo(
    () =>
      conversations.find((conversation) => conversation.id === confirmingDeleteId) || null,
    [confirmingDeleteId, conversations],
  );

  async function loadSessions() {
    // 左侧栏会话列表从 PostgreSQL chat_sessions 读取。
    // 这一步替代之前的 localStorage 本地假记忆。
    const response = await fetch("/api/chat/sessions");
    const payload = (await response.json()) as SessionsResponse;

    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || "加载会话失败");
    }

    setConversations(payload.sessions || []);
  }

  async function loadMessages(sessionId: string) {
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
    // 真正的持久化由 /api/chat 写入 PostgreSQL。
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
    <main className="min-h-screen bg-[#f4f7fb] text-[#091b3d]">
      <div className="flex h-screen overflow-hidden">
        <aside className="hidden w-[250px] shrink-0 flex-col bg-[#061a3d] text-white md:flex">
          <div className="flex h-20 items-center px-5">
            <div className="text-2xl font-semibold tracking-normal">genengi</div>
          </div>

          <div className="px-4">
            <button
              className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-[#0969ff] px-4 text-sm font-medium text-white shadow-[0_12px_30px_rgba(9,105,255,0.35)] transition hover:bg-[#005bed]"
              onClick={() => {
                setActiveWorkspace("chat");
                void startNewChat();
              }}
              type="button"
            >
              <span className="text-xl leading-none">+</span>
              新对话
            </button>
          </div>

          <nav className="mt-7 space-y-1 px-3">
            {[
              ["chat", "AI装修顾问"],
              ["design", "效果图生成"],
            ].map(([key, label]) => (
              <button
                className={
                  activeWorkspace === key
                    ? "flex h-11 w-full items-center gap-3 rounded-lg bg-white/14 px-3 text-sm font-medium text-white"
                    : "flex h-11 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium text-white/78 transition hover:bg-white/10 hover:text-white"
                }
                key={key}
                onClick={() => setActiveWorkspace(key as "chat" | "design")}
                type="button"
              >
                <span className="grid size-6 place-items-center rounded-md border border-white/22 text-xs">
                  {key === "design" ? "图" : "问"}
                </span>
                {label}
              </button>
            ))}
          </nav>

          <div className="mt-6 flex-1 overflow-y-auto px-4">
            <div className="mb-3 flex items-center justify-between px-1">
              <div className="text-sm font-semibold text-white/75">聊天记录</div>
              <span className="text-xs text-white/40">{conversations.length}</span>
            </div>

            <div className="space-y-2">
              {conversations.length === 0 ? (
                <div className="px-1 py-2 text-sm leading-6 text-white/45">暂无对话</div>
              ) : null}

              {conversations.map((conversation) => (
                <div
                  className={
                    conversation.id === activeConversationId && activeWorkspace === "chat"
                      ? "group flex h-11 w-full items-center gap-1 rounded-lg bg-white/14 px-1.5 text-sm text-white"
                      : "group flex h-11 w-full items-center gap-1 rounded-lg px-1.5 text-sm text-white/78 transition hover:bg-white/10 hover:text-white"
                  }
                  key={conversation.id}
                >
                  <button
                    className="flex min-w-0 flex-1 items-center justify-between gap-3 px-1.5 text-left"
                    onClick={() => {
                      setActiveWorkspace("chat");
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
                    <svg aria-hidden="true" className="size-4" fill="none" viewBox="0 0 24 24">
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

          <div className="space-y-3 border-t border-white/10 p-4">
            <div className="rounded-lg border border-white/10 bg-white/5 p-3">
              <div className="text-xs text-white/55">当前项目</div>
              <div className="mt-2 text-sm font-semibold">我的新家</div>
              <div className="mt-1 text-xs text-white/55">三居室 · 98平 · 奶油风</div>
            </div>
            <button
              className="flex h-10 w-full items-center justify-center rounded-lg border border-white/12 text-sm text-white/78 transition hover:bg-white/10"
              type="button"
            >
              管理知识库
            </button>
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col bg-[#f4f7fb]">
          <header className="flex h-[72px] shrink-0 items-center justify-between border-b border-[#dbe5f3] bg-white px-4 md:px-7">
            <div>
              <h1 className="text-2xl font-semibold tracking-normal text-[#111827]">
                {activeWorkspace === "design" ? "效果图生成" : "AI装修顾问"}
              </h1>
              <div className="mt-1 text-sm text-[#6b7894]">
                {activeWorkspace === "design"
                  ? "上传户型图，生成统一风格的全屋效果图方案"
                  : "基于装修知识库回答施工、材料、预算、验收问题"}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <button className="grid size-9 place-items-center rounded-full border border-[#d8e4f5] text-[#42557d]" type="button">
                ?
              </button>
              <div className="grid size-9 place-items-center rounded-full bg-[#4b55d9] text-sm font-semibold text-white">
                W
              </div>
            </div>
          </header>

          {activeWorkspace === "design" ? (
            <DesignWorkspace />
          ) : (
            <ChatWorkspace
              activeConversationLoading={activeConversationLoading}
              canSubmit={canSubmit}
              error={error}
              exampleQuestions={EXAMPLE_QUESTIONS}
              input={input}
              messages={messages}
              onInputChange={setInput}
              onSubmit={submitQuestion}
            />
          )}
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
