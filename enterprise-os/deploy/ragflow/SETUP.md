# RAGFlow 企业知识库部署

依据上游 `infiniflow/ragflow` v1.0.0（镜像 `infiniflow/ragflow:v1.0.0`，后端为 Go）源码核对。

## 关键事实

- **开源版不支持 OIDC 登录。** `ParseOAuthConfig` 在非企业版构建里是空实现。所以员工不登录 RAGFlow 界面，统一通过 Jchat 的「enterprise-knowledge」工具检索。各部门的知识库管理员用 RAGFlow 本地账号维护文档。
- **MCP 内置在 9380 端口的 `POST /api/v1/mcp`。**
  - 无状态的 streamable-http：每个请求单独鉴权，不下发会话 ID。
  - 用 `Authorization: Bearer <API Key>` 识别账号。
  - os-bridge 按部门换 Key，所以**一个部门对应一个 RAGFlow 账号**，不同部门之间检索隔离。
- **9382 端口的独立 MCP 服务不要开。** self-host 模式只有一个固定身份，无法按部门区分。
- **数据源连接器：**
  - 有飞书知识库（`feishu_wiki`）和钉钉多维表（`dingtalk_ai_table`），没有企业微信文档连接器。
  - **飞书知识库连接器只同步上传到知识库里的附件。** 飞书原生在线文档、表格、多维表格都会被跳过，见下文「数据同步」。

## 部署

```sh
git clone --depth 1 --branch v1.0.0 https://github.com/infiniflow/ragflow.git   # 用与镜像一致的版本
cd ragflow/docker
cp .env .env.bak
```

修改 `.env`（至少这些）：

| 变量 | 值 |
| --- | --- |
| `ELASTIC_PASSWORD`、`MYSQL_PASSWORD`、`MINIO_PASSWORD`、`REDIS_PASSWORD` | 全部换成强随机密码（默认值是公开的 `infini_rag_flow`）。如果改用 OpenSearch 等引擎，相应的 `*_PASSWORD` 也要换 |
| `DEFAULT_SUPERUSER_PASSWORD` | 强随机密码。超级管理员 `admin@ragflow.io` 的默认密码是 `admin`（`ADMIN_DEFAULT_PASSWORD`），只在首次建库时生效，所以**第一次启动前**就要设好 |
| `ENABLE_REGISTER` | 先保持 `1`，建好各部门账号后改为 `0` 并重启。`REGISTER_ENABLED` 是无用的遗留变量，不起作用 |
| `MEM_LIMIT` | 按服务器内存调整（官方建议整机 ≥16 GB） |

**所有端口只监听本机。** 上游默认把 Elasticsearch、MySQL、MinIO、Kvrocks、NATS、Jaeger 以及 9380、9381 都映射到 `0.0.0.0`。容器内的 Nginx 还会把 `/api/v1` 和 `/api/v1/admin` 转发到 80/443 端口，所以只收紧 9380 不够。用本目录的覆盖文件启动：

```sh
docker compose -f docker-compose.yml -f /path/to/enterprise-os/deploy/ragflow/docker-compose.ports.yml up -d
docker compose ps --format '{{.Name}} {{.Ports}}' | grep -v 127.0.0.1   # 应该没有输出
```

- 覆盖后，Web 界面在本机 `127.0.0.1:8081`，os-bridge 通过 `http://127.0.0.1:9380/api/v1/mcp` 访问。不要改成经 80/443 访问 MCP：MCP 会校验 Host 头，可能返回 403。
- 知识库管理员需要用界面时，在宿主机 Nginx 上为 `127.0.0.1:8081` 配置内网 IP 白名单，并屏蔽 `/api/v1/admin`。

## 模型接入 JAPI

在 RAGFlow「模型供应商」添加 **OpenAI-API-Compatible**：

