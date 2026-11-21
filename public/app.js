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
PAGES.suppliers = { t: 'الموردون', api: '/suppliers', f: [['name', 'اسم المورد', 'name'], ['phone', 'الهاتف', 'phone', '', 'o'], ['address', 'العنوان', 'address', '', 'o']] };
PAGES.customers = { t: 'العملاء', api: '/customers', f: [['name', 'اسم العميل', 'name'], ['phone', 'الهاتف', 'phone', '', 'o'], ['address', 'العنوان', 'address', '', 'o']] };
PAGES.stage_defs = { t: 'مراحل التصنيع (الترتيب بالأرقام)', api: '/stage_defs', f: [['name', 'اسم المرحلة', 'name'], ['position', 'الترتيب', 'position', 'n']] };
const NAV = [['dashboard', 'لوحة التحكم'], ['products', 'المنتجات'], ['materials', 'الخامات'], ['warehouses', 'المخازن'], ['stock', 'المخزون'], ['suppliers', 'الموردون'], ['purchases', 'المشتريات'], ['customers', 'العملاء'], ['sales', 'المبيعات'], ['pstock', 'مخزون المنتجات'], ['bom', 'وصفات التصنيع'], ['production', 'أوامر التصنيع'], ['stage_defs', 'مراحل التصنيع'], ['finance', 'المصروفات والإيرادات'], ['reports', 'التقارير']];
const KINDS = { opening: 'رصيد افتتاحي', in: 'دخول', out: 'صرف', damaged: 'تالف', adjust: 'تسوية (+/-)' };
let me, ws, retry = 0, page = 'dashboard', reload = () => {};

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
  ({ stock, purchases, sales, pstock, bom, production, dashboard, finance, reports }[p] || crud)(p);
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
async function purchases() {
  let sups = [], whs = [], mats = [];
  try { [sups, whs, mats] = await Promise.all([api('/suppliers'), api('/warehouses'), api('/materials')]); } catch (x) { toast(x.message, 1); }
  const opt = a => a.map(o => `<option value="${o.id}">${esc(o.name)}</option>`).join('');
  const line = () => `<div class="row ln"><select name="material_id">${opt(mats)}</select><input name="qty" type="number" step="any" min="0" placeholder="الكمية" required><input name="unit_cost" type="number" step="any" min="0" placeholder="سعر الوحدة (ج.م)" value="${mats[0] ? mats[0].unit_cost_piastres / 100 : ''}" required><button type="button" class="danger rm">حذف</button></div>`;
  let rid = crypto.randomUUID();
  $('#view').innerHTML = `<div class="bar"><h2>المشتريات</h2></div>
  <form id="pi"><div class="row"><select name="supplier_id" required>${opt(sups)}</select><select name="warehouse_id" required>${opt(whs)}</select></div>
  <div id="lines">${line()}</div><button type="button" class="ghost" id="addl">+ إضافة صنف</button>
  <div class="row" style="margin-top:10px"><input name="discount" type="number" step="any" min="0" placeholder="الخصم (ج.م)"><input name="paid" type="number" step="any" min="0" placeholder="المدفوع الآن (ج.م)"><input name="note" placeholder="ملاحظة"><button>اعتماد الفاتورة واستلامها</button></div></form>
  <h3>المستحق للموردين</h3><div style="overflow-x:auto"><table><thead><tr><th>المورد</th><th>إجمالي الفواتير</th><th>المدفوع</th><th>المتبقي</th><th></th></tr></thead><tbody id="due"></tbody></table></div>
  <h3>آخر الفواتير</h3><div style="overflow-x:auto"><table><thead><tr><th>رقم</th><th>التاريخ</th><th>المورد</th><th>المخزن</th><th>الإجمالي</th></tr></thead><tbody id="inv"></tbody></table></div>`;
  $('#addl').onclick = () => $('#lines').insertAdjacentHTML('beforeend', line());
  $('#lines').onclick = e => { if (e.target.classList.contains('rm') && document.querySelectorAll('.ln').length > 1) e.target.closest('.ln').remove(); };
  $('#lines').onchange = e => { if (e.target.name === 'material_id') { const m = mats.find(x => x.id == e.target.value); e.target.closest('.ln').querySelector('[name=unit_cost]').value = m ? m.unit_cost_piastres / 100 : ''; } };
  $('#pi').onsubmit = async e => { e.preventDefault(); const f = e.target;
    const items = [...document.querySelectorAll('.ln')].map(d => ({ material_id: d.querySelector('[name=material_id]').value, qty: d.querySelector('[name=qty]').value, unit_cost: d.querySelector('[name=unit_cost]').value }));
    try { await api('/purchases', 'POST', { supplier_id: f.supplier_id.value, warehouse_id: f.warehouse_id.value, discount: f.discount.value, paid: f.paid.value, note: f.note.value, items, request_id: rid });
      rid = crypto.randomUUID(); toast('تم اعتماد الفاتورة وإضافة الخامات للمخزن'); $('#lines').innerHTML = line(); f.discount.value = f.paid.value = f.note.value = ''; } catch (x) { toast(x.message, 1); } };
  $('#due').onclick = async e => { const id = e.target.dataset.pay; if (!id) return; const v = prompt('مبلغ السداد (ج.م)'); if (!v) return;
    try { await api('/supplier-payments', 'POST', { supplier_id: id, amount: v, request_id: crypto.randomUUID() }); toast('تم تسجيل السداد'); } catch (x) { toast(x.message, 1); } };
  reload = async () => { try { const [b, l] = await Promise.all([api('/supplier-balances'), api('/purchases')]);
    $('#due').innerHTML = b.map(r => `<tr><td>${esc(r.name)}</td><td>${r.invoiced / 100}</td><td>${r.paid / 100}</td><td>${(r.invoiced - r.paid) / 100}</td><td>${r.invoiced > r.paid ? `<button class="ghost" data-pay="${r.id}">سداد</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="5">أضف موردين أولاً</td></tr>';
    $('#inv').innerHTML = l.map(r => `<tr><td>PI-${r.id}</td><td>${esc(r.created_at)}</td><td>${esc(r.supplier)}</td><td>${esc(r.warehouse)}</td><td>${r.total_piastres / 100}</td></tr>`).join('') || '<tr><td colspan="5">لا توجد فواتير</td></tr>'; } catch (x) { toast(x.message, 1); } };
  reload();
}
async function sales() {
  let custs = [], whs = [], prods = [];
  try { [custs, whs, prods] = await Promise.all([api('/customers'), api('/warehouses'), api('/products')]); } catch (x) { toast(x.message, 1); }
  const opt = a => a.map(o => `<option value="${o.id}">${esc(o.name)}</option>`).join('');
  const line = () => `<div class="row ln"><select name="product_id">${opt(prods)}</select><input name="qty" type="number" step="any" min="0" placeholder="الكمية" required><input name="unit_price" type="number" step="any" min="0" placeholder="سعر الوحدة (ج.م)" value="${prods[0] ? prods[0].price_piastres / 100 : ''}" required><button type="button" class="danger rm">حذف</button></div>`;
  let rid = crypto.randomUUID();
  $('#view').innerHTML = `<div class="bar"><h2>المبيعات</h2></div>
  <form id="pi"><div class="row"><select name="customer_id" required>${opt(custs)}</select><select name="warehouse_id" required>${opt(whs)}</select></div>
  <div id="lines">${line()}</div><button type="button" class="ghost" id="addl">+ إضافة صنف</button>
  <div class="row" style="margin-top:10px"><input name="discount" type="number" step="any" min="0" placeholder="الخصم (ج.م)"><input name="paid" type="number" step="any" min="0" placeholder="المدفوع الآن (ج.م)"><input name="note" placeholder="ملاحظة"><button>إصدار الفاتورة</button></div></form>
  <h3>المستحق على العملاء</h3><div style="overflow-x:auto"><table><thead><tr><th>العميل</th><th>إجمالي الفواتير</th><th>المدفوع</th><th>المتبقي</th><th></th></tr></thead><tbody id="due"></tbody></table></div>
  <h3>آخر الفواتير</h3><div style="overflow-x:auto"><table><thead><tr><th>رقم</th><th>التاريخ</th><th>العميل</th><th>المخزن</th><th>الإجمالي</th></tr></thead><tbody id="inv"></tbody></table></div>`;
  $('#addl').onclick = () => $('#lines').insertAdjacentHTML('beforeend', line());
  $('#lines').onclick = e => { if (e.target.classList.contains('rm') && document.querySelectorAll('.ln').length > 1) e.target.closest('.ln').remove(); };
  $('#lines').onchange = e => { if (e.target.name === 'product_id') { const m = prods.find(x => x.id == e.target.value); e.target.closest('.ln').querySelector('[name=unit_price]').value = m ? m.price_piastres / 100 : ''; } };
  $('#pi').onsubmit = async e => { e.preventDefault(); const f = e.target;
    const items = [...document.querySelectorAll('.ln')].map(d => ({ product_id: d.querySelector('[name=product_id]').value, qty: d.querySelector('[name=qty]').value, unit_price: d.querySelector('[name=unit_price]').value }));
    try { await api('/sales', 'POST', { customer_id: f.customer_id.value, warehouse_id: f.warehouse_id.value, discount: f.discount.value, paid: f.paid.value, note: f.note.value, items, request_id: rid });
      rid = crypto.randomUUID(); toast('تم إصدار الفاتورة وخصم المنتجات من المخزن'); $('#lines').innerHTML = line(); f.discount.value = f.paid.value = f.note.value = ''; } catch (x) { toast(x.message, 1); } };
  $('#due').onclick = async e => { const id = e.target.dataset.pay; if (!id) return; const v = prompt('مبلغ التحصيل (ج.م)'); if (!v) return;
    try { await api('/customer-payments', 'POST', { customer_id: id, amount: v, request_id: crypto.randomUUID() }); toast('تم تسجيل التحصيل'); } catch (x) { toast(x.message, 1); } };
  reload = async () => { try { const [b, l] = await Promise.all([api('/customer-balances'), api('/sales')]);
    $('#due').innerHTML = b.map(r => `<tr><td>${esc(r.name)}</td><td>${r.invoiced / 100}</td><td>${r.paid / 100}</td><td>${(r.invoiced - r.paid) / 100}</td><td>${r.invoiced > r.paid ? `<button class="ghost" data-pay="${r.id}">تحصيل</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="5">أضف عملاء أولاً</td></tr>';
    $('#inv').innerHTML = l.map(r => `<tr><td>SI-${r.id}</td><td>${esc(r.created_at)}</td><td>${esc(r.customer)}</td><td>${esc(r.warehouse)}</td><td>${r.total_piastres / 100}</td></tr>`).join('') || '<tr><td colspan="5">لا توجد فواتير</td></tr>'; } catch (x) { toast(x.message, 1); } };
  reload();
}
async function pstock() {
  let mats = [], whs = [];
  try { [mats, whs] = await Promise.all([api('/products'), api('/warehouses')]); } catch (x) { toast(x.message, 1); }
  const opt = a => a.map(o => `<option value="${o.id}">${esc(o.name)}</option>`).join('');
  $('#view').innerHTML = `<div class="bar"><h2>مخزون المنتجات</h2></div>
  <form class="row" id="mv"><select name="product_id" required>${opt(mats)}</select><select name="warehouse_id" required>${opt(whs)}</select>
  <select name="kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
  <input name="qty" type="number" step="any" placeholder="الكمية" required><input name="note" placeholder="ملاحظة"><button>تسجيل الحركة</button></form>
  <h3>الأرصدة</h3><div style="overflow-x:auto"><table><thead><tr><th>المنتج</th><th>المخزن</th><th>الرصيد</th><th>الحالة</th></tr></thead><tbody id="bal"></tbody></table></div>
  <h3>آخر الحركات</h3><div style="overflow-x:auto"><table><thead><tr><th>التاريخ</th><th>المنتج</th><th>المخزن</th><th>النوع</th><th>الكمية</th><th>المستخدم</th></tr></thead><tbody id="led"></tbody></table></div>`;
  reload = async () => { try { const [s, l] = await Promise.all([api('/product-stock'), api('/product-stock/ledger')]);
    const tot = {}; s.forEach(r => tot[r.product_id] = (tot[r.product_id] || 0) + r.qty);
    $('#bal').innerHTML = s.map(r => `<tr><td>${esc(r.name)}</td><td>${esc(r.warehouse)}</td><td>${r.qty}</td><td>${r.qty <= 0 ? 'نفد' : 'متوفر'}</td></tr>`).join('') || '<tr><td colspan="4">أضف خامات ومخازن أولاً</td></tr>';
    $('#led').innerHTML = l.map(r => `<tr><td>${esc(r.created_at)}</td><td>${esc(r.product)}</td><td>${esc(r.warehouse)}</td><td>${(KINDS[r.kind] || 'بيع')}</td><td>${r.qty}</td><td>${esc(r.user)}</td></tr>`).join('') || '<tr><td colspan="6">لا توجد حركات</td></tr>'; } catch (x) { toast(x.message, 1); } };
  $('#mv').onsubmit = async e => { e.preventDefault(); const d = Object.fromEntries(new FormData(e.target)); d.request_id = crypto.randomUUID();
    try { await api('/product-stock/move', 'POST', d); e.target.qty.value = ''; e.target.note.value = ''; toast('تم تسجيل الحركة'); } catch (x) { toast(x.message, 1); } };
  reload();
}
async function bom() {
  let prods = [], mats = [];
  try { [prods, mats] = await Promise.all([api('/products'), api('/materials')]); } catch (x) { toast(x.message, 1); }
  const line = (mid = '', q = '') => `<div class="row ln"><select name="material_id">${mats.map(o => `<option value="${o.id}" ${o.id == mid ? 'selected' : ''}>${esc(o.name)} (${esc(o.unit)})</option>`).join('')}</select><input name="qty" type="number" step="any" min="0" placeholder="الكمية للوحدة الواحدة" value="${q}" required><button type="button" class="danger rm">حذف</button></div>`;
  $('#view').innerHTML = `<div class="bar"><h2>وصفات التصنيع</h2></div><form id="bf"><div class="row"><select name="product_id">${prods.map(o => `<option value="${o.id}">${esc(o.name)}</option>`).join('')}</select></div>
  <p>الخامات اللازمة لتصنيع <b>وحدة واحدة</b> من المنتج:</p><div id="lines"></div><button type="button" class="ghost" id="addl">+ إضافة خامة</button> <button>حفظ الوصفة</button></form>`;
  const loadB = async () => { const pid = $('#bf').product_id.value; if (!pid) return; try { const r = await api('/bom?product_id=' + pid); $('#lines').innerHTML = r.length ? r.map(x => line(x.material_id, x.qty_per_unit)).join('') : line(); } catch (x) { toast(x.message, 1); } };
  $('#bf').product_id.onchange = loadB;
  $('#addl').onclick = () => $('#lines').insertAdjacentHTML('beforeend', line());
  $('#lines').onclick = e => { if (e.target.classList.contains('rm') && document.querySelectorAll('.ln').length > 1) e.target.closest('.ln').remove(); };
  $('#bf').onsubmit = async e => { e.preventDefault(); const items = [...document.querySelectorAll('.ln')].map(d => ({ material_id: d.querySelector('[name=material_id]').value, qty: d.querySelector('[name=qty]').value }));
    try { await api('/bom', 'PUT', { product_id: e.target.product_id.value, items }); toast('تم حفظ الوصفة'); } catch (x) { toast(x.message, 1); } };
  reload = () => {}; loadB();
}
const ST = { open: 'جديد', in_progress: 'قيد التنفيذ', completed: 'مكتمل', cancelled: 'ملغي' };
async function production() {
  let prods = [], whs = [], cur = 0, rid = crypto.randomUUID(), list = [];
  try { [prods, whs] = await Promise.all([api('/products'), api('/warehouses')]); } catch (x) { toast(x.message, 1); }
  const opt = a => a.map(o => `<option value="${o.id}">${esc(o.name)}</option>`).join('');
  $('#view').innerHTML = `<div class="bar"><h2>أوامر التصنيع</h2></div>
  <form class="row" id="po"><select name="product_id" required>${opt(prods)}</select><select name="warehouse_id" required>${opt(whs)}</select><input name="qty" type="number" step="any" min="0" placeholder="الكمية المطلوبة" required><input name="due_date" type="date"><input name="note" placeholder="ملاحظة"><button>إنشاء أمر تصنيع</button></form>
  <div style="overflow-x:auto"><table><thead><tr><th>رقم</th><th>المنتج</th><th>الكمية</th><th>المراحل</th><th>الموعد</th><th>الحالة</th><th>تكلفة الوحدة</th><th></th></tr></thead><tbody id="ol"></tbody></table></div><div id="det"></div>`;
  const today = new Date().toISOString().slice(0, 10);
  const draw = () => { $('#ol').innerHTML = list.map(r => { const late = r.due_date && r.due_date < today && ['open', 'in_progress'].includes(r.status);
    return `<tr><td>MO-${r.id}</td><td>${esc(r.product)}</td><td>${r.status === 'completed' ? r.qty_good + ' (تالف ' + r.qty_scrap + ')' : r.qty_planned}</td><td>${r.done}/${r.total}</td><td>${esc(r.due_date || '')}${late ? ' ⚠️ متأخر' : ''}</td><td>${ST[r.status]}</td><td>${r.status === 'completed' && r.qty_good > 0 ? (r.total_cost_piastres / r.qty_good / 100).toFixed(2) : ''}</td><td><button class="ghost" data-o="${r.id}">تفاصيل</button></td></tr>`; }).join('') || '<tr><td colspan="8">لا توجد أوامر</td></tr>'; };
  const det = async () => { if (!cur) return; try { const { order: o, stages, mats } = await api('/production/' + cur); const open = ['open', 'in_progress'].includes(o.status); const nextId = (stages.find(s => s.status === 'pending') || {}).id;
    $('#det').innerHTML = `<div class="card"><h3>MO-${o.id}: ${esc(o.product)} — ${ST[o.status]}</h3>
    <b>المراحل</b><ul>${stages.map(s => `<li>${s.status === 'done' ? '✅' : '⬜'} ${esc(s.name)} ${open && s.id === nextId ? `<button class="ghost" data-s="${s.id}">تم</button>` : ''}</li>`).join('') || '<li>لا توجد مراحل</li>'}</ul>
    <b>الخامات المطلوبة للكمية المخططة (${o.qty_planned})</b><div style="overflow-x:auto"><table><thead><tr><th>الخامة</th><th>المطلوب</th><th>المتاح في ${esc(o.warehouse)}</th></tr></thead><tbody>${mats.map(m => `<tr><td>${esc(m.name)}</td><td>${+(m.qty_per_unit * o.qty_planned).toFixed(3)} ${esc(m.unit)}</td><td>${m.have >= m.qty_per_unit * o.qty_planned ? '' : '⚠️ '}${m.have}</td></tr>`).join('')}</tbody></table></div>
    ${o.status === 'completed' ? `<p>الكمية الجيدة: ${o.qty_good} | التالف: ${o.qty_scrap}<br>تكلفة الخامات: ${o.material_cost_piastres / 100} | العمالة: ${o.labor_piastres / 100} | التشغيل: ${o.overhead_piastres / 100}<br><b>الإجمالي: ${o.total_cost_piastres / 100} ج.م</b></p>` : ''}
    ${open ? `<form class="row" id="cf"><input name="qty_good" type="number" step="any" min="0" placeholder="الكمية الجيدة" required><input name="qty_scrap" type="number" step="any" min="0" placeholder="الكمية التالفة"><input name="labor" type="number" step="any" min="0" placeholder="تكلفة العمالة (ج.م)"><input name="overhead" type="number" step="any" min="0" placeholder="مصروفات التشغيل (ج.م)"><button>إتمام التصنيع واستلام المنتج</button></form><button class="danger" data-c="1">إلغاء الأمر</button>` : ''}</div>`; } catch (x) { toast(x.message, 1); } };
  reload = async () => { try { list = await api('/production'); draw(); det(); } catch (x) { toast(x.message, 1); } };
  $('#po').onsubmit = async e => { e.preventDefault(); const d = Object.fromEntries(new FormData(e.target)); d.request_id = rid;
    try { const r = await api('/production', 'POST', d); rid = crypto.randomUUID(); e.target.qty.value = ''; e.target.note.value = ''; cur = r.id; toast('تم إنشاء الأمر'); } catch (x) { toast(x.message, 1); } };
  $('#ol').onclick = e => { if (e.target.dataset.o) { cur = +e.target.dataset.o; det(); } };
  $('#det').onclick = async e => { try { if (e.target.dataset.s) { await api(`/production/${cur}/stage`, 'POST', { stage_id: e.target.dataset.s }); toast('تم إنهاء المرحلة'); }
    if (e.target.dataset.c && confirm('إلغاء أمر التصنيع؟')) { await api(`/production/${cur}/cancel`, 'POST', {}); toast('تم الإلغاء'); } } catch (x) { toast(x.message, 1); } };
  $('#det').onsubmit = async e => { e.preventDefault(); if (!confirm('سيتم خصم الخامات وإضافة المنتج للمخزن. متأكدة؟')) return;
    try { await api(`/production/${cur}/complete`, 'POST', Object.fromEntries(new FormData(e.target))); toast('تم إتمام التصنيع'); } catch (x) { toast(x.message, 1); } };
  reload();
}
const money2 = v => (v / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const isoD = d => d.toLocaleDateString('en-CA');
function chart(s) {
  const keys = [...new Set([...s.sales, ...s.purchases, ...s.expenses].map(r => r.d))].sort();
  if (!keys.length) return '<p>لا توجد حركة مسجلة في هذه الفترة</p>';
  const get = (a, k) => (a.find(r => r.d === k) || {}).t || 0, max = Math.max(1, ...keys.flatMap(k => [get(s.sales, k), get(s.purchases, k), get(s.expenses, k)]));
  const W = Math.max(320, keys.length * 44), H = 200, cols = ['#8b63ff', '#c9b8ff', '#ff8fb1'];
  const g = keys.map((k, i) => [s.sales, s.purchases, s.expenses].map((a, j) => { const h = Math.round(get(a, k) / max * (H - 30)); return `<rect x="${i * 44 + 6 + j * 12}" y="${H - 20 - h}" width="10" height="${h}" fill="${cols[j]}" rx="2"/>`; }).join('') + `<text x="${i * 44 + 22}" y="${H - 5}" font-size="9" text-anchor="middle" fill="currentColor">${esc(k.slice(-5))}</text>`).join('');
  return `<div style="overflow-x:auto"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${g}</svg></div><p><span style="color:#8b63ff">■</span> المبيعات &nbsp; <span style="color:#c9b8ff">■</span> المشتريات &nbsp; <span style="color:#ff8fb1">■</span> المصروفات</p>`;
}
async function dashboard() {
  const now = new Date(); let from = isoD(new Date(now.getFullYear(), now.getMonth(), 1)), to = isoD(now);
  $('#view').innerHTML = `<div class="bar"><h2>لوحة التحكم</h2></div><div class="row" id="rg"><button class="ghost" data-r="day">اليوم</button><button class="ghost" data-r="week">الأسبوع</button><button class="ghost" data-r="month">الشهر</button><button class="ghost" data-r="year">السنة</button><input type="date" id="df" value="${from}"><input type="date" id="dt" value="${to}"><button id="dg">عرض</button></div><div id="dash"></div>`;
  $('#rg').onclick = e => { const r = e.target.dataset.r; if (r) { to = isoD(now); from = r === 'day' ? to : r === 'week' ? isoD(new Date(now - 6 * 864e5)) : r === 'month' ? isoD(new Date(now.getFullYear(), now.getMonth(), 1)) : isoD(new Date(now.getFullYear(), 0, 1)); $('#df').value = from; $('#dt').value = to; reload(); }
    if (e.target.id === 'dg') { from = $('#df').value; to = $('#dt').value; reload(); } };
  const card = (t, v, c = '') => `<div class="stat ${c}"><span>${t}</span><b>${v}</b></div>`;
  reload = async () => { try { const d = await api(`/dashboard?from=${from}&to=${to}`);
    $('#dash').innerHTML = `<p>الفترة: ${esc(d.from)} إلى ${esc(d.to)} (التواريخ بتوقيت UTC)</p><div class="stats">
    ${card('المبيعات (' + d.sales.c + ' فاتورة)', money2(d.sales.t))}${card('المشتريات (' + d.purchases.c + ' فاتورة)', money2(d.purchases.t))}${card('المصروفات', money2(d.expenses), 'bad')}${card('إيرادات أخرى', money2(d.other_revenue))}
    ${card('تكلفة المبيعات التقديرية', money2(d.cogs))}${card('الربح التقديري', money2(d.profit), d.profit >= 0 ? 'good' : 'bad')}${card('المحصّل من العملاء', money2(d.collected))}${card('المدفوع للموردين', money2(d.paid))}
    ${card('قيمة مخزون الخامات', money2(d.inv_materials))}${card('قيمة مخزون المنتجات', money2(d.inv_products))}${card('مستحق على العملاء', money2(d.receivable))}${card('مستحق للموردين', money2(d.payable))}
    ${card('أوامر تصنيع جارية', d.production.running)}${card('أوامر متأخرة', d.production.late, d.production.late ? 'bad' : '')}${card('أوامر اكتملت بالفترة', d.production.completed)}
    ${card('منتجات / خامات', d.counts.products + ' / ' + d.counts.materials)}${card('موردون / عملاء', d.counts.suppliers + ' / ' + d.counts.customers)}</div>
    <p class="hint">الربح التقديري = المبيعات + الإيرادات الأخرى − تكلفة المبيعات (بتكلفة المنتج المسجلة في صفحة المنتجات) − المصروفات.</p>
    <h3>المبيعات والمشتريات والمصروفات</h3>${chart(d.series)}
    <h3>تنبيهات نقص الخامات</h3><div style="overflow-x:auto"><table><thead><tr><th>الخامة</th><th>الرصيد</th><th>حد إعادة الطلب</th></tr></thead><tbody>${d.low.map(r => `<tr><td>${esc(r.name)}</td><td>⚠️ ${r.q} ${esc(r.unit)}</td><td>${r.min_stock}</td></tr>`).join('') || '<tr><td colspan="3">لا توجد خامات تحت الحد</td></tr>'}</tbody></table></div>
    <h3>آخر العمليات</h3><div style="overflow-x:auto"><table><thead><tr><th>الوقت</th><th>المستخدم</th><th>العملية</th></tr></thead><tbody>${d.recent.map(r => `<tr><td>${esc(r.created_at)}</td><td>${esc(r.user)}</td><td>${esc(r.action)} ${esc(r.entity || '')} ${esc(r.entity_id || '')}</td></tr>`).join('')}</tbody></table></div>`; } catch (x) { toast(x.message, 1); } };
  reload();
}
const FCAT = { expense: ['تشغيل', 'رواتب', 'إيجار', 'كهرباء ومياه', 'صيانة', 'نقل وشحن', 'مصروفات إدارية', 'أخرى'], revenue: ['إيرادات أخرى', 'أخرى'] };
async function finance() {
  let rid = crypto.randomUUID();
  const cats = k => FCAT[k].map(c => `<option>${c}</option>`).join('');
  $('#view').innerHTML = `<div class="bar"><h2>المصروفات والإيرادات الأخرى</h2></div><form class="row" id="ff"><select name="kind"><option value="expense">مصروف</option><option value="revenue">إيراد آخر</option></select><select name="category">${cats('expense')}</select>
  <input name="amount" type="number" step="any" min="0" placeholder="المبلغ (ج.م)" required><input name="entry_date" type="date" value="${isoD(new Date())}" required><input name="note" placeholder="ملاحظة"><button>تسجيل</button></form>
  <p class="hint">مبيعات العملاء ومشتريات الموردين بتتسجل تلقائياً من صفحاتها، وهنا بتسجلي المصروفات والإيرادات الأخرى بس.</p>
  <div style="overflow-x:auto"><table><thead><tr><th>التاريخ</th><th>النوع</th><th>التصنيف</th><th>المبلغ</th><th>ملاحظة</th><th></th></tr></thead><tbody id="fl"></tbody></table></div>`;
  $('#ff').kind.onchange = e => { $('#ff').category.innerHTML = cats(e.target.value); };
  reload = async () => { try { const r = await api('/finance');
    $('#fl').innerHTML = r.map(x => `<tr><td>${esc(x.entry_date)}</td><td>${x.kind === 'expense' ? 'مصروف' : 'إيراد'}</td><td>${esc(x.category)}</td><td>${money2(x.amount_piastres)}</td><td>${esc(x.note || '')}</td><td><button class="danger" data-v="${x.id}">إلغاء</button></td></tr>`).join('') || '<tr><td colspan="6">لا توجد حركات</td></tr>'; } catch (x) { toast(x.message, 1); } };
  $('#ff').onsubmit = async e => { e.preventDefault(); const d = Object.fromEntries(new FormData(e.target)); d.request_id = rid;
    try { await api('/finance', 'POST', d); rid = crypto.randomUUID(); e.target.amount.value = ''; e.target.note.value = ''; toast('تم التسجيل'); } catch (x) { toast(x.message, 1); } };
  $('#fl').onclick = async e => { const v = e.target.dataset.v; if (!v || !confirm('إلغاء هذه الحركة؟ (تبقى محفوظة في سجل العمليات)')) return;
    try { await api('/finance/' + v, 'DELETE'); toast('تم الإلغاء'); } catch (x) { toast(x.message, 1); } };
  reload();
}
const RP = { sales: 'تقرير المبيعات', purchases: 'تقرير المشتريات', finance: 'المصروفات والإيرادات', stock: 'أرصدة الخامات', pstock: 'أرصدة المنتجات', production: 'أوامر التصنيع' };
async function reports() {
  const now = new Date(); let data = null, label = '';
  $('#view').innerHTML = `<div class="bar noprint"><h2>التقارير</h2></div><div class="row noprint"><select id="rt">${Object.entries(RP).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
  <input type="date" id="rf" value="${isoD(new Date(now.getFullYear(), now.getMonth(), 1))}"><input type="date" id="rto" value="${isoD(now)}"><button id="rs">عرض</button><button class="ghost" id="rx">تصدير Excel (CSV)</button><button class="ghost" id="rp">طباعة / PDF</button></div><div id="rep"></div>`;
  reload = () => {};
  $('#rs').onclick = async () => { try { const t = $('#rt').value; data = await api(`/report?type=${t}&from=${$('#rf').value}&to=${$('#rto').value}`);
    label = RP[t] + (['stock', 'pstock'].includes(t) ? '' : ` (${$('#rf').value} إلى ${$('#rto').value})`);
    $('#rep').innerHTML = `<h3>${esc(label)}</h3><div style="overflow-x:auto"><table><thead><tr>${data.cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${data.rows.map(r => `<tr>${r.map(v => `<td>${esc(v)}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${data.cols.length}">لا توجد بيانات</td></tr>`}</tbody></table></div>`; } catch (x) { toast(x.message, 1); } };
  $('#rx').onclick = () => { if (!data) return toast('اعرضي التقرير أولاً', 1);
    const csv = [data.cols, ...data.rows].map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' })); a.download = `report-${$('#rt').value}.csv`; a.click(); };
  $('#rp').onclick = () => { if (!data) return toast('اعرضي التقرير أولاً', 1); window.print(); };
}
function start() {
  api('/me').then(u => { me = u;
    app.innerHTML = `<div class="shell"><nav class="side"><b>🪑 المصنع</b>${NAV.map(n => `<button data-p="${n[0]}">${n[1]}</button>`).join('')}<button id="out">تسجيل الخروج</button></nav><main class="main"><div id="view"></div></main></div>`;
    document.querySelectorAll('.side [data-p]').forEach(b => b.onclick = () => go(b.dataset.p));
    $('#out').onclick = async () => { me = null; ws?.close(); await api('/logout', 'POST', {}); login(false); };
    go(page); connect(); }).catch(() => login(false));
}
start();
