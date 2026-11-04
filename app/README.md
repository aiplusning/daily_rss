# Daily RSS 应用（独立后端 + DSH 插件页）

在现有每日 RSS 日报仓库基础上增加一个可独立部署的资讯应用：Node.js 后端提供 RSS 聚合 API，`app/public` 提供可直接打开或嵌入 DSH 的响应式插件页。现有 `2026/` Markdown 日报归档保持不变。

## 功能

- 预置 AI、开发、开源、研究和行业 RSS 来源；可从侧栏添加订阅。
- 手动同步或每 15 分钟自动拉取 RSS/Atom；失败来源单独记录错误。
- 规范化 URL、跨来源按文章链接去重；资讯按时间倒序聚合。
- 按领域来源、关键词、日期、未读和收藏筛选。
- 收藏、已读状态保存在 SQLite；文章摘要和每日简报可接入 OpenAI 兼容 API。
- 独立网页可在 DSH 中作为 URL/iframe 插件页使用，后端开放 JSON API。

## 启动

需要 Node.js 20+ 和 npm：

```bash
cd app
npm install
npm start
```

打开 `http://localhost:3000`。默认 SQLite 文件 `app/daily-rss.sqlite`；生产环境建议把 `DB_PATH` 指向持久化磁盘。首次运行会自动创建数据库并拉取预置来源。RSS 拉取受各来源可用性和部署网络访问能力影响。

## AI 配置（可选）

AI 文章摘要与每日简报使用 OpenAI Chat Completions 兼容接口。密钥只放在服务端环境变量中：

```bash
AI_API_KEY=your-key \
AI_BASE_URL=https://api.openai.com/v1 \
AI_MODEL=gpt-4o-mini \
npm start
```

未配置密钥时，RSS 阅读、搜索、收藏、已读及时间筛选仍正常工作，AI 操作会显示配置提示。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 监听端口 |
| `DB_PATH` | `app/daily-rss.sqlite` | SQLite 数据库文件路径 |
| `AUTO_REFRESH` | `true` | 启动时是否立即同步 RSS |
| `REFRESH_INTERVAL_MS` | `900000` | 自动同步间隔（毫秒） |
| `AI_API_KEY` | — | AI 服务密钥（可选） |
| `AI_BASE_URL` | `https://api.openai.com/v1` | OpenAI 兼容 API 根地址 |
| `AI_MODEL` | `gpt-4o-mini` | 摘要模型 |

## API

- `GET /api/health` — 服务健康状态和 AI 配置状态
- `GET /api/feeds`、`POST /api/feeds`、`DELETE /api/feeds/:id` — 订阅来源
- `POST /api/feeds/:id/refresh`、`POST /api/refresh` — 同步来源
- `GET /api/articles?q=&feed=&from=&to=&favorite=1&unread=1&limit=&offset=` — 聚合资讯
- `PATCH /api/articles/:id/state`，请求体可含 `is_read`、`is_favorite`
- `POST /api/articles/:id/summarize` — 生成并保存单篇 AI 摘要
- `POST /api/briefing` — 基于最近 24 小时资讯生成每日简报

## DSH 集成

将应用部署到 DSH 可访问的服务地址，并将部署 URL 配置为 DSH 的网页/iframe 插件页面。插件页不依赖 DSH 专有 SDK，可独立使用。若 DSH 要求特定插件清单或 SDK，请根据其版本补充 manifest/入口约定。

公网部署请启用 HTTPS，并在反向代理或平台层增加访问控制；此 MVP 不包含用户账号与多租户隔离，收藏和已读状态是该实例共享状态。
