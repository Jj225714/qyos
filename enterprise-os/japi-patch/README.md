# JAPI（Sub2API）补丁

## 0001-admin-create-user-api-key.patch

让企业 OS 的 os-bridge 用一把**受限管理密钥**（`adm_sc_…`）为每位员工建 JAPI 用户和专用 API Key，并在离职或停用时停用 Key。员工不需要 JAPI 密码，也不接触 Key。

- 基线：上游 `Wei-Shaw/sub2api` 提交 `530c5e3`（2026-11-11），分支 `enterprise-os`。
- 一个文件里含多个提交，`git am` 可以直接应用。

### 新增和变更的路由

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v1/admin/users/:id/api-keys` | 新增。为用户创建 API Key |
| PUT | `/api/v1/admin/api-keys/:id/status` | 新增。停用或恢复某把 Key |
| POST | `/api/v1/admin/users` | 原有。受限密钥调用时增加字段边界，响应按读权限裁剪 |
| PUT | `/api/v1/admin/users/:id` | 原有。同上 |
| PUT | `/api/v1/admin/api-keys/:id` | 原有。受限密钥不能操作管理员名下的 Key |

#### POST /api/v1/admin/users/:id/api-keys

请求：`{"name": "enterprise-os", "group_id": 3}`
- `name` 必填，首尾空格会被去掉，长度 1–100 字符。
- `group_id` 可选；省略、`0` 或负数表示不绑定分组。分组权限由现有 `APIKeyService.Create` 校验。

响应：`{"code":0,"message":"success","data":{...}}`。`data` 与 `GET /admin/users/:id/api-keys` 的单条结构相同，其中 `data.key` 是**明文 Key**，`data.id` 是 Key 的 ID，`data.status` 为 `active`。

拒绝条件：
- 用户不存在（含已删除）：404，`reason: USER_NOT_FOUND`
- 用户是管理员（无论状态）：403，`reason: ADMIN_USER_API_KEY_FORBIDDEN`
- 用户 status 不是 `active`：403，`reason: USER_NOT_ACTIVE`

#### PUT /api/v1/admin/api-keys/:id/status

请求：`{"status": "active"}` 或 `{"status": "disabled"}`，只接受这两个值，大小写敏感。

响应：`{"code":0,"message":"success","data":{...}}`。`data` 是更新后的 Key，结构同上，也含明文 `key`。

行为：
- 状态没变时直接返回 200，不写库。
- `disabled` 可以从任意状态设置。
- `active` 只能从 `disabled` 恢复。`expired` 或 `quota_exhausted` 的 Key 不能经此接口恢复，返回 409，`reason: API_KEY_STATUS_CONFLICT`。
- 实际更新走用户侧已有的 `APIKeyService.Update`（以 Key 所有者身份），复用其所有权校验和鉴权缓存清除。

**生效时间：** 更新成功后立即删除该 Key 的鉴权缓存：本实例的进程内 L1 缓存、Redis L2 缓存，并通过 Redis Pub/Sub 通知其他实例删除各自的 L1。之后的新请求会重新从数据库加载，看到新状态。单实例下立即生效；多实例下取决于 Pub/Sub 送达，通常在毫秒级。如果 Pub/Sub 丢消息，其他实例最迟在 L1 TTL 后生效（默认 `api_key_auth_cache.l1_ttl_seconds = 15` 秒，含 10% 抖动）。**已经在进行中的请求（如流式响应）不会被中断。**

#### 统一错误格式

所有错误都是 JSON：`{"code": <HTTP 状态码>, "message": "...", "reason": "..."}`。

| HTTP | reason | 场景 |
|---|---|---|
| 400 | （空） | 路径 ID 非法、JSON 无法解析、`name` 为空或过长、`status` 不是 active/disabled |
| 401 | `INVALID_ADMIN_KEY` | 管理密钥无效、过期、IP 不在 `allowed_ips`，或创建者已不是 active 管理员 |
| 403 | `FORBIDDEN` | 管理密钥未勾选该路由对应的权限 |
| 403 | `ADMIN_USER_API_KEY_FORBIDDEN` | 给管理员账号建 Key |
| 403 | `USER_NOT_ACTIVE` | 给非 active 用户建 Key |
| 403 | `SCOPED_ADMIN_TARGET_FORBIDDEN` | 受限密钥创建或提升管理员、修改管理员账号，或改管理员名下 Key 的状态或分组 |
| 403 | `SCOPED_ADMIN_BALANCE_WRITE_REQUIRED` | 受限密钥创建或编辑用户时带了 `balance`，但没有 `users.balance.write` |
| 404 | `USER_NOT_FOUND` / `API_KEY_NOT_FOUND` | 用户或 Key 不存在 |
| 409 | `API_KEY_STATUS_CONFLICT` | 试图把 expired 或 quota_exhausted 的 Key 设为 active |
| 423 | `ADMIN_COMPLIANCE_ACK_REQUIRED` | 创建该管理密钥的管理员尚未完成合规确认 |

### 新增权限（受限管理密钥目录）

均为“全站”（global）权限，按方法和完整路径精确登记，互不隐含：

| 权限 ID | 放行路由 | 分类 |
|---|---|---|
| `users.create` | `POST /users` | 用户 |
| `users.update` | `PUT /users/:id` | 用户 |
| `users.api_keys.read` | `GET /users/:id/api-keys` | API 密钥 |
| `users.api_keys.create` | `POST /users/:id/api-keys` | API 密钥 |
| `api_keys.group.write` | `PUT /api-keys/:id` | API 密钥 |
| `api_keys.status.write` | `PUT /api-keys/:id/status` | API 密钥 |

受限密钥使用 `users.create` / `users.update` 时，处理器会额外检查：
- 不能创建 `role=admin` 的用户，不能把用户改成管理员，也不能修改任何管理员账号（返回 `SCOPED_ADMIN_TARGET_FORBIDDEN`）。
- 请求中带 `balance` 时，还需要 `users.balance.write`。
- 响应按读权限裁剪：只有 `users.create` / `users.update` 时，`data` 只有 `{"id": ...}`；同时勾选 `users.read` 才返回 email、username、role、status 等资料字段。os-bridge 用 `data.id` 作为 JAPI 用户 ID 即可。

另外，通过受限密钥创建管理员原本也会被 step-up 2FA 拦截（`STEP_UP_ADMIN_API_KEY_FORBIDDEN`），但仅在 step-up 开关开启时生效；新增的检查不依赖该开关。

前端管理密钥设置页从后端读取权限目录，无需改页面。但前端有测试要求每个权限都有中英文标签，所以同步补了 `frontend/src/i18n/locales/{zh,en}/adminAccessKeys.ts`，中文标签与后端目录逐字一致。前端测试未在本机运行。

### 审计

- 管理员登录会话（JWT）调用时，由审计中间件记录，动作名为：
  - `POST /api/v1/admin/users/:id/api-keys` → `admin.users.api_keys.create`
  - `PUT /api/v1/admin/api-keys/:id/status` → `admin.api_keys.status.update`
  - `PUT /api/v1/admin/api-keys/:id` → `admin.api_keys.group.update`
- 受限管理密钥调用时，上游统一记为 `admin.api_key.request`（只记方法、路径、状态码、密钥 ID 和名称，不记请求体）。本补丁在 `extra.route_action` 里补上上述具体动作名，便于按动作检索。
- 审计中间件只保存脱敏后的请求体，从不保存响应体，所以响应中的明文 Key 不会写入审计库。已有测试覆盖这一点。

## os-bridge 的密钥配置

在 JAPI 后台“设置 → 管理密钥”新建**受限密钥**（不要勾选全权访问，旧版全局密钥已停止新建）：

1. 全站权限只勾选以下几项：
   - `users.read`：按邮箱查找已有用户（`GET /users?search=`、`GET /users/:id`）
   - `users.create`、`users.update`
   - `users.api_keys.read`、`users.api_keys.create`
   - `api_keys.status.write`
   - `api_keys.group.write`：仅在需要事后改 Key 分组时勾选
   - 不要勾选 `users.balance.write`，除非 os-bridge 确实要设置余额。
2. `allowed_ips` 填 os-bridge 的出口 IP（或 CIDR）。
3. `expires_at` 设一个明确的过期时间（例如 90 天），并安排轮换。
4. **创建该密钥的管理员**必须保持 active，且已完成管理员合规确认：
   - 创建者被停用或降级后，密钥立即失效（401 `INVALID_ADMIN_KEY`）。
   - 创建者未完成合规确认时，所有请求返回 423 `ADMIN_COMPLIANCE_ACK_REQUIRED`。
5. 密钥明文只在创建时显示一次，存入 os-bridge 的密钥管理，不要写进代码或日志。

请求头：`x-api-key: adm_sc_…`。

## 应用与验证

```sh
cd <JAPI 源码根目录>
git am /path/to/0001-admin-create-user-api-key.patch   # 冲突时改用 git am -3
cd backend
go build ./...
go vet ./internal/handler/admin/ ./internal/pkg/adminaccess/ ./internal/server/...
go test ./internal/handler/admin/ ./internal/pkg/adminaccess/ ./internal/server/middleware/ ./internal/server/routes/ -count=1
go test -tags unit ./internal/pkg/adminaccess/ ./internal/server/middleware/ ./internal/server/routes/ -count=1
```

部分上游测试（含本补丁的路由级测试）带 `//go:build unit` 标签，需要加 `-tags unit` 才会运行。

