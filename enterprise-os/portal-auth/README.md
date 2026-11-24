# portal-auth · 企业OS 门户登录

门户首页（`os.jpmamoru.com`，示例）的登录服务。员工打开首页先看到登录页，用企业 IM 登录一次后，点「对话」「生图」「API 管理」即可进入，不用再输账号密码。

## 它做什么，不做什么

- 它是 Casdoor 里 `portal` 应用的 OIDC 客户端：授权码 + PKCE + nonce，完整校验 ID Token（签名、算法、签发方、受众、有效期、nonce）。
- 登录时用员工的 access token 调 os-bridge `/internal/me`。这一步沿用 os-bridge 的全部规则（部门、在职、账号绑定、管理员账号拒绝），并提前开好 JAPI 账号和 Key，所以之后进入 API 管理时账号已经存在。
- ID Token 的 `sub` 必须等于 os-bridge 识别出的 Casdoor 用户 ID，JAPI 实例必须等于 `bridge.japiInstance`。
- 首页会话只放在内存里，只记录显示用的信息（姓名、邮箱、部门、JAPI 用户 ID、Casdoor ID）。**不保存、不返回任何令牌**，也不保存 ID Token。
- **各应用的会话是各自的。** 免二次登录靠的是 Casdoor 自己的会话，加上 Casdoor 应用的「自动登录」。门户卡片的地址会让每个应用**重新发起一次授权**，所以进入的一定是当前登录的员工。
- 服务端请求一律不跟随 HTTP 跳转（防止客户端密钥或员工令牌被转发到别处）。

## 接口（Nginx 把 `/auth/` 转到 `127.0.0.1:3292`）

| 路径 | 作用 |
| --- | --- |
| `GET /auth/login[?app=chat\|image\|api]` | 跳到 Casdoor 登录；带 `app` 时登录后直接进入该应用 |
| `GET /auth/callback` | Casdoor 回调：校验后建立首页会话 |
| `GET /auth/me` | 当前员工（姓名、邮箱、部门）和可用应用；每 60 秒复核一次账号状态 |
| `POST /auth/logout` | 只接受本站表单；结束首页会话，再跳到 Casdoor 结束 Casdoor 会话（不带 `id_token_hint`） |
| `GET /auth/logged-out` | Casdoor 退出后的回跳，核对 state |
| `GET /auth/healthz` | 存活检查 |

## 会话与复核

- 首页会话最长 `sessionMaxHours`（默认 8 小时）。到期后回到登录页；只要 Casdoor 会话还在，点登录不会再要求扫码。
- 每 `recheckMs`（60 秒）向 os-bridge `/internal/users/:id` 复核一次。以下情况立即退出首页：
  - 账号停用、离职或无部门；
  - 绑定的 Casdoor ID 变了；
  - 邮箱变了；
  - JAPI 实例不一致。
- os-bridge 暂时连不上时，自上次**成功**复核起 `recheckGraceMs`（5 分钟）内保持登录，超过就退出。os-bridge 自己在 Casdoor 故障时沿用上次结果（原有行为），这个宽限期不改变这一点。
- 打开着的首页每 60 秒和切回页面时重新查询一次，被停用后入口会自动隐藏。
- 服务重启会清空首页会话（员工重新点登录即可）。

## 换人登录

同一浏览器里，有人在首页仍处于登录状态时发起新的登录：只要这是本浏览器自己发起的有效登录（state 与登录 Cookie 一致），原来的首页会话就会先被结束。

- 新登录被拒绝（未分配部门、管理员账号、身份或绑定不符、登录失败）时，首页回到登录页，不会继续显示上一位员工。
- 伪造或无效的回调（state 不对）不会让当前员工被登出。


## 退出

- 首页「退出」会结束首页会话和 Casdoor 会话。之后点任何卡片都需要重新用 IM 登录。
- 退出必须来自门户页面自己的表单：请求的 Origin 必须正好是门户地址，`Origin: null`、其他站点和非表单请求都被拒绝。门户页面的 Referrer-Policy 必须是 `same-origin`，否则浏览器发出的 Origin 是 `null`。
- 只有回跳中的 state 与退出时设置的 Cookie 完全一致（各一个、格式正确）时，首页才显示「已退出」。
- Casdoor 暂时无法退出时，首页提示并提供「再次退出企业登录」按钮。
- **已经打开的应用页面不会被同时退出**：生图、对话、API 管理按各自的会话有效期失效。在公用电脑上，请在各应用里也点退出。

## 部署（运维执行）

```sh
sudo useradd --system portal-auth
sudo cp -r enterprise-os/portal-auth /opt/portal-auth
sudo mkdir -p /etc/portal-auth
sudo cp enterprise-os/portal-auth/config.example.json /etc/portal-auth/config.json   # 按注释改域名、Client ID、japiInstance
# 两个密钥文件：Casdoor portal 应用的 Client Secret；与 os-bridge secrets.json 中 internalToken 相同的内容（单独一份副本）
sudo install -m 0640 -o root -g portal-auth /dev/null /etc/portal-auth/client-secret
sudo install -m 0640 -o root -g portal-auth /dev/null /etc/portal-auth/os-bridge-internal.token
sudoedit /etc/portal-auth/client-secret /etc/portal-auth/os-bridge-internal.token
sudo cp enterprise-os/portal-auth/portal-auth.service /etc/systemd/system/ && sudo systemctl enable --now portal-auth
curl -H 'Host: os.jpmamoru.com' http://127.0.0.1:3292/auth/healthz
```

配置里有 `<...>` 占位值、地址不是 https、os-bridge 地址不是本机，或者密钥文件为空时，服务会拒绝启动。

Casdoor 设置（`portal` 应用、自动登录、退出回跳地址）见 `enterprise-os/deploy/casdoor/SETUP.md`。Nginx 见 `enterprise-os/portal/nginx-portal.conf`。

## 测试

```sh
cd enterprise-os/portal-auth && node --test test/*.test.mjs
```

测试用的是模拟的 Casdoor 和 os-bridge（测试里现场生成的 RSA/EC 密钥），**不是**真实环境验收。
