# qyos · 企业OS 基础版

日期：2026-11-11。对应方案文档「企业OS 基础版方案」。本版已按融合审查修复，各上游行为都对照源码核对过。

## 一句话

员工用**一个** IM（飞书 / 企业微信 / 钉钉三选一，默认飞书，在 Jadmin 里切换）经 **Casdoor** 登录。**os-bridge** 把每个人映射到自己的 **JAPI** 账号和专属 Key：按人计费，离职即停。它还按部门把 **RAGFlow** 知识库接进 **Jchat**。**Jimage** 新增企业账号登录，老账号数据不迁移。

```
所选 IM（飞书 / 企业微信 / 钉钉，Jadmin 中三选一）
        │  OAuth
     Casdoor ──Webhook（只作"有变化"提示）──┐      ┌─ 每 10 分钟全量对账（读 Casdoor 用户）
        │ OIDC                              ▼      ▼
  ┌─────┼──────────────┐            os-bridge :3290（容器可达） ──admin API──► JAPI（Sub2API）
Jchat   Jimage 保险库   Jadmin        :3291（仅本机 /internal）         ▲
  │ X-OS-Access-Token   │ /internal/*   ▲   │                          │
  └──── /v1/* 、/mcp/knowledge ─────────┘   └─部门 Key─► RAGFlow MCP   │
Jimage 前端 ── 员工自己的 JAPI Key（只在内存，不落盘）───────────────────┘
```

## 目录

| 目录 | 内容 | 验证 |
| --- | --- | --- |
| `enterprise-os/os-bridge/` | 新服务（Node ≥22，零依赖）：模型代理、知识库 MCP 代理、Casdoor 同步（Webhook 加定时对账）、Jimage 内部接口 | `node --test`：27 项全部通过（Node 26.13） |
| `enterprise-os/japi-patch/` | Sub2API 补丁：管理员替用户建 Key、改 Key 状态、scoped 密钥权限。`third_party/sub2api/` 已包含这些改动 | 见其 README |
| `third_party/` | 四个上游项目的源码快照：sub2api（JAPI，含企业OS 改动）、librechat、ragflow、casdoor | 版本和许可证见 `third_party/README.md` |
| `jadmin/` | Jadmin：管理员企业登录（显式关联）、登录 IM 三选一、部门目录、员工资料检查、安全修复 | `python -m unittest jadmin/test_enterprise.py` |
| `config-vault/`、`web/` | Jimage：保险库 SSO 和前端「企业账号登录」；员工渠道独立，Key 不落盘 | `node --test config-vault/*.test.mjs`；web 下 `npx vitest run` |
| `enterprise-os/deploy/casdoor/` | docker-compose、`.env` 模板、后台配置步骤 | 配置模板 |
| `enterprise-os/deploy/librechat/` | `librechat.yaml` 片段、`.env` 片段、老用户迁移步骤 | 按 v0.8.9-rc1 源码核对 |
| `enterprise-os/deploy/ragflow/` | 部署、端口收紧覆盖文件、部门账号、数据源、模型接入 | 按 v1.0.0 源码核对 |

## 部署顺序

以下命令都在服务器上、从本仓库检出后执行：`git clone https://github.com/Jj225714/qyos.git && cd qyos`（`main` 分支）。

1. **JAPI**：从 `third_party/sub2api/` 构建，它已包含企业OS 改动（见 `third_party/README.md`）。如果你们的 JAPI 有其他定制，改为把 `enterprise-os/japi-patch` 的补丁合进去。跑测试后发布。
   - 后台建一把 scoped 管理员密钥，权限见 `enterprise-os/japi-patch/README.md`，`allowed_ips` 只填 os-bridge 所在主机。
   - 按部门建分组。注意分组平台类型：向量接口只支持 OpenAI 平台，生图接口只支持 OpenAI 和 Grok 平台。
   - **新员工的初始余额**：JAPI 默认余额是 0，非订阅分组在余额为 0 时会拒绝调用。二选一：
     - 在 JAPI「系统设置」里调高 `default_balance`（推荐），os-bridge 建号时不传余额；
     - 或给密钥加勾 `users.balance.write`，并在 os-bridge `japi.newUser.balance` 中填写金额。
     - 部门分组也可以改成订阅类型，并配好默认订阅。
