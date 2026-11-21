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
  stage_defs: [['name', 'name', 's', 60, 'اسم المرحلة'], ['position', 'position', 'n', 0, 'الترتيب']],
  customers: [['name', 'name', 's', 80, 'الاسم'], ['phone', 'phone', 'o', 30, 'الهاتف'], ['address', 'address', 'o', 200, 'العنوان']],
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

const isoDate = d => d.toISOString().slice(0, 10);
function period(url) {
  const now = new Date(), f = url.searchParams.get('from') || isoDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))), t = url.searchParams.get('to') || isoDate(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f) || !/^\d{4}-\d{2}-\d{2}$/.test(t) || f > t) throw new HttpErr(400, 'الفترة غير صالحة');
  return [f, t];
}
const ORD = { open: 'جديد', in_progress: 'قيد التنفيذ', completed: 'مكتمل', cancelled: 'ملغي' };

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
  const gm = p.match(/^\/api\/(warehouses|materials|suppliers|customers|stage_defs)(?:\/(\d+))?$/);
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
  if (p === '/api/product-stock' && m === 'GET') {
    if (!can(user, 'pstock.view')) throw new HttpErr(403, 'غير مصرح');
    return J((await env.DB.prepare(`SELECT p.id product_id,p.sku,p.name,w.id warehouse_id,w.name warehouse,COALESCE(SUM(i.qty),0) qty
      FROM products p CROSS JOIN warehouses w LEFT JOIN product_movements i ON i.product_id=p.id AND i.warehouse_id=w.id
      WHERE p.status='active' AND w.status='active' GROUP BY p.id,w.id ORDER BY p.name,w.name`).all()).results);
  }
  if (p === '/api/product-stock/ledger' && m === 'GET') {
    if (!can(user, 'pstock.view')) throw new HttpErr(403, 'غير مصرح');
    return J((await env.DB.prepare(`SELECT i.id,i.qty,i.kind,i.note,i.created_at,p.name product,w.name warehouse,u.name user
      FROM product_movements i JOIN products p ON p.id=i.product_id JOIN warehouses w ON w.id=i.warehouse_id
      LEFT JOIN users u ON u.id=i.user_id ORDER BY i.id DESC LIMIT 50`).all()).results);
  }
  if (p === '/api/product-stock/move' && m === 'POST') {
    if (!can(user, 'pstock.move')) throw new HttpErr(403, 'غير مصرح');
    const kind = body.kind, sign = { opening: 1, in: 1, out: -1, damaged: -1, adjust: 0 }[kind];
    if (sign === undefined) throw new HttpErr(400, 'نوع الحركة غير صالح');
    let q = Number(body.qty); if (!Number.isFinite(q) || q === 0 || (sign && q < 0)) throw new HttpErr(400, 'الكمية غير صالحة');
    if (sign) q *= sign;
    const pid = +body.product_id, wid = +body.warehouse_id, rid = str(body.request_id, 64, 'المعرف');
    if (!(await env.DB.prepare("SELECT id FROM products WHERE id=? AND status='active'").bind(pid).first()) ||
        !(await env.DB.prepare("SELECT id FROM warehouses WHERE id=? AND status='active'").bind(wid).first())) throw new HttpErr(400, 'المنتج أو المخزن غير موجود');
    if (await env.DB.prepare('SELECT 1 x FROM product_movements WHERE request_id=?').bind(rid).first()) return J({ ok: true, duplicate: true });
    const r = await env.DB.prepare(`INSERT INTO product_movements(product_id,warehouse_id,qty,kind,note,user_id,request_id)
      SELECT ?,?,?,?,?,?,? WHERE (SELECT COALESCE(SUM(qty),0) FROM product_movements WHERE product_id=? AND warehouse_id=?)+? >= 0`)
      .bind(pid, wid, q, kind, body.note ? String(body.note).slice(0, 200) : null, user.id, rid, pid, wid, q).run();
    if (!r.meta.changes) throw new HttpErr(409, 'رصيد المنتج في هذا المخزن غير كافٍ');
    await audit(env, user, 'pstock.' + kind, 'product_movements', r.meta.last_row_id, null, { pid, wid, q }); await broadcast(env, 'pstock'); return J({ ok: true }, 201);
  }
  if (p === '/api/sales' && m === 'GET') {
    if (!can(user, 'sales.view')) throw new HttpErr(403, 'غير مصرح');
    return J((await env.DB.prepare(`SELECT i.id,i.total_piastres,i.created_at,c.name customer,w.name warehouse FROM sales_invoices i
      JOIN customers c ON c.id=i.customer_id JOIN warehouses w ON w.id=i.warehouse_id WHERE i.status='issued' ORDER BY i.id DESC LIMIT 50`).all()).results);
  }
  if (p === '/api/customer-balances' && m === 'GET') {
    if (!can(user, 'sales.view')) throw new HttpErr(403, 'غير مصرح');
    return J((await env.DB.prepare(`SELECT c.id,c.name,
      COALESCE((SELECT SUM(total_piastres) FROM sales_invoices WHERE customer_id=c.id AND status='issued'),0) invoiced,
      COALESCE((SELECT SUM(amount_piastres) FROM customer_payments WHERE customer_id=c.id),0) paid FROM customers c WHERE c.status='active' ORDER BY c.name`).all()).results);
  }
  if (p === '/api/customer-payments' && m === 'POST') {
    if (!can(user, 'sales.collect')) throw new HttpErr(403, 'غير مصرح');
    const cid = +body.customer_id, amt = money(body.amount, 'المبلغ'), rid = str(body.request_id, 64, 'المعرف');
    if (amt <= 0) throw new HttpErr(400, 'المبلغ يجب أن يكون أكبر من صفر');
    if (!(await env.DB.prepare("SELECT id FROM customers WHERE id=? AND status='active'").bind(cid).first())) throw new HttpErr(400, 'العميل غير موجود');
    if (await env.DB.prepare('SELECT 1 x FROM customer_payments WHERE request_id=?').bind(rid).first()) return J({ ok: true, duplicate: true });
    const r = await env.DB.prepare(`INSERT INTO customer_payments(customer_id,amount_piastres,method,note,user_id,request_id)
      SELECT ?,?,?,?,?,? WHERE ? <= COALESCE((SELECT SUM(total_piastres) FROM sales_invoices WHERE customer_id=? AND status='issued'),0)
        - COALESCE((SELECT SUM(amount_piastres) FROM customer_payments WHERE customer_id=?),0)`)
      .bind(cid, amt, String(body.method || 'cash').slice(0, 20), body.note ? String(body.note).slice(0, 200) : null, user.id, rid, amt, cid, cid).run();
    if (!r.meta.changes) throw new HttpErr(409, 'المبلغ أكبر من المستحق على العميل');
    await audit(env, user, 'customer.payment', 'customer_payments', r.meta.last_row_id, null, { cid, amt }); await broadcast(env, 'sales'); return J({ ok: true }, 201);
  }
  if (p === '/api/sales' && m === 'POST') {
    if (!can(user, 'sales.create')) throw new HttpErr(403, 'غير مصرح');
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length || items.length > 50) throw new HttpErr(400, 'أضف من 1 إلى 50 صنفاً');
    const cid = +body.customer_id, wid = +body.warehouse_id, rid = str(body.request_id, 64, 'المعرف');
    const lines = items.map(it => { const q = Number(it.qty); if (!Number.isFinite(q) || q <= 0) throw new HttpErr(400, 'كمية غير صالحة'); const c = money(it.unit_price, 'سعر الوحدة'); return { pid: +it.product_id, q, c, t: Math.round(q * c) }; });
    const ids = [...new Set(lines.map(l => l.pid))], ph = ids.map(() => '?').join(',');
    const prods = (await env.DB.prepare(`SELECT id,name FROM products WHERE status='active' AND id IN (${ph})`).bind(...ids).all()).results;
    const cust = await env.DB.prepare("SELECT id FROM customers WHERE id=? AND status='active'").bind(cid).first();
    const wh = await env.DB.prepare("SELECT id FROM warehouses WHERE id=? AND status='active'").bind(wid).first();
    if (prods.length !== ids.length || !cust || !wh) throw new HttpErr(400, 'العميل أو المخزن أو أحد المنتجات غير صحيح');
    const old = await env.DB.prepare('SELECT id,status FROM sales_invoices WHERE request_id=?').bind(rid).first();
    if (old?.status === 'issued') return J({ ok: true, duplicate: true, id: old.id });
    const need = {}; lines.forEach(l => need[l.pid] = (need[l.pid] || 0) + l.q);
    const bal = (await env.DB.prepare(`SELECT product_id,COALESCE(SUM(qty),0) q FROM product_movements WHERE warehouse_id=? AND product_id IN (${ph}) GROUP BY product_id`).bind(wid, ...ids).all()).results;
    for (const pr of prods) if ((bal.find(b => b.product_id === pr.id)?.q || 0) < need[pr.id] - 1e-9) throw new HttpErr(409, `الرصيد غير كافٍ للمنتج: ${pr.name}`);
    const sub = lines.reduce((a, l) => a + l.t, 0), disc = body.discount ? money(body.discount, 'الخصم') : 0, paid = body.paid ? money(body.paid, 'المدفوع') : 0;
    if (disc > sub) throw new HttpErr(400, 'الخصم أكبر من الإجمالي');
    const total = sub - disc; if (paid > total) throw new HttpErr(400, 'المدفوع أكبر من إجمالي الفاتورة');
    const id = old ? old.id : (await env.DB.prepare('INSERT INTO sales_invoices(customer_id,warehouse_id,subtotal_piastres,discount_piastres,total_piastres,note,created_by,request_id) VALUES(?,?,?,?,?,?,?,?)')
      .bind(cid, wid, sub, disc, total, body.note ? String(body.note).slice(0, 200) : null, user.id, rid).run()).meta.last_row_id;
    const db = env.DB, st = [];
    lines.forEach((l, i) => {
      st.push(db.prepare('INSERT INTO sales_items(invoice_id,product_id,qty,unit_price_piastres,line_total_piastres) VALUES(?,?,?,?,?)').bind(id, l.pid, l.q, l.c, l.t));
      st.push(db.prepare("INSERT INTO product_movements(product_id,warehouse_id,qty,kind,note,user_id,request_id) VALUES(?,?,?,'sale',?,?,?)").bind(l.pid, wid, -l.q, `فاتورة بيع #${id}`, user.id, `si-${id}-${i}`));
    });
    if (paid) st.push(db.prepare('INSERT INTO customer_payments(customer_id,invoice_id,amount_piastres,method,user_id,request_id) VALUES(?,?,?,?,?,?)').bind(cid, id, paid, 'cash', user.id, `sip-${id}`));
    // حارس: إن أصبح أي رصيد سالباً (بيع متزامن) يفشل الإدخال فتُلغى العملية كلها
    st.push(db.prepare('INSERT INTO _guard(x) SELECT NULL WHERE EXISTS (SELECT 1 FROM product_movements WHERE warehouse_id=? GROUP BY product_id HAVING SUM(qty) < -0.000001)').bind(wid));
    st.push(db.prepare("UPDATE sales_invoices SET status='issued',issued_at=CURRENT_TIMESTAMP WHERE id=? AND status='draft'").bind(id));
    try { await db.batch(st); } catch (e) { if (/NOT NULL/i.test(e.message)) throw new HttpErr(409, 'الرصيد لم يعد كافياً، حاول مرة أخرى'); throw e; }
    await audit(env, user, 'sale.issue', 'sales_invoices', id, null, { cid, wid, total, paid });
    await broadcast(env, 'sales'); return J({ ok: true, id }, 201);
  }
  if (p === '/api/bom' && m === 'GET') {
    if (!can(user, 'bom.view')) throw new HttpErr(403, 'غير مصرح');
    return J((await env.DB.prepare('SELECT c.material_id,c.qty_per_unit,m.name,m.unit FROM product_components c JOIN materials m ON m.id=c.material_id WHERE c.product_id=? ORDER BY m.name')
      .bind(+url.searchParams.get('product_id')).all()).results);
  }
  if (p === '/api/bom' && m === 'PUT') {
    if (!can(user, 'bom.edit')) throw new HttpErr(403, 'غير مصرح');
    const pid = +body.product_id, items = Array.isArray(body.items) ? body.items : [];
    if (items.length > 50) throw new HttpErr(400, 'عدد الخامات كبير');
    const ls = items.map(it => { const q = Number(it.qty); if (!Number.isFinite(q) || q <= 0) throw new HttpErr(400, 'كمية غير صالحة في الوصفة'); return { mid: +it.material_id, q }; });
    const ids = ls.map(l => l.mid); if (new Set(ids).size !== ids.length) throw new HttpErr(400, 'خامة مكررة في الوصفة');
    if (!(await env.DB.prepare("SELECT id FROM products WHERE id=? AND status='active'").bind(pid).first())) throw new HttpErr(400, 'المنتج غير موجود');
    if (ids.length) { const c = await env.DB.prepare(`SELECT COUNT(*) c FROM materials WHERE status='active' AND id IN (${ids.map(() => '?').join(',')})`).bind(...ids).first(); if (c.c !== ids.length) throw new HttpErr(400, 'إحدى الخامات غير موجودة'); }
    await env.DB.batch([env.DB.prepare('DELETE FROM product_components WHERE product_id=?').bind(pid),
      ...ls.map(l => env.DB.prepare('INSERT INTO product_components(product_id,material_id,qty_per_unit) VALUES(?,?,?)').bind(pid, l.mid, l.q))]);
    await audit(env, user, 'bom.save', 'product_components', pid, null, ls); await broadcast(env, 'bom'); return J({ ok: true });
  }
  if (p === '/api/production' && m === 'GET') {
    if (!can(user, 'production.view')) throw new HttpErr(403, 'غير مصرح');
    return J((await env.DB.prepare(`SELECT o.id,o.status,o.qty_planned,o.qty_good,o.qty_scrap,o.due_date,o.total_cost_piastres,p.name product,
      (SELECT COUNT(*) FROM production_order_stages WHERE order_id=o.id AND status='done') done,(SELECT COUNT(*) FROM production_order_stages WHERE order_id=o.id) total
      FROM production_orders o JOIN products p ON p.id=o.product_id ORDER BY o.id DESC LIMIT 50`).all()).results);
  }
  if (p === '/api/production' && m === 'POST') {
    if (!can(user, 'production.create')) throw new HttpErr(403, 'غير مصرح');
    const pid = +body.product_id, wid = +body.warehouse_id, rid = str(body.request_id, 64, 'المعرف'), qty = Number(body.qty);
    if (!Number.isFinite(qty) || qty <= 0) throw new HttpErr(400, 'الكمية غير صالحة');
    const due = body.due_date ? String(body.due_date) : null; if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new HttpErr(400, 'تاريخ غير صالح');
    if (!(await env.DB.prepare("SELECT id FROM products WHERE id=? AND status='active'").bind(pid).first()) ||
        !(await env.DB.prepare("SELECT id FROM warehouses WHERE id=? AND status='active'").bind(wid).first())) throw new HttpErr(400, 'المنتج أو المخزن غير موجود');
    const ex = await env.DB.prepare('SELECT id FROM production_orders WHERE request_id=?').bind(rid).first();
    if (ex) return J({ ok: true, duplicate: true, id: ex.id });
    if (!(await env.DB.prepare('SELECT COUNT(*) c FROM product_components WHERE product_id=?').bind(pid).first()).c) throw new HttpErr(400, 'حدّد وصفة التصنيع للمنتج أولاً');
    const defs = (await env.DB.prepare("SELECT name,position FROM stage_defs WHERE status='active' ORDER BY position,id").all()).results;
    const st = [env.DB.prepare('INSERT INTO production_orders(product_id,warehouse_id,qty_planned,due_date,note,created_by,request_id) VALUES(?,?,?,?,?,?,?)')
      .bind(pid, wid, qty, due, body.note ? String(body.note).slice(0, 200) : null, user.id, rid)];
    defs.forEach(d => st.push(env.DB.prepare('INSERT INTO production_order_stages(order_id,name,position) SELECT id,?,? FROM production_orders WHERE request_id=?').bind(d.name, d.position, rid)));
    await env.DB.batch(st);
    const id = (await env.DB.prepare('SELECT id FROM production_orders WHERE request_id=?').bind(rid).first()).id;
    await audit(env, user, 'production.create', 'production_orders', id, null, { pid, wid, qty }); await broadcast(env, 'production'); return J({ ok: true, id }, 201);
  }
  const po = p.match(/^\/api\/production\/(\d+)(?:\/(stage|complete|cancel))?$/);
  if (po) {
    const id = +po[1], act = po[2];
    const o = await env.DB.prepare('SELECT o.*,p.name product,w.name warehouse FROM production_orders o JOIN products p ON p.id=o.product_id JOIN warehouses w ON w.id=o.warehouse_id WHERE o.id=?').bind(id).first();
    if (!o) throw new HttpErr(404, 'غير موجود');
    if (!act && m === 'GET') {
      if (!can(user, 'production.view')) throw new HttpErr(403, 'غير مصرح');
      const stages = (await env.DB.prepare('SELECT id,name,position,status,done_at FROM production_order_stages WHERE order_id=? ORDER BY position,id').bind(id).all()).results;
      const mats = (await env.DB.prepare(`SELECT c.material_id,m.name,m.unit,c.qty_per_unit,
        COALESCE((SELECT SUM(qty) FROM inventory_movements WHERE material_id=c.material_id AND warehouse_id=?),0) have
        FROM product_components c JOIN materials m ON m.id=c.material_id WHERE c.product_id=? ORDER BY m.name`).bind(o.warehouse_id, o.product_id).all()).results;
      return J({ order: o, stages, mats });
    }
    if (m !== 'POST' || !act) throw new HttpErr(405, 'طريقة غير مدعومة');
    if (!['open', 'in_progress'].includes(o.status)) throw new HttpErr(409, 'هذا الأمر مغلق');
    if (act === 'stage') {
      if (!can(user, 'production.update')) throw new HttpErr(403, 'غير مصرح');
      const s = await env.DB.prepare('SELECT * FROM production_order_stages WHERE id=? AND order_id=?').bind(+body.stage_id, id).first();
      if (!s || s.status !== 'pending') throw new HttpErr(400, 'المرحلة غير صالحة');
      if (await env.DB.prepare("SELECT 1 x FROM production_order_stages WHERE order_id=? AND status='pending' AND (position<? OR (position=? AND id<?))").bind(id, s.position, s.position, s.id).first())
        throw new HttpErr(409, 'أكمل المراحل السابقة أولاً');
      await env.DB.batch([env.DB.prepare("UPDATE production_order_stages SET status='done',done_at=CURRENT_TIMESTAMP,done_by=? WHERE id=?").bind(user.id, s.id),
        env.DB.prepare("UPDATE production_orders SET status='in_progress',started_at=COALESCE(started_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(id)]);
      await audit(env, user, 'production.stage', 'production_orders', id, null, { stage: s.name }); await broadcast(env, 'production'); return J({ ok: true });
    }
    if (act === 'cancel') {
      if (!can(user, 'production.cancel')) throw new HttpErr(403, 'غير مصرح');
      await env.DB.prepare("UPDATE production_orders SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('open','in_progress')").bind(id).run();
      await audit(env, user, 'production.cancel', 'production_orders', id); await broadcast(env, 'production'); return J({ ok: true });
    }
    if (!can(user, 'production.complete')) throw new HttpErr(403, 'غير مصرح');
    if ((await env.DB.prepare("SELECT COUNT(*) c FROM production_order_stages WHERE order_id=? AND status='pending'").bind(id).first()).c) throw new HttpErr(409, 'أكمل كل مراحل التصنيع أولاً');
    const good = body.qty_good === '' || body.qty_good == null ? 0 : num(body.qty_good, 'الكمية الجيدة'), scrap = body.qty_scrap === '' || body.qty_scrap == null ? 0 : num(body.qty_scrap, 'الكمية التالفة');
    if (good + scrap <= 0) throw new HttpErr(400, 'أدخل كمية منتجة أو تالفة');
    const labor = body.labor ? money(body.labor, 'العمالة') : 0, over = body.overhead ? money(body.overhead, 'التشغيل') : 0;
    const comps = (await env.DB.prepare('SELECT c.material_id,c.qty_per_unit,m.name,m.unit_cost_piastres FROM product_components c JOIN materials m ON m.id=c.material_id WHERE c.product_id=?').bind(o.product_id).all()).results;
    if (!comps.length) throw new HttpErr(400, 'لا توجد وصفة تصنيع لهذا المنتج');
    const used = good + scrap, bal = (await env.DB.prepare('SELECT material_id,COALESCE(SUM(qty),0) q FROM inventory_movements WHERE warehouse_id=? GROUP BY material_id').bind(o.warehouse_id).all()).results;
    const short = comps.filter(c => (bal.find(b => b.material_id === c.material_id)?.q || 0) < used * c.qty_per_unit - 1e-9).map(c => c.name);
    if (short.length) throw new HttpErr(409, `خامات غير كافية في المخزن: ${short.join('، ')}`);
    const st = [env.DB.prepare("INSERT INTO _guard(x) SELECT NULL WHERE NOT EXISTS (SELECT 1 FROM production_orders WHERE id=? AND status IN ('open','in_progress'))").bind(id)];
    let matCost = 0;
    comps.forEach((c, i) => { const q = used * c.qty_per_unit; matCost += Math.round(q * c.unit_cost_piastres);
      st.push(env.DB.prepare("INSERT INTO inventory_movements(material_id,warehouse_id,qty,kind,note,user_id,request_id) VALUES(?,?,?,'out',?,?,?)").bind(c.material_id, o.warehouse_id, -q, `أمر تصنيع #${id}`, user.id, `po-${id}-m${i}`)); });
    if (good > 0) st.push(env.DB.prepare("INSERT INTO product_movements(product_id,warehouse_id,qty,kind,note,user_id,request_id) VALUES(?,?,?,'in',?,?,?)").bind(o.product_id, o.warehouse_id, good, `أمر تصنيع #${id}`, user.id, `po-${id}-p`));
    st.push(env.DB.prepare('INSERT INTO _guard(x) SELECT NULL WHERE EXISTS (SELECT 1 FROM inventory_movements WHERE warehouse_id=? GROUP BY material_id HAVING SUM(qty) < -0.000001)').bind(o.warehouse_id));
    st.push(env.DB.prepare("UPDATE production_orders SET status='completed',qty_good=?,qty_scrap=?,labor_piastres=?,overhead_piastres=?,material_cost_piastres=?,total_cost_piastres=?,completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .bind(good, scrap, labor, over, matCost, matCost + labor + over, id));
    try { await env.DB.batch(st); } catch (e) { if (/NOT NULL/i.test(e.message)) throw new HttpErr(409, 'تغيّرت الأرصدة أو أُغلق الأمر، حدّث الصفحة وحاول مرة أخرى'); throw e; }
    await audit(env, user, 'production.complete', 'production_orders', id, null, { good, scrap, matCost, labor, over }); await broadcast(env, 'production'); await broadcast(env, 'stock'); return J({ ok: true });
  }
  if (p === '/api/finance' && m === 'GET') {
    if (!can(user, 'finance.view')) throw new HttpErr(403, 'غير مصرح');
    return J((await env.DB.prepare("SELECT id,kind,category,amount_piastres,entry_date,note FROM finance_entries WHERE status='active' ORDER BY entry_date DESC,id DESC LIMIT 100").all()).results);
  }
  if (p === '/api/finance' && m === 'POST') {
    if (!can(user, 'finance.create')) throw new HttpErr(403, 'غير مصرح');
    const kind = body.kind; if (!['expense', 'revenue'].includes(kind)) throw new HttpErr(400, 'نوع غير صالح');
    const cat = str(body.category, 40, 'التصنيف'), amt = money(body.amount, 'المبلغ'), rid = str(body.request_id, 64, 'المعرف'), dt = String(body.entry_date || '');
    if (amt <= 0) throw new HttpErr(400, 'المبلغ يجب أن يكون أكبر من صفر');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dt)) throw new HttpErr(400, 'تاريخ غير صالح');
    let r; try { r = await env.DB.prepare('INSERT INTO finance_entries(kind,category,amount_piastres,entry_date,note,user_id,request_id) VALUES(?,?,?,?,?,?,?)')
      .bind(kind, cat, amt, dt, body.note ? String(body.note).slice(0, 200) : null, user.id, rid).run(); }
    catch (e) { if (/UNIQUE/i.test(e.message)) return J({ ok: true, duplicate: true }); throw e; }
    await audit(env, user, 'finance.' + kind, 'finance_entries', r.meta.last_row_id, null, { cat, amt, dt }); await broadcast(env, 'finance'); return J({ ok: true }, 201);
  }
  const fm = p.match(/^\/api\/finance\/(\d+)$/);
  if (fm && m === 'DELETE') {
    if (!can(user, 'finance.void')) throw new HttpErr(403, 'غير مصرح');
    const old = await env.DB.prepare("SELECT * FROM finance_entries WHERE id=? AND status='active'").bind(+fm[1]).first();
    if (!old) throw new HttpErr(404, 'غير موجود');
    await env.DB.prepare("UPDATE finance_entries SET status='void' WHERE id=?").bind(old.id).run();
    await audit(env, user, 'finance.void', 'finance_entries', old.id, old); await broadcast(env, 'finance'); return J({ ok: true });
  }
  if (p === '/api/dashboard' && m === 'GET') {
    if (!can(user, 'dashboard.view')) throw new HttpErr(403, 'غير مصرح');
    const [f, t] = period(url), db = env.DB, one = (sql, ...a) => db.prepare(sql).bind(...a).first(), all = async (sql, ...a) => (await db.prepare(sql).bind(...a).all()).results;
    const fmt = (Date.parse(t) - Date.parse(f)) / 864e5 > 62 ? '%Y-%m' : '%Y-%m-%d';
    const [sales, purch, coll, paid, fin, cogs, invM, invP, recv, pay, cnt, prod, low, recent, sS, pS, eS] = await Promise.all([
      one("SELECT COALESCE(SUM(total_piastres),0) t,COUNT(*) c FROM sales_invoices WHERE status='issued' AND date(issued_at) BETWEEN ? AND ?", f, t),
      one("SELECT COALESCE(SUM(total_piastres),0) t,COUNT(*) c FROM purchase_invoices WHERE status='received' AND date(received_at) BETWEEN ? AND ?", f, t),
      one('SELECT COALESCE(SUM(amount_piastres),0) t FROM customer_payments WHERE date(created_at) BETWEEN ? AND ?', f, t),
      one('SELECT COALESCE(SUM(amount_piastres),0) t FROM supplier_payments WHERE date(created_at) BETWEEN ? AND ?', f, t),
      all("SELECT kind,COALESCE(SUM(amount_piastres),0) t FROM finance_entries WHERE status='active' AND entry_date BETWEEN ? AND ? GROUP BY kind", f, t),
      one("SELECT COALESCE(SUM(ROUND(si.qty*p.cost_piastres)),0) t FROM sales_items si JOIN sales_invoices i ON i.id=si.invoice_id JOIN products p ON p.id=si.product_id WHERE i.status='issued' AND date(i.issued_at) BETWEEN ? AND ?", f, t),
      one("SELECT COALESCE(SUM(b.q*m.unit_cost_piastres),0) t FROM (SELECT material_id,SUM(qty) q FROM inventory_movements GROUP BY material_id) b JOIN materials m ON m.id=b.material_id WHERE m.status='active'"),
      one("SELECT COALESCE(SUM(b.q*p.cost_piastres),0) t FROM (SELECT product_id,SUM(qty) q FROM product_movements GROUP BY product_id) b JOIN products p ON p.id=b.product_id WHERE p.status='active'"),
      one("SELECT COALESCE((SELECT SUM(total_piastres) FROM sales_invoices WHERE status='issued'),0)-COALESCE((SELECT SUM(amount_piastres) FROM customer_payments),0) t"),
      one("SELECT COALESCE((SELECT SUM(total_piastres) FROM purchase_invoices WHERE status='received'),0)-COALESCE((SELECT SUM(amount_piastres) FROM supplier_payments),0) t"),
      one("SELECT (SELECT COUNT(*) FROM products WHERE status='active') products,(SELECT COUNT(*) FROM materials WHERE status='active') materials,(SELECT COUNT(*) FROM suppliers WHERE status='active') suppliers,(SELECT COUNT(*) FROM customers WHERE status='active') customers"),
      one("SELECT (SELECT COUNT(*) FROM production_orders WHERE status IN ('open','in_progress')) running,(SELECT COUNT(*) FROM production_orders WHERE status='completed' AND date(completed_at) BETWEEN ? AND ?) completed,(SELECT COUNT(*) FROM production_orders WHERE status IN ('open','in_progress') AND due_date IS NOT NULL AND due_date<date('now')) late", f, t),
      all("SELECT m.name,m.unit,m.min_stock,COALESCE(SUM(i.qty),0) q FROM materials m LEFT JOIN inventory_movements i ON i.material_id=m.id WHERE m.status='active' AND m.min_stock>0 GROUP BY m.id HAVING q<=m.min_stock ORDER BY q LIMIT 10"),
      all('SELECT a.action,a.entity,a.entity_id,a.created_at,u.name user FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 15'),
      all(`SELECT strftime('${fmt}',issued_at) d,SUM(total_piastres) t FROM sales_invoices WHERE status='issued' AND date(issued_at) BETWEEN ? AND ? GROUP BY d`, f, t),
      all(`SELECT strftime('${fmt}',received_at) d,SUM(total_piastres) t FROM purchase_invoices WHERE status='received' AND date(received_at) BETWEEN ? AND ? GROUP BY d`, f, t),
      all(`SELECT strftime('${fmt}',entry_date) d,SUM(amount_piastres) t FROM finance_entries WHERE status='active' AND kind='expense' AND entry_date BETWEEN ? AND ? GROUP BY d`, f, t)]);
    const exp = fin.find(x => x.kind === 'expense')?.t || 0, rev = fin.find(x => x.kind === 'revenue')?.t || 0;
    return J({ from: f, to: t, sales, purchases: purch, collected: coll.t, paid: paid.t, expenses: exp, other_revenue: rev, cogs: cogs.t, profit: sales.t + rev - cogs.t - exp,
      inv_materials: invM.t, inv_products: invP.t, receivable: recv.t, payable: pay.t, counts: cnt, production: prod, low, recent, series: { sales: sS, purchases: pS, expenses: eS } });
  }
  if (p === '/api/report' && m === 'GET') {
    if (!can(user, 'reports.view')) throw new HttpErr(403, 'غير مصرح');
    const type = url.searchParams.get('type'), [f, t] = period(url), all = async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).all()).results, E = v => v / 100;
    let cols, rows;
    if (type === 'sales') {
      cols = ['التاريخ', 'رقم الفاتورة', 'العميل', 'المخزن', 'الإجمالي', 'مدفوع وقت الفاتورة'];
      rows = (await all("SELECT i.id,date(i.issued_at) d,c.name c,w.name w,i.total_piastres t,COALESCE((SELECT SUM(amount_piastres) FROM customer_payments WHERE invoice_id=i.id),0) p FROM sales_invoices i JOIN customers c ON c.id=i.customer_id JOIN warehouses w ON w.id=i.warehouse_id WHERE i.status='issued' AND date(i.issued_at) BETWEEN ? AND ? ORDER BY i.id DESC LIMIT 1000", f, t)).map(r => [r.d, 'SI-' + r.id, r.c, r.w, E(r.t), E(r.p)]);
    } else if (type === 'purchases') {
      cols = ['التاريخ', 'رقم الفاتورة', 'المورد', 'المخزن', 'الإجمالي', 'مدفوع وقت الفاتورة'];
      rows = (await all("SELECT i.id,date(i.received_at) d,c.name c,w.name w,i.total_piastres t,COALESCE((SELECT SUM(amount_piastres) FROM supplier_payments WHERE invoice_id=i.id),0) p FROM purchase_invoices i JOIN suppliers c ON c.id=i.supplier_id JOIN warehouses w ON w.id=i.warehouse_id WHERE i.status='received' AND date(i.received_at) BETWEEN ? AND ? ORDER BY i.id DESC LIMIT 1000", f, t)).map(r => [r.d, 'PI-' + r.id, r.c, r.w, E(r.t), E(r.p)]);
    } else if (type === 'finance') {
      cols = ['التاريخ', 'النوع', 'التصنيف', 'المبلغ', 'ملاحظة'];
      rows = (await all("SELECT entry_date,kind,category,amount_piastres,note FROM finance_entries WHERE status='active' AND entry_date BETWEEN ? AND ? ORDER BY entry_date DESC,id DESC LIMIT 1000", f, t)).map(r => [r.entry_date, r.kind === 'expense' ? 'مصروف' : 'إيراد', r.category, E(r.amount_piastres), r.note || '']);
    } else if (type === 'stock') {
      cols = ['الخامة', 'الوحدة', 'الرصيد', 'سعر الوحدة', 'القيمة'];
      rows = (await all("SELECT m.name,m.unit,COALESCE(SUM(i.qty),0) q,m.unit_cost_piastres c FROM materials m LEFT JOIN inventory_movements i ON i.material_id=m.id WHERE m.status='active' GROUP BY m.id ORDER BY m.name")).map(r => [r.name, r.unit, r.q, E(r.c), E(Math.round(r.q * r.c))]);
    } else if (type === 'pstock') {
      cols = ['المنتج', 'الرصيد', 'تكلفة الوحدة المسجلة', 'القيمة'];
      rows = (await all("SELECT p.name,COALESCE(SUM(i.qty),0) q,p.cost_piastres c FROM products p LEFT JOIN product_movements i ON i.product_id=p.id WHERE p.status='active' GROUP BY p.id ORDER BY p.name")).map(r => [r.name, r.q, E(r.c), E(Math.round(r.q * r.c))]);
    } else if (type === 'production') {
      cols = ['التاريخ', 'رقم الأمر', 'المنتج', 'الحالة', 'المخطط', 'الجيد', 'التالف', 'إجمالي التكلفة'];
      rows = (await all("SELECT o.id,date(o.created_at) d,p.name,o.status,o.qty_planned,o.qty_good,o.qty_scrap,o.total_cost_piastres t FROM production_orders o JOIN products p ON p.id=o.product_id WHERE date(o.created_at) BETWEEN ? AND ? ORDER BY o.id DESC LIMIT 1000", f, t)).map(r => [r.d, 'MO-' + r.id, r.name, ORD[r.status], r.qty_planned, r.qty_good, r.qty_scrap, E(r.t)]);
    } else throw new HttpErr(400, 'نوع التقرير غير معروف');
    return J({ cols, rows });
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
