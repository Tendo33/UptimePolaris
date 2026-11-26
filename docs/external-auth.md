# 外部认证

[English](#english)

Go 后端可接受反向代理已验证的身份，或 Cloudflare Access 签发的 JWT。通过验证的身份拥有管理员权限。此功能默认关闭，Worker 后端不支持这些配置。

先通过 `/setup` 创建本地管理员，再启用外部认证。保留本地账户和可选的 `POLARIS_ADMIN_TOKEN` 作为恢复入口。外部身份不会与同名本地账户合并，也不能修改本地账户的用户名和密码。公开页面继续按原来的范围脱敏。

## 配置

在进程环境或工作目录的 `.env` 中配置，修改后重启 Go 服务。每次只能启用一种模式。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `POLARIS_AUTH_MODE` | `disabled` | `disabled`、`trusted-header` 或 `cloudflare-access` |
| `POLARIS_AUTH_HEADER` | `Remote-User` | 可信代理注入的身份头，仅用于 `trusted-header` |
| `POLARIS_AUTH_TRUSTED_PROXIES` | 空 | 允许注入身份的直连代理 CIDR，逗号分隔；可信头模式必填 |
| `POLARIS_AUTH_CF_TEAM_DOMAIN` | 空 | `https://<team>.cloudflareaccess.com`；Access 模式必填 |
| `POLARIS_AUTH_CF_AUDIENCE` | 空 | Access 应用的 AUD 标签；Access 模式必填 |
| `POLARIS_AUTH_ALLOWED_IDENTITIES` | 空 | 允许登录的身份，逗号分隔；留空接受所选模式下所有通过验证的身份 |

可信头身份按原值匹配，区分大小写。Access 身份按 Token 内的邮箱匹配，不区分大小写。这里的白名单控制管理员权限，建议明确列出需要管理后台的身份。

### Authelia、Authentik 等可信代理

```dotenv
POLARIS_AUTH_MODE=trusted-header
POLARIS_AUTH_HEADER=Remote-User
POLARIS_AUTH_TRUSTED_PROXIES=127.0.0.1/32,::1/128
POLARIS_AUTH_ALLOWED_IDENTITIES=alice,bob
```

代理应先完成认证，再覆盖 `Remote-User`，并保留原始 `Host`。不可将客户端传入的同名头直接转发。代理和 Polaris 不在同一主机时，填写实际直连代理的 CIDR；Docker 部署不要照抄回环地址。

此白名单独立于用于登录限流的 `POLARIS_TRUSTED_PROXIES`，也独立于 `POLARIS_TRUST_PROXY`。认证只使用 TCP 连接的对端地址，不使用 `X-Forwarded-For` 或 `Forwarded` 判断可信代理。缺少身份、重复身份头、不在白名单的身份或不可信来源，都不能获得外部管理员权限。`0.0.0.0/0` 和 `::/0` 不允许作为认证代理范围。

### Cloudflare Access

```dotenv
POLARIS_AUTH_MODE=cloudflare-access
POLARIS_AUTH_CF_TEAM_DOMAIN=https://your-team.cloudflareaccess.com
POLARIS_AUTH_CF_AUDIENCE=your-application-aud
POLARIS_AUTH_ALLOWED_IDENTITIES=owner@example.com,operator@example.com
```

在 Cloudflare Access 中创建保护 Polaris 后台的应用，复制团队域名和应用 AUD。代理必须向 `/admin`、登录页和管理 API 传递 `Cf-Access-Jwt-Assertion`。Agent、Push 和公开状态接口仍使用各自的访问规则，不要用交互式登录拦住机器上报。

Polaris 从团队域名的 `/cdn-cgi/access/certs` 获取公钥，校验 RS256 签名、签发方、AUD、有效期、`nbf`、用户 subject、`type: app` 和邮箱。仅有身份邮箱头不算认证，缺少用户邮箱的服务 Token 不能登录后台。公钥会缓存在内存中；新签名密钥触发刷新，刷新请求间隔至少 10 秒，单次超时 5 秒。新密钥暂时不可用时拒绝认证，可稍后重试或使用本地账户。

Access 配置遵循 [Cloudflare 的 JWT 验证要求](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)。Polaris 不使用 Token 提供的任意公钥 URL。

## 登录、退出和恢复

通过已认证的代理访问后台时，Polaris 自动识别身份。每个请求都需要有效的上游凭据；外部登录不会签发可绕过代理使用的本地登录 Cookie。

点击“退出”会清除本地会话，并暂停当前浏览器会话的外部自动登录。登录页提供“使用外部身份登录”按钮，可重新验证并恢复访问；也可填写本地账户。退出 Polaris 不会注销身份提供方，要结束上游会话需到对应提供方退出。

外部认证失效不会关闭本地密码登录和管理 Bearer Token。若上游本身拦住了所有请求，可从受保护的本机或运维入口使用本地登录，或将 `POLARIS_AUTH_MODE` 改为 `disabled` 后重启。

## English

The Go backend supports identities verified by a trusted reverse proxy and JWTs issued by Cloudflare Access. Accepted identities receive administrator access. External authentication is disabled by default; the Worker backend does not support these settings.

Complete `/setup` with a local administrator first. Keep that account and, optionally, `POLARIS_ADMIN_TOKEN` for recovery. External identities remain separate from local accounts, including accounts with the same name. Their usernames and passwords are managed upstream. Public data redaction stays in effect.

### Configure the provider

Set the following environment variables or place them in the working directory's `.env`, then restart the Go service. Choose one mode.

| Variable | Default | Purpose |
| --- | --- | --- |
| `POLARIS_AUTH_MODE` | `disabled` | `disabled`, `trusted-header`, or `cloudflare-access` |
| `POLARIS_AUTH_HEADER` | `Remote-User` | Identity header for trusted-header mode |
| `POLARIS_AUTH_TRUSTED_PROXIES` | empty | Comma-separated direct proxy CIDRs; required for trusted-header mode |
| `POLARIS_AUTH_CF_TEAM_DOMAIN` | empty | `https://<team>.cloudflareaccess.com`; required for Access mode |
| `POLARIS_AUTH_CF_AUDIENCE` | empty | Access application AUD tag; required for Access mode |
| `POLARIS_AUTH_ALLOWED_IDENTITIES` | empty | Comma-separated administrator identities; empty accepts all identities verified by the chosen mode |

Header identities match exactly, including case. Access identities match the signed email claim without case sensitivity. Set an explicit identity list when only some upstream users should administer Polaris.

For Authelia or Authentik, use the trusted-header example above. The proxy must authenticate each request, overwrite the configured identity header, and preserve `Host`. Never forward a client-supplied identity header unchanged. Set the actual directly connected proxy CIDRs; loopback ranges are unsuitable when the proxy runs elsewhere or in another container. Authentication uses the connection peer, never `X-Forwarded-For` or `Forwarded`. Its CIDRs are separate from the forwarded-client-IP and HTTPS proxy settings. All-address ranges are rejected.

For Cloudflare Access, use the Access example above with your team domain, application AUD and allowed emails. Forward `Cf-Access-Jwt-Assertion` to the console, login page and management APIs. Keep Agent, Push and public routes reachable under their appropriate policies. Polaris verifies RS256, issuer, audience, expiry, not-before time, subject, `type: app` and email against your team's `/cdn-cgi/access/certs` keys. Email headers alone and service tokens without a user email do not grant access. Key refreshes have a five-second timeout and a ten-second minimum interval; cached keys serve normal requests. See [Cloudflare's validation guide](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).

### Sign in, sign out and recover

Valid upstream identities sign in automatically. Every request must retain its upstream credentials; Polaris does not create an independent local login cookie for external identities. Signing out clears the local session and suppresses automatic external sign-in for the browser session. Use “Continue with external sign-in” on the login page to verify the upstream identity again, or sign in with a local account. Signing out of Polaris does not sign out of the identity provider.

`GET /api/auth/session` exposes `authentication` (`local`, `bearer`, `trusted-header`, `cloudflare-access`, or `null`) and `externalAuth` (`{ mode }` when configured after setup, otherwise `null`). `POST /api/auth/external` restores external sign-in after verifying the current upstream credentials. It returns 404 when disabled, 401 for a missing or rejected identity, and 403 for a cross-origin request. Local account changes from an external identity return 403 `external_account_managed`.

Local passwords and admin Bearer tokens remain available if external authentication fails. If the upstream proxy blocks access itself, use a protected local operations route, or set `POLARIS_AUTH_MODE=disabled` and restart.
