# 主题指南

[English](#english)

一个主题包可以提供监控状态页、机器状态页和 AI 模型页的主题。“主题管理”顶部按已启用的页面显示当前主题；下方已安装主题可以直接应用，会按主题声明的页面类型自动匹配。首次安装后需手动应用；更新已在使用的主题包时，相关页面会自动使用新版。管理控制台、登录、初始化和 API 始终使用内置实现。

## 安装与选择

1. Worker 配好 `THEMES` R2 绑定；Go 使用数据目录里的 `themes/`，确保可写且持久化。
2. 在主题管理里点击选择或拖入单个 ZIP，也可以填写可下载的 ZIP 地址；上传中或存储不可用时控件会禁用。
3. 在主题管理里预览包内的各个主题。
4. 在已安装主题旁点“应用”，主题就用到它声明的页面类型，不用另选监控页或机器页。
5. 顶部看板显示应用结果；点“主题配置”编辑选项并保存。机器页入口随机器独立展示功能显示，AI 页入口随 AI 监控功能显示。AI 内置页可另设标题和说明，通过 `/ai` 或指定的 AI 域名访问。

更新后，已安装列表只显示当前版本，使用该主题包的页面会同步更新。仍受新版支持的有效配置、头部代码和自定义 HTML 会保留；不再支持的选项会移除，新选项使用主题默认值。如果新版缺少正在使用的子主题，更新会被拒绝，原配置不变。要回退，重新上传旧版主题包；也可以在对应看板恢复内置主题。删除主题包会先清掉各页面对这个包的引用，再删除资源。资源删除失败时，管理记录还在，已经清掉的页面引用不会恢复。

主题 JavaScript 会在公开页面运行，只安装可信来源的包。

可以使用 [Polaris Simple](../examples/themes/polaris-simple/README.md) 主题包，分别给监控页和机器页选主题。

## 配置选项

内置主题也可以在顶部看板中点“主题配置”，调整强调色、圆角、页面宽度、布局、内容密度、卡片列数和信息显示。页面布局作为访客的默认视图，访客已保存的视图选择仍然有效。安装主题的选项由主题包提供。

主题配置里可以填头部代码（最多 16 KiB UTF-8）和自定义 HTML（最多 32 KiB UTF-8）。内置页面在正文下方显示自定义内容；安装主题需要提供内容插槽。这些内容访客都能看到，脚本还有本站同源权限；只用可信代码，不要填凭据。手动切换主题、恢复内置主题或删除主题后，这些内容会清空；更新同一主题包时保留。

主题选项引用的监控或机器，必须位于对应页面的公开范围内。AI 主题的目标类型为 `ai`，可声明 `public.config`、`public.ai-models` 和 `public.ai-history`。网站和 AI 主题还可声明 `public.subscriptions`、`public.subscription-history`，读取对应类别的公开订阅和条目历史。

通过 `polarisTheme.read('subscriptions', { category: 'website', limit: 50, offset: 0 })` 读取订阅；模型类别使用 `model`。通过 `polarisTheme.read('subscription-history', { id: '条目 ID' })` 读取历史。自定义状态页可传 `pageId`。数据仍遵守公开开关、功能开关和页面范围；请保留来源、有效性和时间含义，避免把快照合并成本地 SLA。详见[订阅指南](subscriptions.md)。

## 预览

预览在隔离窗口里运行。外部脚本、网络请求和需要本站权限的行为，可能和公开页面不一样。应用后要用未登录状态检查实际页面。

## 管理 API

以下接口需要管理员会话或 Bearer Token：

| 方法和路径 | 用途 |
| --- | --- |
| `GET /api/themes` | 列出主题包、当前安装版本及其子主题 |
| `POST /api/themes/install` | 提交 `{ "url": "https://example.com/theme.zip" }` 或 ZIP 二进制请求体 |
| `GET /api/themes/:short/preview?version=<versionKey>&theme=<id>` | 获取子主题预览元数据 |
| `GET /api/themes/:short/update-check` | 检查来源 URL 更新 |
| `DELETE /api/themes/:short` | 删除主题包及其资源 |

ZIP 上传使用 `Content-Type: application/zip`。页面配置使用 `page.theme = { short, version, theme }`、`page.themeOptions` 和可选的 `page.headCode`、`page.contentHtml`；其中 `version` 用安装返回的 `versionKey`。通过展示配置接口保存后立即生效。

## English

Theme packages can provide monitor, machine and AI model pages. Page panels appear for enabled features. A newly installed package must be applied manually. Updating a package already in use moves its pages to the new version. The administration console, login, setup and API remain built in. See the [documentation index](README.md#english) and [deployment guide](deployment.md#english) for the surrounding site setup.

### Install and apply

Worker needs the `THEMES` R2 binding; Go stores theme files in its persistent data directory. In theme management, pick or drop a single ZIP file, or provide its download URL; the control is disabled while uploading or when storage is unavailable. Preview its themes, then apply the desired theme. Application is matched to the theme's declared page type. The machine-page controls appear when the separate machine page is enabled. Change options in the corresponding page panel; save changes in the panel.

The installed list shows only the current version. Updates move pages using the package to that version, preserving valid options still supported by the new definitions, head code and custom HTML. Removed options are discarded; new options use their theme defaults. An update that omits an active child theme is rejected without changing page settings. To roll back, upload the older package again or restore the built-in theme. Deleting a package first removes references from both pages, then deletes its resources. If resource deletion fails, the management record remains but removed page references are not restored. Theme JavaScript runs on public pages, so install only packages you trust.

The [Polaris Simple theme](../examples/themes/polaris-simple/README.md#english) provides monitor and machine pages.

### Configure and preview

Built-in themes can also be configured from their page panel. Set the accent color, corner radius, page width, layout, content density, card columns and information visibility. The layout is the default for visitors who have not saved their own view. Installed themes define their own options. Monitor and machine references must belong to the corresponding public page.

The AI page appears when AI monitoring is enabled. Its built-in theme also supports an independent title and description. Visit `/ai` or assign an AI-page domain. AI themes use target `ai` and capabilities `public.config`, `public.ai-models` and `public.ai-history`. Website and AI themes may also request `public.subscriptions` and `public.subscription-history`.

Use `polarisTheme.read('subscriptions', { category: 'website', limit: 50, offset: 0 })` for website subscriptions; use `model` for models. Read history with `polarisTheme.read('subscription-history', { id: 'item ID' })`. Custom status pages may supply `pageId`. Access follows visibility, feature and page scope. Preserve source, freshness and observation-time labels; do not combine snapshots with local SLA.

`headCode` allows up to 16 KiB of UTF-8 HTML, CSS and JavaScript in the page head. `contentHtml` allows up to 32 KiB of UTF-8 custom HTML. Built-in pages display it below the main content; installed themes need a content slot. Both are public. Scripts on a public theme page run with the site's origin; use trusted code and never include credentials. These values are cleared when manually switching themes, restoring the built-in theme or deleting the theme. Updating the same package preserves them.

Preview runs in an isolated window. External scripts, network requests and behavior requiring the site's origin can differ from the public page. Check the applied page while signed out.

### Administration API

The API table above lists package listing, ZIP or URL installation, preview, update checks and deletion. These operations require an administrator session or Bearer token. ZIP uploads use `Content-Type: application/zip`. Page configuration uses `page.theme = { short, version, theme }`, `page.themeOptions`, and optional `page.headCode` and `page.contentHtml`; `version` is the installed `versionKey`. Saving the presentation configuration applies the change.
