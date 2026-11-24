"""DEP06 installation status; installation is managed outside Jadmin."""
def status():
    return {'managedDeployment': True,
            'stages': {'admin': 'done', 'jiapi': 'done', 'image': 'done', 'jichat': 'done', 'accounts': 'pending'},
            'busy': None,
            'notice': '服务已由服务器部署流程安装。企业登录、员工部门和模型渠道仍需配置；真实账号与模型联动尚未验收。'}

def start(stage):
    return {'error': '当前部署由服务器维护，不支持在管理后台重复安装。请使用企业配置和模型配置入口完成后续设置。'}, 409
