const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const pgSession = require('connect-pg-simple')(session);

const app = express();
const PORT = process.env.PORT || 3000;

// 连接云数据库
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 初始化数据库表
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      password_hash VARCHAR(100) NOT NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'user',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sections (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      sort_order INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS resources (
      id SERIAL PRIMARY KEY,
      section_id INTEGER NOT NULL,
      title VARCHAR(200) NOT NULL,
      content TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS "session" (
      "sid" varchar NOT NULL COLLATE "default",
      "sess" json NOT NULL,
      "expire" timestamp(6) NOT NULL,
      CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
    );
    CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
  `);

  // 初始化管理员
  const adminRes = await pool.query("SELECT id FROM users WHERE role='admin' LIMIT 1");
  if (adminRes.rowCount === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    await pool.query("INSERT INTO users (username,password_hash,role) VALUES ($1,$2,$3)", ['admin', hash, 'admin']);
    console.log('初始管理员：admin / admin123');
  }
}
initDB();

app.use(express.json());
app.use(session({
  store: new pgSession({ pool: pool, tableName: 'session' }),
  secret: process.env.SESSION_SECRET || 'super-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: false, maxAge: 7 * 24 * 3600 * 1000 }
}));

const requireLogin = (req, res, next) => req.session.user ? next() : res.status(401).json({ error: '未登录' });
const requireAdmin = (req, res, next) => (req.session.user && req.session.user.role === 'admin') ? next() : res.status(403).json({ error: '无权限' });

/* ---------- 登录接口 ---------- */
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '请输入账号密码' });
  const { rows } = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
  if (rows.length === 0 || !bcrypt.compareSync(password, rows[0].password_hash))
    return res.status(401).json({ error: '账号或密码错误' });
  req.session.user = { id: rows[0].id, username: rows[0].username, role: rows[0].role };
  res.json({ ok: true, user: req.session.user });
});

app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/me', (req, res) => res.json({ user: req.session.user || null }));

/* ---------- 页面路由 ---------- */
app.get('/login', (req, res) => res.send(loginHTML));
app.get('/admin', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/login');
  res.send(adminHTML);
});
app.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  res.send(homeHTML);
});

/* ---------- 分区接口 ---------- */
app.get('/api/admin/sections', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM sections ORDER BY sort_order,id');
  res.json(rows);
});
app.post('/api/admin/sections', requireAdmin, async (req, res) => {
  const { name, sort_order } = req.body || {};
  if (!name) return res.status(400).json({ error: '分区名不能为空' });
  const { rows } = await pool.query('INSERT INTO sections (name,sort_order) VALUES ($1,$2) RETURNING id', [name, Number(sort_order) || 0]);
  res.json({ ok: true, id: rows[0].id });
});
app.delete('/api/admin/sections/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  await pool.query('DELETE FROM resources WHERE section_id=$1', [id]);
  await pool.query('DELETE FROM sections WHERE id=$1', [id]);
  res.json({ ok: true });
});

/* ---------- 账户接口 ---------- */
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT id,username,role,created_at FROM users ORDER BY id');
  res.json(rows);
});
app.post('/api/admin/users', requireAdmin, async (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '账号密码不能为空' });
  if (username.length < 3) return res.status(400).json({ error: '账号至少3位' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });
  const check = await pool.query('SELECT id FROM users WHERE username=$1', [username]);
  if (check.rowCount > 0) return res.status(400).json({ error: '账号已存在' });
  const hash = bcrypt.hashSync(password, 10);
  await pool.query('INSERT INTO users (username,password_hash,role) VALUES ($1,$2,$3)', [username, hash, role === 'admin' ? 'admin' : 'user']);
  res.json({ ok: true });
});
app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.session.user.id) return res.status(400).json({ error: '不能删除自己' });
  await pool.query('DELETE FROM users WHERE id=$1', [id]);
  res.json({ ok: true });
});

/* ---------- 资源接口 ---------- */
app.get('/api/admin/resources', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM resources ORDER BY id DESC');
  res.json(rows);
});
app.post('/api/admin/resources', requireAdmin, async (req, res) => {
  const { section_id, title, content } = req.body || {};
  if (!section_id || !title) return res.status(400).json({ error: '分区和标题必填' });
  const { rows } = await pool.query('INSERT INTO resources (section_id,title,content) VALUES ($1,$2,$3) RETURNING id', [Number(section_id), title, content || '']);
  res.json({ ok: true, id: rows[0].id });
});
app.delete('/api/admin/resources/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM resources WHERE id=$1', [Number(req.params.id)]);
  res.json({ ok: true });
});

/* ---------- 前台数据接口 ---------- */
app.get('/api/sections', requireLogin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM sections ORDER BY sort_order,id');
  res.json(rows);
});
app.get('/api/resources', requireLogin, async (req, res) => {
  const sid = Number(req.query.section_id);
  let query = 'SELECT * FROM resources ORDER BY id DESC';
  let params = [];
  if (sid) { query = 'SELECT * FROM resources WHERE section_id=$1 ORDER BY id DESC'; params = [sid]; }
  const { rows } = await pool.query(query, params);
  res.json(rows);
});

/* ---------- 前端页面代码 ---------- */
const CSS = `
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:#f5f7fb;color:#1f2937;line-height:1.6;min-height:100vh}
input,select,textarea,button{font:inherit}
input,select,textarea{width:100%;padding:10px 14px;border:1px solid #e5e7eb;border-radius:10px;background:#fff;outline:none}
input:focus,select:focus,textarea:focus{border-color:#2563eb}
.container{width:min(100% - 32px,1100px);margin:0 auto}
.header{position:sticky;top:0;z-index:10;background:rgba(255,255,255,.92);backdrop-filter:blur(10px);border-bottom:1px solid #e5e7eb}
.nav{min-height:60px;display:flex;align-items:center;justify-content:space-between;gap:12px}
.logo{font-weight:800;color:#2563eb}
.btn{padding:10px 18px;border-radius:999px;background:#2563eb;color:#fff;border:none;cursor:pointer;font-weight:600}
.btn:hover{opacity:.9}
.btn.ghost{background:transparent;color:#1f2937;border:1px solid #e5e7eb}
.btn.danger{background:#dc2626}
.btn.small{padding:6px 12px;font-size:13px}
.muted{color:#6b7280;font-size:14px}
.hidden{display:none!important}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:20px}
.auth-body{display:flex;align-items:center;justify-content:center;padding:24px;min-height:100vh}
.auth-card{width:100%;max-width:400px;background:#fff;border:1px solid #e5e7eb;border-radius:20px;padding:32px;box-shadow:0 20px 60px rgba(15,23,42,.08)}
.auth-card h2{font-size:22px;margin-bottom:18px}
.form{display:flex;flex-direction:column;gap:12px}
.msg{font-size:14px;color:#dc2626;min-height:20px}
.tabs{display:flex;gap:8px;overflow-x:auto;margin:24px 0 16px}
.tab{flex:0 0 auto;padding:10px 18px;border:none;background:#f1f5f9;border-radius:10px;cursor:pointer;font-weight:600;color:#6b7280}
.tab.active{background:#2563eb;color:#fff}
.panel{display:none}
.panel.active{display:block}
.form-row{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px}
.form-row input,.form-row select{flex:1;min-width:140px}
.list{display:flex;flex-direction:column;gap:8px}
.list-item{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;background:#f8fafc;border-radius:10px;font-size:14px;word-break:break-all}
@media(max-width:600px){.auth-card{padding:24px 20px}.nav{flex-wrap:wrap;padding:10px 0}}
`;

const loginHTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录</title><style>${CSS}</style></head><body class="auth-body"><div class="auth-card"><h2>登录</h2><form id="f" class="form"><input name="username" placeholder="账号" required><input name="password" type="password" placeholder="密码" required><button class="btn" type="submit">登录</button><p class="msg" id="msg"></p></form></div><script>document.getElementById('f').onsubmit=async function(e){e.preventDefault();var f=e.target;var r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:f.username.value,password:f.password.value})});var d=await r.json();if(d.ok){location.href=d.user.role==='admin'?'/admin':'/'}else{document.getElementById('msg').textContent=d.error}}</script></body></html>`;

const adminHTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>管理后台</title><style>${CSS}</style></head><body><header class="header"><div class="container nav"><div class="logo">管理后台</div><div style="display:flex;gap:12px;align-items:center"><a href="/" class="muted">返回主页</a><button class="btn ghost" id="logout">退出</button></div></div></header><main class="container"><div class="tabs"><button class="tab active" data-tab="sections">分区管理</button><button class="tab" data-tab="users">账户管理</button><button class="tab" data-tab="resources">资源添加</button></div><section class="panel active" id="panel-sections"><div class="card"><div class="form-row"><input id="secName" placeholder="分区名称"><input id="secOrder" type="number" placeholder="排序" value="0" style="max-width:110px"><button class="btn" id="addSec">添加分区</button></div><div id="secList" class="list"></div></div></section><section class="panel" id="panel-users"><div class="card"><div class="form-row"><input id="userName" placeholder="账号（至少3位）"><input id="userPwd" type="password" placeholder="密码（至少6位）"><select id="userRole" style="max-width:140px"><option value="user">普通用户</option><option value="admin">管理员</option></select><button class="btn" id="addUser">添加账户</button></div><div id="userList" class="list"></div></div></section><section class="panel" id="panel-resources"><div class="card"><div class="form-row"><select id="resSection" style="max-width:180px"></select><input id="resTitle" placeholder="标题"><textarea id="resContent" placeholder="内容" rows="3" style="width:100%"></textarea><button class="btn" id="addRes">添加资源</button></div><div id="resList" class="list"></div></div></section></main><script>var api=async function(url,opts){var r=await fetch(url,opts);if(r.status===401||r.status===403){location.href='/login';return null}return r.json()};var json=function(data){return{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}};document.querySelectorAll('.tab').forEach(function(t){t.onclick=function(){document.querySelectorAll('.tab').forEach(function(x){x.classList.remove('active')});t.classList.add('active');document.querySelectorAll('.panel').forEach(function(p){p.classList.remove('active')});document.getElementById('panel-'+t.dataset.tab).classList.add('active');if(t.dataset.tab==='sections')loadSections();if(t.dataset.tab==='users')loadUsers();if(t.dataset.tab==='resources')loadResources()}});async function loadSections(){var list=await api('/api/admin/sections');if(!list)return;var box=document.getElementById('secList');var sel=document.getElementById('resSection');box.innerHTML='';sel.innerHTML='';list.forEach(function(s){var div=document.createElement('div');div.className='list-item';var span=document.createElement('span');span.textContent=s.name+'（排序 '+s.sort_order+'）';var btn=document.createElement('button');btn.className='btn danger small';btn.textContent='删除';btn.onclick=async function(){if(!confirm('删除该分区？会同时删除其下资源'))return;await api('/api/admin/sections/'+s.id,{method:'DELETE'});loadSections()};div.appendChild(span);div.appendChild(btn);box.appendChild(div);var opt=document.createElement('option');opt.value=s.id;opt.textContent=s.name;sel.appendChild(opt)})}document.getElementById('addSec').onclick=async function(){var name=document.getElementById('secName').value.trim();if(!name)return alert('请输入分区名');var sort_order=Number(document.getElementById('secOrder').value)||0;await api('/api/admin/sections',json({name:name,sort_order:sort_order}));document.getElementById('secName').value='';loadSections()};async function loadUsers(){var list=await api('/api/admin/users');if(!list)return;var box=document.getElementById('userList');box.innerHTML='';list.forEach(function(u){var div=document.createElement('div');div.className='list-item';var span=document.createElement('span');span.textContent=u.username+'（'+u.role+'）';var btn=document.createElement('button');btn.className='btn danger small';btn.textContent='删除';btn.onclick=async function(){if(!confirm('删除用户 '+u.username+'？'))return;var res=await api('/api/admin/users/'+u.id,{method:'DELETE'});if(res&&res.error)alert(res.error);loadUsers()};div.appendChild(span);div.appendChild(btn);box.appendChild(div)})}document.getElementById('addUser').onclick=async function(){var username=document.getElementById('userName').value.trim();var password=document.getElementById('userPwd').value;var role=document.getElementById('userRole').value;if(!username||!password)return alert('账号密码不能为空');var res=await api('/api/admin/users',json({username:username,password:password,role:role}));if(res&&res.error)return alert(res.error);document.getElementById('userName').value='';document.getElementById('userPwd').value='';loadUsers()};async function loadResources(){var list=await api('/api/admin/resources');if(!list)return;var box=document.getElementById('resList');box.innerHTML='';list.forEach(function(r){var div=document.createElement('div');div.className='list-item';var span=document.createElement('span');span.textContent='['+r.section_id+'] '+r.title+' - '+(r.content||'');var btn=document.createElement('button');btn.className='btn danger small';btn.textContent='删除';btn.onclick=async function(){if(!confirm('删除该资源？'))return;await api('/api/admin/resources/'+r.id,{method:'DELETE'});loadResources()};div.appendChild(span);div.appendChild(btn);box.appendChild(div)})}document.getElementById('addRes').onclick=async function(){var section_id=Number(document.getElementById('resSection').value);var title=document.getElementById('resTitle').value.trim();var content=document.getElementById('resContent').value.trim();if(!section_id||!title)return alert('请选择分区并填写标题');var res=await api('/api/admin/resources',json({section_id:section_id,title:title,content:content}));if(res&&res.error)return alert(res.error);document.getElementById('resTitle').value='';document.getElementById('resContent').value='';loadResources()};document.getElementById('logout').onclick=async function(){await fetch('/api/logout',{method:'POST'});location.href='/login'};loadSections();</script></body></html>`;

const homeHTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>主页</title><style>${CSS}.main{display:grid;grid-template-columns:240px 1fr;gap:24px;padding:28px 0;align-items:start}.sidebar{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:8px;position:sticky;top:84px}.side-item{text-align:left;padding:10px 12px;border-radius:10px;border:none;background:transparent;cursor:pointer;font-weight:500}.side-item:hover{background:#f1f5f9}.side-item.active{background:#2563eb;color:#fff}.content{display:flex;flex-direction:column;gap:16px}.content .card h3{margin-bottom:6px}.content .card p{color:#6b7280;font-size:15px;white-space:pre-wrap}@media(max-width:800px){.main{grid-template-columns:1fr}.sidebar{position:static;flex-direction:row;overflow-x:auto}.side-item{white-space:nowrap}}</style></head><body><header class="header"><div class="container nav"><div class="logo">我的网页</div><div style="display:flex;gap:12px;align-items:center"><span id="who" class="muted"></span><a href="/admin" id="adminLink" class="muted hidden">管理</a><button class="btn ghost" id="logout">退出</button></div></div></header><main class="container main"><aside class="sidebar" id="sections"></aside><section class="content" id="contents"></section></main><script>var currentSection=null;var api=async function(url){var r=await fetch(url);if(r.status===401){location.href='/login';return null}return r.json()};async function loadMe(){var me=await api('/api/me');if(!me||!me.user){location.href='/login';return}document.getElementById('who').textContent=me.user.username;if(me.user.role==='admin')document.getElementById('adminLink').classList.remove('hidden')}async function loadSections(){var list=await api('/api/sections');if(!list)return;var box=document.getElementById('sections');box.innerHTML='';if(!list.length){box.innerHTML='<p class="muted">暂无分区</p>';return}if(!currentSection)currentSection=list[0].id;list.forEach(function(s){var b=document.createElement('button');b.className='side-item'+(currentSection===s.id?' active':'');b.textContent=s.name;b.onclick=function(){currentSection=s.id;document.querySelectorAll('.side-item').forEach(function(x){x.classList.remove('active')});b.classList.add('active');loadContents()};box.appendChild(b)});loadContents()}async function loadContents(){var box=document.getElementById('contents');box.innerHTML='';if(!currentSection)return;var list=await api('/api/resources?section_id='+currentSection);if(!list||!list.length){box.innerHTML='<p class="muted">该分区暂无内容</p>';return}list.forEach(function(c){var div=document.createElement('article');div.className='card';var h=document.createElement('h3');var p=document.createElement('p');h.textContent=c.title;p.textContent=c.content||'';div.appendChild(h);div.appendChild(p);box.appendChild(div)})}document.getElementById('logout').onclick=async function(){await fetch('/api/logout',{method:'POST'});location.href='/login'};loadMe().then(loadSections);</script></body></html>`;

app.listen(PORT, () => console.log('http://localhost:' + PORT));
