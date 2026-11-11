# 配置保险库（Node.js 22+，无第三方运行依赖）

复用已有账号登录及 AES-256-GCM 密钥。个人设置、会话、配置附件、团队草稿和发布记录均加密存储。不要重新生成已有 `--key-file`，否则旧存档将无法解密。

## 启动与管理员授权

```sh
node server.mjs --origin https://example.com --auth-base http://127.0.0.1:8080/api/v1 --store /private/config-vault --key-file /private/config-vault.key --admin-users-file /private/config-vault-admins.json --public-rules-dir /srv/application/public-rules --port 3183
node admin-users.mjs --file /private/config-vault-admins.json --action grant --user-id 123
node admin-users.mjs --file /private/config-vault-admins.json --action list
node admin-users.mjs --file /private/config-vault-admins.json --action revoke --user-id 123
```

账号 ID 必须来自现有账号服务，不能使用邮箱猜测。默认无人拥有团队管理权限。管理员文件置于私有目录；授权即时生效，无需重启。`--public-rules-dir` 指向实际 `/public-rules/` 静态目录，发布时会校验文件存在。旧 URL 继续由静态服务器分发；新附件使用鉴权保险库接口。

反向代理整个 `/api/config-vault/`，请求体上限建议 30MB、读取超时 60 秒；保留 `Host`、`Origin`、`X-Config-User` 和 Cookie。若配置了 `proxy_pass_request_headers off`，必须逐项显式转发这些头以及 `Content-Type`、`Sec-Fetch-Site`。不能沿用旧 256KB 请求限制，否则附件会被拦截。API 仍仅监听本机。不要把保险库存储目录放进网页静态目录。部署时须同步本目录的 `server.mjs`、`settings.mjs`、`validation.mjs` 和 `commerce-policy-schema.json`。

## 企业账号登录（可选）

接入企业OS后，员工可用飞书 / 企业微信 / 钉钉（经 Casdoor）登录，不再需要 JAPI 密码。启动时追加 `--sso-config /private/config-vault-sso.json`（格式见 `sso-config.example.json`），未提供该参数时行为与原来完全相同。

配置项（`sso-config.example.json`）：

- `bridge.baseUrl`：os-bridge 内部接口地址，默认 `http://127.0.0.1:3291`（os-bridge 的独立内部端口，不是对外的 3290）。所有请求带 `x-internal-token`（取自 `bridge.tokenFile`）。
- `bridge.japiInstance`（**必填**）：必须与 os-bridge 配置 `japi.instance` 完全相同。保险库只按 JAPI 数字用户 ID 区分账号（个人配置 `user-<id>`、素材、团队成员、管理员名单、relay 任务），所以**只有当 os-bridge 连接的 JAPI 与本服务 `--auth-base` 是同一个 Sub2API 实例时才能这样配置**；指向不同实例会导致 ID 撞号、员工看到别人的数据。保险库在每次 `/internal/me` 与 `/internal/users/:id` 的应答中校验 `instance`，不一致即拒绝 SSO（503）并记录一条不含身份和密钥的日志。缺失或仍是 `<...>` 占位值时服务拒绝启动。
- `sessionMaxHours`：SSO 会话的绝对时长上限，默认 12，最大 168。到期后须重新企业登录（不随 Casdoor 会话结束，也不续期）；调低后对已签发的会话立即生效。密码登录会话仍为 7 天。
- `managedChannel`：托管渠道的名称、地址和模型。`models` 须按网关实际提供的模型名填写；示例只列出图片模型，需要文本模型时自行追加 `{ "name": "实际模型名", "capability": "text" }`。名称形如 `<...>` 的占位值会被忽略并记录日志，不会下发给前端。

流程：

- `GET /oidc/start?return=/image`：跳转 Casdoor（授权码 + PKCE）。state 存入 `oidc/` 子目录下的加密一次性记录，并用 `Path=/api/config-vault/oidc` 的 Lax Cookie 绑定当前浏览器。未被消费的过期记录在启动时和之后的 start 请求中（至多每分钟一次、每次至多扫描 1000 个文件）按文件时间清理。
  - start 是从站内页面发起的同站顶层导航，会带上 SameSite=Strict 的会话 Cookie；此时吊销该浏览器出示的旧会话并清除其 Cookie（跨站回调带不上这些 Cookie，无法在回调时吊销）。
  - 授权地址带 `provider_hint`，值取 os-bridge `GET /internal/config` 返回的 `loginProvider.name`，缓存 5 分钟，以跳过 Casdoor 的 IM 选择页；取不到时（失败缓存 1 分钟）不带该参数，不影响登录。
