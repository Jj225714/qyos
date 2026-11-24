// 门户启动：把真实的浏览器对象交给 portal-core.js。
(function () {
    'use strict';
    var core = window.QYOS_PORTAL_CORE;
    if (!core) return;
    core.createPortal({
        document: document,
        config: window.QYOS_PORTAL || {},
        fetch: window.fetch.bind(window),
        location: window.location,
        history: window.history,
        setInterval: window.setInterval.bind(window),
        clearInterval: window.clearInterval.bind(window),
        addEventListener: window.addEventListener.bind(window),
    }).start();
})();
