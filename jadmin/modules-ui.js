const moduleCard = document.createElement('section');
moduleCard.className = 'card';
moduleCard.innerHTML = '<h2>模块状态与能力</h2><div id="moduleGrid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px"></div><p id="moduleNotice" class="muted" role="status"></p>';
document.querySelector('#app').insertBefore(moduleCard, document.querySelector('#app').firstElementChild);

async function refreshModules() {
  const notice = $('moduleNotice');
  try {
    const result = await api('/api/admin/modules');
    const labels = {healthy: '正常', degraded: '异常', unconfigured: '未连接', reachable: '端口可达（业务待验证）'};
    $('moduleGrid').replaceChildren(...Object.values(result.modules || {}).map(module => {
      const card = document.createElement('div');
      card.className = 'card';
      card.style.margin = '0';
      const status = document.createElement('strong');
      status.className = module.status === 'healthy' ? 'ok' : (module.status === 'degraded' ? 'bad' : 'muted');
      status.textContent = labels[module.status] || module.status;
      const title = document.createElement('div');
      title.textContent = module.name;
      const endpoint = document.createElement('small');
      endpoint.className = 'muted';
      endpoint.textContent = module.endpoint;
      const capabilities = document.createElement('div');
      capabilities.className = 'muted';
      capabilities.textContent = '能力：' + (module.capabilities || []).join('、');
      card.append(title, status, document.createElement('br'), endpoint, document.createElement('br'), capabilities);
      return card;
    }));
    notice.textContent = '状态来自本机服务探测；“未配置”表示后台尚未接入该服务，不代表服务本身故障。';
  } catch (error) {
    notice.textContent = '模块状态读取失败：' + error.message;
    notice.className = 'bad';
  }
}

const originalModuleLoad = load;
load = async function () {
  await Promise.allSettled([originalModuleLoad(), refreshModules()]);
};

