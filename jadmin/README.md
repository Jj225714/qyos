# Jadmin

入口：客户配置的管理域名。服务默认监听 `127.0.0.1:8090`，由 Nginx 提供 HTTPS。

## 已部署能力

- 管理后台登录、审计、CPU/内存/磁盘/Docker 状态；
- Jchat 用户创建、启用/停用、重置密码；Jchat API 地址、Key、默认模型和模型列表；
- 四个业务模块及配置保险库、模型转发服务的健康状态；
- 通过 JAPI 现有 `/api/v1` 管理接口读取管理员账户、用户、API Key 掩码和用量摘要；
- 读取配置保险库团队管理员，并授权或撤销管理员，操作写入审计记录；
- Jimage页面可达性检查。Jimage 工作区和浏览器 IndexedDB 数据仍需在Jimage内导入。

## 运行依赖

Python 3、`bcrypt`、Docker CLI，以及环境变量 `ADMIN_SECRET`、`ADMIN_EMAIL`、`ADMIN_PASSWORD`。生产环境还需能读取 JAPI `.env` 和配置保险库管理员 CLI；可用以下变量覆盖默认路径：`SUB2API_BASE_URL`、`SUB2API_ENV`、`CONFIG_VAULT_ADMIN_FILE`、`CONFIG_VAULT_ADMIN_CLI`。

Jchat 路径、Mongo 容器名和配置文件也支持 `LIBRECHAT_ENV`、`LIBRECHAT_CONFIG`、`LIBRECHAT_MONGO_CONTAINER`。不要把凭据、`admin.db`、主密钥或真实 API Key 放进公开安装包。

## 新服务器安装

本目录是客户独立安装副本，不包含现网域名、数据库、用户、密钥或保险库主密钥。默认安装目录为 `/opt/enterprise-ai-platform/admin-panel`，所有路径和域名均可通过环境变量覆盖。

1. 安装 Python 3、bcrypt、Docker、Node.js（配置保险库要求 Node.js 22+）。
2. 按 `docs/architecture.md` 部署 Jchat、JAPI、配置保险库、provider-relay 和Jimage 静态站。
3. 复制 `admin-panel.service.example` 为 systemd 服务，写入私有环境文件，并把 Nginx 站点指向 `127.0.0.1:8090`。
4. 首次登录后检查“模块状态与能力”，再用“JAPI与配置保险库”卡片验证接口。
5. 用 `healthcheck.py` 做匿名页面、登录和模块接口验收。

JAPI 的上游账号、分组、额度和 PostgreSQL 数据属于其自身管理范围；当前后台只读取安全摘要，避免绕过它的业务校验直接改库。

## 企业OS：企业账号登录与部门管理

新增文件 `enterprise.py`、`enterprise-ui.js`、`test_enterprise.py`，`server.py` 挂接路由，并包含下面列出的安全加固。

- **启动检查：** `ADMIN_SECRET` 少于 32 个字符时拒绝启动。原实现中该变量为空时，任何人都能伪造登录令牌。
- **企业账号登录：** 管理员可经 Casdoor 登录，回调地址 `https://<Jadmin 域名>/api/sso/callback`。授权地址带 `provider_hint`，直接跳到当前选定的 IM。只有已**显式关联**的 Casdoor 用户才能进入，且关联的邮箱必须仍是 `ADMIN_EMAIL` 或 users 表中启用的 ADMIN 账号；原邮箱密码登录保留。
- **登录方式（三选一）：** 在「登录方式」卡片里选择飞书、企业微信或钉钉（默认飞书）。保存后，Jadmin 把 `CASDOOR_APPS` 中每个应用的 IM 提供商改为只剩所选的一项（验证码等非 IM 提供商不动），os-bridge 从部门接口的 `loginProvider` 读到同一设置。
- **安全加固：** `/api/admin/credentials` 只返回 Key 掩码（前 7 位 + 后 4 位），不再返回管理员明文密码；写入 `librechat.env` / `librechat.yaml` 的值拒绝换行和空字符；`/api/sso/start` 每 IP 每分钟最多 10 次；页面带 CSP（内联脚本按哈希放行，`frame-ancestors 'none'`）、`X-Frame-Options: DENY`、`nosniff`、`Referrer-Policy: no-referrer`；sqlite 启用 WAL，每个请求独立连接。
- **部门与员工：** 在后台维护部门（代码、名称、Casdoor 群组、JAPI 分组 ID）和按邮箱的手动分配。生效顺序：手动分配 → 第一个包含员工 Casdoor 群组的部门 → 未分配。os-bridge 每分钟从 `GET /api/internal/departments`（`X-Internal-Token`）读取。
- **员工资料检查：** 用 Casdoor 应用凭据读取全部员工，列出缺邮箱、缺手机号、邮箱或手机号重复、未绑定 IM、未分配部门的人，并可在表格里直接改部门。

