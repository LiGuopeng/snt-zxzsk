import { FormEvent } from "react";

type Source = {
  source_file: string;
  section: string | null;
  layer: string | null;
  module: string | null;
  similarity: number;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
};

type ChatWorkspaceProps = {
  activeConversationLoading: boolean;
  canSubmit: boolean;
  error: string;
  exampleQuestions: string[];
  input: string;
  messages: ChatMessage[];
  onInputChange: (value: string) => void;
  onSubmit: (event?: FormEvent<HTMLFormElement>, presetQuestion?: string) => void;
};

export function ChatWorkspace({
  activeConversationLoading,
  canSubmit,
  error,
  exampleQuestions,
  input,
  messages,
  onInputChange,
  onSubmit,
}: ChatWorkspaceProps) {
  const hasMessages = messages.length > 0;

  return (
    <>
      <div className="flex-1 overflow-y-auto">
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
                直接描述房子、阶段、报价、合同或现场现象。我会先检索你的装修知识库，再给出简洁建议和参考来源。
              </p>

              <div className="mt-8 grid w-full gap-3 sm:grid-cols-2">
                {exampleQuestions.map((question, index) => (
                  <button
                    className="group flex min-h-20 items-center gap-4 rounded-lg border border-[#d8e6ff] bg-white/82 p-4 text-left shadow-[0_14px_36px_rgba(38,96,190,0.07)] transition hover:border-[#8ebcff] hover:bg-white"
                    key={question}
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
                        <div className="mb-1 text-right text-sm font-semibold text-[#091b3d]">你</div>
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
                        <details className="mt-4 rounded-lg border border-[#d8e6ff] bg-white/80 p-3">
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
                                <div className="break-all font-medium">{source.source_file}</div>
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
                <div className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-2 text-sm text-[#647399] shadow-sm">
                  <span className="size-2 animate-pulse rounded-full bg-[#0969ff]" />
                  正在检索知识库并生成回答...
                </div>
              </article>
            ) : null}
          </section>
        )}
      </div>

      <div className="shrink-0 px-5 pb-5">
        <div className="mx-auto w-full max-w-5xl">
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
