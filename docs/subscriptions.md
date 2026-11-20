# 订阅公开监控

Uptime Polaris 可以读取其他站点公开的网站和模型状态。打开“订阅 → 订阅仓库”，选择配置、预览条目，再保存订阅。网站和模型分开管理；模型订阅需要先在设置中开启 AI 监控。

## 从仓库添加

1. 在订阅仓库中选择通用模板或站点配置。默认接入[官方仓库](https://github.com/XingLingQAQ/UptimePolaris-Subscriptions)。
2. 填写数据地址和模板参数。Uptime Kuma 使用状态页的基础地址和 slug，例如 `https://status.example.com/status/main` 对应基础地址 `https://status.example.com`、slug `main`。
3. 点击“读取预览”，核对名称、状态、时间和错误提示，选择要订阅的条目。
4. 设置名称、分组、公开范围和通知，然后创建。

新订阅默认不公开，监控告警和同步告警也默认关闭。第一次读取用于建立状态基线，不发送来源已有的故障。开启“自动订阅新增条目”后，新条目仍保持私有。

公开网站和模型页面按订阅分组，每组可以折叠。开启“设置 → 站点 → 同步监控网站图标”后，订阅来源也会获取网站图标；无法获取时保留默认图形。图标只读取公开 HTTPS 来源，不携带订阅凭据。

目录不可用时，页面保留缓存和内置 Kuma 模板。已有订阅使用本地保存的描述文件运行，不依赖每轮下载仓库。

## 导入自定义接口

支持外部 HTTPS 链接、上传 JSON 和粘贴 JSON。普通 GitHub 文件链接可以转换为原始文件地址；其他网页请提供 JSON 直链。导入的文件保存在本地配置库，可重复创建订阅。移除本地配置不会删除已创建的订阅。

描述格式使用 `schemaVersion: 1`，完整格式见[JSON Schema](../shared/subscription.schema.json)。配置包含输入参数、只读请求、条目身份、状态和时间映射。接口支持 GET、读取数据的 POST、JSON 响应、有界分页及跨请求关联。可从官方仓库的 `json-website`、`json-model` 或 `statuspage` 模板开始修改。

请求地址必须使用公开主机名和 HTTPS。认证值应声明为 `secret` 输入，通过参数表单填写。导出的描述文件不包含这些值。更改秘密参数所发往的来源时，需要重新填写凭据。

`sourcePage` 指定公开列表的来源状态页，例如 `{"baseUrlInput":"baseUrl","path":"/status/{slug}"}`。路径参数不能引用秘密输入；未配置时只展示来源名称。条目本身的网址和描述文件下载地址不会替代状态页链接。

Worker 部署保留 `global_fetch_strictly_public` 兼容标记，外部请求先校验公开 DNS，实际连接由 Cloudflare 的公网出口隔离。Go 校验 DNS 结果并连接已验证的地址。自托管 workerd 应保持公网出口限制，不能为订阅请求开放内网网络权限。

条目 ID 应选来源稳定 ID。名称会变化，不能用名称代替身份。来源会提供“过期”“暂停”等有效性信息时，可用 `observations.currentWhen` 声明条件；不满足条件的条目显示数据过期，保留最后一次有效观测。

```json
{
  "currentWhen": {
    "op": "eq",
    "path": "$.live.freshness",
    "value": "current"
  }
}
```

上面是 `observations` 中的一个字段，不是完整描述文件。条件支持 `eq`、`in`、`exists` 和 `and`，作用于目录中的当前条目。

## 周期、时间和历史

同步周期范围为 60～86400 秒。模板可以让目录和状态使用不同周期，例如 Kuma 目录每 300 秒、心跳每 60 秒读取。立即同步会请求刷新，仍遵守来源限流。

心跳以来源的探测时间判断有效性；Kuma 默认建议有效期 300 秒，请按来源实际探测间隔调整。快照以成功获取时间判断有效性。同步成功不代表来源报告的服务正常；同步失败也不会把所有条目改成故障。

每条目保留最近 60 条观测和最多 90 天的日汇总。心跳正常率只统计已接收观测。快照仅记录首次获取及状态变化，不按轮询次数计算可用率。来源提供的可用率单独标明窗口，不与本地探测 SLA 合并。

429 和临时错误会退避重试，支持 `Retry-After`。认证和格式错误低频重试，需要管理员检查参数或映射。同步记录可以查看获取、解析和保存阶段；大来源分批保存，任务中断后可以继续提交。

## 更新配置与恢复

在“接口配置”中检查更新、比较描述、读取预览后应用。运行时不会自动采用远端修改。相同版本出现不同内容时会提示冲突；请核对来源。

打开订阅列表时会按需检查配置更新，同一配置的检查结果缓存 24 小时。发现更新后列表提供比较入口；手动检查最短间隔为 60 秒。外部文件支持 ETag 和 Last-Modified 条件请求。

改动条目身份或数据来源时，预览列出新旧 ID。明确关联的条目保留历史；未关联的旧条目归档，新条目建立基线。上一份有效配置可通过“预览上一版”恢复，恢复也要重新预览并确认身份关系。凭据不随描述版本回退。

远端同步保留本地名称、分组、排序、公开和静默设置。取消订阅一个条目会停止追加观测并退出公开展示；归档整个订阅会停止同步和通知，保留历史。永久删除同时移除配置、历史和待发通知。

## 通知与密钥备份

监控告警用于来源条目的故障、降级和恢复；同步告警用于 Polaris 无法持续读取来源，两者独立配置。同步告警默认等待连续异常 300 秒。条目静默只关闭该条目的监控告警。

选择全局规则时，通知渠道必须允许“外部订阅”和对应事件类别。指定渠道时绕过全局范围，但仍受渠道启用状态、维护和通知开关限制。接收预览不会外发消息，测试通知会真实发送。详见[通知配置](notifications.md)。

Worker 使用部署的 `ADMIN_TOKEN` 加密订阅凭据与响应缓存，备份和迁移时要保留该值。Go 复用 AI 凭据密钥：SQLite 默认在数据目录创建 `ai-credential.key`；PostgreSQL 部署需要配置 `POLARIS_AI_KEY_FILE`。密钥文件为 32 字节，必须随数据库安全备份。密钥丢失时需要恢复原文件或重新配置订阅，不能用新文件解开旧数据。

---

## English

Open **Subscriptions → Subscription library**, choose an official configuration or import a JSON descriptor, enter its parameters, preview the source, select items, and save. Website and model subscriptions are separate. Enable AI monitoring before activating model subscriptions.

Public website and model items are grouped by subscription, with collapsible sections. Enable **Settings → Site → Sync monitor icons** to fetch source website icons; unavailable icons keep their default glyphs. Icon requests use public HTTPS sources without subscription credentials.

The [official library](https://github.com/XingLingQAQ/UptimePolaris-Subscriptions) includes Uptime Kuma, Polaris, Statuspage, generic JSON, GitHub Status and Cloudflare Status. Kuma needs a base URL and status-page slug. Imports accept HTTPS links, JSON uploads and pasted JSON. Imported configurations remain reusable in the local library. Existing subscriptions use their saved descriptors when the library is unavailable.

Subscriptions and alerts start private and disabled for publication and notification. Initial observations establish a baseline without reporting historical outages. Newly discovered items remain private even with automatic subscription enabled. Local names, groups, ordering, visibility and mute settings survive synchronization.

Descriptors use `schemaVersion: 1`; see the [schema](../shared/subscription.schema.json). Requests support GET, read-only POST, bounded pagination and JSON mapping. Use stable source IDs. Declare credentials as `secret` inputs; exported descriptors omit their values. Changing a credential's destination requires entering it again. `observations.currentWhen` can test source freshness using `eq`, `in`, `exists` or `and`; failed conditions retain the last valid observation and display stale data.

Set `sourcePage`, for example `{"baseUrlInput":"baseUrl","path":"/status/{slug}"}`, to publish the source status-page link. Its path cannot reference secret inputs. Without it, only the source name is displayed. Keep `global_fetch_strictly_public` enabled on Worker deployments. Worker checks public DNS before using Cloudflare's isolated public egress; Go connects to validated DNS addresses. Self-hosted workerd must retain public-only egress.

Sync intervals range from 60 to 86400 seconds. Heartbeats use source observation times; snapshots use fetch times. Kuma suggests a 300-second freshness window, which should match the source's probe interval. Each item retains up to 60 observations and 90 daily summaries. Heartbeat availability describes received observations only; snapshots do not estimate probe counts or SLA. Source-provided percentages retain their own windows.

Use **Interface configuration** to check, compare, preview and apply updates. Updates are never applied automatically. Identity changes require reviewing old-to-new item links; unlinked old items are archived. The previous valid configuration can be previewed and restored. Restoring a descriptor does not restore credentials.

Opening the subscription list checks for configuration updates on demand, with a 24-hour cache. Available updates link to the comparison screen. Manual checks have a 60-second minimum interval; external files support ETag and Last-Modified conditional requests.

Item alerts and synchronization alerts have separate policies. Synchronization alerts wait 300 seconds by default. Global routing requires channels to allow external subscriptions and the matching event type. Explicit channels bypass scope filters while respecting mute, maintenance and enabled states. Previewing recipients sends nothing; notification tests send real messages.

Worker encrypts credentials and response caches using the deployment's `ADMIN_TOKEN`; retain it with backups. Go reuses the AI credential key: SQLite creates `ai-credential.key` in its data directory, while PostgreSQL requires `POLARIS_AI_KEY_FILE`. Back up the 32-byte key alongside the database. A replacement key cannot decrypt existing data.
