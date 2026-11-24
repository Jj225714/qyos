import type { ReactNode } from "react";

import { AgentPanel } from "@/components/agent/agent-panel";
import { AppTopNav } from "@/components/layout/app-top-nav";
import { StoreNotReadyNotice } from "@/components/storage/store-hydration-alert";

export default function UserLayout({ children }: { children: ReactNode }) {
    return (
        <div className="flex h-dvh overflow-hidden bg-background text-foreground">
            <StoreNotReadyNotice />
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <AppTopNav />
                <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
            </div>
            {/* TEMP_HIDDEN_HEADER: 同步隐藏 Agent 面板，避免已保存的展开状态继续占用界面。 */}
            {/* <AgentPanel /> */}
        </div>
    );
}
