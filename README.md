# OpenKrakey

> 一个**极简、时间驱动、插件化**的自主 Agent 框架。
> [`Arrosam/KrakeyBot`](https://github.com/Arrosam/KrakeyBot) 的从零重构版——同样的"持续心跳"理念，全新的、不再变成屎山的架构。

## 它是什么

普通 AI 助手是"自动贩卖机"：投问题、出答案、回去睡觉。OpenKrakey 跑在**心跳**上：每隔一段时间醒来，把当前所有信息组成一个完整 context 发给 LLM，执行返回的动作，然后继续。它**永不阻塞输入**——工具调用异步执行，跑到一半时你的新消息会在下一拍一并被处理。

运行时本身**领域无关**：内核不知道什么是 LLM、prompt、记忆。**"Agent" 是一个独立实例**，由一组插件跑起来后涌现行为；连记忆、对话历史、用哪个模型都是插件。

## 核心结构

- **全局**：`boot`（只负责启动，读配置拉起 Agent）、`cli`（独立的配置文件管理工具/UI，也可手改文件）。
- **每个 Agent 实例**（互相隔离，由 `agent_instance` 包裹）：
  - `orchestrator` —— 指挥（内含 context-buffer）：按序 compose context、暴露 eventbus 供插件改自己那块、异步 dispatch 工具调用、维持 actionbus、协调时钟。
  - `event-system` —— 独立中枢总线（事件 + 动作），clock / loader / orchestrator / 插件都接它。
  - `clock` —— 哑计时器（只激活）。
  - `loader` —— 插件装卸：从 Agent 私有夹 + 共享 `public_plugin/` 加载、设好数据目录、注册进 event-system。

详见 **[ARCHITECTURE.md](ARCHITECTURE.md)**。

## 插件与数据

- 共享插件放 `public_plugin/<id>/`（数据共享 → 多 Agent 共享知识）；Agent 私有插件放 `agents/<id>/plugins/<id>/`（数据隔离，覆盖同名共享插件）。
- "共享代码、而非共享单例"：每个 Agent 各自实例化，共享/隔离取决于插件数据目录的位置。

## 状态

🚧 设计定稿（见 ARCHITECTURE.md），正在从零重建实现。栈：TypeScript + Node.js。

## License

[MIT](LICENSE) © 2026 Samuel