- `GET /oidc/callback`：校验 state、换取 access token，交给 os-bridge `/internal/me` 映射到 JAPI 用户，签发与密码登录相同的两个会话 Cookie，然后回到 `return` 指定的站内路径。失败时跳回 `/#server-config-sso=failed|unavailable`。
- 会话仍以 **JAPI 用户 ID** 为主体，已有个人配置、素材库、团队成员和任务不需要迁移。SSO 会话不保存 JAPI 令牌，每 60 秒经 os-bridge `/internal/users/:id` 复核账号状态；员工在 JAPI 停用，或在 Casdoor 被禁用/删除后，下一次复核即失效。
- `GET /session` 对 SSO 会话返回 `user.managed: true`；`GET /managed-channel` 返回 `infinite-canvas-channel` v1 渠道文件，内含该员工自己的 JAPI Key。前端以固定 id `managed-enterprise` 单独保存该渠道，不与同地址的手填渠道合并；仅在首次加入且员工还没有对应默认模型时设置默认模型。
- 托管渠道及其 Key 只在内存中：不写入个人配置同步、团队发布、配置导出、迁移备份或浏览器本地存储（保险库也会在保存个人配置时剔除该 id 的渠道）。每次登录或会话恢复时重新从 `/managed-channel` 获取；会话失效（401）、复核停用或退出登录时从本地配置移除。
- Casdoor 中 jimage 应用的回调地址填 `https://<站点>/api/config-vault/oidc/callback`。前端运行时配置加 `enterpriseSsoEnabled: true` 后显示登录按钮（可用 `enterpriseSsoLabel` 改文字）。
- 反向代理需放行 `/api/config-vault/oidc/` 的 GET 顶层跳转（不带 Origin 头），其余规则不变。

## 接口

- `GET /settings`：schemaVersion=2、当前账号、manageTeam 权限、personal/team；管理员另获 draft。
- `GET /settings/versions`：各范围修订号，供轮询；无任何密钥。
- `PUT /settings/personal {revision,value}`：原子保存个人设置，返回 SettingsSection。与旧 `/config` 共用个人修订号；旧接口只更新 config，不删除 extras。
- `PUT /settings/team/draft {revision,value}`：保存草稿，返回草稿 section。允许不完整，不允许未知敏感字段、本机附件或商品图绑定。
- `POST /settings/team/validate {value}`：返回 `{valid,errors}`。
- `POST /settings/team/publish {revision}`：修订号为 draft.revision；返回发布 section，草稿同时递增并更新为发布内容。
- `GET /settings/team/history`：管理员获取 `{history:[{version,revision,savedAt,actor,rollbackOf?}]}`。
- `POST /settings/team/rollback {revision,version}`：以指定历史内容发布更高版本；revision 为当前草稿版本。
- `POST /assets {scope,name,mimeType,data}`：data 为标准 base64，scope 为 personal/team，返回 SettingsAsset；支持 PNG/JPEG/WebP/GIF/TTF/OTF/WOFF/WOFF2，单文件最多 20MB，编码后的 JSON 请求体最多 30MB。禁止 SVG/HTML。个人附件隔离到当前账号；团队上传须管理员。
- `GET /assets/team/<sha256>` 或 `/assets/personal/<sha256>`：需登录，返回原始字节。

团队配置的 `TeamSettings.modelConfig` 统一保存渠道（含 API Key）、模型列表、五个默认模型和流程角色。默认模型必须绑定团队渠道；`sceneModel`、`repairModel`、`copyModel`、`translationModel`、`complianceModel` 允许为空，客户端分别回退到团队图片或文本默认模型。管理员才可写草稿、发布和回滚，普通成员只能读取已发布版本。模型配置与类目规则共用团队修订号、冲突检测和不可变发布历史，个人主题、语言、提示词来源、WebDAV 等仍在个人修订号中同步。

所有新写入携带 `X-Config-User: 当前账号ID`，不匹配返回409。会话注销与写入串行，注销后不得保存。权限不足403，未登录401，修订冲突409，校验失败422（可展示原因）。GET须同源 Origin，或浏览器同源 Fetch Metadata。

## 发布、备份与回滚

每次发布先写不可变 release，再原子更新单个 `settings-team.enc`。此文件同时包含生效指针、草稿、历史及审计，避免跨文件提交不一致；中途故障至多产生未引用 release，不会出现部分生效状态。单个服务进程独占存储，不能多进程共写。

发布生成 `server-aoweisi-team-v<version>-<hash>`，品牌也使用版本化 ID。历史任务保留旧版本。已发布类目不能删除；回滚时保留后来新增类目的停用记录。新版本号高于输入和历史版本。

升级前一致备份整个私有存储目录、密钥、管理员文件及前端目录。不要只备份个人记录而遗漏附件。服务可兼容旧 user-N.enc 并保留 `/config`，首次读取旧数据转换为个人 section 而不覆盖原档。程序回滚不要求还原用户数据；团队内容回滚用管理接口生成新版本。

```sh
node --test config-vault/*.test.mjs
```

测试使用临时独立服务和存储，覆盖双账号隔离、双浏览器同账号恢复、首次保存、并发冲突、旧接口兼容、重启、权限、附件、团队发布、回滚和语义校验。不调用真实生图模型。
