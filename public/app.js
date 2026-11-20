const $ = s => document.querySelector(s), app = $('#app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(t, err) { const e = $('#toast'); e.innerHTML = `<span class="${err ? 'e' : ''}">${esc(t)}</span>`; setTimeout(() => e.innerHTML = '', 3500); }
async function api(path, method = 'GET', data) {
  const r = await fetch('/api' + path, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'erp' }, body: data ? JSON.stringify(data) : undefined });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'خطأ'); return j;
}
let me, ws, retry = 0, products = [];
function login(setup) {
  app.innerHTML = `<form class="login" id="f"><h2>تسجيل الدخول</h2>
  ${setup ? '<input name="setup_key" placeholder="مفتاح ا��تهيئة" required><input name="name" placeholder="الاسم" required>' : ''}
  <input name="email" type="email" placeholder="البريد الإلكتروني" required><input name="password" type="password" placeholder="كلمة السر" required>
  <button>${setup ? 'إنشاء الحساب الإداري' : 'دخول'}</button><button type="button" class="ghost" id="t">${setup ? 'لدي حساب' : 'تهيئة أول مرة'}</button></form>`;
  $('#t').onclick = () => login(!setup);
  $('#f').onsubmit = async e => { e.preventDefault(); const d = Object.fromEntries(new FormData(e.target));
    try { if (setup) { await api('/setup', 'POST', d); toast('تم إنشاء الحساب، سجّل الدخول'); return login(false); } await api('/login', 'POST', d); start(); } catch (x) { toast(x.message, 1); } };
}
function connect() {
  ws = new WebSocket(`wss://${location.host}/api/ws`);
  ws.onopen = () => { retry = 0; load(); };
  ws.onmessage = e => { try { if (JSON.parse(e.data).type === 'products') load(); } catch {} };
  ws.onclose = () => { if (me) setTimeout(connect, Math.min(1000 * 2 ** retry++, 15000)); };
}
async function load() { try { products = await api('/products'); draw(); } catch (x) { toast(x.message, 1); } }
function draw() {
  $('#rows').innerHTML = products.map(p => `<tr><td>${esc(p.sku)}</td><td>${esc(p.name)}</td><td>${p.cost_piastres / 100}</td><td>${p.price_piastres / 100}</td>
  <td><button class="ghost" data-e="${p.id}">تعديل</button> <button class="danger" data-d="${p.id}">أرشفة</button></td></tr>`).join('') || '<tr><td colspan="5">لا توجد منتجات</td></tr>';
}
function start() {
  api('/me').then(u => { me = u;
    app.innerHTML = `<div class="shell"><nav class="side"><b>🪑 المصنع</b><button class="on">المنتجات</button><button id="out">تسجيل الخروج</button></nav>
    <main class="main"><div class="bar"><h2>المنتجات</h2><span>${esc(me.name)}</span></div>
    <form class="row" id="add"><input name="sku" placeholder="الكود" required><input name="name" placeholder="اسم المنتج" required>
    <input name="cost" type="number" step="0.01" min="0" placeholder="التكلفة (ج.م)" required><input name="price" type="number" step="0.01" min="0" placeholder="سعر البيع (ج.م)" required><button>إضافة</button></form>
    <div style="overflow-x:auto"><table><thead><tr><th>الكود</th><th>الاسم</th><th>التكلفة</th><th>السعر</th><th></th></tr></thead><tbody id="rows"></tbody></table></div></main></div>`;
    $('#out').onclick = async () => { me = null; ws?.close(); await api('/logout', 'POST', {}); login(false); };
    $('#add').onsubmit = async e => { e.preventDefault(); try { await api('/products', 'POST', Object.fromEntries(new FormData(e.target))); e.target.reset(); toast('تمت الإضافة'); } catch (x) { toast(x.message, 1); } };
    $('#rows').onclick = async e => { const d = e.target.dataset.d, ed = e.target.dataset.e;
      try { if (d && confirm('أرشفة هذا المنتج؟')) { await api('/products/' + d, 'DELETE'); toast('تمت الأرشفة'); }
        if (ed) { const p = products.find(x => x.id == ed), name = prompt('الاسم', p.name); if (!name) return;
          const cost = prompt('التكلفة', p.cost_piastres / 100), price = prompt('السعر', p.price_piastres / 100);
          await api('/products/' + ed, 'PUT', { name, cost, price, version: p.version }); toast('تم التعديل'); } } catch (x) { toast(x.message, 1); load(); } };
    connect(); }).catch(() => login(false));
}
start();
