# dsh-recall

English: [README_EN.md](./README_EN.md)

DSH 插件：为模型提供 **`recall` 工具**——搜索并读取**调用代理自己的会话日志**，包括被压缩（compaction）遮蔽的事件。

压缩从不删除事件：它把一段可见历史替换成摘要检查点（checkpoint），被替换的事件仍留在持久日志中，分类为 `shadowed`。`recall` 就是模型回到那段内容的正式途径——`surfaces: ["shadowed"]` 逐字取回压缩前内容，`seq` 读取任意精确事件。

## 安装

前置：DSH（`dsh web` 可正常运行）、Node.js ≥ 20、pnpm ≥ 10（`dsh plugin` 命令需要）。

### 方式一（推荐）：官方 CLI 一条命令

```sh
dsh plugin --profile web add dsh-recall
```

`dsh plugin add` 会在 profile 目录安装 npm 包，并因包内声明了 `dsh.bundle.patch` 而自动把插件注册进 `dsh.profile.bundles`——**下次启动自动挂载，无需手动改任何配置文件**。

`recall` 是 host 侧工具，挂载需要重启一次：

```sh
# 重启 dsh web（视你的启动方式而定）
# 例如：pm2 restart dsh-web，或 Ctrl+C 后重新 dsh web
```

### 方式二：手动 npm 安装 + 挂载行

```sh
cd ~/.dsh/profiles/web
npm i dsh-recall
```

然后在 `~/.dsh/profiles/web/cordis.patch.yml` 加入：

```yaml
- insert:
    - id: tool-recall
      name: 'dsh-recall'
      config:
        maxResults: 25
        maxCharsPerEvent: 3000
```

重启 `dsh web`。注意：方式一和方式二**二选一**，同时使用会双挂载。

### 从 GitHub 安装（不发布到 npm）

```sh
dsh plugin --profile web add github:fengshenx/dsh-recall
# 或
cd ~/.dsh/profiles/web && npm i github:fengshenx/dsh-recall
```

包内 `prepare` 脚本会在安装时自动构建（需要 Node 环境）。

### 卸载

```sh
dsh plugin --profile web remove dsh-recall
```

## 使用

重启后，模型（如我）的工具列表里会出现 `recall`。示例调用：

```
recall { query: "Agent/Sub Agent有能力回忆", surfaces: ["shadowed"] }
```

返回压缩前被遮蔽的原始消息，逐字可读。参数：

| 参数 | 说明 |
|---|---|
| `query` | 对事件文本的不区分大小写字面子串（与 `seq` 互斥） |
| `seq` | 按 seq 精确读取某事件，可加 `window` 取邻居 |
| `window` | 配合 `seq`：前后各取多少条事件 |
| `event_types` | 按事件类型过滤（如 `user/message`、`compaction/summary`） |
| `surfaces` | `current`（模型可见）/ `shadowed`（被压缩替换）/ `log-only`（从未上模型表面） |
| `seq_from` / `seq_to` | seq 范围过滤 |
| `limit` | 返回上限（受部署配置 `maxResults` 收敛） |

设计要点：只读调用者**自己的**会话日志，无跨会话访问；当前 step 的事件总是排除；fork 子会话继承父日志前缀，因此也能回忆父历史。

## 配置

`maxResults`（每次调用返回事件数上限）与 `maxCharsPerEvent`（每个事件文本字符上限）为必填部署配置，可在挂载行的 `config` 中调整。

## 开发

```sh
pnpm install
pnpm build        # tsc 出类型 + tsdown 出 lib/
pnpm test         # vitest（含真实 Loader 组合测试）
npm pack --dry-run  # 检查发布内容
```

## 发布

```sh
# 发布到 npm（名字 dsh-recall 当前可用）
npm publish
```

或仅推 GitHub：推送后用户按上面"从 GitHub 安装"即可。

## 工作原理简述

- 插件是普通 npm 包：`dsh.bundle.patch` 声明（`cordis.patch.yml`）+ 标准插件行。
- `dsh plugin add` 的 bundle 协调（DSH `apps/cli/src/plugin.ts`）：安装后检查包是否声明 `dsh.bundle`，是则追加进 profile 的 `dsh.profile.bundles`；启动时作为 patch 层自动合并。
- 运行时：`recall` 通过 `exec.agent.session.events` 读取调用者自己的完整事件日志，surface 分类复用 `@deepseek-ai/dsh-session-query` 的 `buildSessionEventRecords`（与官方 session-query 工具同一套词汇）。

## License

MIT
