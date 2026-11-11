# Casdoor 配置步骤

以下步骤在 Casdoor 后台（`https://sso.jpmamoru.com`）完成。字段名以后台界面为准；行为依据 Casdoor 上游源码（2026-11-11 master）核对。

**登录方式只用一个 IM。** 飞书、企业微信、钉钉三选一，**默认飞书**，在 Jadmin「登录方式」里切换（见第 3 节）。三个 Provider 都先在 Casdoor 建好，但同一时间每个应用只挂一个；Casdoor 服务端只允许应用 Provider 列表里的方式登录，所以切换在服务端生效，不只是界面上隐藏按钮。

## 0. 启动

1. `cp .env.example .env`，填写 `CASDOOR_VERSION`（固定版本号，不要用 latest）、两个数据库密码、`CASDOOR_INIT_ADMIN_PASSWORD`（强随机）。
2. 从同版本镜像取出 `app.conf`，把 `runmode` 改成 `prod`（Casdoor 的 runmode 只认 app.conf，环境变量无效；dev 模式会开放 `/swagger`）：
   ```sh
   docker run --rm --entrypoint cat casbin/casdoor:$CASDOOR_VERSION /conf/app.conf > app.conf
   sed -i 's/^runmode *= *dev/runmode = prod/' app.conf && grep ^runmode app.conf
   ```
3. `docker compose up -d`，**立刻**打开 `https://sso.jpmamoru.com` 用 `admin` 和 `CASDOOR_INIT_ADMIN_PASSWORD` 登录。如果出现"设置管理员密码"的初始化页面，说明这个版本的镜像不支持 `initAdminPassword`：马上在这个页面设好强密码（谁先打开谁就能设置），之后升级到支持该变量的版本。
4. 登录后删除 `.env` 里的 `CASDOOR_INIT_ADMIN_PASSWORD`，并在 `docker-compose.yml` 里删掉 `initAdminPassword` 那一行。

## 1. 组织

1. 新建组织 `jpmamoru`（后面的 `<org>` 都指它）。
2. 「群组」里建群组，可以照搬 IM 的组织架构；员工令牌里会出现 `jpmamoru/sales` 这样的值。业务部门在 **Jadmin「部门目录」**里定义（一个部门可包含多个群组，个别员工可按邮箱手动指定）。
3. **账户项（Account items）的修改规则**：`Email`、`Phone`、`Groups`、`Is forbidden` 设为 `Admin` 或 `Immutable`，**不要是 `Self`**。Casdoor 默认 Email/Phone 是 `Self`。邮箱决定员工对应的 JAPI 账号、Jchat 账号和 Jadmin 管理员身份。
4. **限制组织管理员人数。** `jpmamoru` 的组织管理员能为本组织新建签名证书；任何持有本组织应用 Client Secret 的系统（Jadmin、os-bridge）在 Casdoor 里也等同组织管理员。这些 Secret 按管理员密码级别保管（文件权限 0600，不进 Git）。os-bridge 只信任各应用自己的 JWKS（`/.well-known/<应用>/jwks`），不受此影响；但 Jchat（LibreChat）用的是全局 JWKS，所以组织管理员权限只给必要的人。

## 2. 三个 IM Provider

在「提供商」新建三个 OAuth Provider，凭证来自各 IM 开放平台的**企业自建应用**。名称请用下表的默认值（Jadmin 的 `CASDOOR_IM_PROVIDERS` 按这些名称找 Provider；改名的话两边一起改）：

| Provider 名称 | 类型 | 开放平台权限 | 关键设置 |
| --- | --- | --- | --- |
| `provider_lark` | Lark（飞书） | 获取用户邮箱、手机号 | 员工的「邮箱」字段应为公司邮箱（Casdoor 优先取 `email`，没有才用企业邮箱） |
| `provider_dingtalk` | DingTalk（钉钉） | 个人信息、手机号、邮箱 | 同上 |
| `provider_wecom` | WeCom（企业微信，Internal） | 网页授权、读取成员 | **勾选 Use id as name**（Casdoor 用户名 = 企业微信 userid） |

每个 Provider 都设置 **Email regex** 为公司域名，例如 `^[^@]+@jpmamoru\.com$`，非公司邮箱不能注册。

回调地址都是 `https://sso.jpmamoru.com/callback`；企业微信的可信域名填 `sso.jpmamoru.com`。

**为什么企业微信要特殊处理：** Casdoor 只有在 IM 声明邮箱或手机号"已验证"时，才按邮箱或手机号找到已有账号。飞书、钉钉会声明已验证，企业微信从不声明。所以企业微信只能按用户名（= 企业微信 userid）找人。Jadmin 选企业微信时，会自动把绑定规则设为 `Name`。

## 3. 应用（jchat、jimage、jadmin、os-bridge）

| 应用 | 回调地址 | 用途 |
| --- | --- | --- |
| `jchat` | `https://jchat.jpmamoru.com/oauth/openid/callback` | Client ID 写进 LibreChat `.env` 和 os-bridge `casdoor.audiences` |
| `jimage` | `https://jimage.jpmamoru.com/api/config-vault/oidc/callback` | Client ID 写进保险库 `sso-config.json` 和 os-bridge `casdoor.audiences` |
| `jadmin` | `https://jadmin.jpmamoru.com/api/sso/callback` | Jadmin 管理员登录、员工资料检查 |
| `os-bridge` | 不需要（不用于登录） | os-bridge 用它的 Client ID/Secret 读取员工在职状态 |