- Base URL：`http://127.0.0.1:8080/v1`（JAPI 内网地址，需要以 `/v1` 结尾）。
- API Key：在 JAPI 为「知识库服务」单独建一个用户和 Key，放进专门的分组，便于单独看成本。这个 Key 不经过 os-bridge。
  - 注意 JAPI 的分组平台：向量接口只支持 OpenAI 平台的分组，其他平台会返回 404。
- 对话模型：按 JAPI 实际开放的模型填写。
- 向量模型：填 JAPI 提供的向量模型名。

**每个 RAGFlow 账号（各部门账号和 kb-public）都要分别配置一次模型供应商，向量模型名必须完全相同。** 原因：

- 模型配置是按账号保存的；
- 跨库检索时，RAGFlow 要求所有库的向量模型同名，否则报 "datasets use different embedding models"。

向量模型定下后不要随意更换，更换需要重建全部索引。

## 部门账号与权限

1. **建部门账号。** 每个部门建一个**普通**账号（超级管理员不能调用租户 API），例如 `kb-sales@jpmamoru.com`，交给该部门的知识库管理员。
2. **配置部门 Key。** 在该账号下建本部门的知识库，生成 API Key，写进 os-bridge `secrets.json` 的 `ragflowKeys`。键名是 Jadmin「部门目录」里的部门代码，例如 `sales`。
3. **全公司公共库。** 建一个 `kb-public` 账号，然后同时完成以下三步，缺一不可：
   - (a) 每个公共知识库的「权限」设为**团队**（默认是"仅自己"）。
   - (b) 在 kb-public 的「团队」里邀请每个部门账号。
   - (c) 每个部门账号登录一次，**接受邀请**。接受之前状态是"已邀请"，部门 Key 看不到公共库。
4. **注意写权限。** 团队成员对公共库**有写权限**：部门账号可以修改公共库、上传或删除其中的文档。员工经 os-bridge 只能用只读的检索工具，不受影响；但部门账号只交给可信的人。
5. **部门没有自己的知识库时：**
   - os-bridge 会给这个部门的员工返回一个空工具列表，Jchat 正常使用，只是没有知识库工具。
   - 如果想让这些部门也能检索公共库，在 `ragflowKeys` 里配置 `"*"`。不要用 kb-public 自己的 Key，它还能看到 kb-public 的私有库。应另建一个空账号，加入 kb-public 团队后用它的 Key。
   - 不在任何部门的员工会被 os-bridge 拒绝（`provisioning.requireDepartment`），不会用到 `*`。

## 数据同步

数据同步服务默认开启。

- **飞书知识库：** 在部门账号下添加「Feishu Wiki」数据源，只选该部门的知识库空间。**只同步上传到知识库里的文件附件**，飞书原生文档、表格、多维表格不会同步。需要入库的原生文档，先导出为 docx 或 pdf 再上传到知识库空间，或放进对象存储后用 S3 数据源同步。
- **钉钉多维表：** 添加「DingTalk AI Table」数据源，按表同步记录。
- **企业微信和其他文件：** 管理员手工上传；或者放进对象存储，用 S3、S3 兼容或 WebDAV 数据源同步。
- 只同步明确划入知识库的空间或文件夹，不要全量抓取。

## 验证

```sh
# 用某部门 Key 列出该账号可见的知识库：应只看到本部门的库 + 已接受邀请的公共库
curl -s http://127.0.0.1:9380/api/v1/datasets -H "Authorization: Bearer <部门 Key>"
```

RAGFlow 对无效 Key 也返回 HTTP 200，响应体是 `{"code":102,...}`。os-bridge 会把这种情况转成 502 `RAGFLOW_REJECTED`，并在日志里记一条 `ragflow_rejected`。

然后在 Jchat 里做两次对照：
1. 用该部门员工的账号，让模型调用 enterprise-knowledge 工具，问一个只有本部门文档能回答的问题。
2. 用其他部门员工的账号问同一个问题，应该检索不到。
