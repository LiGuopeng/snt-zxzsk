"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

import { ChatWorkspace, type ChatMessage } from "./components/chat-workspace";
import { DesignWorkspace } from "./components/design-workspace";

type Source = {
  // used 表示回答后确认采用；retrieved 表示二次筛选失败时的检索兜底来源。
  mode?: "used" | "retrieved";
  // knowledge_chunks.id；新回答会带上，历史消息可能没有。
  chunk_id?: string;
  // 知识库来源文件。
  source_file: string;
  // 来源章节。
  section: string | null;
  // 知识库层级。
  layer: string | null;
  // 业务模块。
  module: string | null;
  // 向量相似度，用于调试召回质量。
  similarity: number;
  // 回答完成后，AI 判断这条资料支撑了哪个结论。
  reason?: string;
};

type Conversation = {
  // chat_sessions.id。
  id: string;
  // 左侧会话标题。
  title: string;
  // 左侧列表显示相对更新时间。
  updated_at: string;
};

type SessionsResponse = {
  // API 是否成功。
  ok: boolean;
  // GET /api/chat/sessions 返回的会话列表。
  sessions?: Conversation[];
  // POST /api/chat/sessions 新建会话时返回的单条会话。
  session?: Conversation;
  // API 错误信息。
  error?: string;
};

type MessagesResponse = {
  // API 是否成功。
  ok: boolean;
  // 当前会话的历史消息。
  messages?: Array<{
    id: string;
    role: "user" | "assistant" | "system";
    content: string;
    sources?: Source[];
  }>;
  error?: string;
};

type ChatStreamDonePayload = {
  // 服务端保存后的完整回答，用于最终校正前端逐字拼接结果。
  answer?: string;
  // 后端创建或确认的会话 ID。
  sessionId?: string;
  // 本次回答实际采用的知识库依据。
  sources?: Source[];
};

type ChatStreamErrorPayload = {
  // 给用户展示的错误信息。
  error?: string;
  // 给程序判断的错误码，例如 AI_TIMEOUT。
  errorCode?: string;
};

type ChatStreamTokenPayload = {
  // 服务端流式返回的增量文本片段。
  token?: string;
};

// 空态页展示的示例问题，帮助用户理解 AI 装修顾问适合问什么。
const EXAMPLE_QUESTIONS = [
  "水电增项 8000 是不是被坑了？",
  "卫生间门口地板发黑是不是漏水？",
  "瓷砖空鼓一点要不要重铺？",
  "装修公司让我先付尾款再整改，可以吗？",
];

// 本地占位会话 ID：用户点击“新对话”后，真实 sessionId 可能还在创建或等待第一条消息。
const NEW_CHAT_ID = "__new_chat__";

/**
 * 创建前端临时消息 ID。
 * 用于乐观渲染用户消息和流式助手占位消息，数据库真实 ID 会在重新加载会话时覆盖。
 */
function createMessageId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * 将会话更新时间格式化成左侧列表的短相对时间。
 * 只用于展示，不参与任何排序或业务判断。
 */
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

/**
 * 解析 text/event-stream 中的一段 SSE 事件。
 * 后端按 event/data 输出，前端根据 event 区分 session、token、done、error。
 */
function parseServerSentEvent(block: string) {
  let event = "message";
  const dataLines: string[] = [];

  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trim());
    }
  }

  return {
    data: dataLines.length ? JSON.parse(dataLines.join("\n")) as unknown : null,
    event,
  };
}