`jchat`、`jimage`、`jadmin` 三个应用都要：

- 组织选 `jpmamoru`；Token format 保持 `JWT`（os-bridge 依赖其中的 `email`、`email_verified`、`groups`、`isForbidden`）；证书保持默认 RS256。
- **Expire in hours 设为 `1`**（默认 168，即 7 天）。Refresh token expire in hours 可保持默认。令牌签出后无法撤回，有效期就是员工被禁用后还能用旧令牌的最长时间。
- **保持允许注册（Enable signup 打开）。** Casdoor 只有在允许注册时，才会为第一次用 IM 登录的新员工建账号。注册范围由 IM 企业通讯录和 Provider 的 Email regex 限定。密码注册入口在「注册项」里去掉。
- Providers 里先只加 `provider_lark`（canSignUp、canSignIn 打开，绑定规则 `Email`、`Phone`）。之后由 Jadmin 维护这一项。
- 登录方式只保留 IM。管理员账号可保留密码登录作为应急入口。

### 由 Jadmin 切换 IM

Jadmin 用一个**全局管理员**的 Access Key 改写这三个应用的 Provider 列表（组织级凭据无权修改应用）。

1. 在 `built-in` 组织下建一个专用用户（例如 `jadmin-sync`），设为管理员，并生成 Access key / Access secret。
2. 把它们写进 Jadmin 的 `CASDOOR_ADMIN_ACCESS_KEY` 和 `CASDOOR_ADMIN_ACCESS_SECRET_FILE`（权限 0600）。
3. 在 Jadmin「登录方式」里选择 IM 并保存。Jadmin 会对 `CASDOOR_APPS`（默认 `jchat,jimage,jadmin`）逐个替换 IM Provider 项，并显示每个应用的同步结果。
4. 没配这个凭据时，Jadmin 只保存设置，并提示你到 Casdoor 手动改三个应用的 Providers。手动改法：每个应用的 Providers 只保留所选 IM（验证码等非 IM 项不动）；该项设为可注册、可登录、不可解绑，绑定规则飞书和钉钉为 `Email`、`Phone`，企业微信为 `Name`。

**这把 Access Key 等于 Casdoor 的全局管理员**，泄露就意味着 Casdoor 被完全接管。另外，Casdoor 要求用 URL 查询参数传 Access Key，所以 Casdoor 前面的 Nginx 不要记录查询串，例如对 `/api/` 使用不含 `$request_uri` 的 log_format，或者关闭 access_log。

Jadmin 的 `/api/sso/start` 按客户端 IP 限流，IP 取 `X-Forwarded-For` 的最后一跳。所以 Jadmin 前面的 Nginx 要设置 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`，并且 Jadmin 只能监听 127.0.0.1。

Jadmin 和 Jimage 的登录跳转会带上 `provider_hint=<所选 Provider>`，员工直接进入该 IM 的授权页。

**切换前须知：**

- **飞书 ⇄ 钉钉：** 老员工在新 IM 里的邮箱必须与 Casdoor 中的一致（按已验证邮箱或手机号匹配）。先在 Jadmin「员工资料检查」里核对。
- **切到企业微信：** 每个员工的 Casdoor 用户名必须等于其企业微信 userid，或者员工已在「我的账户」里关联过企业微信。否则这些人会因"邮箱已存在"而登录失败。Jadmin 会显示未绑定企业微信的人数，并要求确认后才切换。

## 4. Webhook（离职联动）

os-bridge **不信任 Webhook 内容**。Casdoor 的 Webhook 记录里，`object` 是原始请求体（失败的请求也会发送），`extendedUser` 是**操作者**而不是被操作的员工。所以 Webhook 只用来通知"某人可能变了"，os-bridge 收到后用 `os-bridge` 应用的凭据重新读取这个员工的状态。

另外，os-bridge 每 10 分钟（`reconcile.intervalMs`）全量对账一次：Casdoor 里已删除或禁用的员工，其 JAPI 账号和 Key 会被停用。所以 Webhook 漏发也不会影响离职。

在 **built-in** 组织下新建 Webhook（只有 built-in 的 Webhook 能访问内网地址）：

- URL：`http://host.docker.internal:3290/webhooks/casdoor`
- Method：POST；Content type：`application/json`
- Headers：`X-OS-Bridge-Secret: <与 os-bridge secrets.json 的 webhookSecret 相同>`
- Events：`login`、`new-user`、`signup`、`add-user`、`update-user`、`delete-user`（IM 首次登录发出的是 `login` + `new-user`）
- **不要**勾选 Is user extended（它带的是操作者，os-bridge 也不用）
- 重试：默认共尝试 3 次，间隔 60 秒

## 5. 验证

1. Jadmin「员工资料检查」里没有缺邮箱、邮箱重复的人。
2. 用所选 IM 登录一个测试员工：Casdoor「用户」里出现该员工，`email_verified` 为真。os-bridge 日志出现 `user_created`，JAPI 出现该用户和 `enterprise-os` Key。
3. 在 Casdoor 禁用该员工：os-bridge 日志出现 `user_disabled` 和 `key_disabled`，JAPI 里用户和 Key 都变为 disabled。
4. 重新启用：日志出现 `user_reactivated`。
5. 不发 Webhook，直接在 Casdoor 删除一个测试员工：10 分钟内（或重启 os-bridge 后 10 秒）日志出现 `reconcile_done`，`disabled` 为 1。
6. 在 Jadmin 把登录方式切到钉钉再切回飞书：三个应用的 Providers 随之变化，Jadmin 显示同步成功。
