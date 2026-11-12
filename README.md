# qyos · 企业OS

qyos 是一套给公司内部用的 AI 工作平台。员工用企业 IM（飞书、企业微信或钉钉，三选一）登录一次，就能使用对话、知识库问答和 AI 生图。每个人有自己的模型账号，按人计费，员工离职后账号自动停用。

全部源码都在这个仓库里，克隆一次就能构建、部署和测试。

## 员工怎么用

员工只需要打开门户 `https://os.jpmamoru.com`（示例域名，实际以你们的配置为准）：

| 入口 | 用途 |
| --- | --- |
| **Jchat** | 对话、写作、部门知识库问答 |
| **Jimage** | AI 生图、画布、商品图处理 |

第一次进入会跳到企业 IM 扫码登录，系统自动开好个人账号，不需要另设密码。管理员从门户底部进入 **Jadmin** 管理后台。

## 组成

```
              门户 os.jpmamoru.com
                 │
       ┌─────────┼──────────┐
     Jchat     Jimage     Jadmin ──── 选择登录 IM、管理部门
       │         │          │
       └────── Casdoor（统一登录，接飞书 / 企业微信 / 钉钉）
                 │
             os-bridge ──── 每个员工对应一个 JAPI 账号和 Key；按部门接入知识库
              │      │
            JAPI   RAGFlow
         （模型网关）（知识库）
```

| 组件 | 是什么 | 源码位置 |
| --- | --- | --- |
| 门户 | 统一入口页，纯静态 | `enterprise-os/portal/` |
| Jimage | AI 生图工作台，基于开源项目 Infinite Canvas | `web/`、`config-vault/`、`provider-relay/` 等，原项目说明见 [JIMAGE.md](JIMAGE.md) |
| Jadmin | 管理后台：登录 IM 切换、部门目录、员工资料检查 | `jadmin/` |
| os-bridge | 连接各系统的服务：开户、Key 分发、知识库代理、离职同步 | `enterprise-os/os-bridge/` |
| JAPI | 模型网关，基于 Sub2API，含企业OS 改动 | `third_party/sub2api/` |
| Jchat | 对话界面，基于 LibreChat | `third_party/librechat/`，配置在 `enterprise-os/deploy/librechat/` |
| RAGFlow | 知识库 | `third_party/ragflow/`，配置在 `enterprise-os/deploy/ragflow/` |
| Casdoor | 统一登录 | `third_party/casdoor/`，配置在 `enterprise-os/deploy/casdoor/` |

`third_party/` 下的上游版本、许可证和改动见 [third_party/README.md](third_party/README.md)。

## 部署

```sh
git clone https://github.com/Jj225714/qyos.git
cd qyos
```

然后按 [enterprise-os/README.md](enterprise-os/README.md) 的「部署顺序」操作，依次是 JAPI、Casdoor、Jadmin、os-bridge、Jchat、RAGFlow、Jimage，最后是门户。各组件的详细步骤在 `enterprise-os/deploy/` 下。

## 测试

| 组件 | 命令 | 需要 |
| --- | --- | --- |
| os-bridge | `cd enterprise-os/os-bridge && node --test` | Node ≥ 22 |
| Jadmin | `python -m unittest jadmin/test_enterprise.py` | Python 3.12 |
| Jimage 保险库 | `node --test config-vault/*.test.mjs` | Node ≥ 22 |
| Jimage 转发 | `node --test provider-relay/*.test.mjs` | Node ≥ 22 |
| Jimage 前端 | `cd web && npm ci --legacy-peer-deps && npx tsc --noEmit && npx vitest run && npm run build` | Node ≥ 22 |
| JAPI | `cd third_party/sub2api/backend && go test ./internal/handler/admin/... ./internal/pkg/adminaccess/... ./internal/server/...` | Go，版本见 `go.mod` |

## 其他文档

- [enterprise-os/README.md](enterprise-os/README.md)：企业OS 总说明、部署顺序、接口和安全边界
- [PROJECT.md](PROJECT.md)：Jimage 源码来源和发布核验
- [JIMAGE.md](JIMAGE.md)：Jimage 所基于的 Infinite Canvas 原项目说明
- [jadmin/README.md](jadmin/README.md)：Jadmin 运行和环境变量

## 许可证

本仓库自有代码和 Jimage 部分沿用 [MIT License](LICENSE)（来自 Infinite Canvas）。`third_party/` 下各项目保留各自的许可证：Sub2API 为 LGPL-3.0，LibreChat 为 MIT，RAGFlow 和 Casdoor 为 Apache-2.0。
