import base64, hashlib, hmac, json, os, secrets, sqlite3, time, subprocess, threading, shutil
import urllib.request, urllib.error
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import setup_wizard
import enterprise
import employee_email
import email_confirmation
import module_grants
import media_http
import work_http
import mail_service
import mail_http
import api_usage_admin
import login_config
import model_transport
import model_config_service
import runtime_model_settings
from runtime_model_client import ModelError, IDENTIFIER, valid
import sys
import ssl
DB=os.environ.get('ADMIN_DB','/opt/enterprise-ai-platform/admin-panel/admin.db'); KEY=os.environ.get('ADMIN_SECRET',''); EMAIL=os.environ.get('ADMIN_EMAIL',''); PASS=os.environ.get('ADMIN_PASSWORD',''); LCENV=os.environ.get('LIBRECHAT_ENV','/opt/enterprise-ai-platform/librechat.env'); LCYAML=os.environ.get('LIBRECHAT_CONFIG','/opt/enterprise-ai-platform/librechat.yaml'); MONGO_CONTAINER=os.environ.get('LIBRECHAT_MONGO_CONTAINER','enterprise-ai-platform-mongodb-1')
SUB2API_BASE=os.environ.get('SUB2API_BASE_URL','http://127.0.0.1:8080')
SUB2API_ENV=os.environ.get('SUB2API_ENV','/opt/enterprise-ai-platform/sub2api.env')
VAULT_ADMIN_FILE=os.environ.get('CONFIG_VAULT_ADMIN_FILE','/opt/enterprise-ai-platform/private/vault-admins.json')
VAULT_ADMIN_CLI=os.environ.get('CONFIG_VAULT_ADMIN_CLI','/opt/enterprise-ai-platform/config-vault/admin-users.mjs')
MODEL_BASE_URL=os.environ.get('MODEL_BASE_URL',SUB2API_BASE+'/v1')
CONFIG_LOCK_PATH='/run/qyos-librechat-apply/config.lock'
APPLY_SOCKET_PATH='/run/qyos-librechat-apply/apply.sock'
from contextlib import closing
_schema_lock=threading.Lock(); _schema_ready=set()
_LC_FILES_LOCK=threading.RLock()
def connect():
 c=sqlite3.connect(DB,timeout=15); c.row_factory=sqlite3.Row; return c
def init_db():
 """Creates/migrates the schema and turns on WAL. Runs once per process (main() calls it at startup)."""
 with _schema_lock:
  if DB in _schema_ready: return
  with closing(connect()) as c:
   c.execute('pragma journal_mode=WAL')
   c.execute('create table if not exists users(id integer primary key,email text unique,password text,role text,enabled integer default 1,created integer,username text)')
   cols={r[1] for r in c.execute('pragma table_info(users)')}
   if 'username' not in cols: c.execute('alter table users add column username text')
   c.execute('create table if not exists config(k text primary key,v text,updated integer)')
   c.execute("delete from config where k='apiKey'")  # older versions kept a plaintext copy of the API key here
   c.execute('delete from config where k in (?,?,?,?,?)',('_endpointState','_endpointKeyOrigin','expectedBaseURL','expectedRevision','reuseKeyForNewOrigin'))
   c.execute("create table if not exists endpoint_binding(id integer primary key check(id=1), revision integer not null, state text not null, committed_origin text, pending_origin text, updated integer)")
   c.execute('create table if not exists audit(id integer primary key,action text,detail text,at integer)')
   c.execute('create table if not exists metrics(id integer primary key,at integer,cpu real,memory real,disk real,containers text)')
   enterprise.init_db(c)
   login_config.init_db(c)
   runtime_model_settings.init_db(c)
   c.commit()
   login_config.recover_startup(c)
   model_service().init_db(c)
  _schema_ready.add(DB)
def db():
 """A new connection; the caller closes it (request handlers do so in H.close_db, jobs use closing())."""
 if DB not in _schema_ready: init_db()
 return connect()

def audit(c, action, detail):
 c.execute('insert into audit(action,detail,at) values(?,?,?)',(action,detail,int(time.time()))); c.commit()

_runtime_models=runtime_model_settings.Settings(sys.modules[__name__])
def model_config_write_guard(c,operation_id):
 try: runtime_model_settings.check_chat_write(c,operation_id)
 except ModelError as e: raise model_config_service.ServiceError(e.code,e.status) from None

def health(url, timeout=4):
 import urllib.request
 try: return urllib.request.urlopen(url,timeout=timeout).status==200
 except: return False

def reachable(host, port, timeout=2):
 import socket
 try:
  with socket.create_connection((host, port), timeout=timeout): return True
 except OSError: return False

def module_status():
 return {
  'admin': {'name':'Jadmin','status':'healthy','endpoint':'127.0.0.1:8090','capabilities':['modules','audit','metrics']},
  'librechat': {'name':'Jchat','status':'healthy' if health('http://127.0.0.1:3080/api/config',1) else 'degraded','endpoint':'127.0.0.1:3080','capabilities':['users','endpoint-config','models']},
  'sub2api': {'name':'JAPI','status':'healthy' if health(os.environ.get('SUB2API_HEALTH_URL','http://127.0.0.1:8080/health'),1) else ('unconfigured' if not reachable('127.0.0.1',8080,1) else 'degraded'),'endpoint':os.environ.get('SUB2API_HEALTH_URL','http://127.0.0.1:8080/health'),'capabilities':['health','models']},
  'image': {'name':'Jimage','status':'healthy' if health(os.environ.get('IMAGE_SYSTEM_URL','http://127.0.0.1/'),1) else ('unconfigured' if not reachable('127.0.0.1',3000,1) else 'degraded'),'endpoint':os.environ.get('IMAGE_SYSTEM_URL','http://127.0.0.1/'),'capabilities':['页面可达性检查；业务管理未接入']},
  'configVault': {'name':'配置保险库','status':'reachable' if reachable(os.environ.get('CONFIG_VAULT_HOST','127.0.0.1'),int(os.environ.get('CONFIG_VAULT_PORT','3183'))) else 'unconfigured','endpoint':os.environ.get('CONFIG_VAULT_HOST','127.0.0.1')+':'+os.environ.get('CONFIG_VAULT_PORT','3183'),'capabilities':['端口探测；配置管理未接入']},
  'providerRelay': {'name':'模型转发服务','status':'reachable' if reachable(os.environ.get('PROVIDER_RELAY_HOST','127.0.0.1'),int(os.environ.get('PROVIDER_RELAY_PORT','3181'))) else 'unconfigured','endpoint':os.environ.get('PROVIDER_RELAY_HOST','127.0.0.1')+':'+os.environ.get('PROVIDER_RELAY_PORT','3181'),'capabilities':['端口探测；调用验证未执行']},
 }

def env_file(path):
 out={}
 try:
  for line in open(path):
   line=line.strip()
   if line and not line.startswith('#') and '=' in line:
    k,v=line.split('=',1); out[k]=v.strip().strip('"').strip("'")
 except: pass
 return out

def sub2api_request(path, method='GET', payload=None):
 """Use the existing JAPI admin API; return a redacted view."""
 e=env_file(SUB2API_ENV); email=e.get('ADMIN_EMAIL'); password=e.get('ADMIN_PASSWORD')
 if not email or not password: return {'error':'JAPI管理员凭据未配置'}
 try:
  body=json.dumps({'email':email,'password':password}).encode()
  req=urllib.request.Request(SUB2API_BASE+'/api/v1/auth/login',data=body,headers={'Content-Type':'application/json'},method='POST')
  login=json.load(urllib.request.urlopen(req,timeout=8)); data=login.get('data') or {}; token=data.get('access_token')
  if not token: return {'error':'JAPI登录失败'}
  req=urllib.request.Request(SUB2API_BASE+path,headers={'Authorization':'Bearer '+token},method=method)
  if payload is not None:
   req.data=json.dumps(payload).encode(); req.add_header('Content-Type','application/json')
  return json.load(urllib.request.urlopen(req,timeout=10))
 except urllib.error.HTTPError as e: return {'error':'JAPI接口 HTTP '+str(e.code)}
 except Exception: return {'error':'JAPI接口暂时不可用'}

def vault_admins(action='list', user_id=None):
 args=['node',VAULT_ADMIN_CLI,'--file',VAULT_ADMIN_FILE,'--action',action]
 if user_id: args += ['--user-id',str(user_id)]
 try: return json.loads(subprocess.check_output(args,text=True,stderr=subprocess.DEVNULL,timeout=10))
 except Exception: return {'error':'配置保险库管理员列表读取失败'}

def system_metrics():
 try:
  load=float(os.getloadavg()[0]); cpu=round(min(100,load/(os.cpu_count() or 1)*100),1)
 except: cpu=0
 try:
  du=shutil.disk_usage('/'); disk=round(du.used/du.total*100,1)
  with open('/proc/meminfo') as f: vals={x.split(':')[0]:int(x.split()[1]) for x in f if ':' in x}
  memory=round((1-vals.get('MemAvailable',0)/vals.get('MemTotal',1))*100,1)
 except: memory=disk=0
 try:
  out=subprocess.check_output(['docker','ps','--format','{{.Names}}|{{.Status}}|{{.Image}}'],text=True,timeout=5)
  containers=[dict(zip(['name','status','image'],x.split('|',2))) for x in out.splitlines() if x]
 except: containers=[]
 return {'at':int(time.time()),'cpu':cpu,'memory':memory,'disk':disk,'containers':containers}

def collect_metrics():
 while True:
  try:
   m=system_metrics()
   with closing(db()) as c: c.execute('insert into metrics(at,cpu,memory,disk,containers) values(?,?,?,?,?)',(m['at'],m['cpu'],m['memory'],m['disk'],json.dumps(m['containers']))); c.execute('delete from metrics where at<?',(int(time.time())-86400,)); c.commit()
  except Exception: pass
  time.sleep(60)

def raw_env(name, strict=False):
 try:
  with open(LCENV,encoding='utf-8') as f:
   for line in f:
    if line.startswith(name+'='): return line.rstrip().split('=',1)[1]
 except (OSError,UnicodeError):
  if strict: raise
 return ''

def current_config():
 out={}
 try:
  with open(LCENV,encoding='utf-8') as stream:
   for line in stream:
    if '=' in line:
     k,v=line.rstrip().split('=',1); out[k]=v
  key=out.get('ZHITOUZHUAN_API_KEY','')
  # keySuffix is deprecated and stays empty for response-shape compatibility.
  return {'customBaseURL':display_base_url(MODEL_BASE_URL),'keyConfigured':bool(key.strip()),'keySuffix':'', 'domainClient':out.get('DOMAIN_CLIENT',''), 'endpoints':out.get('ENDPOINTS','')}
 except: return {'keyConfigured':False,'keySuffix':''}