### 本机实测结果

2026-11-11，Windows 11，Go 1.27.4（满足 go.mod 的 1.27.3，无需下载工具链），在 `backend/` 下运行：

```text
$ go build ./...
（无输出，exit 0）

$ go vet ./internal/handler/admin/ ./internal/pkg/adminaccess/ ./internal/server/...
（无输出，exit 0）

$ go test ./internal/handler/admin/ ./internal/pkg/adminaccess/ ./internal/server/middleware/ ./internal/server/routes/ -count=1
ok  	github.com/Wei-Shaw/sub2api/internal/handler/admin	1.136s
ok  	github.com/Wei-Shaw/sub2api/internal/pkg/adminaccess	1.253s
ok  	github.com/Wei-Shaw/sub2api/internal/server/middleware	0.632s
ok  	github.com/Wei-Shaw/sub2api/internal/server/routes	11.733s

$ go test -tags unit ./internal/handler/admin/ ./internal/pkg/adminaccess/ ./internal/server/middleware/ ./internal/server/routes/ -count=1
ok  	github.com/Wei-Shaw/sub2api/internal/handler/admin	1.130s
ok  	github.com/Wei-Shaw/sub2api/internal/pkg/adminaccess	1.971s
ok  	github.com/Wei-Shaw/sub2api/internal/server/middleware	0.702s
ok  	github.com/Wei-Shaw/sub2api/internal/server/routes	11.802s
```

