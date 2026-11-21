const $ = s => document.querySelector(s), app = $('#app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(t, err) { const e = $('#toast'); e.innerHTML = `<span class="${err ? 'e' : ''}">${esc(t)}</span>`; setTimeout(() => e.innerHTML = '', 3500); }
async function api(path, method = 'GET', data) {
  const r = await fetch('/api' + path, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'erp' }, body: data ? JSON.stringify(data) : undefined });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'خطأ'); return j;
}
// حقل: [المفتاح، العنوان، عمود الجدول، نوع(m=مبلغ، n=رقم)، o=اختياري]
const PAGES = {
  products: { t: 'المنتجات', api: '/products', f: [['sku', 'الكود', 'sku'], ['name', 'الاسم', 'name'], ['cost', 'التكلفة (ج.م)', 'cost_piastres', 'm'], ['price', 'سعر البيع (ج.م)', 'price_piastres', 'm']] },
  materials: { t: 'الخامات', api: '/materials', f: [['sku', 'الكود', 'sku'], ['name', 'الاسم', 'name'], ['unit', 'الوحدة (متر، كيلو...)', 'unit'], ['unit_cost', 'سعر الشراء (ج.م)', 'unit_cost_piastres', 'm'], ['min_stock', 'حد إعادة الطلب', 'min_stock', 'n']] },
  warehouses: { t: 'المخازن', api: '/warehouses', f: [['name', 'اسم المخزن', 'name'], ['location', 'الموقع', 'location', '', 'o']] }
};
const NAV = [['products', 'المنتجات'], ['materials', 'الخامات'], ['warehouses', 'المخازن'], ['stock', 'المخزون']];
const KINDS = { opening: 'رصيد افتتاحي', in: 'دخول', out: 'صرف', damaged: 'تالف', adjust: 'تسوية (+/-)' };
let me, ws, retry = 0, page = 'products', reload = () => {};

