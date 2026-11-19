# AI 模型监控

[English](#english)

在后台的 **AI 监控** 页面管理渠道和模型。一个渠道保存一组接口地址和 API Key；渠道里的模型分别检查、分别记录状态。Worker 和 Go 后端均可使用。

首次使用时，在“设置 → 展示设置”中打开“启用 AI 监控”。关闭后停止定时检查、Queue 中的 AI 任务和手动调用，保留渠道、模型及历史。已有 AI 渠道的站点更新后保持启用；新站点默认关闭。

## 添加渠道和模型

1. 打开 `/admin/ai`，添加渠道，选择接口协议，填写名称、基础地址和 API Key。基础地址保留版本路径，不附加生成接口路径，示例见下表。
2. 保存后可选择“检查连接”。这会请求模型列表，不会发起文本生成；渠道不支持模型列表时，会显示“不支持模型列表”，不代表模型调用失败。
3. 进入渠道，添加要监控的模型，填写显示名称和渠道实际接受的模型 ID。系统不会自动监控列表里的全部模型。
4. 设置提示词、输出上限、期望文本、间隔、超时和公开选项，然后保存。默认每 300 秒检查一次，超时 30 秒；间隔范围为 60～86400 秒，超时范围为 1～60 秒，且必须短于间隔。

也可以选择“从渠道导入”，读取模型列表后勾选多个模型，统一设置检查间隔、启用和公开选项。获取列表不会调用模型；导入并启用后开始定时检查。添加单个模型时可从同一列表选取 ID；渠道不支持模型列表时仍可手动填写。

渠道可设置自定义请求头，例如网关身份验证或 OpenAI 组织标识：

```json
{
  "OpenAI-Organization": "org-example",
  "CF-Access-Client-Id": "example-client-id",
  "CF-Access-Client-Secret": "example-client-secret"
}
```

请求头可用键值行或 JSON 编辑，不限制条数。值加密保存，打开渠道编辑器时会读取已保存的值，无需重新填写。删除所有行或提交空对象可清除请求头。整个请求头 JSON 不超过 64 KiB；名称不超过 64 个字符，单个值不超过 2048 个可打印 ASCII 字符。认证头、`Content-Type`、`Host`、`Cookie` 和连接控制类请求头不能覆盖；API Key 仍在专用字段填写，保存后不回显。

基础地址支持 HTTP、HTTPS、本机和内网，例如 `http://127.0.0.1:11434/v1` 或容器网络中的 `http://ollama:11434/v1`。`localhost` 指向执行检查的后端，不是浏览器所在电脑。Go 可以访问服务器能够连接的内网服务；云端 Worker 不能直接连接你的本机，需使用它能访问的地址。HTTP 会明文传输密钥，公网服务建议使用 HTTPS。文件路径、URL 中的凭据、查询参数和片段不受支持，云元数据地址仍会被拒绝。

| 接口协议 | 基础地址示例 | 自动追加的生成路径 | 模型 ID 示例 |
| --- | --- | --- | --- |
| OpenAI Chat Completions | `https://api.openai.com/v1` | `/chat/completions` | `gpt-4.1-mini` |
| OpenAI Responses | `https://api.openai.com/v1` | `/responses` | `gpt-4.1-mini` |
| Anthropic Messages | `https://api.anthropic.com/v1` | `/messages` | `claude-sonnet-4-5` |
| Gemini generateContent | `https://generativelanguage.googleapis.com/v1beta` | `/models/模型ID:generateContent` | `gemini-2.5-flash` |

使用中转渠道时，填写中转地址，并选择它实际支持的协议。模型 ID 以渠道提供的名称为准。Gemini 只填写模型名称，不含 `models/` 前缀或其他路径。修改渠道协议会影响渠道下的所有模型；切换到 Gemini 前，先修正不符合格式的模型 ID。请求失败后不会自动切换协议或重试其他生成接口。

检查使用非流式文本生成请求。默认提示词为 `Reply OK.`，最多 2000 个字符；输出上限默认 64 tokens，可设置为 1～4096。期望文本留空时，有效且非空的回复就算通过；填写后，回复须包含这段文本，区分大小写，不支持正则表达式。不符合时显示“响应不匹配”。

模型的“自定义请求体（JSON）”用于添加协议参数，也可以替换默认消息。例如 OpenAI 兼容接口可填写：

```json
{
  "temperature": 0.2,
  "top_p": 0.9,
  "messages": [
    { "role": "system", "content": "Answer briefly." },
    { "role": "user", "content": "Reply OK." }
  ]
}
```

JSON 对象与默认请求体递归合并，数组整体替换。模型 ID、非流式模式和输出上限仍按表单设置，Responses 始终使用 `store: false`。Gemini 的生成参数放在 `generationConfig` 中；支持哪些参数由所选渠道和模型决定。请求体最多 64 KiB，填写 `{}` 可清除附加参数。手动与定时检查使用相同配置，公开响应不包含请求体。

推理内容、拒绝块和工具调用不算文本结果；Responses 的 `incomplete` 结果只有包含可见文字时才通过，失败或仍在处理的响应不通过。部分推理模型可能在输出上限内无法生成可见文字，此时显示“返回结果无效”。可按需提高输出上限，但可能增加费用。不检查图片、音频或流式输出，也不通过其他模型的结果推断当前模型的状态。

OpenAI 协议使用 Bearer 认证；Anthropic 使用 `x-api-key` 和 `anthropic-version: 2026-10-21`；Gemini 使用 `x-goog-api-key`，密钥不会放入 URL。各协议的请求格式见 [OpenAI Responses](https://developers.openai.com/api/reference/resources/responses/methods/create)、[Anthropic Messages](https://platform.claude.com/docs/en/api/messages) 和 [Gemini generateContent](https://ai.google.dev/api/generate-content)。

**定时检查会产生真实 API 调用，可能收费。** 每 5 分钟检查一个模型，每天最多计划调用 288 次。表单显示每日计划次数，不估算金额；实际费用取决于渠道计价、输入和输出。手动检查另行确认费用，不计入定时历史和可用率。

## 查看结果

模型列表显示定时检查的结果、检查时间和完整响应耗时，不是首字延迟。认证失败、没有权限、模型或接口不可用、已知限流、已知额度不足、超时和无效响应分别显示。无法确定原因的 HTTP 429 只显示请求或额度受限。

渠道连接结果与模型结果独立。暂停、配置变更后等待检查、请求预算不足、密钥不可用、渠道冷却和结果过期都不会显示成正常，也不算一次模型故障。过期结果仍可查看上次实际检查时间和结果。

后台和公开页的可用性条显示最近最多 60 次实际定时检查。手动检查和未执行轮次不会加入，也不会补成正常。修改名称、公开设置或通知渠道不会清空状态；探测配置变化后，状态条从新配置的检查重新积累。

“检查记录”可切换最近 7、30、90 个 UTC 自然日，包含当天。可用率是成功次数除以实际检查总次数，未执行的检查不计入分母，不补齐缺失时段。Worker 明细来自 Analytics Engine，可能延迟或采样；每日汇总使用精确计数。明细暂不可用时，仍显示已有汇总和状态条记录。

## 通知与公开展示

在 AI 渠道设置中选择通知渠道，该渠道下的所有模型共用这项设置。留空时沿用全局通知规则，AI 告警发送到未限定监控分组的已启用通知渠道。选择后只向指定渠道发送，不再按监控分组筛选。故障确认阈值和维护窗口沿用站点设置，状态变化后发送故障或恢复通知；停用的通知渠道不会发送。

勾选“公开”且启用监控的模型可显示在独立 AI 页面，也可显示在主监控页。在展示设置中打开或关闭“在主监控页显示 AI 模型”；关闭后不参与主监控页的统计和筛选，独立页面仍可用。

独立页面地址为 `/ai`，也可以给“AI 展示页域名”配置单独域名。先完成 DNS 和部署侧域名绑定，再保存映射。进入“主题管理 → AI 模型展示页”配置标题、说明、颜色、宽度、列表或卡片布局、密度、列数和信息显示，预览后保存。

内置 AI 页默认使用列表，与主监控页分别记住访客选择的视图。模型按渠道分组，每组显示状态汇总并支持折叠；搜索渠道名称会列出对应模型并展开分组。展开模型检查记录时，历史内容与模型区域同宽。

关闭公开或暂停后，匿名访问不能再读取该模型及其历史。公开数据包含用于分组的渠道 ID 和渠道名称，不包含渠道地址、API Key、自定义请求头、提示词、匹配文本或供应商响应正文。模型名称和渠道名称会公开，不要填写密钥或其他敏感内容。

## 密钥保存与恢复

保存后的 API Key 不会回显。编辑渠道时默认保留原密钥；选择“替换 API Key”才会更新。删除渠道会同时删除渠道下的模型。

| 部署方式 | 加密材料 |
| --- | --- |
| Worker | 使用已有 `ADMIN_TOKEN`，无需新增 AI Secret；数据库和 `ADMIN_TOKEN` 都要备份 |
| Go + SQLite | 第一次保存渠道密钥时，在数据目录建立 `ai-credential.key`；随数据目录备份 |
| Go + PostgreSQL | 首次添加渠道前，通过 `POLARIS_AI_KEY_FILE` 指定受保护的密钥文件；所有实例使用相同的 32 字节内容 |

Go 的显式密钥文件必须包含 **32 个原始随机字节**，不是 32 字符的密码，也不是十六进制或 Base64 文本。使用密钥管理工具提供文件，例如将文件挂载为 `/run/secrets/polaris-ai-key`，并设置：

```dotenv
POLARIS_AI_KEY_FILE=/run/secrets/polaris-ai-key
```

POSIX 上仅允许运行账号读写文件（`0600`）；Windows 上限制 DACL，仅授予运行账号和 SYSTEM 所需权限，不能使用符号链接。密钥文件应独立备份，不要提交到 Git。SQLite 切换到 PostgreSQL 时保留原 `ai-credential.key`，将其作为目标实例的显式密钥文件。

恢复时同时恢复数据库和对应加密材料。文件丢失时不会自动生成新文件冒充原密钥；先恢复备份。确实无法恢复时，配置新的受保护材料，再逐个替换渠道 API Key。不要直接轮换 Worker 的 `ADMIN_TOKEN` 来修复 AI 密钥问题：它还用于保护初始化选库记录。

## English

Manage channels and models on **AI monitoring** at `/admin/ai`. A channel stores a base URL and API key. Each model has its own schedule and results. Both Worker and Go backends support this feature.

Enable **AI monitoring** in the presentation settings before using it. Disabling stops scheduled checks, queued AI tasks and manual calls while retaining configuration and history. Existing channels remain enabled after an upgrade; new sites default to disabled.

### Add a channel and model

1. Add a channel, select its protocol, and enter a name, base URL and API key. Keep the version path in the base URL; do not append a generation endpoint. See the examples below.
2. Optionally select **Check connection**. This requests the model list without generating text. An unsupported model-list endpoint does not establish that model calls fail.
3. Open the channel and add each model you want to monitor, using the exact model ID accepted by that channel. Listed models are not enabled automatically.
4. Set the prompt, output limit, expected text, interval, timeout and public visibility. Defaults are 300 seconds and a 30-second timeout. Intervals range from 60 to 86400 seconds; timeouts range from 1 to 60 seconds and must be shorter than the interval.

Alternatively, select **Import from channel**, choose models from the list and set a shared interval, enabled state and public visibility. Fetching the list does not call a model; enabled imports start scheduled checks. The single-model editor can use the same list for ID suggestions. Manual entry remains available when the channel does not support model listing.

Custom headers support field-based and JSON editing, without an entry-count limit. Values are encrypted at rest and loaded when an administrator opens the channel editor, so they can be edited again. Delete all fields or use an empty object to clear them. The complete header JSON is limited to 64 KiB, names to 64 characters and each value to 2048 printable ASCII characters. Authentication, Content-Type, Host, Cookie and connection-control headers cannot be overridden. The API key uses its dedicated field and is not returned after saving.

Base URLs accept HTTP, HTTPS, local and private hosts, such as `http://127.0.0.1:11434/v1` or `http://ollama:11434/v1` on a container network. Localhost refers to the backend host, not the browser's computer. Go can reach services accessible from its server; a cloud Worker cannot directly reach your computer. HTTP sends keys unencrypted; prefer HTTPS for public services. File paths, URL credentials, query parameters, fragments and cloud metadata endpoints remain unsupported.

| Protocol | Example base URL | Appended generation path | Example model ID |
| --- | --- | --- | --- |
| OpenAI Chat Completions | `https://api.openai.com/v1` | `/chat/completions` | `gpt-4.1-mini` |
| OpenAI Responses | `https://api.openai.com/v1` | `/responses` | `gpt-4.1-mini` |
| Anthropic Messages | `https://api.anthropic.com/v1` | `/messages` | `claude-sonnet-4-5` |
| Gemini generateContent | `https://generativelanguage.googleapis.com/v1beta` | `/models/MODEL_ID:generateContent` | `gemini-2.5-flash` |

For a gateway, use its base URL and the protocol it supports. Use model IDs accepted by that channel. Gemini requires the bare model name, without `models/` or another path. Changing a channel’s protocol affects every model in it; correct incompatible model IDs before switching to Gemini. Failed requests do not trigger protocol fallback or retries against another generation endpoint.

Checks use non-streaming text generation. The default prompt is `Reply OK.`, with up to 2000 characters. The output limit defaults to 64 tokens and accepts 1–4096. Leave expected text empty to accept any valid, nonempty reply; otherwise the reply must contain the exact case-sensitive text, without regular expressions. A different reply produces a response-mismatch result.

**Custom request body (JSON)** adds protocol options or replaces default messages; the example above adds `temperature`, `top_p` and a complete `messages` array. Objects are merged recursively, while arrays are replaced. The model ID, non-streaming mode and output limit still follow the form; Responses always sets `store: false`. Put Gemini generation options in `generationConfig`. Supported options depend on the channel and model. The custom object is limited to 64 KiB; `{}` clears it. Manual and scheduled checks use the same configuration, and public responses exclude the body.

Reasoning, refusal blocks and tool calls do not count as text output. A Responses `incomplete` result passes only when it contains visible text; failed or still-pending responses do not pass. Reasoning models may consume the limit before producing visible text. Raising the limit may help but can increase costs. Images, audio and streaming are not checked. A working channel or another model does not establish the selected model’s availability.

OpenAI protocols use Bearer authentication. Anthropic uses `x-api-key` and `anthropic-version: 2026-10-21`. Gemini uses `x-goog-api-key`, never a key in the URL. Request references: [OpenAI Responses](https://developers.openai.com/api/reference/resources/responses/methods/create), [Anthropic Messages](https://platform.claude.com/docs/en/api/messages), [Gemini generateContent](https://ai.google.dev/api/generate-content).

**Scheduled checks make real API calls and may incur charges.** A five-minute interval schedules up to 288 calls per model per day. The form shows planned call counts, not a price estimate. Manual checks require separate cost confirmation and do not enter scheduled history or availability.

### Read results

The model list shows scheduled results, check times and full-response duration, not time to first token. Authentication, permission, missing model or endpoint, known rate limits, known quota exhaustion, timeout and invalid responses have separate labels. An ambiguous HTTP 429 is not classified as quota exhaustion.

Channel connection results remain separate from model results. Paused, changed, skipped, cooling-down and stale checks do not appear as healthy and are not recorded as target failures. Stale data retains the last actual check time and result.

Console and public status rails show up to 60 actual scheduled checks. Manual and unexecuted checks are excluded; gaps are not filled as healthy. Name, visibility and notification changes preserve state. Probe configuration changes start a fresh rail with the new observations.

**Check history** offers 7, 30 and 90 UTC calendar dates, including today. Availability is successful checks divided by actual checks; unexecuted checks are excluded, and gaps are not filled. Worker details come from Analytics Engine and may be delayed or sampled. Daily summaries use exact counters; existing summaries and status-rail observations remain readable when details are unavailable.

### Alerts and public visibility

Select notification channels in the AI channel settings; every model in that AI channel uses the selection. An empty selection follows global notification rules: AI alerts go to enabled channels with no monitor-group restriction. An explicit selection sends only to those channels, regardless of group scope. Failure confirmation and maintenance windows follow site settings. Failure and recovery transitions send alerts; disabled notification channels do not send.

Enabled public models can appear on the independent AI page and the main status page. **Show AI models on the main status page** controls inclusion in that page’s model section, overall status, search and filters; switching it off leaves the independent page available.

Open `/ai` for the independent page, or assign a separate AI-page domain after configuring DNS and deployment-side bindings. In **Themes → AI model page**, configure the title, description, colors, width, list or card layout, density, columns and visible information, then preview and save.

The built-in AI page defaults to a list and remembers the visitor's view separately from the main status page. Models are grouped by channel, with state summaries and collapsible groups. Searching a channel name finds its models and expands matching groups. Expanded history uses the full model-area width.

Making a model private or pausing it removes anonymous access to the model and its history. Public responses include channel IDs and names for grouping, but exclude endpoint URLs, keys, custom headers, prompts, matching text and provider response bodies. Both model and channel names are public; keep sensitive information out of them.

### Protect and restore keys

Saved API keys are never returned. Editing preserves the current key unless **Replace API key** is selected. Deleting a channel also deletes its models.

| Deployment | Encryption material |
| --- | --- |
| Worker | Existing `ADMIN_TOKEN`; back it up separately from the database |
| Go with SQLite | `ai-credential.key` is created in the data directory on the first channel-key write; back it up with the data |
| Go with PostgreSQL | Set `POLARIS_AI_KEY_FILE` before adding a channel; all instances must use the same protected 32-byte material |

An explicit Go key file contains **32 raw random bytes**, not a password, hexadecimal string or Base64 text. Provision it through your secret-management tooling, for example at `/run/secrets/polaris-ai-key`, and set `POLARIS_AI_KEY_FILE` to that path. Use mode `0600` on POSIX. On Windows, restrict the DACL to the runtime account and SYSTEM. Symlinks are not accepted. Back up the file separately and keep it out of Git.

When moving SQLite data to PostgreSQL, keep the original `ai-credential.key` and configure it as the explicit key file on every target instance. Restore the database and its matching encryption material together. Missing material is not silently regenerated. Restore the backup first; if recovery is impossible, provision new protected material and replace every channel API key. Do not rotate the Worker’s `ADMIN_TOKEN` just to repair AI keys: it also protects setup database-selection records.
