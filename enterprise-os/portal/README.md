# 企业OS 门户

员工只需要记住一个地址（示例为 `https://os.jpmamoru.com`）。页面上是两个大入口：

- **Jchat**：对话、写作和部门知识库问答。打开后自动跳到企业 IM 登录。
- **Jimage**：AI 生图。入口直接走企业账号登录，登录后进入生图页。

页面下方有一行小字「管理员 · Jadmin 管理后台」。员工点进去也要管理员账号，所以不需要隐藏。

门户是纯静态页面，没有后端，不保存任何数据，也不需要登录。

## 文件

| 文件 | 作用 |
| --- | --- |
| `config.js` | **唯一需要改的文件**：标题、登录 IM 名称、入口地址、管理员链接、求助说明 |
| `index.html`、`portal.js`、`portal.css`、`favicon.svg` | 页面本身，自动适配手机和深色模式 |
| `nginx-portal.conf` | Nginx 站点示例，带严格的 CSP |

## 部署

```sh
sudo mkdir -p /var/www/qyos-portal
sudo cp enterprise-os/portal/{index.html,portal.js,portal.css,favicon.svg,config.js} /var/www/qyos-portal/
sudo vi /var/www/qyos-portal/config.js          # 按实际域名修改
sudo cp enterprise-os/portal/nginx-portal.conf /etc/nginx/conf.d/qyos-portal.conf   # 改域名和证书路径
sudo nginx -t && sudo systemctl reload nginx
```

需要为门户域名申请证书，并在 DNS 里加解析。

## 配置说明

- `loginIm`：与 Jadmin「登录方式」保持一致。在 Jadmin 切换 IM 后，记得把这里一起改掉，页面提示语会跟着变。
- `apps[].url`：只接受 `https://` 完整地址或以 `/` 开头的本站路径，写错的条目不会显示。
- Jimage 的地址 `/api/config-vault/oidc/start?return=%2Fimage` 会直接发起企业账号登录。前提是保险库已按 `jimage-patch` 的说明开启 SSO；没开的话改成 `https://jimage.jpmamoru.com/image`。
- 要加新应用（比如以后的报表系统），在 `apps` 里再加一项，`icon` 可选 `chat`、`image`、`book`、`grid`。

## 本地预览

直接用浏览器打开 `index.html` 就能看到效果。
