// 门户配置。部署时只改这个文件，改完刷新页面即可生效。
// 地址只接受 https:// 开头的完整地址或以 / 开头的本站路径，其他写法会被忽略。
window.QYOS_PORTAL = {
    // 浏览器标题和页面大标题
    title: '企业OS',
    // 大标题下面的一行字，留空则不显示
    subtitle: 'jpmamoru 员工工作台',
    // 员工登录用的 IM 名称，与 Jadmin「登录方式」保持一致：飞书 / 企业微信 / 钉钉
    loginIm: '飞书',

    // 员工入口，按顺序显示为大卡片。icon 可选 chat、image、book、grid
    apps: [
        {
            name: 'Jchat',
            description: '对话、写作和部门知识库问答',
            url: 'https://jchat.jpmamoru.com/',
            icon: 'chat',
        },
        {
            name: 'Jimage',
            description: 'AI 生图、画布和商品图处理',
            // 直接走企业账号登录，登录后进入生图页
            url: 'https://jimage.jpmamoru.com/api/config-vault/oidc/start?return=%2Fimage',
            icon: 'image',
        },
    ],

    // 管理员入口，显示在页面下方的小字区域。员工点进去也需要管理员身份
    admin: [
        { name: 'Jadmin 管理后台', url: 'https://jadmin.jpmamoru.com/' },
    ],

    // 页脚的求助说明，留空则不显示
    help: '登录或使用遇到问题，请联系 IT 支持。',
};