2. **Casdoor**：按 `enterprise-os/deploy/casdoor/SETUP.md`。
   - 三个 IM Provider 都建好；jchat、jimage、jadmin、os-bridge 四个应用；Webhook 最后配。
   - 应用令牌有效期设为 1 小时。
3. **Jadmin**：用本分支的 `jadmin/` 替换服务器上的 admin-panel 目录（先备份），配置 `CASDOOR_*`、`JADMIN_ORIGIN`、`OS_BRIDGE_TOKEN`。
   - 在「登录方式」里确认是飞书。
   - 用「员工资料检查」补齐邮箱，在「部门目录」建好部门。
   - 用密码登录后，点「关联企业账号」。
4. **os-bridge**：

   ```sh
   sudo useradd --system os-bridge
   sudo cp -r enterprise-os/os-bridge /opt/os-bridge
   sudo mkdir -p /etc/os-bridge && sudo cp enterprise-os/os-bridge/config.example.json /etc/os-bridge/config.json   # 再按注释填写
   sudo install -m 600 -o os-bridge enterprise-os/os-bridge/secrets.example.json /etc/os-bridge/secrets.json         # 再填入真实值
   sudo cp enterprise-os/os-bridge/os-bridge.service /etc/systemd/system/ && sudo systemctl enable --now os-bridge
   curl http://172.17.0.1:3290/healthz && curl http://127.0.0.1:3291/healthz
   ```

   - `listen.host` 用 Docker 网桥地址（常见为 `172.17.0.1`），容器经 `host.docker.internal` 访问。
   - `internal` 只监听 127.0.0.1，它会返回员工的 Key。
   - **不要对公网开放 3290 和 3291 端口。**
5. **Casdoor Webhook** 指向 os-bridge。用一个测试员工走一遍 SETUP.md 第 5 节的验证。
6. **Jchat**：先按 `enterprise-os/deploy/librechat/MIGRATION.md` 迁移老用户，再合并两个配置片段，重启。
7. **RAGFlow**：按 `enterprise-os/deploy/ragflow/SETUP.md`。把各部门 Key 按**部门代码**写进 os-bridge `secrets.json` 的 `ragflowKeys`，重启 os-bridge。
8. **Jimage**：从本分支构建 `web/`（`npm ci --legacy-peer-deps && npm run build`）并发布，部署本分支的 `config-vault/`；保险库加 `--sso-config`，运行时配置加 `enterpriseSsoEnabled: true`。
   - `bridge.baseUrl` 填 `http://127.0.0.1:3291`。
   - `bridge.japiInstance` 与 os-bridge 的 `japi.instance` 相同。只有当 os-bridge 的 JAPI 与保险库 `--auth-base` 是**同一个 Sub2API** 时才能这样填，否则用户 ID 会撞号。
9. 试点部门全员走一遍，再推广。推广后关闭 Jimage 的手填渠道。

## os-bridge 接口

| 路径 | 端口 | 调用方 | 认证 | 作用 |
| --- | --- | --- | --- | --- |
| `POST /v1/chat/completions` 等 6 个 OpenAI 兼容路径 | 3290 | Jchat | Casdoor **access token**（`X-OS-Access-Token` 或 `Authorization`） | 首次调用开户、建 Key，之后换成员工本人的 JAPI Key 转发（支持流式） |
| `GET/POST/DELETE /mcp/knowledge` | 3290 | Jchat | 同上 | 与模型调用同样的在职检查，然后按部门注入 RAGFlow Key；部门没有知识库时返回空工具列表 |
| `POST /webhooks/casdoor` | 3290 | Casdoor | `X-OS-Bridge-Secret` | 只当作"某人可能变了"，os-bridge 去 Casdoor 读这个人的当前状态 |
| `GET /internal/config`、`/internal/me`、`/internal/users/:id`、`/internal/users/:id/key` | 3291 | Jimage 保险库 | `X-Internal-Token` | 实例标识与所选 IM；身份映射；状态复核（含 Casdoor 禁用）；取员工 Key |
| `GET /healthz` | 两者 | 运维 | 无 | 存活检查；3291 上还返回最近一次对账结果 |

