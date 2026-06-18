# OpenKrakey

> 一个**极简、时间驱动、插件化**的自主 Agent 框架。
> [`Arrosam/KrakeyBot`](https://github.com/Arrosam/KrakeyBot) 的从零重构版——同样的"持续心跳"理念，全新的、不再变成屎山的架构。

## 它是什么

普通 AI 助手是"自动贩卖机"：投问题、出答案、回去睡觉。OpenKrakey 跑在**心跳**上：每隔一段时间醒来，把当前所有信息组成一个完整 context 发给 LLM，执行返回的动作，然后继续。它**永不阻塞输入**——工具调用异步执行，跑到一半时你的新消息会在下一拍一并被处理。

运行时本身**领域无关**：内核不知道什么是 LLM、prompt、记忆。**"Agent" 是一个独立实例**，由一组插件跑起来后涌现行为；连记忆、对话历史、用哪个模型都是插件。

## 核心结构

- **全局**：`boot`（只负责启动，读配置拉起 Agent）、`cli`（独立的配置文件管理工具/UI，也可手改文件）。
- **每个 Agent 实例**（互相隔离，由 `agent_instance` 包裹）：
  - `orchestrator` —— 指挥（内含 context-buffer）：按各 context 块的 target/优先级 compose（system 提示 + messages 数组）、暴露 eventbus 供插件改自己那块、异步 dispatch 工具调用、维持 actionbus、协调时钟。
  - `event-system` —— 独立中枢总线（事件 + 动作），clock / loader / orchestrator / 插件都接它。
  - `clock` —— 哑计时器（只激活）。
  - `loader` —— 插件装卸：从 Agent 私有夹 + 共享 `public_plugin/` 加载、设好数据目录、注册进 event-system。

详见 **[ARCHITECTURE.md](ARCHITECTURE.md)**。

## 插件与数据

- 共享插件放 `public_plugin/<id>/`（数据共享 → 多 Agent 共享知识）；Agent 私有插件放 `agents/<id>/plugins/<id>/`（数据隔离，覆盖同名共享插件）。
- "共享代码、而非共享单例"：每个 Agent 各自实例化，共享/隔离取决于插件数据目录的位置。

## 快速开始（MVP）

```bash
npm install
cp config/llm.example.json config/llm.json   # 填入你的 API key（或用 "${ENV_VAR}" 引用环境变量）
npm run cli                                   # → ✦ Guided setup：选服务、填模型/端点/密钥、起 agent，一路引导
npm start                                     # 启动所有 agents/*/config.json —— 控制台打印 ✦ Web chat: http://localhost:7717
```

启动后打开浏览器到 `http://localhost:7717` 即可与各 agent 对话（每个 agent 独立会话、消息有 sent/read 状态）。

MVP 插件集（`public_plugin/`）：`llm-core`（LLM 往返）· `persona`（身份 system 块）·
`web`（浏览器聊天通道：refcounted http hub + SSE 流 + sent/read 状态；仅在 LLM 显式调用 `web.send_message` 工具时才发消息——LLM 的 output.message 独白不再自动推送；并**自己维护聊天记录**，渲染成 `web.conversation` 会话块喂给 LLM——只记用户输入与 Agent 显式发出的消息，独白与工具机制都不入账；作为带数据的插件默认私有，每个 Agent 各自一份）。
把插件 id 放进 agent 配置的 `privatePlugins` 即可获得该插件的独立私有数据副本（`web` 默认即私有）。

## 状态

✅ Phase 0（内核：契约 + 五个 per-Agent 模块 + boot/cli/llm-gateway）与 **Phase 1 MVP**（上述 3 个核心插件 + `inspector` 调试面板，
端到端测试覆盖完整一拍：输入 → web 记入会话 → compose（system + messages）→ LLM → `web.send_message` 发消息并记入会话 → 下一拍带上 → 输出）已完成，755 项测试全绿。
栈：TypeScript + Node.js。

## License

[MIT](LICENSE) © 2026 Samuel
