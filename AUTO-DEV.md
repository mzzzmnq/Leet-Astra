# 自动开发循环 · 使用说明

用 `auto-dev.ps1` 把 `TASKS.md` 里的任务逐条交给 OpenCode 执行,每条任务自动验证、自动提交。
一次只做一条,失败就回滚,不阻塞后面的任务。

```
TASKS.md ──► auto-dev.ps1 ──► opencode run --auto ──► 改代码
                  │                                     │
                  │◄─────────── 有文件改动? ────────────┘
                  │                 │ 没有 → 判失败
                  │
                  └──► 验证命令(退出码 0?)
                            │ 通过                │ 不通过
                    commit(含 [x])          回滚 + commit [!]
```

## 前置条件

- 已安装并登录 OpenCode(`opencode` 在 PATH 里)
- 目标仓库是 git 仓库、工作区干净
- 项目配置 `opencode.jsonc` 已存在(含无人值守 `deny` 护栏 + `auto-dev` agent)

## 怎么跑

```powershell
cd "D:\Leet Astra"

# 1. 先看它打算发什么,不调用模型
.\auto-dev.ps1 -DryRun

# 2. 只跑一条,人盯完
.\auto-dev.ps1 -MaxRounds 1

# 3. 确认行为符合预期后再放开
.\auto-dev.ps1 -MaxRounds 10

# 4. 跑完看结果
git --no-pager log --oneline -n 10
git --no-pager diff main..auto/dev --stat
```

常用参数:

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `-Repo` | 当前目录 | 目标仓库 |
| `-Tasks` | `TASKS.md` | 任务清单 |
| `-Verify` | `node --check openleet.user.js; node --test` | 验证命令,退出码 0 即通过 |
| `-Model` | `opencode-go/deepseek-v4.1-flash` | 换模型只改这里 |
| `-Agent` | `auto-dev` | 传空串则用默认 primary agent |
| `-MaxRounds` | `5` | 本条命令最多做几条任务 |
| `-Retries` | `1` | 验证失败后重试几次(会把失败输出喂回去) |
| `-Branch` | `auto/dev` | 工作分支 |
| `-DryRun` | 关 | 只打印 prompt |
| `-NoAuto` | 关 | 不传 `--auto`(会因无人应答权限请求而卡住,基本只用于排查) |
| `-AllowNoOp` | 关 | 允许「模型一个文件都没改」也算通过 |

## 任务清单格式

```markdown
- [ ] 任务描述,越具体越好
- [x] 已完成(脚本自动勾)
- [!] 验证失败的,人工确认后改回 - [ ] 可重跑
```

脚本只认行首的 `- [ ] `,段落文字随便写。**第一条任务描述本身就是 prompt**,所以:
把文件路径、函数名、验收标准写进去,别写"优化一下代码"这种。

## 判据只有一条:验证命令

模型说"已完成"不算数,`$Verify` 退出码为 0 才算数。

这是整个循环里唯一可信的环节。换项目时第一件事就是把 `-Verify` 改成那个项目的真实门禁
(`go test ./...` / `npm test` / `cargo test` / `pytest -q`)。**没有自动化验证的项目不要放进这个循环** ——
你只会得到一堆看起来对、跑不起来的代码。

两条例外处理:

- **模型一个文件都没改** → 直接判失败,不跑验证命令。否则"验证命令恰好成立"会造成假阳性
  (例如验证是"文件 X 存在",而模型压根没干活)。
- **`node --test` 的 `not ok`** → 即使退出码为 0 也判失败。Node 测试跑在子进程里时退出码未必透传,
  所以脚本同时检查输出里有没有 `not ok`。

## 安全边界

| 风险 | 现在的处理 |
| --- | --- |
| 改坏仓库 | 每条任务一个 commit;验证不过 `git checkout -- .` + `git clean -fd` 整轮回滚 |
| 误推送 | `opencode.jsonc` 里 `git push *` 显式 `deny` |
| 改到不该改的 | `.github/`、`.env` 已 deny;agent 步数上限 40 |
| 越权访问磁盘 | 没开 `external_directory`,默认需要审批 |
| 无限跑 | `-MaxRounds` + agent `steps` |

`opencode run --auto` 会**自动批准所有未被显式 deny 的权限请求**。所以:

> 护栏必须写成 `deny`。写成 `ask` 在自动化里等于放行。

要临时手动 push,先把 `opencode.jsonc` 里 `git push *` 那一行删掉。

## 回滚

```powershell
# 丢掉当前分支上最后一次 auto-dev 提交
git reset --hard HEAD~1

# 或者整体放弃这个分支
git checkout main
git branch -D auto/dev
```

## 放大:多仓库并行烧额度

限额是按模型算的,所以并行时要**每个仓库配不同模型**,否则一起撞同一堵 5 小时墙。

```powershell
$jobs = @(
  @{ Repo = "D:\work\repo-a"; Model = "opencode-go/kimi-k3";     Verify = "go test ./..." },
  @{ Repo = "D:\work\repo-b"; Model = "opencode-go/qwen3.8-max"; Verify = "npm test" },
  @{ Repo = "D:\work\repo-c"; Model = "opencode-go/grok-4.7";    Verify = "cargo test" },
  @{ Repo = "D:\work\repo-d"; Model = "opencode-go/glm-5.3";     Verify = "pytest -q" }
)

$jobs | ForEach-Object {
  Start-Process pwsh -ArgumentList @(
    "-NoProfile", "-File", "D:\Leet Astra\auto-dev.ps1",
    "-Repo", $_.Repo, "-Model", $_.Model, "-Verify", $_.Verify, "-MaxRounds", "20"
  )
}
```

注意:每个目标仓库都要有自己的 `opencode.jsonc` 护栏,否则 `--auto` 在那边等于全放行。

## 已知限制

- `opencode run` 每次是**独立会话**,不共享上下文。任务之间要靠 `TASKS.md` 和代码本身传递状态。
- 验证失败的重试只带**验证输出**,不带上一轮的对话,所以重试不是"接着上次想",而是重新做一遍。
- 脚本假设任务之间**互不冲突**。并行运行多个实例操作同一个仓库会互相踩,单仓库请串行。
- `TASKS.md` 的文件编码固定用 UTF-8;用别的编辑器改过之后如果出现乱码,重存成 UTF-8。
