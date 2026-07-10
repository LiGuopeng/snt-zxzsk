import { FormEvent, useEffect, useRef } from "react";

type Source = {
  // used 表示回答后确认采用；retrieved 表示二次筛选失败后的检索兜底依据。
  mode?: "used" | "retrieved";
  // knowledge_chunks.id。新生成回答会带上，历史数据可能为空。
  chunk_id?: string;
  // 来源 Markdown 文件路径，用于用户和开发者追溯知识内容。
  source_file: string;
  // 来源所在章节；知识切片没有章节时为 null。
  section: string | null;
  // 知识库层级，例如标准知识库、民间经验库、规则库等。
  layer: string | null;
  // 业务模块，例如预算、合同、施工、验收、售后等。
  module: string | null;
  // 向量召回相似度。主要用于判断检索质量，不直接代表答案正确率。
  similarity: number;
  // 回答生成后，系统二次筛选出的“这条资料支撑了哪个判断”。
  reason?: string;
};

export type ChatMessage = {
  // 前端渲染消息列表使用的稳定 key。新消息先用临时 ID，重新拉取后会变成数据库 ID。
  id: string;
  // 当前只展示用户和助手消息，system 消息不进入页面消息流。
  role: "user" | "assistant";
  // 消息正文；助手消息在流式输出时会逐步追加。
  content: string;
  // 助手消息才会有 sources，用于展示“实际采用依据”。
  sources?: Source[];
};

type ChatWorkspaceProps = {
  // 当前会话是否正在生成回答，用于控制 loading、按钮禁用和底部提示。
  activeConversationLoading: boolean;
  // 当前会话的生成阶段文案，例如正在检索知识库、正在生成回答。
  activeConversationStageLabel?: string;
  // 是否允许提交；通常要求有输入内容且当前会话不在生成中。
  canSubmit: boolean;
  // 页面级错误信息，例如接口失败、AI 超时等。
  error: string;
  // 空态页示例问题，点击后直接触发提问。
  exampleQuestions: string[];
  // 输入框受控值，由父组件统一管理。
  input: string;
  // 当前会话的消息列表。
  messages: ChatMessage[];
  // 输入框变化回调；父组件负责写入 state。
  onInputChange: (value: string) => void;
  // 提交问题回调；presetQuestion 用于示例问题按钮绕过输入框。
  onSubmit: (event?: FormEvent<HTMLFormElement>, presetQuestion?: string) => void;
};

/**
 * AI 装修顾问聊天工作区。
 * 只负责展示空态、消息流、实际采用依据、输入框和提交入口；
 * 会话状态、接口请求和流式解析都放在父组件 page.tsx 中处理。
 */
