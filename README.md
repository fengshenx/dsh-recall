# dsh-recall

English: [README_EN.md](./README_EN.md)

DSH 插件：为模型提供 **`recall` 工具**——搜索并读取**调用代理自己的会话日志**，包括被压缩（compaction）遮蔽的事件。

压缩从不删除事件：它把一段可见历史替换成摘要检查点（checkpoint），被替换的事件仍留在持久日志中，分类为 `shadowed`。`recall` 就是模型回到那段内容的正式途径——`surfaces: ["shadowed"]` 逐字取回压缩前内容，`seq` 读取任意精确事件。

## 安装

前置：DSH（`dsh web` 可正常运行）、Node.js ≥ 20、pnpm ≥ 10（`dsh plugin` 命令需要）。插件发布在 npm，一条命令安装并自动挂载：

```sh
dsh plugin --profile web add dsh-recall
```

`dsh plugin add` 会在 profile 目录安装 npm 包，并因包内声明了 `dsh.bundle.patch` 而自动把插件注册进 `dsh.profile.bundles`——**下次启动自动挂载，无需手动改任何配置文件**。

`recall` 是 host 侧工具，挂载需要重启一次：

```sh
# 重启 dsh web（视你的启动方式而定）
# 例如：pm2 restart dsh-web，或 Ctrl+C 后重新 dsh web
```

### 卸载

```sh
dsh plugin --profile web remove dsh-recall
```

## 使用

重启后，模型（如我）的工具列表里会出现 `recall`。示例调用：

```
recall { query: "Agent/Sub Agent有能力回忆 压缩", max_results: 10 }
```

返回压缩前被遮蔽的原始消息，逐字可读。参数：

| 参数 | 说明 |
|---|---|
| `query` | **必填**：空格分隔的多关键词，事件需同时包含全部关键词（不区分大小写）才匹配 |
| `max_results` | 可选：最多返回的命中条数（1-10，默认 10，内部上限 10） |
| `surfaces` | 可选：只返回指定表面分类的事件（`current` / `shadowed` / `log-only`），省略则全表面 |

命中按相关度排序逐行输出：`#seq 类型 [表面] (time): 内容`，行与行之间没有额外的上下文事件——长事件本身的内容由命中位置窗口保证（见下）。

- **相关度排序**：长词（稀有）与出现密度高的命中靠前，同分时新的优先；中文长词按 2-4 字片段兜底匹配——压缩改写导致长句原文不连续时仍能召回
- **长事件截断**：只保留命中位置附近的内容（以命中为中心各取一半预算），超出部分标注「…(省略N字符)…」
- **匹配归一化**：NFKC + 小写；查询不含全角/组合字符时走纯小写快路径（此时事件里的全角变体如 ＡＢＣ 不再匹配 `abc`）
- `query` 最长 200 字符，超出会报错
- 会话从未压缩时，搜索返回提示而非结果列表（早期内容都在当前上下文里）

设计要点：只读调用者**自己的**会话日志，无跨会话访问；当前 step 的事件总是排除；fork 子会话继承父日志前缀，因此也能回忆父历史。

## 配置

`maxResults`（每次调用命中数上限）与 `maxCharsPerEvent`（每个事件文本字符上限，默认 20000）为必填部署配置，可在挂载行的 `config` 中调整。

## 开发

```sh
pnpm install
pnpm build        # tsc 出类型 + tsdown 出 lib/
pnpm test         # vitest（含真实 Loader 组合测试）
npm pack --dry-run  # 检查发布内容
```

## 本地调试（未发布 npm 时）

`dsh plugin` 支持本地路径，安装为 `link:` 符号链接（源码实时指向插件目录）：

```sh
dsh plugin --profile web add /Users/<you>/<path>/dsh-recall
```

它会自动完成两件事：把包加入 profile 的 `dsh.profile.bundles`，并在启动时应用插件自带的 `cordis.patch.yml`。之后：

1. 如果 profile 的 `cordis.patch.yml` 里有旧的 manual 挂载行（同一 `tool-recall` id），删掉它，否则重复插入冲突；
2. 重启 web server，`dsh --profile web --dump-config` 应显示 `# == dsh-recall` 段；
3. 每次改 `src/` 后 `pnpm build` 再重启 web server 生效（无需重新 `plugin add`）。

## 工作原理简述

- 插件是普通 npm 包：`dsh.bundle.patch` 声明（`cordis.patch.yml`）+ 标准插件行。
- `dsh plugin add` 的 bundle 协调（DSH `apps/cli/src/plugin.ts`）：安装后检查包是否声明 `dsh.bundle`，是则追加进 profile 的 `dsh.profile.bundles`；启动时作为 patch 层自动合并。
- 运行时：`recall` 通过 `exec.agent.session.events` 读取调用者自己的完整事件日志，surface 分类复用 `@deepseek-ai/dsh-session-query` 的 `buildSessionEventRecords`（与官方 session-query 工具同一套词汇）。

## License

MIT
