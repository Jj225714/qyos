import { startStorageSession } from "@/services/storage-gc";

// Storage maintenance (deleting unused files) must finish before any app module reads or writes stored data,
// and only runs when no other tab is open. The app itself is loaded afterwards. If this page cannot join the
// cross-tab presence group (while the browser supports it), it does not start: another tab might be deleting files.
startStorageSession().then(
    () => import("./app-main"),
    (error) => {
        console.error("[storage] 无法与其他标签页协调本地存储", error);
        const root = document.getElementById("root");
        if (root) root.innerHTML = '<main style="max-width:560px;margin:15vh auto;font:16px system-ui;line-height:1.6;padding:24px">无法与其他标签页协调本地存储，为保护已保存的数据，应用暂未启动。请关闭其他标签页后<button onclick="location.reload()" style="margin-left:8px">刷新</button></main>';
    },
);