export function ChatWorkspace({
  activeConversationLoading,
  activeConversationStageLabel,
  canSubmit,
  error,
  exampleQuestions,
  input,
  messages,
  onInputChange,
  onSubmit,
}: ChatWorkspaceProps) {
  // 是否已经有消息。没有消息时展示产品空态和示例问题；有消息时展示聊天列表。
  const hasMessages = messages.length > 0;
  // 聊天消息滚动容器。新消息或流式 token 到来时，需要控制这个容器滚动到底部。
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  // 消息列表底部锚点。scrollIntoView 比手算 scrollTop 更稳，适配 sources 展开后的高度变化。
  const bottomAnchorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // 消息新增、AI 流式输出、阶段文案变化时，保持视图跟随最新内容。
    // requestAnimationFrame 等浏览器完成本轮布局后再滚动，避免内容高度还没更新就计算位置。
    const frameId = window.requestAnimationFrame(() => {
      bottomAnchorRef.current?.scrollIntoView({
        block: "end",
        behavior: "smooth",
      });
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [activeConversationStageLabel, messages]);

  /**
   * 根据 sources 的来源模式生成前端展示文案。
   * used：回答生成后确认采用，可信度更高。
   * retrieved：二次确认失败时的兜底检索依据，不能冒充“实际采用”。
   */
  function getSourceDisplayMeta(sources: Source[]) {
    const hasUsedSource = sources.some((source) => source.mode === "used" || source.reason);

    if (hasUsedSource) {
      return {
        title: `实际采用依据 ${sources.length} 条`,
        description: "以下为回答生成后再次筛选出的知识库依据，用于说明本次结论主要参考了哪些资料。",
      };
    }

    return {
      title: `知识库检索依据 ${sources.length} 条`,
      description: "以下为系统检索命中的候选知识资料，用于辅助本次回答，不等同于逐条实际采用。",
    };
  }

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto" ref={scrollContainerRef}>
        {/* 空态：用户还没有开始咨询时，直接给出可点击的装修问题示例。 */}
        {!hasMessages ? (
          <section className="mx-auto flex min-h-full w-full max-w-6xl flex-col justify-center px-6 py-10">
            <div>
              <div className="inline-flex w-fit items-center rounded-full border border-[#c9dcff] bg-white/80 px-4 py-2 text-sm font-medium text-[#0969ff] shadow-sm">
                AI 装修顾问
              </div>

              <h2 className="mt-7 max-w-4xl text-4xl font-semibold tracking-normal text-[#071a44] md:text-5xl">
                今天想解决哪个装修问题？
              </h2>
              <p className="mt-5 max-w-3xl text-[15px] leading-8 text-[#405176]">
                直接描述房子、阶段、报价、合同或现场现象。我会先检索你的装修知识库，再给出简洁建议和回答依据。
              </p>

              <div className="mt-8 grid w-full gap-3 sm:grid-cols-2">
                {exampleQuestions.map((question, index) => (
                  <button
                    className="group flex min-h-20 items-center gap-4 rounded-lg border border-[#d8e6ff] bg-white/82 p-4 text-left shadow-[0_14px_36px_rgba(38,96,190,0.07)] transition hover:border-[#8ebcff] hover:bg-white"
                    key={question}
                    // 示例问题不写入输入框，直接交给父组件按一次真实提问处理。
                    onClick={() => onSubmit(undefined, question)}
                    type="button"
                  >
                    <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[#eaf3ff] text-sm font-semibold text-[#0969ff]">
                      {index + 1}
                    </span>
                    <span className="min-w-0 text-sm leading-6 text-[#20345d]">{question}</span>
                  </button>
                ))}
              </div>
            </div>
          </section>
        ) : (
          /* 消息态：按角色区分用户气泡和 AI 回答区。 */
          <section className="mx-auto w-full max-w-3xl px-4 py-6">
            {messages.map((message) => (
              <article className="group py-5" key={message.id}>
                {/* 用户消息靠右展示，保持和常见聊天产品一致。 */}
                {message.role === "user" ? (
                  <div className="flex justify-end">
                    <div className="flex max-w-[78%] flex-row-reverse items-start gap-3">
                      <div className="grid size-8 shrink-0 place-items-center rounded-full bg-[#2563eb] text-sm font-semibold text-white">
                        你
                      </div>
                      <div className="min-w-0">
                        <div className="mb-1 text-right text-sm font-semibold text-[#091b3d]">你</div>
                        <div className="rounded-2xl rounded-tr-md bg-[#0969ff] px-4 py-3 text-left text-[15px] leading-7 text-white shadow-[0_10px_24px_rgba(9,105,255,0.24)]">
                          {message.content}
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  /* 助手消息靠左展示，并在回答下方折叠展示实际采用依据。 */
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
                        <details className="mt-4 rounded-lg border border-[#d8e6ff] bg-white/80 p-3">
                          <summary className="cursor-pointer text-sm font-medium text-[#20345d]">
                            {getSourceDisplayMeta(message.sources).title}
                          </summary>
                          <p className="mt-2 text-xs leading-5 text-[#647399]">
                            {getSourceDisplayMeta(message.sources).description}
                          </p>
                          <div className="mt-3 grid gap-2">
                            {message.sources.map((source, index) => (
                              <div
                                className="rounded-lg bg-[#f6f9ff] p-3 text-xs leading-5 text-[#42557d]"
                                // 同一个文件和章节可能出现多条候选依据，所以追加 index 保证 key 稳定。
                                key={`${source.source_file}-${source.section}-${index}`}
                              >
                                <div className="mb-1 flex flex-wrap gap-2">
                                  <span className="rounded bg-[#e9f2ff] px-2 py-0.5 text-[#0969ff]">
                                    {source.layer || "未标注"}
                                  </span>
                                  <span>{source.module || "未标注"}</span>
                                  <span>{source.similarity.toFixed(4)}</span>
                                </div>
                                <div className="break-all font-medium">{source.source_file}</div>
                                <div className="mt-1 text-[#647399]">
                                  {source.section || "未标注章节"}
                                </div>
                                {source.reason ? (
                                  <div className="mt-2 rounded-md bg-white px-2 py-1 text-[#20345d]">
                                    支撑判断：{source.reason}
                                  </div>
                                ) : null}
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

            {/* 流式回答期间的阶段提示；真实 token 会直接写入上方 assistant 消息。 */}
            {activeConversationLoading ? (
              <article className="py-5">
                <div className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-2 text-sm text-[#647399] shadow-sm">
                  <span className="size-2 animate-pulse rounded-full bg-[#0969ff]" />
                  {activeConversationStageLabel || "正在检索知识库并生成回答..."}
                </div>
              </article>
            ) : null}
            <div ref={bottomAnchorRef} />
          </section>
        )}
      </div>

      {/* 底部固定输入区：父组件负责状态，这里只触发输入变化和提交。 */}
      <div className="shrink-0 px-5 pb-5">
        <div className="mx-auto w-full max-w-5xl">
          {/* 接口或流式过程失败时展示错误，避免用户只看到无响应。 */}
          {error ? (
            <div className="mb-3 rounded-lg border border-[#fecaca] bg-[#fef2f2] px-4 py-3 text-sm text-[#991b1b]">
              {error}
            </div>
          ) : null}

          <form
            className="rounded-lg border border-[#9fc5ff] bg-white/90 p-3 shadow-[0_18px_60px_rgba(9,105,255,0.14)] backdrop-blur"
            onSubmit={onSubmit}
          >
            <div className="flex gap-3">
              <textarea
                aria-label="输入装修问题"
                className="max-h-36 min-h-20 flex-1 resize-none bg-transparent px-2 py-2 text-[15px] leading-7 text-[#091b3d] outline-none placeholder:text-[#7d8db3]"
                onChange={(event) => onInputChange(event.target.value)}
                // Enter 直接发送，Shift + Enter 保留换行，符合聊天产品常见输入习惯。
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    if (canSubmit) {
                      onSubmit();
                    }
                  }
                }}
                placeholder="询问装修预算、合同、施工、验收、售后问题..."
                value={input}
              />
              <button
                aria-label="发送问题"
                className={
                  // 按钮三种状态：生成中、可提交、不可提交。
                  activeConversationLoading
                    ? "mt-auto grid size-12 shrink-0 cursor-not-allowed place-items-center rounded-full bg-[#e8f0ff] text-[#7f96c4] shadow-none transition"
                    : canSubmit
                      ? "mt-auto grid size-12 shrink-0 place-items-center rounded-full bg-[#0969ff] text-white shadow-[0_12px_30px_rgba(9,105,255,0.32)] transition hover:bg-[#005bed]"
                      : "mt-auto grid size-12 shrink-0 cursor-not-allowed place-items-center rounded-full bg-[#eef4ff] text-[#9fb2d6] shadow-none transition"
                }
                disabled={!canSubmit}
                type="submit"
              >
                ↑
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  );
}
