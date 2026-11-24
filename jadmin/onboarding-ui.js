// Progress is derived from observed data. Only optional skip preferences persist.
(function () {
  const names = ['确认部署状态', '配置模型接口', '分配部门与业务权限', '核对已有员工账号', '配置企业登录', '关联管理员企业账号', '添加其他管理员', '员工试用与业务验收'];
  // Keep stored skip IDs and panel dispatch stable while changing the displayed order.
  const primary = [0,4,1,2,7], optionalSteps = [3,5,6];
  const title = step => primary.includes(step.id) ? primary.indexOf(step.id)+'. '+step.name : step.name+'（按需）';
  const labels = {complete:'已完成',incomplete:'未完成',unknown:'未知',blocked:'受阻',skipped:'已跳过，可稍后配置',info:'信息说明',unverified:'未验证（需人工确认）'};
  const ok = entry => entry && entry.status === 'ok' && entry.at > 0 && !entry.stale;
  function derive(entries, skipped = {}, ownerEmail = '') {
    const value = key => ok(entries[key]) ? entries[key].value : null;
    const result = names.map((name,id) => ({id,name,status:id===0?'info':id===7?'unverified':'unknown',detail:'尚未检查',at:0}));
    const set = (id,status,detail,key) => Object.assign(result[id], {status,detail,at:entries[key]?.at||0});
    set(0,'info','只读取部署与服务信息，不执行安装。','modules');
    const providers=value('providers'), model=value('model');
    const configured=providers?.providers?.some(p=>p.keyConfigured===true);
    if (providers) {
      if (!configured) set(1,'incomplete','尚未配置模型接口 Key。','providers');
      else if (!model) set(1,'unknown','Key 已配置 · 模型列表未检查（未知）','model');
      else if (!model.error && model.models?.length && model.models.includes(model.defaultModel)) set(1,'complete','模型列表可读取，默认模型在列表中；对话业务仍需人工验证。','model');
      else set(1,'incomplete',model.error||'请拉取模型并从有效列表中设置默认模型。','model');
    }
    const departments=value('departments');
    if (departments) set(2,departments.departments?.length?'complete':'incomplete',departments.departments?.length?'已有 '+departments.departments.length+' 个部门。':'还没有部门；先在身份服务建立群组，再添加部门。','departments');
    const directory=value('directory');
    if (!directory) set(3,'unknown','员工资料未检查；需主动读取员工目录。','directory');
    else set(3,directory.total>0?'complete':'incomplete',directory.total>0?'已读取 '+directory.total+' 人，资料问题请到检查表逐项处理。':'员工目录为空，无法评估匹配情况。','directory');
    const login=value('login'), op=login?.operation;
    const recovery=op && (['interrupted','compensation_failed'].includes(op.status)||['interrupted','compensation_failed'].includes(op.phase));
    if (login) {
      if (recovery) set(4,'blocked','登录操作未完成，请先核对状态或恢复操作前快照。','login');
      else if (!login.connection?.ok || !login.guard?.ok || login.signup?.paused) set(4,'blocked','身份服务、注册保护或新员工注册状态未满足前提；后台邮箱密码登录始终可用。','login');
      else if (login.activeRevisionId && login.loginState==='consistent' && op?.status==='done') set(4,'complete','配置已发送到各应用；真实员工登录仍需人工验证。','login');
      else if (['draining','cleanup_incomplete'].includes(op?.phase)) set(4,'incomplete','切换尚未完成，请返回企业登录继续等待或完成清理。','login');
      else if (login.stagedRevisionId) set(4,'incomplete','已有 Jadmin 试用版本，请继续测试真实登录。','login');
      else if (login.revisions?.length) set(4,'incomplete','已有保存版本，请继续凭据测试和试用。','login');
      else set(4,'incomplete','尚未开始配置企业登录；可稍后处理，邮箱密码登录始终可用。','login');
    }
    const links=value('links');
    if (links) set(5,!links.enabled?'blocked':links.self?'complete':'incomplete',!links.enabled?'企业账号登录未配置。':links.self?'管理员已关联企业账号。':'尚未关联当前管理员的企业账号。','links');
    const users=value('users');
    if (users) {
      const count=(users.users||[]).filter(u=>String(u.role).toUpperCase()==='ADMIN' && String(u.email).toLowerCase()!==ownerEmail.toLowerCase()).length;
      set(6,count?'complete':'incomplete',count?'已有 '+count+' 个其他管理员；请按需配置保险库权限。':'尚无其他管理员，可由当前所有者继续管理。','users');
    }
    set(7,'unverified','需人工验证对话、生图、团队知识库和跨应用登录。','');
    result.forEach(step=>{if(step.id>=2&&step.id<=6&&skipped[step.id]&&step.status!=='complete'&&!(step.id===4&&recovery))step.status='skipped';});
    return result;
  }
  function progress(steps) {
    const optional=steps.slice(2,7);
    return '必需设置 '+(steps[1].status==='complete'?1:0)+'/1 · 可选设置 '+optional.filter(s=>s.status==='complete').length+'/5 完成 · 已跳过 '+optional.filter(s=>s.status==='skipped').length+' · 未知 '+steps.slice(1,7).filter(s=>s.status==='unknown').length;
  }
  window.JadminOnboarding={derive,progress};
  if (typeof document==='undefined') return;
  const shell=JadminShell, state=JadminState;
  const el=(tag,text,attrs={})=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;Object.assign(n,attrs);return n;};
  const storageKey='qyos.jadmin.onboarding.skip.v1';
  let skips={};
  try {const stored=JSON.parse(localStorage.getItem(storageKey)||'{}');for(let id=2;id<=6;id++)if(stored[id]===true)skips[id]=true;} catch(_) {}
  let selected=null, moved=[], visit=0;
  const entries=()=>Object.fromEntries(['providers','model','departments','directory','login','links','users','modules'].map(k=>[k,state.get(k)]));
  const steps=()=>derive(entries(),skips,shell.isOwner()&&typeof shell.actor==='function'?shell.actor():'');
  const root=el('section',undefined,{className:'onboarding'});
  const summary=el('section',undefined,{className:'card'});
  const list=el('nav',undefined,{className:'setup-steps'});list.setAttribute('aria-label','首次设置步骤');
  const panel=el('section',undefined,{className:'card setup-panel'});
  const layout=el('div',undefined,{className:'setup-layout'});layout.append(list,panel);root.append(summary,layout);
  const overview=el('section',undefined,{className:'card setup-progress'});
  document.getElementById('setup-placeholder')?.remove();
  shell.mount('setup',root);shell.mount('overview',overview);
  const style=el('style');style.textContent='.setup-layout{display:grid;grid-template-columns:230px minmax(0,1fr);gap:18px}.setup-steps{display:flex;flex-direction:column;gap:6px}.setup-steps button{text-align:left;background:white;color:#344054;border:1px solid #d9e0ea;white-space:normal;line-height:1.5}.setup-steps button[aria-current=step]{border-color:#2563eb;background:#eff6ff;color:#1d4ed8}.setup-panel{min-width:0;margin:0}.setup-step-state{padding:8px 0}.setup-panel .card{box-shadow:none}.setup-embed{min-width:0}.setup-panel h2{font-size:20px}.setup-progress ul{display:flex;flex-wrap:wrap;gap:10px 20px;padding-left:20px}.setup-panel>footer{margin-top:20px;border-top:1px solid #e5e9f0;padding-top:12px}.setup-owner-hint{color:#667085}@media(max-width:959px){.setup-layout{grid-template-columns:minmax(0,1fr)}.setup-steps{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.setup-steps button{margin:0;font-size:13px}}';document.head.append(style);
  function timestamp(step) {return step.at?'数据时间 '+new Date(step.at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})+(Date.now()-step.at>300000?' · 可能已过期':''):'';}
  function renderProgress() {
    const data=steps();
    summary.replaceChildren(el('h2','开始设置'),el('p',progress(data)),el('p','按需要依次配置；可选项目允许稍后处理。业务验收始终需要人工确认。',{className:'muted'}));
    if(!shell.isOwner())summary.append(el('p','以下设置需由所有者完成；当前仅查看设置状态。',{className:'setup-owner-hint'}));
    const stepButton=step=>{
      const b=el('button',title(step)+' · '+labels[step.status],{type:'button',onclick:()=>selectStep(step.id)});
      if(selected===step.id)b.setAttribute('aria-current','step');return b;
    };
    list.replaceChildren(...primary.map(id=>stepButton(data[id])),el('p','按需设置',{className:'muted'}),...optionalSteps.map(id=>stepButton(data[id])));
    overview.replaceChildren(el('h2','首次设置进度'),el('p',progress(data)));
    const chips=el('ul');primary.slice(1).forEach(id=>chips.append(el('li',data[id].name+'：'+labels[data[id].status])));overview.append(chips,el('button','继续设置',{type:'button',onclick:()=>shell.navigate('setup')}));
  }
  function restore() {for(const item of moved){if(item.marker.parentNode)item.marker.replaceWith(item.node);else shell.mount(item.route,item.node);}moved=[];}
  function embed(route,node,host) {if(!node)return;const marker=document.createComment('wizard '+route);node.replaceWith(marker);host.append(node);moved.push({route,node,marker});}
  const hints=[
    '确认各服务可访问。这里只显示部署说明，不执行安装或重试安装。',
    '先保存 API 地址和 Key，再读取模型列表并设定默认模型。后台读取列表成功不等于已经验证真实对话。',
    '员工可以先通过企业平台登录。默认需要分配部门才能开通模型接口权限；企业登录不会自动同步部门。',
    '切换已有账号的登录方式时，按需核对邮箱、手机号和账号绑定，避免重复账号。新企业可先用测试账号验证，无需预录所有员工。',
    '保存时自动测试凭据，再在 Jadmin 试用、完成真实登录测试并启用。无需先建立部门。企业微信按 userid 匹配已有员工，请先确认测试员工的账号匹配。后台邮箱密码登录始终可用。',
    '在当前管理员自己的企业账号中完成关联，以后可以使用企业登录进入后台。',
    '可增加其他管理员并按需授予配置保险库权限。当前任何管理员都可管理其他管理员。',
    '建议先完成模型接口配置，再逐项人工验收。企业登录为可选；没有企业登录时，可使用密码账号测试。'
  ];
  async function selectStep(id,{force=false}={}) {
    const thisVisit=++visit;restore();selected=id;renderProgress();
    const step=steps()[id];
    const description=el('p',step.detail,{className:'setup-step-state'}), time=el('p',timestamp(step),{className:'muted'});
    const target=el('div',undefined,{className:'setup-embed'});
    const retry=el('button','刷新此步骤',{type:'button',onclick:()=>selectStep(id,{force:true})});
    panel.replaceChildren(el('h2',title(step)),el('p',hints[id]),description,time,retry,target);
    if(id===7){
      const checklist=el('ol');[
        '对话：使用测试账号发送一条问题，确认模型回复、用量记录及会话保存。',
        '生图：提交一次真实请求，确认生成结果和权限；当前服务可达并不能证明业务可用。',
        '团队知识库：项目采用 LibreChat 团队 RAG 方案，需人工核对文档上传、部门可见范围及带来源的回答。历史部门配置可能仍含 RAGFlow 入口，不代表当前知识库已验收。',
        '统一登录：使用员工测试账号逐一打开首页、聊天、生图和 API 功能，检查进入、退出与访问权限。'
      ].forEach(text=>checklist.append(el('li',text)));target.append(checklist,el('p','未验证（需人工确认）；此页不保存验收记录。',{className:'muted'}));retry.hidden=true;
    } else if(!shell.isOwner()) {
      target.append(el('p','仅所有者可在此向导进行设置。您可在日常管理页面使用已有权限。',{className:'muted'}));retry.hidden=true;
    } else {
      description.textContent='正在读取…';
      try {
        if(id===0){
          const modules=await state.read('modules',()=>api('/api/admin/modules'),{force});
          if(thisVisit!==visit)return;
          const serviceList=el('ul');Object.values(modules.modules||{}).forEach(m=>serviceList.append(el('li',m.name+'：'+({healthy:'正常',degraded:'异常',unconfigured:'未连接',reachable:'可达，业务待验证'}[m.status]||m.status))));target.append(serviceList);
          await shell.loadSetupNotice();if(thisVisit!==visit)return;
          if(typeof setupCard!=='undefined')embed('status',setupCard,target);
        }
        if(id===1){await shell.run('models',{force});if(thisVisit!==visit)return;embed('models',document.getElementById('modelConfigCard')||shell.page('models')?.querySelector('.card'),target);}
        if(id===2||id===3){if(window.JadminEnterprise.selectPeopleTab)await window.JadminEnterprise.selectPeopleTab(id===2?'departments':'directory',{load:false});await window.JadminEnterprise.refreshDepartments({force});if(id===3)await window.JadminEnterprise.refreshDirectory({force});if(thisVisit!==visit)return;embed('people',window.JadminEnterprise.cards.people,target);}
        if(id===4){await window.JadminEnterprise.refreshLoginIm({force});if(thisVisit!==visit)return;embed('login',window.JadminEnterprise.cards.login,target);}
        if(id===5){await window.JadminEnterprise.refreshLinks({force});if(thisVisit!==visit)return;embed('admins',window.JadminEnterprise.cards.links,target);}
        if(id===6){embed('admins',document.getElementById('adminUsersCard')||shell.page('admins')?.querySelector('.card'),target);target.append(el('button','查看全部管理员与保险库权限',{type:'button',onclick:()=>shell.navigate('admins')}));await shell.run('admins',{force});if(thisVisit!==visit)return;}
        const current=steps()[id];description.textContent=labels[current.status]+' · '+current.detail;time.textContent=timestamp(current);renderProgress();
      } catch(error){if(error.code==='superseded_read'||thisVisit!==visit)return;const current=steps()[id];description.textContent=(current.status==='unknown'?'读取失败，状态未知。':labels[current.status]+' · '+current.detail+' 部分辅助数据读取失败。')+'请重试。';description.className='bad';time.textContent=timestamp(current);const details=el('details');details.append(el('summary','技术详情'),el('pre',error.message));target.append(details);renderProgress();}
    }
    if(thisVisit!==visit)return;
    const footer=el('footer');
    const position=primary.indexOf(id);
    if(position>0)footer.append(el('button','上一步',{type:'button',onclick:()=>selectStep(primary[position-1])}));
    if(id>=2&&id<=6&&shell.isOwner()&&!(id===4&&/恢复/.test(steps()[4].detail)))footer.append(el('button',skips[id]?'取消稍后处理':'稍后处理',{type:'button',onclick:()=>{
      if(skips[id])delete skips[id];else skips[id]=true;
      try{localStorage.setItem(storageKey,JSON.stringify(skips));}catch(_){shell.notice('浏览器无法保存偏好；本次会话中仍可稍后处理。');}
      selectStep(id);
    }}));
    if(position>=0&&position<primary.length-1)footer.append(el('button','下一步',{type:'button',onclick:()=>selectStep(primary[position+1])}));
    if(position<0)footer.append(el('button','返回业务验收',{type:'button',onclick:()=>selectStep(7)}));
    panel.append(footer);
    if(typeof shell.labelTables==='function')shell.labelTables(panel);
  }
  window.addEventListener('hashchange',()=>{if(!location.hash.startsWith('#/setup')){visit++;restore();}});
  shell.register('overview',async()=>renderProgress());
  shell.register('setup',async({force=false}={})=>{
    const data=steps();
    const recovery=data[4].status==='blocked'&&/恢复/.test(data[4].detail);
    const initial=recovery?4:(primary.slice(1).find(id=>!['complete','skipped'].includes(data[id].status))??7);
    await selectStep(selected===null?initial:selected,{force});
  });
  if(typeof state.subscribe==='function')state.subscribe(()=>{
    if(state.get('links').status==='unloaded'){visit++;restore();selected=null;}
    renderProgress();
  });
  renderProgress();
})();
