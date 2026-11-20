const enc = new TextEncoder();
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const unhex = h => new Uint8Array(h.match(/../g).map(x => parseInt(x, 16)));
const J = (d, s = 200, h = {}) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json', ...h } });
class HttpErr extends Error { constructor(s, m) { super(m); this.s = s; } }

async function derive(pw, salt) {
  const k = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, k, 256));
}
async function hashPw(pw) { const s = crypto.getRandomValues(new Uint8Array(16)); return hex(s) + ':' + await derive(pw, s); }
async function checkPw(pw, st) {
  const [s, h] = st.split(':'); const d = await derive(pw, unhex(s));
  let r = 0; for (let i = 0; i < h.length; i++) r |= h.charCodeAt(i) ^ d.charCodeAt(i); return r === 0 && h.length === d.length;
}
const sha = async t => hex(await crypto.subtle.digest('SHA-256', enc.encode(t)));
const cookie = req => (req.headers.get('cookie') || '').match(/(?:^|; )sid=([^;]+)/)?.[1];

async function getUser(req, env) {
  const t = cookie(req); if (!t) return null;
  return await env.DB.prepare(`SELECT u.id,u.email,u.name,u.role,u.permissions FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>? AND u.active=1`).bind(await sha(t), Date.now()).first();
}
const can = (u, p) => u.role === 'admin' || JSON.parse(u.permissions || '[]').includes(p);
async function audit(env, u, action, entity, id, before, after) {
  await env.DB.prepare('INSERT INTO audit_logs(user_id,action,entity,entity_id,before_json,after_json) VALUES(?,?,?,?,?,?)')
    .bind(u?.id ?? null, action, entity, String(id ?? ''), before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null).run();
}
const broadcast = (env, type, data) => env.HUB.get(env.HUB.idFromName('main'))
  .fetch('https://hub/broadcast', { method: 'POST', body: JSON.stringify({ type, ...data }) });
const str = (v, max, name) => { if (typeof v !== 'string' || !v.trim() || v.length > max) throw new HttpErr(400, `حقل غير صالح: ${name}`); return v.trim(); };
const money = (v, name) => { const n = Math.round(Number(v) * 100); if (!Number.isFinite(n) || n < 0) throw new HttpErr(400, `قيمة غير صالحة: ${name}`); return n; };

async function newSession(env, userId) {
  const t = hex(crypto.getRandomValues(new Uint8Array(32))); const exp = Date.now() + 7 * 864e5;
  await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(await sha(t), userId, exp).run();
  return `sid=${t}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${7 * 86400}`;
}

