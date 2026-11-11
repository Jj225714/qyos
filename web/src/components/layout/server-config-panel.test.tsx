import { renderToStaticMarkup } from "react-dom/server";
import { App } from "antd";
import { describe, expect, it, vi } from "vitest";
import { createBuiltInPolicyPack } from "@/lib/commerce/defaults";
import { personalMigrationRows, teamMigrationRows, ServerConfigPanel, ServerConfigStatus } from "./server-config-panel";
const fixture = vi.hoisted(() => ({ state: {} as Record<string, unknown>, sso: false }));
vi.mock("./membership-library-panel", () => ({ MembershipLibraryPanel: () => <div>资产成员管理入口</div> }));
vi.mock("@/services/server-config", () => ({
    useServerConfigStore: () => fixture.state,
    initializeServerConfiguration: vi.fn(),
    loginServerConfiguration: vi.fn(),
    startEnterpriseLogin: vi.fn(),
    logoutServerConfiguration: vi.fn(),
    reloadServerConfiguration: vi.fn(),
    saveServerConfiguration: vi.fn(),
    loadTeamDraft: vi.fn(),
    saveTeamDraft: vi.fn(),
    uploadSettingsAsset: vi.fn(),
}));
vi.mock("@/services/settings-data", () => ({ prepareTeamSettingsForServer: vi.fn(), captureLocalPersonalSettings: () => ({ config: {} }) }));
vi.mock("@/stores/use-config-store", () => ({ useConfigStore: (select: (state: unknown) => unknown) => select({ openConfigDialog: vi.fn() }) }));
vi.mock("@/constant/runtime-config", () => ({ getServerConfigEnabled: () => true, getEnterpriseSsoEnabled: () => fixture.sso, getEnterpriseSsoLabel: () => "企业账号登录（飞书 / 企业微信 / 钉钉）" }));
describe("account sync UI", () => {
    it("compares credential changes without disclosing values", () => {
        const rows = personalMigrationRows({ config: { apiKey: "local-secret" } }, { config: { apiKey: "remote-secret" } });
        expect(rows[0].result).toBe("与服务器不同");
        expect(JSON.stringify(rows)).not.toContain("secret");
    });
    it("recognizes content differences even when team counts are identical", () => {
        const pack = createBuiltInPolicyPack();
        const rows = teamMigrationRows({ policyPack: pack, brands: [] }, { policyPack: { ...pack, name: "另一个同数量的配置" }, brands: [] });
        expect(rows[0].local).toBe(rows[0].server);
        expect(rows[0].result).toBe("内容有差异");
    });
    it("clearly asks a blank browser to log in and does not show retired authentication", () => {
        fixture.state = { user: null, phase: "signed-out", message: "" };
        const html = renderToStaticMarkup(
            <App>
                <ServerConfigStatus />
                <ServerConfigPanel />
            </App>,
        );
        expect(html).toContain("登录后恢复配置");
        expect(html).toContain("登录并恢复配置");
        expect(html).not.toContain("访问码");
    });
    it("offers enterprise sign-in only when the server enables it", () => {
        fixture.state = { user: null, phase: "signed-out", message: "" };
        const render = () => renderToStaticMarkup(
            <App>
                <ServerConfigPanel />
            </App>,
        );
        fixture.sso = false;
        expect(render()).not.toContain("企业账号登录");
        fixture.sso = true;
        const html = render();
        expect(html).toContain("企业账号登录（飞书 / 企业微信 / 钉钉）");
        expect(html).toContain("登录并恢复配置");
        fixture.sso = false;
    });
    it("shows separate personal and team versions and permission status", () => {
        fixture.state = { user: { id: 1, email: "test@example.com" }, phase: "ready", revision: 3, teamRevision: 7, manageTeam: false, message: "", migrationCandidate: null };
        const html = renderToStaticMarkup(
            <App>
                <ServerConfigPanel />
            </App>,
        );
        expect(html).toContain("团队只读成员");
        expect(html).toContain("个人配置");
        expect(html).toContain("团队配置");
        expect(html).toContain("最近成功同步");
        expect(html).not.toContain('type="password"');
    });
});
