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
const broadcast = (env, type) => env.HUB.get(env.HUB.idFromName('main'))
  .fetch('https://hub/broadcast', { method: 'POST', body: JSON.stringify({ type }) }).catch(() => {});
const str = (v, max, name) => { if (typeof v !== 'string' || !v.trim() || v.length > max) throw new HttpErr(400, `حقل غير صالح: ${name}`); return v.trim(); };
const money = (v, name) => { const n = Math.round(Number(v) * 100); if (!Number.isFinite(n) || n < 0) throw new HttpErr(400, `قيمة غير صالحة: ${name}`); return n; };

async function newSession(env, userId) {
  const t = hex(crypto.getRandomValues(new Uint8Array(32))); const exp = Date.now() + 7 * 864e5;
  await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(await sha(t), userId, exp).run();
  return `sid=${t}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${7 * 86400}`;
}

const SPEC = {
  warehouses: [['name', 'name', 's', 80, 'الاسم'], ['location', 'location', 'o', 200, 'الموقع']],
  suppliers: [['name', 'name', 's', 80, 'الاسم'], ['phone', 'phone', 'o', 30, 'الهاتف'], ['address', 'address', 'o', 200, 'العنوان']],
  materials: [['sku', 'sku', 's', 40, 'الكود'], ['name', 'name', 's', 120, 'الاسم'], ['unit', 'unit', 's', 20, 'الوحدة'],
    ['unit_cost', 'unit_cost_piastres', 'm', 0, 'سعر الشراء'], ['min_stock', 'min_stock', 'n', 0, 'حد إعادة الطلب']]
};
const num = (v, label) => { const n = Number(v); if (v === '' || v == null || !Number.isFinite(n) || n < 0) throw new HttpErr(400, `قيمة غير صالحة: ${label}`); return n; };
const conv = ([k, col, t, max, label], v) => t === 's' ? str(v, max, label) : t === 'o' ? (v == null || v === '' ? null : str(String(v), max, label)) : t === 'm' ? money(v, label) : num(v, label);
async function crud(env, user, m, ent, id, body) {
  const sp = SPEC[ent], need = a => { if (!can(user, `${ent}.${a}`)) throw new HttpErr(403, 'غير مصرح'); };
  if (!id) {
    if (m === 'GET') { need('view'); return J((await env.DB.prepare(`SELECT * FROM ${ent} WHERE status='active' ORDER BY id DESC`).all()).results); }
    if (m === 'POST') {
      need('create'); const vals = sp.map(s => conv(s, body[s[0]]));
      try {
        const r = await env.DB.prepare(`INSERT INTO ${ent}(${sp.map(s => s[1]).join(',')}) VALUES(${sp.map(() => '?').join(',')})`).bind(...vals).run();
        await audit(env, user, 'create', ent, r.meta.last_row_id, null, body); await broadcast(env, ent); return J({ id: r.meta.last_row_id }, 201);
      } catch (e) { throw new HttpErr(409, 'الكود أو الاسم مكرر'); }
    }
  } else {
    const old = await env.DB.prepare(`SELECT * FROM ${ent} WHERE id=?`).bind(id).first();
    if (!old) throw new HttpErr(404, 'غير موجود');
    if (m === 'PUT') {
      need('edit'); const f = sp.filter(s => s[0] !== 'sku'), vals = f.map(s => conv(s, body[s[0]]));
      let r; try { r = await env.DB.prepare(`UPDATE ${ent} SET ${f.map(s => s[1] + '=?').join(',')},version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND version=?`).bind(...vals, id, +body.version).run(); }
      catch (e) { throw new HttpErr(409, 'الاسم مكرر'); }
      if (!r.meta.changes) throw new HttpErr(409, 'تم تعديل هذا السجل من جهاز آخر، حدّث الصفحة');
      await audit(env, user, 'update', ent, id, old, body); await broadcast(env, ent); return J({ ok: true });
    }
    if (m === 'DELETE') {
      need('delete'); await env.DB.prepare(`UPDATE ${ent} SET status='archived',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(id).run();
      await audit(env, user, 'archive', ent, id, old); await broadcast(env, ent); return J({ ok: true });
    }
  }
  throw new HttpErr(405, 'طريقة غير مدعومة');
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
  const gm = p.match(/^\/api\/(warehouses|materials|suppliers)(?:\/(\d+))?$/);
  if (gm) return crud(env, user, m, gm[1], gm[2] ? +gm[2] : 0, body);
  if (p === '/api/stock' && m === 'GET') {
    if (!can(user, 'stock.view')) throw new HttpErr(403, 'غير مصرح');
    return J((await env.DB.prepare(`SELECT m.id material_id,m.sku,m.name,m.unit,m.min_stock,w.id warehouse_id,w.name warehouse,COALESCE(SUM(i.qty),0) qty
      FROM materials m CROSS JOIN warehouses w LEFT JOIN inventory_movements i ON i.material_id=m.id AND i.warehouse_id=w.id
      WHERE m.status='active' AND w.status='active' GROUP BY m.id,w.id ORDER BY m.name,w.name`).all()).results);
  }
  if (p === '/api/stock/ledger' && m === 'GET') {
    if (!can(user, 'stock.view')) throw new HttpErr(403, 'غير مصرح');
    return J((await env.DB.prepare(`SELECT i.id,i.qty,i.kind,i.note,i.created_at,m.name material,w.name warehouse,u.name user
      FROM inventory_movements i JOIN materials m ON m.id=i.material_id JOIN warehouses w ON w.id=i.warehouse_id
      LEFT JOIN users u ON u.id=i.user_id ORDER BY i.id DESC LIMIT 50`).all()).results);
  }
  if (p === '/api/stock/move' && m === 'POST') {
    if (!can(user, 'stock.move')) throw new HttpErr(403, 'غير مصرح');
    const kind = body.kind, sign = { opening: 1, in: 1, out: -1, damaged: -1, adjust: 0 }[kind];
    if (sign === undefined) throw new HttpErr(400, 'نوع الحركة غير صالح');
    let q = Number(body.qty); if (!Number.isFinite(q) || q === 0 || (sign && q < 0)) throw new HttpErr(400, 'الكمية غير صالحة');
    if (sign) q *= sign;
    const mid = +body.material_id, wid = +body.warehouse_id, rid = str(body.request_id, 64, 'المعرف');
    const mat = await env.DB.prepare("SELECT id,name,min_stock FROM materials WHERE id=? AND status='active'").bind(mid).first();
    const wh = await env.DB.prepare("SELECT id FROM warehouses WHERE id=? AND status='active'").bind(wid).first();
    if (!mat || !wh) throw new HttpErr(400, 'الخامة أو المخزن غير موجود');
    if (await env.DB.prepare('SELECT 1 x FROM inventory_movements WHERE request_id=?').bind(rid).first()) return J({ ok: true, duplicate: true });
    let r;
    try {
      r = await env.DB.prepare(`INSERT INTO inventory_movements(material_id,warehouse_id,qty,kind,note,user_id,request_id)
        SELECT ?,?,?,?,?,?,? WHERE (SELECT COALESCE(SUM(qty),0) FROM inventory_movements WHERE material_id=? AND warehouse_id=?)+? >= 0`)
        .bind(mid, wid, q, kind, body.note ? String(body.note).slice(0, 200) : null, user.id, rid, mid, wid, q).run();
    } catch (e) { if (/UNIQUE/i.test(e.message)) return J({ ok: true, duplicate: true }); throw e; }
    if (!r.meta.changes) throw new HttpErr(409, 'الرصيد في هذا المخزن غير كافٍ');
    await audit(env, user, 'stock.' + kind, 'inventory_movements', r.meta.last_row_id, null, { mid, wid, q });
    const t = await env.DB.prepare('SELECT COALESCE(SUM(qty),0) q FROM inventory_movements WHERE material_id=?').bind(mid).first();
    if (q < 0 && t.q < mat.min_stock) await env.DB.prepare('INSERT INTO notifications(kind,message) VALUES(?,?)').bind('low_stock', `انخفاض مخزون: ${mat.name}`).run();
    await broadcast(env, 'stock'); return J({ ok: true }, 201);
  }
  if (p === '/api/purchases' && m === 'GET') {
    if (!can(user, 'purchases.view')) throw new HttpErr(403, 'غير مصرح');
    return J((await env.DB.prepare(`SELECT i.id,i.total_piastres,i.created_at,s.name supplier,w.name warehouse FROM purchase_invoices i
      JOIN suppliers s ON s.id=i.supplier_id JOIN warehouses w ON w.id=i.warehouse_id WHERE i.status='received' ORDER BY i.id DESC LIMIT 50`).all()).results);
  }
  if (p === '/api/supplier-balances' && m === 'GET') {
    if (!can(user, 'purchases.view')) throw new HttpErr(403, 'غير مصرح');
    return J((await env.DB.prepare(`SELECT s.id,s.name,
      COALESCE((SELECT SUM(total_piastres) FROM purchase_invoices WHERE supplier_id=s.id AND status='received'),0) invoiced,
      COALESCE((SELECT SUM(amount_piastres) FROM supplier_payments WHERE supplier_id=s.id),0) paid FROM suppliers s WHERE s.status='active' ORDER BY s.name`).all()).results);
  }
  if (p === '/api/supplier-payments' && m === 'POST') {
    if (!can(user, 'purchases.pay')) throw new HttpErr(403, 'غير مصرح');
    const sid = +body.supplier_id, amt = money(body.amount, 'المبلغ'), rid = str(body.request_id, 64, 'المعرف');
    if (amt <= 0) throw new HttpErr(400, 'المبلغ يجب أن يكون أكبر من صفر');
    if (!(await env.DB.prepare("SELECT id FROM suppliers WHERE id=? AND status='active'").bind(sid).first())) throw new HttpErr(400, 'المورد غير موجود');
    if (await env.DB.prepare('SELECT 1 x FROM supplier_payments WHERE request_id=?').bind(rid).first()) return J({ ok: true, duplicate: true });
    let r;
    try {
      r = await env.DB.prepare(`INSERT INTO supplier_payments(supplier_id,amount_piastres,method,note,user_id,request_id)
        SELECT ?,?,?,?,?,? WHERE ? <= COALESCE((SELECT SUM(total_piastres) FROM purchase_invoices WHERE supplier_id=? AND status='received'),0)
          - COALESCE((SELECT SUM(amount_piastres) FROM supplier_payments WHERE supplier_id=?),0)`)
        .bind(sid, amt, String(body.method || 'cash').slice(0, 20), body.note ? String(body.note).slice(0, 200) : null, user.id, rid, amt, sid, sid).run();
    } catch (e) { if (/UNIQUE/i.test(e.message)) return J({ ok: true, duplicate: true }); throw e; }
    if (!r.meta.changes) throw new HttpErr(409, 'المبلغ أكبر من المستحق للمورد');
    await audit(env, user, 'supplier.payment', 'supplier_payments', r.meta.last_row_id, null, { sid, amt }); await broadcast(env, 'purchases'); return J({ ok: true }, 201);
  }
  if (p === '/api/purchases' && m === 'POST') {
    if (!can(user, 'purchases.create')) throw new HttpErr(403, 'غير مصرح');
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length || items.length > 50) throw new HttpErr(400, 'أضف من 1 إلى 50 صنفاً');
    const sid = +body.supplier_id, wid = +body.warehouse_id, rid = str(body.request_id, 64, 'المعرف');
    const lines = items.map(it => { const q = Number(it.qty); if (!Number.isFinite(q) || q <= 0) throw new HttpErr(400, 'كمية غير صالحة'); const c = money(it.unit_cost, 'سعر الوحدة'); return { mid: +it.material_id, q, c, t: Math.round(q * c) }; });
    const ids = [...new Set(lines.map(l => l.mid))];
    const okm = await env.DB.prepare(`SELECT COUNT(*) c FROM materials WHERE status='active' AND id IN (${ids.map(() => '?').join(',')})`).bind(...ids).first();
    const sup = await env.DB.prepare("SELECT id FROM suppliers WHERE id=? AND status='active'").bind(sid).first();
    const wh = await env.DB.prepare("SELECT id FROM warehouses WHERE id=? AND status='active'").bind(wid).first();
    if (okm.c !== ids.length || !sup || !wh) throw new HttpErr(400, 'المورد أو المخزن أو إحدى الخامات غير صحيحة');
    const sub = lines.reduce((a, l) => a + l.t, 0), disc = body.discount ? money(body.discount, 'الخصم') : 0, paid = body.paid ? money(body.paid, 'المدفوع') : 0;
    if (disc > sub) throw new HttpErr(400, 'الخصم أكبر من الإجمالي');
    const total = sub - disc; if (paid > total) throw new HttpErr(400, 'المدفوع أكبر من إجمالي الفاتورة');
    let id;
    try {
      id = (await env.DB.prepare('INSERT INTO purchase_invoices(supplier_id,warehouse_id,subtotal_piastres,discount_piastres,total_piastres,note,created_by,request_id) VALUES(?,?,?,?,?,?,?,?)')
        .bind(sid, wid, sub, disc, total, body.note ? String(body.note).slice(0, 200) : null, user.id, rid).run()).meta.last_row_id;
    } catch (e) {
      if (!/UNIQUE/i.test(e.message)) throw e;
      const ex = await env.DB.prepare('SELECT id,status FROM purchase_invoices WHERE request_id=?').bind(rid).first();
      if (ex.status === 'received') return J({ ok: true, duplicate: true, id: ex.id });
      id = ex.id; // محاولة سابقة لم تكتمل: نكملها
    }
    const db = env.DB, st = [];
    lines.forEach((l, i) => {
      st.push(db.prepare('INSERT INTO purchase_items(invoice_id,material_id,qty,unit_cost_piastres,line_total_piastres) VALUES(?,?,?,?,?)').bind(id, l.mid, l.q, l.c, l.t));
      st.push(db.prepare("INSERT INTO inventory_movements(material_id,warehouse_id,qty,kind,note,user_id,request_id) VALUES(?,?,?,'in',?,?,?)").bind(l.mid, wid, l.q, `فاتورة شراء #${id}`, user.id, `pi-${id}-${i}`));
    });
    if (paid) st.push(db.prepare('INSERT INTO supplier_payments(supplier_id,invoice_id,amount_piastres,method,user_id,request_id) VALUES(?,?,?,?,?,?)').bind(sid, id, paid, 'cash', user.id, `pip-${id}`));
    st.push(db.prepare("UPDATE purchase_invoices SET status='received',received_at=CURRENT_TIMESTAMP WHERE id=? AND status='draft'").bind(id));
    await db.batch(st);
    await audit(env, user, 'purchase.receive', 'purchase_invoices', id, null, { sid, wid, total, paid });
    await broadcast(env, 'purchases'); return J({ ok: true, id }, 201);
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