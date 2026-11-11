# 上游源码（third_party）

企业OS 涉及的四个上游项目，源码原样放在这里，克隆 qyos 一次就能拿到全部代码，用来构建、部署和测试。每个目录都是对应上游提交的完整文件快照（不含上游的 Git 历史），文件与上游逐字节一致。

| 目录 | 企业OS 中的名字 | 上游仓库 | 提交 | 日期 | 许可证 | 本仓库改动 |
| --- | --- | --- | --- | --- | --- | --- |
| `sub2api/` | JAPI | https://github.com/Wei-Shaw/sub2api | `530c5e3a4` 加 2 个企业OS 提交，到 `03a2664a5` | 2026-11-11 | LGPL-3.0 | 有，见下 |
| `librechat/` | Jchat | https://github.com/danny-avila/LibreChat | `8d3da9bbb` | 2026-10-26 | MIT | 无 |
| `ragflow/` | 知识库 | https://github.com/infiniflow/ragflow | `db1cd5929` | 2026-11-06 | Apache-2.0 | 无 |
| `casdoor/` | 统一登录 | https://github.com/casdoor/casdoor | `66b51eef9` | 2026-11-11 | Apache-2.0 | 无 |

各目录保留上游的 `LICENSE`，使用和再分发时遵守各自许可证。

## sub2api 的改动

`third_party/sub2api/` 已经包含企业OS 的两个提交，内容与 `enterprise-os/japi-patch/0001-admin-create-user-api-key.patch` 相同：

1. `43875113b` feat(admin): let admins create an API key for a user
2. `03a2664a5` feat(admin): scoped-key permissions and key status endpoint for directory sync

直接从这个目录构建即可，不需要再打补丁。补丁文件留给已有 JAPI 源码、只想合并改动的场合。

Sub2API 是 LGPL-3.0。内部部署不涉及分发；如果对外分发修改后的 JAPI，需要按 LGPL 提供修改后的源码（即本目录）。

## 构建和测试

```sh
# JAPI（Go，版本见 third_party/sub2api/backend/go.mod）
cd third_party/sub2api/backend && go build ./... && go test ./internal/handler/admin/... ./internal/pkg/adminaccess/... ./internal/server/...

# 镜像和部署方式见各项目自己的文档
#   third_party/sub2api/deploy/README.md
#   third_party/librechat/docker-compose.yml
#   third_party/ragflow/docker/
#   third_party/casdoor/docker-compose.yml
```

LibreChat、RAGFlow、Casdoor 没有改动，生产环境也可以直接用官方镜像（版本与上表提交对应），配合 `enterprise-os/deploy/` 里的配置。

## 更新上游

换成新的上游版本时，用新提交的文件整体替换对应目录，并更新上表。sub2api 要先把两个企业OS 提交变基到新版本、测试通过，再替换。
