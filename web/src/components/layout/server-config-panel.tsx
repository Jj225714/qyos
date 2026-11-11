import { Alert, App, Button, Card, Form, Input, Space, Table, Tag } from "antd";
import { useEffect, useState } from "react";
import { getEnterpriseSsoEnabled, getEnterpriseSsoLabel, getServerConfigEnabled } from "@/constant/runtime-config";
import { initializeServerConfiguration, loginServerConfiguration, startEnterpriseLogin, logoutServerConfiguration, reloadServerConfiguration, saveServerConfiguration, useServerConfigStore, loadTeamDraft, saveTeamDraft, publishTeamDraft, uploadSettingsAsset } from "@/services/server-config";
import { captureLocalPersonalSettings, captureLocalTeamSettings, prepareTeamSettingsForServer } from "@/services/settings-data";
import { createCategorySeedPack } from "@/lib/commerce/category-seed";
import type { PersonalSettings, TeamSettings } from "@/types/settings-sync";
import { useConfigStore } from "@/stores/use-config-store";
import { MembershipLibraryPanel } from "./membership-library-panel";

export function ServerConfigBridge() {
    useEffect(() => {
        void initializeServerConfiguration();
    }, []);
    return null;
}
export function ServerConfigStatus() {
    const state = useServerConfigStore();
    const open = useConfigStore((s) => s.openConfigDialog);
    if (!getServerConfigEnabled()) return null;
    const label = !state.user ? "登录后恢复配置" : state.phase === "saving" ? "配置保存中" : state.phase === "checking" ? "正在恢复配置" : ["error", "conflict"].includes(state.phase) ? "同步待处理" : "账号与同步";
    return (
        <button
            type="button"
            className="rounded-md px-2 py-1 text-xs text-stone-600 hover:bg-black/5 dark:text-stone-300"
            onClick={() => open(false, "server-config")}
            title={state.user ? `${state.user.email} · 最近同步 ${formatTime(state.lastSyncedAt)}` : "登录后恢复个人配置与团队规则"}
        >
            {label}
            {state.user ? ` · ${state.user.email}` : ""}
        </button>
    );
}
function formatTime(value: string | null | undefined) {
    return value ? new Date(value).toLocaleString() : "尚无记录";
}
export function personalMigrationRows(local: PersonalSettings, remote: PersonalSettings | null) {
    const groups: Array<[string, unknown, unknown]> = [
        ["渠道与模型配置", local.config, remote?.config],
        ["提示词来源与更新频率", local.promptSources, remote?.promptSources],
        ["WebDAV 配置", local.webdav, remote?.webdav],
        ["语言与主题", local.appearance, remote?.appearance],
    ];
    return groups.map(([name, source, target]) => ({ name, result: source === undefined ? "本机未设置" : JSON.stringify(source) === JSON.stringify(target) ? "一致" : target === undefined ? "服务器未设置" : "与服务器不同" }));
}
export function teamMigrationRows(local: TeamSettings, remote: TeamSettings | null) {
    const count = (value: TeamSettings | null) => ({
        categories: value?.policyPack.categories?.length || 0,
        rules: (value?.policyPack.rules.length || 0) + (value?.policyPack.categories || []).reduce((sum, c) => sum + c.rules.length, 0),
        brands: value?.brands.length || 0,
        assets: (value?.policyPack.references.length || 0) + (value?.brands || []).reduce((sum, b) => sum + Number(Boolean(b.logo)) + Number(Boolean(b.thaiFont)), 0),
        models: value?.modelConfig?.channels.length || 0,
    });
    const from = count(local),
        to = count(remote);
    return [
        { name: "大类与子类", local: from.categories, server: to.categories },
        { name: "规则要求", local: from.rules, server: to.rules },
        { name: "品牌", local: from.brands, server: to.brands },
        { name: "示例、Logo 与字体附件", local: from.assets, server: to.assets },
        { name: "统一渠道与模型", local: from.models, server: to.models },
    ].map((row) => ({ ...row, result: row.name === "品牌" ? (JSON.stringify(local.brands) === JSON.stringify(remote?.brands) ? "一致" : "内容有差异") : row.name === "统一渠道与模型" ? (JSON.stringify(local.modelConfig) === JSON.stringify(remote?.modelConfig) ? "一致" : "内容有差异") : JSON.stringify(local.policyPack) === JSON.stringify(remote?.policyPack) ? "一致" : "内容有差异" }));
}
export function ServerConfigPanel() {
    const state = useServerConfigStore();
    const { modal, message } = App.useApp();
    const open = useConfigStore((s) => s.openConfigDialog);
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [migrationOpen, setMigrationOpen] = useState(false);
    const [migrationBusy, setMigrationBusy] = useState(false);
    const [migrationMessage, setMigrationMessage] = useState("");
    const busy = ["checking", "saving"].includes(state.phase) || migrationBusy;
    useEffect(() => {
        setPassword("");
        setMigrationOpen(false);
        setMigrationMessage("");
    }, [state.user?.id]);
    const submit = async () => {
        const value = password;
        setPassword("");
        await loginServerConfiguration(email, value);
    };
    const candidate = state.migrationCandidate;
    const teamCandidate = candidate?.team ? { ...candidate.team, policyPack: candidate.team.policyPack.categories?.length ? candidate.team.policyPack : createCategorySeedPack(candidate.team.policyPack) } : null;
    const migrateTeam = async () => {
        if (!teamCandidate) return;
        const account = useServerConfigStore.getState().user;
        setMigrationBusy(true);
        setMigrationMessage("正在上传配置附件…");
        try {
            const currentDraft = await loadTeamDraft();
            const prepared = await prepareTeamSettingsForServer(teamCandidate, uploadSettingsAsset, () => useServerConfigStore.getState().user === account);
            await saveTeamDraft(prepared, currentDraft.revision);
            if (useServerConfigStore.getState().user !== account) return;
            setMigrationMessage("团队配置及附件已保存为草稿。请前往「跨境类目规则」校对后发布，其他设备才会应用。");
            message.success("团队迁移草稿已保存");
        } catch (error) {
            if (useServerConfigStore.getState().user === account) setMigrationMessage(error instanceof Error ? error.message : "迁移失败，本机候选仍保留，可重试。");
        } finally {
            setMigrationBusy(false);
        }
    };
    const saveModelTeamDraft = async () => {
        if (!state.manageTeam) return;
        setMigrationBusy(true);
        try {
            const draft = await loadTeamDraft();
            const prepared = await prepareTeamSettingsForServer(captureLocalTeamSettings(), uploadSettingsAsset, () => Boolean(useServerConfigStore.getState().user?.id === state.user?.id));
            const saved = await saveTeamDraft(prepared, draft.revision);
            setMigrationMessage(`团队渠道与模型已保存为草稿（修订 ${saved.revision}），请确认后发布。`);
            message.success("团队模型配置草稿已保存");
        } catch (error) {
            setMigrationMessage(error instanceof Error ? error.message : "团队模型配置保存失败");
        } finally { setMigrationBusy(false); }
    };
    const publishModelTeamDraft = async () => {
        if (!state.manageTeam || !state.teamDraft?.value) return;
        setMigrationBusy(true);
        try {
            const result = await publishTeamDraft(state.teamDraft.revision);
            setMigrationMessage(`团队渠道与模型已发布（修订 ${result.revision}），成员下次读取时生效。`);
            message.success("团队模型配置已发布");
        } catch (error) {
            setMigrationMessage(error instanceof Error ? error.message : "团队模型配置发布失败");
        } finally { setMigrationBusy(false); }
    };
    return (
        <section className="space-y-4 py-2">
            {state.user && !["checking", "signed-out"].includes(state.phase) ? <MembershipLibraryPanel key={state.user.id} /> : null}
            <p className="text-sm text-stone-500">登录同一 Always API 账号后恢复个人渠道密钥、模型绑定、提示词来源、WebDAV 及偏好，并读取团队类目与品牌配置。画布、商品实拍、生成记录和本机代理保留在本机。</p>
            {state.message && <Alert showIcon type={["error", "conflict"].includes(state.phase) ? "warning" : "info"} title={state.message} />}
            {state.user ? (
                <>
                    <p className="text-sm">
                        已登录：<strong>{state.user.email}</strong> <Tag>{state.manageTeam ? "团队管理员" : "团队只读成员"}</Tag>
                    </p>
                    <p className="text-sm text-stone-500">最近成功同步：{formatTime(state.lastSyncedAt)}</p>
                    <div className="grid gap-3 md:grid-cols-2">
                            <Card size="small" title="个人配置 · 当前账号的所有浏览器共享">
                            <p>
                                修订 {state.revision} · 最近保存 {formatTime(state.savedAt)}
                            </p>
                            <p className="text-sm text-stone-500">渠道地址、API Key、模型绑定、提示词来源和偏好会加密保存；登录同一账号的浏览器会自动恢复。代理地址仍按设备保留。</p>
                            <Button className="mt-2" loading={state.phase === "saving"} disabled={busy || state.phase === "conflict"} onClick={() => void saveServerConfiguration()}>
                                重试保存个人配置
                            </Button>
                        </Card>
                        <Card size="small" title="团队配置 · 所有成员共享">
                            <p>
                                修订 {state.teamRevision} · 最近发布 {formatTime(state.teamSavedAt)}
                            </p>
                            <p className="text-sm text-stone-500">渠道地址、API Key、模型列表、默认模型、跨境流程角色、类目、品牌和附件由管理员保存草稿并发布；主题、语言和提示词来源仍按账号同步。</p>
                            <Button className="mt-2" onClick={() => open(false, "commerce-categories")}>
                                查看团队类目规则
                            </Button>
                            {state.manageTeam ? <Space className="mt-2" wrap><Button loading={migrationBusy} onClick={() => void saveModelTeamDraft()}>保存当前渠道与模型为草稿</Button><Button loading={migrationBusy} disabled={!state.teamDraft?.value} onClick={() => void publishModelTeamDraft()}>发布团队模型草稿</Button></Space> : null}
                        </Card>
                    </div>
                    {state.phase === "conflict" ? (
                        <Card title="个人配置冲突对比">
                            <Alert type="warning" title="其他设备已更新配置；当前本机修改仍保留" description="下方比较当前修改与服务器内容，密钥仅显示是否有差异。读取服务器版本会放弃当前修改。" />
                            <Table
                                rowKey="name"
                                pagination={false}
                                size="small"
                                dataSource={personalMigrationRows(captureLocalPersonalSettings(), state.serverPersonal)}
                                columns={[
                                    { title: "配置分组", dataIndex: "name" },
                                    { title: "差异", dataIndex: "result" },
                                ]}
                            />
                            <Button
                                className="mt-2"
                                onClick={() => {
                                    const value = captureLocalPersonalSettings();
                                    modal.confirm({ title: "确认用当前本机修改覆盖服务器个人配置？", onOk: () => saveServerConfiguration(value) });
                                }}
                            >
                                确认保留当前本机修改
                            </Button>
                        </Card>
                    ) : null}
                    <Space wrap>
                        <Button disabled={busy} onClick={() => (state.phase === "conflict" || state.dirty ? modal.confirm({ title: "读取服务器配置并放弃当前未保存修改？", onOk: reloadServerConfiguration }) : void reloadServerConfiguration())}>
                            重新读取服务器配置
                        </Button>
                        <Button disabled={busy || !candidate} onClick={() => setMigrationOpen((value) => !value)}>
                            一次迁移旧电脑配置
                        </Button>
                        <Button disabled={busy} onClick={() => void logoutServerConfiguration()}>
                            退出登录
                        </Button>
                    </Space>
                    {migrationOpen && candidate ? (
                        <Card title="迁移前对比 · 登录前本机保留的配置">
                            <p className="mb-3 text-sm text-stone-500">候选保留时间：{formatTime(candidate.capturedAt)}。下方只显示配置差异，不展示密钥内容；不会迁移任务、画布或商品素材。个人与团队分开提交，附件先上传，失败可重试。</p>
                            <Table
                                pagination={false}
                                size="small"
                                rowKey="name"
                                dataSource={personalMigrationRows(candidate.personal, state.serverPersonal)}
                                columns={[
                                    { title: "个人配置", dataIndex: "name" },
                                    { title: "本机与服务器对比", dataIndex: "result" },
                                ]}
                            />
                            <Button
                                className="my-3"
                                disabled={busy}
                                onClick={() =>
                                    modal.confirm({ title: "将该本机候选保存为当前账号个人配置？", content: "会替换服务器中的对应个人配置。请先确认这是要迁移的旧电脑，密钥不会发送给团队成员。", onOk: () => saveServerConfiguration(candidate.personal) })
                                }
                            >
                                确认迁移个人配置
                            </Button>
                            {teamCandidate ? (
                                <>
                                    <Table
                                        pagination={false}
                                        size="small"
                                        rowKey="name"
                                        dataSource={teamMigrationRows(teamCandidate, state.serverTeam)}
                                        columns={[
                                            { title: "团队内容", dataIndex: "name" },
                                            { title: "本机候选", dataIndex: "local" },
                                            { title: "已发布", dataIndex: "server" },
                                            { title: "内容对比", dataIndex: "result" },
                                        ]}
                                    />
                                    <p className="my-2 text-sm text-stone-500">本机尚无类目层级时，迁移草稿会补入文件标准的 3 个大类、10 个子类及对应示例。</p>
                                    <Button
                                        disabled={busy || !state.manageTeam}
                                        onClick={() => modal.confirm({ title: "将本机团队配置保存为迁移草稿？", content: "先上传附件，再替换现有团队草稿。不会直接发布；请在类目规则中校对后发布。", onOk: migrateTeam })}
                                    >
                                        上传附件并保存团队迁移草稿
                                    </Button>
                                </>
                            ) : null}
                            {!state.manageTeam ? <p className="mt-2 text-sm">当前账号仅可迁移个人配置，团队迁移需要管理员权限。</p> : null}
                            {migrationMessage ? <Alert className="mt-3" type="info" showIcon title={migrationMessage} /> : null}
                        </Card>
                    ) : null}
                </>
            ) : (
                <Form layout="vertical" onFinish={() => void submit()} className="max-w-sm">
                    <Alert className="mb-4" type="info" title="登录后恢复配置" />
                    {getEnterpriseSsoEnabled() ? (
                        <>
                            <Button type="primary" block className="mb-3" onClick={startEnterpriseLogin} disabled={busy}>
                                {getEnterpriseSsoLabel()}
                            </Button>
                            <p className="mb-3 text-center text-xs text-stone-500">或使用账号密码登录</p>
                        </>
                    ) : null}
                    <Form.Item label="账号邮箱">
                        <Input aria-label="服务器配置账号邮箱" type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} />
                    </Form.Item>
                    <Form.Item label="密码">
                        <Input.Password aria-label="服务器配置密码" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
                    </Form.Item>
                    <Button type="primary" htmlType="submit" loading={busy} disabled={!email.trim() || !password}>
                        登录并恢复配置
                    </Button>
                </Form>
            )}
        </section>
    );
}