环境变量（密钥建议用 `_FILE` 形式指向权限 0600 的文件）：

| 变量 | 说明 |
| --- | --- |
| `CASDOOR_URL` | 例如 `https://sso.jpmamoru.com` |
| `CASDOOR_ORG` | Casdoor 组织名，例如 `jpmamoru` |
| `CASDOOR_CLIENT_ID`、`CASDOOR_CLIENT_SECRET(_FILE)` | Casdoor 中 jadmin 应用的凭据；同时用于读取员工列表 |
| `JADMIN_ORIGIN` | Jadmin 对外地址，例如 `https://jadmin.jpmamoru.com` |
| `OS_BRIDGE_TOKEN(_FILE)` | 与 os-bridge `secrets.json` 的 `jadminToken` 相同 |
| `CASDOOR_ADMIN_ACCESS_KEY(_FILE)`、`CASDOOR_ADMIN_ACCESS_SECRET(_FILE)` | 专用 Casdoor **全局管理员**用户的 accessKey / accessSecret，只用于读取和修改应用的提供商列表。不配置时切换登录方式只保存设置，需按页面提示在 Casdoor 手动调整 |
| `CASDOOR_APPS` | 需要同步登录方式的 Casdoor 应用（owner 为 admin），默认 `jchat,jimage,jadmin` |
| `CASDOOR_IM_PROVIDERS` | 三种 IM 在 Casdoor 中的提供商名称，默认 `lark=provider_lark,wecom=provider_wecom,dingtalk=provider_dingtalk` |

### 管理员关联企业账号

管理员不能"第一次用企业账号登录就自动绑定"，必须本人显式关联：

1. 先用邮箱和密码登录 Jadmin。
2. 在「企业账号关联」卡片点击「关联企业账号」，浏览器跳到 Casdoor（关联链接 10 分钟内有效、只能用一次）。
3. 在 Casdoor 用自己的 IM 完成登录，回到后台后提示"已关联企业账号"。以后即可点「企业账号登录」直接进入。

当登录方式为飞书或钉钉时，Casdoor 返回的 `email_verified` 必须为 true；企业微信不声明邮箱已验证，此时只看关联关系。没有关联记录的企业账号一律不能进入管理后台。管理员可在同一卡片解除自己的关联，`ADMIN_EMAIL` 对应的所有者可解除任何人的关联。升级前已存在的关联继续有效。

### 切换登录方式

- 飞书、钉钉：Casdoor 按已验证的邮箱或手机号把 IM 登录合并到已有用户，绑定规则 `Email, Phone`。
- 企业微信：企业微信内部应用从不声明邮箱/手机号已验证，只能按用户名合并，绑定规则 `Name`。需要在企业微信提供商上开启「使用 ID 作为用户名」（UseIdAsName），并保证每位员工的 Casdoor 用户名等于其企业微信 userid。
- **从飞书或钉钉切到企业微信之前**：先在「员工资料检查」确认每个人都已绑定企业微信。「登录方式」卡片会显示未绑定人数，保存时还会再次确认，未绑定的员工切换后无法登录。
- 每个应用都要开启「启用注册」，否则新员工首次登录会失败；员工范围由提供商的邮箱正则和 IM 企业通讯录限定。
- 同步时 Jadmin 先读取应用，再提交 `update-application?columns=providers`，只改提供商这一列。任何一个应用失败都会在页面上写明应用名，修复后重新保存即可。

测试：`python3 -m unittest jadmin/test_enterprise.py`
