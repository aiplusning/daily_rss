# WorkBuddy 连接器与智能体落地计划

## 产品目标
让用户在 WorkBuddy 中用自然语言检索 Daily RSS 资讯、了解订阅来源、刷新信息、生成文章摘要/每日简报，并在用户确认后管理收藏与已读状态。

## 交付架构
1. **数据层**：沿用 Daily RSS SQLite、RSS/Atom 抓取与现有 JSON API。
2. **连接器层**：新增独立 WorkBuddy HTTP sidecar，提供 OpenAPI 3.0 文档及显式 allowlist 工具；Bearer Key 认证，固定连接到 `DAILY_RSS_URL`。
3. **智能体层**：支持两种方式：WorkBuddy 原生 Agent 调用 OpenAPI 工具（推荐），或 sidecar `/agent/chat` 使用 OpenAI 兼容模型 tool calling。
4. **运维层**：独立部署、HTTPS、Secret 管理、持久数据库、限流/审计及健康检查。

## 已实现的一期范围
- 来源列表、新闻搜索/日期/状态过滤、RSS 刷新、已读/收藏修改、单篇 AI 摘要、每日简报。
- OpenAPI schema 与 Agent tool schema 保持同一能力边界。
- 固定上游地址和 API allowlist；输入长度/日期/文章 ID校验；工具轮数受限。
- 中文 Agent 提示词、history 消息角色过滤、错误返回、端到端 curl 验证说明。

## 实施阶段
- **阶段 0：确认接入方式**：识别 WorkBuddy 具体租户版本、连接器类型（OpenAPI/API 插件/MCP）及认证方式；由此确认导入体验，当前按标准 OpenAPI + Bearer 实现。
- **阶段 1：本地 MVP**：启动 RSS 服务与 Connector，配置 AI Key，测试 API 和模型工具调用。
- **阶段 2：WorkBuddy 集成**：部署 Connector 到 HTTPS；导入 OpenAPI；配置 Secret；创建 Agent 指令和操作审批；用测试租户验收。
- **阶段 3：安全与上线**：增加用户身份/租户隔离、速率限制、审计和监控；由 SQLite 迁移至适合多副本的数据库；设置备份、告警、成本预算。

## 验收标准
- 未授权请求被拒绝，错误凭证不能访问 OpenAPI 和工具路由。
- 搜索、来源列表在 AI 服务关闭时仍可用；AI 功能在未配置密钥时明确返回配置错误。
- 时间过滤/收藏/已读筛选结果正确；非合法文章 ID 和日期被拒绝。
- Agent 只能调用定义的工具，不可执行自由 URL/任意路径；刷新和状态修改具有人机确认策略。
- 连接器能被目标 WorkBuddy 租户导入；此项需在实际租户完成最终验收。

## 风险/未决项
- WorkBuddy 的具体产品版本和租户连接器协议未提供；若它要求 MCP、OAuth 或专有 manifest，需在标准 OpenAPI 适配器外加一层协议适配。
- 当前原应用的文章已读/收藏是实例共享数据，无身份隔离；不适合直接作为多租户公共服务。
- 互联网 RSS 源可用性不保证；生产刷新建议进入队列并对失败源退避。