LOOPBACK_HOSTS=('127.0.0.1','localhost','::1')
def url_origin(url):
 return model_transport.url_origin(url)
def url_host(url):
 from urllib.parse import urlsplit
 try: return urlsplit(str(url or '')).hostname or ''
 except ValueError: return ''
def trusted_model_origins():
 """Operator-trusted internal exceptions; public HTTPS hosts do not need this list."""
 out={url_origin(MODEL_BASE_URL)}
 for item in os.environ.get('JADMIN_ALLOWED_MODEL_ORIGINS','').split(','):
  if item.strip(): out.add(url_origin(item.strip()))
 out.discard(None)
 return out
def check_model_url(url):
 return resolve_model_target(url)

def parse_model_url(url):
 return model_transport.parse_model_url(url, trusted_model_origins())

def resolve_model_target(url):
 return model_transport.resolve_model_target(url, trusted_model_origins())
def fetch_models(base, key, *, timeout=None):
 return model_transport.fetch_models(base, key, trusted_model_origins(), timeout=timeout)

def probe_chat_model(base,key,model,*,timeout=None):
 return model_transport.probe_chat_model(base,key,model,trusted_model_origins(),timeout=timeout)

def models():
 try: return fetch_models(*_bound_probe_args())
 except Exception: return []

def current_base_url():
 return model_service().current_base_url()

def display_base_url(value=None):
 try: return parse_model_url(current_base_url() if value is None else value).base
 except ValueError: return ''

def public_config(c):
 values={r['k']:r['v'] for r in c.execute("select k,v from config where k in ('defaultModel','baseURL','providerName')")}
 if 'baseURL' in values: values['baseURL']=display_base_url(values['baseURL'])
 return values

def _probe_snapshot():
 init_db()
 return model_service().snapshot()

def _bound_probe_args():
 endpoint, _, key, error=_probe_snapshot()
 if error: raise ValueError(error)
 return endpoint['baseURL'], key

def model_status(actor=None):
 endpoint, default, key, error=_probe_snapshot()
 if error: error=model_error_message(error)
 result={'models':[], 'defaultModel':default, 'fallbackModel':endpoint.get('fallbackModel',''), 'baseURL':endpoint['baseURL'], 'endpoint':endpoint, 'revision':endpoint['revision'], 'error':error}
 result.update(firstSetup=bool(endpoint.get('firstSetup')),endpointsWarning=bool(endpoint.get('endpointsWarning')))
 with closing(db()) as c: result['apply']=model_service().apply_status(c,actor or EMAIL)
 if error: return result
 try:
  result['models']=fetch_models(endpoint['baseURL'], key)
  if not result['models']: result['error']='接口返回空模型列表，请检查渠道权限。'
 except ValueError as e: result['error']=str(e)
 except urllib.error.HTTPError as e:
  result['error']='模型接口返回重定向，已拒绝跟随；请所有者填写最终的 API 地址。' if 300<=e.code<400 else '模型接口返回 HTTP '+str(e.code)+'，请检查接口地址、Key 和渠道权限。'
 except ssl.SSLCertVerificationError: result['error']='模型接口 TLS 证书校验失败（证书不受信任或与域名不匹配）'
 except TimeoutError: result['error']='模型接口连接超时，可手动填写模型 ID 后保存。'
 except Exception: result['error']='模型接口连接失败或返回格式无效，请检查已保存的配置后重试。'
 return result

def mongo_eval(code):
 try:
  r=subprocess.run(['docker','exec',MONGO_CONTAINER,'mongosh','--quiet','LibreChat','--eval',code],capture_output=True,text=True,timeout=30)
  if r.returncode != 0: return None
  return r.stdout.strip()
 except: return None

def sync_librechat_users(c):
 raw=mongo_eval("JSON.stringify(db.users.find({}, {email:1,username:1,role:1,createdAt:1}).toArray())")
 try: rows=json.loads(raw.splitlines()[-1])
 except: rows=[]
 for u in rows:
  c.execute('insert into users(email,password,role,enabled,created,username) values(?,?,?,?,?,?) on conflict(email) do update set role=excluded.role,username=excluded.username',(u.get('email'), 'external:'+u.get('email',''), u.get('role','USER'), 1, int(time.time()), u.get('username','')))
 c.commit(); return rows

def librechat_accounts():
 raw=mongo_eval("JSON.stringify(db.users.find({}, {email:1,username:1,role:1,banned:1,createdAt:1,updatedAt:1,lastLoginAt:1,last_login:1}).toArray())")
 try: users=json.loads(raw.splitlines()[-1])
 except: users=[]
 # Count messages and conversations by the stored user identifier; no message text is returned.
 stats=mongo_eval("JSON.stringify({messages:db.messages.aggregate([{$group:{_id:'$user',count:{$sum:1},last:{$max:'$createdAt'},tokens:{$sum:{$ifNull:['$tokenCount',0]}}}}]).toArray(),conversations:db.conversations.aggregate([{$group:{_id:'$user',count:{$sum:1},last:{$max:'$updatedAt'}}}]).toArray()})")
 try: stats=json.loads(stats.splitlines()[-1])
 except: stats={'messages':[],'conversations':[]}
 bymsg={str(x.get('_id')):x for x in stats.get('messages',[]) if x.get('_id')}; byconv={str(x.get('_id')):x for x in stats.get('conversations',[]) if x.get('_id')}
 out=[]
 for u in users:
  uid=str(u.get('_id','')); m=bymsg.get(uid,{ }); cv=byconv.get(uid,{ }); last=u.get('lastLoginAt') or u.get('last_login') or m.get('last') or cv.get('last')
  out.append({'platform':'Jchat','id':uid,'email':u.get('email'),'username':u.get('username'),'role':u.get('role'),'status':'disabled' if u.get('banned') else 'active','createdAt':u.get('createdAt'),'lastLoginAt':last,'usage':{'messages':m.get('count',0),'conversations':cv.get('count',0),'tokens':m.get('tokens',0)}})
 return out

def vault_admin_details():
 vault=vault_admins(); ids={str(x) for x in vault.get('administratorIds',[]) } if isinstance(vault,dict) else set()
 users=sub2api_request('/api/v1/admin/users'); items=(users.get('data',{}).get('items',[]) if isinstance(users,dict) else [])
 out=[]
 for u in items:
  if str(u.get('id')) in ids: out.append({'id':u.get('id'),'email':u.get('email'),'username':u.get('username'),'role':u.get('role'),'status':u.get('status'),'last_active_at':u.get('last_active_at'),'permission':'已授权'})
 for uid in ids:
  if not any(str(x.get('id'))==uid for x in out): out.append({'id':uid,'permission':'已授权'})
 return {'administrators':out}

def unified_accounts():
 out=librechat_accounts(); users=sub2api_request('/api/v1/admin/users'); items=(users.get('data',{}).get('items',[]) if isinstance(users,dict) else [])
 for u in items:
  if not isinstance(u,dict): continue
  out.append({'platform':'JAPI','id':u.get('id'),'email':u.get('email'),'username':u.get('username'),'role':u.get('role'),'status':u.get('status'),'createdAt':u.get('created_at'),'lastLoginAt':u.get('last_active_at'),'usage':{'balance':u.get('balance'),'frozenBalance':u.get('frozen_balance'),'concurrency':u.get('concurrency')}})
 vault=vault_admins(); admin_ids={str(x) for x in vault.get('administratorIds',[]) } if isinstance(vault,dict) else set()
 for u in items:
  if str(u.get('id')) in admin_ids: out.append({'platform':'配置保险库','id':u.get('id'),'email':u.get('email'),'username':u.get('username'),'role':'vault-admin','status':u.get('status'),'createdAt':u.get('created_at'),'lastLoginAt':u.get('last_active_at'),'usage':{'permission':'team-admin'}})
 return out

def mongo_create(email,name,username,password):
 try:
  import bcrypt
  q=json.dumps(email); n=json.dumps(name); u=json.dumps(username); phash=json.dumps(bcrypt.hashpw(password.encode(),bcrypt.gensalt(rounds=10)).decode())
  code="const u=db.users.findOne({email:"+q+"});if(!u){db.users.insertOne({name:"+n+",username:"+u+",email:"+q+",emailVerified:true,password:"+phash+",provider:'local',role:'USER',plugins:[],createdAt:new Date(),updatedAt:new Date()})}"
  return mongo_eval(code) is not None
 except: return False

def mongo_password(email,password):
 import bcrypt
 q=json.dumps(email); pw=json.dumps(bcrypt.hashpw(password.encode(),bcrypt.gensalt(rounds=10)).decode())
 code="db.users.updateOne({email:"+q+"},{$set:{password:"+pw+",updatedAt:new Date()}})"
 return mongo_eval(code) is not None

def mongo_enabled(email,enabled):
 # LibreChat recognizes banned users; preserve the account while preventing login.
 q=json.dumps(email); value='false' if enabled else 'true'
 code="db.users.updateOne({email:"+q+"},{$set:{banned:"+value+",updatedAt:new Date()}})"
 return mongo_eval(code) is not None

def check_config_value(name, value):
 """Values written into librechat.env / librechat.yaml must stay on one line (no injected keys)."""
 if value is None or value=='': return
 if not isinstance(value,str) or any(ch in value for ch in '\r\n\0'): raise ValueError(name+' 不能包含换行或空字符')
 if name=='defaultModel' and any(ch in value for ch in '[],#'): raise ValueError('defaultModel 不能包含 [ ] , #')

class EndpointError(ValueError):
 def __init__(self, code, message, status=400):
  super().__init__(message); self.code=code; self.status=status