export default function Home() {
  // 输入框当前文本。
  const [input, setInput] = useState("");
  // 左侧会话列表。
  const [conversations, setConversations] = useState<Conversation[]>([]);
  // 当前中间聊天窗口展示的消息。
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // 当前主工作区：AI 装修顾问或效果图生成。
  const [activeWorkspace, setActiveWorkspace] = useState<"chat" | "design">("design");
  // 当前选中的真实会话 ID；NEW_CHAT_ID 表示前端新对话占位。
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  // 正在弹窗确认删除的会话 ID。
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  // 正在执行删除请求的会话 ID，用于禁用重复点击。
  const [deletingConversationId, setDeletingConversationId] = useState<string | null>(null);
  // 页面级错误提示。
  const [error, setError] = useState("");
  // 正在生成回答的会话 ID 列表，支持不同会话并行生成。
  const [loadingConversationIds, setLoadingConversationIds] = useState<string[]>([]);
  // 保存最新 activeConversationId，避免流式请求闭包里拿到旧状态。
  const activeConversationIdRef = useRef<string | null>(null);

  // 当前会话是否正在生成回答，用于控制输入框禁用和 loading 展示。
  const activeConversationLoading = activeConversationId
    ? loadingConversationIds.includes(activeConversationId)
    : loadingConversationIds.includes(NEW_CHAT_ID);
  // 是否允许提交问题。
  const canSubmit = useMemo(
    () => input.trim().length > 0 && !activeConversationLoading,
    [activeConversationLoading, input],
  );
  // 当前确认删除弹窗对应的会话对象。
  const confirmingConversation = useMemo(
    () =>
      conversations.find((conversation) => conversation.id === confirmingDeleteId) || null,
    [confirmingDeleteId, conversations],
  );

  /**
   * 加载左侧会话列表。
   * 数据来自 PostgreSQL chat_sessions，不再使用浏览器本地存储。
   */
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

  /**
   * 加载某个会话下的历史消息。
   * 点击左侧会话时调用，用数据库内容恢复中间聊天窗口。
   */
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
    // activeConversationIdRef 专门服务流式读取：
    // token 回来时用它判断用户是否仍停留在发起请求的会话。
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);

  /**
   * 提交用户问题并读取 /api/chat 流式响应。
   * 先乐观插入 user 消息和空 assistant 消息，再用 token 事件逐步填充 assistant 内容。
   */
  async function submitQuestion(event?: FormEvent<HTMLFormElement>, presetQuestion?: string) {
    event?.preventDefault();

    // presetQuestion 来自示例问题按钮；没有 preset 时使用输入框文本。
    const question = (presetQuestion || input).trim();

    // 记录请求发起时的会话，后续 token 回来时只更新同一个会话，避免串台。
    const requestActiveConversationId = activeConversationId;
    // NEW_CHAT_ID 只是前端占位，传给后端时要转成 null，让后端创建或使用真实 session。
    const requestSessionId =
      requestActiveConversationId === NEW_CHAT_ID ? null : requestActiveConversationId;
    // loading key 用真实 sessionId 或 NEW_CHAT_ID，支持不同会话并行生成。
    const requestConversationKey = requestSessionId || NEW_CHAT_ID;

    if (!question || loadingConversationIds.includes(requestConversationKey)) {
      return;
    }

    const userMessage: ChatMessage = {
      id: createMessageId(),
      role: "user",
      content: question,
    };
    // assistantMessageId 用来定位这个空助手消息，后续 token 事件会持续追加到这条消息上。
    const assistantMessageId = createMessageId();
    const assistantMessage: ChatMessage = {
      id: assistantMessageId,
      role: "assistant",
      content: "",
      sources: [],
    };
    // 同一个对话的上下文依赖 sessionId。
    // 这里直接使用 activeConversationId，避免左侧会话列表尚未刷新时 activeConversation 查不到，
    // 导致后端误以为是新会话，从而丢失上一轮上下文。
    // 先把用户消息放到页面里，减少等待感。
    // 真正的持久化由 /api/chat 写入 PostgreSQL。
    setMessages((current) => [...current, userMessage, assistantMessage]);

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

      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => null) as ChatStreamErrorPayload | null;
        throw new Error(payload?.error || "请求失败");
      }

      // reader 逐块读取 text/event-stream 响应。
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      // buffer 保存尚未凑齐完整 SSE 事件的半包文本。
      let buffer = "";

      /**
       * 处理单个 SSE 事件块。
       * token 事件追加文本，done 事件补齐 sources，error 事件抛给外层 catch。
       */
      async function handleEvent(block: string) {
        if (!block.trim()) {
          return;
        }

        const parsed = parseServerSentEvent(block);

        if (parsed.event === "session") {
          // session 事件只说明后端已经准备好会话。
          // 新会话的 activeConversationId 等 done 事件再切换，避免流式 token 更新被会话 ID 变化挡住。
          return;
        }

        if (parsed.event === "token") {
          const payload = parsed.data as ChatStreamTokenPayload | null;
          const token = payload?.token || "";

          if (!token || activeConversationIdRef.current !== requestActiveConversationId) {
            return;
          }

          setMessages((current) =>
            current.map((message) =>
              message.id === assistantMessageId
                ? {
                    ...message,
                    content: `${message.content}${token}`,
                  }
                : message,
            ),
          );
          return;
        }

        if (parsed.event === "done") {
          const payload = parsed.data as ChatStreamDonePayload | null;

          if (activeConversationIdRef.current === requestActiveConversationId) {
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantMessageId
                  ? {
                      ...message,
                      content: payload?.answer || message.content,
                      sources: payload?.sources || [],
                    }
                  : message,
              ),
            );

            if (!requestSessionId && payload?.sessionId) {
              setActiveConversationId(payload.sessionId);
            }
          }
          return;
        }

        if (parsed.event === "error") {
          const payload = parsed.data as ChatStreamErrorPayload | null;
          throw new Error(payload?.error || "请求失败");
        }
      }

      while (true) {
        // 每次 read 可能拿到半个或多个 SSE 事件，所以必须用 buffer 按 \n\n 切完整事件。
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() || "";

        for (const block of blocks) {
          await handleEvent(block);
        }
      }

      if (buffer.trim()) {
        // 处理最后一个没有以 \n\n 结尾的事件。
        await handleEvent(buffer);
      }

      await loadSessions();
    } catch (requestError) {
      if (activeConversationIdRef.current === requestActiveConversationId) {
        setError(requestError instanceof Error ? requestError.message : "请求失败");
        // 如果流式请求失败，移除空的助手占位消息，避免页面留下空回答。
        setMessages((current) => current.filter((message) => message.id !== assistantMessageId));
      }
    } finally {
      setLoadingConversationIds((current) =>
        current.filter((conversationId) => conversationId !== requestConversationKey),
      );
    }
  }

  /**
   * 开始一个新对话。
   * 先在前端切到聊天工作区并清空消息，再调用后端创建真实 chat_session。
   */
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

  /**
   * 删除一个会话及其消息。
   * 只删除 chat_sessions/chat_messages，不会影响知识库和效果图数据。
   */
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
