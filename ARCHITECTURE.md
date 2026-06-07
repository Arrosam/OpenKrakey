# OpenKrakey 架构设计

> **状态**：设计定稿（v1.0，全仓重写起点）。**栈**：TypeScript + Node.js（npm；测试经 tsx）。**许可**：MIT。
> **前身**：[`Arrosam/KrakeyBot`](https://github.com/Arrosam/KrakeyBot)（Python）——因缺乏规划、抽象反复重切而成"屎山"。OpenKrakey 从零重做。

---

## 0. 一句话定位

> **内核是一个领域无关的「时间驱动 + 非阻塞 + 插件化」运行时。"Agent" 是一个独立实例，由一组插件跑在心跳上涌现出行为。** 内核不知道什么是 LLM、prompt、记忆——这些都在插件里。

---

## 1. 设计原则

| # | 原则 | 含义 |
|---|------|------|
| P1 | **时间驱动 · 非阻塞** | 每个 Agent 有自己的心跳；工具调用异步甩出、永不阻塞输入；新消息/工具结果折叠进下一拍。 |
| P2 | **一切皆插件** | LLM、记忆、prompt/context 块、工具、通道……全是插件。 |
| P3 | **Agent 即独立实例** | 每个 Agent 自带 clock / event-system / orchestrator / loader / 插件 / 数据，互相隔离；可并发多个。 |
| P4 | **最小耦合** | 模块与插件之间只经 **event-system** 沟通（事件 + 动作），不互相 import 实现。 |
| P5 | **职责单一** | 见 §3——每个模块只做一件事，边界清晰（这是本项目存在的理由）。 |
| P6 | **抗漂移** | 契约（L1）是唯一共享词汇；一组测试强制的不变量（§9）锁死边界。 |

---

## 2. 模块结构

```
┌──────────────────────────── 全局（运行时一份）────────────────────────────┐
│  boot  ——只负责启动：读各 Agent 配置文件 → 拉起 Agent                       │
│  cli   ——独立的配置文件管理工具（UI）：按格式增改 Agent 配置 / Default 设置   │
│          （用户也可直接手改文件；显示 Krakey logo）                          │
└───────────────────────────────────────────────────────────────────────────┘
            │ 启动时按配置创建
            ▼
┌──────────── Agent 实例（每个一套，互相隔离，由 agent_instance 包裹）────────┐
│                                                                            │
│   agent_instance ——包裹一个 Agent：持有并连好下面四件，对外暴露 start/stop  │
│                                                                            │
│   ┌── event-system ──(独立中枢：eventbus + actionbus)──┐                    │
│   │      ▲          ▲              ▲           ▲        │                    │
│   │   clock      loader       orchestrator   插件…      │                    │
│   │  (发tick)  (注册插件)   (订阅/compose/dispatch)      │                    │
│   └──────────────────────────────────────────────────┘                    │
│                                                                            │
│   orchestrator 内部含 context-buffer（有序 context 块）                      │
└────────────────────────────────────────────────────────────────────────────┘
```

| 范围 | 模块 | 一句话 |
|------|------|--------|
| 全局 | **boot** | 启动器 |
| 全局 | **cli** | 配置文件管理 UI（独立工具） |
| 每 Agent | **agent_instance** | 包裹一个 Agent（门面/容器） |
| 每 Agent | **orchestrator** | 指挥（内含 context-buffer） |
| 每 Agent | **event-system** | 独立中枢总线（事件 + 动作） |
| 每 Agent | **clock** | 哑计时器 |
| 每 Agent | **loader** | 插件装卸 |

---

## 3. 各模块职责

### 全局

**boot** —— **只负责启动**。读取每个 Agent 个人文件夹下的配置文件（`agents/<id>/config.json`），为每个配置创建并启动一个 `agent_instance`。仅此而已（不做运行期管理）。

**cli** —— **独立的配置文件管理工具**（一种 User Interface）。方便用户按正确格式增/改/删 Agent 的配置文件、维护 **Default Plugin Setting**；新建 Agent 时以 Default 为模板复制。它**与运行时解耦**——用户完全可以手改文件代替它。启动显示 Krakey ASCII logo，持续交互。

### 每个 Agent 实例内

**agent_instance** —— **包裹一个 Agent**（门面）。持有并连好本 Agent 的 clock + event-system + orchestrator + loader；对外暴露 `start` / `stop`（及输入/输出）。`start()`：让 loader 装好插件 → 让 orchestrator 开始指挥；`stop()`：停 clock + 让 loader teardown。自己不含业务逻辑。

**orchestrator** —— **指挥**（per-Agent；**context-buffer 在它内部**）。五个职责：
1. 按各 context 块声明的**优先级**（`priority`，数字**大→小**，高的在最上）把各块 compose 成完整 context；
2. 经 event-system **暴露 eventbus**：插件注册进来、在特定事件下改 context 块——块按 **id 寻址**，任何插件都可改**别的插件**的块（如 A 改 B 的 `BBB`）；
3. **异步、不阻塞**地执行从 LLM 解析出的指令（工具调用）；
4. 经 event-system **维持 actionbus** 供插件被调用；
5. **协调时钟节奏**。
> 一拍（beat）：clock 发 tick → orchestrator compose 完整 context → 调 `llm.chat`（插件）→ 解析返回 → dispatch 工具调用（异步）。

**event-system** —— **独立的中枢总线**：`eventbus`（emit/on）+ `actionbus`（register/invoke）。clock、loader、orchestrator、各插件**都接到这里**来收发各类事件、注册可调用动作。保持独立，正是因为接入它的东西多。

**clock** —— **哑计时器**：自行倒数，到点只负责**激活**（经 event-system 发一个 tick）；不调度、不决定内容；节奏可被 orchestrator 调整（setInterval / fireNow）。

**loader** —— **插件装卸**（loader 只负责启动期 + 注册）：
- 构建时把 config 里 `privatePlugins` 声明的插件从 `public_plugin/` **复制**进本 Agent 的 `agents/<id>/plugins/`（已存在则不覆盖，保留其私有数据）；
- 加载：本 Agent 私有夹 `agents/<id>/plugins/` **整夹自动加载并覆盖**同名 public + config 声明的 public 插件；
- 给每个插件设好 `dataDir`、构建 PluginContext、调 `setup` **把插件注册进本 Agent 的 event-system**（动作/监听/context 块）；
- `stop` 时逐个 teardown。

---

## 4. 一拍的数据流（单个 Agent 内）

```
   插件 ──emit──▶ event-system(eventbus) ──▶ 插件按 id 增/改/删 context 块（在 orchestrator 的 context-buffer 里）
     ▲                                                          │
     │                                          clock 倒数到点 → 发 tick
     │                                                          ▼
     │                       orchestrator: compose 完整 context → invoke("llm.chat", ctx) ─▶ LLM 插件
     │                                                          │ (在途；不阻塞)
     │                                                          ▼
     │                              解析返回（response.parse 插件 / 默认）→ 动作[]
     └──invoke◀── event-system(actionbus) ◀── orchestrator 逐个 dispatch（工具异步甩出）
```

**时间并行 = 非阻塞**：工具调用异步执行；跑到一半时新输入/已回的工具结果都折叠进**下一拍**的完整 context 快照。每个 Agent 各跑各的（互不阻塞）。

---

## 5. 插件模型

**共享代码，而非共享单例**——每个 Agent 各自实例化插件；"共享 / 隔离"取决于插件把文件存到哪，而**数据目录跟着代码位置走**。

- **public 插件**：代码在 `public_plugin/<id>/`，所有声明它的 Agent 都从这里加载 → 它们的 `dataDir` 都指向**同一个** `public_plugin/<id>/data/` → 图书馆例子：A 存的知识 B 能读到（共享数据、各自独立实例）。
- **independent（私有）插件**：Agent 构建时把该插件代码**复制**进 `agents/<id>/plugins/<id>/` → `dataDir` 指向本 Agent 自己的 `data/` → 数据只此 Agent 可见，且**覆盖**同名 public。
- **PluginContext** 提供 `dataDir`（= 该插件代码目录下的 `data/`），插件读写文件/DB 都用它。
- 一个插件提供任意组合：**context 块**（带 `priority`，按 id 寻址）、**actions**（注册到 actionbus）、**listeners**（订阅 eventbus）。
- **context 块按 id 共享寻址**：块由注册它的插件维护，但任何插件都能按 id **请求增/改/删别的插件的块**（如 A 改 B 的 `BBB` 块）。
- **优先级 = 排序 + 缓存策略**：每块声明 `priority`（数字），orchestrator 按 **大→小** 渲染并排列（高的在最上）。约定：**固定/稳定**块（身份、系统提示）给**高优先级（10000+）置顶**——既好改、又让稳定前缀提升 prompt 缓存命中；**多变**块（history、工具结果）给**低优先级（0–10000）放下面**。

配置里：`plugins: string[]`（要加载的 public 插件）；`privatePlugins?: string[]`（要 independent 化、构建时复制进来的）。私有夹里已有的插件总是自动加载并覆盖同名 public。

---

## 6. 个人文件夹 / 配置 / cli

```
agents/<id>/                  # 一个 Agent 的"个人文件夹"
├─ config.json                # AgentDefinition（intervalMs / plugins / privatePlugins / config / persona…）
├─ plugins/<pid>/             # 私有插件代码（+ data/ 私有数据）
└─ data/ …                    # 该 Agent 的其它数据
public_plugin/<pid>/          # 共享插件代码（+ data/ 共享数据）
config/agent.default.json     # Default Plugin Setting（/new 以它为模板）
```

- **boot** 启动时读 `agents/*/config.json` 全部拉起。
- **cli** 是改这些文件的便捷工具：`/new <id>`（按 default 复制出 `agents/<id>/config.json`）、`/default`、增改插件声明等；用户也可直接手改。

---

## 7. 目录骨架（仓库）

```
OpenKrakey/
├─ package.json  tsconfig.json  LICENSE  .gitignore
├─ src/
│  ├─ contracts/        # L1 唯一共享词汇（纯类型 + 知名 action/event 名）
│  │   clock · event-system · context · plugin · orchestrator · agent · loader · index
│  ├─ core/             # 模块实现：boot · cli · agent-instance · orchestrator · event-system · clock · loader
│  └─ ...
├─ public_plugin/<id>/  # 共享插件（含示例 library）
├─ agents/<id>/         # 各 Agent 个人文件夹（config.json + plugins/ + data/）
├─ config/agent.default.json
└─ docs/                # 文档（含从 KrakeyBot 搬来的依赖图工具，待重做）
```

---

## 8. 契约（L1，纯类型）

`clock`、`event-system`(EventBus+ActionBus)、`context`(ContextBlock`{id,priority,render}` / ComposedContext)、`plugin`(Plugin/PluginManifest/PluginContext——含 `dataDir` + 按 id 的 context 块 增/改/删/查)、`orchestrator`、`agent`(AgentDefinition 含 `privatePlugins?`、AgentHandle)、`loader`，外加知名 action/event 名常量。

---

## 9. 不变量（抗屎山 · 测试强制）

- **R1** 核心不含领域知识（不出现 LLM/prompt/memory 概念）。
- **R2** 插件只经本 Agent 的 event-system + L1 契约沟通；不互相 import、不碰核心内部、不跨 Agent。
- **R3** 一个零插件的 Agent 能跑完一拍不报错。
- **R4** 职责单一：每个模块只做 §3 写的事（如 loader 不跑 beat、agent_instance 不 setup 插件）。
- **R5** 契约（L1）是唯一共享词汇，改动需版本化。
- **R6** per-Agent 隔离：A 的插件/数据/事件不泄漏到 B（public 插件的共享数据除外，且那是显式的）。

---

## 10. 路线图

- **Phase 0**：契约 + 五个 per-Agent 模块（clock / event-system / orchestrator(含 context-buffer) / loader / agent_instance）+ boot，能"裸 Agent 空跑一拍"。
- **Phase 1**：示例插件（`library` 演示 public/independent + dataDir；llm + toolcall-parser + 几个 context 块 + history）→ 能对话、有记忆。
- **Phase 2**：cli 配置工具（logo + `/new` + `/default` + 增改）。
- **Phase 3**：依赖图可视化（从 KrakeyBot 搬来重做）、自我成长（`docs/PLUGIN_DEV.md`）等。