## 安全边界

- **令牌：**
  - 只接受 `tokenType=access-token`、`aud` 在白名单、未过期的 Casdoor JWT，拒绝 id token 和 refresh token，也拒绝 HS 算法。
  - 只信任各应用自己的 JWKS（`/.well-known/<应用>/jwks`）。配置了全局 JWKS 会拒绝启动，因为全局 JWKS 含所有组织的证书。
  - JWKS 刷新失败时继续用已加载的公钥。
- **邮箱：**
  - 默认要求邮箱已验证（`casdoor.requireEmailVerified: "auto"`）。
  - 例外是 Jadmin 选了企业微信时：企业微信不声明邮箱已验证，员工按企业微信 userid 匹配。
- **在职状态：**
  - Webhook 内容一律不信，员工状态都从 Casdoor 重新读取。
  - 每 10 分钟全量对账：Casdoor 中已删除或禁用的员工，其 JAPI 账号和 Key 都会被停用。
  - 一次对账要停用超过 20% 的账号时，会拒绝执行（防止组织配置错误导致全员停用）。
- **管理员处置优先：**
  - 管理员在 JAPI 手动停用的账号，不会被自动恢复。
  - 管理员停用的 Key，或额度用尽、过期的 Key，不会被悄悄换成新 Key，员工会收到 403 `KEY_DISABLED`。
  - JAPI 管理员账号不会被自动绑定。
- **开户条件：**
  - 不在任何部门的人不开户（`provisioning.requireDepartment`）。
  - 新账号带初始余额、并发和 RPM 限制（`japi.newUser`）。
- **其他：** 员工的令牌不会转发给 JAPI 或 RAGFlow；日志不记录令牌和 Key。

**身份绑定：**
- JAPI 账号按邮箱找到，首次使用时绑定到 Casdoor 用户 ID，写在备注里：`os-bridge casdoor:<id>`。之后同一邮箱的其他 Casdoor 用户会收到 403 `IDENTITY_MISMATCH`。
- Jadmin 的管理员只能经显式「关联企业账号」后才能用 SSO 登录。
- 员工确实换了 Casdoor 账号时，由管理员手动解绑：删掉 JAPI 备注里那一段，或在 Jadmin 里解除关联。

**部门与分组：**
- 员工换部门后，下一次请求会把其 `enterprise-os` Key 移到新部门的 JAPI 分组。
- 账号的可用分组里，旧部门的分组会被移除、新部门的分组会被加入；管理员另外加的、不属于任何部门的分组保留。

```sh
cd enterprise-os/os-bridge && node --test test/*.test.mjs && cd ../..
python3 -m unittest jadmin/test_enterprise.py
node --test config-vault/*.test.mjs
```

## 尚未完成 / 需要你们决定

- **按部门的用量报表**还没做。JAPI 已有按用户的用量数据，下一步可在 Jadmin 按部门聚合。
- **提示词审计和风控默认关闭。** 开启后，完整提示词会存进 JAPI 数据库，且**没有自动过期**；需要制定清理策略并告知员工。
- **LibreChat 校验会话用的是 Casdoor 全局 JWKS**，无法通过配置改为应用级。见 `enterprise-os/deploy/librechat/MIGRATION.md`，靠限制 Casdoor 组织管理员来缓解。
- **需要在真实环境实测的：**
  - Casdoor 令牌响应里有 `refresh_token`（LibreChat 依赖它）；
  - 所用 Casdoor 镜像版本支持 `initAdminPassword`；
  - RAGFlow 端口覆盖文件需要 Docker Compose v2.24 及以上。本机没有 Docker，这个文件未实际运行验证。
- **Langfuse** 未单独部署：Jchat 可以直接用 LibreChat 内置的 Langfuse 追踪。
