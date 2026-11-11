# Jchat 老用户迁移到企业账号

LibreChat v0.8.9-rc1 会拒绝老用户用 OpenID 登录：

- 企业账号首次登录时，LibreChat 先按 Casdoor 用户 ID 找人，找不到再按邮箱找。
- 按邮箱找到的账号，只要 `provider` 不是 `openid`，就直接判定登录失败（`packages/api/src/auth/openid.ts`）。
- 原来用邮箱密码注册的账号，`provider` 是 `local`。
- 没有任何环境变量能放开这个限制。

只要把老账号的 `provider` 改成 `openid`、不写 `openidId`，员工首次用企业账号登录时，LibreChat 就会按邮箱认领这个账号，补写 `openidId`，历史对话全部保留。

## 步骤

1. **核对邮箱。** 在 Jadmin「员工资料检查」里导出 Casdoor 邮箱，与 Jchat 用户邮箱逐一对照。LibreChat 存邮箱时会转成小写。
   - 邮箱不一致的人：先在 Jchat 里改成公司邮箱。
   - 离职的人：在 Jchat 里删除或封禁。

   原因：任何能用这个邮箱登录 Casdoor 的人，都会认领这个账号。

2. **备份 Mongo。**

   ```sh
   docker exec <mongo 容器> mongodump --db LibreChat --out /tmp/before-openid
   ```

3. **预演。** 先只看会改哪些账号：

   ```sh
   docker exec -it <mongo 容器> mongosh LibreChat --eval 'db.users.find({provider:"local"},{email:1}).toArray()'
   ```

4. **迁移。** 不要写入 `openidId`，LibreChat 会在首次登录时补写：

   ```sh
   docker exec -it <mongo 容器> mongosh LibreChat --eval 'db.users.updateMany({provider:"local", openidId:{$exists:false}}, {$set:{provider:"openid"}})'
   ```

5. **合并配置并重启。** 合并 `librechat-env-snippet.txt` 和 `librechat.yaml`，然后重启 LibreChat。用一个老员工账号测试：登录后应能看到原来的对话。

迁移后这些账号不能再用密码登录，与 `ALLOW_EMAIL_LOGIN=false` 一致。

## 已知限制：LibreChat 信任全局 JWKS

- LibreChat 校验会话令牌时，用的是 Casdoor 发现文档里的**全局** JWKS，其中含有所有组织的证书。
- 所以 `jpmamoru` 的组织管理员，或者持有本组织应用 Client Secret 的系统，理论上可以伪造 Jchat 会话。
- os-bridge 只信任 `jchat` 和 `jimage` 两个应用自己的 JWKS，模型和知识库调用不受这个问题影响。
- 缓解办法：组织管理员和应用 Secret 只给必要的人和系统（见 `deploy/casdoor/SETUP.md` 第 1 节）。