def model_error_message(code):
 if code=='model_probe_failed': return '该模型没有通过聊天测试，当前配置未更改。请核对模型 ID 和接口可用性。'
 if code=='invalid_fallback_model': return '请填写有效的兜底模型 ID。'
 if code=='fallback_matches_default': return '兜底模型必须与 Jchat 默认模型不同。'
 if code=='model_probe_timeout': return '聊天模型测试超时，当前配置未更改。请稍后再试。'
 messages={
  'yaml_malformed':'librechat.yaml 格式无效或含重复键，未作修改，请联系部署管理员',
  'managed_endpoint_ambiguous':'找到多个使用统一 Key 的接口，无法确定后台应管理哪一个',
  'legacy_endpoint_requires_maintenance':'现有接口使用内部网关或员工令牌，请联系部署管理员处理',
  'endpoint_name_conflict':'已有同名接口，请联系部署管理员处理',
  'first_setup_requires_default_model':'首次设置必须提供 API 地址和默认模型',
  'owner_required_first_setup':'首次设置需由所有者完成',
  'owner_required':'此操作需由所有者完成',
  'owner_required_for_endpoint_apply':'接口或 Key 有未生效的更改，需所有者应用',
  'invalid_api_key':'Key 只能包含字母、数字及 . _ ~ + / = : -，长度须为 8 至 512 个字符',
  'invalid_default_model':'请填写有效的默认模型 ID',
  'invalid_base_url':'API 地址无效或不符合允许的网络范围，请核对地址',
  'key_required':'尚未配置统一 Key',
  'key_binding_required':'接口与 Key 尚未绑定，请所有者重新保存接口',
  'key_required_for_new_origin':'请填写新服务商的 Key，或明确确认沿用现有 Key',
  'key_required_after_failed_save':'上次保存未完成，请重新填写 API Key 后保存',
  'endpoint_stale':'配置已被其他操作修改，请刷新后重试',
  'config_busy':'正在应用或保存配置，请稍后重试',
  'config_read_failed':'无法读取模型配置，请联系部署管理员检查文件权限',
  'config_file_unsafe':'模型配置文件权限或类型不符合要求，请联系部署管理员',
  'config_lock_unavailable':'配置应用服务尚未就绪，请联系部署管理员',
  'apply_unavailable':'配置应用服务暂时不可用，请稍后重新核对',
  'config_recovery_required':'配置恢复尚未完成，请联系部署管理员',
  'config_recovery_blocked':'配置恢复文件需要检查，请联系部署管理员',
  'save_config_failed_restored':'保存失败，已恢复原配置，版本未改变',
  'save_config_failed_pending':'保存失败且恢复未完成，请联系部署管理员',
  'env_duplicate_key':'服务器存在重复 Key 配置，未作修改，请联系部署管理员',
  'model_discovery_timeout':'模型接口连接超时，可手动填写模型 ID 后保存',
  'model_discovery_tls_failed':'模型接口 TLS 证书校验失败，请核对服务商地址和证书',
  'model_discovery_failed':'模型列表读取失败，可手动填写模型 ID 后保存',
  'discovery_rate_limited':'读取过于频繁，请等待 5 秒后重试',
  'rollback_unavailable':'没有可回退的已生效配置',
  'last_good_unavailable':'上次已生效配置的恢复文件不可用，请联系部署管理员',
 }
 if code in messages: return messages[code]
 if isinstance(code,str) and code.startswith('model_discovery_http_'):
  status=code.removeprefix('model_discovery_http_')
  if len(status)==3 and status.isdigit(): return '模型接口返回 HTTP '+status+'，请检查接口地址和 Key 权限'
 return code

_model_service=None

def model_service():
 global _model_service
 if _model_service is None:
  _model_service=model_config_service.Service(sys.modules[__name__])
 return _model_service

def save_model_config(c, data, actor):
 try: return model_service().save(c,data,actor)
 except model_config_service.ServiceError as e: raise EndpointError(e.code,model_error_message(e.code),e.status) from None

def provider_name(c):
 row=c.execute("select v from config where k='providerName'").fetchone()
 return row['v'] if row else (os.environ.get('MODEL_PROVIDER_NAME') or 'JAPI')

def save_display_settings(c, data, actor):
 if actor!=EMAIL: raise EndpointError('owner_required','owner_required',403)
 if not isinstance(data,dict) or set(data)!={'providerName'}:
  raise EndpointError('settings_fields_invalid','仅支持修改服务商显示名称')
 value=data['providerName']
 if not isinstance(value,str) or any(ord(ch)<32 or 127<=ord(ch)<=159 for ch in value):
  raise EndpointError('provider_name_invalid','服务商名称应为 1 至 40 个字符，且不能包含控制字符')
 value=value.strip()
 if not 1<=len(value)<=40:
  raise EndpointError('provider_name_invalid','服务商名称应为 1 至 40 个字符')
 c.execute('insert into config(k,v,updated) values(?,?,?) on conflict(k) do update set v=excluded.v,updated=excluded.updated',('providerName',value,int(time.time())))
 audit(c,'save_display_settings',json.dumps({'actor':actor,'field':'providerName'}))
 return {'ok':True,'providerName':value}

def provider_status(c):
 with _LC_FILES_LOCK:
  try: base=parse_model_url(current_base_url()).base
  except ValueError: base=''
  return {'name':provider_name(c),'baseURL':base,'keyConfigured':bool(raw_env('ZHITOUZHUAN_API_KEY').strip())}
def ph(p,s=None):
 s=s or secrets.token_hex(16); return s+':'+hashlib.scrypt(p.encode(),salt=bytes.fromhex(s),n=16384,r=8,p=1).hex()
def check(p,x):
 try:s,h=x.split(':'); return hmac.compare_digest(h,hashlib.scrypt(p.encode(),salt=bytes.fromhex(s),n=16384,r=8,p=1).hex())
 except:return False
def tok(e):
 payload=e+'|'+str(int(time.time()+86400))
 encoded=base64.urlsafe_b64encode(payload.encode()).decode().rstrip('=')
 return encoded+'.'+hmac.new(KEY.encode(),encoded.encode(),hashlib.sha256).hexdigest()
def who(t):
 # An empty or short ADMIN_SECRET would let anyone forge a session token.
 if len(KEY)<32: return None
 try:
  a,s=t.split('.'); e,u=base64.urlsafe_b64decode(a+'='*((4-len(a)%4)%4)).decode().split('|')
  return e if int(u)>time.time() and hmac.compare_digest(s,hmac.new(KEY.encode(),a.encode(),hashlib.sha256).hexdigest()) else None
 except:return None
def admin_email(c, email):
 """Canonical Jadmin administrator email for an SSO login, or None."""
 email=(email or '').strip().lower()
 if not email: return None
 if EMAIL and EMAIL.lower()==email: return EMAIL
 row=c.execute("select email from users where lower(email)=? and enabled=1 and upper(role)='ADMIN'",(email,)).fetchone()
 return row['email'] if row else None
def is_admin_actor(c, email):
 if not email: return False
 if email == EMAIL: return True
 row=c.execute('select role,enabled from users where email=?',(email,)).fetchone()
 return bool(row and row['enabled'] and str(row['role']).upper()=='ADMIN')
def mask(value):
 """Report presence without exposing any credential characters."""
 return '已配置' if isinstance(value,str) and value.strip() else ''
# /api/sso/start: per-IP limit on top of the global cap of 1000 pending states in enterprise.sso_start.
SSO_START_LIMIT=10; SSO_START_WINDOW=60
_sso_hits={}; _sso_lock=threading.Lock()
def sso_rate_ok(ip, now=None):
 now=now or time.time(); since=now-SSO_START_WINDOW
 with _sso_lock:
  if len(_sso_hits)>10000:
   for k in [k for k,v in _sso_hits.items() if not v or v[-1]<=since]: del _sso_hits[k]
  hits=[t for t in _sso_hits.get(ip,()) if t>since]
  ok=len(hits)<SSO_START_LIMIT
  if ok: hits.append(now)
  _sso_hits[ip]=hits
  return ok