const controlCard = document.createElement('section');
controlCard.className = 'card';
controlCard.innerHTML = '<h2>JAPI与配置保险库</h2><p class="muted">JAPI数据通过其现有管理接口读取，密钥只显示掩码。配置保险库管理员变更会记录审计。</p><button id="loadSub2">刷新JAPI</button> <button id="loadVault">刷新保险库管理员</button><div id="moduleData"><p class="muted">请选择要查看的模块</p></div><div><input id="vaultUserId" placeholder="保险库管理员用户 ID" inputmode="numeric"><button id="grantVault">授权</button><button id="revokeVault" class="danger">撤销</button></div><h3>新增JAPI账号</h3><div><input id="brainEmail" placeholder="邮箱"><input id="brainUsername" placeholder="用户名"><input id="brainPassword" type="password" placeholder="初始密码"><button id="createBrainUser">创建账号</button></div><p id="moduleActionNotice" class="muted"></p>';
document.querySelector('#app').appendChild(controlCard);
function clearModuleData() { $('moduleData').replaceChildren(); }
function addTable(title, rows) {
  const wrap=document.createElement('div'); const h=document.createElement('h3'); h.textContent=title; wrap.appendChild(h);
  const table=document.createElement('table'); const body=document.createElement('tbody');
  Object.entries(rows||{}).forEach(([k,v])=>{const tr=document.createElement('tr'); const a=document.createElement('th'); const b=document.createElement('td'); a.textContent=k; b.textContent=(v===null||v===undefined||v==='')?'—':(typeof v==='object'?JSON.stringify(v):String(v)); tr.append(a,b); body.appendChild(tr);});
  table.appendChild(body); wrap.appendChild(table); $('moduleData').appendChild(wrap);
}
function addListTable(title, items, columns) {
  const wrap=document.createElement('div'); const h=document.createElement('h3'); h.textContent=title; wrap.appendChild(h); const table=document.createElement('table');
  const thead=document.createElement('thead'); const hr=document.createElement('tr'); columns.forEach(c=>{const th=document.createElement('th');th.textContent=c[1];hr.appendChild(th);});thead.appendChild(hr);table.appendChild(thead);
  const tb=document.createElement('tbody'); (items||[]).forEach(item=>{const tr=document.createElement('tr');columns.forEach(c=>{const td=document.createElement('td');let v=item[c[0]];if(v===null||v===undefined||v==='')v='—';td.textContent=typeof v==='object'?JSON.stringify(v):String(v);tr.appendChild(td);});tb.appendChild(tr);});table.appendChild(tb);wrap.appendChild(table);$('moduleData').appendChild(wrap);
}
async function loadSub2Api() { try { const x=await api('/api/admin/sub2api'); clearModuleData(); const a=x.account?.data||{}; addTable('账户信息',{ID:a.id,邮箱:a.email,用户名:a.username,角色:a.role,状态:a.status,'最近活跃':a.last_active_at,'创建时间':a.created_at}); addTable('余额与额度',{余额:a.balance,冻结余额:a.frozen_balance,并发额度:a.concurrency,允许分组:a.allowed_groups,累计充值:a.total_recharged,'RPM 限制':a.rpm_limit}); addTable('通知设置',{余额通知:a.balance_notify_enabled?'已开启':'已关闭',通知阈值:a.balance_notify_threshold,附加邮箱:a.balance_notify_extra_emails}); const keys=x.keys?.data?.items||[]; addListTable('API Key（已脱敏）',keys,[['name','名称'],['keyMasked','Key'],['status','状态'],['group_id','分组'],['last_used_at','最近使用']]); const usage=x.usage?.data||{}; addTable('最近用量',{记录总数:usage.total,当前页:usage.page,每页数量:usage.page_size,页数:usage.pages}); addListTable('最近调用记录',usage.items||[],[['model','模型'],['service_tier','服务等级'],['reasoning_effort','推理等级'],['created_at','时间'],['total_tokens','Token']]); $('moduleActionNotice').textContent='JAPI数据已按表格加载'; } catch(e) { $('moduleActionNotice').textContent=e.message; $('moduleActionNotice').className='bad'; } }
async function loadVault() { try { const x=await api('/api/admin/config-vault'); clearModuleData(); addListTable('配置保险库管理员', x.administrators||[], [['id','用户 ID'],['email','邮箱'],['username','用户名'],['role','角色'],['status','账号状态'],['last_active_at','最近活跃'],['permission','保险库权限']]); $('moduleActionNotice').textContent='配置保险库管理员已按表格加载'; } catch(e) { $('moduleActionNotice').textContent=e.message; $('moduleActionNotice').className='bad'; } }
$('loadSub2').onclick=loadSub2Api; $('loadVault').onclick=loadVault;
async function vaultAction(action) { try { const id=$('vaultUserId').value.trim(); if(!/^\d+$/.test(id)) throw Error('请输入数字用户 ID'); const x=await api('/api/admin/config-vault/'+action,{method:'POST',body:JSON.stringify({userId:id})}); $('moduleActionNotice').textContent=(action==='grant'?'授权':'撤销')+'成功'; clearModuleData(); addListTable('配置保险库管理员', x.administrators||[], [['id','用户 ID'],['email','邮箱'],['username','用户名'],['role','角色'],['status','账号状态'],['last_active_at','最近活跃'],['permission','保险库权限']]); } catch(e) { $('moduleActionNotice').textContent=e.message; $('moduleActionNotice').className='bad'; } }
$('grantVault').onclick=()=>vaultAction('grant'); $('revokeVault').onclick=()=>vaultAction('revoke');