async function handle(req, env) {
  const url = new URL(req.url), p = url.pathname, m = req.method;
  if (m !== 'GET' && req.headers.get('x-requested-with') !== 'erp') throw new HttpErr(403, 'طلب مرفوض');
  const body = m === 'GET' || m === 'DELETE' ? {} : await req.json().catch(() => { throw new HttpErr(400, 'بيانات غير صالحة'); });

  if (p === '/api/setup' && m === 'POST') {
    if (!env.SETUP_KEY || body.setup_key !== env.SETUP_KEY) throw new HttpErr(403, 'مفتاح التهيئة غير صحيح');
    const email = str(body.email, 120, 'البريد').toLowerCase(), name = str(body.name, 80, 'الاسم');
    if (!(env.ADMIN_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).includes(email)) throw new HttpErr(403, 'هذا البريد غير مصرح له');
    if (typeof body.password !== 'string' || body.password.length < 10) throw new HttpErr(400, 'كلمة السر 10 أحرف على الأقل');
    const cnt = await env.DB.prepare("SELECT COUNT(*) c FROM users WHERE role='admin'").first();
    if (cnt.c >= 2) throw new HttpErr(409, 'تم إنشاء الحسابين الإداريين بالفعل');
    try { const r = await env.DB.prepare("INSERT INTO users(email,name,pass_hash,role) VALUES(?,?,?,'admin')").bind(email, name, await hashPw(body.password)).run();
      await audit(env, { id: r.meta.last_row_id }, 'admin.setup', 'users', r.meta.last_row_id);
    } catch { throw new HttpErr(409, 'الحساب موجود بالفعل'); }
    return J({ ok: true });
  }
  if (p === '/api/login' && m === 'POST') {
    const email = String(body.email || '').toLowerCase(), ip = req.headers.get('cf-connecting-ip') || '';
    const since = Date.now() - 15 * 60e3;
    const a = await env.DB.prepare('SELECT COUNT(*) c FROM login_attempts WHERE (email=? OR ip=?) AND at>?').bind(email, ip, since).first();
    if (a.c >= 8) throw new HttpErr(429, 'محاولات كثيرة، حاول بعد 15 دقيقة');
    const u = await env.DB.prepare('SELECT * FROM users WHERE email=? AND active=1').bind(email).first();
    if (!u || !(await checkPw(String(body.password || ''), u.pass_hash))) {
      await env.DB.prepare('INSERT INTO login_attempts(email,ip,at) VALUES(?,?,?)').bind(email, ip, Date.now()).run();
      throw new HttpErr(401, 'بيانات الدخول غير صحيحة');
    }
    await audit(env, u, 'login', 'users', u.id);
    return J({ ok: true }, 200, { 'set-cookie': await newSession(env, u.id) });
  }
  const user = await getUser(req, env);
  if (!user) throw new HttpErr(401, 'يجب تسجيل الدخول');
  if (p === '/api/logout') {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha(cookie(req))).run();
    return J({ ok: true }, 200, { 'set-cookie': 'sid=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0' });
  }
  if (p === '/api/me') return J({ id: user.id, name: user.name, email: user.email, role: user.role });
  if (p === '/api/ws') {
    if (req.headers.get('upgrade') !== 'websocket') throw new HttpErr(426, 'WebSocket فقط');
    return env.HUB.get(env.HUB.idFromName('main')).fetch('https://hub/ws', req);
  }
  if (p === '/api/products') {
    if (m === 'GET') {
      if (!can(user, 'products.view')) throw new HttpErr(403, 'غير مصرح');
      return J((await env.DB.prepare("SELECT * FROM products WHERE status='active' ORDER BY id DESC").all()).results);
    }
    if (m === 'POST') {
      if (!can(user, 'products.create')) throw new HttpErr(403, 'غير مصرح');
      const row = { sku: str(body.sku, 40, 'الكود'), name: str(body.name, 120, 'الاسم'), c: money(body.cost, 'التكلفة'), pr: money(body.price, 'السعر') };
      try { const r = await env.DB.prepare('INSERT INTO products(sku,name,cost_piastres,price_piastres) VALUES(?,?,?,?)').bind(row.sku, row.name, row.c, row.pr).run();
        await audit(env, user, 'create', 'products', r.meta.last_row_id, null, row);
        await broadcast(env, 'products', { by: user.id }); return J({ id: r.meta.last_row_id }, 201);
      } catch (e) { if (e instanceof HttpErr) throw e; throw new HttpErr(409, 'كود المنتج مكرر'); }
    }
  }
  const pm = p.match(/^\/api\/products\/(\d+)$/);
  if (pm) {
    const id = +pm[1], old = await env.DB.prepare('SELECT * FROM products WHERE id=?').bind(id).first();
    if (!old) throw new HttpErr(404, 'غير موجود');
    if (m === 'PUT') {
      if (!can(user, 'products.edit')) throw new HttpErr(403, 'غير مصرح');
      const r = await env.DB.prepare('UPDATE products SET name=?,cost_piastres=?,price_piastres=?,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND version=?')
        .bind(str(body.name, 120, 'الاسم'), money(body.cost, 'التكلفة'), money(body.price, 'السعر'), id, +body.version).run();
      if (!r.meta.changes) throw new HttpErr(409, 'تم تعديل هذا المنتج من جهاز آخر، حدّث الصفحة');
      await audit(env, user, 'update', 'products', id, old, body); await broadcast(env, 'products', { by: user.id }); return J({ ok: true });
    }
    if (m === 'DELETE') {
      if (!can(user, 'products.delete')) throw new HttpErr(403, 'غير مصرح');
      await env.DB.prepare("UPDATE products SET status='archived',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(id).run();
      await audit(env, user, 'archive', 'products', id, old); await broadcast(env, 'products', { by: user.id }); return J({ ok: true });
    }
  }
  throw new HttpErr(404, 'غير موجود');
}

export default {
  async fetch(req, env) {
    try { return await handle(req, env); }
    catch (e) { if (e instanceof HttpErr) return J({ error: e.message }, e.s); console.error(e); return J({ error: 'خطأ في الخادم' }, 500); }
  }
};

export class Hub {
  constructor(state) { this.s = state; }
  async fetch(r) {
    const u = new URL(r.url);
    if (u.pathname === '/ws') { const [c, s] = Object.values(new WebSocketPair()); this.s.acceptWebSocket(s); return new Response(null, { status: 101, webSocket: c }); }
    if (u.pathname === '/broadcast') { const m = await r.text(); for (const w of this.s.getWebSockets()) { try { w.send(m); } catch {} } return new Response('ok'); }
    return new Response('no', { status: 404 });
  }
  webSocketMessage(ws, m) { if (m === 'ping') ws.send('pong'); }
  webSocketClose(ws) { try { ws.close(); } catch {} }
}