SECURITY_HEADERS=[('X-Frame-Options','DENY'),('X-Content-Type-Options','nosniff'),('Referrer-Policy','no-referrer')]
CSP="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
class H(BaseHTTPRequestHandler):
 def end_headers(self):
  for k,v in SECURITY_HEADERS+[('Content-Security-Policy',CSP)]: self.send_header(k,v)
  super().end_headers()
 def client_ip(self):
  # Nginx appends the peer address, so the last X-Forwarded-For hop is the one it saw.
  hops=[h.strip() for h in self.headers.get('X-Forwarded-For','').split(',') if h.strip()]
  return hops[-1] if hops else self.client_address[0]
 def conn(self):
  """This request's sqlite connection, closed by close_db when the request ends."""
  if getattr(self,'_db',None) is None: self._db=db()
  return self._db
 def close_db(self):
  c=getattr(self,'_db',None); self._db=None
  if c is not None: c.close()
 def html(self,text,n=200,extra=()):
  self.send_response(n);self.send_header('Content-Type','text/html; charset=utf-8');self.send_header('Cache-Control','no-store')
  for k,v in extra: self.send_header(k,v)
  self.end_headers();self.wfile.write(text.encode())
 def out(self,x,n=200,extra=()):
  self.send_response(n);self.send_header('Content-Type','application/json');self.send_header('Cache-Control','no-store')
  for k,v in extra: self.send_header(k,v)
  self.end_headers();self.wfile.write(json.dumps(x).encode())
 def body(self): return json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))) or b'{}')
 def redirect(self,location,cookie=None):
  self.send_response(302);self.send_header('Location',location);self.send_header('Cache-Control','no-store')
  if cookie: self.send_header('Set-Cookie',cookie)
  self.end_headers()
 def enterprise_get(self,query):
  """Unauthenticated enterprise routes: SSO navigation and the os-bridge department feed."""
  from urllib.parse import quote, parse_qs
  if self.path=='/api/sso/status': return self.out({'enabled':enterprise.sso_enabled()})
  if self.path=='/api/internal/departments':
   if not enterprise.bridge_authorized(self.headers.get('X-Internal-Token')): return self.out({'error':'unauthorized'},401)
   c=self.conn(); return self.out(enterprise.bridge_payload(c))
  clear=enterprise.STATE_COOKIE+'=; Path=/api/sso; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
  if self.path=='/api/sso/start':
   if not sso_rate_ok(self.client_ip()):
    target='/#sso-error='+quote('登录请求过于频繁，请一分钟后再试')
    return self.html('<!doctype html><meta charset=utf-8><meta http-equiv=refresh content="3;url='+target+'"><title>Jadmin</title><p>登录请求过于频繁，请一分钟后再试。</p><p><a href="'+target+'">返回登录页</a></p>',429,[('Retry-After',str(SSO_START_WINDOW))])
   c=self.conn(); link=(parse_qs(query).get('link') or [None])[0]
   try: location,cookie=enterprise.sso_start(c,link=link)
   except enterprise.EnterpriseError as e: return self.redirect('/#sso-error='+quote(str(e)))
   return self.redirect(location,cookie)
  c=self.conn()
  try:
   result=enterprise.sso_finish(c,query,enterprise.cookie_state(self.headers.get('Cookie')),owner_checker=lambda actor: actor==EMAIL and is_admin_actor(c,actor),session_epoch=hashlib.sha256(KEY.encode()).hexdigest())
   if result.get('login_test'):
    return self.redirect('/#login-test-done='+quote(result['attemptId']),clear)
   actor=admin_email(c,result['email'])
   if not actor: audit(c,'sso_denied',result['email']); return self.redirect('/#sso-error='+quote('该企业账号关联的邮箱不是 Jadmin 管理员'),clear)
   if result['linked']:
    audit(c,'sso_link',actor); return self.redirect('/#sso-token='+quote(tok(actor))+'&sso-notice='+quote('已关联企业账号，以后可直接用企业账号登录'),clear)
   audit(c,'sso_login',actor); return self.redirect('/#sso-token='+quote(tok(actor)),clear)
  except enterprise.EnterpriseError as e:
   audit(c,'sso_denied',str(e)); return self.redirect('/#sso-error='+quote(str(e)),clear)
 def do_GET(self):
  try: return self.handle_get()
  finally: self.close_db()
 def do_POST(self):
  try: return self.handle_post()
  finally: self.close_db()
 def read_email_json(self,max_body=None):
   types=self.headers.get_all('Content-Type',[])
   if len(types)!=1 or types[0].lower().replace(' ','') not in ('application/json','application/json;charset=utf-8'):
    raise employee_email.EmailError('unsupported_media_type',415)
   lengths=self.headers.get_all('Content-Length',[])
   if self.headers.get_all('Transfer-Encoding') or self.headers.get_all('Content-Encoding') or len(lengths)!=1 or not lengths[0].isascii() or not lengths[0].isdigit():
    raise employee_email.EmailError('invalid_request',400)
   if len(lengths[0])>10: raise employee_email.EmailError('request_too_large',413)
   length=int(lengths[0])
   if length>(employee_email.MAX_BODY if max_body is None else max_body): raise employee_email.EmailError('request_too_large',413)
   if length<1: raise employee_email.EmailError('invalid_request',400)
   prior_timeout=self.connection.gettimeout()
   try:
    self.connection.settimeout(5)
    raw=self.rfile.read(length)
    if len(raw)!=length: raise ValueError('short body')
    return employee_email.strict_json(raw.decode('utf-8'))
   except (ValueError, OSError, RecursionError):
    raise employee_email.EmailError('invalid_request',400) from None
   finally: self.connection.settimeout(prior_timeout)
 def module_grants_request(self):
  from urllib.parse import urlsplit
  path=urlsplit(self.path).path
  internal=path.startswith('/api/internal/')
  actor=None; c=None
  def authorized():
   headers=self.headers.get_all('Authorization',[])
   current=who(headers[0][7:]) if len(headers)==1 and headers[0].startswith('Bearer ') else None
   return bool(current and current==actor and is_admin_actor(c,current))
  try:
   if internal:
    headers=self.headers.get_all('X-Internal-Token',[])
    if len(headers)!=1 or not enterprise.bridge_authorized(headers[0]): return self.out({'error':'unauthorized'},401)
   else:
    headers=self.headers.get_all('Authorization',[])
    actor=who(headers[0][7:]) if len(headers)==1 and headers[0].startswith('Bearer ') else None
    if not actor: return self.out({'error':'unauthorized'},401)
    c=self.conn()
    if not authorized(): return self.out({'error':'admin_required'},403)
   methods={
    '/api/admin/module-grants':('GET','POST'),
    '/api/admin/module-grants/backfill':('POST',),
    '/api/admin/module-grants/backfill/preview':('POST',),
    '/api/internal/module-grants':('GET',),
    '/api/internal/module-grants/check':('POST',),
   }
   if path not in methods or self.path!=path: return self.out({'error':'invalid_request'},400)
   if self.command not in methods[path]: return self.out({'error':'method_not_allowed'},405,extra=[('Allow',', '.join(methods[path]))])
   if '/backfill' in path and actor!=EMAIL: return self.out({'error':'owner_required'},403)
   organization=os.environ.get('CASDOOR_ORG','')
   if not employee_email.valid_id(organization): return self.out({'error':'organization_unconfigured'},503)
   data=self.read_email_json(module_grants.MAX_BODY) if self.command=='POST' else None
   c=c or self.conn()
   module_grants.init_db(c)
   if internal:
    result=(module_grants.feed(c,organization) if self.command=='GET'
            else module_grants.observe(c,organization,data))
   else:
    try: users=enterprise.casdoor_users()
    except enterprise.EnterpriseError: return self.out({'error':'directory_unavailable'},503)
    if self.command=='GET':
     result=module_grants.listing(c,organization,users); result['canBackfill']=actor==EMAIL
    elif '/backfill' in path:
     result=module_grants.backfill(c,organization,data,actor,users,
       lambda: authorized() and actor==EMAIL,preview=path.endswith('/preview'))
    else: result=module_grants.save(c,organization,data,actor,users,authorized)
   return self.out(result)
  except (module_grants.GrantError,employee_email.EmailError) as error:
   return self.out({'error':error.code,'code':error.code},error.status)
  except sqlite3.Error: return self.out({'error':'grants_unavailable'},503)
  finally: self.close_connection=True
 def internal_email_confirmation(self):
  try:
   headers=self.headers.get_all('X-Internal-Token',[])
   if len(headers)!=1 or not enterprise.bridge_authorized(headers[0]): return self.out({'error':'unauthorized'},401)
   if self.path!='/api/internal/employee-email-confirmation': return self.out({'error':'invalid_request'},400)
   confirmed=email_confirmation.lookup(self.conn(),self.read_email_json())
   return self.out({'confirmed':confirmed})
  except employee_email.EmailError as error: return self.out({'error':error.code},error.status)
  except sqlite3.Error: return self.out({'error':'confirmation_unavailable'},503)
  finally: self.close_connection=True
 def email_completion_request(self):
  c=self.conn(); actor=None; employee_id=None
  def authorized():
   headers=self.headers.get_all('Authorization',[])
   current=who(headers[0][7:]) if len(headers)==1 and headers[0].startswith('Bearer ') else None
   return bool(current and current==actor and is_admin_actor(c,current))
  try:
   headers=self.headers.get_all('Authorization',[])
   actor=who(headers[0][7:]) if len(headers)==1 and headers[0].startswith('Bearer ') else None
   if not actor: raise employee_email.EmailError('unauthorized',401)
   if not authorized(): raise employee_email.EmailError('admin_required',403)
   if self.command!='POST': raise employee_email.EmailError('method_not_allowed',405)
   if self.path!='/api/admin/directory/email': raise employee_email.EmailError('invalid_request',400)
   body=self.read_email_json()
   existing=isinstance(body,dict) and body.get('confirmExisting') is True
   if existing: body.pop('confirmExisting')
   employee_id,email=employee_email.validate_body(body)
   audit(c,'employee_email',json.dumps({'actor':actor,'employeeId':employee_id,'outcome':'attempt'}))
   if existing:
    email_confirmation.record(c,employee_id,email,actor,authorized)
    return self.out({'employeeId':employee_id,'email':email,'workEmailConfirmed':True})
   confirmation='pending'
   def confirm(binding):
    nonlocal confirmation
    if not email_confirmation.valid_binding(binding):
     confirmation='not_applicable'
     return
    try:
     email_confirmation.record(c,employee_id,email,actor,authorized,expected_binding=binding)
     confirmation='confirmed'
    except (employee_email.EmailError,sqlite3.Error): pass
   result=employee_email.complete_email(body,authorized=authorized,after_write=confirm)
   try: audit(c,'employee_email',json.dumps({'actor':actor,'employeeId':employee_id,'outcome':'updated'}))
   except sqlite3.Error: raise employee_email.EmailError('write_outcome_unknown',503) from None
   result['workEmailConfirmation']=confirmation
   return self.out(result)
  except employee_email.EmailError as error:
   try: audit(c,'employee_email',json.dumps({'actor':actor,'employeeId':employee_id,'outcome':error.code}))
   except sqlite3.Error: pass
   return self.out({'error':error.code,'code':error.code},error.status,extra=[('Allow','POST')] if error.status==405 else ())
  except sqlite3.Error:
   return self.out({'error':'audit_unavailable','code':'audit_unavailable'},503)
  finally: self.close_connection=True
 def email_unsupported_method(self):
  from urllib.parse import urlsplit
  try:
   if api_usage_admin.matches(self.path): return api_usage_admin.handle(self,sys.modules[__name__])
   if media_http.matches(self.path): return media_http.handle(self,sys.modules[__name__])
   if work_http.matches(self.path): return work_http.handle(self,sys.modules[__name__])
   if mail_http.matches(self.path): return mail_http.handle(self,sys.modules[__name__])
   if urlsplit(self.path).path.startswith(('/api/admin/module-grants','/api/internal/module-grants')): return self.module_grants_request()
   if urlsplit(self.path).path=='/api/admin/directory/email': return self.email_completion_request()
   return self.send_error(501, "Unsupported method (%r)" % self.command)
  finally: self.close_db()
 do_PUT=email_unsupported_method
 do_DELETE=email_unsupported_method
 do_OPTIONS=email_unsupported_method
 do_HEAD=email_unsupported_method
 def handle_get(self):
  from urllib.parse import urlsplit
  if api_usage_admin.matches(self.path): return api_usage_admin.handle(self,sys.modules[__name__])
  if media_http.matches(self.path): return media_http.handle(self,sys.modules[__name__])
  if work_http.matches(self.path): return work_http.handle(self,sys.modules[__name__])
  if mail_http.matches(self.path): return mail_http.handle(self,sys.modules[__name__])
  if urlsplit(self.path).path.startswith(('/api/admin/module-grants','/api/internal/module-grants')): return self.module_grants_request()
  if urlsplit(self.path).path=='/api/admin/directory/email': return self.email_completion_request()
  query=urlsplit(self.path).query; self.path=urlsplit(self.path).path
  if self.path in ('/api/sso/status','/api/sso/start','/api/sso/callback','/api/internal/departments'): return self.enterprise_get(query)
  if self.path=='/': return self.html(HTML)
  c=self.conn()
  actor=who(self.headers.get('Authorization','').replace('Bearer ',''))
  if not actor:return self.out({'error':'unauthorized'},401)
  if not is_admin_actor(c,actor):return self.out({'error':'administrator_required'},403)
  if self.path=='/api/admin/runtime-models':
   return self.out(_runtime_models.summary(c))
  if self.path.startswith('/api/admin/runtime-models/jobs/'):
   job_id=self.path.rsplit('/',1)[-1]
   if not valid(IDENTIFIER,job_id): return self.out({'code':'job_missing'},404)
   try: return self.out(_runtime_models.job_status(job_id,actor))
   except ModelError as e: return self.out(e.public(),e.status)
  if self.path=='/api/admin/setup':
   if actor!=EMAIL:return self.out({'error':'owner_required'},403)
   return self.out(setup_wizard.status())
  if self.path=='/api/admin/credentials':
   if actor!=EMAIL: return self.out({'error':'administrator_required'},403)
   keys=sub2api_request('/api/v1/keys')
   for item in (keys.get('data',{}).get('items',[]) if isinstance(keys,dict) and isinstance(keys.get('data'),dict) else []):
    if isinstance(item,dict) and 'key' in item: item['keyMasked']=mask(item.pop('key'))
   audit(c,'view_credentials',actor)
   return self.out({'librechatApiKey':mask(raw_env('ZHITOUZHUAN_API_KEY')),'keys':keys,'adminLogin':{'email':EMAIL,'passwordConfigured':bool(PASS)},'passwordNote':'已设置' if PASS else '未设置'})
  if self.path in ('/api/admin/login-im','/api/admin/login-config') or self.path.startswith('/api/admin/login-config/test-signin/'):
   try:
    if self.path.startswith('/api/admin/login-config/test-signin/'):
     if actor!=EMAIL:return self.out({'error':'owner_required','code':'owner_required'},403)
     return self.out(login_config.test_status(c,self.path.rsplit('/',1)[1],actor))
    result=login_config.summary(c,actor=actor);result['owner']=actor==EMAIL
    return self.out(result)
   except enterprise.EnterpriseError as e:return self.login_config_error(e)
  if self.path=='/api/admin/sso/links':
   own=enterprise.list_bindings(c,actor)
   return self.out({'enabled':enterprise.sso_enabled(),'self':own[0] if own else None,'owner':actor==EMAIL,'bindings':enterprise.list_bindings(c) if actor==EMAIL else own})
  if self.path in ('/api/model-status','/api/admin/model-status'):return self.out(model_status(actor))
  if self.path=='/api/admin/model-config/apply-status':
   try: return self.out(model_service().apply_status(c,actor))
   except model_config_service.ServiceError as e: return self.out({'error':model_error_message(e.code),'code':e.code},e.status)
  if self.path in ('/api/modules','/api/admin/modules'):return self.out({'modules':module_status()})
  if self.path=='/api/users':return self.out({'users':[dict(x) for x in c.execute('select id,email,role,enabled,created from users')]})
  if self.path=='/api/config':return self.out({'config':public_config(c),'current':{**current_config(),'librechatBaseURL':display_base_url()},'canEditEndpoint':actor==EMAIL,'models':models()})
  if self.path in ('/api/health','/api/admin/services'):
   modules=module_status(); return self.out({'librechat':modules['librechat']['status']=='healthy','sub2api':modules['sub2api']['status']=='healthy','image':modules['image']['status']=='healthy','configVault':modules['configVault']['status']=='reachable','providerRelay':modules['providerRelay']['status']=='reachable','admin':True,'nginx':health('http://127.0.0.1:80')})
  if self.path in ('/api/admin/accounts','/api/accounts'): return self.out({'accounts':unified_accounts()})
  if self.path in ('/api/admin/sub2api','/api/sub2api'):
   users=sub2api_request('/api/v1/admin/users'); keys=sub2api_request('/api/v1/keys'); usage=sub2api_request('/api/v1/admin/usage'); me=sub2api_request('/api/v1/auth/me')
   for item in (keys.get('data',{}).get('items',[]) if isinstance(keys,dict) else []):
    if isinstance(item,dict) and 'key' in item: item['keyMasked']=mask(item.pop('key'))
   return self.out({'users':users,'keys':keys,'usage':usage,'account':me})
  if self.path in ('/api/admin/config-vault','/api/config-vault'): return self.out(vault_admin_details())
  if self.path=='/api/admin/departments': return self.out({'departments':enterprise.list_departments(c),'assignments':enterprise.list_assignments(c),'sso':enterprise.sso_enabled()})
  if self.path=='/api/admin/directory':
   try: return self.out(enterprise.directory_report(c))
   except enterprise.EnterpriseError as e: return self.out({'error':str(e)},e.status)
  if self.path in ('/api/audit','/api/admin/audit'):return self.out({'audit':[dict(x) for x in c.execute('select action,detail,at from audit order by id desc limit 100')]})
  if self.path in ('/api/metrics','/api/admin/metrics'):
   rows=[dict(x) for x in c.execute('select at,cpu,memory,disk,containers from metrics order by at desc limit 1440')];return self.out({'current':system_metrics(),'history':rows})
  if self.path in ('/api/admin/users','/api/admin/models','/api/admin/config','/api/admin/providers'):
   if self.path.endswith('/users'): return self.out({'users':[dict(x) for x in c.execute('select id,email,role,enabled,created,username from users')]})
   if self.path.endswith('/models'): return self.out({'models':models()})
   if self.path.endswith('/providers'): return self.out({'providers':[provider_status(c)]})
   return self.out({'config':current_config(),'current':{**current_config(),'librechatBaseURL':display_base_url()},'canEditEndpoint':actor==EMAIL,'models':models()})
  self.out({'error':'not_found'},404)
 def do_PATCH(self):
  return self.do_POST()
 def login_config_error(self,error):
  import re
  code=str(error.data.get('code') or 'login_config_failed')
  if not re.fullmatch(r'[a-z][a-z0-9_]{0,79}',code):code='login_config_failed'
  result={'error':'登录配置操作未完成（'+code+'）','code':code}
  continuity=error.data.get('continuity')
  if code=='needs_confirmation' and isinstance(continuity,dict):
   result['continuity']={k:v for k,v in continuity.items() if k in ('at','total','alreadyLinked','possibleMatch','noBasis') and isinstance(v,int) and not isinstance(v,bool) and v>=0}
  return self.out(result,error.status)
 def login_config_post(self,c,actor,data):
  # Every mutation, including the old alias and PATCH, has the same owner boundary.
  if actor!=EMAIL:return self.out({'error':'owner_required','code':'owner_required'},403)
  suffix=self.path.removeprefix('/api/admin/login-config')
  actions={'/revisions':'save_revision','/stage':'stage','/stage/cancel':'cancel_stage','/test-signin':'start_test','/activate':'activate','/activate/finish':'finish','/cleanup/retry':'retry_cleanup','/restore':'restore','/detach':'detach','/reconcile':'reconcile','/signup/pause':'signup_pause','/signup/resume':'signup_resume'}
  action=actions.get(suffix)
  if suffix=='/revisions/clear-unused':action='clear_unused'
  if suffix.startswith('/revisions/') and suffix.endswith('/test-credentials'):
   revision=suffix[len('/revisions/'):-len('/test-credentials')]
   if not revision or '/' in revision:return self.out({'error':'not_found'},404)
   data=dict(data,revisionId=revision);action='test_credentials'
  if self.path=='/api/admin/login-im':
   # Selection, activation gates and operation auditing share the core boundary.
   action='legacy_activate'
  if not action:return self.out({'error':'not_found'},404)
  try:
   bearer=self.headers.get('Authorization','').removeprefix('Bearer ')
   encoded=bearer.split('.',1)[0]
   session_exp=int(base64.urlsafe_b64decode(encoded+'='*((4-len(encoded)%4)%4)).decode().rsplit('|',1)[1])
   result=login_config.dispatch(c,action,data,actor,session_exp=session_exp,session_epoch=hashlib.sha256(KEY.encode()).hexdigest())
   result=dict(result);cookie=result.pop('cookie',None)
   # Audit only stable identifiers. No form fields, upstream responses, URLs or cookies.
   detail={'actor':actor,'action':action,'status':result.get('status','completed')}
   for field in ('revisionId','operationId'):
    value=result.get(field)
    if isinstance(value,(int,str)) and len(str(value))<=128:detail[field]=value
   audit(c,'login_config',json.dumps(detail,ensure_ascii=False))
   return self.out(result,extra=[('Set-Cookie',cookie)] if cookie else ())
  except enterprise.EnterpriseError as e:return self.login_config_error(e)
 def handle_post(self):
  from urllib.parse import urlsplit
  if api_usage_admin.matches(self.path): return api_usage_admin.handle(self,sys.modules[__name__])
  if media_http.matches(self.path): return media_http.handle(self,sys.modules[__name__])
  if work_http.matches(self.path): return work_http.handle(self,sys.modules[__name__])
  if mail_http.matches(self.path): return mail_http.handle(self,sys.modules[__name__])
  if urlsplit(self.path).path.startswith(('/api/admin/module-grants','/api/internal/module-grants')): return self.module_grants_request()
  if urlsplit(self.path).path=='/api/admin/directory/email': return self.email_completion_request()
  if urlsplit(self.path).path=='/api/internal/employee-email-confirmation': return self.internal_email_confirmation()
  self.path=urlsplit(self.path).path
  if self.path.startswith('/api/admin/runtime-models/'):
   headers=self.headers.get_all('Authorization',[])
   actor=who(headers[0][7:]) if len(headers)==1 and headers[0].startswith('Bearer ') else None
   if not actor: return self.out({'code':'unauthorized'},401)
   c=self.conn()
   if not is_admin_actor(c,actor): return self.out({'code':'administrator_required'},403)
   parts=self.path.split('/')
   if len(parts)!=6: return self.out({'code':'invalid_request'},400)
   sizes=self.headers.get_all('Content-Length',[])
   if len(sizes)!=1 or self.headers.get('Transfer-Encoding') or not sizes[0].isascii() or not sizes[0].isdecimal() or len(sizes[0])>4 or not 1<=int(sizes[0])<=4096:
    self.close_connection=True
    return self.out({'code':'invalid_request'},400)
   try: data=self.body()
   except (ValueError,UnicodeError): return self.out({'code':'invalid_request'},400)
   try: return self.out(_runtime_models.start(c,parts[-2],parts[-1],data,actor),202)
   except ModelError as e: return self.out(e.public(),e.status)
  if self.path.startswith('/api/admin/users'):
   self.path=self.path.replace('/api/admin','/api',1)
  elif self.path=='/api/admin/config':
   self.path='/api/config'
  d=self.body();c=self.conn()
  if self.path=='/api/login':
   ok=bool(EMAIL and PASS and d.get('email')==EMAIL and hmac.compare_digest(d.get('password',''),PASS))
   if not ok:
    r=c.execute('select * from users where email=? and enabled=1',(d.get('email',''),)).fetchone();ok=bool(r and check(d.get('password',''),r['password']) and str(r['role']).upper()=='ADMIN')
   return self.out({'token':tok(d.get('email'))} if ok else {'error':'invalid_credentials'},200 if ok else 401)
  actor=who(self.headers.get('Authorization','').replace('Bearer ',''))
  if not actor:return self.out({'error':'unauthorized'},401)
  if not is_admin_actor(c,actor):return self.out({'error':'administrator_required'},403)
  if self.path=='/api/admin/login-im' or self.path.startswith('/api/admin/login-config/'):
   return self.login_config_post(c,actor,d)
  if self.path=='/api/admin/setup':
   if actor!=EMAIL:return self.out({'error':'owner_required'},403)
   result,code=setup_wizard.start(d.get('stage'));return self.out(result,code)
  if self.path in ('/api/users','/api/admin/users'):
   if not d.get('email') or '@' not in d['email']: return self.out({'error':'valid_email_required'},400)
   pw=d.get('password') or secrets.token_urlsafe(14)
   try:
    c.execute('insert into users(email,password,role,created,username) values(?,?,?,?,?)',(d['email'],ph(pw),d.get('role','USER'),int(time.time()),d['email'].split('@')[0])); audit(c,'create_user',d['email'])
    if not mongo_create(d['email'],d.get('name',d['email'].split('@')[0]),d.get('username',d['email'].split('@')[0]),pw):
     c.rollback(); return self.out({'error':'librechat_account_creation_failed'},502)
   except sqlite3.IntegrityError:return self.out({'error':'user_exists'},409)
   return self.out({'email':d['email'],'temporaryPassword':pw})
  if self.path=='/api/users/disable':
   c.execute('update users set enabled=0 where id=?',(d.get('id'),)); row=c.execute('select email from users where id=?',(d.get('id'),)).fetchone()
   if row and not mongo_enabled(row['email'],False): c.rollback(); return self.out({'error':'librechat_account_update_failed'},502)
   audit(c,'disable_user',str(d.get('id')));return self.out({'ok':True})
  if self.path=='/api/users/enable':
   c.execute('update users set enabled=1 where id=?',(d.get('id'),)); row=c.execute('select email from users where id=?',(d.get('id'),)).fetchone()
   if row and not mongo_enabled(row['email'],True): c.rollback(); return self.out({'error':'librechat_account_update_failed'},502)
   audit(c,'enable_user',str(d.get('id')));return self.out({'ok':True})
  if self.path=='/api/users/reset-password':
   pw=d.get('password') or secrets.token_urlsafe(14);c.execute('update users set password=? where id=?',(ph(pw),d.get('id')));row=c.execute('select email from users where id=?',(d.get('id'),)).fetchone()
   if row and not mongo_password(row['email'],pw): c.rollback(); return self.out({'error':'librechat_password_update_failed'},502)
   audit(c,'reset_password',str(d.get('id')));return self.out({'temporaryPassword':pw})
  if self.path in ('/api/admin/sub2api/users','/api/sub2api/users'):
   if not d.get('email') or not d.get('password'): return self.out({'error':'email_and_password_required'},400)
   result=sub2api_request('/api/v1/admin/users','POST',{'email':d.get('email'),'password':d.get('password'),'username':d.get('username',''),'role':d.get('role','user')})
   audit(c,'sub2api_create_user',d.get('email')); return self.out(result, 200 if 'error' not in result else 400)
  if self.path in ('/api/admin/config-vault/grant','/api/config-vault/grant','/api/admin/config-vault/revoke','/api/config-vault/revoke'):
   action='grant' if self.path.endswith('grant') else 'revoke'; uid=d.get('userId')
   if not str(uid).isdigit(): return self.out({'error':'userId_required'},400)
   vault_admins(action,uid); audit(c,'vault_admin_'+action,str(uid)); return self.out(vault_admin_details())
  if self.path in ('/api/admin/departments','/api/admin/departments/delete','/api/admin/assignments'):
   try:
    if self.path.endswith('/delete'): enterprise.delete_department(c,str(d.get('code',''))); audit(c,'department_delete',str(d.get('code','')))
    elif self.path.endswith('/assignments'): r=enterprise.set_assignment(c,d.get('email'),d.get('code'),d.get('note','')); audit(c,'department_assign',json.dumps({'email':str(d.get('email','')).lower(),'code':d.get('code') or None},ensure_ascii=False))
    else: r=enterprise.save_department(c,d); audit(c,'department_save',json.dumps(r,ensure_ascii=False))
   except enterprise.EnterpriseError as e: return self.out({'error':str(e)},e.status)
   return self.out({'departments':enterprise.list_departments(c),'assignments':enterprise.list_assignments(c)})
  if self.path=='/api/admin/sso/link':
   if not enterprise.sso_enabled(): return self.out({'error':'未启用企业登录'},404)
   email=(admin_email(c,actor) or actor).lower()
   try: link=enterprise.create_link(c,email)
   except enterprise.EnterpriseError as e: return self.out({'error':str(e)},e.status)
   audit(c,'sso_link_start',email); return self.out({'url':'/api/sso/start?link='+link,'expiresIn':enterprise.LINK_SECONDS})
  if self.path=='/api/admin/sso/unlink':
   target=str(d.get('email') or actor).strip().lower()
   if target!=actor.lower() and actor!=EMAIL: return self.out({'error':'owner_required'},403)
   removed=enterprise.unlink(c,target); audit(c,'sso_unlink',json.dumps({'actor':actor,'email':target},ensure_ascii=False))
   if not removed: return self.out({'error':'没有这条关联'},404)
   return self.out({'ok':True,'bindings':enterprise.list_bindings(c) if actor==EMAIL else enterprise.list_bindings(c,actor)})
  if self.path=='/api/admin/settings':
   try: return self.out(save_display_settings(c,d,actor))
   except EndpointError as e: return self.out({'error':str(e),'code':e.code},e.status)
  if self.path in ('/api/admin/model-config/discover','/api/admin/model-config/apply','/api/admin/model-config/verify','/api/admin/model-config/rollback'):
   try:
    action=self.path.rsplit('/',1)[1]
    if action=='discover': result=model_service().discover(c,d,actor)
    elif action=='rollback': result=model_service().rollback(c,d,actor)
    else: result=model_service().apply(c,d,actor,op=action)
    return self.out(result,200 if action=='discover' else 202)
   except (EndpointError,model_config_service.ServiceError) as e: return self.out({'error':model_error_message(e.code),'code':e.code},e.status)
  if self.path=='/api/config':
   try:
    result=save_model_config(c,d,actor)
   except EndpointError as e: return self.out({'error':str(e),'code':e.code},e.status)
   except ValueError as e: return self.out({'error':str(e)},400)
   return self.out(result)
  self.out({'error':'not_found'},404)