本补丁新增的 24 个测试已用 `-v` 逐个确认运行并通过：
- `apikey_create_for_user_test.go`：建 Key 的成功、输入校验，以及用户不存在（JSON 404）、非 active、管理员三种拒绝。
- `apikey_status_test.go`：停用和恢复、状态不变不写库、非法值、404、409，以及受限密钥不能管理管理员名下的 Key。
- `user_handler_scoped_write_test.go`：受限密钥创建和编辑用户的字段边界与响应裁剪。
- `catalog_enterprise_os_test.go`：6 个新权限的登记，每个只放行自己的路由。
- `audit_log_enterprise_os_test.go`：审计动作名、明文 Key 不入审计库、受限密钥审计中的 `route_action`。
- `routes/custom_admin_key_enterprise_os_test.go`（`-tags unit`）：通过真实路由和管理密钥鉴权，验证勾选权限后放行、未勾选时 403。

本机只有 4 GB 内存，并行编译会因内存耗尽崩溃，所以用了 `GOFLAGS=-p=1` 串行编译。这与代码无关。

如果你们的定制版重新生成过 wire 代码（`wire_gen.go`），请改 `internal/handler/wire.go` 的 provider 集合后重新运行 `wire`，不要只手改生成文件。本补丁没有改 `NewAdminAPIKeyHandler` 的签名（仍为 `(adminService, *service.APIKeyService)`），所以只有第一个提交改过 `wire_gen.go`。

## 许可证

Sub2API 为 LGPL-3.0。内部部署不涉及分发；若将来对外分发修改后的 JAPI，需要按 LGPL 提供修改后的源码。
