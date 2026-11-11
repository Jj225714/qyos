> 本仓库即 **qyos**（企业OS）：在 Jimage 源码基础上加入 Jadmin、os-bridge 与部署模板。企业OS 的总览与部署顺序见 [enterprise-os/README.md](enterprise-os/README.md)。

# JimageAI 生图项目（jpmamoru）

## 项目范围与来源

生产入口：[https://jimage.jpmamoru.com/image](https://jimage.jpmamoru.com/image)。本目录是该站点的本地开发源码副本，主体取自工作区 `infinite-canvas/`，于 2026-11-11 复制。它包含前端、服务端配套模块、插件、部署脚本与文档，但**不能仅凭目录名认定它与当前线上发布物逐字节一致**。源码有自己的历史改动；生产站点的前端发布物来自另一份构建结果。

同日从服务器 `/opt/enterprise-ai-platform/image-system/` 取得运行目录快照，保存在本地 `server-snapshot/image-system/`，原始压缩包为 `server-snapshot.tar.gz`。该快照包括 `dist/`、示例运行配置及 Nginx 配置，约 44 MB、47 个文件。它没有 TypeScript/React 源码、源码映射或 Git 历史，因此无法仅从服务器还原完整开发源码。快照只用于对照线上文件，不提交 Git。

本站基于 Infinite Canvas 开发。原仓库的许可证见 [LICENSE](LICENSE)，上游来源见 [README.md](README.md)。复制源码时排除了 `node_modules`、构建产物、测试输出、缓存、日志、运行数据和本地 `.env` 文件；这些内容通过安装依赖、构建或服务器备份恢复。

## 目录结构

| 目录 | 作用 |
| --- | --- |
| `web/` | React + TypeScript + Vite 前端；`src/pages/image/` 为生图工作台，`src/services/` 负责模型与图片接口 |
| `config-vault/` | 账号配置与跨浏览器同步服务 |
| `provider-relay/` | 部分模型服务的服务端转发 |
| `model-gateway/` | 模型网关相关代码 |
| `canvas-agent/`、`canvas-proxy/` | 画布 Agent 与代理服务 |
| `plugins/`、`assets/` | 插件、SDK 和素材 |
| `deploy/`、`docs/` | 部署脚本与项目文档 |
| `jadmin/` | 统一管理后台 Jadmin；代码与 2026-11-11 服务器运行文件一致，附 systemd 服务模板 |
| `server-snapshot/` | 线上 Jimage 静态发布物的本地快照；Git 忽略 |

## 与其他平台的关系

Jimage 前端通过个人或服务器配置选择模型，图片请求经同源代理或模型网关连接 JAPI。Jadmin 是统一管理后台，代码见 [jadmin/README.md](jadmin/README.md)；配置保险库负责用户配置保存。JAPI 与 Jchat 的完整源码、数据库和运行密钥**不在本仓库**。若要在新服务器部署整套平台，需要另外取得这些模块的源码或安装包、域名和受保护配置。

## 本地运行

需要 Node.js 与 npm。以 `web/` 为工作目录：

```sh
npm ci
npm run typecheck
npm run build
npm run dev
```

默认开发地址为 `http://localhost:3000`。构建输出位于 `web/dist/`。部分完整流程还需要按实际环境配置网关和配置保险库；不要把 API Key、密码或服务器私钥写入前端、示例配置或 Git。

代码入口及构建方式可参见 [AGENTS.md](AGENTS.md)；历史部署说明见 [DEPLOYMENT.md](DEPLOYMENT.md)。其中部分旧域名、IP 和发布目录属于历史记录，不能直接用于当前 jpmamoru 生产环境。

## 发布与核验

1. 对照 `server-snapshot/image-system/dist/index.html` 中的资源文件名，确认目标发布版本。
2. 在 `web/` 执行类型检查和生产构建，检查生成页面的生图、编辑、模型选择与账号同步。
3. 按目标服务器的实际部署配置发布 `web/dist/`，保留旧版本供回滚。该仓库中通用的 `docker-compose.yml` 指向上游镜像，不等于当前 Jimage 服务器配置。
4. 对已登录用户执行端到端生图，并检查 JAPI 的实际图片响应与服务健康状态。HTTP 200 的流式响应还需检查最终是否完成并返回图片。

当前服务器使用的发布目录快照仅作证据；本次下载与 Git 备份没有向生产服务器发布新版本。

## Git 与敏感信息

仓库仅上传源码、公开部署模板与文档。`server-snapshot/`、压缩包、依赖、构建结果、缓存、`.env`、日志、Jadmin 数据库和数据目录均不进入 Git。运行密钥应留在受保护的服务器配置或密钥管理系统中。上传前使用 `git status` 和敏感内容扫描检查提交清单。
