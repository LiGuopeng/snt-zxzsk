const DEFAULT_OUTPUTS = ["全屋高清效果图", "空间视角图", "方案说明", "材料建议"];

export function DesignWorkspace() {
  return (
    <section className="grid min-h-0 flex-1 gap-4 overflow-hidden p-4 lg:grid-cols-[minmax(0,1fr)_300px] xl:grid-cols-[minmax(0,1fr)_330px]">
      <div className="flex min-w-0 flex-col gap-4 overflow-y-auto pr-1">
        <section className="rounded-lg border border-[#d9e4f7] bg-white p-4 shadow-[0_10px_30px_rgba(22,56,117,0.06)]">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-[#16213d]">
                户型图 <span className="text-[#ef3349]">（必传）*</span>
              </div>
              <div className="mt-1 text-xs text-[#7685a5]">
                生成全屋效果图前必须上传，用于识别空间比例、房间数量和动线。
              </div>
            </div>
            <span className="rounded-full bg-[#fff4e5] px-2.5 py-1 text-xs font-medium text-[#b76a00]">
              待上传
            </span>
          </div>

          <div className="grid gap-3 lg:grid-cols-[320px_minmax(0,1fr)]">
            <div className="flex min-h-24 items-center gap-3 rounded-lg border border-dashed border-[#b8cdf5] bg-[#f7fbff] p-3">
              <div className="grid h-20 w-24 shrink-0 grid-cols-3 grid-rows-3 gap-1 rounded-md border border-[#c9d8ef] bg-white p-1">
                <div className="col-span-2 rounded bg-[#eaf1fb]" />
                <div className="rounded bg-[#dce9f8]" />
                <div className="rounded bg-[#f2f6fc]" />
                <div className="col-span-2 rounded bg-[#e5eefb]" />
                <div className="col-span-3 rounded bg-[#eef4fc]" />
              </div>
              <div className="min-w-0">
                <button
                  className="h-9 rounded-md border border-[#8eb8ff] bg-white px-3 text-sm font-medium text-[#0969ff] transition hover:bg-[#eef6ff]"
                  type="button"
                >
                  上传户型图
                </button>
                <div className="mt-2 text-xs leading-5 text-[#ef3349]">
                  生成全屋效果图前必须上传
                </div>
              </div>
            </div>

            <div className="flex items-center rounded-lg border border-[#d9e4f7] bg-white p-3">
              <div className="text-sm leading-6 text-[#667799]">
                上传后系统会自动解析户型、面积、空间数量和动线，再生成统一风格的全屋效果图。
              </div>
            </div>
          </div>

          <div className="mt-4 rounded-lg border border-[#d9e4f7] bg-[#fbfdff] p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-[#17233f]">AI 生成意图</div>
                <div className="mt-1 text-xs text-[#7685a5]">
                  用一句话描述偏好，系统会结合户型图自动补全风格、预算、色系和空间方案。
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {["户型待识别", "面积待识别"].map((item) => (
                  <span
                    className="rounded-full border border-[#d9e4f7] bg-white px-3 py-1 text-xs font-medium text-[#667799]"
                    key={item}
                  >
                    {item}
                  </span>
                ))}
              </div>
            </div>

            <div className="mt-4 rounded-lg border border-[#cfe0fb] bg-white p-3 shadow-[0_12px_30px_rgba(22,56,117,0.05)]">
              <textarea
                aria-label="描述全屋生成意图"
                className="h-24 w-full resize-none bg-transparent px-1 py-1 text-[15px] leading-7 text-[#17233f] outline-none placeholder:text-[#8b9ab6]"
                placeholder="比如：想要明亮通透的现代简约风，有小孩，希望耐脏好打理，预算中等"
              />
              <div className="mt-3 flex flex-wrap items-end justify-between gap-3 border-t border-[#edf2fa] pt-3">
                <div className="min-w-0 flex-1">
                  <div className="mb-2 text-xs font-medium text-[#6b7894]">示例需求</div>
                  <div className="flex flex-wrap gap-2">
                    {[
                      "现代简约 · 明亮通透 · 有小孩",
                      "奶油风 · 温柔耐看 · 收纳多",
                      "原木风 · 自然放松 · 预算中等",
                    ].map((example) => (
                      <button
                        className="rounded-full border border-[#d9e4f7] bg-[#f8fbff] px-3 py-1.5 text-xs font-medium text-[#42557d] transition hover:border-[#8eb8ff] hover:bg-[#eef6ff] hover:text-[#0969ff]"
                        key={example}
                        type="button"
                      >
                        {example}
                      </button>
                    ))}
                  </div>
                </div>
                <button
                  className="h-10 cursor-not-allowed rounded-lg bg-[#b8c7df] px-5 text-sm font-semibold text-white shadow-none"
                  disabled
                  type="button"
                >
                  生成全屋效果图
                </button>
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-lg border border-[#d9e4f7] bg-white p-4 shadow-[0_10px_30px_rgba(22,56,117,0.06)]">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-[#17233f]">全屋效果图方案</h2>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                <span className="font-semibold text-[#17233f]">等待生成</span>
                {["需先上传户型图", "自动解析空间", "生成全屋方案"].map((chip) => (
                  <span className="rounded-md bg-[#eef4ff] px-2 py-1 text-xs font-medium text-[#48628c]" key={chip}>
                    {chip}
                  </span>
                ))}
              </div>
            </div>
            <button
              className="h-9 rounded-lg border border-[#d7e3f5] px-3 text-sm font-medium text-[#445779] transition hover:bg-[#f7fbff]"
              type="button"
            >
              查看生成记录
            </button>
          </div>

          <div className="grid min-h-[420px] place-items-center rounded-lg border border-dashed border-[#bfd1ee] bg-[#f8fbff] px-6 py-12 lg:min-h-[500px]">
            <div className="w-full max-w-xl text-center">
              <div className="mx-auto grid h-24 w-24 place-items-center rounded-2xl border border-[#d9e4f7] bg-white shadow-[0_16px_40px_rgba(22,56,117,0.08)]">
                <svg aria-hidden="true" className="size-11 text-[#0969ff]" fill="none" viewBox="0 0 24 24">
                  <path
                    d="M4 5h16v14H4zM8 15l2.6-3 2 2.2 1.8-1.8L18 16M8 9h.01"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.8"
                  />
                </svg>
              </div>
              <h3 className="mt-6 text-xl font-semibold text-[#17233f]">上传户型图后生成全屋效果图</h3>
              <p className="mx-auto mt-3 max-w-md text-sm leading-7 text-[#667799]">
                系统会先解析户型结构，再按默认风格和你的补充需求生成全屋方案。这里不会展示假效果图，避免和真实结果混淆。
              </p>
              <div className="mt-6 grid gap-3 text-left sm:grid-cols-3">
                {["户型解析", "全屋生成", "多视角预览"].map((step, index) => (
                  <div className="rounded-lg border border-[#d9e4f7] bg-white p-3" key={step}>
                    <div className="text-xs font-semibold text-[#0969ff]">0{index + 1}</div>
                    <div className="mt-2 text-sm font-medium text-[#17233f]">{step}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap justify-center gap-3">
            {["保存全屋方案", "导出方案", "用知识库检查全屋方案"].map((action) => (
              <button
                className="h-10 cursor-not-allowed rounded-lg border border-[#d9e4f7] bg-[#f8fafc] px-6 text-sm font-medium text-[#97a5bd]"
                disabled
                key={action}
                type="button"
              >
                {action}
              </button>
            ))}
          </div>
        </section>

        <section className="rounded-lg border border-[#d9e4f7] bg-white px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-[#17233f]">全屋方案检查结果</div>
              <div className="mt-1 text-xs text-[#7d8aa6]">生成后可展开查看施工、材料、预算风险</div>
            </div>
            <button className="grid size-8 place-items-center rounded-lg text-[#42557d] hover:bg-[#f4f7fc]" type="button">
              ˄
            </button>
          </div>
        </section>
      </div>

      <aside className="flex min-h-0 flex-col gap-4 overflow-y-auto rounded-lg border border-[#d9e4f7] bg-white p-4 shadow-[0_10px_30px_rgba(22,56,117,0.06)]">
        <h2 className="text-base font-semibold text-[#17233f]">户型解析</h2>
        <div className="border-t border-[#edf2fa] pt-4">
          <div className="mb-3 text-sm font-medium text-[#42557d]">识别结果</div>
          <div className="grid gap-3 text-sm">
            {[
              ["户型", "待上传后识别"],
              ["面积", "待上传后识别"],
              ["空间", "待上传后识别"],
              ["动线", "待上传后识别"],
            ].map(([label, value]) => (
              <div className="rounded-lg bg-[#f7fbff] p-3" key={label}>
                <div className="text-xs text-[#7d8aa6]">{label}</div>
                <div className="mt-1 leading-6 text-[#17233f]">{value}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="border-t border-[#edf2fa] pt-4">
          <div className="mb-3 text-sm font-medium text-[#42557d]">生成规则</div>
          <div className="rounded-lg border border-[#d9e4f7] bg-white p-3 text-xs leading-6 text-[#667799]">
            系统按户型图自动识别空间并生成全屋方案，默认保持户型结构、统一全屋风格和色系。
          </div>
        </div>

        <div className="border-t border-[#edf2fa] pt-4">
          <div className="mb-3 text-sm font-medium text-[#42557d]">生成队列</div>
          <div className="rounded-lg border border-dashed border-[#cddbf0] bg-[#f8fbff] p-3 text-xs leading-6 text-[#667799]">
            上传户型图并点击生成后，会按解析出的空间自动创建生成任务。
          </div>
        </div>

        <div className="border-t border-[#edf2fa] pt-4">
          <div className="mb-3 text-sm font-medium text-[#42557d]">输出</div>
          <div className="grid gap-2 text-sm text-[#17233f]">
            {DEFAULT_OUTPUTS.map((item) => (
              <div className="flex items-center gap-2" key={item}>
                <span className="size-1.5 rounded-full bg-[#0969ff]" />
                {item}
              </div>
            ))}
          </div>
        </div>

        <div className="mt-auto rounded-lg border border-[#b8d2ff] bg-[#f7fbff] p-4">
          <div className="text-sm font-semibold text-[#17233f]">知识库检查</div>
          <div className="mt-2 text-xs leading-5 text-[#667799]">
            基于装修知识库检查全屋方案的施工、材料、预算风险。
          </div>
          <button className="mt-3 h-10 w-full rounded-lg border border-[#8eb8ff] bg-white text-sm font-semibold text-[#0969ff] transition hover:bg-[#eef6ff]" type="button">
            检查当前全屋方案
          </button>
        </div>
      </aside>
    </section>
  );
}
