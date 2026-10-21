# Leet Astra 自动化任务清单

`auto-dev.ps1` 每次只取**第一条未勾选**的任务交给模型执行。

- 任务 = `- [ ]` 那一行(标题) **加上它到下一个任务之间的全部正文** —— 所以正文写得越具体,模型做得越准。
- 验证通过 → 自动提交并勾成 `- [x]`。
- 验证失败 → 回滚整轮改动,标成 `- [!]`。人工确认后改回 `- [ ]` 即可重跑。

约定:

- 一条任务 = 一次 `opencode run`,禁止"顺手做别的"。
- 每条任务必须能靠 `node --check openleet.user.js` + `node --test` 自动判定成败。
- 涉及行为的改动**必须带测试**,否则不算完成。

---

- [ ] T1 上下文截断时给出显式提示

**文件**:`openleet.user.js`(`buildSystem()` 约 951–966 行,`renderProblemChip()` 约 920–942 行)

**现状**:`buildSystem()` 对题目描述和代码各做一次 `.slice(0, 8000)`,静默截断,发送方和 UI 都看不出内容被裁过。README「已知限制」已列出这一点。

**要做**:

1. 抽出常量 `const CONTEXT_LIMIT = 8000;`,替换两处魔法数字。
2. 计算 `descriptionTruncated` / `codeTruncated`(比较原文长度与上限)。
3. 截断时在 system 文本里加一行明确说明,例如 `【注意】题目描述超过 8000 字符,已按前 8000 字符截断`,代码同理。
4. `readProblem()` 的返回值带上这两个布尔标记,并在题目 chip(`renderProblemChip`)里显示 `题面已截断` / `代码已截断`。
5. 在 `tests/` 下新增测试:直接调用 `buildSystem`,断言 (a) 未超限时**不含**截断提示且全文保留;(b) 超限时**含**截断提示且送入模型的长度不超过上限。

**验收**:`node --check openleet.user.js` 通过;`node --test` 全绿,且新增至少 2 条断言。

---

- [ ] T2 SSE 分帧兼容 CRLF

**文件**:`openleet.user.js`(`directChat()` 约 490–518 行)

**现状**:用 `buffer.indexOf("\n\n")` 找事件边界、再 `chunk.split("\n")` 拆行,只认 LF。上游若用 CRLF 分帧,整条流会一直攒在 buffer 里,直到 `onload` 才靠整体 JSON 兜底,表现就是 README 说的"没有逐字显示回答"。

**要做**:

1. 把分帧逻辑抽成可测试的纯函数,例如 `function createSseParser(onEvent) { ... return { push(text) { ... } }; }`:
   - 事件分隔同时接受 `\r\n\r\n` 和 `\n\n`;
   - `data:` 行解析时容忍行尾的 `\r`;
   - 分块边界落在分隔符中间时不能丢事件(buffering 要跨 `push` 保留)。
2. `directChat()` 改用它,`onDelta` / `onReasoning` / `error` 的现有行为保持不变。
3. 新增测试:(a) 同一段流的 LF 版和 CRLF 版解析出的 delta 序列完全一致;(b) 把同一段流按 1 字节切块逐个 `push`,结果仍一致;(c) 含 `data: [DONE]` 和空行的事件被正确跳过。

**验收**:`node --check openleet.user.js` 通过;`node --test` 全绿且新增测试全部通过。

---

- [ ] T3 LeetNote 导入阻止不完整代码

**文件**:`openleet.user.js`(`importToLeetNote()` 约 1087–1121 行)

**现状**:只要 `problem.code` 非空就 push 进 `solutions`,完全没看 `problem.codeIncomplete`。DOM 降级读到的片段会被当成完整解法存进笔记。README「已知限制」第 2 条就是这个。

**要做**:

1. `problem.codeIncomplete === true` 时**不发请求**:在面板里给出明确错误说明,内容要包含:
   - 这是从编辑器 DOM 降级读到的片段,不是完整代码;
   - 处理办法:把完整代码手动复制到聊天输入框,或在题目页点一下真实编辑器后重新「读取题目」。