function login(setup) {
  app.innerHTML = `<form class="login" id="f"><h2>تسجيل الدخول</h2>
  ${setup ? '<input name="setup_key" placeholder="مفتاح التهيئة" required><input name="name" placeholder="الاسم" required>' : ''}
  <input name="email" type="email" placeholder="البريد الإلكتروني" required><input name="password" type="password" placeholder="كلمة السر" required>
  <button>${setup ? 'إنشاء الحساب الإداري' : 'دخول'}</button><button type="button" class="ghost" id="t">${setup ? 'لدي حساب' : 'تهيئة أول مرة'}</button></form>`;
  $('#t').onclick = () => login(!setup);
  $('#f').onsubmit = async e => { e.preventDefault(); const d = Object.fromEntries(new FormData(e.target));
    try { if (setup) { await api('/setup', 'POST', d); toast('تم إنشاء الحساب، سجّل الدخول'); return login(false); } await api('/login', 'POST', d); start(); } catch (x) { toast(x.message, 1); } };
}
function connect() {
  ws = new WebSocket(`wss://${location.host}/api/ws`);
  ws.onopen = () => { retry = 0; reload(); };
  ws.onmessage = () => reload();
  ws.onclose = () => { if (me) setTimeout(connect, Math.min(1000 * 2 ** retry++, 15000)); };
}
function go(p) {
  page = p; document.querySelectorAll('.side [data-p]').forEach(b => b.classList.toggle('on', b.dataset.p === p));
  (p === 'stock' ? stock : crud)(p);
}
async function crud(p) {
  const P = PAGES[p]; let rows = [];
  const val = (r, f) => f[3] === 'm' ? r[f[2]] / 100 : r[f[2]];
  $('#view').innerHTML = `<div class="bar"><h2>${P.t}</h2></div><form class="row" id="add">${P.f.map(f => `<input name="${f[0]}" placeholder="${f[1]}" ${f[3] ? 'type="number" step="any" min="0"' : ''} ${f[4] ? '' : 'required'}>`).join('')}<button>إضافة</button></form>
  <div style="overflow-x:auto"><table><thead><tr>${P.f.map(f => `<th>${f[1]}</th>`).join('')}<th></th></tr></thead><tbody id="rows"></tbody></table></div>`;
  reload = async () => { try { rows = await api(P.api);
    $('#rows').innerHTML = rows.map(r => `<tr>${P.f.map(f => `<td>${esc(val(r, f))}</td>`).join('')}<td><button class="ghost" data-e="${r.id}">تعديل</button> <button class="danger" data-d="${r.id}">أرشفة</button></td></tr>`).join('') || '<tr><td colspan="9">لا توجد بيانات بعد</td></tr>'; } catch (x) { toast(x.message, 1); } };
  $('#add').onsubmit = async e => { e.preventDefault(); try { await api(P.api, 'POST', Object.fromEntries(new FormData(e.target))); e.target.reset(); toast('تمت الإضافة'); } catch (x) { toast(x.message, 1); } };
  $('#rows').onclick = async e => { const d = e.target.dataset.d, ed = e.target.dataset.e;
    try { if (d && confirm('أرشفة هذا السجل؟')) { await api(P.api + '/' + d, 'DELETE'); toast('تمت الأرشفة'); }
      if (ed) { const r = rows.find(x => x.id == ed), body = { version: r.version };
        for (const f of P.f) { if (f[0] === 'sku') { body.sku = r.sku; continue; } const v = prompt(f[1], val(r, f) ?? ''); if (v === null) return; body[f[0]] = v; }
        await api(P.api + '/' + ed, 'PUT', body); toast('تم التعديل'); } } catch (x) { toast(x.message, 1); reload(); } };
  reload();
}
async function stock() {
  let mats = [], whs = [];
  try { [mats, whs] = await Promise.all([api('/materials'), api('/warehouses')]); } catch (x) { toast(x.message, 1); }
  const opt = a => a.map(o => `<option value="${o.id}">${esc(o.name)}</option>`).join('');
  $('#view').innerHTML = `<div class="bar"><h2>المخزون</h2></div>
  <form class="row" id="mv"><select name="material_id" required>${opt(mats)}</select><select name="warehouse_id" required>${opt(whs)}</select>
  <select name="kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
  <input name="qty" type="number" step="any" placeholder="الكمية" required><input name="note" placeholder="ملاحظة"><button>تسجيل الحركة</button></form>
  <h3>الأرصدة</h3><div style="overflow-x:auto"><table><thead><tr><th>الخامة</th><th>المخزن</th><th>الرصيد</th><th>الحالة</th></tr></thead><tbody id="bal"></tbody></table></div>
  <h3>آخر الحركات</h3><div style="overflow-x:auto"><table><thead><tr><th>التاريخ</th><th>الخامة</th><th>المخزن</th><th>النوع</th><th>الكمية</th><th>المستخدم</th></tr></thead><tbody id="led"></tbody></table></div>`;
  reload = async () => { try { const [s, l] = await Promise.all([api('/stock'), api('/stock/ledger')]);
    const tot = {}; s.forEach(r => tot[r.material_id] = (tot[r.material_id] || 0) + r.qty);
    $('#bal').innerHTML = s.map(r => `<tr><td>${esc(r.name)}</td><td>${esc(r.warehouse)}</td><td>${r.qty} ${esc(r.unit)}</td><td>${tot[r.material_id] <= r.min_stock ? '⚠️ منخفض' : 'جيد'}</td></tr>`).join('') || '<tr><td colspan="4">أضف خامات ومخازن أولاً</td></tr>';
    $('#led').innerHTML = l.map(r => `<tr><td>${esc(r.created_at)}</td><td>${esc(r.material)}</td><td>${esc(r.warehouse)}</td><td>${KINDS[r.kind]}</td><td>${r.qty}</td><td>${esc(r.user)}</td></tr>`).join('') || '<tr><td colspan="6">لا توجد حركات</td></tr>'; } catch (x) { toast(x.message, 1); } };
  $('#mv').onsubmit = async e => { e.preventDefault(); const d = Object.fromEntries(new FormData(e.target)); d.request_id = crypto.randomUUID();
    try { await api('/stock/move', 'POST', d); e.target.qty.value = ''; e.target.note.value = ''; toast('تم تسجيل الحركة'); } catch (x) { toast(x.message, 1); } };
  reload();
}
function start() {
  api('/me').then(u => { me = u;
    app.innerHTML = `<div class="shell"><nav class="side"><b>🪑 المصنع</b>${NAV.map(n => `<button data-p="${n[0]}">${n[1]}</button>`).join('')}<button id="out">تسجيل الخروج</button></nav><main class="main"><div id="view"></div></main></div>`;
    document.querySelectorAll('.side [data-p]').forEach(b => b.onclick = () => go(b.dataset.p));
    $('#out').onclick = async () => { me = null; ws?.close(); await api('/logout', 'POST', {}); login(false); };
    go(page); connect(); }).catch(() => login(false));
}
start();