const accountCard = document.createElement('section');
accountCard.className = 'card';
accountCard.innerHTML = '<h2>全平台账号与用量</h2><p class="muted">汇总各平台账号、最近活跃时间和用量；Jchat 返回消息/会话/Token 统计，JAPI返回余额/并发状态。</p><button id="loadAccounts">刷新账号数据</button><div style="overflow:auto"><table><thead><tr><th>平台</th><th>账号</th><th>角色</th><th>状态</th><th>最近登录/活跃</th><th>用量</th></tr></thead><tbody id="accountRows"></tbody></table></div><p id="accountNotice" class="muted"></p>';
document.querySelector('#app').appendChild(accountCard);
async function loadAccounts() { try { const x=await api('/api/admin/accounts'); const rows=x.accounts||[]; $('accountRows').innerHTML=''; rows.forEach(a=>{const tr=document.createElement('tr'); const usage=a.usage||{}; tr.innerHTML='<td></td><td></td><td></td><td></td><td></td><td></td>'; tr.children[0].textContent=a.platform||''; tr.children[1].textContent=(a.email||a.username||'')+' '+(a.id?'('+a.id+')':''); tr.children[2].textContent=a.role||''; tr.children[3].textContent=a.status||''; tr.children[4].textContent=a.lastLoginAt||'暂无记录'; tr.children[5].textContent=Object.entries(usage).map(([k,v])=>k+': '+(v??0)).join('，'); $('accountRows').appendChild(tr); }); $('accountNotice').textContent='共 '+rows.length+' 条平台账号记录'; } catch(e) { $('accountNotice').textContent='账号数据读取失败：'+e.message; $('accountNotice').className='bad'; } }
$('loadAccounts').onclick=loadAccounts;

$('createBrainUser').onclick=async()=>{try{const email=$('brainEmail').value.trim(),password=$('brainPassword').value;if(!email||!password)throw Error('邮箱和初始密码必填');const x=await api('/api/admin/sub2api/users',{method:'POST',body:JSON.stringify({email,username:$('brainUsername').value.trim(),password})});$('moduleActionNotice').textContent='JAPI账号创建成功';$('brainPassword').value='';loadAccounts();}catch(e){$('moduleActionNotice').textContent='创建失败：'+e.message;$('moduleActionNotice').className='bad';}};

// Readable credentials are fetched only through the owner-authorized endpoint.
const credentialCard = document.createElement('section');
credentialCard.className = 'card';
credentialCard.innerHTML = '<h2>账号与 API Key</h2><p>密钥只显示前 7 位和后 4 位，用于核对是否配置正确；管理员密码不经网页显示，请在服务器私有环境文件中查看或修改。其他平台用户的密码无法从哈希还原；配置保险库使用JAPI账号密码。</p><button id="showCredentials">显示凭据摘要</button><button id="hideCredentials">隐藏凭据</button><p id="credentialNotice" role="status"></p><div id="credentialTable" style="overflow:auto"></div>';
document.querySelector('#app').appendChild(credentialCard);
function credentialRow(body, values) {
  const tr=document.createElement('tr');
  values.forEach(value=>{const td=document.createElement('td');td.textContent=value??'—';td.style.overflowWrap='anywhere';tr.appendChild(td);});
  body.appendChild(tr);
}
async function showCredentials() {
  $('credentialNotice').textContent='正在读取…';
  $('credentialTable').replaceChildren();
  try {
    const result=await api('/api/admin/credentials');
    const table=document.createElement('table'), head=document.createElement('thead'), body=document.createElement('tbody');
    credentialRow(head,['平台','账号 / 名称','凭据类型','值（掩码）']);
    credentialRow(body,['Jadmin',result.adminLogin.email,'登录密码',result.adminLogin.passwordConfigured?'已设置（不显示）':'未设置']);
    credentialRow(body,['Jchat','模型接口','API Key',result.librechatApiKey||'未配置']);
    (result.keys?.data?.items||[]).forEach(key=>credentialRow(body,['JAPI',key.name||key.id,'API Key',key.keyMasked||'未返回']));
    credentialRow(body,['Jchat / JAPI','用户账号','登录密码','哈希存储，无法还原；需设置新密码']);
    table.append(head,body);$('credentialTable').appendChild(table);
    $('credentialNotice').textContent=result.keys?.error||'已显示凭据摘要，本次查看已记录审计。';
  } catch(e) { $('credentialNotice').textContent='读取失败：'+e.message; }
}
$('showCredentials').onclick=showCredentials;
$('hideCredentials').onclick=()=>{$('credentialTable').replaceChildren();$('credentialNotice').textContent='凭据已隐藏';};
['brainPassword','newpassword','apiKey'].forEach(id=>{
  const input=$(id); if(!input)return;
  const toggle=document.createElement('button');toggle.type='button';toggle.textContent='显示';
  toggle.onclick=()=>{input.type=input.type==='password'?'text':'password';toggle.textContent=input.type==='password'?'显示':'隐藏';};
  input.after(toggle);
});