HTML=r"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Jadmin · 企业工作台</title>
<style>
:root{color-scheme:light;--ink:#172b3a;--muted:#5c6e7c;--line:#dce5eb;--surface:#fff;--canvas:#f4f7f9;--accent:#14766d;--accent-dark:#0e5d56;--danger:#b6333b;--radius:12px}
*{box-sizing:border-box}body{margin:0;font:15px/1.6 "Segoe UI","Microsoft YaHei",system-ui,sans-serif;color:var(--ink);background:var(--canvas)}[hidden]{display:none!important}button,input,select,textarea{font:inherit}button,a,input,select,textarea,summary{outline-offset:4px}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid #63b7ac}button{border:1px solid transparent;border-radius:8px;padding:9px 15px;background:var(--accent);color:white;cursor:pointer;min-height:42px}button:hover{background:var(--accent-dark)}button:disabled{opacity:.5;cursor:not-allowed}a{color:var(--accent);text-underline-offset:3px}input,select,textarea{padding:10px 12px;border:1px solid #bdcdd6;border-radius:8px;background:white;color:var(--ink);max-width:100%;min-width:0}input:not([type=checkbox]),select,textarea{min-height:44px}input[type=checkbox]{accent-color:var(--accent)}textarea{min-height:110px;resize:vertical}.field{display:flex;flex-direction:column;gap:6px;margin:14px 0;font-weight:600}.field input,.field select,.field textarea{font-weight:400}.field .button-secondary{align-self:flex-start}.button-secondary{background:white;color:var(--ink);border-color:#c9d6dd}.button-secondary:hover{background:#edf4f5}.danger{background:var(--danger)}.danger:hover{background:#902b32}.muted{color:var(--muted)}.ok{color:#17694b}.bad{color:#a82732}.chip{display:inline-flex;border-radius:99px;padding:3px 10px;font-size:12px;background:#e6f4ee;color:#17694b}.chip.warn{background:#fff1d9;color:#895709}.chip.bad{background:#fbe8ea;color:#a82732}.chip.neutral{background:#edf1f5;color:#5c6e7c}.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:24px;margin:0 0 20px;min-width:0;box-shadow:0 3px 10px #17314203}.card h2{font-size:19px;line-height:1.4;margin:0 0 15px}.card h3{font-size:16px;margin:24px 0 10px}p{margin:8px 0 14px}h1{margin:0;font-size:25px;letter-spacing:-.5px}.eyebrow{font-size:12px;letter-spacing:2px;color:var(--accent);font-weight:700}.stack{display:flex;flex-direction:column;gap:12px}.actions,.dialog-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}.card button{margin:3px}.grid-two{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}.grid-two .card{margin-bottom:0}.overview-wide{grid-column:1/-1}.empty-state{padding:24px;border:1px dashed #cbd8df;border-radius:8px;color:var(--muted);background:#fafcfd}.error-banner{padding:14px 17px;border:1px solid #ecc7cb;border-radius:8px;background:#fff4f5;color:#912a34;margin:12px 0}.error-banner p{margin:0 0 8px}.notice{padding:12px 16px;background:#eaf5f2;border-radius:8px;color:#155a50;margin:12px 0}.skeleton{padding:16px;color:var(--muted);border-radius:8px;background:#edf2f5}.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;margin:14px 0;font-size:14px}th,td{text-align:left;padding:12px 10px;border-bottom:1px solid #e6edf1;vertical-align:top;overflow-wrap:anywhere}th{font-size:12px;color:var(--muted);font-weight:600;background:#f8fafb}td button{font-size:13px;padding:7px 10px;min-height:36px}details{margin:10px 0}summary{cursor:pointer;color:var(--muted)}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f6f8;padding:14px;border-radius:8px;font-size:12px}progress,meter{width:100%;accent-color:var(--accent)}.skip-link{position:fixed;left:20px;top:-70px;background:white;padding:12px;z-index:100}.skip-link:focus{top:12px}.login-layout{max-width:440px;margin:8vh auto;padding:24px}.login-brand{margin:0 0 28px}.login-brand h1{font-size:32px}.login-card{padding:30px}.login-card button[type=submit]{width:100%;margin-top:14px}.login-card h2{font-size:22px}.login-footnote{font-size:12px;text-align:center;color:var(--muted)}
.topbar{height:74px;padding:0 30px;display:flex;align-items:center;justify-content:space-between;background:#fff;border-bottom:1px solid var(--line);grid-column:1/-1;position:sticky;top:0;z-index:20}.brand{font-weight:750;font-size:22px;letter-spacing:-.6px}.brand small{font-size:11px;font-weight:500;color:var(--muted);margin-left:12px;letter-spacing:1px}.session-tools{display:flex;align-items:center;gap:12px}.session-email{font-size:13px;color:var(--muted);max-width:250px;overflow:hidden;text-overflow:ellipsis}.app-shell{display:grid;grid-template-columns:220px minmax(0,1fr);min-height:100vh;grid-template-rows:74px 1fr}.sidebar{background:#fff;border-right:1px solid var(--line);padding:25px 14px;position:sticky;top:74px;height:calc(100vh - 74px);overflow:auto}.nav-group{font-size:11px;color:#718390;padding:22px 14px 7px;letter-spacing:1px}.sidebar a{display:block;text-decoration:none;color:#4c6271;padding:11px 14px;border-radius:8px;margin:3px 0;font-size:14px}.sidebar a:hover{background:#f1f7f7}.sidebar a[aria-current=page]{color:#0e655c;background:#e8f3f0;font-weight:650}.sidebar-note{font-size:11px;color:var(--muted);margin:30px 14px}.main-content{width:100%;max-width:1160px;margin:0 auto;padding:30px}.page-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:22px}.page-heading h1{font-size:25px}.page-heading p{font-size:13px;color:var(--muted);margin-bottom:0}.page{min-width:0}.freshness{font-size:12px;color:var(--muted);margin:0 0 15px}.menu-button,.drawer-scrim{display:none}.admin-dialog{border:1px solid var(--line);border-radius:15px;max-width:540px;width:calc(100% - 32px);max-height:90vh;padding:26px;box-shadow:0 24px 80px #172c3d36}.admin-dialog::backdrop{background:#102a3c70}.admin-dialog h2{font-size:21px;margin-top:0}.admin-dialog input:not([type=checkbox]),.admin-dialog textarea{width:100%}.dialog-actions{justify-content:flex-end}.onboarding-grid{display:grid;grid-template-columns:220px minmax(0,1fr);gap:20px}.step-list{list-style:none;padding:0}.step-list button{width:100%;text-align:left}.tab-list{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px}.tab-list [aria-selected=true]{background:var(--accent);color:white}.helper{font-size:13px;color:var(--muted)}.unsupported{font-size:12px;color:#6a7783;padding-top:14px;border-top:1px solid var(--line)}
@media(max-width:959px){.app-shell{display:block}.topbar{height:64px;padding:0 16px}.brand small,.session-email{display:none}.menu-button{display:inline-flex;min-width:42px;justify-content:center;background:white;color:var(--ink);font-size:20px}.topbar-brand{display:flex;align-items:center;gap:10px}.session-tools{gap:7px}.session-tools button{padding:7px 10px;min-height:38px}.sidebar{position:fixed;left:0;top:64px;bottom:0;width:260px;height:auto;transform:translateX(-101%);transition:transform .15s;z-index:40;box-shadow:14px 0 40px #17314220}.app-shell.drawer-open .sidebar{transform:translateX(0)}.drawer-scrim{position:fixed;inset:64px 0 0;border:0;border-radius:0;background:#16334566;z-index:30;width:100%;height:calc(100vh - 64px)}.drawer-open .drawer-scrim{display:block}.main-content{padding:22px 16px}.card{padding:19px}.grid-two,.onboarding-grid{grid-template-columns:1fr}.page-heading h1{font-size:22px}.page-heading button{padding:8px 13px}.card table{display:block;max-width:100%;overflow-x:auto}.card table thead{display:none}.card table tbody{display:block;width:100%}.card table tr{display:block;border:1px solid var(--line);border-radius:9px;margin:11px 0;padding:10px}.card table td{display:block;border:0;padding:6px 0;min-width:0}.card table td[data-label]::before{content:attr(data-label) "：";display:inline-block;min-width:85px;font-weight:600;color:var(--muted);font-size:12px}.card input,.card select{max-width:100%}.login-layout{margin:4vh auto;padding:16px}.login-card{padding:24px}.admin-dialog{padding:22px}.sidebar-note{margin-top:22px}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
.login-platforms{display:flex;gap:16px;flex-wrap:wrap;margin:16px 0;padding:12px;border:1px solid var(--line);border-radius:8px}.login-platform-choice,.login-checkbox{display:inline-flex;gap:8px;align-items:center;min-height:44px}.login-platform-choice input[type=radio],.login-checkbox input[type=checkbox]{margin:0;padding:0;min-height:0;width:18px;height:18px;accent-color:var(--accent)}.login-platform-choice span{white-space:nowrap}.login-setup-guide{margin-top:24px;border-top:1px solid var(--line);padding-top:8px}.login-setup-guide code{overflow-wrap:anywhere}.login-setup-guide button{max-width:100%}
.page-heading>button{flex-shrink:0;white-space:nowrap}
.model-checkbox{display:flex;align-items:flex-start;gap:8px;min-height:44px;margin:10px 0;font-weight:400}.model-checkbox input[type=checkbox]{flex:0 0 18px;width:18px;height:18px;min-height:0;margin:4px 0;padding:0;accent-color:var(--accent)}.model-checkbox span{min-width:0;overflow-wrap:anywhere}.model-discovery-controls{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.model-discovery-controls .model-checkbox{margin:0}.model-discovery-controls .model-checkbox span{white-space:nowrap}.model-discovery-controls>input[type=text]{flex:1 1 100%;width:100%}
/* JADMIN12: all login presentation is scoped away from the authenticated shell. */
#loginbox{position:relative;isolation:isolate;max-width:none;min-height:100svh;margin:0;padding:0 40px 56px;overflow:hidden;background:linear-gradient(118deg,#edf5ff 0%,#f6f7ff 65%,#f1effb 100%);color:#24324a}
#loginbox,#loginbox *{letter-spacing:0}
#loginbox::before{content:'';position:absolute;inset:0;z-index:-1;pointer-events:none;background-image:linear-gradient(#b8cbe72b 1px,transparent 1px),linear-gradient(90deg,#b8cbe72b 1px,transparent 1px);background-size:72px 72px;mask-image:linear-gradient(transparent,#000);opacity:.65}
#loginbox .login-masthead{height:104px;max-width:1240px;margin:auto;display:flex;align-items:center;gap:14px}
#loginbox .login-logo{width:34px;height:34px;flex:none;color:#3274cf}
#loginbox .login-wordmark{font-size:23px;font-weight:700;white-space:nowrap}
#loginbox .login-product{font-size:16px;font-weight:400;color:#64718a;padding-left:16px;border-left:1px solid #cdd7e7}
#loginbox .login-container{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);width:min(1080px,100%);min-height:550px;margin:38px auto 0;background:#fff;border:1px solid #e7ebf4;border-radius:8px;box-shadow:0 20px 64px #304e8210;overflow:hidden}
#loginbox .login-intro{position:relative;min-width:0;padding:54px 48px;background:linear-gradient(150deg,#f7fbff,#f5f7fe);border-right:1px solid #edf0f7}
#loginbox .login-overline{font-size:12px;color:#687f9d;font-weight:600;margin:0 0 16px}
#loginbox .login-intro h1{font-size:34px;font-weight:650;line-height:1.35;margin:0 0 18px}
#loginbox .login-summary{font-size:16px;color:#64758c;line-height:1.9;max-width:380px;margin:0 0 30px}
#loginbox .login-capabilities{list-style:none;padding:0;margin:0;display:grid;gap:17px}
#loginbox .login-capabilities li{display:flex;gap:12px;align-items:flex-start;font-size:14px;color:#52667f}
#loginbox .login-capabilities li::before{content:'';width:7px;height:7px;margin-top:8px;flex:none;border-radius:2px;background:#508cdb}
#loginbox .login-capabilities li:nth-child(2)::before{background:#668b83}
#loginbox .login-capabilities li:nth-child(3)::before{background:#9380b2}
#loginbox .login-capabilities strong{font-weight:600;color:#314763;margin-right:10px}
#loginbox .login-visual{display:block;width:100%;max-width:360px;aspect-ratio:360/110;margin:30px 0 0;overflow:visible}
#loginbox .login-visual path,#loginbox .login-visual rect{vector-effect:non-scaling-stroke}
#loginbox .login-visual .signal{animation:login-signal 5s ease-in-out infinite alternate}
#loginbox .login-card{border:0;border-radius:0;box-shadow:none;margin:0;min-width:0;padding:57px 48px 44px;background:#fff}
#loginbox .login-card h2{font-size:23px;font-weight:600;line-height:1.4;margin:0 0 30px;padding-bottom:20px;border-bottom:1px solid #e8edf4}
#loginbox .login-card h2::after{content:'';display:block;width:30px;height:3px;background:#3477d6;position:relative;top:22px}
#loginbox .field{font-size:14px;font-weight:500;color:#354760;margin:0 0 22px;gap:9px}
#loginbox input{width:100%;min-height:48px;border-radius:5px;border-color:#ced8e6;font-size:16px;padding:11px 13px;background:#fff;color:#24324a}
#loginbox input::placeholder{color:#8d99aa;font-size:14px}
#loginbox input:focus-visible,#loginbox button:focus-visible{outline:3px solid #a3c7f5;outline-offset:3px;border-color:#4e8de0}
#loginbox button{min-height:44px;border-radius:5px}
#loginbox .button-secondary{align-self:flex-end;background:transparent;border:0;color:#526e94;padding:6px 0;margin:-5px 0 0;font-size:13px;min-width:64px}
#loginbox .button-secondary:hover{color:#1c5bb0;background:#f5f8fd}
#loginbox #loginbtn{width:100%;min-height:48px;margin:3px 0 0;background:#2c72d2;border:1px solid #2c72d2;color:#fff;font-size:16px}
#loginbox #loginbtn:hover{background:#205db3}
#loginbox #loginbtn:disabled{cursor:wait;opacity:.6}
#loginbox #msg{min-height:24px;margin:14px 0 0;font-size:13px;line-height:1.8;overflow-wrap:anywhere;color:#af3545}
#loginbox .login-footnote{font-size:12px;color:#7b899c;margin:24px 0 0;text-align:left;line-height:1.8}
#loginbox .login-bottom{max-width:1080px;margin:26px auto 0;text-align:center;font-size:12px;color:#7d8ca2}
@keyframes login-signal{from{opacity:.35}to{opacity:1}}
@media(max-width:959px){#loginbox{padding:0 24px 40px}#loginbox .login-masthead{height:90px}#loginbox .login-container{margin-top:24px;grid-template-columns:minmax(0,1fr) minmax(0,1fr)}#loginbox .login-intro,#loginbox .login-card{padding:38px 28px}#loginbox .login-intro h1{font-size:30px}#loginbox .login-capabilities strong{display:block;margin:0 0 2px}}
@media(max-width:680px){#loginbox{padding:0 16px 28px}#loginbox .login-masthead{height:80px;gap:10px}#loginbox .login-wordmark{font-size:21px}#loginbox .login-product{font-size:13px;padding-left:10px}#loginbox .login-logo{width:28px;height:28px}#loginbox .login-container{grid-template-columns:minmax(0,1fr);margin:8px auto 0;min-height:0}#loginbox .login-intro{padding:28px 24px;border-right:0;border-bottom:1px solid #edf0f7}#loginbox .login-intro h1{font-size:27px;margin-bottom:10px}#loginbox .login-overline{margin-bottom:10px}#loginbox .login-summary{font-size:14px;margin-bottom:18px}#loginbox .login-capabilities{gap:9px}#loginbox .login-capabilities li{font-size:12px}#loginbox .login-capabilities strong{display:inline;margin-right:8px}#loginbox .login-visual{display:none}#loginbox .login-card{padding:28px 24px 24px}#loginbox .login-card h2{font-size:21px;margin-bottom:26px}#loginbox .login-bottom{margin-top:20px}}
@media(prefers-reduced-motion:reduce){#loginbox *,#loginbox::before{animation:none!important;transition:none!important}}
</style></head><body>
<a class="skip-link" href="#main-content">跳到主要内容</a>
<div class="login-layout" id="loginbox">
 <header class="login-masthead"><svg class="login-logo" viewBox="0 0 32 32" fill="none" aria-hidden="true"><rect x="2" y="2" width="11" height="11" rx="2" fill="currentColor"/><rect x="19" y="2" width="11" height="11" rx="2" fill="currentColor" opacity=".4"/><rect x="2" y="19" width="11" height="11" rx="2" fill="currentColor" opacity=".4"/><rect x="19" y="19" width="11" height="11" rx="2" fill="currentColor"/></svg><span class="login-wordmark">企业OS</span><span class="login-product">Jadmin 管理中心</span></header>
 <main class="login-container" aria-label="管理员登录">
  <section class="login-intro" aria-labelledby="login-title"><p class="login-overline">ENTERPRISE ADMINISTRATION</p><h1 id="login-title">管理中心</h1><p class="login-summary">让团队、应用与资源井然有序。<br>从这里管理你的企业工作空间。</p>
   <ul class="login-capabilities"><li><span><strong>团队与权限</strong>连接成员，明确协作边界</span></li><li><span><strong>应用与模型</strong>集中配置，保持服务有序</span></li><li><span><strong>运行与记录</strong>掌握状态，回溯管理操作</span></li></ul>
   <svg class="login-visual" viewBox="0 0 360 110" fill="none" aria-hidden="true"><path d="M12 78H72L107 42H183L225 78H345M72 78H183L225 42H316M107 42V92M225 42V92" stroke="#c6d8ef"/><rect x="30" y="64" width="28" height="28" rx="5" fill="#edf4fe" stroke="#9fbee9"/><rect x="130" y="26" width="50" height="34" rx="5" fill="#e7f0fc" stroke="#8eafe0"/><rect x="260" y="64" width="36" height="28" rx="5" fill="#f0ecf8" stroke="#b7acd0"/><path d="M141 38h28M141 47h17M269 74h18M269 82h12" stroke="#a3b8d7"/><circle class="signal" cx="225" cy="42" r="4" fill="#759bd0"/><circle class="signal" cx="107" cy="78" r="3" fill="#8ba9bd"/></svg>
  </section>
  <section class="login-card" aria-labelledby="login-heading"><h2 id="login-heading">邮箱登录</h2><form id="loginform"><label class="field" for="email">邮箱<input id="email" type="email" required autocomplete="username" placeholder="输入管理员邮箱"></label><label class="field" for="password">密码<input id="password" type="password" required autocomplete="current-password" placeholder="输入登录密码"></label><button id="loginbtn" type="submit">登录后台</button><p id="msg" role="alert" aria-live="polite"></p></form><p class="login-footnote">使用管理员邮箱和密码登录</p></section>
 </main><p class="login-bottom">企业OS · Jadmin 管理中心</p>
</div>
<div id="app" class="app-shell" hidden>
<header class="topbar"><div class="topbar-brand"><button id="menu-toggle" class="menu-button" type="button" aria-label="打开导航" aria-controls="sidebar" aria-expanded="false">☰</button><span class="brand">Jadmin<small>企业工作台</small></span></div><div class="session-tools"><span id="session-email" class="session-email"></span><span id="role-badge" class="chip neutral">管理员</span><button id="logout" type="button" class="button-secondary">退出</button></div></header>
<nav id="sidebar" class="sidebar" aria-label="主要导航"><a href="#/overview" data-route="overview">概览</a><div class="nav-group">首次设置</div><a href="#/setup" data-route="setup">开始设置</a><div class="nav-group">日常管理</div><a href="#/people" data-route="people">员工与部门</a><a href="#/accounts" data-route="accounts">平台账号</a><a href="#/teamwork" data-route="teamwork" hidden>团队日程</a><div class="nav-group">配置</div><a href="#/models" data-route="models">模型与接口</a><a href="#/login" data-route="login">企业登录</a><a href="#/mail" data-route="mail" hidden>企业邮箱</a><div class="nav-group">权限与安全</div><a href="#/admins" data-route="admins">管理员与权限</a><a href="#/credentials" data-route="credentials">凭据摘要</a><a href="#/audit" data-route="audit">操作记录</a><div class="nav-group">运行状态</div><a href="#/status" data-route="status">服务与资源</a><p class="sidebar-note">界面隐藏仅为方便；权限由服务器检查。</p></nav>
<button id="drawer-scrim" class="drawer-scrim" type="button" aria-label="关闭导航"></button>
<main id="main-content" class="main-content" tabindex="-1"><div class="page-heading"><div><p id="page-group" class="eyebrow">工作台</p><h1 id="page-title">概览</h1><p id="page-description">查看工作台状态与需要处理的事项。</p></div><button id="refresh" type="button" class="button-secondary">刷新</button></div><div id="global-notice" role="status" aria-live="polite" hidden></div><p id="page-freshness" class="freshness"></p><div id="bootstrap-status" class="skeleton" hidden>正在读取设置状态…</div>
<section id="page-overview" class="page" aria-label="概览" hidden></section>
<section id="page-setup" class="page" aria-label="开始设置" hidden><section class="card" id="setup-placeholder"><h2>从这里开始</h2><p>先连接模型接口，再按需要配置企业登录、部门与平台账号。实际模型调用、图像和知识库需要人工业务验收。</p><div class="actions"><a href="#/models">配置模型与接口</a><a href="#/login">配置企业登录</a></div><p class="muted">后台邮箱密码登录始终可用。未检查的项目保持未知。</p></section></section>
<section id="page-people" class="page" aria-label="员工与部门" hidden></section>
<section id="page-accounts" class="page" aria-label="平台账号" hidden></section>
<section id="page-teamwork" class="page" aria-label="团队日程" hidden></section>
<section id="page-models" class="page" aria-label="模型与接口" hidden><section id="modelConfigCard" class="card"><h2>当前接口</h2><div id="config"></div><div id="endpoint-controls"><h3>修改接口</h3><p id="endpoint-owner-note" class="muted">仅所有者可修改 API 地址与统一 Key。</p><label class="field" for="baseURL">API 地址<input id="baseURL" type="url" autocomplete="off" placeholder="https://api.example.com/v1"></label><label class="field" for="apiKey">统一 API Key<input id="apiKey" type="password" autocomplete="new-password" placeholder="留空保持原值"></label><label class="field"><input id="reuseKeyForNewOrigin" type="checkbox">沿用现有 Key 到新地址（我确认该 Key 属于新服务商）</label><p class="muted">可填写公网 HTTPS 服务商地址，请写到服务商要求的路径，系统不会自动补全 /v1。保存配置不代表 Jchat 实际对话已验证。</p><button id="save-endpoint" type="button">保存接口</button></div><p id="endpoint-notice" role="status"></p><h3>模型</h3><p class="muted">模型列表可读取不代表实际对话已验证。</p><label class="field" for="model">默认模型<select id="model"></select></label><div class="actions"><button id="loadmodels" type="button" class="button-secondary">重新拉取模型</button><button id="savebtn" type="button">设为默认模型</button></div><p id="modelNotice" role="status" aria-live="polite"></p><p class="unsupported">内网或本机模型网关仍需服务器管理员预先配置；所有者密码暂由服务器配置。</p></section></section>
<section id="page-login" class="page" aria-label="企业登录" hidden></section>
<section id="page-mail" class="page" aria-label="企业邮箱" hidden></section>
<section id="page-admins" class="page" aria-label="管理员与权限" hidden></section>
<section id="page-credentials" class="page" aria-label="凭据摘要" hidden></section>
<section id="page-audit" class="page" aria-label="操作记录" hidden></section>
<section id="page-status" class="page" aria-label="服务与资源" hidden></section>
</main></div></body></html>"""
from pathlib import Path
for _ui_name in ('core-ui.js','models-ui.js','runtime-models-ui.js','media-ui.js','modules-ui.js','setup-ui.js','enterprise-ui.js','api-usage-ui.js','grants-ui.js','media-grants-ui.js','onboarding-ui.js','work-ui.js','mail-ui.js','shell-ui.js'):
 _ui_path=Path(__file__).with_name(_ui_name)
 if _ui_name=='onboarding-ui.js' and not _ui_path.exists(): continue
 HTML += '<script>'+_ui_path.read_text(encoding='utf-8')+'</script>'

def script_hashes(page):
 import re
 return ["'sha256-"+base64.b64encode(hashlib.sha256(s.encode()).digest()).decode()+"'" for s in re.findall(r'<script>([\s\S]*?)</script>',page)]
# The page is static, so its inline scripts are allowed by hash instead of 'unsafe-inline'.
CSP=CSP.replace("script-src 'self' 'unsafe-inline'","script-src 'self' "+' '.join(script_hashes(HTML)))
def main():
 if len(KEY)<32: raise SystemExit('ADMIN_SECRET 至少需要 32 个字符（例如 python3 -c "import secrets;print(secrets.token_hex(32))"）')
 init_db()
 if work_http.enabled(): work_http.start(sys.modules[__name__])
 mail_http.start(sys.modules[__name__])
 mail_service.start_worker(sys.modules[__name__])
 if os.environ.get('QYOS_SHARED_IMAGE_SOCKET'):
  import shared_image_provider
  shared_image_provider.start(sys.modules[__name__],os.environ['QYOS_SHARED_IMAGE_SOCKET'])
 threading.Thread(target=_runtime_models.recover,daemon=True).start()
 threading.Thread(target=collect_metrics,daemon=True).start()
 port=int(os.environ.get('ADMIN_PORT','8090'))
 try: ThreadingHTTPServer((os.environ.get('ADMIN_HOST','127.0.0.1'),port),H).serve_forever()
 finally:
  mail_http.stop(); mail_service.stop_worker(); work_http.stop()

if __name__ == '__main__':
 main()