2. 允许显式覆盖:新增配置项 `cfg.allowIncompleteExport`(默认 `false`),为 `true` 时才放行并照常导出。不需要加设置 UI,但在提示文案里说明这个开关。
3. 新增测试:(a) `codeIncomplete = true` 且开关为 `false` 时**不调用** `gmFetch`;(b) 开关为 `true` 时正常调用,且请求体里带上了片段代码。

**验收**:`node --check openleet.user.js` 通过;`node --test` 全绿。

---

- [ ] T4 对齐 OpenCode Go 模型候选

**文件**:`openleet.user.js`(`OPENCODE_MODELS` 约 147–173 行)

**现状**:有 5 个条目已不在 OpenCode Go 官方模型列表中:`glm-5.1`、`glm-5`、`kimi-k2.5`、`mimo-v2-pro`、`mimo-v2-omni`。官方列表里走 OpenAI 兼容 `/chat/completions` 的项,脚本现在一个不缺。

**要做**:

1. 删掉上述 5 个过期条目。
2. 在数组上方加注释,写明这是**静态快照**,给出核对方式 `curl https://opencode.ai/inference/go/v1/models`,并标注该注释的日期。
3. 新增测试:把官方 `/chat/completions` 模型 id 写成白名单,断言 `OPENCODE_MODELS` 中每一项的 `id` 都在白名单内(防止以后再塞进已下线的模型)。白名单需包含:`glm-5.3-flash`、`glm-5.3`、`glm-5.2`、`kimi-k3`、`kimi-k2.7-code`、`kimi-k2.6`、`longcat-2.0`、`longcat-2.5-preview-free`、`step-5-preview-free`、`deepseek-v4.1-flash`、`deepseek-v4-pro`、`deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`、`mimo-v2.6-flash`、`mimo-v2.6-pro`、`mimo-v2.5`、`mimo-v2.5-pro`、`hy4-preview`、`hy3`、`space-bunny`。

**验收**:`node --check openleet.user.js` 通过;`node --test` 全绿;源码里搜不到那 5 个过期 id。

---

- [ ] T5 README 全量更新到 2.4.0,并加文档一致性检查

**文件**:`README.md`、新增 `tests/docs.test.cjs`

**现状**:README 停留在 **2.3.1**,与代码严重不符:

- 说「聊天记录保存在当前页面内存中,刷新后不会恢复」—— 实际已按题目持久化(见 `tests/conversation.test.cjs`),还会保存草稿;
- 「项目结构」只列了 `tests/reader.test.cjs`,漏了 `conversation.test.cjs` 和 `conversation-harness.cjs`;
- 说「当前 8 项测试」—— 实际 `node --test` 跑出 **19 项**;
- 文档给的 `node --test tests/reader.test.cjs` 只跑其中 8 项,而 `node --test tests/` 在 Node 22 上会报 `Cannot find module`;
- 缺少 2.4.0 的版本记录条目。

**要做**:

1. 逐节核对并更新 README:版本号、聊天持久化行为(含草稿、按题目隔离、`pagehide` / `visibilitychange` 落盘)、项目结构、测试数量与正确命令(`node --test`,不带路径)、版本记录补 2.4.0。
2. 新增 `tests/docs.test.cjs`,用 Node 内置测试断言:
   (a) README 中出现的版本号与脚本头部 `@version` 一致;
   (b) README「项目结构」里列出的 `tests/` 文件与磁盘实际文件一致;
   (c) README 里不出现已知失效的测试命令写法 `node --test tests/`(不带具体文件名的那种)。
3. 确认 README 正文里不再出现「刷新后不会恢复」这类与现状相反的说法。

**验收**:`node --check openleet.user.js` 通过;`node --test` 全绿且包含新增的 `docs.test.cjs`。
