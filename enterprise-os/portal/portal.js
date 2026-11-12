(function () {
    'use strict';

    var config = window.QYOS_PORTAL || {};

    var ICONS = {
        chat: '<path d="M5 6.5A3.5 3.5 0 0 1 8.5 3h11A3.5 3.5 0 0 1 23 6.5v7a3.5 3.5 0 0 1-3.5 3.5H12l-5 4v-4.2A3.5 3.5 0 0 1 5 13.5z"/><path d="M10 8.5h8M10 12h5" class="line"/>',
        image: '<rect x="3.5" y="4" width="21" height="18" rx="3.5"/><circle cx="10" cy="10" r="2.2" class="line"/><path d="M5 19.5l5.5-5.5 4 4 3-3 5 4.5" class="line"/>',
        book: '<path d="M5 5.5A2.5 2.5 0 0 1 7.5 3H22v18H7.5A2.5 2.5 0 0 0 5 23.5z"/><path d="M5 23.5A2.5 2.5 0 0 1 7.5 21H22v2.5" class="line"/>',
        grid: '<rect x="4" y="4" width="8.5" height="8.5" rx="2"/><rect x="15.5" y="4" width="8.5" height="8.5" rx="2"/><rect x="4" y="15.5" width="8.5" height="8.5" rx="2"/><rect x="15.5" y="15.5" width="8.5" height="8.5" rx="2"/>',
    };

    /** 只放行 https:// 完整地址和本站绝对路径，避免配置写错时出现 javascript: 之类的链接。 */
    function safeUrl(value) {
        if (typeof value !== 'string') return null;
        var url = value.trim();
        if (/^\/(?!\/)/.test(url)) return url;
        try {
            var parsed = new URL(url);
            return parsed.protocol === 'https:' ? parsed.href : null;
        } catch (error) {
            return null;
        }
    }

    function text(id, value) {
        var el = document.getElementById(id);
        if (!el) return;
        if (typeof value === 'string' && value.trim()) {
            el.textContent = value.trim();
            el.hidden = false;
        } else {
            el.hidden = true;
        }
    }

    function appCard(app) {
        var url = safeUrl(app.url);
        if (!url || !app.name) return null;

        var li = document.createElement('li');
        var link = document.createElement('a');
        link.className = 'app';
        link.href = url;

        var icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('viewBox', '0 0 28 28');
        icon.setAttribute('aria-hidden', 'true');
        icon.setAttribute('class', 'app-icon');
        icon.innerHTML = ICONS[app.icon] || ICONS.grid; // 固定图标，不来自配置内容

        var body = document.createElement('span');
        body.className = 'app-body';
        var name = document.createElement('span');
        name.className = 'app-name';
        name.textContent = app.name;
        body.appendChild(name);
        if (app.description) {
            var desc = document.createElement('span');
            desc.className = 'app-desc';
            desc.textContent = app.description;
            body.appendChild(desc);
        }

        var arrow = document.createElement('span');
        arrow.className = 'app-arrow';
        arrow.setAttribute('aria-hidden', 'true');
        arrow.textContent = '→';

        link.appendChild(icon);
        link.appendChild(body);
        link.appendChild(arrow);
        li.appendChild(link);
        return li;
    }

    var title = typeof config.title === 'string' && config.title.trim() ? config.title.trim() : '企业OS';
    document.title = title;
    text('title', title);
    text('subtitle', config.subtitle);
    if (typeof config.loginIm === 'string' && config.loginIm.trim()) {
        text('login-hint', '用' + config.loginIm.trim() + '账号登录，不需要单独的密码。');
    }

    var list = document.getElementById('apps');
    list.textContent = '';
    (Array.isArray(config.apps) ? config.apps : []).forEach(function (app) {
        var card = appCard(app || {});
        if (card) list.appendChild(card);
    });
    if (!list.children.length) {
        var empty = document.createElement('li');
        empty.className = 'noscript';
        empty.textContent = '还没有配置应用入口，请管理员编辑 config.js。';
        list.appendChild(empty);
    }

    var adminLinks = document.getElementById('admin-links');
    (Array.isArray(config.admin) ? config.admin : []).forEach(function (item) {
        var url = item && safeUrl(item.url);
        if (!url || !item.name) return;
        var a = document.createElement('a');
        a.href = url;
        a.textContent = item.name;
        adminLinks.appendChild(a);
    });
    document.getElementById('admin').hidden = !adminLinks.children.length;

    text('help', config.help);
})();
