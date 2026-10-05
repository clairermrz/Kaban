/* =========================================================
   STATE
========================================================= */
const NAV_ITEMS = [
  {id:'dashboard', label:'Dashboard', icon:'house'},
  {id:'income', label:'Income', icon:'receipt'},
  {id:'expenses', label:'Expenses', icon:'shopping-bag', match:['necessities','extra','playjar']},
  {id:'savings', label:'Savings', icon:'piggy-bank'},
  {id:'debts', label:'Debts', icon:'credit-card'},
  {id:'calendar', label:'Calendar', icon:'calendar-days'},
  {id:'annual', label:'Reports', icon:'chart-column'},
  {id:'settings', label:'Settings', icon:'settings'}
];
const EXPENSE_SECTIONS = ['necessities','extra','playjar'];
let curExpenseSection = 'necessities';
/* Phone bottom bar: four destinations plus the centre Add button; everything else lives under More. */
const BOTTOM_NAV = [
  {id:'dashboard', label:'Home', icon:'house'},
  {id:'expenses', label:'Expenses', icon:'shopping-bag', match:['necessities','extra','playjar']},
  {id:'__add'},
  {id:'calendar', label:'Calendar', icon:'calendar-days'},
  {id:'__more', label:'More', icon:'ellipsis', match:['income','savings','debts','annual','settings']}
];

function firstMondayOfYear(y){
  let d = new Date(y,0,1);
  while(d.getDay()!==1){ d.setDate(d.getDate()+1); }
  return d;
}
function toISO(d){
  const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), dd=String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${dd}`;
}

function defaultSettings(){
  return {
    householdName:'',
    currency:'PHP',
    earners:[], // [{id, name, schedule:{type, anchor?, days?, day?}}] — see EARNER / PAYDAY helpers
    onboarded:false,
    allocations:{necessities:50, savings:30, extra:10, playjar:10},
    categoryDefaults:{necessities:{}, extra:{}, playjar:{}},
    savingsAmountDefault:0,
    categoryTree:{
      necessities: leafCatTree(['Bills','Subscriptions','Food','Groceries','Transportation','Utilities','Household','Medical','Miscellaneous']),
      extra: leafCatTree(['Shopping','Dining Out','Gifts','Personal','Beauty','Entertainment','Travel','Miscellaneous']),
      playjar: leafCatTree(['Restaurants','Coffee','Hobbies','Entertainment','Dates','Shopping','Games','Travel','Miscellaneous'])
    },
    dashboardPrefs:{
      view:'detailed',
      order:['moneyWentChart','cashFlowCard','debtPaydown','budgetVsActual','dailyAllowance','upcoming','whereMoneyWent','monthComparison','monthProgress','healthSnapshot','notes'],
      hidden:{}
    },
    savingsGoals:[
      {id:'g-emergency', name:'Emergency Fund', allocation:40, target:null, active:true},
      {id:'g-vacation', name:'Vacation', allocation:20, target:null, active:true},
      {id:'g-investments', name:'Investments', allocation:25, target:null, active:true},
      {id:'g-house', name:'House', allocation:15, target:null, active:true}
    ]
  };
}
function leafCatTree(names){ return names.map(name=>({id:uid('cat'), name, subs:[], inactiveFrom:null})); }
function getCategoryTree(section){ return state.settings.categoryTree[section]; }
/* A category (main or sub) is active for a given month if it was never deactivated,
   or the deactivation only took effect from a later month onward. */
function isCategoryActiveForMonth(node, monthKeyParam){
  return !node.inactiveFrom || monthKeyParam < node.inactiveFrom;
}
function defaultMonth(){
  return {
    income:[],
    necessities:{expenses:[], budgetOverrides:{}},
    extra:{expenses:[], budgetOverrides:{}},
    playjar:{expenses:[], budgetOverrides:{}},
    savingsActuals:{},
    savingsAmountOverride:null,
    savingsGoalAllocOverrides:{},
    rollover:{necessities:null, extra:null, playjar:null},
    notes:''
  };
}
function defaultState(){
  return { settings: defaultSettings(), recurringBills: [], recurringIncome: [], months: {}, debts: [] };
}

/* Replaced with the signed-in user's data by bootApp() (called from cloud.js). */
let state = defaultState();

/* Migrate a flat {name:number} or {name:{own,subs}} defaults map to the new shape */
function migrateDefaultsMap(map){
  const out = {};
  Object.entries(map||{}).forEach(([name,val])=>{
    if(val && typeof val==='object') out[name] = {own: val.own!==undefined?val.own:0, subs: val.subs||{}};
    else out[name] = {own: Number(val)||0, subs:{}};
  });
  return out;
}
/* Categories used to live per-month, which meant a category (and its budget) only existed in
   whichever month you happened to create it — brand new months always started from the generic
   defaults. This merges every month's categories ever seen into one shared, global tree so a
   category set up once is available identically in every month, past and future. */
function buildGlobalCategoryTree(s){
  const sections = ['necessities','extra','playjar'];
  const result = {};
  sections.forEach(sec=>{
    const mainOrder = [];
    const subsByMain = new Map();
    Object.values(s.months||{}).forEach(m=>{
      const secObj = m[sec];
      if(!secObj) return;
      let tree = secObj.categoryTree;
      if(!tree && secObj.categories) tree = secObj.categories.map(name=>({name, subs:[]}));
      if(!tree) return;
      tree.forEach(main=>{
        if(!subsByMain.has(main.name)){ subsByMain.set(main.name, []); mainOrder.push(main.name); }
        const subArr = subsByMain.get(main.name);
        (main.subs||[]).forEach(sub=>{ if(!subArr.includes(sub.name)) subArr.push(sub.name); });
      });
    });
    result[sec] = mainOrder.length ? mainOrder.map(name=>({id:uid('cat'), name, inactiveFrom:null, subs:subsByMain.get(name).map(sn=>({id:uid('sub'), name:sn, inactiveFrom:null}))})) : null;
  });
  return result;
}
/* Migrate a month section's old flat categories/budgetOverrides into the new nested-override shape.
   Category structure itself is no longer stored per-month — see buildGlobalCategoryTree. */
function migrateSection(sec){
  if(!sec) return;
  delete sec.categoryTree;
  delete sec.categories;
  const newOv = {};
  Object.entries(sec.budgetOverrides||{}).forEach(([name,val])=>{
    if(val && typeof val==='object') newOv[name] = {own: val.own, subs: val.subs||{}};
    else newOv[name] = {own: Number(val), subs:{}};
  });
  sec.budgetOverrides = newOv;
  (sec.expenses||[]).forEach(e=>{
    if(e.mainCategory===undefined){ e.mainCategory = e.category; e.subCategory = null; delete e.category; }
  });
}
function migrateRecurring(b){
  if(b.expectedAmount!==undefined) return b; // already migrated
  const dueDay = Math.min(31, Math.max(1, Number(b.dueDay)||1));
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), Math.min(dueDay, new Date(now.getFullYear(), now.getMonth()+1, 0).getDate()));
  return {
    id:b.id, name:b.name, section:b.section,
    mainCategory: b.category || 'Miscellaneous', subCategory: null,
    expectedAmount: Number(b.amount)||0,
    frequency:'monthly', customIntervalDays:null,
    startDate: toISO(start), endDate:null, notes:'', active:true
  };
}
function normalizeState(s){
  if(!s.settings.categoryDefaults) s.settings.categoryDefaults = {necessities:{}, extra:{}, playjar:{}};
  ['necessities','extra','playjar'].forEach(sec=>{
    s.settings.categoryDefaults[sec] = migrateDefaultsMap(s.settings.categoryDefaults[sec]||{});
  });
  if(!s.settings.categoryTree){
    const merged = buildGlobalCategoryTree(s);
    const fallback = defaultSettings().categoryTree;
    s.settings.categoryTree = {
      necessities: merged.necessities || fallback.necessities,
      extra: merged.extra || fallback.extra,
      playjar: merged.playjar || fallback.playjar
    };
  }
  ['necessities','extra','playjar'].forEach(sec=>{
    s.settings.categoryTree[sec].forEach(main=>{
      if(main.inactiveFrom===undefined) main.inactiveFrom = null;
      (main.subs||[]).forEach(sub=>{ if(sub.inactiveFrom===undefined) sub.inactiveFrom = null; });
    });
  });
  if(!s.settings.dashboardPrefs) s.settings.dashboardPrefs = defaultSettings().dashboardPrefs;
  Object.values(s.months||{}).forEach(m=>{
    ['necessities','extra','playjar'].forEach(sec=> migrateSection(m[sec]));
  });
  if(!s.debts) s.debts = [];
  s.debts.forEach(d=>{ if(!d.payments) d.payments = []; if(!d.lateFee) d.lateFee = {mode:'none', amount:null, percent:null}; });
  (s.settings.savingsGoals||[]).forEach(g=>{ if(g.active===undefined) g.active = true; });
  if(s.settings.savingsAmountDefault===undefined) s.settings.savingsAmountDefault = 0;
  Object.values(s.months||{}).forEach(m=>{
    if(m.savingsAmountOverride===undefined){
      // Migrate the old single "custom target" override into the new monthly-savings-amount override.
      m.savingsAmountOverride = (m.savingsTargetOverride!==undefined && m.savingsTargetOverride!==null) ? m.savingsTargetOverride : null;
    }
    delete m.savingsTargetOverride;
    if(!m.savingsGoalAllocOverrides) m.savingsGoalAllocOverrides = {};
  });
  s.recurringBills = (s.recurringBills||[]).map(migrateRecurring);
  if(!Array.isArray(s.recurringIncome)) s.recurringIncome = [];
  migrateEarners(s);
  if(!s.settings.currency) s.settings.currency = 'PHP';
  if(s.settings.householdName===undefined) s.settings.householdName = '';
  return s;
}
/* Income used to be hardcoded to two people ("Me" on a biweekly anchor, "Chad" on the 5th/20th).
   Earners are now a configurable list, and income.person stores the earner's id. Older exports
   are converted here so they import cleanly. */
function migrateEarners(s){
  const st = s.settings;
  if(!st.earners){
    st.earners = [];
    if(st.meAnchorPayday){
      st.earners.push({id:'earner_me', name:'Me', schedule:{type:'biweekly', anchor:st.meAnchorPayday}});
      st.earners.push({id:'earner_chad', name:'Chad', schedule:{type:'semimonthly', days:[5,20]}});
    }
    // Anything that already had data predates onboarding, so don't send it through setup again.
    st.onboarded = true;
  }
  delete st.meAnchorPayday;
  const byId = new Map(st.earners.map(e=>[e.id, e]));
  Object.values(s.months||{}).forEach(m=>{
    (m.income||[]).forEach(inc=>{
      if(byId.has(inc.person)) return;
      let match = st.earners.find(e=>e.name===inc.person);
      if(!match){
        match = {id:uid('earner'), name:String(inc.person||'Unknown'), schedule:{type:'none'}};
        st.earners.push(match); byId.set(match.id, match);
      }
      inc.person = match.id;
    });
  });
}
/* Turn an imported/loaded object into a valid state, or throw if it isn't one. */
function coerceState(parsed){
  if(!parsed || typeof parsed!=='object' || !parsed.settings || !parsed.months) throw new Error('bad format');
  if(!parsed.recurringBills) parsed.recurringBills = [];
  return normalizeState(parsed);
}
/* Called by cloud.js once the user's data is loaded (or with null for a brand new account). */
function bootApp(data){
  state = data ? coerceState(data) : defaultState();
  document.getElementById('app').hidden = false;
  applyChartTheme();
  renderAll();
  if(!state.settings.onboarded) openOnboardingModal();
}
function getState(){ return state; }
/* Swap in a newer copy of the data (e.g. saved from another device) without leaving the current view. */
function replaceState(data){
  state = coerceState(data);
  renderAll();
}
function saveState(){
  if(window.Store) Store.persist(state);
}
function uid(prefix){ return (prefix||'id')+'_'+Math.random().toString(36).slice(2,10); }

function monthKey(y,mi){ return `${y}-${String(mi+1).padStart(2,'0')}`; }
function prevMonthKey(y,mi){ return mi===0 ? monthKey(y-1,11) : monthKey(y,mi-1); }
function ensureMonth(key){
  if(!state.months[key]) state.months[key] = defaultMonth();
  return state.months[key];
}
function getMonth(key, createIfMissing){
  if(state.months[key]) return state.months[key];
  return createIfMissing ? ensureMonth(key) : null;
}

/* current selected month/year */
const today = new Date();
let cur = { year: today.getFullYear(), monthIndex: today.getMonth() };
let curView = 'dashboard';
let curYearForAnnual = today.getFullYear();
let curDebtTab = 'overview';
let curDebtDetailId = null;
let curDebtSearch = '';
let curDebtTypeFilter = 'all';
let curDebtStatusFilter = 'all';
let curCalFilters = {paydays:true, recurring:true, expenses:true, debts:true};
let curDashboardMoneyView = 'actual';
let curShowCompletedDebts = false;
let curShowDeactivatedGoals = false;
let curExpandedCats = {}; // key: `${section}|${mainCategoryName}` -> true when opened; categories start collapsed

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

/* =========================================================
   FORMATTERS / HELPERS
========================================================= */
const CURRENCIES = [
  ['PHP','Philippine Peso'],['USD','US Dollar'],['EUR','Euro'],['GBP','British Pound'],['CAD','Canadian Dollar'],
  ['AUD','Australian Dollar'],['NZD','New Zealand Dollar'],['SGD','Singapore Dollar'],['HKD','Hong Kong Dollar'],
  ['MYR','Malaysian Ringgit'],['IDR','Indonesian Rupiah'],['THB','Thai Baht'],['VND','Vietnamese Dong'],
  ['JPY','Japanese Yen'],['KRW','South Korean Won'],['CNY','Chinese Yuan'],['INR','Indian Rupee'],
  ['AED','UAE Dirham'],['SAR','Saudi Riyal'],['QAR','Qatari Riyal'],['KWD','Kuwaiti Dinar'],
  ['CHF','Swiss Franc'],['SEK','Swedish Krona'],['NOK','Norwegian Krone'],['DKK','Danish Krone'],
  ['ZAR','South African Rand'],['NGN','Nigerian Naira'],['MXN','Mexican Peso'],['BRL','Brazilian Real']
];
const _fmtCache = {};
function moneyFormatter(fractionDigits){
  const code = (state && state.settings && state.settings.currency) || 'PHP';
  const k = code+'|'+fractionDigits;
  if(!_fmtCache[k]){
    const opts = {style:'currency', currency:code, minimumFractionDigits:fractionDigits, maximumFractionDigits:2};
    try{ _fmtCache[k] = new Intl.NumberFormat(undefined, {...opts, currencyDisplay:'narrowSymbol'}); }
    catch(e){ _fmtCache[k] = new Intl.NumberFormat(undefined, opts); }
  }
  return _fmtCache[k];
}
function money(n){
  n = Number(n); if(!isFinite(n)) n = 0;
  if(Math.abs(n) < 0.005) n = 0; // avoid "-₱0"
  return moneyFormatter((Math.abs(n)%1!==0)?2:0).format(n);
}
function currencySymbol(){
  const part = moneyFormatter(0).formatToParts(0).find(p=>p.type==='currency');
  return part ? part.value : ((state && state.settings.currency) || '');
}
function currencyName(code){ const c = CURRENCIES.find(x=>x[0]===code); return c ? c[1] : code; }
function pct(n, digits){
  if(!isFinite(n)) n=0;
  return n.toFixed(digits===undefined?0:digits)+'%';
}
function daysInMonth(y,mi){ return new Date(y, mi+1, 0).getDate(); }
function fmtDateHuman(iso){
  if(!iso) return '';
  const [y,m,d] = iso.split('-').map(Number);
  const dt = new Date(y, m-1, d);
  return dt.toLocaleDateString('en-US',{month:'short', day:'numeric'});
}
function escapeHtml(s){
  return String(s===undefined||s===null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* =========================================================
   UI KIT — icons, dialogs, menus, toasts, form helpers, chart theme
========================================================= */
/* Lucide icon as an inline SVG string, e.g. icon('trash-2'). */
const _iconCache = {};
function icon(name, cls){
  const k = name+'|'+(cls||'');
  if(_iconCache[k]) return _iconCache[k];
  const pascal = name.split('-').map(p=>p.charAt(0).toUpperCase()+p.slice(1)).join('');
  const node = window.lucide && window.lucide.icons && window.lucide.icons[pascal];
  const inner = node ? node.map(([tag, attrs])=>`<${tag} ${Object.entries(attrs).map(([a,v])=>`${a}="${v}"`).join(' ')}/>`).join('') : '';
  return _iconCache[k] = `<svg class="ic ${cls||''}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}
function cssVar(name){ return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

/* Promise-based dialogs that sit above any open modal.
   askDialog({title, message, fields:[{id,label,type,value,placeholder,money,required}], confirmLabel, tone}) → values | null */
function askDialog(opts){
  return new Promise(resolve=>{
    const root = document.getElementById('dialogRoot');
    const fields = opts.fields || [];
    const toneIcon = opts.tone==='danger' ? 'triangle-alert' : opts.tone==='warn' ? 'circle-alert' : (opts.icon || null);
    root.innerHTML = `<div class="modal-backdrop dialog-layer" data-dlg-backdrop>
      <div class="modal-card dialog-card" role="dialog" aria-modal="true" aria-labelledby="dlgTitle">
        ${toneIcon?`<div class="dialog-icon ${opts.tone||''}">${icon(toneIcon)}</div>`:''}
        <h3 id="dlgTitle">${escapeHtml(opts.title||'')}</h3>
        ${opts.message?`<p class="dialog-msg">${escapeHtml(opts.message)}</p>`:''}
        ${fields.length?`<form id="dlgForm" style="margin-top:14px;">${fields.map(f=> f.type==='icon' ? iconFieldHtml(`dlg-${f.id}`, f.value, f.label, {nameSrc:f.nameFrom?`dlg-${f.nameFrom}`:'', tone:f.tone, allowAuto:f.allowAuto, autoIcon:f.autoIcon}) : `
          <div class="field"><label for="dlg-${f.id}">${escapeHtml(f.label)}</label>
          ${f.money ? moneyInputHtml(`dlg-${f.id}`, f.value, f.placeholder) :
            `<input type="${f.type||'text'}" id="dlg-${f.id}" value="${escapeHtml(f.value==null?'':f.value)}" placeholder="${escapeHtml(f.placeholder||'')}" ${f.type==='number'?'step="0.01" min="0"':''} autocomplete="off">`}
          </div>`).join('')}<div id="dlgError" class="warn-text" style="display:none;"></div></form>`:''}
        <div class="modal-actions">
          ${opts.hideCancel?'':`<button type="button" class="btn btn-ghost" data-dlg="cancel">${escapeHtml(opts.cancelLabel||'Cancel')}</button>`}
          <button type="button" class="btn ${opts.tone==='danger'?'btn-danger-solid':'btn-primary'}" data-dlg="ok">${escapeHtml(opts.confirmLabel||'OK')}</button>
        </div>
      </div></div>`;
    const close = (val)=>{ root.innerHTML=''; document.removeEventListener('keydown', onKey, true); resolve(val); };
    const submit = ()=>{
      const vals = {};
      for(const f of fields){
        const v = document.getElementById('dlg-'+f.id).value.trim();
        if(f.required && !v){ const er = document.getElementById('dlgError'); er.textContent = `Enter ${f.label.toLowerCase()}.`; er.style.display='block'; return; }
        vals[f.id] = v;
      }
      if(opts.validate){ const msg = opts.validate(vals); if(msg){ const er = document.getElementById('dlgError'); er.textContent = msg; er.style.display='block'; return; } }
      close(fields.length ? vals : true);
    };
    const onKey = (e)=>{ if(e.key==='Escape'){ e.stopPropagation(); close(null); } };
    document.addEventListener('keydown', onKey, true);
    root.querySelector('[data-dlg=ok]').addEventListener('click', submit);
    const cancel = root.querySelector('[data-dlg=cancel]'); if(cancel) cancel.addEventListener('click', ()=>close(null));
    root.querySelector('[data-dlg-backdrop]').addEventListener('click', (e)=>{ if(e.target.hasAttribute('data-dlg-backdrop')) close(null); });
    const form = document.getElementById('dlgForm');
    if(form){ form.addEventListener('submit', (e)=>{ e.preventDefault(); submit(); }); enhanceForm(form); wireIconFields(form); }
    const first = root.querySelector('input:not([type=hidden])') || root.querySelector('[data-dlg=ok]');
    setTimeout(()=>{ first.focus(); if(first.select) first.select(); }, 30);
  });
}
function alertDialog(title, message, tone){ return askDialog({title, message, tone: tone||'warn', confirmLabel:'Got it', hideCancel:true}); }
function confirmDialog(title, message, opts){ return askDialog(Object.assign({title, message, confirmLabel:'Confirm'}, opts||{})).then(Boolean); }

/* Floating menu anchored to an element (a bottom sheet on phones). items: [{label, icon, tone, onClick} | {sep:true} | {heading}] */
function openMenu(anchor, items, opts){
  closeMenu();
  const root = document.getElementById('popoverRoot');
  const isPhone = window.matchMedia('(max-width:900px)').matches;
  root.innerHTML = `<div class="menu-shield" style="position:fixed;inset:0;z-index:249;${isPhone?'background:var(--overlay);':''}"></div>
    <div class="popover ${isPhone?'sheet':''}" role="menu">${opts && opts.html ? opts.html : items.map((it,i)=>{
      if(it.sep) return '<div class="menu-sep"></div>';
      if(it.heading) return `<div class="menu-label">${escapeHtml(it.heading)}</div>`;
      const tone = it.tone || 'accent';
      return `<button class="menu-item" role="menuitem" data-mi="${i}">${it.icon?`<span class="menu-ic" style="background:var(--${tone}-tint);color:var(--${tone==='accent'?'accent':tone});">${icon(it.icon)}</span>`:''}<span>${escapeHtml(it.label)}</span></button>`;
    }).join('')}</div>`;
  const pop = root.querySelector('.popover');
  if(!isPhone){
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight;
    let left = (opts && opts.align==='left') ? r.left : r.right - w;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = r.bottom + 6; if(top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    pop.style.left = left+'px'; pop.style.top = top+'px';
  }
  root.querySelector('.menu-shield').addEventListener('click', closeMenu);
  pop.querySelectorAll('[data-mi]').forEach(b=> b.addEventListener('click', ()=>{ const it = items[Number(b.dataset.mi)]; closeMenu(); it.onClick(); }));
  document.addEventListener('keydown', menuEsc, true);
  return pop;
}
function menuEsc(e){ if(e.key==='Escape'){ e.stopPropagation(); closeMenu(); } }
function closeMenu(){ document.getElementById('popoverRoot').innerHTML=''; document.removeEventListener('keydown', menuEsc, true); }

/* Toasts, optionally with an action such as Undo. */
function toast(msg, opts){
  opts = opts || {};
  const host = document.getElementById('toastHost');
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = `<span>${escapeHtml(msg)}</span>${opts.action?`<button type="button">${escapeHtml(opts.action)}</button>`:''}`;
  host.appendChild(t);
  const timer = setTimeout(()=>t.remove(), opts.action ? 6000 : 2400);
  if(opts.action) t.querySelector('button').addEventListener('click', ()=>{ clearTimeout(timer); t.remove(); opts.onAction(); });
}
/* Delete something immediately, with an Undo toast instead of an "are you sure?" step. */
function deleteWithUndo(label, doDelete, undo){
  doDelete(); saveState(); renderAll();
  toast(label, {action:'Undo', onAction:()=>{ undo(); saveState(); renderAll(); toast('Restored'); }});
}

/* Money input with the currency symbol inside the field. */
function moneyInputHtml(id, value, placeholder){
  const sym = currencySymbol();
  return `<div class="input-affix" style="--affix-w:${Math.max(1, sym.length)}ch"><span class="affix">${escapeHtml(sym)}</span><input type="number" inputmode="decimal" step="0.01" min="0" id="${id}" value="${value==null?'':escapeHtml(value)}" placeholder="${escapeHtml(placeholder||'0.00')}"></div>`;
}
/* Polishes plain form markup in modals: currency prefixes on money fields, Today/Yesterday shortcuts on dates. */
function enhanceForm(root){
  const sym = currencySymbol();
  root.querySelectorAll('.field').forEach(field=>{
    const label = field.querySelector('label');
    const input = field.querySelector('input[type=number]');
    if(label && input && !input.closest('.input-affix') && label.children.length===0){
      const txt = label.textContent;
      if(txt.includes(`(${sym})`) || txt.includes(`, ${sym})`)){
        // "Amount (₱)" → "Amount", "Target amount (optional, ₱)" → "Target amount (optional)"
        label.textContent = txt.replace(` (${sym})`, '').replace(`(${sym})`, '').replace(`, ${sym})`, ')');
        const wrap = document.createElement('div');
        wrap.className = 'input-affix'; wrap.style.setProperty('--affix-w', Math.max(1, sym.length)+'ch');
        wrap.innerHTML = `<span class="affix">${escapeHtml(sym)}</span>`;
        input.parentNode.insertBefore(wrap, input); wrap.appendChild(input);
        input.setAttribute('inputmode','decimal');
      }
    }
  });
  root.querySelectorAll('input[type=date]').forEach(inp=>{
    if(inp.dataset.enhanced || !/date$/i.test(inp.id) || /due|end|start|borrowed|anchor/i.test(inp.id)) return;
    inp.dataset.enhanced = '1';
    const t0 = toISO(today), y0 = addDaysISO(t0, -1);
    const qd = document.createElement('div'); qd.className = 'quick-dates';
    qd.innerHTML = `<button type="button" data-d="${t0}">Today</button><button type="button" data-d="${y0}">Yesterday</button>`;
    const sync = ()=> qd.querySelectorAll('button').forEach(b=> b.classList.toggle('active', b.dataset.d===inp.value));
    qd.addEventListener('click', e=>{ const b = e.target.closest('button'); if(!b) return; inp.value = b.dataset.d; inp.dispatchEvent(new Event('change',{bubbles:true})); sync(); });
    inp.addEventListener('change', sync); inp.addEventListener('input', sync);
    inp.insertAdjacentElement('afterend', qd); sync();
  });
}

/* Appearance: 'system' | 'light' | 'dark' (a per-device preference, not synced). */
function getThemePref(){ try{ return localStorage.getItem('kaban_theme') || 'system'; }catch(e){ return 'system'; } }
function setThemePref(pref){
  try{ pref==='system' ? localStorage.removeItem('kaban_theme') : localStorage.setItem('kaban_theme', pref); }catch(e){}
  if(pref==='system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', pref);
  applyChartTheme(); renderAll();
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', ()=>{ if(getThemePref()==='system' && document.getElementById('app') && !document.getElementById('app').hidden){ applyChartTheme(); renderAll(); } });

/* Chart.js defaults that follow the current theme. */
function applyChartTheme(){
  if(!window.Chart) return;
  const C = Chart.defaults;
  C.font.family = "'Inter', system-ui, sans-serif";
  C.font.size = 12;
  C.color = cssVar('--text-2');
  C.borderColor = cssVar('--border');
  C.plugins.legend.labels.usePointStyle = true;
  C.plugins.legend.labels.pointStyle = 'circle';
  C.plugins.legend.labels.boxWidth = 8;
  C.plugins.legend.labels.boxHeight = 8;
  C.plugins.legend.labels.padding = 14;
  Object.assign(C.plugins.tooltip, {
    backgroundColor: cssVar('--inverse'), titleColor: cssVar('--on-inverse'), bodyColor: cssVar('--on-inverse'),
    padding: 10, cornerRadius: 10, displayColors: true, boxPadding: 4, usePointStyle: true,
    titleFont:{weight:'600'}, bodyFont:{weight:'500'}
  });
  C.elements.arc.borderColor = cssVar('--surface');
  C.elements.arc.borderWidth = 2;
  C.elements.bar.borderRadius = 6;
  C.elements.line.borderWidth = 2;
  C.scale.grid.color = cssVar('--border');
  if(Chart.overrides && Chart.overrides.doughnut) Chart.overrides.doughnut.cutout = '68%';
}
/* Theme-aware colours for budget buckets and generic chart series. */
function bucketColor(key){
  return cssVar({necessities:'--c-nec', extra:'--c-extra', playjar:'--c-play', savings:'--c-save', debt:'--c-debt', income:'--accent'}[key] || '--text-3');
}
function chartPalette(){
  return ['--c-nec','--c-extra','--c-play','--c-save','--c-debt','--accent','--warning','--success','--danger','--text-3'].map(cssVar);
}

/* =========================================================
   ICON PICKER — lets people choose an icon for categories, subcategories and savings goals.
   Names are Lucide icons; any that a given Lucide build lacks are skipped automatically.
========================================================= */
const ICON_CHOICES = [
  ['Home & bills', ['house','building','building-2','key-round','sofa','bed-double','bath','lamp','armchair','receipt','file-text','zap','plug','lightbulb','droplet','flame','wifi','smartphone','tv','router','wrench','hammer','paint-roller','trash-2','shield-check','umbrella']],
  ['Food & drink', ['utensils','utensils-crossed','shopping-basket','shopping-cart','store','coffee','cup-soda','wine','beer','milk','pizza','sandwich','soup','salad','beef','fish','egg','apple','carrot','croissant','cookie','cake','ice-cream-cone','popcorn','candy']],
  ['Transport', ['car','car-front','car-taxi-front','bus','train-front','tram-front','bike','motorbike','fuel','plane','ship','sailboat','map-pin','navigation','parking-meter','tickets-plane']],
  ['Health & care', ['stethoscope','pill','syringe','hospital','heart-pulse','activity','dumbbell','bike','sparkles','scissors','smile','eye','glasses','shirt','footprints','bath','spray-can','brush']],
  ['Fun & hobbies', ['party-popper','gift','clapperboard','film','music','headphones','gamepad-2','dices','puzzle','palette','camera','book-open','ticket','drama','tent','mountain','tree-palm','sun','umbrella','guitar','mic','trophy']],
  ['Family & pets', ['users','user','baby','heart','heart-handshake','hand-heart','paw-print','dog','cat','bird','fish','graduation-cap','school','backpack','pencil','church','flower-2','sprout']],
  ['Money & work', ['wallet','piggy-bank','banknote','coins','hand-coins','credit-card','landmark','receipt-text','calculator','percent','trending-up','chart-line','chart-pie','briefcase','laptop','building','target','gem','crown','shield','vault','badge-percent','repeat','calendar-days']],
  ['Shopping & misc', ['shopping-bag','tag','tags','package','box','scissors','shirt','watch','gem','gift','star','leaf','flower','sun','moon','cloud','shapes','circle-dot','bookmark','flag','bell','sparkle']]
];
function iconExists(name){
  const pascal = name.split('-').map(p=>p.charAt(0).toUpperCase()+p.slice(1)).join('');
  return !!(window.lucide && window.lucide.icons && window.lucide.icons[pascal]);
}
let _iconGroupsCache = null;
function iconGroups(){
  if(_iconGroupsCache) return _iconGroupsCache;
  const seen = new Set();
  _iconGroupsCache = ICON_CHOICES.map(([g, names])=>[g, names.filter(n=>{ if(seen.has(n) || !iconExists(n)) return false; seen.add(n); return true; })]).filter(([,n])=>n.length);
  return _iconGroupsCache;
}
/* Resolves to an icon name, '' for "automatic", or undefined if cancelled. */
function pickIcon(current, opts){
  opts = opts || {};
  return new Promise(resolve=>{
    const root = document.getElementById('pickerRoot');
    const tone = opts.tone || 'accent';
    const render = (q)=>{
      q = (q||'').trim().toLowerCase();
      const groupHit = (g)=> g.toLowerCase().split(/[^a-z]+/).some(w=> w===q || w===q+'s' || (q.length>=4 && w.startsWith(q)));
      const groups = iconGroups().map(([g, names])=>[g, q ? names.filter(n=>n.includes(q) || groupHit(g)) : names]).filter(([,n])=>n.length);
      return (opts.allowAuto ? `<div class="ip-group"><button type="button" class="ip-auto ${!current?'active':''}" data-pick="">${icon('wand-sparkles')}<span>Automatic<small>Pick an icon from the name</small></span></button></div>` : '') +
        (groups.length ? groups.map(([g, names])=>`<div class="ip-group"><div class="menu-label">${escapeHtml(g)}</div><div class="ip-grid">${
          names.map(n=>`<button type="button" class="ip-tile t-${iconTone(n, tone)} ${n===current?'active':''}" data-pick="${n}" title="${n.replace(/-/g,' ')}" aria-label="${n.replace(/-/g,' ')}">${icon(n)}</button>`).join('')
        }</div></div>`).join('') : `<p class="small-muted" style="padding:10px 4px;">No icons match “${escapeHtml(q)}”.</p>`);
    };
    root.innerHTML = `<div class="modal-backdrop dialog-layer picker-layer" data-ip-backdrop>
      <div class="modal-card ip-card" role="dialog" aria-modal="true" aria-label="Choose an icon">
        <div class="modal-header"><h3>${escapeHtml(opts.title||'Choose an icon')}</h3><button class="icon-btn" data-ip-close aria-label="Close">${icon('x')}</button></div>
        <div class="search-field ip-search">${icon('search','ic-sm')}<input type="search" id="ipSearch" placeholder="Search icons (e.g. car, food, pet)" autocomplete="off"></div>
        <div class="ip-body" id="ipBody">${render('')}</div>
      </div></div>`;
    const close = (val)=>{ root.innerHTML=''; document.removeEventListener('keydown', onKey, true); resolve(val); };
    const onKey = (e)=>{ if(e.key==='Escape'){ e.stopPropagation(); close(undefined); } };
    document.addEventListener('keydown', onKey, true);
    root.querySelector('[data-ip-close]').addEventListener('click', ()=>close(undefined));
    root.querySelector('[data-ip-backdrop]').addEventListener('mousedown', (e)=>{ if(e.target.hasAttribute('data-ip-backdrop')) close(undefined); });
    const body = document.getElementById('ipBody');
    body.addEventListener('click', (e)=>{ const b = e.target.closest('[data-pick]'); if(b) close(b.dataset.pick); });
    const search = document.getElementById('ipSearch');
    search.addEventListener('input', ()=>{ body.innerHTML = render(search.value); });
    if(window.matchMedia('(min-width:901px)').matches) setTimeout(()=>search.focus(), 30);
  });
}
/* A form control that shows the chosen icon and opens the picker. Value lives in a hidden input. */
function iconFieldHtml(id, value, label, opts){
  opts = opts || {};
  const shown = value || opts.autoIcon || 'tag';
  return `<div class="field"><label>${escapeHtml(label||'Icon')}</label>
    <button type="button" class="icon-choice" data-icon-field="${id}" data-name-src="${opts.nameSrc||''}" data-tone="${opts.tone||'accent'}" data-allow-auto="${opts.allowAuto?'1':''}" data-auto="${opts.autoKind||'category'}">
      <span class="badge-ic t-${opts.tone||'accent'}" data-icon-preview>${icon(shown)}</span>
      <span class="icon-choice-label" data-icon-label>${value ? 'Change icon' : 'Automatic'}</span>
      ${icon('chevron-right','ic-sm')}
    </button>
    <input type="hidden" id="${id}" value="${escapeHtml(value||'')}">
  </div>`;
}
function wireIconFields(root){
  root.querySelectorAll('[data-icon-field]').forEach(btn=>{
    if(btn.dataset.wired) return; btn.dataset.wired = '1';
    const input = document.getElementById(btn.dataset.iconField);
    const autoFor = ()=>{ const src = btn.dataset.nameSrc && document.getElementById(btn.dataset.nameSrc); const nm = src ? src.value : ''; return btn.dataset.auto==='goal' ? goalIcon(nm) : categoryIcon(nm); };
    const refresh = ()=>{
      btn.querySelector('[data-icon-preview]').innerHTML = icon(input.value || autoFor());
      btn.querySelector('[data-icon-label]').textContent = input.value ? 'Change icon' : 'Automatic';
    };
    btn.addEventListener('click', ()=>{
      pickIcon(input.value, {tone:btn.dataset.tone, allowAuto:!!btn.dataset.allowAuto}).then(v=>{ if(v===undefined) return; input.value = v; refresh(); });
    });
    const src = btn.dataset.nameSrc && document.getElementById(btn.dataset.nameSrc);
    if(src) src.addEventListener('input', ()=>{ if(!input.value) refresh(); });
  });
}

/* =========================================================
   EARNERS & PAYDAYS
========================================================= */
const EARNER_TONES = ['rose','clay','sage','gold'];
const PAY_SCHEDULE_TYPES = [
  ['biweekly','Every 2 weeks'],
  ['weekly','Every week'],
  ['semimonthly','Twice a month'],
  ['monthly','Once a month'],
  ['none','No fixed schedule']
];
function earners(){ return state.settings.earners || []; }
function earnerById(id){ return earners().find(e=>e.id===id) || null; }
function earnerName(id){ const e = earnerById(id); return e ? e.name : String(id||'Unknown'); }
function earnerTone(id){
  const i = earners().findIndex(e=>e.id===id);
  return EARNER_TONES[(i<0?0:i) % EARNER_TONES.length];
}
function earnerIncomeLabel(e){ return /^me$/i.test(e.name.trim()) ? 'Your income' : `${e.name}'s income`; }
function ordinal(n){ const s=['th','st','nd','rd'], v=n%100; return n+(s[(v-20)%10]||s[v]||s[0]); }
function payScheduleLabel(sch){
  sch = sch || {type:'none'};
  if(sch.type==='biweekly') return sch.anchor ? `Every 2 weeks (from ${fmtDateHuman(sch.anchor)})` : 'Every 2 weeks';
  if(sch.type==='weekly') return sch.anchor ? `Every week (from ${fmtDateHuman(sch.anchor)})` : 'Every week';
  if(sch.type==='semimonthly') return `On the ${(sch.days||[]).map(ordinal).join(' & ')}`;
  if(sch.type==='monthly') return `Monthly on the ${ordinal(sch.day||1)}`;
  return 'No fixed schedule';
}
/* Every expected payday for an earner within [startISO, endISO] inclusive. Days past the end of a
   short month (e.g. the 30th in February) fall on that month's last day. */
function paydaysInRange(earner, startISO, endISO){
  const sch = earner.schedule || {type:'none'};
  const out = [];
  if(sch.type==='biweekly' || sch.type==='weekly'){
    if(!sch.anchor) return out;
    const step = sch.type==='weekly' ? 7 : 14;
    const anchor = new Date(sch.anchor+'T00:00:00');
    const start = new Date(startISO+'T00:00:00');
    const diff = Math.round((start - anchor)/86400000);
    const offset = ((diff % step) + step) % step;
    let d = new Date(start); d.setDate(d.getDate() + (offset===0 ? 0 : step-offset));
    for(let guard=0; toISO(d)<=endISO && guard<600; guard++){ out.push(toISO(d)); d.setDate(d.getDate()+step); }
    return out;
  }
  if(sch.type==='semimonthly' || sch.type==='monthly'){
    const days = sch.type==='monthly' ? [Number(sch.day)||1] : (sch.days||[]).map(Number);
    let y = Number(startISO.slice(0,4)), mi = Number(startISO.slice(5,7))-1;
    for(let guard=0; guard<240; guard++){
      if(monthKey(y,mi) > endISO.slice(0,7)) break;
      const dim = daysInMonth(y,mi);
      Array.from(new Set(days.map(dd=>Math.min(Math.max(1,dd), dim)))).sort((a,b)=>a-b).forEach(dd=>{
        const iso = monthKey(y,mi)+'-'+String(dd).padStart(2,'0');
        if(iso>=startISO && iso<=endISO) out.push(iso);
      });
      mi++; if(mi>11){ mi=0; y++; }
    }
  }
  return out;
}
/* Income actually recorded for an earner on a given date (searches every month, since an entry
   is filed under whichever month was selected when it was added). */
/* Most recent recorded pay for an earner — used as the expected amount for upcoming paydays. */
function lastIncomeAmount(earnerId){
  let best = null;
  Object.values(state.months).forEach(m=> (m.income||[]).forEach(i=>{ if(i.person===earnerId && (!best || i.date>best.date)) best = i; }));
  return best ? Number(best.amount)||null : null;
}
function findIncomeOn(earnerId, iso){
  for(const m of Object.values(state.months)){
    const hit = (m.income||[]).find(i=>i.person===earnerId && i.date===iso);
    if(hit) return hit;
  }
  return null;
}

/* =========================================================
   COMPUTATION ENGINE
========================================================= */
function sumBy(arr, fn){ return arr.reduce((a,x)=>a+(Number(fn(x))||0),0); }

/* ---------- Category default-budget helpers ---------- */
/* ---------- Category tree helpers ---------- */
function findMainCat(monthData, section, mainName){
  return getCategoryTree(section).find(c=>c.name===mainName);
}
function ensureDefaultsNode(section, mainName){
  const d = state.settings.categoryDefaults[section];
  if(!d[mainName]) d[mainName] = {own:0, subs:{}};
  return d[mainName];
}
function ensureOverrideNode(monthData, section, mainName){
  const ov = monthData[section].budgetOverrides;
  if(!ov[mainName]) ov[mainName] = {own:undefined, subs:{}};
  if(!ov[mainName].subs) ov[mainName].subs = {};
  return ov[mainName];
}
function getCategoryDefault(section, mainName, subName){
  const d = state.settings.categoryDefaults[section][mainName];
  if(!d) return 0;
  if(subName) return d.subs[subName]!==undefined ? Number(d.subs[subName]) : 0;
  return d.own!==undefined ? Number(d.own) : 0;
}
function getCategoryBudget(monthData, section, mainName, subName){
  const ov = monthData[section].budgetOverrides[mainName];
  if(ov){
    if(subName){ if(ov.subs && ov.subs[subName]!==undefined) return Number(ov.subs[subName]); }
    else if(ov.own!==undefined) return Number(ov.own);
  }
  return getCategoryDefault(section, mainName, subName);
}
/* Actual spend for a leaf (sub, or main if it has no subs) */
function leafActual(monthData, section, mainName, subName){
  return sumBy(monthData[section].expenses.filter(e=> e.mainCategory===mainName && (subName? e.subCategory===subName : !e.subCategory)), e=>e.amount);
}
/* Full rollup rows: one row per main category (with .budget/.actual/.remaining rolled up),
   each carrying .subs rows if it has subcategories. */
function categoryBudgetRows(monthData, section, monthKeyParam){
  return getCategoryTree(section).filter(main=>{
    const mainActiveOrHasData = isCategoryActiveForMonth(main, monthKeyParam) || leafActual(monthData, section, main.name, null)>0 ||
      main.subs.some(sub=> leafActual(monthData, section, main.name, sub.name)>0);
    return mainActiveOrHasData;
  }).map(main=>{
    const visibleSubs = main.subs.filter(sub=>{
      const actual = leafActual(monthData, section, main.name, sub.name);
      return isCategoryActiveForMonth(sub, monthKeyParam) || actual>0;
    });
    if(main.subs.length){
      const subRows = visibleSubs.map(sub=>{
        const budget = getCategoryBudget(monthData, section, main.name, sub.name);
        const actual = leafActual(monthData, section, main.name, sub.name);
        const ov = monthData[section].budgetOverrides[main.name];
        const isCustom = !!(ov && ov.subs && ov.subs[sub.name]!==undefined);
        return {name:sub.name, budget, actual, remaining:budget-actual, isCustomThisMonth:isCustom, inactive:!isCategoryActiveForMonth(sub, monthKeyParam)};
      });
      const budget = sumBy(subRows, r=>r.budget);
      const actual = sumBy(subRows, r=>r.actual);
      return {main:main.name, id:main.id, budget, actual, remaining:budget-actual, subs:subRows, isCustomThisMonth:false, inactive:!isCategoryActiveForMonth(main, monthKeyParam)};
    }
    const budget = getCategoryBudget(monthData, section, main.name, null);
    const actual = leafActual(monthData, section, main.name, null);
    const ov = monthData[section].budgetOverrides[main.name];
    const isCustom = !!(ov && ov.own!==undefined);
    return {main:main.name, id:main.id, budget, actual, remaining:budget-actual, subs:null, isCustomThisMonth:isCustom, inactive:!isCategoryActiveForMonth(main, monthKeyParam)};
  });
}
function categoryPlannedTotal(monthData, section, monthKeyParam){
  return sumBy(categoryBudgetRows(monthData, section, monthKeyParam), r=>r.budget);
}
/* Apply a change to a leaf's DEFAULT budget, honoring the chosen scope.
   scope: 'future' | 'current' | 'currentAndFuture' */
function applyCategoryDefaultChange(section, mainName, subName, newValue, scope){
  const old = getCategoryDefault(section, mainName, subName);
  const curKey = monthKey(cur.year, cur.monthIndex);
  const allKeys = Object.keys(state.months);
  function freeze(k){
    const m = state.months[k];
    const ov = ensureOverrideNode(m, section, mainName);
    if(subName){ if(ov.subs[subName]===undefined) ov.subs[subName] = old; }
    else { if(ov.own===undefined) ov.own = old; }
  }
  function setCurrent(){
    const m = ensureMonth(curKey);
    const ov = ensureOverrideNode(m, section, mainName);
    if(subName) ov.subs[subName] = newValue; else ov.own = newValue;
  }
  if(scope==='future'){
    allKeys.filter(k=> k <= curKey).forEach(freeze);
    const d = ensureDefaultsNode(section, mainName);
    if(subName) d.subs[subName] = newValue; else d.own = newValue;
  } else if(scope==='current'){
    setCurrent();
  } else { // currentAndFuture
    allKeys.filter(k=> k < curKey).forEach(freeze);
    setCurrent();
    const d = ensureDefaultsNode(section, mainName);
    if(subName) d.subs[subName] = newValue; else d.own = newValue;
  }
}
/* Same scope-based carry-forward pattern, applied to the monthly savings amount */
function applySavingsAmountChange(newValue, scope){
  const old = Number(state.settings.savingsAmountDefault)||0;
  const curKey = monthKey(cur.year, cur.monthIndex);
  const allKeys = Object.keys(state.months);
  function freeze(k){
    const m = state.months[k];
    if(m.savingsAmountOverride===null || m.savingsAmountOverride===undefined) m.savingsAmountOverride = old;
  }
  function setCurrent(){ ensureMonth(curKey).savingsAmountOverride = newValue; }
  if(scope==='future'){
    allKeys.filter(k=> k <= curKey).forEach(freeze);
    state.settings.savingsAmountDefault = newValue;
  } else if(scope==='current'){
    setCurrent();
  } else { // currentAndFuture
    allKeys.filter(k=> k < curKey).forEach(freeze);
    setCurrent();
    state.settings.savingsAmountDefault = newValue;
  }
}
/* Same pattern, applied to a savings goal's allocation percentage */
function applyGoalAllocationChange(goalId, newValue, scope){
  const goal = state.settings.savingsGoals.find(g=>g.id===goalId);
  if(!goal) return;
  const old = Number(goal.allocation)||0;
  const curKey = monthKey(cur.year, cur.monthIndex);
  const allKeys = Object.keys(state.months);
  function ensureOv(m){ if(!m.savingsGoalAllocOverrides) m.savingsGoalAllocOverrides = {}; return m.savingsGoalAllocOverrides; }
  function freeze(k){
    const ov = ensureOv(state.months[k]);
    if(ov[goalId]===undefined) ov[goalId] = old;
  }
  function setCurrent(){ ensureOv(ensureMonth(curKey))[goalId] = newValue; }
  if(scope==='future'){
    allKeys.filter(k=> k <= curKey).forEach(freeze);
    goal.allocation = newValue;
  } else if(scope==='current'){
    setCurrent();
  } else { // currentAndFuture
    allKeys.filter(k=> k < curKey).forEach(freeze);
    setCurrent();
    goal.allocation = newValue;
  }
}

function computeMonth(key){
  const m = getMonth(key, true);
  const s = state.settings;
  const totalIncome = sumBy(m.income, i=>i.amount);
  const incomeByPerson = {};
  m.income.forEach(i=>{ incomeByPerson[i.person] = (incomeByPerson[i.person]||0) + Number(i.amount||0); });

  const [mStart, mEnd] = monthRange(key);
  const debtPaymentsThisMonth = debtPaymentsInRange(mStart, mEnd);
  const borrowedFundsThisMonth = borrowedFundsInRange(mStart, mEnd);
  const totalCashReceived = totalIncome + borrowedFundsThisMonth;
  // Debt is paid first: only what's actually paid toward debt reduces what's left to budget.
  const budgetableIncome = totalIncome - debtPaymentsThisMonth;

  const prevKey = prevMonthKey(cur_yearOf(key), cur_moOf(key));
  const prevM = state.months[prevKey];
  let prevCalc = null;
  if(prevM) prevCalc = computeMonthShallow(prevKey);

  function rolloverIn(section){
    if(!prevCalc) return 0;
    const decision = prevM.rollover[section];
    if(decision === 'rollover'){
      const remaining = prevCalc[section].remaining;
      return remaining > 0 ? remaining : 0;
    }
    return 0;
  }

  const necRolloverIn = rolloverIn('necessities');
  const extRolloverIn = rolloverIn('extra');
  const playRolloverIn = rolloverIn('playjar');

  const necBudgetBase = budgetableIncome * s.allocations.necessities/100;
  const extBudgetBase = budgetableIncome * s.allocations.extra/100;
  const playBudgetBase = budgetableIncome * s.allocations.playjar/100;
  const savAutoBase = budgetableIncome * s.allocations.savings/100; // Recommended target — reference only, never drives allocation
  const hasAmountOverride = (m.savingsAmountOverride !== null && m.savingsAmountOverride !== undefined);
  const savingsAmount = hasAmountOverride ? Number(m.savingsAmountOverride) : Number(s.savingsAmountDefault)||0; // Monthly Savings Amount — what actually gets split across goals

  const necBudget = necBudgetBase + necRolloverIn;
  const extBudget = extBudgetBase + extRolloverIn;
  const playBudget = playBudgetBase + playRolloverIn;

  const necActual = sumBy(m.necessities.expenses, e=>e.amount);
  const extActual = sumBy(m.extra.expenses, e=>e.amount);
  const playActual = sumBy(m.playjar.expenses, e=>e.amount);

  const necRemaining = necBudget - necActual;
  const extRemaining = extBudget - extActual;
  const playRemaining = playBudget - playActual;

  const goalAllocOv = m.savingsGoalAllocOverrides || {};
  const goals = s.savingsGoals.map(g=>{
    const hasPctOverride = goalAllocOv[g.id]!==undefined;
    const effectivePct = hasPctOverride ? Number(goalAllocOv[g.id]) : g.allocation;
    const budget = g.active ? savingsAmount * (effectivePct/100) : 0; // Planned Allocation
    const actual = Number(m.savingsActuals[g.id] || 0);
    return {...g, allocation:effectivePct, isPctCustomThisMonth:hasPctOverride, budget, actual, remaining: budget - actual};
  });
  const totalActualSavings = sumBy(goals, g=>g.actual);
  const totalPlannedAllocation = sumBy(goals, g=>g.budget);
  const unallocatedAmount = savingsAmount - totalPlannedAllocation;
  const savingsGoalPctTotal = sumBy(goals.filter(g=>g.active), g=>g.allocation);

  const totalExpenses = necActual + extActual + playActual;
  const netCashFlow = totalCashReceived - debtPaymentsThisMonth - totalExpenses - totalActualSavings;
  const savingsRate = totalIncome>0 ? (totalActualSavings/totalIncome*100) : 0;
  const remainingBudgetOverall = necRemaining + extRemaining + playRemaining;

  return {
    key, totalIncome, incomeByPerson, borrowedFundsThisMonth, totalCashReceived, debtPaymentsThisMonth, budgetableIncome,
    necessities:{budget:necBudget, budgetBase:necBudgetBase, actual:necActual, remaining:necRemaining, rolloverIn:necRolloverIn},
    extra:{budget:extBudget, budgetBase:extBudgetBase, actual:extActual, remaining:extRemaining, rolloverIn:extRolloverIn},
    playjar:{budget:playBudget, budgetBase:playBudgetBase, actual:playActual, remaining:playRemaining, rolloverIn:playRolloverIn},
    savings:{budgetTotal:savingsAmount, autoBudgetTotal:savAutoBase, isCustomTarget:hasAmountOverride, actualTotal:totalActualSavings,
      remaining:savingsAmount-totalActualSavings, totalPlanned:totalPlannedAllocation, unallocated:unallocatedAmount,
      goals, goalPctTotal:savingsGoalPctTotal},
    totalExpenses, netCashFlow, savingsRate, remainingBudgetOverall,
    hasPrev: !!prevM, prevKey
  };
}
/* shallow version without recursing into its own previous month rollover chain beyond 1 level, to avoid infinite recursion issues (rollover only looks back one month) */
function computeMonthShallow(key){
  const m = getMonth(key, true);
  const s = state.settings;
  const totalIncome = sumBy(m.income, i=>i.amount);
  const [mStart, mEnd] = monthRange(key);
  const debtPaymentsThisMonth = debtPaymentsInRange(mStart, mEnd);
  const budgetableIncome = totalIncome - debtPaymentsThisMonth;
  const necBudgetBase = budgetableIncome * s.allocations.necessities/100;
  const extBudgetBase = budgetableIncome * s.allocations.extra/100;
  const playBudgetBase = budgetableIncome * s.allocations.playjar/100;
  const pkey = prevMonthKey(cur_yearOf(key), cur_moOf(key));
  const pm = state.months[pkey];
  let necIn=0, extIn=0, playIn=0;
  if(pm){
    const ppm = state.months[prevMonthKey(cur_yearOf(pkey), cur_moOf(pkey))];
    // don't chain further back than one level for shallow calc
    necIn=0; extIn=0; playIn=0;
  }
  const necActual = sumBy(m.necessities.expenses, e=>e.amount);
  const extActual = sumBy(m.extra.expenses, e=>e.amount);
  const playActual = sumBy(m.playjar.expenses, e=>e.amount);
  return {
    necessities:{budget:necBudgetBase+necIn, actual:necActual, remaining:(necBudgetBase+necIn)-necActual},
    extra:{budget:extBudgetBase+extIn, actual:extActual, remaining:(extBudgetBase+extIn)-extActual},
    playjar:{budget:playBudgetBase+playIn, actual:playActual, remaining:(playBudgetBase+playIn)-playActual}
  };
}
function cur_yearOf(key){ return Number(key.split('-')[0]); }
function cur_moOf(key){ return Number(key.split('-')[1])-1; }
function monthRange(key){
  const y = cur_yearOf(key), mi = cur_moOf(key);
  return [monthKey(y,mi)+'-01', monthKey(y,mi)+'-'+String(daysInMonth(y,mi)).padStart(2,'0')];
}

function expenseLeafLabel(e){ return e.subCategory ? `${e.mainCategory} — ${e.subCategory}` : e.mainCategory; }
function allExpensesForMonth(m){
  return [].concat(
    m.necessities.expenses.map(e=>({...e, section:'necessities'})),
    m.extra.expenses.map(e=>({...e, section:'extra'})),
    m.playjar.expenses.map(e=>({...e, section:'playjar'}))
  );
}
function topCategories(key, limit){
  const m = getMonth(key, true);
  const totals = {};
  allExpensesForMonth(m).forEach(e=>{
    const label = expenseLeafLabel(e);
    totals[label] = (totals[label]||0) + Number(e.amount||0);
  });
  return Object.entries(totals).sort((a,b)=>b[1]-a[1]).slice(0, limit||5);
}
function mainCategoryTotals(key){
  const m = getMonth(key, true);
  const totals = {};
  allExpensesForMonth(m).forEach(e=>{ totals[e.mainCategory] = (totals[e.mainCategory]||0) + Number(e.amount||0); });
  return Object.entries(totals).sort((a,b)=>b[1]-a[1]);
}
/* Compare planned category-budget totals against the income-based section target (warning only, never alters spending) */

function financialHealthScore(calc){
  let score = 0;
  const savScore = Math.max(0, Math.min(40, (calc.savingsRate/30)*40));
  score += savScore;
  const sections = ['necessities','extra','playjar'];
  let adherenceScore = 0;
  sections.forEach(sec=>{
    const d = calc[sec];
    if(d.budget<=0){ adherenceScore += 40/3; return; }
    if(d.remaining >= 0){ adherenceScore += 40/3; }
    else{
      const overRatio = Math.abs(d.remaining)/d.budget;
      adherenceScore += Math.max(0, (40/3) * (1 - Math.min(overRatio,1)));
    }
  });
  score += adherenceScore;
  if(calc.netCashFlow >= 0) score += 20;
  else{
    const ratio = calc.totalIncome>0 ? Math.abs(calc.netCashFlow)/calc.totalIncome : 1;
    score += Math.max(0, 20*(1-Math.min(ratio,1)));
  }
  score = Math.round(Math.max(0, Math.min(100, score)));
  let note;
  if(score>=85) note = "You're within your budgets and keeping a strong savings rate this month.";
  else if(score>=65) note = "Mostly on track — a category or two is running close to its limit.";
  else if(score>=45) note = "A few budgets have slipped. Worth a look at where spending crept up.";
  else note = "Spending is well ahead of income this month. Consider adjusting categories or income.";
  return {score, note};
}

/* =========================================================
   DEBT & LOANS — CALCULATION ENGINE
========================================================= */
const DEBT_TYPE_LABEL = {standard:'Standard Loan', installment:'Installment', flexible:'Flexible'};

function monthsBetweenDates(fromISO, toISO_){
  const a = new Date(fromISO+'T00:00:00'), b = new Date(toISO_+'T00:00:00');
  let months = (b.getFullYear()-a.getFullYear())*12 + (b.getMonth()-a.getMonth());
  if(b.getDate() < a.getDate()) months--;
  return Math.max(0, months);
}
function addMonthsISO(iso, n){
  const d = new Date(iso+'T00:00:00');
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth()+n);
  const lastDay = new Date(d.getFullYear(), d.getMonth()+1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return toISO(d);
}
function addDaysISO(iso, n){
  const d = new Date(iso+'T00:00:00'); d.setDate(d.getDate()+n); return toISO(d);
}
function debtBorrowerList(){
  const set = new Set(earners().map(e=>e.name));
  state.debts.forEach(d=>{ if(d.borrower) set.add(d.borrower); });
  return Array.from(set);
}

/* Known interest amount for a debt (standard type). Returns {amount, label} or {amount:null,label:'Unknown'} */
function debtInterestAmount(d){
  const it = d.interest || {mode:'none'};
  if(it.mode==='none') return {amount:0, label:'None'};
  if(it.mode==='unknown') return {amount:null, label:'Unknown'};
  if(it.mode==='fixed') return {amount:Number(it.amount)||0, label:money(Number(it.amount)||0)};
  if(it.mode==='percentage'){
    const pct_ = Number(it.percent)||0;
    const todayISO = toISO(today);
    if(it.percentPeriod==='onetime'){
      const amt = d.principal*pct_/100; return {amount:amt, label:pct(pct_)+' one-time'};
    }
    if(it.percentPeriod==='annual'){
      const years = monthsBetweenDates(d.dateBorrowed, todayISO)/12;
      const amt = d.principal*pct_/100*years; return {amount:amt, label:pct(pct_)+'/yr (est. to date)'};
    }
    // monthly
    const months = monthsBetweenDates(d.dateBorrowed, todayISO);
    const amt = d.principal*pct_/100*months; return {amount:amt, label:pct(pct_)+'/mo (est. to date)'};
  }
  return {amount:0, label:'None'};
}
function debtTotalPaid(d){ return sumBy(d.payments, p=>p.amount); }

/* Installment schedule with FIFO allocation of total actual payments across scheduled slots */
function debtInstallmentSchedule(d){
  const inst = d.installment;
  const n = Number(inst.numPayments)||0;
  const amt = Number(inst.monthlyPayment)||0;
  let pool = debtTotalPaid(d);
  const todayISO = toISO(today);
  const slots = [];
  for(let i=0;i<n;i++){
    let due;
    if(inst.frequency==='weekly') due = addDaysISO(inst.startDate, i*7);
    else if(inst.frequency==='biweekly') due = addDaysISO(inst.startDate, i*14);
    else due = addMonthsISO(inst.startDate, i); // monthly & custom fallback
    const allocated = Math.max(0, Math.min(amt, pool));
    pool -= allocated;
    let status;
    if(allocated >= amt && amt>0) status = 'Paid';
    else if(allocated > 0) status = 'Partial';
    else if(due < todayISO) status = 'Overdue';
    else status = 'Upcoming';
    slots.push({index:i+1, dueDate:due, expected:amt, paid:allocated, remaining:amt-allocated, status});
  }
  return slots;
}
function debtScheduledTotal(d){
  return Number(d.installment.monthlyPayment||0) * Number(d.installment.numPayments||0);
}
/* Unified "total owed" (before payments) for any debt type */
function debtTotalOwed(d){
  if(d.repaymentType==='installment') return debtScheduledTotal(d);
  const ia = debtInterestAmount(d);
  const lf = debtLateFeeAmount(d);
  return d.principal + (ia.amount||0) + lf;
}
function debtBalance(d){
  return Math.max(0, debtTotalOwed(d) - debtTotalPaid(d));
}
function debtProgressPct(d){
  const total = debtTotalOwed(d);
  if(total<=0) return 0;
  return Math.min(100, debtTotalPaid(d)/total*100);
}
function debtOverdueInfo(d){
  const todayISO = toISO(today);
  if(d.repaymentType==='flexible') return {overdue:false, amount:0, count:0, monthsOverdue:null};
  if(d.repaymentType==='installment'){
    const slots = debtInstallmentSchedule(d);
    const overdueSlots = slots.filter(s=>s.status==='Overdue' || (s.status==='Partial' && s.dueDate<todayISO));
    const amount = sumBy(overdueSlots, s=>s.remaining);
    const monthsOverdue = overdueSlots.length ? monthsBetweenDates(overdueSlots[0].dueDate, todayISO) : 0;
    return {overdue: overdueSlots.length>0, amount, count: overdueSlots.length, monthsOverdue};
  }
  // standard
  if(!d.dueDate) return {overdue:false, amount:0, count:0, monthsOverdue:null};
  const bal = debtBalance(d);
  if(d.dueDate < todayISO && bal>0){
    return {overdue:true, amount:bal, count:1, monthsOverdue: monthsBetweenDates(d.dueDate, todayISO)};
  }
  return {overdue:false, amount:0, count:0, monthsOverdue:null};
}
function debtLateFeeAmount(d){
  const lf = d.lateFee || {mode:'none'};
  if(!lf.mode || lf.mode==='none') return 0;
  const info = debtOverdueInfo(d);
  if(!info.overdue) return 0;
  if(lf.mode==='fixed') return Number(lf.amount)||0;
  if(lf.mode==='percentage') return (info.amount||0) * (Number(lf.percent)||0)/100;
  return 0;
}
function debtStatusLabel(d){
  if(d.repaymentType==='flexible') return debtBalance(d)<=0 ? 'Paid off' : 'Flexible';
  if(debtBalance(d)<=0) return 'Paid off';
  const info = debtOverdueInfo(d);
  return info.overdue ? 'Overdue' : 'Active';
}
/* Balance of a single debt as of a cutoff date (for annual history) */
function debtBalanceAsOf(d, cutoffISO){
  if(d.dateBorrowed > cutoffISO) return 0;
  const total = debtTotalOwed(d);
  const paid = sumBy(d.payments.filter(p=>p.date<=cutoffISO), p=>p.amount);
  return Math.max(0, total-paid);
}
function allDebtsBalanceAsOf(cutoffISO){ return sumBy(state.debts, d=>debtBalanceAsOf(d,cutoffISO)); }

function debtPaymentsInRange(fromISO, toISO_){
  let total = 0;
  state.debts.forEach(d=> d.payments.forEach(p=>{ if(p.date>=fromISO && p.date<=toISO_) total += Number(p.amount||0); }));
  return total;
}
function borrowedFundsInRange(fromISO, toISO_){
  return sumBy(state.debts.filter(d=> d.dateBorrowed>=fromISO && d.dateBorrowed<=toISO_), d=>d.principal);
}
function debtOverviewTotals(){
  const debts = state.debts;
  const active = debts.filter(d=>debtBalance(d)>0);
  let totalOutstanding=0, totalPrincipal=0, totalScheduled=0, totalPaid=0, totalInterest=0, totalAdditionalCost=0, overdueCount=0, flexibleCount=0;
  debts.forEach(d=>{
    totalPaid += debtTotalPaid(d);
    if(debtBalance(d)>0){
      totalOutstanding += debtBalance(d);
      totalPrincipal += d.principal;
    }
    if(d.repaymentType==='installment'){
      totalScheduled += debtScheduledTotal(d);
      if(d.installment.interestKnown) totalInterest += Number(d.installment.interestAmount)||0;
      else totalAdditionalCost += Math.max(0, debtScheduledTotal(d) - d.principal);
    } else {
      const ia = debtInterestAmount(d);
      if(ia.amount!==null) totalInterest += ia.amount;
    }
    if(d.repaymentType==='flexible') flexibleCount++;
    const info = debtOverdueInfo(d);
    if(info.overdue) overdueCount += (d.repaymentType==='installment' ? info.count : 1);
  });
  return {totalOutstanding, totalPrincipal, totalScheduled, totalPaid, totalInterest, totalAdditionalCost, activeCount:active.length, overdueCount, flexibleCount};
}

/* =========================================================
   RECURRING EXPENSES — ENGINE
========================================================= */
const FREQUENCY_DEFS = {
  monthly:{unit:'months', n:1, label:'Monthly'},
  biweekly:{unit:'days', n:14, label:'Every 2 weeks'},
  weekly:{unit:'days', n:7, label:'Weekly'},
  every2months:{unit:'months', n:2, label:'Every 2 months'},
  quarterly:{unit:'months', n:3, label:'Quarterly'},
  yearly:{unit:'months', n:12, label:'Yearly'},
  custom:{unit:'days', n:null, label:'Custom'}
};
function frequencyLabel(rec){
  if(rec.frequency==='custom') return `Every ${rec.customIntervalDays||30} days`;
  return (FREQUENCY_DEFS[rec.frequency]||FREQUENCY_DEFS.monthly).label;
}
/* All occurrence due-dates for a recurring item within [rangeStartISO, rangeEndISO] inclusive */
function recurringOccurrences(rec, rangeStartISO, rangeEndISO){
  const def = FREQUENCY_DEFS[rec.frequency] || FREQUENCY_DEFS.monthly;
  const out = [];
  let d = rec.startDate;
  let guard = 0;
  while(d <= rangeEndISO && guard<3000){
    guard++;
    if(rec.endDate && d > rec.endDate) break;
    if(d >= rangeStartISO) out.push(d);
    if(def.unit==='months') d = addMonthsISO(d, def.n);
    else d = addDaysISO(d, rec.frequency==='custom' ? Math.max(1,Number(rec.customIntervalDays)||30) : def.n);
  }
  return out;
}
/* Was a given occurrence actually paid? Looks for an expense linked to this recurring id + due date. */
function recurringOccurrenceStatus(rec, dueISO){
  const monthData = state.months[dueISO.slice(0,7)];
  const match = monthData ? monthData[rec.section].expenses.find(e=> e.recurringId===rec.id && e.recurringDueDate===dueISO) : null;
  if(match) return {status:'Paid', actual:match.amount, expenseId:match.id};
  if(dueISO < toISO(today)) return {status:'Overdue', actual:null, expenseId:null};
  return {status:'Expected', actual:null, expenseId:null};
}
function relativeDayLabel(dateISO){
  const diffDays = Math.round((new Date(dateISO+'T00:00:00') - new Date(toISO(today)+'T00:00:00'))/86400000);
  if(diffDays<0) return `${Math.abs(diffDays)} day${Math.abs(diffDays)===1?'':'s'} overdue`;
  if(diffDays===0) return 'Today';
  if(diffDays===1) return 'Tomorrow';
  return `In ${diffDays} days`;
}
function nextRecurringOccurrence(rec){
  const dates = recurringOccurrences(rec, rec.startDate, addDaysISO(toISO(today), 366));
  return dates.find(d=> recurringOccurrenceStatus(rec,d).status!=='Paid') || dates[dates.length-1] || null;
}
/* When a plain expense is logged, see if it matches an unpaid occurrence of an active recurring item
   in the same category — if so, auto-link them so the Calendar shows it as Paid automatically. */
function findMatchingRecurringOccurrence(section, mainCategory, subCategory, dateISO){
  const candidates = state.recurringBills.filter(r=>
    r.active && r.section===section && r.mainCategory===mainCategory && (r.subCategory||null)===(subCategory||null));
  const winStart = addDaysISO(dateISO, -20), winEnd = addDaysISO(dateISO, 20);
  let best = null, bestDist = Infinity;
  candidates.forEach(rec=>{
    recurringOccurrences(rec, winStart, winEnd).forEach(occISO=>{
      if(recurringOccurrenceStatus(rec, occISO).status==='Paid') return;
      const dist = Math.abs(new Date(occISO+'T00:00:00') - new Date(dateISO+'T00:00:00'));
      if(dist < bestDist){ bestDist = dist; best = {recurringId: rec.id, recurringDueDate: occISO}; }
    });
  });
  return best;
}
/* Total debt amount due within the currently-selected month (installment slots + standard loans with a due date this month) */
function debtDueThisMonth(){
  const mStart = monthKey(cur.year,cur.monthIndex)+'-01';
  const mEnd = monthKey(cur.year,cur.monthIndex)+'-'+String(daysInMonth(cur.year,cur.monthIndex)).padStart(2,'0');
  let total = 0;
  state.debts.forEach(d=>{
    if(d.repaymentType==='installment'){
      debtInstallmentSchedule(d).forEach(s=>{ if(s.dueDate>=mStart && s.dueDate<=mEnd) total += s.expected; });
    } else if(d.repaymentType==='standard' && d.dueDate>=mStart && d.dueDate<=mEnd && debtBalance(d)>0){
      total += debtBalance(d);
    }
  });
  return total;
}
/* Everything that actually left (or was set aside from) the household's available cash this month */
function totalCashOutflow(calc){
  return calc.totalExpenses + calc.savings.actualTotal + calc.debtPaymentsThisMonth;
}

/* =========================================================
   RENDER: SHELL
========================================================= */
function navTo(view){
  if(view==='expenses') view = curExpenseSection;
  if(EXPENSE_SECTIONS.includes(view) && !EXPENSE_SECTIONS.includes(curView)) curExpandedCats = {}; // fresh visit: everything collapsed
  if(EXPENSE_SECTIONS.includes(view)) curExpenseSection = view;
  curView = view; curDebtDetailId = null; closeMenu();
  renderAll();
  window.scrollTo({top:0});
}
function renderShell(){
  const nav = document.getElementById('navList');
  nav.innerHTML = NAV_ITEMS.map(item=>{
    const active = curView===item.id || (item.match||[]).includes(curView);
    return `<button class="navitem ${active?'active':''}" data-nav="${item.id}" ${active?'aria-current="page"':''}>${icon(item.icon)}<span>${item.label}</span></button>`;
  }).join('');
  nav.onclick = (e)=>{ const b = e.target.closest('[data-nav]'); if(b) navTo(b.dataset.nav); };

  const bn = document.getElementById('bottomNav');
  bn.innerHTML = BOTTOM_NAV.map(item=>{
    if(item.id==='__add') return `<button class="bn-add" data-bn="__add" aria-label="Add">${icon('plus')}</button>`;
    const active = curView===item.id || (item.match||[]).includes(curView);
    return `<button class="bn-item ${active?'active':''}" data-bn="${item.id}">${icon(item.icon)}<span>${item.label}</span></button>`;
  }).join('');
  bn.onclick = (e)=>{
    const b = e.target.closest('[data-bn]'); if(!b) return;
    if(b.dataset.bn==='__add') return openAddMenu(b);
    if(b.dataset.bn==='__more') return openMoreMenu(b);
    navTo(b.dataset.bn);
  };

  document.getElementById('msMonthLabel').innerHTML = '<span class="m-full">'+MONTH_NAMES[cur.monthIndex]+'</span><span class="m-short">'+MONTH_NAMES[cur.monthIndex].slice(0,3)+'</span>';
  document.getElementById('msYearLabel').textContent = cur.year;
  const hh = state.settings.householdName;
  document.getElementById('sidebarFootText').innerHTML =
    `<div class="sync-status" data-sync-status></div>${hh?`<div style="font-weight:700;">${escapeHtml(hh)}</div>`:''}`;
  renderTopChips();
  renderAvatar();
  renderAlertBell();
  if(window.Store) Store.renderStatus();
}
function accountInfo(){ return (window.Store && Store.accountInfo) ? Store.accountInfo() : {mode:'guest', email:null, cloudConfigured:false}; }
function renderAvatar(){
  const btn = document.getElementById('avatarBtn');
  if(!btn) return;
  const info = accountInfo();
  const label = info.email || state.settings.householdName || '';
  const nm = displayName() || (info.email ? info.email.split('@')[0] : 'Guest');
  btn.innerHTML = `<span class="av-circle">${label ? escapeHtml(label.trim().charAt(0).toUpperCase()) : icon('user')}<span class="av-status" data-sync-status></span></span><span class="av-text"><b>${escapeHtml(nm)}</b><small>Stay consistent ${icon('sprout','ic-xs')}</small></span>${icon('chevron-down','ic-sm av-chev')}`;
  btn.title = info.email ? `Signed in as ${info.email}` : 'Not signed in — data is saved on this device';
}
function openAccountMenu(anchor){
  const info = accountInfo();
  const items = [
    {heading: info.email ? info.email : 'Not signed in · saved on this device'},
    {label:'Settings', icon:'settings', onClick:()=>{ curSettingsTab='general'; navTo('settings'); }},
    {label:'Appearance', icon:'sun', onClick:()=>{ curSettingsTab='appearance'; navTo('settings'); }},
    {label:'Export backup', icon:'download', onClick:exportData},
    {label:'Download spreadsheet (CSV)', icon:'sheet', onClick:()=>exportCSV(null)},
    ...(isStandalone() ? [] : [{label:'Install app on this device', icon:'smartphone', onClick:installApp}]),
    {sep:true}
  ];
  if(info.mode==='cloud') items.push({label:'Sign out', icon:'log-out', tone:'danger', onClick:()=>Store.handleAction('account-signout')});
  else if(info.cloudConfigured) items.push({label:'Create account / Sign in', icon:'user', tone:'c-nec', onClick:()=>Store.handleAction('account-create')});
  openMenu(anchor, items);
}
function renderTopChips(){
  const el = document.getElementById('topChips');
  if(!el) return;
  if(curView==='dashboard'){ el.innerHTML=''; return; }
  const ctx = dashboardCtx(monthKey(cur.year, cur.monthIndex));
  const daysTxt = ctx.isPastMonth ? 'Month ended' : (ctx.isCurrentRealMonth ? `${ctx.daysLeft} day${ctx.daysLeft===1?'':'s'} left` : `${ctx.days} days`);
  el.innerHTML = `<span class="top-chip">${icon('calendar-days')}${daysTxt}</span>
    ${ctx.isPastMonth ? '' : `<span class="top-chip sun" title="${escapeHtml(ctx.allowanceNote)}">${icon('sun')}<span><span class="chip-small">Daily Allowance</span><span class="chip-big">${money(Math.floor(ctx.dailyAllowance))} / day</span></span></span>`}`;
}
function allocationSplitLabel(){
  const a = state.settings.allocations;
  return `${a.necessities}/${a.savings}/${a.extra}/${a.playjar}`;
}
function shiftMonth(delta){
  cur.monthIndex += delta;
  if(cur.monthIndex<0){ cur.monthIndex=11; cur.year--; }
  if(cur.monthIndex>11){ cur.monthIndex=0; cur.year++; }
  renderAll();
}
function openMonthPicker(anchor){
  let year = cur.year;
  const html = ()=>`<div class="year-row">
      <button class="icon-btn" data-y="-1" aria-label="Previous year">${icon('chevron-left')}</button>
      <span>${year}</span>
      <button class="icon-btn" data-y="1" aria-label="Next year">${icon('chevron-right')}</button>
    </div>
    <div class="month-grid">${MONTH_NAMES.map((n,i)=>`<button data-m="${i}" class="${year===cur.year&&i===cur.monthIndex?'active':''} ${year===today.getFullYear()&&i===today.getMonth()?'today':''}">${n.slice(0,3)}</button>`).join('')}</div>
    <div class="menu-sep"></div>
    <button class="menu-item" data-thismonth style="justify-content:center;font-weight:600;color:var(--accent);">Go to this month</button>`;
  const pop = openMenu(anchor, [], {html:html(), align:'left'});
  pop.style.width = '260px';
  if(!pop.classList.contains('sheet')){ const r = anchor.getBoundingClientRect(); pop.style.left = Math.max(8, r.left + r.width/2 - 130)+'px'; }
  pop.addEventListener('click', (e)=>{
    const y = e.target.closest('[data-y]'), m = e.target.closest('[data-m]');
    if(y){ year += Number(y.dataset.y); pop.innerHTML = html(); return; }
    if(m){ cur.year = year; cur.monthIndex = Number(m.dataset.m); closeMenu(); renderAll(); return; }
    if(e.target.closest('[data-thismonth]')){ cur.year = today.getFullYear(); cur.monthIndex = today.getMonth(); closeMenu(); renderAll(); }
  });
}
function openAddMenu(anchor){
  const key = monthKey(cur.year, cur.monthIndex);
  const activeDebts = state.debts.filter(d=>debtBalance(d)>0);
  const items = [
    {heading:'Add expense'},
    {label:'Necessities', icon:'house', tone:'c-nec', onClick:()=>openExpenseModal(key,'necessities',null)},
    {label:'Extra expenses', icon:'shopping-bag', tone:'c-extra', onClick:()=>openExpenseModal(key,'extra',null)},
    {label:'Play jar', icon:'party-popper', tone:'c-play', onClick:()=>openExpenseModal(key,'playjar',null)},
    {sep:true},
    {label:'Income', icon:'banknote', tone:'success', onClick:()=>openIncomeModal(key,null)},
    {label:'Savings deposit', icon:'piggy-bank', tone:'c-save', onClick:()=>{ navTo('savings'); }},
  ];
  if(activeDebts.length===1) items.push({label:`Payment to ${activeDebts[0].lender}`, icon:'hand-coins', tone:'c-debt', onClick:()=>openDebtPaymentModal(activeDebts[0].id, null)});
  else if(activeDebts.length>1) items.push({label:'Debt payment', icon:'hand-coins', tone:'c-debt', onClick:()=>{
    openMenu(anchor, [{heading:'Pay which debt?'}].concat(activeDebts.map(d=>({label:`${d.lender} · ${money(debtBalance(d))} left`, icon:'landmark', tone:'c-debt', onClick:()=>openDebtPaymentModal(d.id, null)}))));
  }});
  openMenu(anchor, items);
}
function openMoreMenu(anchor){
  openMenu(anchor, NAV_ITEMS.filter(n=>!['dashboard','calendar','expenses'].includes(n.id)).map(n=>({label:n.label, icon:n.icon, tone:'accent', onClick:()=>navTo(n.id)})));
}
document.getElementById('prevMonthBtn').innerHTML = icon('chevron-left');
document.getElementById('monthLabelBtn').insertAdjacentHTML('afterbegin', icon('calendar','ic-sm ms-cal'));
document.querySelectorAll('[data-brand-logo]').forEach(el=> el.innerHTML = brandLogoSVG());
document.getElementById('nextMonthBtn').innerHTML = icon('chevron-right');
document.getElementById('addBtn').innerHTML = `${icon('plus')}<span class="add-btn-label">Add</span>`;
document.getElementById('prevMonthBtn').addEventListener('click', ()=>shiftMonth(-1));
document.getElementById('nextMonthBtn').addEventListener('click', ()=>shiftMonth(1));
document.getElementById('monthLabelBtn').addEventListener('click', (e)=>openMonthPicker(e.currentTarget));
document.getElementById('addBtn').addEventListener('click', (e)=>openAddMenu(e.currentTarget));
document.getElementById('avatarBtn').addEventListener('click', (e)=>openAccountMenu(e.currentTarget));
document.getElementById('alertBtn').addEventListener('click', (e)=>openAlertsPanel(e.currentTarget));
(function wireSearch(){
  const input = document.getElementById('globalSearch'), box = document.getElementById('searchResults');
  const ic = document.querySelector('[data-search-icon]'); if(ic) ic.innerHTML = icon('search','ic-sm');
  if(!input || !box) return;
  let sel = -1;
  const mark = ()=> box.querySelectorAll('.sr-item').forEach((b,i)=>b.classList.toggle('active', i===sel));
  input.addEventListener('input', ()=>{ sel = -1; renderSearchResults(input); });
  input.addEventListener('focus', ()=>{ if(input.value.trim().length>=2) renderSearchResults(input); });
  input.addEventListener('keydown', (e)=>{
    const n = (box._results||[]).length;
    if(e.key==='ArrowDown' && n){ e.preventDefault(); sel = (sel+1)%n; mark(); }
    else if(e.key==='ArrowUp' && n){ e.preventDefault(); sel = (sel-1+n)%n; mark(); }
    else if(e.key==='Enter' && n){ e.preventDefault(); openSearchResult(box._results[Math.max(sel,0)]); }
    else if(e.key==='Escape'){ input.value=''; box.hidden = true; input.blur(); }
  });
  box.addEventListener('mousedown', (e)=>{ const b = e.target.closest('[data-sr]'); if(!b) return; e.preventDefault(); openSearchResult(box._results[Number(b.dataset.sr)]); });
  input.addEventListener('blur', ()=> setTimeout(()=>{ box.hidden = true; }, 120));
})();
window.addEventListener('scroll', ()=>{ document.getElementById('topbar').classList.toggle('scrolled', window.scrollY>4); }, {passive:true});

let chartRegistry = {};
function destroyChart(id){ if(chartRegistry[id]){ chartRegistry[id].destroy(); delete chartRegistry[id]; } }

function renderAll(){
  renderShell();
  const key = monthKey(cur.year, cur.monthIndex);
  ensureMonth(key);
  const main = document.getElementById('mainContent');
  let viewHtml = '';
  if(curView==='dashboard') viewHtml = viewDashboard(key);
  else if(curView==='income') viewHtml = viewIncome(key);
  else if(EXPENSE_SECTIONS.includes(curView)) viewHtml = viewSection(key, curView);
  else if(curView==='savings') viewHtml = viewSavings(key);
  else if(curView==='debts') viewHtml = viewDebts(key);
  else if(curView==='calendar') viewHtml = viewCalendar(key);
  else if(curView==='annual') viewHtml = viewAnnual(curYearForAnnual);
  else if(curView==='settings') viewHtml = viewSettings();
  main.innerHTML = '<div class="view-enter">'+viewHtml+'</div>';
  attachViewHandlers(key);
  if(curView==='annual') drawAnnualCharts(curYearForAnnual);
  if(curView==='dashboard') drawDashboardDonut();
  if(DONUT_SECTIONS.includes(curView)) drawSectionDonut(key, curView);
}

/* =========================================================
   VIEW: DASHBOARD
========================================================= */
/* Extra insight cards shown under the main dashboard; users can hide and reorder these. */
const SIMPLE_DASHBOARD_IDS = [];
const DASHBOARD_SECTIONS = {
  cashFlowCard: {title:'Cash flow', render: sectionCashFlowCard},
  debtPaydown: {title:'Debt paydown', render: sectionDebtPaydown},
  healthSnapshot: {title:'Financial health', render: sectionHealthSnapshot},
  whereMoneyWent: {title:'Top spending insights', render: sectionWhereMoneyWent},
  monthProgress: {title:'Month-to-date snapshot', render: sectionMonthProgress},
  notes: {title:'Notes for this month', render: sectionNotes}
};
function dashboardSectionOrder(){
  const prefs = state.settings.dashboardPrefs;
  const known = Object.keys(DASHBOARD_SECTIONS);
  const canonical = defaultSettings().dashboardPrefs.order.filter(id=>known.includes(id));
  let ordered = prefs.order.filter(id=>known.includes(id));
  // Slot any section the user's saved order doesn't know about yet (e.g. after an update)
  // into its canonical position, rather than always dumping it at the very end.
  canonical.forEach((id, idx)=>{
    if(!ordered.includes(id)){
      let insertAt = ordered.length;
      for(let j=idx+1;j<canonical.length;j++){
        const pos = ordered.indexOf(canonical[j]);
        if(pos!==-1){ insertAt = pos; break; }
      }
      ordered.splice(insertAt, 0, id);
    }
  });
  known.forEach(id=>{ if(!ordered.includes(id)) ordered.push(id); });
  return ordered;
}

/* ---------- Icons for buckets, categories, goals ---------- */
const BUCKETS = {
  necessities:{label:'Necessities', icon:'house', tone:'nec'},
  extra:{label:'Extra Expenses', icon:'shopping-cart', tone:'extra'},
  playjar:{label:'Play Jar', icon:'heart', tone:'play'},
  savings:{label:'Savings Target', icon:'sprout', tone:'save'},
  debt:{label:'Debt Payments', icon:'credit-card', tone:'debt'}
};
const CATEGORY_ICON_RULES = [
  [/rent|mortgage|housing|home|house/i,'house'], [/bill/i,'receipt'], [/subscri|stream|netflix|spotify/i,'repeat'],
  [/grocer|market/i,'shopping-basket'], [/dining|restaurant|eat out/i,'utensils-crossed'], [/food|meal|lunch|snack/i,'utensils'],
  [/coffee|cafe|tea/i,'coffee'], [/transport|commute|car|grab|taxi|parking/i,'car'], [/gas|fuel/i,'fuel'], [/bus|train|jeep/i,'bus'],
  [/electric|power|utilit/i,'zap'], [/water/i,'droplet'], [/internet|wifi|broadband/i,'wifi'], [/phone|mobile|load/i,'smartphone'],
  [/household|furnit|cleaning/i,'sofa'], [/medic|health|doctor|pharma|hospital/i,'stethoscope'], [/insur/i,'shield-check'],
  [/school|tuition|educat|book/i,'graduation-cap'], [/baby|kid|child/i,'baby'], [/pet|dog|cat/i,'paw-print'],
  [/shop|cloth|apparel/i,'shopping-bag'], [/gift|present/i,'gift'], [/beauty|salon|hair|skin/i,'sparkles'], [/personal|self/i,'user'],
  [/entertain|movie|cinema|concert/i,'clapperboard'], [/travel|trip|vacation|flight/i,'plane'], [/hobb|craft|art/i,'palette'],
  [/date|romance|love/i,'heart'], [/game|gaming/i,'gamepad-2'], [/gym|fitness|sport/i,'dumbbell'], [/loan|debt|credit/i,'credit-card'],
  [/donat|charity|church|tithe/i,'hand-heart'], [/misc|other/i,'shapes']
];
function categoryIcon(name){
  for(const [re, ic] of CATEGORY_ICON_RULES) if(re.test(name||'')) return ic;
  return 'tag';
}
function goalIcon(name){
  if(/emergenc|rainy|safety/i.test(name)) return 'shield';
  if(/house|home/i.test(name)) return 'house';
  if(/vacation|travel|trip/i.test(name)) return 'plane';
  if(/invest|stock|fund/i.test(name)) return 'trending-up';
  if(/car/i.test(name)) return 'car';
  if(/school|educat|college/i.test(name)) return 'graduation-cap';
  if(/wedding|ring/i.test(name)) return 'gem';
  if(/retire/i.test(name)) return 'sunset';
  return 'piggy-bank';
}
const GOAL_TONES = ['save','rose','nec','extra','play','debt'];
const SECTION_TONE = {necessities:'nec', extra:'extra', playjar:'play'};
function upcomingIcon(it){
  if(it.kind==='payday') return {ic:'user', tone:'save'};
  if(it.kind==='income') return {ic:'banknote', tone:'nec'};
  if(it.kind==='installment') return {ic:'credit-card', tone:'nec'};
  if(it.kind==='loan') return {ic:'landmark', tone:'play'};
  const ic = categoryIcon(it.label + ' ' + (it.category||''));
  return {ic: ic==='tag' ? 'receipt' : ic, tone:'rose'};
}

/* ---------- Botanical illustrations (generated SVG) ---------- */
function sprigSVG(o){
  const rad = (o.angle||0) * Math.PI/180;
  const P0 = [o.x, o.y];
  const P1 = [o.x + Math.sin(rad)*o.len, o.y - Math.cos(rad)*o.len];
  const nx = Math.cos(rad), ny = Math.sin(rad); // perpendicular
  const C = [(P0[0]+P1[0])/2 + nx*(o.curve||0), (P0[1]+P1[1])/2 + ny*(o.curve||0)];
  const pt = t=>[(1-t)*(1-t)*P0[0]+2*(1-t)*t*C[0]+t*t*P1[0], (1-t)*(1-t)*P0[1]+2*(1-t)*t*C[1]+t*t*P1[1]];
  const tan = t=>[2*(1-t)*(C[0]-P0[0])+2*t*(P1[0]-C[0]), 2*(1-t)*(C[1]-P0[1])+2*t*(P1[1]-C[1])];
  let out = `<path d="M${P0[0]} ${P0[1]} Q${C[0]} ${C[1]} ${P1[0]} ${P1[1]}" stroke="${o.color}" stroke-width="${o.stem||1.6}" fill="none" stroke-linecap="round" opacity="${o.opacity}"/>`;
  const n = o.leaves;
  for(let i=0;i<n;i++){
    const t = 0.18 + (0.8*(i/(n-1||1)));
    const [px,py] = pt(Math.min(t,0.98));
    const [tx,ty] = tan(t);
    const base = Math.atan2(ty, tx) * 180/Math.PI;
    const side = i===n-1 ? 0 : (i%2 ? 1 : -1);
    const L = o.size * (1 - 0.35*t), W = L*0.36;
    const rot = base + side*48;
    out += `<path transform="translate(${px.toFixed(1)} ${py.toFixed(1)}) rotate(${rot.toFixed(1)})" d="M0 0 C${(L*.3).toFixed(1)} ${(-W).toFixed(1)} ${(L*.75).toFixed(1)} ${(-W).toFixed(1)} ${L.toFixed(1)} 0 C${(L*.75).toFixed(1)} ${W.toFixed(1)} ${(L*.3).toFixed(1)} ${W.toFixed(1)} 0 0Z" fill="${o.color}" opacity="${o.opacity}"/>`;
  }
  return out;
}
/* ---------- Watercolor illustrations (all original, drawn in code) ----------
   Shapes are painted with the shared SVG filters in index.html:
   #wcPaint = wobbly edge + granulation + darker pigment pooling at the rim,
   #wcWash  = big soft bleeding washes, #wcInk = slightly shaky ink outlines. */
function WC_FILTER(){ return ''; }
function P(inner, op){ return `<g filter="url(#wcPaint)"${op!=null?` opacity="${op}"`:''}>${inner}</g>`; }
function INK(inner){ return `<g filter="url(#wcInk)" fill="none" stroke="#84624A" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" opacity=".75">${inner}</g>`; }
function artCottage(x, y, s){
  return `<g transform="translate(${x} ${y}) scale(${s})">
    ${P(`<rect x="0" y="16" width="44" height="30" fill="#F3DFC6"/>`, .95)}
    ${P(`<path d="M-6 18 L22 -4 L50 18Z" fill="#C9735E"/>`, .9)}
    ${P(`<rect x="33" y="-1" width="5" height="11" fill="#9C7A5E"/><rect x="17" y="28" width="10" height="18" fill="#84624A"/>`, .85)}
    ${P(`<rect x="5" y="22" width="8" height="8" fill="#F1D9A0"/><rect x="31" y="22" width="8" height="8" fill="#F1D9A0"/>`, .9)}
    ${INK(`<path d="M0 16 V46 H44 V16"/><path d="M-6 18 L22 -4 L50 18"/><path d="M17 46 V28 H27 V46"/><rect x="5" y="22" width="8" height="8"/><rect x="31" y="22" width="8" height="8"/><path d="M9 22 V30 M5 26 H13 M35 22 V30 M31 26 H39"/>`)}
  </g>`;
}
function artTree(x, y, s){
  return `<g transform="translate(${x} ${y}) scale(${s})">
    ${P(`<path d="M-2 14 Q0 26 -1 38 H3 Q2 26 2 14Z" fill="#84624A"/>`, .85)}
    ${P(`<circle cx="0" cy="6" r="15" fill="#627F5F"/>`, .78)}
    ${P(`<circle cx="-9" cy="13" r="10" fill="#7D9A75"/><circle cx="9" cy="12" r="9" fill="#8DAE85"/>`, .7)}
    ${P(`<circle cx="-4" cy="2" r="6" fill="#A7C4A0"/>`, .55)}
  </g>`;
}
function artCloud(x, y, s){
  return `<g transform="translate(${x} ${y}) scale(${s})" filter="url(#wcWash)" fill="#fff" opacity=".95"><ellipse cx="0" cy="0" rx="34" ry="11"/><ellipse cx="-14" cy="-5" rx="16" ry="10"/><ellipse cx="10" cy="-7" rx="14" ry="9"/></g>`;
}
function artBirds(x, y, s){
  return `<g transform="translate(${x} ${y}) scale(${s})" filter="url(#wcInk)" stroke="#6E665A" stroke-width="1.4" fill="none" stroke-linecap="round" opacity=".8"><path d="M0 0 q4 -4 8 0 q4 -4 8 0"/><path d="M20 -9 q3 -3 6 0 q3 -3 6 0"/></g>`;
}
/* An ordinary black cat sitting on a stone wall, seen from the side. */
function artCatOnWall(x, y, s){
  return `<g transform="translate(${x} ${y}) scale(${s})">
    ${P(`<g fill="#E6D8BE"><rect x="-30" y="22" width="22" height="11" rx="3"/><rect x="-7" y="22" width="24" height="11" rx="3"/><rect x="18" y="22" width="20" height="11" rx="3"/><rect x="-20" y="33" width="24" height="11" rx="3"/><rect x="5" y="33" width="25" height="11" rx="3"/></g>`, .95)}
    ${INK(`<g stroke="#A8936E" stroke-width="1"><rect x="-30" y="22" width="22" height="11" rx="3"/><rect x="-7" y="22" width="24" height="11" rx="3"/><rect x="18" y="22" width="20" height="11" rx="3"/><rect x="-20" y="33" width="24" height="11" rx="3"/><rect x="5" y="33" width="25" height="11" rx="3"/></g>`)}
    ${P(`<g fill="#3F3A32"><ellipse cx="6" cy="12" rx="10" ry="11"/><circle cx="5" cy="-4" r="7"/><path d="M0 -8 L1.5 -15 L5 -10Z"/><path d="M6 -10 L10 -15 L10.5 -8Z"/></g>`, .92)}
    ${INK(`<path d="M15 20 C29 18 32 4 26 -4" stroke="#3F3A32" stroke-width="3"/>`)}
  </g>`;
}
/* ---------- Watercolor botanicals (original, drawn in code) ----------
   Broad layered leaves shaded base-to-tip with the lf-* gradients, five-petal blossoms with the
   pt-* gradients, all painted through the shared #wcPaint / #wcWash / #wcInk filters in index.html. */
function seededRandom(seed){ let s = seed % 2147483647; if(s<=0) s += 2147483646; return ()=> (s = s*16807 % 2147483647) / 2147483647; }
/* One leaf pointing along +x from the origin: soft shading plus a pale centre vein. */
function wcLeafPath(L, W, grad, bend){
  const b = bend||0;
  return `<path d="M0 0 C${(L*.22).toFixed(1)} ${(-W+b).toFixed(1)} ${(L*.68).toFixed(1)} ${(-W*.9+b).toFixed(1)} ${L.toFixed(1)} ${b.toFixed(1)} C${(L*.68).toFixed(1)} ${(W*.9+b).toFixed(1)} ${(L*.22).toFixed(1)} ${(W+b).toFixed(1)} 0 0Z" fill="url(#${grad})"/>`;
}
function wcVein(L, W, bend){
  const b = bend||0;
  return `<path d="M${(L*.06).toFixed(1)} 0 Q${(L*.5).toFixed(1)} ${(b*.6 - W*.06).toFixed(1)} ${(L*.9).toFixed(1)} ${(b*.9).toFixed(1)}" stroke="#FFFFFF" stroke-width="${Math.max(.7, W*.07).toFixed(2)}" fill="none" opacity=".38" stroke-linecap="round"/>`;
}
/* A painted branch with alternating broad leaves.
   o = {x, y, angle (0 = up), len, curve, leaves, size, grads:[lf-*], width (leaf width ratio), seed, stem, opacity} */
function wcBranch(o){
  const rnd = seededRandom(o.seed || 7);
  const grads = o.grads || ['lf-deep','lf-mid','lf-light'];
  const rad = (o.angle||0) * Math.PI/180;
  const P0 = [o.x, o.y], P1 = [o.x + Math.sin(rad)*o.len, o.y - Math.cos(rad)*o.len];
  const nx = Math.cos(rad), ny = Math.sin(rad);
  const C = [(P0[0]+P1[0])/2 + nx*(o.curve||0), (P0[1]+P1[1])/2 + ny*(o.curve||0)];
  const pt = t=>[(1-t)*(1-t)*P0[0]+2*(1-t)*t*C[0]+t*t*P1[0], (1-t)*(1-t)*P0[1]+2*(1-t)*t*C[1]+t*t*P1[1]];
  const tan = t=>[2*(1-t)*(C[0]-P0[0])+2*t*(P1[0]-C[0]), 2*(1-t)*(C[1]-P0[1])+2*t*(P1[1]-C[1])];
  const layers = ['','',''];
  const veins = [];
  const n = o.leaves;
  for(let i=0;i<n;i++){
    const t = 0.14 + 0.82*(i/(n-1||1));
    const [px,py] = pt(Math.min(t,.985)), [tx,ty] = tan(t);
    const base = Math.atan2(ty,tx)*180/Math.PI;
    const side = i===n-1 ? 0 : (i%2 ? 1 : -1);
    const L = o.size * (1 - 0.42*t) * (0.82 + rnd()*0.36);
    const W = L * ((o.width||.36) + rnd()*0.08);
    const bend = (rnd()-.5) * W * .5;
    const rot = base + side*((o.spread||34) + rnd()*((o.spread||34)*.55));
    const grad = grads[Math.floor(rnd()*grads.length)];
    const tf = `translate(${px.toFixed(1)} ${py.toFixed(1)}) rotate(${rot.toFixed(1)})`;
    layers[i%3] += `<g transform="${tf}">${wcLeafPath(L, W, grad, bend)}</g>`;
    veins.push(`<g transform="${tf}">${wcVein(L, W, bend)}</g>`);
  }
  const op = o.opacity!=null ? o.opacity : .9;
  const stem = `<path d="M${P0[0]} ${P0[1]} Q${C[0].toFixed(1)} ${C[1].toFixed(1)} ${P1[0].toFixed(1)} ${P1[1].toFixed(1)}" stroke="${o.stem||'#6E8F69'}" stroke-width="${o.stemWidth||2}" fill="none" stroke-linecap="round"/>`;
  return `<g filter="url(#wcInk)" opacity="${(op*.85).toFixed(2)}">${stem}</g>${P(layers[0], op)}${P(layers[1], op-.08)}${P(layers[2], op-.14)}<g opacity="${op.toFixed(2)}">${veins.join('')}</g>`;
}
/* A five-petal watercolor blossom. */
function wcFlower(x, y, r, grad, rot){
  let petals = '';
  for(let i=0;i<5;i++) petals += `<ellipse cx="0" cy="${(-r*.55).toFixed(1)}" rx="${(r*.42).toFixed(1)}" ry="${(r*.6).toFixed(1)}" transform="rotate(${(i*72 + (rot||0)).toFixed(0)})" fill="url(#${grad||'pt-peach'})"/>`;
  return `<g transform="translate(${x} ${y})">${P(petals, .92)}${P(`<circle r="${(r*.22).toFixed(1)}" fill="#D9A657"/>`, .95)}<g fill="#B98E62" opacity=".7"><circle cx="${(r*.12).toFixed(1)}" cy="${(-r*.08).toFixed(1)}" r="${(r*.05).toFixed(1)}"/><circle cx="${(-r*.1).toFixed(1)}" cy="${(r*.06).toFixed(1)}" r="${(r*.05).toFixed(1)}"/></g></g>`;
}
/* Little clusters of round buds on short stems. */
function wcBuds(x, y, color, n, seed, r){
  const rnd = seededRandom(seed||3); let buds = '', stems = '';
  for(let i=0;i<n;i++){
    const bx = x + (rnd()-.5)*22, by = y + (rnd()-.5)*22, rr = (r||3.4)*(0.75+rnd()*.5);
    stems += `<path d="M${x} ${y+10} Q${((x+bx)/2).toFixed(1)} ${(by+8).toFixed(1)} ${bx.toFixed(1)} ${by.toFixed(1)}"/>`;
    buds += `<ellipse cx="${bx.toFixed(1)}" cy="${by.toFixed(1)}" rx="${(rr*.8).toFixed(1)}" ry="${rr.toFixed(1)}" fill="${color}"/>`;
  }
  return `<g filter="url(#wcInk)" stroke="#7D9A75" stroke-width="1" fill="none" opacity=".7">${stems}</g>${P(buds, .88)}`;
}
/* A thin stem of tiny pink blossoms, like sprigs of wildflowers. */
function wcFlowerSprig(x, y, angle, len, n, seed, grad){
  const rnd = seededRandom(seed||5);
  const rad = angle*Math.PI/180, ex = x + Math.sin(rad)*len, ey = y - Math.cos(rad)*len;
  let stems = `<path d="M${x} ${y} Q${(x+ex)/2 + 6} ${(y+ey)/2} ${ex.toFixed(1)} ${ey.toFixed(1)}"/>`;
  let flowers = '';
  for(let i=0;i<n;i++){
    const t = .45 + .55*(i/(n-1||1));
    const px = x + (ex-x)*t, py = y + (ey-y)*t;
    const off = (i%2?1:-1) * (6 + rnd()*8);
    const fx = px + Math.cos(rad)*off, fy = py + Math.sin(rad)*off - 3;
    stems += `<path d="M${px.toFixed(1)} ${py.toFixed(1)} L${fx.toFixed(1)} ${fy.toFixed(1)}"/>`;
    const r = 4.2 + rnd()*2.4;
    let petals = '';
    for(let k=0;k<5;k++) petals += `<ellipse cx="0" cy="${(-r*.5).toFixed(1)}" rx="${(r*.4).toFixed(1)}" ry="${(r*.55).toFixed(1)}" transform="rotate(${k*72 + rnd()*30})" fill="url(#${grad||'pt-pink'})"/>`;
    flowers += `<g transform="translate(${fx.toFixed(1)} ${fy.toFixed(1)})">${petals}<circle r="${(r*.18).toFixed(1)}" fill="#D9A657"/></g>`;
  }
  return `<g filter="url(#wcInk)" stroke="#8C9A82" stroke-width="1" fill="none" opacity=".75">${stems}</g>${P(flowers, .9)}`;
}
const SLIM = {width:.21, spread:26};
/* A daisy with many narrow petals, painted in soft peach. */
function wcDaisy(x, y, r, grad, rot, n){
  n = n || 12; let petals = '';
  for(let i=0;i<n;i++) petals += `<ellipse cx="0" cy="${(-r*.55).toFixed(1)}" rx="${(r*.17).toFixed(1)}" ry="${(r*.5).toFixed(1)}" transform="rotate(${(i*360/n + (rot||0)).toFixed(0)})" fill="url(#${grad||'pt-peach'})"/>`;
  return `<g transform="translate(${x} ${y})">${P(petals, .9)}${P(`<circle r="${(r*.2).toFixed(1)}" fill="#D9A657"/>`, .95)}<circle r="${(r*.1).toFixed(1)}" fill="#B98E62" opacity=".55"/></g>`;
}
/* A stem with a daisy on top and a couple of slender leaves. */
function wcDaisyStem(x, y, tx, ty, r, seed, grad){
  const mx = (x+tx)/2 + ((seed%2)?10:-10), my = (y+ty)/2;
  const ang = Math.atan2(tx-x, -(ty-y))*180/Math.PI;
  return `<g filter="url(#wcInk)" stroke="#7D9A75" stroke-width="1.3" fill="none" opacity=".8"><path d="M${x} ${y} Q${mx} ${my} ${tx} ${ty}"/></g>
    ${wcBranch({x:(x+mx)/2, y:(y+my)/2+10, angle:ang+(seed%2?-38:38), len:r*2.2, curve:6, leaves:3, size:r*1.3, seed, grads:['lf-sage','lf-dusty'], width:.24, spread:30, opacity:.85})}
    ${wcDaisy(tx, ty, r, grad, seed*17)}`;
}
/* Torn-paper note: rough-edged kraft paper with a strip of tape. */
function tornPaper(x, y, w, h, seed, fill){
  const rnd = seededRandom(seed||7); const pts = [];
  const j = ()=> (rnd()-.5)*4;
  for(let i=0;i<=10;i++) pts.push(`${(x + w*i/10 + j()).toFixed(1)},${(y + j()).toFixed(1)}`);
  for(let i=1;i<=8;i++) pts.push(`${(x + w + j()).toFixed(1)},${(y + h*i/8 + j()).toFixed(1)}`);
  for(let i=9;i>=0;i--) pts.push(`${(x + w*i/10 + (rnd()-.5)*5).toFixed(1)},${(y + h + (rnd()-.5)*7).toFixed(1)}`);
  for(let i=7;i>=1;i--) pts.push(`${(x + j()).toFixed(1)},${(y + h*i/8 + j()).toFixed(1)}`);
  const poly = pts.join(' ');
  return `<polygon points="${poly}" fill="#C9B79B" opacity=".35" transform="translate(2 3)"/>
    <polygon points="${poly}" fill="${fill||'#EFE3CC'}"/>
    <g filter="url(#wcWash)" opacity=".35"><ellipse cx="${x+w*.3}" cy="${y+h*.6}" rx="${w*.3}" ry="${h*.3}" fill="#E2CFAE"/></g>
    <rect x="${x+w/2-22}" y="${y-9}" width="44" height="16" fill="#F7F0E2" opacity=".75" transform="rotate(-4 ${x+w/2} ${y})"/>`;
}
/* Painted artwork lives in img/ as transparent WebP files. */
function artImg(name, cls, alt){ return `<img class="${cls||''}" src="img/${name}.webp?v=5" alt="${alt||''}" ${alt?'':'aria-hidden="true"'} decoding="async" draggable="false">`; }
/* Hero still life: mug, stacked books, and a vase of dried flowers. */
function stillLifeSVG(){ return artImg('still-life','still-life'); }
const TILE_SPRIG = {
  nec:{grads:['lf-sage','lf-olive','lf-dusty']}, save:{grads:['lf-sage','lf-dusty','lf-pale']},
  rose:{grads:['lf-blush','lf-sage'], flower:true}, play:{grads:['lf-blush','lf-dusty'], flower:true},
  sky:{grads:['lf-sky','lf-dusty','lf-pale']}, extra:{grads:['lf-gold','lf-dusty']}, debt:{grads:['lf-gold','lf-dusty']}, warn:{grads:['lf-gold','lf-dusty']}
};
/* A slender painted sprig tucked into the bottom-right of a tile. */
function tileSprigSVG(tone, seed){
  const t = TILE_SPRIG[tone] || TILE_SPRIG.save;
  const s = seed||9;
  return `<svg viewBox="0 0 130 130" preserveAspectRatio="xMaxYMax meet" aria-hidden="true">
    ${wcBranch({x:122, y:132, angle:-16, len:122, curve:-16, leaves:11, size:34, seed:s, grads:t.grads, width:.21, spread:26})}
    ${wcBranch({x:100, y:132, angle:-48, len:74, curve:8, leaves:7, size:28, seed:s+5, grads:t.grads, width:.22, spread:28, opacity:.75})}
    ${t.flower ? wcFlowerSprig(70, 126, -22, 56, 3, s) : ''}
  </svg>`;
}
/* Sign-in scene: soft washes framed by slender branches and pink sprigs. */
function authSceneSVG(){
  return `<svg viewBox="0 0 400 560" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <g filter="url(#wcWash)"><rect x="-40" y="-40" width="480" height="640" fill="#F5EEDF"/><ellipse cx="300" cy="110" rx="170" ry="90" fill="#E2EDF6" opacity=".8"/><path d="M150 160 C240 140 340 150 370 200 C380 300 360 360 300 380 C230 390 170 370 150 330 C136 270 136 200 150 160Z" fill="#F2D9CE" opacity=".6"/><ellipse cx="70" cy="490" rx="190" ry="110" fill="#E4EDDF" opacity=".9"/></g>
    ${wcBranch({x:30, y:560, angle:10, len:500, curve:40, leaves:22, size:80, seed:11, grads:['lf-sage','lf-olive','lf-sage'], width:.2, spread:24, stemWidth:2})}
    ${wcBranch({x:0, y:540, angle:30, len:360, curve:24, leaves:16, size:70, seed:61, grads:['lf-dusty','lf-pale'], width:.21, spread:28, opacity:.75})}
    ${wcFlowerSprig(70, 420, 20, 160, 7, 4)}${wcFlowerSprig(36, 360, 34, 100, 4, 9, 'pt-blush')}
    ${wcBranch({x:-10, y:570, angle:58, len:240, curve:-30, leaves:11, size:84, seed:5, grads:['lf-olive','lf-sage','lf-dusty'], width:.34, spread:40})}
    ${wcBranch({x:190, y:576, angle:-36, len:190, curve:16, leaves:10, size:72, seed:19, grads:['lf-sage','lf-pale','lf-dusty'], width:.32, spread:42})}
    ${wcBranch({x:410, y:-10, angle:212, len:260, curve:-30, leaves:14, size:62, seed:29, grads:['lf-sage','lf-dusty','lf-pale'], width:.2, spread:26})}
    ${wcFlowerSprig(330, 60, 200, 90, 4, 12)}
  </svg>`;
}
function heroArtSVG(){ return tileSprigSVG('nec', 3); }


/* Small watercolor doodles for encouragement and empty states. */
const DOODLES = {
  sun:`<svg class="sun-doodle" width="34" height="22" viewBox="0 0 34 22" aria-hidden="true"><g filter="url(#wcInk)" stroke="#D9A657" stroke-width="1.6" stroke-linecap="round" fill="none"><path d="M7 20 A10 10 0 0 1 27 20"/><path d="M17 4 V7 M6 9 L8 11 M28 9 L26 11 M2 17 H5 M29 17 H32"/></g><path d="M9 20 A8 8 0 0 1 25 20Z" fill="#F1D9A0" opacity=".7" filter="url(#wcPaint)"/></svg>`,
  sprout:`<svg width="54" height="54" viewBox="0 0 54 54" aria-hidden="true">${P('<path d="M14 34 H40 L37 50 H17Z" fill="#C9735E"/><rect x="12" y="30" width="30" height="6" rx="2" fill="#B5604F"/>', .9)}${INK('<path d="M27 30 Q26 20 27 10" stroke="#627F5F" stroke-width="2"/>')}${P('<path d="M27 18 C18 16 14 10 14 6 C22 6 27 12 27 18Z" fill="#7D9A75"/><path d="M27 14 C35 12 39 6 40 2 C32 2 27 8 27 14Z" fill="#A7C4A0"/>', .9)}</svg>`,
  teacup:`<svg width="54" height="54" viewBox="0 0 54 54" aria-hidden="true">${INK('<path d="M20 14 c-2 -4 2 -6 0 -10 M28 14 c-2 -4 2 -6 0 -10" stroke="#B9A684" stroke-width="1.6"/>')}${P('<ellipse cx="25" cy="44" rx="19" ry="3.5" fill="#E8C9A8"/><path d="M10 20 H40 C40 34 34 40 25 40 C16 40 10 34 10 20Z" fill="#FFFDF6"/>', .95)}${P('<path d="M14 26 C18 24 22 29 26 26 C29 24 33 27 36 25 L35 30 C30 33 20 33 15 30Z" fill="#8FB7D9"/>', .6)}${INK('<path d="M10 20 H40 C40 34 34 40 25 40 C16 40 10 34 10 20Z"/><path d="M40 24 C47 24 47 33 39 32"/>')}</svg>`,
  books:`<svg width="54" height="54" viewBox="0 0 54 54" aria-hidden="true">${P('<rect x="8" y="36" width="38" height="8" rx="1.5" fill="#627F5F"/>', .85)}${P('<rect x="11" y="28" width="32" height="8" rx="1.5" fill="#E79B8B"/>', .85)}${P('<rect x="9" y="20" width="35" height="8" rx="1.5" fill="#8FB7D9"/>', .85)}${P('<path d="M31 20 V8 C34 6 38 6 40 8 V20" fill="#D9A657"/>', .85)}${INK('<path d="M38 12 C42 8 44 4 45 2" stroke="#627F5F" stroke-width="1.6"/>')}${P('<path d="M44 4 C47 3 49 5 49 7 C46 8 44 6 44 4Z" fill="#7D9A75"/>', .9)}</svg>`,
  lantern:`<svg width="54" height="54" viewBox="0 0 54 54" aria-hidden="true"><g filter="url(#wcWash)" opacity=".5"><circle cx="27" cy="25" r="16" fill="#F1D9A0"/></g>${INK('<path d="M27 2 V8"/>')}${P('<path d="M21 8 H33 L35 12 H19Z" fill="#84624A"/><path d="M19 36 H35 L32 41 H22Z" fill="#84624A"/>', .9)}${P('<rect x="18" y="12" width="18" height="24" rx="3" fill="#F6E7C9"/>', .95)}${P('<ellipse cx="27" cy="25" rx="5" ry="7" fill="#D9A657"/>', .8)}${INK('<rect x="18" y="12" width="18" height="24" rx="3"/>')}</svg>`
};
function doodleNote(kind, title, text){
  return `<div class="doodle-note">${kind===null ? '' : (DOODLES[kind]||DOODLES.sprout)}<span>${title?`<span class="hand">${escapeHtml(title)}</span>`:''}${text}</span></div>`;
}
/* A gentle, data-aware line of encouragement for the dashboard. */
function encouragement(calc){
  const secs = ['necessities','extra','playjar'];
  const over = secs.filter(s=> calc[s].budget>0 && calc[s].actual > calc[s].budget);
  const saved = calc.savings.actualTotal, target = calc.savings.budgetTotal;
  if(!calc.totalIncome && !calc.totalExpenses) return {title:'A fresh page', line:'Add this month’s income to get started.', art:'books'};
  if(over.length) return {title:'A gentle nudge', line:`${sectionLabel(over[0])} went a little over. Tomorrow is a new page.`, art:'teacup'};
  if(target>0 && saved >= target) return {title:'Savings goal reached!', line:'Every peso you set aside grows your garden.', art:null};
  if(calc.netCashFlow > 0) return {title:'You’re doing great!', line:'Consistency builds a brighter tomorrow.', art:'sprout'};
  return {title:'Steady does it', line:'Small steps, big places.', art:'lantern'};
}

function brandLogoSVG(){
  return `<svg class="brand-logo" viewBox="0 0 44 44" aria-hidden="true">
    <path d="M16 40 C17 31 19 24 24 17" stroke="var(--accent-ink)" stroke-width="2.2" fill="none" stroke-linecap="round"/>
    <path d="M22 20 C21 10 28 4 40 3 C41 15 34 22 22 20Z" fill="var(--accent)"/>
    <path d="M23 19 C28 14 32 10 37 6" stroke="var(--surface)" stroke-width="1.3" fill="none" stroke-linecap="round" opacity=".8"/>
    <path d="M18 27 C15 18 8 15 2 16 C2 25 9 30 18 27Z" fill="var(--accent)" opacity=".75"/>
    <path d="M17 26 C13 22 9 20 5 19" stroke="var(--surface)" stroke-width="1.2" fill="none" stroke-linecap="round" opacity=".8"/>
  </svg>`;
}

/* ---------- Dashboard ---------- */
let curDashCatFilter = 'all';
function deltaInfo(curV, prevV, upIsGood){
  if(prevV===null || prevV===undefined || !isFinite(prevV) || Math.abs(prevV)<0.005) return null;
  const diff = curV - prevV;
  const pctV = Math.abs(diff/prevV*100);
  if(Math.abs(diff) < 0.005) return {cls:'flat', arrow:'minus', pct:0, diff};
  const up = diff > 0;
  return {cls: (up===upIsGood) ? 'good' : 'bad', arrow: up ? 'arrow-up' : 'arrow-down', pct:pctV, diff};
}
function deltaPill(d){
  if(!d) return '';
  return `<div class="delta-wrap"><span class="delta ${d.cls}">${icon(d.arrow)}${pct(d.pct)}</span><span class="delta-note">vs last month</span></div>`;
}
function dashboardCtx(key){
  const calc = computeMonth(key);
  const m = getMonth(key,true);
  const days = daysInMonth(cur.year, cur.monthIndex);
  const isCurrentRealMonth = (cur.year===today.getFullYear() && cur.monthIndex===today.getMonth());
  const isPastMonth = (new Date(cur.year, cur.monthIndex, 1)) < (new Date(today.getFullYear(), today.getMonth(), 1));
  let daysLeft, dailyAllowance, allowanceNote;
  const discretionary = calc.extra.remaining + calc.playjar.remaining;
  if(isPastMonth){
    daysLeft = 0; dailyAllowance = 0; allowanceNote = 'This month has ended.';
  } else {
    daysLeft = isCurrentRealMonth ? (days - today.getDate() + 1) : days;
    if(discretionary <= 0){
      dailyAllowance = 0;
      allowanceNote = discretionary < 0 ? 'Discretionary budget exceeded.' : 'No discretionary budget left.';
    } else {
      dailyAllowance = discretionary / daysLeft;
      allowanceNote = 'From remaining Extra Expenses + Play Jar';
    }
  }
  const prev = calc.hasPrev ? computeMonthShallowFull(calc.prevKey) : null;
  return {key, calc, m, prev, health: financialHealthScore(calc), days, daysLeft, dailyAllowance, allowanceNote, discretionary, isCurrentRealMonth, isPastMonth};
}
/* Name used in the dashboard greeting and account button. */
function displayName(){
  const e = earners()[0];
  if(e && !/^me$/i.test(e.name.trim())) return e.name.trim();
  if(state.settings.householdName) return state.settings.householdName;
  const info = (typeof accountInfo==='function') ? accountInfo() : null;
  if(info && info.email){ const n = info.email.split('@')[0].replace(/[._-]+/g,' ').replace(/\d+/g,'').trim(); if(n) return n.charAt(0).toUpperCase()+n.slice(1); }
  return '';
}
function greeting(){
  const h = new Date().getHours();
  return h < 12 ? 'Good morning,' : h < 18 ? 'Good afternoon,' : 'Good evening,';
}
function viewDashboard(key){
  const ctx = dashboardCtx(key);
  const {calc, prev} = ctx;

  let rolloverBanner = '';
  if(calc.hasPrev){
    const prevM = state.months[calc.prevKey];
    const prevCalc = computeMonthShallow(calc.prevKey);
    const undecided = ['necessities','extra','playjar'].filter(sec=> prevM.rollover[sec]===null && prevCalc[sec].remaining > 0);
    if(undecided.length){
      rolloverBanner = `<div class="banner gold">
        <div class="banner-text" style="display:flex;gap:12px;align-items:flex-start;"><span class="badge-ic sm t-warn">${icon('sparkles')}</span><span><strong>Leftover budget from ${MONTH_NAMES[cur_moOf(calc.prevKey)]}</strong><br>
        ${undecided.map(sec=>`${sectionLabel(sec)}: ${money(prevCalc[sec].remaining)}`).join(' · ')} — decide what happens to it.</span></div>
        <div class="banner-actions">${undecided.map(sec=>`<button class="btn btn-sm" data-action="decide-rollover" data-section="${sec}" data-monthkey="${calc.prevKey}">${sectionLabel(sec)}</button>`).join('')}</div>
      </div>`;
    }
  }

  const prefs = state.settings.dashboardPrefs;
  const moreIds = prefs.view==='simple' ? [] : dashboardSectionOrder().filter(id=>!prefs.hidden[id]);
  const moreHtml = moreIds.map(id=>{
    const def = DASHBOARD_SECTIONS[id];
    return `<details class="card dash-section" open>
      <summary class="section-title" style="margin:0;">${def.title}</summary>
      <div class="dash-section-body">${def.render(ctx)}</div>
    </details>`;
  }).join('');
  const name = displayName();
  const daysTxt = ctx.isPastMonth ? 'This month has ended' : (ctx.isCurrentRealMonth ? `${ctx.daysLeft} day${ctx.daysLeft===1?'':'s'} left this month` : `${ctx.days} days in ${MONTH_NAMES[cur.monthIndex]}`);

  return `<div class="dash">
    <header class="dash-header">
      <div class="dash-greet">
        <div class="dash-welcome">${greeting()}</div>
        <h1 class="dash-title">${name ? escapeHtml(name) : 'Welcome back'} ${DOODLES.sun}</h1>
        <div class="dash-sub">Here’s your financial overview for today.</div>
      </div>
      <div class="hero-meta header-meta">
        ${ctx.isPastMonth ? '' : `<span class="hero-chip" title="${escapeHtml(ctx.allowanceNote)}">${icon('sun','ic-sm')}${money(Math.floor(ctx.dailyAllowance))} / day to spend</span>`}
        <span class="hero-chip">${icon('calendar-days','ic-sm')}${daysTxt}</span>
      </div>
      <div class="dash-corner">${stillLifeSVG()}</div>
    </header>
    ${rolloverBanner}

    <div class="dash-top">
    <section class="card hero-banner">
      <div class="hero-banner-text">
        <div class="hero-pair">
          <div class="hero-fig">
            <h2 class="hero-fig-title">Available to Budget <span class="info-dot" title="Income this month minus debt payments — the amount your budget split is based on.">${icon('info','ic-sm')}</span></h2>
            <div class="hero-big">${money(calc.budgetableIncome)}</div>
            <div class="hero-note">after debt payments</div>
          </div>
          <span class="hero-fig-split" aria-hidden="true"></span>
          <div class="hero-fig">
            <h2 class="hero-fig-title">Available Cash <span class="info-dot" title="Cash received (income + borrowed) minus expenses, savings, and debt payments.">${icon('info','ic-sm')}</span></h2>
            <div class="hero-big ${calc.netCashFlow<0?'neg':''}">${money(calc.netCashFlow)}</div>
            <div class="hero-note">after spending &amp; saving</div>
          </div>
        </div>
      </div>
    </section>

    <div class="kpi3">
      ${kpiCard('This Month’s Income', 'leaf', 'save', calc.totalIncome, deltaInfo(calc.totalIncome, prev && prev.totalIncome, true), 'income')}
      ${kpiCard('Debt Paid', 'credit-card', 'rose', calc.debtPaymentsThisMonth, deltaInfo(calc.debtPaymentsThisMonth, prev && prev.debtPaymentsThisMonth, false), 'debts')}
      ${kpiCard('Saved This Month', 'piggy-bank', 'sky', calc.savings.actualTotal, deltaInfo(calc.savings.actualTotal, prev && prev.savingsActualTotal, true), 'savings')}
    </div>
    </div>

    <div class="dash-grid2">
      <div class="card">
        <div class="card-head"><h3 class="card-title">Budget Overview</h3><span class="card-chip">${ctx.isCurrentRealMonth?'This Month':MONTH_NAMES[cur.monthIndex].slice(0,3)+' '+cur.year}</span></div>
        ${budgetDonut(calc)}
      </div>
      <div class="card">
        <div class="card-head"><h3 class="card-title">Upcoming Bills / Paydays</h3><span style="display:flex;gap:8px;align-items:center;">${(()=>{ const n = overdueCount(ctx.key); return n ? `<button class="card-chip rose" data-action="goto" data-view="calendar">${icon('circle-alert','ic-sm')}${n} overdue</button>` : ''; })()}<button class="card-link" data-action="goto" data-view="calendar">View Calendar ${icon('arrow-right','ic-sm')}</button></span></div>
        ${upcomingList(ctx.key)}
      </div>
      <div class="card">
        <div class="card-head"><h3 class="card-title">Spending Breakdown</h3><span class="card-chip">By category</span></div>
        ${categoryBars(ctx)}
      </div>
      <div class="card">
        <div class="card-head"><h3 class="card-title">Savings Goals</h3><button class="card-link" data-action="goto" data-view="savings">View All ${icon('arrow-right','ic-sm')}</button></div>
        ${savingsProgress(calc)}
        <button class="add-goal-btn" data-action="add-goal">${icon('plus','ic-sm')}Add a Savings Goal</button>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3 class="card-title">Month Comparison</h3><span class="card-chip">Income vs Expenses</span></div>
      ${monthComparison(calc, prev)}
    </div>

    ${moreHtml ? `<div class="card-head" style="margin:8px 0 -4px;"><h3 class="card-title">More Insights</h3><button class="card-chip" data-action="customize-dashboard">${icon('sliders-horizontal','ic-sm')}Customize</button></div>
      <div class="dash-more">${moreHtml}</div>` :
      `<div style="text-align:center;"><button class="card-chip" data-action="customize-dashboard">${icon('sliders-horizontal','ic-sm')}Customize dashboard</button></div>`}
  </div>`;
}
/* Tile used across pages: round icon, label, serif figure, change vs last month, and a little bar graphic. */
const KPI_TONE_ALIAS = {save:'save', nec:'nec', rose:'rose', play:'rose', sky:'sky', extra:'extra', debt:'debt', warn:'debt'};
function kpiCard(label, ic, tone, value, delta, view, display){
  const t = KPI_TONE_ALIAS[tone] || 'save';
  const d = delta ? `<div class="kpi-tile-delta ${delta.cls}">${delta.arrow==='minus'?'—':icon(delta.arrow,'ic-xs')} ${pct(delta.pct)} <span>from last month</span></div>` : '';
  return `<div class="card kpi-tile tone-${t}" ${view?`data-action="goto" data-view="${view}" style="cursor:pointer;"`:''}>
    <span class="kpi-circle">${icon(ic)}</span>
    <div class="kpi-tile-body">
      <div class="kpi-tile-label">${label}</div>
      <div class="kpi-tile-value">${display!=null?escapeHtml(display):money(value)}</div>
      ${d}
    </div>
  </div>`;
}
function budgetRowsData(calc){
  const a = state.settings.allocations;
  return [
    {key:'necessities', view:'necessities', pctA:a.necessities, actual:calc.necessities.actual, budget:calc.necessities.budget},
    {key:'extra', view:'extra', pctA:a.extra, actual:calc.extra.actual, budget:calc.extra.budget},
    {key:'playjar', view:'playjar', pctA:a.playjar, actual:calc.playjar.actual, budget:calc.playjar.budget},
    {key:'savings', view:'savings', pctA:a.savings, actual:calc.savings.actualTotal, budget:calc.savings.budgetTotal}
  ];
}
function spendingSlices(calc){
  return [
    {key:'necessities', label:'Necessities', amount:calc.necessities.actual},
    {key:'extra', label:'Extra Expenses', amount:calc.extra.actual},
    {key:'playjar', label:'Play Jar', amount:calc.playjar.actual},
    {key:'debt', label:'Debt Payments', amount:calc.debtPaymentsThisMonth},
    {key:'savings', label:'Savings', amount:calc.savings.actualTotal}
  ];
}
/* Budget overview: donut of where the month's money went, legend with amounts and shares. */
function budgetDonut(calc){
  const slices = spendingSlices(calc);
  const total = sumBy(slices, s=>s.amount);
  const tone = {necessities:'nec', extra:'extra', playjar:'play', debt:'debt', savings:'save'};
  const budget = sumBy(budgetRowsData(calc), r=>r.budget);
  return `<div class="bd-wrap">
    ${total>0 ? `<div class="donut-wrap"><canvas id="dashDonut" aria-label="Where this month's money went"></canvas>
      <div class="donut-center"><b>${money(Math.round(total))}</b><span>used</span></div></div>`
      : `<div class="empty-chart">Nothing recorded yet this month</div>`}
    <div class="bd-legend">${slices.map(s=>`<button class="bd-item" data-action="goto" data-view="${s.key==='debt'?'debts':s.key==='savings'?'savings':s.key}">
      <span class="dot" style="background:var(--c-${tone[s.key]})"></span>
      <span class="bd-name">${s.label}</span>
      <span class="bd-amt">${money(Math.round(s.amount))}</span>
      <span class="bd-pct">${total>0?pct(s.amount/total*100):'—'}</span>
    </button>`).join('')}
    ${budget>0?`<div class="bd-foot">${money(Math.round(total))} used of ${money(Math.round(budget))} planned</div>`:''}</div>
  </div>`;
}
/* Draws percentages on the donut slices themselves. */
const donutLabelsPlugin = {
  id:'donutLabels',
  afterDatasetsDraw(chart){
    const {ctx} = chart; const ds = chart.data.datasets[0]; const total = ds.data.reduce((a,b)=>a+b,0);
    if(!total) return;
    ctx.save();
    ctx.font = "600 11px Lora, serif"; ctx.textAlign='center'; ctx.textBaseline='middle';
    chart.getDatasetMeta(0).data.forEach((arc,i)=>{
      const p = ds.data[i]/total*100; if(p < 7) return;
      const pos = arc.tooltipPosition();
      ctx.fillStyle = 'rgba(255,255,255,.95)'; ctx.fillText(Math.round(p)+'%', pos.x, pos.y);
    });
    ctx.restore();
  }
};
function drawDashboardDonut(){
  destroyChart('dashDonut');
  const el = document.getElementById('dashDonut');
  if(el){
    const calc = computeMonth(monthKey(cur.year, cur.monthIndex));
    const slices = spendingSlices(calc).filter(s=>s.amount>0);
    chartRegistry['dashDonut'] = new Chart(el, {
      type:'doughnut',
      data:{ labels:slices.map(s=>s.label), datasets:[{data:slices.map(s=>s.amount), backgroundColor:slices.map(s=>bucketColor(s.key)), borderWidth:2, borderColor:cssVar('--surface')}] },
      options:{ responsive:true, maintainAspectRatio:false, cutout:'60%',
        plugins:{ legend:{display:false},
          tooltip:{ callbacks:{ label:(item)=>{
            const total = item.dataset.data.reduce((a,b)=>a+b,0);
            return ` ${item.label}: ${money(item.parsed)} (${total>0?pct(item.parsed/total*100):'0%'})`;
          }}}
        }
      },
      plugins:[donutLabelsPlugin]
    });
  }
  drawDashCompare();
}
/* Spending breakdown: this month's top categories across all expense sections. */
function categoryBars(ctx){
  const totals = {};
  ['necessities','extra','playjar'].forEach(sec=>{
    (ctx.m[sec].expenses||[]).forEach(e=>{
      const k = e.mainCategory || 'Other';
      if(!totals[k]) totals[k] = {name:k, sec, amount:0};
      totals[k].amount += Number(e.amount)||0;
    });
  });
  let rows = Object.values(totals).sort((a,b)=>b.amount-a.amount);
  if(!rows.length) return doodleNote('teacup', 'Nothing spent yet', 'Your top spending categories will show here once you log expenses.');
  if(rows.length > 6){
    const rest = rows.slice(5);
    rows = rows.slice(0,5).concat([{name:'Others', sec:null, amount:sumBy(rest, r=>r.amount)}]);
  }
  const total = sumBy(rows, r=>r.amount);
  const max = Math.max(...rows.map(r=>r.amount), 1);
  const tones = ['nec','extra','play','save','debt','muted'];
  return `<div class="cb2-list">${rows.map((r,i)=>{
    const tone = r.sec ? catTone(r.sec, r.name) : 'muted';
    const barTone = tones[i % tones.length];
    return `<button class="cb2-row" ${r.sec?`data-action="goto" data-view="${r.sec}"`:''}>
      <span class="cb2-ic t-${tone}">${icon(r.sec ? catIconFor(r.sec, r.name) : 'ellipsis','ic-sm')}</span>
      <span class="cb2-name">${escapeHtml(r.name)}</span>
      <span class="bar-track"><span class="bar-fill bf-${barTone==='muted'?'debt':barTone}" style="display:block;width:${(r.amount/max*100).toFixed(1)}%"></span></span>
      <span class="cb2-amt">${money(r.amount)}</span>
      <span class="cb2-pct">${pct(r.amount/total*100)}</span>
    </button>`;
  }).join('')}</div>`;
}
function upcomingList(key){
  const items = computeUpcomingItems(key).filter(it=>it.date>=toISO(today)).slice(0,5);
  if(!items.length) return doodleNote('teacup', 'All quiet for now', 'Nothing due in the next 30 days. Add paydays in Settings or recurring bills from the Calendar.');
  const kind = {payday:'Salary', income:'Recurring income', bill:'Bill', installment:'Installment', loan:'Loan payment'};
  return `<div class="up-list">${items.map(it=>{
    const d = new Date(it.date+'T00:00:00');
    const ui = upcomingIcon(it);
    const days = Math.round((d - new Date(toISO(today)+'T00:00:00'))/86400000);
    const incoming = it.kind==='payday' || it.kind==='income';
    const when = days===0 ? 'Today' : days===1 ? (incoming?'Tomorrow':'Due tomorrow') : (incoming?`In ${days} days`:`Due in ${days} days`);
    return `<div class="up-row">
      <div class="date-tile"><small>${d.toLocaleDateString('en-US',{month:'short'})}</small><b>${String(d.getDate()).padStart(2,'0')}</b></div>
      <span class="badge-ic t-${ui.tone}">${icon(ui.ic)}</span>
      <div class="up-name"><b>${escapeHtml(it.label)}</b><small>${kind[it.kind]||''}</small></div>
      <div class="up-right"><b>${it.amount!==null?money(it.amount):'—'}</b><span class="up-when ${incoming?'in':'out'}">${it.status==='Received'?'Received':when}</span></div>
    </div>`;
  }).join('')}</div>`;
}
function savingsProgress(calc){
  const s = calc.savings;
  const goals = s.goals.filter(g=>g.active);
  if(!goals.length){
    return doodleNote('sprout', 'Plant your first goal', 'Add a savings goal and set how much you’ll put aside each month.');
  }
  return `<div class="sp-list">${goals.slice(0,4).map(g=>{
    const total = totalSavedAllTime(g.id);
    const hasTarget = g.target>0;
    const ratio = hasTarget ? total/g.target : (g.budget>0 ? g.actual/g.budget : 0);
    const tone = iconTone(goalIconFor(g),'nec');
    return `<div class="sp-row">
      <span class="sp-thumb t-${tone}">${icon(goalIconFor(g))}</span>
      <div class="sp-main">
        <b class="sp-name">${escapeHtml(g.name)}</b>
        <span class="sp-amt">${money(hasTarget?total:g.actual)} / ${money(hasTarget?g.target:g.budget)}</span>
        <div class="sp-bar">${barHtml(ratio, 'nec', true)}<span class="sp-pct">${pct(ratio*100)}</span></div>
      </div>
      ${kebab('goal',{id:g.id})}
    </div>`;
  }).join('')}</div>`;
}
/* Six-month income vs expenses bars, with a short handwritten summary. */
function monthComparison(calc, prev){
  const lines = [];
  if(prev){
    const ch = (a,b)=> b>0 ? (a-b)/b*100 : null;
    const inc = ch(calc.totalIncome, prev.totalIncome), exp = ch(calc.totalExpenses, prev.totalExpenses);
    if(inc!==null) lines.push(`Your income ${inc>=0?'increased':'decreased'} by <b>${pct(Math.abs(inc))}</b>`);
    if(exp!==null) lines.push(`expenses ${exp<=0?'decreased':'increased'} by <b>${pct(Math.abs(exp))}</b>`);
  }
  const e = encouragement(calc);
  const summary = lines.length ? `${lines.join(' and ')} compared to last month.` : 'Comparisons appear once you have a previous month recorded.';
  return `<div class="mc-wrap">
    <div class="mc-chart"><canvas id="dashCompare" aria-label="Income vs expenses for the last six months"></canvas></div>
    <div class="mc-note">
      ${e.art ? DOODLES[e.art] : ''}
      <div class="hand">${escapeHtml(e.title)}</div>
      <p>${summary}</p>
    </div>
  </div>`;
}
function drawDashCompare(){
  destroyChart('dashCompare');
  const el = document.getElementById('dashCompare');
  if(!el) return;
  const labels = [], income = [], expenses = [];
  for(let i=5;i>=0;i--){
    let y = cur.year, m = cur.monthIndex - i; while(m<0){ m+=12; y--; }
    const key = monthKey(y,m);
    const c = state.months[key] ? computeMonthShallowFull(key) : null;
    labels.push(MONTH_NAMES[m].slice(0,3)); income.push(c?c.totalIncome:0); expenses.push(c?c.totalExpenses+c.debtPaymentsThisMonth:0);
  }
  const tick = (v)=>{ const n = Number(v); return Math.abs(n)>=1000 ? currencySymbol()+(n/1000).toLocaleString(undefined,{maximumFractionDigits:0})+'K' : money(n); };
  chartRegistry['dashCompare'] = new Chart(el, {
    type:'bar',
    data:{ labels, datasets:[
      {label:'Income', data:income, backgroundColor:bucketColor('necessities'), borderRadius:6, maxBarThickness:16},
      {label:'Expenses', data:expenses, backgroundColor:cssVar('--c-play'), borderRadius:6, maxBarThickness:16}
    ]},
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{position:'bottom'}, tooltip:{callbacks:{label:(it)=>` ${it.dataset.label}: ${money(it.parsed.y)}`}} },
      scales:{ x:{grid:{display:false}}, y:{border:{display:false}, ticks:{callback:tick, maxTicksLimit:5}} } }
  });
}
function overdueCount(key){
  const t0 = toISO(today);
  return computeUpcomingItems(key).filter(it=>it.date<t0 && it.status==='Overdue').length;
}

/* ---------- Global search (top bar) ---------- */
function searchEverything(q){
  q = q.trim().toLowerCase();
  if(q.length < 2) return [];
  const out = [];
  Object.keys(state.months).sort().reverse().forEach(k=>{
    const m = state.months[k];
    ['necessities','extra','playjar'].forEach(sec=> (m[sec].expenses||[]).forEach(e=>{
      const text = `${e.description||''} ${e.mainCategory||''} ${e.subCategory||''}`.toLowerCase();
      if(text.includes(q)) out.push({type:'Expense', icon:catIconFor(sec, e.mainCategory, e.subCategory), tone:catTone(sec, e.mainCategory, e.subCategory), title:e.description || expenseLeafLabel(e), sub:`${expenseLeafLabel(e)} · ${fmtDateLong(e.date)}`, amount:-e.amount, go:{month:k, view:sec}});
    }));
    (m.income||[]).forEach(i=>{
      const text = `${i.description||'salary'} ${earnerName(i.person)}`.toLowerCase();
      if(text.includes(q)) out.push({type:'Income', icon:'banknote', tone:'save', title:i.description||'Salary', sub:`${earnerName(i.person)} · ${fmtDateLong(i.date)}`, amount:i.amount, go:{month:k, view:'income'}});
    });
  });
  state.recurringBills.forEach(r=>{ if(r.name.toLowerCase().includes(q)) out.push({type:'Bill', icon:'repeat', tone:'rose', title:r.name, sub:`Recurring · ${frequencyLabel(r)}`, amount:-r.expectedAmount, go:{view:'calendar'}}); });
  state.settings.savingsGoals.forEach(g=>{ if(g.name.toLowerCase().includes(q)) out.push({type:'Goal', icon:goalIconFor(g), tone:'save', title:g.name, sub:'Savings goal', amount:null, go:{view:'savings'}}); });
  state.debts.forEach(d=>{ if(`${d.lender} ${d.borrower||''}`.toLowerCase().includes(q)) out.push({type:'Debt', icon:'landmark', tone:'debt', title:d.lender, sub:`${DEBT_TYPE_LABEL[d.repaymentType]} · ${money(debtBalance(d))} left`, amount:null, go:{view:'debts', debt:d.id}}); });
  return out.slice(0, 8);
}
function renderSearchResults(input){
  const results = searchEverything(input.value);
  const box = document.getElementById('searchResults');
  if(!box) return;
  if(input.value.trim().length < 2){ box.hidden = true; box.innerHTML=''; return; }
  box.hidden = false;
  box.innerHTML = results.length ? results.map((r,i)=>`<button class="sr-item" data-sr="${i}">
      <span class="badge-ic sm t-${r.tone}">${icon(r.icon)}</span>
      <span class="sr-text"><b>${escapeHtml(r.title)}</b><small>${escapeHtml(r.type)} · ${escapeHtml(r.sub)}</small></span>
      ${r.amount!=null?`<span class="sr-amt ${r.amount<0?'':'pos'}">${money(Math.abs(r.amount))}</span>`:''}
    </button>`).join('') : `<div class="sr-empty">No matches for “${escapeHtml(input.value.trim())}”.</div>`;
  box._results = results;
}
function openSearchResult(r){
  if(!r) return;
  if(r.go.month){ cur.year = Number(r.go.month.slice(0,4)); cur.monthIndex = Number(r.go.month.slice(5,7))-1; }
  const input = document.getElementById('globalSearch'); if(input){ input.value=''; input.blur(); }
  const box = document.getElementById('searchResults'); if(box){ box.hidden = true; box.innerHTML=''; }
  if(r.go.debt){ curDebtDetailId = null; navTo('debts'); curDebtDetailId = r.go.debt; renderAll(); return; }
  navTo(r.go.view);
}
function expensesByCategoryTable(ctx){
  const secs = curDashCatFilter==='all' ? ['necessities','extra','playjar'] : [curDashCatFilter];
  let rows = [];
  secs.forEach(sec=>{
    categoryBudgetRows(ctx.m, sec, ctx.key).forEach(r=>{
      if(r.actual>0 || r.budget>0) rows.push({...r, sec});
    });
  });
  rows.sort((a,b)=> b.actual-a.actual || b.budget-a.budget);
  const shown = rows.slice(0,7);
  if(!shown.length) return `<div class="empty-note"><span class="badge-ic sm t-extra">${icon('receipt')}</span>No expenses or category budgets yet this month.</div>`;
  return `<table class="cat-table">
    <thead><tr><th>Category</th><th class="num">Actual</th><th class="num">Budget</th><th class="num">Remaining</th><th style="width:28px;"></th></tr></thead>
    <tbody>${shown.map(r=>`<tr data-action="goto" data-view="${r.sec}">
      <td><span class="cat-name"><span class="badge-ic sm t-${catTone(r.sec, r.main)}">${icon(catIconFor(r.sec, r.main))}</span><span>${escapeHtml(r.main)}${curDashCatFilter==='all'?` <small>(${sectionLabel(r.sec).replace(' Expenses','')})</small>`:''}</span></span></td>
      <td class="num">${money(r.actual)}</td>
      <td class="num">${r.budget>0?money(r.budget):'<span style="color:var(--text-3)">—</span>'}</td>
      <td class="num">${r.budget>0?`<span class="${r.remaining>=0?'pos':'neg'}">${money(r.remaining)}</span>`:'<span style="color:var(--text-3)">—</span>'}</td>
      <td style="color:var(--text-3);">${icon('chevron-right','ic-sm')}</td>
    </tr>`).join('')}</tbody>
  </table>
  ${rows.length>shown.length?`<div style="margin-top:10px;font-size:13px;color:var(--text-3);">+ ${rows.length-shown.length} more categories</div>`:''}`;
}
function monthComparisonTiles(calc, prev){
  if(!prev) return `<div class="empty-note"><span class="badge-ic sm t-accent">${icon('chart-column')}</span>Comparisons appear once you have a previous month recorded.</div>`;
  const tiles = [
    {label:'Income', cur:calc.totalIncome, prev:prev.totalIncome, upGood:true},
    {label:'Expenses', cur:calc.totalExpenses, prev:prev.totalExpenses, upGood:false},
    {label:'Debt Paid', cur:calc.debtPaymentsThisMonth, prev:prev.debtPaymentsThisMonth, upGood:false},
    {label:'Savings', cur:calc.savings.actualTotal, prev:prev.savingsActualTotal, upGood:true}
  ];
  return `<div class="cmp-grid">${tiles.map(t=>{
    const diff = t.cur - t.prev;
    if(Math.abs(diff)<0.005) return `<div class="cmp-tile flat"><div class="cmp-label">${t.label}</div><div class="cmp-big">${icon('minus')}0%</div><div class="cmp-sub">No change</div></div>`;
    const up = diff>0;
    const cls = up===t.upGood ? 'good' : 'bad';
    const pctTxt = t.prev>0 ? pct(Math.abs(diff/t.prev*100)) : 'New';
    return `<div class="cmp-tile ${cls}"><div class="cmp-label">${t.label}</div>
      <div class="cmp-big">${icon(up?'arrow-up':'arrow-down')}${pctTxt}</div>
      <div class="cmp-sub">${money(Math.abs(diff))} ${up?'more':'less'}</div></div>`;
  }).join('')}</div>`;
}
function sectionCashFlowCard(ctx){
  const calc = ctx.calc;
  function line(label, amount, isMinus){
    return `<div class="progress-meta" style="display:flex;justify-content:space-between;margin-bottom:9px;"><span>${isMinus?'− ':''}${label}</span><span style="color:var(--ink);font-weight:600;font-variant-numeric:tabular-nums;">${money(amount)}</span></div>`;
  }
  return `
    ${line('Income (+ borrowed funds)', calc.totalCashReceived)}
    ${line('Debt Payments', calc.debtPaymentsThisMonth, true)}
    <div style="display:flex;justify-content:space-between;padding:6px 0 12px;font-weight:600;font-size:14px;border-bottom:1px dashed var(--line);margin-bottom:12px;"><span>Budgetable Income</span><span>${money(calc.budgetableIncome)}</span></div>
    ${line('Necessities', calc.necessities.actual, true)}
    ${line('Extra Expenses', calc.extra.actual, true)}
    ${line('Play Jar', calc.playjar.actual, true)}
    ${line('Actual Savings', calc.savings.actualTotal, true)}
    <div class="divider"></div>
    <div class="stat-label">Available Cash</div>
    <div class="hero-num" style="color:${calc.netCashFlow>=0?'var(--sage-dark)':'var(--danger)'};">${money(calc.netCashFlow)}</div>
    <p class="help-text" style="margin-top:10px;">Every debt payment automatically adjusts your available ${allocationSplitLabel()} budget — there's no fixed debt amount to hit.</p>
  `;
}
function debtPrincipalProgress(){
  const totalPrincipal = sumBy(state.debts, d=>d.principal);
  const paidTowardPrincipal = sumBy(state.debts, d=>Math.min(debtTotalPaid(d), d.principal));
  return {totalPrincipal, paidTowardPrincipal, pct: totalPrincipal>0 ? paidTowardPrincipal/totalPrincipal*100 : 0};
}
function sectionDebtPaydown(ctx){
  const t = debtOverviewTotals();
  const startOfMonth = monthRange(ctx.key)[0];
  const startingBalance = allDebtsBalanceAsOf(addDaysISO(startOfMonth,-1));
  const debtReduction = startingBalance - t.totalOutstanding;
  const pp = debtPrincipalProgress();
  if(!state.debts.length) return `<p class="small-muted">No debts on file yet — add one from the Debt &amp; Loans page.</p>`;
  return `
    <div class="grid grid-2" style="margin-bottom:16px;">
      <div class="stat-card clay"><div class="stat-label">Outstanding Debt</div><div class="stat-value">${money(t.totalOutstanding)}</div></div>
      <div class="stat-card gold"><div class="stat-label">Paid This Month</div><div class="stat-value">${money(ctx.calc.debtPaymentsThisMonth)}</div></div>
      <div class="stat-card sage"><div class="stat-label">Total Paid</div><div class="stat-value">${money(t.totalPaid)}</div></div>
      <div class="stat-card ink"><div class="stat-label">Debt Reduction This Month</div><div class="stat-value">${money(Math.max(0,debtReduction))}</div></div>
    </div>
    ${pp.totalPrincipal>0?`<div class="progress-wrap">
      <div class="progress-top"><span>Debt-free progress (principal paid off)</span><span>${pct(pp.pct)}</span></div>
      <div class="progress-track"><div class="progress-fill ok" style="width:${Math.min(100,pp.pct)}%"></div></div>
      <div class="progress-meta">${money(pp.paidTowardPrincipal)} of ${money(pp.totalPrincipal)} original principal — interest isn't counted toward this</div>
    </div>`:''}
    <p class="help-text" style="margin-top:14px;">Every debt payment automatically adjusts your available budget — there's no required amount to hit.</p>
  `;
}
function sectionBudgetVsActual(ctx){
  const calc = ctx.calc;
  const buckets = [
    {label:'Necessities', actual:calc.necessities.actual, budget:calc.necessities.budget},
    {label:'Savings', actual:calc.savings.actualTotal, budget:calc.savings.budgetTotal},
    {label:'Extra Expenses', actual:calc.extra.actual, budget:calc.extra.budget},
    {label:'Play Jar', actual:calc.playjar.actual, budget:calc.playjar.budget}
  ];
  return `<table style="margin-bottom:14px;">
    <thead><tr><th>Bucket</th><th class="num">Budget</th><th class="num">Actual</th><th class="num">Remaining</th></tr></thead>
    <tbody>${buckets.map(b=>`<tr><td>${b.label}</td><td class="num">${money(b.budget)}</td><td class="num">${money(b.actual)}</td><td class="num">${money(b.budget-b.actual)}</td></tr>`).join('')}</tbody>
  </table>
  ${buckets.map(b=>progressBar(b.label, b.actual, b.budget)).join('')}`;
}
function sectionDailyAllowance(ctx){
  return `
    <div class="hero-num">${money(ctx.dailyAllowance)}<span style="font-size:16px;color:var(--ink-faint);font-weight:500;">/day</span></div>
    <p class="progress-meta" style="margin-top:8px;">${ctx.allowanceNote}</p>
    <div class="grid grid-2" style="margin-top:12px;">
      <div><div class="stat-label">Days left</div><div class="stat-value" style="font-size:19px;">${ctx.daysLeft}</div></div>
      <div><div class="stat-label">Remaining discretionary</div><div class="stat-value" style="font-size:19px;">${money(ctx.discretionary)}</div></div>
    </div>
  `;
}
function computeUpcomingItems(key){
  const m = getMonth(key,true);
  const items = [];
  const windowEnd = addDaysISO(toISO(today), 30);
  // Each earner's expected paydays
  earners().forEach(e=>{
    paydaysInRange(e, toISO(today), windowEnd).forEach(iso=>{
      const received = findIncomeOn(e.id, iso);
      items.push({date:iso, kind:'payday', label:`${e.name} payday`, amount:received?received.amount:expectedPayAmount(e), status:received?'Received':'Expected'});
    });
  });
  // Recurring income
  recurringIncomeList().filter(r=>r.active).forEach(rec=>{
    recurringOccurrences(rec, toISO(today), windowEnd).forEach(iso=>{
      const st = recurringIncomeStatus(rec, iso);
      items.push({date:iso, kind:'income', label:rec.name, amount: st.actual!=null?st.actual:rec.amount, status: st.status==='Received'?'Received':'Expected', recId:rec.id, person:rec.person});
    });
  });
  // Recurring expenses — include unpaid overdue ones plus upcoming ones
  state.recurringBills.filter(r=>r.active).forEach(rec=>{
    const rangeStart = addDaysISO(toISO(today), -60);
    recurringOccurrences(rec, rangeStart, windowEnd).forEach(occISO=>{
      const st = recurringOccurrenceStatus(rec, occISO);
      if(st.status==='Paid') return;
      items.push({date:occISO, kind:'bill', category:rec.mainCategory, label:rec.name, amount:rec.expectedAmount, status: st.status});
    });
  });
  // Installment payments
  state.debts.filter(d=>d.repaymentType==='installment').forEach(d=>{
    const next = debtInstallmentSchedule(d).find(s=>s.status==='Upcoming'||s.status==='Overdue'||s.status==='Partial');
    if(next && next.dueDate<=windowEnd) items.push({date:next.dueDate, kind:'installment', label:`${d.lender} #${next.index}`, amount:next.remaining, status: next.status==='Overdue'?'Overdue':'Expected'});
  });
  // Standard loan due dates
  state.debts.filter(d=>d.repaymentType==='standard' && d.dueDate && debtBalance(d)>0).forEach(d=>{
    if(d.dueDate<=windowEnd) items.push({date:d.dueDate, kind:'loan', label:`${d.lender} loan due`, amount:debtBalance(d), status: d.dueDate<toISO(today)?'Overdue':'Expected'});
  });
  items.sort((a,b)=>a.date.localeCompare(b.date));
  return items;
}
function sectionUpcoming(ctx){
  const items = computeUpcomingItems(ctx.key).slice(0,8);
  if(!items.length) return `<p class="small-muted">Nothing upcoming in the next 30 days.</p>`;
  return `<table>
    <thead><tr><th>When</th><th>Item</th><th class="num">Amount</th><th></th></tr></thead>
    <tbody>${items.map(it=>`<tr><td>${relativeDayLabel(it.date)}<div class="small-muted">${fmtDateHuman(it.date)}</div></td><td>${escapeHtml(it.label)}</td><td class="num">${it.amount!==null?money(it.amount):'—'}</td><td><span class="pill ${it.status==='Received'?'sage':it.status==='Overdue'?'danger':'gold'}">${it.status}</span></td></tr>`).join('')}</tbody>
  </table>`;
}
function sectionSpendingBreakdown(ctx){
  const m = ctx.m;
  const expenseBlocks = ['necessities','extra','playjar'].map(sec=>{
    const rows = categoryBudgetRows(m, sec, ctx.key).filter(r=>r.actual>0);
    if(!rows.length) return '';
    return `<details style="margin-bottom:10px;">
      <summary style="cursor:pointer;font-weight:600;font-size:13.5px;">${sectionLabel(sec)} — ${money(sumBy(rows,r=>r.actual))}</summary>
      <div style="margin:8px 0 0 14px;">
        ${rows.map(r=>{
          if(r.subs){
            const subs = r.subs.filter(s=>s.actual>0);
            return `<details style="margin-bottom:6px;"><summary style="cursor:pointer;font-size:13px;color:var(--ink-soft);">${escapeHtml(r.main)} — ${money(r.actual)}</summary>
              <div style="margin:6px 0 0 16px;">${subs.map(s=>`<div class="progress-meta" style="display:flex;justify-content:space-between;margin-bottom:4px;"><span>${escapeHtml(s.name)}</span><span>${money(s.actual)}</span></div>`).join('')}</div>
            </details>`;
          }
          return `<div class="progress-meta" style="display:flex;justify-content:space-between;margin-bottom:4px;"><span>${escapeHtml(r.main)}</span><span>${money(r.actual)}</span></div>`;
        }).join('')}
      </div>
    </details>`;
  }).join('');
  const [mStart, mEnd] = monthRange(ctx.key);
  const debtRows = state.debts.map(d=>({d, paid: sumBy(d.payments.filter(p=>p.date>=mStart&&p.date<=mEnd), p=>p.amount)})).filter(x=>x.paid>0);
  const debtBlock = debtRows.length ? `<details style="margin-bottom:10px;">
      <summary style="cursor:pointer;font-weight:600;font-size:13.5px;">Debt Payments — ${money(sumBy(debtRows,x=>x.paid))}</summary>
      <div style="margin:8px 0 0 14px;">
        ${debtRows.map(x=>`<div class="progress-meta" style="display:flex;justify-content:space-between;margin-bottom:4px;"><span>${escapeHtml(x.d.lender)} (${escapeHtml(x.d.borrower)})</span><span>${money(x.paid)}</span></div>`).join('')}
      </div>
    </details>` : '';
  return (expenseBlocks + debtBlock) || `<p class="small-muted">No expenses recorded yet.</p>`;
}
function sectionWhereMoneyWent(ctx){
  const m = ctx.m;
  const allExp = allExpensesForMonth(m);
  const [mStart, mEnd] = monthRange(ctx.key);
  let largestDebtPayment = null;
  state.debts.forEach(d=> d.payments.forEach(p=>{
    if(p.date>=mStart && p.date<=mEnd && (!largestDebtPayment || p.amount>largestDebtPayment.amount)) largestDebtPayment = {...p, lender:d.lender};
  }));
  if(!allExp.length && !largestDebtPayment) return `<p class="small-muted">No expenses recorded yet.</p>`;
  const mainTotals = mainCategoryTotals(ctx.key);
  const subTotals = allExp.length ? topCategories(ctx.key, 1) : null;
  const totalSpend = sumBy(allExp, e=>e.amount);
  const largest = allExp.length ? [...allExp].sort((a,b)=>b.amount-a.amount)[0] : null;
  const topMain = mainTotals[0];
  const topMainPct = (topMain && totalSpend>0) ? (topMain[1]/totalSpend*100) : 0;
  return `
    ${mainTotals.slice(0,5).map(t=>`<div class="progress-meta" style="display:flex;justify-content:space-between;margin-bottom:6px;"><span>${escapeHtml(t[0])}</span><span>${money(t[1])}</span></div>`).join('')}
    <div class="divider"></div>
    ${topMain?`<div class="progress-meta">Largest spending category: <strong style="color:var(--ink);">${escapeHtml(topMain[0])}</strong> (${pct(topMainPct)} of spending)</div>`:''}
    ${subTotals?`<div class="progress-meta">Largest subcategory: <strong style="color:var(--ink);">${escapeHtml(subTotals[0][0])}</strong> — ${money(subTotals[0][1])}</div>`:''}
    ${largestDebtPayment?`<div class="progress-meta">Largest debt payment: <strong style="color:var(--ink);">${escapeHtml(largestDebtPayment.lender)}</strong> — ${money(largestDebtPayment.amount)}</div>`:''}
    ${largest?`<div class="progress-meta">Largest single transaction: <strong style="color:var(--ink);">${escapeHtml(largest.description||largest.mainCategory)}</strong> — ${money(largest.amount)}</div>`:''}
    <div class="progress-meta">${allExp.length} expense${allExp.length===1?'':'s'} recorded this month</div>
  `;
}
function sectionMonthComparison(ctx){ return renderComparison(ctx.key, ctx.calc); }
function sectionMonthProgress(ctx){
  const days = ctx.days;
  const dayOfMonth = ctx.isPastMonth ? days : (ctx.isCurrentRealMonth ? today.getDate() : (ctx.days-ctx.daysLeft+1));
  const pctMonth = Math.min(100, dayOfMonth/days*100);
  const calc = ctx.calc;
  const budgetTotal = calc.necessities.budget+calc.extra.budget+calc.playjar.budget;
  const actualTotal = calc.necessities.actual+calc.extra.actual+calc.playjar.actual;
  const pctBudgetSpent = budgetTotal>0 ? Math.min(999,actualTotal/budgetTotal*100) : 0;
  const pctSavingsAchieved = calc.savings.budgetTotal>0 ? Math.min(999,calc.savings.actualTotal/calc.savings.budgetTotal*100) : 0;
  const discBudget = calc.extra.budget+calc.playjar.budget;
  const discActual = calc.extra.actual+calc.playjar.actual;
  const pctDiscUsed = discBudget>0 ? Math.min(999,discActual/discBudget*100) : 0;
  return `
    <div class="progress-top" style="margin-bottom:6px;"><span>Day ${dayOfMonth} of ${days}</span><span>${pct(pctMonth)} of month elapsed</span></div>
    <div class="progress-track" style="margin-bottom:14px;"><div class="progress-fill ok" style="width:${pctMonth}%"></div></div>
    <div class="grid grid-3">
      <div><div class="stat-label">Budget spent</div><div class="stat-value" style="font-size:18px;">${pct(pctBudgetSpent)}</div></div>
      <div><div class="stat-label">Savings target achieved</div><div class="stat-value" style="font-size:18px;">${pct(pctSavingsAchieved)}</div></div>
      <div><div class="stat-label">Discretionary used</div><div class="stat-value" style="font-size:18px;">${pct(pctDiscUsed)}</div></div>
    </div>
  `;
}
function sectionHealthSnapshot(ctx){
  const calc = ctx.calc, health = ctx.health;
  const t = debtOverviewTotals();
  const debtProgress = (t.totalOutstanding+t.totalPaid)>0 ? t.totalPaid/(t.totalOutstanding+t.totalPaid)*100 : null;
  return `
    <div class="hero-num">${health.score}<span style="font-size:18px;color:var(--ink-faint);font-weight:500;"> / 100</span></div>
    <p style="color:var(--ink-soft);font-size:13.5px;margin:8px 0 14px;line-height:1.6;">${health.note}</p>
    <div class="divider"></div>
    <div class="progress-meta">Savings rate: <strong style="color:var(--ink);">${pct(calc.savingsRate)}</strong></div>
    <div class="progress-meta">Expense-to-income ratio: <strong style="color:var(--ink);">${calc.totalIncome>0?pct(calc.totalExpenses/calc.totalIncome*100):'—'}</strong></div>
    <div class="progress-meta">Available cash: <strong style="color:var(--ink);">${money(calc.netCashFlow)}</strong></div>
    ${debtProgress!==null?`<div class="progress-meta">Debt paydown progress: <strong style="color:var(--ink);">${pct(debtProgress)}</strong></div>`:''}
  `;
}
function sectionNotes(ctx){
  return `<textarea id="monthNotes" placeholder="Anything worth remembering about this month?">${escapeHtml(ctx.m.notes)}</textarea>
    <div class="btn-row" style="margin-top:10px;"><button class="btn btn-primary btn-sm" data-action="save-notes">Save note</button></div>`;
}
function sectionLabel(sec){ return sec==='necessities'?'Necessities':sec==='extra'?'Extra Expenses':'Play Jar'; }
function progressBar(label, actual, budget){
  const p = budget>0 ? (actual/budget*100) : (actual>0?100:0);
  const cls = p<=85?'ok':(p<=100?'warn':'over');
  const status = p<=85?'On track':(p<=100?'Near limit':'Over budget');
  return `<div class="progress-wrap">
    <div class="progress-top"><span>${label}</span><span>${pct(Math.min(p,999),0)}</span></div>
    <div class="progress-track"><div class="progress-fill ${cls}" style="width:${Math.min(p,100)}%"></div></div>
    <div class="progress-meta">${status} · ${money(actual)} of ${money(budget)}</div>
  </div>`;
}
function renderComparison(key, calc){
  if(!calc.hasPrev) return `<p class="small-muted">Not enough data to compare yet.</p>`;
  const prevCalc = computeMonthShallowFull(calc.prevKey);
  function line(label, cur, prev, invertGood, isPct){
    const diff = cur-prev;
    if(Math.abs(diff) < 0.005) return `<div class="progress-meta" style="margin-bottom:8px;">${label}: no change from last month</div>`;
    const up = diff>0;
    const good = invertGood ? !up : up;
    const arrow = up ? icon('arrow-up','ic-sm') : icon('arrow-down','ic-sm');
    const pctChange = prev!==0 ? Math.abs(diff/prev*100) : null;
    const amt = isPct ? pct(Math.abs(diff)) : money(Math.abs(diff));
    return `<div style="margin-bottom:10px;font-size:13.5px;"><span class="pill ${good?'sage':'danger'}">${arrow} ${amt}</span>
      <span style="color:var(--ink-soft);margin-left:8px;">${label} ${up?'increased':'decreased'}${pctChange!==null?` (${pct(pctChange)})`:''}</span></div>`;
  }
  return line('Income', calc.totalIncome, prevCalc.totalIncome, false)
    + line('Debt payments', calc.debtPaymentsThisMonth, prevCalc.debtPaymentsThisMonth, true)
    + line('Budgetable income', calc.budgetableIncome, prevCalc.budgetableIncome, false)
    + line('Necessities', calc.necessities.actual, prevCalc.necActual, true)
    + line('Extra Expenses', calc.extra.actual, prevCalc.extActual, true)
    + line('Play Jar', calc.playjar.actual, prevCalc.playActual, true)
    + line('Savings', calc.savings.actualTotal, prevCalc.savingsActualTotal, false)
    + line('Total cash outflow', totalCashOutflow(calc), prevCalc.totalCashOutflow, true)
    + line('Available cash', calc.netCashFlow, prevCalc.netCashFlow, false);
}
function computeMonthShallowFull(key){
  const m = getMonth(key,true);
  const s = state.settings;
  const totalIncome = sumBy(m.income, i=>i.amount);
  const necActual = sumBy(m.necessities.expenses, e=>e.amount);
  const extActual = sumBy(m.extra.expenses, e=>e.amount);
  const playActual = sumBy(m.playjar.expenses, e=>e.amount);
  const totalExpenses = necActual+extActual+playActual;
  const savingsActualTotal = sumBy(Object.values(m.savingsActuals), v=>v);
  const [mStart, mEnd] = monthRange(key);
  const debtPaymentsThisMonth = debtPaymentsInRange(mStart, mEnd);
  const borrowedFundsThisMonth = borrowedFundsInRange(mStart, mEnd);
  const netCashFlow = (totalIncome+borrowedFundsThisMonth) - totalExpenses - savingsActualTotal - debtPaymentsThisMonth;
  const savingsRate = totalIncome>0 ? savingsActualTotal/totalIncome*100 : 0;
  return {totalIncome, totalExpenses, necActual, extActual, playActual, savingsActualTotal, netCashFlow, savingsRate, debtPaymentsThisMonth, borrowedFundsThisMonth,
    budgetableIncome: totalIncome-debtPaymentsThisMonth,
    totalCashOutflow: totalExpenses+savingsActualTotal+debtPaymentsThisMonth};
}

/* =========================================================
   SHARED PAGE HELPERS
========================================================= */
function pageHead(title, sub, actions){
  return `<div class="page-head"><div><h1 class="page-title">${title}</h1>${sub?`<div class="page-sub">${sub}</div>`:''}</div>${actions?`<div class="btn-row">${actions}</div>`:''}</div>`;
}
const PERSON_TONES = ['save','play','extra','nec','rose','debt'];
function findEarner(idOrName){ return earnerById(idOrName) || earners().find(e=>e.name===idOrName) || null; }
function personTone(idOrName){
  const e = findEarner(idOrName);
  const i = e ? earners().indexOf(e) : 0;
  return PERSON_TONES[i % PERSON_TONES.length];
}
function personChip(idOrName){
  const e = findEarner(idOrName);
  const name = e ? e.name : String(idOrName||'—');
  return `<span class="person-chip"><span class="badge-ic xs t-${personTone(idOrName)}">${icon('user')}</span>${escapeHtml(name)}</span>`;
}
function kebab(kind, attrs){
  const data = Object.entries(attrs||{}).map(([k,v])=>`data-${k}="${escapeHtml(v==null?'':v)}"`).join(' ');
  return `<button class="icon-btn kebab" data-action="row-menu" data-kind="${kind}" ${data} aria-label="More actions" title="More actions">${icon('ellipsis-vertical')}</button>`;
}
function fmtDateLong(iso){
  if(!iso) return '';
  const [y,m,d] = iso.split('-').map(Number);
  return new Date(y,m-1,d).toLocaleDateString('en-US',{month:'short', day:'numeric', year:'numeric'});
}
function barHtml(ratio, tone, small){
  return `<span class="bar-track ${small?'sm':''}"><span class="bar-fill bf-${tone} ${ratio>1.0001?'over':''}" style="display:block;width:${Math.max(0,Math.min(100,ratio*100)).toFixed(1)}%"></span></span>`;
}
function emptyNote(ic, tone, text){
  return `<div class="empty-note"><span class="badge-ic sm t-${tone}">${icon(ic)}</span><span>${text}</span></div>`;
}
function pillTabs(kind, tabs, active){
  return `<div class="pill-tabs" role="tablist">${tabs.map(t=>`<button role="tab" aria-selected="${t.id===active}" class="${t.id===active?'active':''}" data-action="set-tab" data-tab-kind="${kind}" data-tab="${t.id}">${t.icon?icon(t.icon,'ic-sm'):''}${t.label}</button>`).join('')}</div>`;
}
function findCatNode(sec, main, sub){
  const m = (getCategoryTree(sec)||[]).find(c=>c.name===main);
  if(!m) return null;
  return sub ? (m.subs.find(s=>s.name===sub) || null) : m;
}
/* Icon for a category: the one the user picked, else a best guess from its name. */
function catIconFor(sec, main, sub){
  const n = findCatNode(sec, main, sub);
  if(n && n.icon) return n.icon;
  if(sub){
    const guess = categoryIcon(sub);
    if(guess!=='tag') return guess;
    const mn = findCatNode(sec, main, null);
    if(mn && mn.icon) return mn.icon;
  }
  return categoryIcon(sub || main);
}
/* Pastel badge colour for an icon, following the design guide (sage home, peach food and shopping,
   blue transport and income, blush bills and personal care, lavender fun and health, yellow travel). */
const ICON_TONE_RULES = [
  [/^(house|building|building-2|key-round|sofa|bed-double|bath|lamp|armchair|wrench|hammer|paint-roller|piggy-bank|sprout|leaf|flower|flower-2|shield|shield-check|umbrella|vault|target)$/,'nec'],
  [/^(receipt|file-text|zap|plug|lightbulb|droplet|flame|wifi|smartphone|tv|router|repeat|sparkles|sparkle|scissors|spray-can|brush|smile|eye|glasses|footprints|trash-2)$/,'rose'],
  [/^(shopping-cart|shopping-basket|store|shopping-bag|coffee|cup-soda|wine|beer|milk|pizza|sandwich|soup|salad|beef|fish|egg|apple|carrot|croissant|cookie|cake|ice-cream-cone|popcorn|candy|utensils|utensils-crossed|shirt|watch|package|box|paw-print|dog|cat|bird)$/,'extra'],
  [/^(car|car-front|car-taxi-front|bus|train-front|tram-front|bike|motorbike|fuel|ship|map-pin|navigation|parking-meter|banknote|coins|receipt-text|calculator|percent|trending-up|chart-line|chart-pie|briefcase|laptop|baby|graduation-cap|school|backpack|book-open|pencil|users|user|cloud|moon)$/,'save'],
  [/^(heart|heart-handshake|hand-heart|party-popper|gift|clapperboard|film|music|headphones|gamepad-2|dices|puzzle|palette|camera|ticket|drama|guitar|mic|trophy|stethoscope|pill|syringe|hospital|heart-pulse|activity|dumbbell|church|gem|crown|star|tags|tag|bookmark)$/,'play'],
  [/^(plane|tickets-plane|sailboat|tent|mountain|tree-palm|sun|flag|bell|circle-dot|shapes)$/,'yellow'],
  [/^(credit-card|landmark|hand-coins|badge-percent|wallet)$/,'debt']
];
function iconTone(name, fallback){
  for(const [re, t] of ICON_TONE_RULES) if(re.test(name||'')) return t;
  return fallback || 'nec';
}
function catTone(sec, main, sub){ return iconTone(catIconFor(sec, main, sub), SECTION_TONE[sec] || 'nec'); }
function goalIconFor(g){ return (g && g.icon) || goalIcon(g ? g.name : ''); }
function totalSavedAllTime(goalId){
  return sumBy(Object.values(state.months), m=> Number((m.savingsActuals||{})[goalId]||0));
}

/* =========================================================
   VIEW: INCOME
========================================================= */
function viewIncome(key){
  const m = getMonth(key,true);
  const calc = computeMonth(key);
  const prev = calc.hasPrev ? computeMonthShallowFull(calc.prevKey) : null;
  const rows = [...m.income].sort((a,b)=> b.date.localeCompare(a.date));
  return `
    ${pageHead('Income', `${MONTH_NAMES[cur.monthIndex]} ${cur.year}`, `<button class="btn btn-primary" data-action="add-income">${icon('plus','ic-sm')}Add Income</button>`)}
    <div class="kpi-row">
      ${kpiCard('Total Income', 'receipt', 'save', calc.totalIncome, deltaInfo(calc.totalIncome, prev && prev.totalIncome, true))}
      ${earners().map(e=>kpiCard(`${e.name} Income`, 'user', personTone(e.id), calc.incomeByPerson[e.id]||0, null)).join('')}
    </div>
    <div class="page-2col" style="margin-bottom:18px;">
      ${expectedIncomeCard(key)}
      ${recurringIncomeCard()}
    </div>
    <div class="card">
      <div class="card-head"><h3 class="card-title">Income Entries</h3><span class="card-chip">${rows.length} entr${rows.length===1?'y':'ies'}</span></div>
      ${rows.length ? `<div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>Date</th><th>Source</th><th>Person</th><th class="num">Amount</th><th style="width:40px;"></th></tr></thead>
        <tbody>${rows.map(r=>`<tr>
          <td class="nowrap">${fmtDateLong(r.date)}</td>
          <td>${escapeHtml(r.description||'Salary')}</td>
          <td>${personChip(r.person)}</td>
          <td class="num"><b>${money(r.amount)}</b></td>
          <td>${kebab('income',{id:r.id})}</td>
        </tr>`).join('')}</tbody>
      </table></div>` : doodleNote('books', 'A fresh page', 'No income recorded for this month yet. Use “Add Income” to log a paycheck.')}
    </div>
  `;
}

/* =========================================================
   VIEW: EXPENSES (Necessities / Extra / Play jar)
========================================================= */
let curExpenseCatFilter = 'all';
let curExpenseSearch = '';
/* Necessities & Extra Expenses pages: donut of this month's spending split by main category. */
const DONUT_SECTIONS = ['necessities', 'extra'];
const CAT_COLORS = ['#627F5F','#E8C9A8','#E79B8B','#8FB7D9','#D9A657','#A7C4A0','#C9A27E','#B7A1C9','#6E7B8B','#F1C7A8'];
function sectionSlices(catRows){
  return catRows.filter(c=>c.actual>0).sort((a,b)=>b.actual-a.actual).map((c,i)=>({label:c.main, amount:c.actual, color:CAT_COLORS[i % CAT_COLORS.length]}));
}
function sectionDonut(catRows, calc){
  const slices = sectionSlices(catRows);
  const total = sumBy(slices, x=>x.amount);
  if(!total) return doodleNote('teacup', 'Nothing spent yet', 'Your spending split will show here once you log expenses.');
  return `<div class="bd-wrap">
    <div class="donut-wrap"><canvas id="secDonut" aria-label="Spending by category this month"></canvas>
      <div class="donut-center"><b>${money(Math.round(total))}</b><span>spent</span></div></div>
    <div class="bd-legend">${slices.map(x=>`<button class="bd-item" data-action="filter-exp-cat" data-main="${escapeHtml(x.label)}" title="Show only ${escapeHtml(x.label)} entries">
      <span class="dot" style="background:${x.color}"></span>
      <span class="bd-name">${escapeHtml(x.label)}</span>
      <span class="bd-amt">${money(Math.round(x.amount))}</span>
      <span class="bd-pct">${pct(x.amount/total*100)}</span>
    </button>`).join('')}
    ${calc.budget>0 ? `<div class="bd-foot">${money(Math.round(total))} spent of ${money(Math.round(calc.budget))} budget</div>` : ''}</div>
  </div>`;
}
function drawSectionDonut(key, sec){
  destroyChart('secDonut');
  const el = document.getElementById('secDonut');
  if(!el) return;
  const slices = sectionSlices(categoryBudgetRows(getMonth(key,true), sec, key));
  chartRegistry['secDonut'] = new Chart(el, {
    type:'doughnut',
    data:{ labels:slices.map(x=>x.label), datasets:[{data:slices.map(x=>x.amount), backgroundColor:slices.map(x=>x.color), borderWidth:2, borderColor:cssVar('--surface')}] },
    options:{ responsive:true, maintainAspectRatio:false, cutout:'60%',
      plugins:{ legend:{display:false}, tooltip:{ callbacks:{ label:(item)=>{
        const t = item.dataset.data.reduce((a,b)=>a+b,0);
        return ` ${item.label}: ${money(item.parsed)} (${t>0?pct(item.parsed/t*100):'0%'})`;
      }}}}
    },
    plugins:[donutLabelsPlugin]
  });
}
function viewSection(key, sec){
  const m = getMonth(key,true);
  const calc = computeMonth(key)[sec];
  const tone = SECTION_TONE[sec];
  const catRows = categoryBudgetRows(m, sec, key);
  const plannedTotal = sumBy(catRows, c=>c.budget);
  const ratio = calc.budget>0 ? calc.actual/calc.budget : (calc.actual>0?1:0);
  if(curExpenseCatFilter!=='all' && !catRows.some(c=>c.main===curExpenseCatFilter)) curExpenseCatFilter = 'all';
  let entries = [...m[sec].expenses].sort((a,b)=> b.date.localeCompare(a.date));
  if(curExpenseCatFilter!=='all') entries = entries.filter(e=>e.mainCategory===curExpenseCatFilter);
  const q = curExpenseSearch.trim().toLowerCase();
  if(q) entries = entries.filter(e=> (e.description||'').toLowerCase().includes(q) || expenseLeafLabel(e).toLowerCase().includes(q));

  return `
    ${pageHead('Expenses', `${MONTH_NAMES[cur.monthIndex]} ${cur.year}`,
      `<button class="btn" data-action="manage-categories" data-section="${sec}">${icon('tags','ic-sm')}Manage Categories</button>
       <button class="btn btn-peach" data-action="add-expense" data-section="${sec}">${icon('plus','ic-sm')}Add Expense</button>`)}
    <div class="section-tabs" role="tablist">${EXPENSE_SECTIONS.map(x=>`<button role="tab" aria-selected="${x===sec}" class="${x===sec?'active':''}" data-action="goto" data-view="${x}"><span class="badge-ic t-${SECTION_TONE[x]}">${icon(BUCKETS[x].icon)}</span>${sectionLabel(x)}</button>`).join('')}</div>

    <div class="card sec-summary">
      <span class="badge-ic lg t-${tone}">${icon(BUCKETS[sec].icon)}</span>
      <div class="sec-summary-main">
        <div class="sec-summary-top">
          <span class="kpi-label">${sectionLabel(sec)} budget</span>
          <span class="br-amt"><b ${ratio>1.0001?'style="color:var(--danger-ink)"':''}>${money(calc.actual)}</b> <span>/ ${money(calc.budget)}</span></span>
        </div>
        ${barHtml(ratio, tone)}
        <div class="sec-summary-meta">${pct(state.settings.allocations[sec]||0)} of budgetable income${calc.rolloverIn>0?` · includes ${money(calc.rolloverIn)} rolled over`:''}</div>
      </div>
      <div class="sec-summary-stats">
        <div><span>Remaining</span><b class="${calc.remaining>=0?'pos':'neg'}">${money(calc.remaining)}</b></div>
        <div><span>Used</span><b>${pct(ratio*100)}</b></div>
      </div>
    </div>

    <div class="page-2col ${DONUT_SECTIONS.includes(sec)?'page-3col':''}">
      ${DONUT_SECTIONS.includes(sec) ? `<div class="card sec-donut-card">
        <div class="card-head"><h3 class="card-title">Spending by Category</h3><span class="card-chip">${MONTH_NAMES[cur.monthIndex].slice(0,3)} ${cur.year}</span></div>
        ${sectionDonut(catRows, calc)}
      </div>` : ''}
      <div class="card">
        <div class="card-head"><h3 class="card-title">Expenses by Category</h3><span class="card-chip">Planned ${money(plannedTotal)}</span></div>
        ${catRows.length ? `<div class="cb-list">${catRows.map(c=>catBudgetRow(c, sec)).join('')}</div>` : emptyNote('tags', tone, 'No categories yet — add some with “Manage Categories”.')}
        <p class="help-text" style="margin-top:14px;">Budgets are planning targets — only logged expenses count as actual. Click the pencil to change this month’s budget for a category.</p>
      </div>
      <div class="card">
        <div class="card-head" style="flex-wrap:wrap;">
          <h3 class="card-title">Expense Entries</h3>
          <div class="filter-row">
            <select class="card-chip" id="expCatFilter" aria-label="Filter by category">
              <option value="all">All Categories</option>
              ${catRows.map(c=>`<option value="${escapeHtml(c.main)}" ${curExpenseCatFilter===c.main?'selected':''}>${escapeHtml(c.main)}</option>`).join('')}
            </select>
            <div class="search-field">${icon('search','ic-sm')}<input type="search" id="expSearch" placeholder="Search" value="${escapeHtml(curExpenseSearch)}" aria-label="Search expenses"></div>
          </div>
        </div>
        ${entries.length ? `<div class="tbl-wrap"><table class="tbl">
          <thead><tr><th>Date</th><th>Category</th><th>Description</th><th class="num">Amount</th><th style="width:40px;"></th></tr></thead>
          <tbody>${entries.map(e=>`<tr>
            <td class="nowrap">${fmtDateHuman(e.date)}</td>
            <td><span class="cat-name"><span class="badge-ic xs t-${catTone(sec, e.mainCategory, e.subCategory)}">${icon(catIconFor(sec, e.mainCategory, e.subCategory))}</span><span>${escapeHtml(expenseLeafLabel(e))}</span></span></td>
            <td class="muted-cell">${escapeHtml(e.description||'')}${e.recurringId?` <span title="Recurring bill" style="color:var(--text-3);">${icon('repeat','ic-xs')}</span>`:''}</td>
            <td class="num"><b>${money(e.amount)}</b></td>
            <td>${kebab('expense',{id:e.id, section:sec})}</td>
          </tr>`).join('')}</tbody>
        </table></div>` : ((q||curExpenseCatFilter!=='all') ? emptyNote('receipt', tone, 'No expenses match this filter.') : doodleNote('teacup', 'Nothing spent yet', 'No expenses logged here this month.'))}
      </div>
    </div>
  `;
}
function catBudgetRow(c, sec){
  const tone = SECTION_TONE[sec];
  const pills = `${c.isCustomThisMonth?'<span class="pill gold">custom</span>':''}${c.inactive?'<span class="pill danger">hidden</span>':''}`;
  const ratio = c.budget>0 ? c.actual/c.budget : (c.actual>0?1:0);
  if(c.subs){
    const collapseKey = `${sec}|${c.main}`;
    const collapsed = !curExpandedCats[collapseKey];
    return `<div class="cb-group">
      <div class="cb-row">
        <span class="badge-ic sm t-${catTone(sec, c.main)}">${icon(catIconFor(sec, c.main))}</span>
        <div class="cb-main">
          <div class="cb-top"><span class="cb-name">${escapeHtml(c.main)}${pills}</span><span class="br-amt"><b>${money(c.actual)}</b> <span>/ ${money(c.budget)}</span></span></div>
          ${barHtml(ratio, tone, true)}
        </div>
        <span class="cb-pct">${c.budget>0?pct(ratio*100):'—'}</span>
        <button class="icon-btn" data-action="toggle-category-collapse" data-section="${sec}" data-main="${escapeHtml(c.main)}" aria-label="${collapsed?'Show':'Hide'} subcategories" style="transform:rotate(${collapsed?'-90deg':'0deg'});transition:transform .15s;">${icon('chevron-down')}</button>
      </div>
      ${collapsed ? '' : `<div class="cb-subs">${c.subs.map(s=>{
        const r = s.budget>0 ? s.actual/s.budget : (s.actual>0?1:0);
        return `<div class="cb-row sub">
          <span class="badge-ic xs t-${catTone(sec, c.main, s.name)}">${icon(catIconFor(sec, c.main, s.name))}</span>
          <div class="cb-main">
            <div class="cb-top"><span class="cb-name">${escapeHtml(s.name)}${s.isCustomThisMonth?'<span class="pill gold">custom</span>':''}${s.inactive?'<span class="pill danger">hidden</span>':''}</span><span class="br-amt"><b>${money(s.actual)}</b> <span>/ ${money(s.budget)}</span></span></div>
            ${barHtml(r, tone, true)}
          </div>
          <span class="cb-pct">${s.budget>0?pct(r*100):'—'}</span>
          <button class="icon-btn" data-action="edit-this-month-budget" data-section="${sec}" data-main="${escapeHtml(c.main)}" data-sub="${escapeHtml(s.name)}" title="Edit this month's budget">${icon('pencil')}</button>
        </div>`;
      }).join('')}</div>`}
    </div>`;
  }
  return `<div class="cb-row">
    <span class="badge-ic sm t-${catTone(sec, c.main)}">${icon(catIconFor(sec, c.main))}</span>
    <div class="cb-main">
      <div class="cb-top"><span class="cb-name">${escapeHtml(c.main)}${pills}</span><span class="br-amt"><b ${ratio>1.0001?'style="color:var(--danger-ink)"':''}>${money(c.actual)}</b> <span>/ ${money(c.budget)}</span></span></div>
      ${barHtml(ratio, tone, true)}
    </div>
    <span class="cb-pct">${c.budget>0?pct(ratio*100):'—'}</span>
    <button class="icon-btn" data-action="edit-this-month-budget" data-section="${sec}" data-main="${escapeHtml(c.main)}" data-sub="" title="Edit this month's budget">${icon('pencil')}</button>
  </div>`;
}

/* =========================================================
   VIEW: SAVINGS
========================================================= */
function viewSavings(key){
  const all = computeMonth(key);
  const calc = all.savings;
  const ratio = calc.budgetTotal>0 ? calc.actualTotal/calc.budgetTotal : 0;
  const rateOfIncome = all.totalIncome>0 ? calc.actualTotal/all.totalIncome*100 : 0;
  const deactivatedCount = calc.goals.filter(g=>!g.active).length;
  const visibleGoals = curShowDeactivatedGoals ? calc.goals : calc.goals.filter(g=>g.active);
  return `
    ${pageHead('Savings Overview', `${MONTH_NAMES[cur.monthIndex]} ${cur.year}`, `<button class="btn btn-primary" data-action="add-goal">${icon('plus','ic-sm')}Add Savings Goal</button>`)}
    ${calc.goalPctTotal!==100 ? `<div class="banner gold"><div class="banner-text" style="display:flex;gap:12px;align-items:flex-start;"><span class="badge-ic sm t-warn">${icon('circle-alert')}</span><span>Your active goals add up to <strong>${pct(calc.goalPctTotal)}</strong>. Make them total 100% so this month’s savings amount is fully allocated.</span></div></div>` : ''}
    <div class="page-2col savings-layout">
      <div class="card">
        <div class="card-head"><h3 class="card-title">This Month</h3><span class="badge-ic t-save">${icon('piggy-bank')}</span></div>
        <div class="kpi-label">Total Saved This Month</div>
        <div class="hero-amount">${money(calc.actualTotal)}</div>
        <div class="save-target">
          <span>Monthly savings amount${calc.isCustomTarget?' <span class="pill gold">custom</span>':''}</span>
          <span class="br-amt"><b>${money(calc.budgetTotal)}</b><button class="icon-btn" data-action="edit-savings-amount" title="Set this month's savings amount">${icon('pencil')}</button></span>
        </div>
        ${barHtml(ratio, 'nec')}
        <div style="text-align:right;margin-top:8px;color:var(--text-2);font-size:14px;">${pct(ratio*100)} of target</div>
        <div class="divider"></div>
        <div class="kv-list">
          <div><span>Recommended (${pct(state.settings.allocations.savings||0)} of budgetable income)</span><b>${money(calc.autoBudgetTotal)}</b></div>
          <div><span>Planned across goals</span><b>${money(calc.totalPlanned)}</b></div>
          <div><span>Unallocated</span><b class="${Math.abs(calc.unallocated)<1?'':'neg'}">${money(calc.unallocated)}</b></div>
          <div><span>Savings rate</span><b>${pct(rateOfIncome)} of income</b></div>
        </div>
        <p class="help-text" style="margin-top:12px;">The recommended amount is only a guide. Set whatever you can actually put aside — even ${money(0)} — and it’s split across your goals by their %.</p>
      </div>
      <div class="card">
        <div class="card-head"><h3 class="card-title">Savings Goals</h3>
          ${deactivatedCount ? `<label class="card-chip" style="cursor:pointer;"><input type="checkbox" data-show-deactivated-goals ${curShowDeactivatedGoals?'checked':''}>Show ${deactivatedCount} hidden</label>` : ''}
        </div>
        ${visibleGoals.length ? `<div class="tbl-wrap"><table class="tbl">
          <thead><tr><th>Goal</th><th class="num">Target %</th><th class="num">This Month</th><th class="num">Total Saved</th><th style="min-width:140px;">Progress</th><th style="width:40px;"></th></tr></thead>
          <tbody>${visibleGoals.map((g,i)=>{
            const total = totalSavedAllTime(g.id);
            const prog = g.target>0 ? total/g.target : (g.budget>0 ? g.actual/g.budget : 0);
            return `<tr style="${g.active?'':'opacity:.55;'}">
              <td><span class="cat-name"><span class="badge-ic sm t-${iconTone(goalIconFor(g),'nec')}">${icon(goalIconFor(g))}</span><span>${escapeHtml(g.name)}${g.target?`<small style="display:block;">Goal ${money(g.target)}</small>`:''}</span></span></td>
              <td class="num">${pct(g.allocation)}${g.isPctCustomThisMonth?' <span class="pill gold">custom</span>':''}</td>
              <td class="num"><b>${money(g.actual)}</b><small style="display:block;color:var(--text-3);">of ${money(g.budget)}</small></td>
              <td class="num">${money(total)}</td>
              <td><div class="prog-cell">${barHtml(prog,'nec',true)}<span>${pct(prog*100)}</span></div><small style="color:var(--text-3);">${g.target>0?'of goal':'of this month'}</small></td>
              <td>${kebab('goal',{id:g.id})}</td>
            </tr>`;
          }).join('')}</tbody>
        </table></div>` : doodleNote('sprout', 'Plant your first goal', 'Add a savings goal to start splitting your monthly savings.')}
        <p class="help-text" style="margin-top:12px;">Use the ⋮ menu to record what you actually saved — totals never update automatically.</p>
      </div>
    </div>
  `;
}

/* =========================================================
   VIEW: DEBT & LOANS
========================================================= */
const DEBT_TABS = [
  {id:'overview', label:'All Debts'},
  {id:'installments', label:'Installments'},
  {id:'standard', label:'Standard Loans'},
  {id:'flexible', label:'Flexible'},
  {id:'history', label:'Payment History'}
];
const DEBT_TYPE_ICON = {standard:'landmark', installment:'credit-card', flexible:'hand-coins'};
/* Status badges from the design guide: icon + label on a soft tint. */
function statusPill(kind, label){
  const map = {ontrack:['sage','circle-check','On Track'], upcoming:['gold','clock','Upcoming'], delayed:['danger','circle-alert','Overdue'],
    recurring:['blue','refresh-cw','Recurring'], paid:['muted','circle-check','Paid'], flexible:['gold','clock','Flexible'], paused:['muted','pause','Paused'], partial:['gold','clock','Partial']};
  const [cls, ic, def] = map[kind] || map.upcoming;
  return `<span class="pill ${cls}">${icon(ic)}${label||def}</span>`;
}
function debtStatusPill(d){
  const s = debtStatusLabel(d);
  if(s==='Overdue') return statusPill('delayed');
  if(s==='Paid off') return statusPill('paid','Paid off');
  if(s==='Flexible') return statusPill('flexible');
  return statusPill('ontrack');
}
function viewDebts(key){
  if(curDebtTab==='all') curDebtTab = 'overview';
  if(curDebtDetailId){
    const d = state.debts.find(x=>x.id===curDebtDetailId);
    if(d) return debtDetailView(d);
    curDebtDetailId = null;
  }
  const t = debtOverviewTotals();
  const [mStart, mEnd] = monthRange(key);
  const paidThisMonth = debtPaymentsInRange(mStart, mEnd);
  let body = '';
  if(curDebtTab==='overview') body = debtAllTab();
  else if(curDebtTab==='installments') body = debtInstallmentsTab();
  else if(curDebtTab==='standard') body = debtStandardTab();
  else if(curDebtTab==='flexible') body = debtFlexibleTab();
  else body = debtHistoryTab();
  return `
    ${pageHead('Debt / Loans Tracker', 'Everything you owe, in one place', `<button class="btn btn-primary" data-action="add-debt">${icon('plus','ic-sm')}Add Loan / Debt</button>`)}
    <div class="kpi-row">
      ${kpiCard('Total Balance', 'target', 'rose', t.totalOutstanding, null)}
      ${kpiCard('Total Paid (All Time)', 'wallet', 'nec', t.totalPaid, null)}
      ${kpiCard(`Payments in ${MONTH_NAMES[cur.monthIndex]}`, 'user', 'save', paidThisMonth, null)}
      ${t.overdueCount ? kpiCard('Overdue Payments', 'circle-alert', 'rose', null, null, null, `${t.overdueCount}`) : ''}
    </div>
    ${pillTabs('debt', DEBT_TABS, curDebtTab)}
    ${body}
  `;
}
function debtAllTab(){
  let list = state.debts.slice();
  if(curDebtSearch.trim()){
    const q = curDebtSearch.trim().toLowerCase();
    list = list.filter(d=> d.lender.toLowerCase().includes(q) || (d.borrower||'').toLowerCase().includes(q));
  }
  if(curDebtTypeFilter!=='all') list = list.filter(d=>d.repaymentType===curDebtTypeFilter);
  if(curDebtStatusFilter!=='all') list = list.filter(d=> debtStatusLabel(d).toLowerCase()===curDebtStatusFilter);
  list.sort((a,b)=> debtBalance(b)-debtBalance(a));
  const t = debtOverviewTotals();
  const progress = (t.totalOutstanding+t.totalPaid)>0 ? t.totalPaid/(t.totalOutstanding+t.totalPaid) : 0;
  return `<div class="card">
    <div class="card-head" style="flex-wrap:wrap;">
      <div style="flex:1;min-width:220px;">
        <div class="kpi-label" style="margin-bottom:8px;">Paydown progress · ${pct(progress*100)}</div>
        ${barHtml(progress,'nec',true)}
      </div>
      <div class="filter-row">
        <div class="search-field">${icon('search','ic-sm')}<input type="search" id="debtSearchInput" placeholder="Search lender or borrower" value="${escapeHtml(curDebtSearch)}"></div>
        <select id="debtTypeFilter" class="card-chip" aria-label="Type">
          <option value="all" ${curDebtTypeFilter==='all'?'selected':''}>All types</option>
          <option value="standard" ${curDebtTypeFilter==='standard'?'selected':''}>Standard</option>
          <option value="installment" ${curDebtTypeFilter==='installment'?'selected':''}>Installment</option>
          <option value="flexible" ${curDebtTypeFilter==='flexible'?'selected':''}>Flexible</option>
        </select>
        <select id="debtStatusFilter" class="card-chip" aria-label="Status">
          <option value="all" ${curDebtStatusFilter==='all'?'selected':''}>All statuses</option>
          <option value="active" ${curDebtStatusFilter==='active'?'selected':''}>On track</option>
          <option value="overdue" ${curDebtStatusFilter==='overdue'?'selected':''}>Overdue</option>
          <option value="flexible" ${curDebtStatusFilter==='flexible'?'selected':''}>Flexible</option>
          <option value="paid off" ${curDebtStatusFilter==='paid off'?'selected':''}>Paid off</option>
        </select>
      </div>
    </div>
    ${list.length ? `<div class="tbl-wrap"><table class="tbl">
      <thead><tr><th style="width:30px;"></th><th>Lender</th><th>Type</th><th>Borrower</th><th class="num">Original Amount</th><th class="num">Total Loan</th><th class="num">Paid</th><th class="num">Balance</th><th>Status</th><th style="width:40px;"></th></tr></thead>
      <tbody>${list.map(d=>`<tr class="clickable" data-action="view-debt" data-id="${d.id}">
        <td style="color:var(--text-3);">${icon('chevron-right','ic-sm')}</td>
        <td><span class="cat-name"><span class="badge-ic xs t-debt">${icon(DEBT_TYPE_ICON[d.repaymentType]||'landmark')}</span><b>${escapeHtml(d.lender)}</b></span></td>
        <td class="muted-cell nowrap">${DEBT_TYPE_LABEL[d.repaymentType]}</td>
        <td>${personChip(d.borrower)}</td>
        <td class="num">${money(d.principal)}</td>
        <td class="num">${money(debtTotalOwed(d))}</td>
        <td class="num">${money(debtTotalPaid(d))}</td>
        <td class="num"><b>${money(debtBalance(d))}</b></td>
        <td>${debtStatusPill(d)}</td>
        <td>${kebab('debt',{id:d.id})}</td>
      </tr>`).join('')}</tbody>
    </table></div>` : emptyNote('landmark','debt', state.debts.length ? 'No debts match this filter.' : 'No debts yet. Add a loan, credit card, or installment plan to track it here.')}
  </div>`;
}
function debtCardHead(d, badge){
  return `<div class="card-head">
    <span class="cat-name"><span class="badge-ic t-debt">${icon(DEBT_TYPE_ICON[d.repaymentType]||'landmark')}</span><span><b style="font-size:16px;">${escapeHtml(d.lender)}</b><small style="display:block;">${escapeHtml(d.borrower||'')} · ${DEBT_TYPE_LABEL[d.repaymentType]}</small></span></span>
    <span style="display:flex;gap:8px;align-items:center;">${badge||''}${kebab('debt',{id:d.id})}</span>
  </div>`;
}
function completedToggle(count){
  return count ? `<label class="card-chip" style="cursor:pointer;margin-bottom:14px;"><input type="checkbox" data-show-completed-debts ${curShowCompletedDebts?'checked':''}>Show ${count} paid off</label>` : '';
}
function debtStandardTab(){
  const all = state.debts.filter(d=>d.repaymentType==='standard');
  const completedCount = all.filter(d=>debtBalance(d)<=0).length;
  const list = curShowCompletedDebts ? all : all.filter(d=>debtBalance(d)>0);
  if(!list.length) return completedToggle(completedCount) + `<div class="card">${emptyNote('landmark','debt', all.length?'All your standard loans are paid off.':'No standard loans yet.')}</div>`;
  return completedToggle(completedCount) + `<div class="card-grid">${list.map(d=>{
    const p = debtProgressPct(d)/100;
    const ia = debtInterestAmount(d);
    const overdue = debtOverdueInfo(d);
    const lf = debtLateFeeAmount(d);
    return `<div class="card">${debtCardHead(d, debtStatusPill(d))}
      <div class="sec-summary-top"><span class="kpi-label">${money(debtTotalPaid(d))} paid</span><span class="br-amt"><b>${money(debtBalance(d))}</b> <span>left of ${money(debtTotalOwed(d))}</span></span></div>
      ${barHtml(p,'nec',true)}
      <div class="kv-list" style="margin-top:14px;">
        <div><span>Principal</span><b>${money(d.principal)}</b></div>
        <div><span>Interest</span><b>${escapeHtml(ia.label)}</b></div>
        ${lf>0?`<div><span>Late fee</span><b class="neg">${money(lf)}</b></div>`:''}
        <div><span>Due</span><b class="${overdue.overdue?'neg':''}">${d.dueDate?fmtDateLong(d.dueDate):'No due date'}</b></div>
      </div>
    </div>`;
  }).join('')}</div>`;
}
function debtInstallmentsTab(){
  const all = state.debts.filter(d=>d.repaymentType==='installment');
  const completedCount = all.filter(d=>debtBalance(d)<=0).length;
  const list = curShowCompletedDebts ? all : all.filter(d=>debtBalance(d)>0);
  if(!list.length) return completedToggle(completedCount) + `<div class="card">${emptyNote('credit-card','debt', all.length?'All your installment plans are paid off.':'No installment plans yet.')}</div>`;
  return completedToggle(completedCount) + list.map(d=>{
    const schedule = debtInstallmentSchedule(d);
    const next = schedule.find(s=>s.status==='Upcoming'||s.status==='Overdue'||s.status==='Partial');
    const p = debtProgressPct(d)/100;
    return `<div class="card section-block">${debtCardHead(d, debtStatusPill(d))}
      <div class="sec-summary-top"><span class="kpi-label">${d.installment.numPayments} × ${money(d.installment.monthlyPayment)}</span><span class="br-amt"><b>${money(debtTotalPaid(d))}</b> <span>/ ${money(debtScheduledTotal(d))}</span></span></div>
      ${barHtml(p,'nec',true)}
      <div class="sec-summary-meta">${next ? `Next: #${next.index} due ${fmtDateLong(next.dueDate)} — ${money(next.remaining)}${next.status==='Overdue'?' (overdue)':''}` : 'All installments paid'}</div>
      ${installmentScheduleTable(schedule)}
    </div>`;
  }).join('');
}
function installmentScheduleTable(schedule){
  return `<div class="tbl-wrap" style="margin-top:14px;"><table class="tbl">
    <thead><tr><th>#</th><th>Due date</th><th class="num">Expected</th><th class="num">Paid</th><th>Status</th></tr></thead>
    <tbody>${schedule.map(s=>`<tr><td>${s.index}</td><td class="nowrap">${fmtDateLong(s.dueDate)}</td><td class="num">${money(s.expected)}</td><td class="num">${money(s.paid)}</td><td>${statusPill(s.status==='Paid'?'paid':s.status==='Overdue'?'delayed':s.status==='Partial'?'partial':'upcoming')}</td></tr>`).join('')}</tbody>
  </table></div>`;
}
function debtFlexibleTab(){
  const all = state.debts.filter(d=>d.repaymentType==='flexible');
  const completedCount = all.filter(d=>debtBalance(d)<=0).length;
  const list = curShowCompletedDebts ? all : all.filter(d=>debtBalance(d)>0);
  if(!list.length) return completedToggle(completedCount) + `<div class="card">${emptyNote('hand-coins','debt', all.length?'All your flexible loans are paid off.':'No flexible loans yet.')}</div>`;
  return completedToggle(completedCount) + `<div class="card-grid">${list.map(d=>{
    const p = debtProgressPct(d)/100;
    return `<div class="card">${debtCardHead(d, debtStatusPill(d))}
      <div class="sec-summary-top"><span class="kpi-label">${money(debtTotalPaid(d))} paid</span><span class="br-amt"><b>${money(debtBalance(d))}</b> <span>left of ${money(d.principal)}</span></span></div>
      ${barHtml(p,'nec',true)}
      <div class="sec-summary-meta">${pct(p*100)} paid off · no fixed due date</div>
    </div>`;
  }).join('')}</div><p class="help-text">Flexible loans have no due date, so they’re never marked overdue or charged late fees.</p>`;
}
function debtHistoryTab(){
  const rows = [];
  state.debts.forEach(d=> d.payments.forEach(p=> rows.push({...p, lender:d.lender, borrower:d.borrower, debtId:d.id, type:d.repaymentType})));
  rows.sort((a,b)=> b.date.localeCompare(a.date));
  return `<div class="card">
    <div class="card-head"><h3 class="card-title">Payment History</h3><span class="card-chip">${rows.length} payment${rows.length===1?'':'s'}</span></div>
    ${rows.length ? `<div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>Date</th><th>Lender</th><th>Borrower</th><th class="num">Amount</th><th>Note</th><th style="width:40px;"></th></tr></thead>
      <tbody>${rows.map(r=>`<tr>
        <td class="nowrap">${fmtDateLong(r.date)}</td>
        <td><span class="cat-name"><span class="badge-ic xs t-debt">${icon(DEBT_TYPE_ICON[r.type]||'landmark')}</span>${escapeHtml(r.lender)}</span></td>
        <td>${personChip(r.borrower)}</td>
        <td class="num"><b>${money(r.amount)}</b></td>
        <td class="muted-cell">${escapeHtml(r.note||'')}</td>
        <td>${kebab('payment',{id:r.id, debtid:r.debtId})}</td>
      </tr>`).join('')}</tbody>
    </table></div>` : emptyNote('hand-coins','debt','No payments recorded yet.')}
  </div>`;
}
function debtDetailView(d){
  const ia = debtInterestAmount(d);
  const total = debtTotalOwed(d), paid = debtTotalPaid(d), balance = debtBalance(d);
  const p = debtProgressPct(d)/100;
  const overdue = debtOverdueInfo(d);
  const payments = [...d.payments].sort((a,b)=>b.date.localeCompare(a.date));
  const lf = debtLateFeeAmount(d);
  return `
    <button class="btn btn-ghost btn-sm" data-action="back-to-debts" style="margin-top:8px;">${icon('arrow-left','ic-sm')}Back to Debts</button>
    ${pageHead(escapeHtml(d.lender), `${escapeHtml(d.borrower||'')} · ${DEBT_TYPE_LABEL[d.repaymentType]}`,
      `<button class="btn" data-action="edit-debt" data-id="${d.id}">${icon('pencil','ic-sm')}Edit</button>
       <button class="btn btn-primary" data-action="record-debt-payment" data-id="${d.id}">${icon('plus','ic-sm')}Record Payment</button>`)}
    ${overdue.overdue ? `<div class="banner gold"><div class="banner-text" style="display:flex;gap:12px;align-items:center;"><span class="badge-ic sm t-rose">${icon('circle-alert')}</span><span><strong>${money(overdue.amount)} overdue</strong>${overdue.monthsOverdue?` · ${overdue.monthsOverdue} month${overdue.monthsOverdue===1?'':'s'}`:''}</span></div></div>` : ''}
    <div class="kpi-row">
      ${kpiCard('Total Owed', 'landmark', 'debt', total, null)}
      ${kpiCard('Paid So Far', 'wallet', 'nec', paid, null)}
      ${kpiCard('Balance', 'target', 'rose', balance, null)}
    </div>
    <div class="page-2col">
      <div class="card">
        <div class="card-head"><h3 class="card-title">Repayment</h3>${debtStatusPill(d)}</div>
        <div class="save-summary"><div><span class="big">${pct(p*100)}</span> <span class="of">paid off</span></div><div class="saved"><b>${money(paid)}</b> of ${money(total)}</div></div>
        ${barHtml(p,'nec')}
        <div class="divider"></div>
        <div class="kv-list">
          <div><span>Date borrowed</span><b>${fmtDateLong(d.dateBorrowed)}</b></div>
          <div><span>Due date</span><b>${d.repaymentType==='flexible'?'None (flexible)':(d.dueDate?fmtDateLong(d.dueDate):'—')}</b></div>
          <div><span>Principal</span><b>${money(d.principal)}</b></div>
          <div><span>Interest</span><b>${d.repaymentType==='installment' ? (d.installment.interestKnown?money(d.installment.interestAmount):'Unknown') : escapeHtml(ia.label)}</b></div>
          ${lf>0?`<div><span>Late fees</span><b class="neg">${money(lf)}</b></div>`:''}
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3 class="card-title">Payment History</h3><span class="card-chip">${payments.length}</span></div>
        ${payments.length ? `<div class="tbl-wrap"><table class="tbl">
          <thead><tr><th>Date</th><th class="num">Amount</th><th>Note</th><th style="width:40px;"></th></tr></thead>
          <tbody>${payments.map(p2=>`<tr><td class="nowrap">${fmtDateLong(p2.date)}</td><td class="num"><b>${money(p2.amount)}</b></td><td class="muted-cell">${escapeHtml(p2.note||'')}</td><td>${kebab('payment',{id:p2.id, debtid:d.id})}</td></tr>`).join('')}</tbody>
        </table></div>` : emptyNote('hand-coins','debt','No payments recorded yet.')}
      </div>
    </div>
    ${d.repaymentType==='installment' ? `<div class="card" style="margin-top:18px;">
      <div class="card-head"><h3 class="card-title">Payment Schedule</h3></div>
      ${installmentScheduleTable(debtInstallmentSchedule(d))}
      ${d.installment.interestKnown ? '' : `<p class="help-text" style="margin-top:10px;">Interest unknown — the scheduled total (${money(debtScheduledTotal(d))}) is ${money(Math.max(0,debtScheduledTotal(d)-d.principal))} more than the principal.</p>`}
    </div>` : ''}
  `;
}

/* =========================================================
   VIEW: CALENDAR
========================================================= */
let curCalEventFilter = 'all';
function viewCalendar(key){
  const m = getMonth(key,true);
  const y = cur.year, mi = cur.monthIndex;
  const nDays = daysInMonth(y, mi);
  const firstDow = new Date(y, mi, 1).getDay();
  const monthStartISO = monthKey(y,mi)+'-01', monthEndISO = monthKey(y,mi)+'-'+String(nDays).padStart(2,'0');
  const paydaysByEarner = earners().map(e=>({e, dates:new Set(paydaysInRange(e, monthStartISO, monthEndISO))}));
  const incomeByDate = {};
  m.income.forEach(i=>{ (incomeByDate[i.date]=incomeByDate[i.date]||[]).push(i); });
  const recurByDate = {};
  if(curCalFilters.recurring){
    state.recurringBills.filter(r=>r.active).forEach(rec=>{
      recurringOccurrences(rec, monthStartISO, monthEndISO).forEach(occISO=>{
        (recurByDate[occISO]=recurByDate[occISO]||[]).push({rec, st:recurringOccurrenceStatus(rec, occISO)});
      });
    });
  }
  const expByDate = {};
  if(curCalFilters.expenses){
    allExpensesForMonth(m).forEach(e=>{ if(!e.recurringId) (expByDate[e.date]=expByDate[e.date]||[]).push(e); });
  }
  const tag = (tone, ic, text, title)=>`<span class="cal-tag t-${tone}" title="${escapeHtml(title||text)}">${icon(ic,'ic-xs')}<span>${escapeHtml(text)}</span></span>`;
  const cells = [];
  for(let i=0;i<firstDow;i++) cells.push(`<div class="cal-cell blank"></div>`);
  for(let d=1; d<=nDays; d++){
    const iso = toISO(new Date(y,mi,d));
    let tags = '';
    if(curCalFilters.paydays){
      paydaysByEarner.forEach(({e, dates})=>{
        if(!dates.has(iso)) return;
        const received = (incomeByDate[iso]||[]).find(x=>x.person===e.id) || findIncomeOn(e.id, iso);
        tags += tag('nec', 'user', `${e.name} Payday`, `${e.name} — ${received?'received '+money(received.amount):'expected payday'}`);
      });
    }
    if(curCalFilters.paydays){
      recurringIncomeList().filter(r=>r.active).forEach(rec=>{
        if(recurringOccurrences(rec, iso, iso).length) tags += tag('nec', 'banknote', rec.name, `${rec.name} · ${money(rec.amount)} · ${recurringIncomeStatus(rec, iso).status}`);
      });
    }
    (recurByDate[iso]||[]).forEach(({rec,st})=>{
      const tone = st.status==='Paid' ? 'muted' : 'rose';
      tags += tag(tone, st.status==='Paid'?'check':categoryIcon(rec.name+' '+rec.mainCategory)==='tag'?'receipt':categoryIcon(rec.name+' '+rec.mainCategory), rec.name, `${rec.name} · ${st.status==='Paid'?'paid '+money(st.actual):money(rec.expectedAmount)+' — '+st.status}`);
    });
    (expByDate[iso]||[]).forEach(e=>{
      tags += tag('save', catIconFor(e.section, e.mainCategory, e.subCategory), expenseLeafLabel(e), `${expenseLeafLabel(e)} · ${money(e.amount)}`);
    });
    if(curCalFilters.debts){
      state.debts.forEach(deb=>{
        if(deb.repaymentType==='installment'){
          debtInstallmentSchedule(deb).forEach(s=>{
            if(s.dueDate===iso) tags += tag(s.status==='Paid'?'muted':'play', s.status==='Paid'?'check':'credit-card', `${deb.lender} #${s.index}`, `${deb.lender} #${s.index} · ${money(s.expected)} · ${s.status}`);
          });
        } else if(deb.repaymentType==='standard' && deb.dueDate===iso){
          const paidOff = debtBalance(deb)<=0;
          tags += tag(paidOff?'muted':'play', 'landmark', `${deb.lender} due`, `${deb.lender} due · ${money(debtBalance(deb))}`);
        }
      });
    }
    cells.push(`<div class="cal-cell ${toISO(today)===iso?'today':''}"><div class="cal-day">${d}</div>${tags}</div>`);
  }
  const filterChip = (id, label)=>`<label class="filter-chip ${curCalFilters[id]?'on':''}"><input type="checkbox" data-cal-filter="${id}" ${curCalFilters[id]?'checked':''}>${label}</label>`;
  const t0 = toISO(today);
  let events = computeUpcomingItems(key);
  if(curCalEventFilter==='paydays') events = events.filter(e=>e.kind==='payday'||e.kind==='income');
  else if(curCalEventFilter==='bills') events = events.filter(e=>e.kind==='bill');
  else if(curCalEventFilter==='debts') events = events.filter(e=>e.kind==='installment'||e.kind==='loan');
  const overdue = events.filter(e=>e.date<t0 && e.status==='Overdue');
  const upcoming = events.filter(e=>e.date>=t0).slice(0,8);
  return `
    ${pageHead('Calendar', `${MONTH_NAMES[mi]} ${y}`,
      `<button class="btn" data-action="goto-today">${icon('calendar-check','ic-sm')}Today</button>
       <button class="btn btn-primary" data-action="manage-recurring">${icon('plus','ic-sm')}Add Recurring Bill</button>`)}
    <div class="cal-layout">
      <div class="card">
        <div class="card-head" style="flex-wrap:wrap;">
          <h3 class="card-title">${MONTH_NAMES[mi]} ${y}</h3>
          <div class="filter-row">${filterChip('paydays','Paydays')}${filterChip('recurring','Bills')}${filterChip('expenses','Expenses')}${filterChip('debts','Debts')}</div>
        </div>
        <div class="calendar-grid cal-head">${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d=>`<div class="cal-dow">${d}</div>`).join('')}</div>
        <div class="calendar-grid">${cells.join('')}</div>
        <div class="cal-legend"><span><i style="background:var(--c-nec)"></i>Payday</span><span><i style="background:var(--c-rose)"></i>Bill / Recurring</span><span><i style="background:var(--c-save)"></i>Expense</span><span><i style="background:var(--c-play)"></i>Debt payment</span></div>
      </div>
      <div class="card">
        <div class="card-head"><h3 class="card-title">Upcoming Events</h3>
          <select class="card-chip" id="calEventFilter" aria-label="Filter events">
            ${[['all','All'],['paydays','Paydays'],['bills','Bills'],['debts','Debts']].map(([v,l])=>`<option value="${v}" ${curCalEventFilter===v?'selected':''}>${l}</option>`).join('')}
          </select>
        </div>
        ${overdue.length ? `<div class="overdue-note">${icon('circle-alert','ic-sm')}${overdue.length} overdue: ${overdue.slice(0,3).map(o=>escapeHtml(o.label)).join(', ')}${overdue.length>3?'…':''}</div>` : ''}
        ${upcoming.length ? `<div class="list-rows">${upcoming.map(it=>{
          const dd = new Date(it.date+'T00:00:00');
          const ui = upcomingIcon(it);
          return `<div class="list-row cal-list">
            <div class="lr-date">${fmtDateHuman(it.date)}<span>${dd.toLocaleDateString('en-US',{weekday:'short'})}</span></div>
            <span class="badge-ic t-${ui.tone}">${icon(ui.ic)}</span>
            <div class="lr-name">${escapeHtml(it.label)}<small>${it.kind==='bill'?'Bill':it.kind==='payday'?'Payday':it.kind==='income'?'Recurring income':'Debt payment'} · ${relativeDayLabel(it.date)}</small></div>
            <div class="lr-amt">${it.amount!==null?money(it.amount):'—'}</div>
          </div>`;
        }).join('')}</div>` : emptyNote('calendar-check','accent','Nothing coming up in the next 30 days.')}
      </div>
    </div>
    <div class="card" style="margin-top:18px;">
      <div class="card-head"><h3 class="card-title">Recurring Bills</h3><button class="card-chip" data-action="manage-recurring">${icon('plus','ic-sm')}Add</button></div>
      ${state.recurringBills.length ? `<div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>Name</th><th>Category</th><th class="num">Expected</th><th>Schedule</th><th>Status</th><th style="width:40px;"></th></tr></thead>
        <tbody>${state.recurringBills.map(rec=>{
          const next = nextRecurringOccurrence(rec);
          const catLabel = rec.subCategory ? `${rec.mainCategory} — ${rec.subCategory}` : rec.mainCategory;
          return `<tr>
            <td><span class="cat-name"><span class="badge-ic xs t-${catTone(rec.section, rec.mainCategory, rec.subCategory)}">${icon(catIconFor(rec.section, rec.mainCategory, rec.subCategory))}</span><b>${escapeHtml(rec.name)}</b></span></td>
            <td class="muted-cell">${escapeHtml(catLabel)} · ${sectionLabel(rec.section)}</td>
            <td class="num">${money(rec.expectedAmount)}</td>
            <td class="nowrap">${frequencyLabel(rec)}${next?`<small style="display:block;color:var(--text-3);">Next: ${fmtDateHuman(next)}</small>`:''}</td>
            <td>${rec.active ? statusPill('recurring') : statusPill('paused')}</td>
            <td>${kebab('recurring',{id:rec.id, due:next||''})}</td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>` : emptyNote('repeat','nec','No recurring bills yet. Add rent, utilities, or subscriptions so they show up on the calendar.')}
      <p class="help-text" style="margin-top:10px;">Pausing stops future calendar entries. Deleting a bill never deletes expenses you already logged from it.</p>
    </div>
  `;
}

/* =========================================================
   VIEW: REPORTS (annual)
========================================================= */
let curReportTab = 'overview';
const REPORT_TABS = [
  {id:'overview', label:'Monthly Overview'},
  {id:'categories', label:'Category Breakdown'},
  {id:'cashflow', label:'Income vs Expenses'},
  {id:'savings', label:'Savings Progress'},
  {id:'debt', label:'Debt'}
];
function annualData(year){
  const monthCalcs = [];
  for(let i=0;i<12;i++){
    const key = monthKey(year,i);
    if(state.months[key]) monthCalcs.push({i, key, calc: computeMonthShallowFull(key)});
  }
  const totalIncome = sumBy(monthCalcs, x=>x.calc.totalIncome);
  const totalExpenses = sumBy(monthCalcs, x=>x.calc.totalExpenses);
  const totalSavings = sumBy(monthCalcs, x=>x.calc.savingsActualTotal);
  const totalDebtPaid = sumBy(monthCalcs, x=>x.calc.debtPaymentsThisMonth);
  const totalBudgetable = sumBy(monthCalcs, x=>x.calc.budgetableIncome);
  const net = totalIncome-totalExpenses-totalSavings-totalDebtPaid;
  const n = monthCalcs.length||1;
  const catTotals = {necessities:0, extra:0, playjar:0};
  const categoryTotals = {};
  const goalTotals = {};
  state.settings.savingsGoals.forEach(g=> goalTotals[g.id]={goal:g, name:g.name, target:g.target, total:0});
  monthCalcs.forEach(x=>{
    const m = state.months[x.key];
    ['necessities','extra','playjar'].forEach(sec=>{
      m[sec].expenses.forEach(e=>{
        catTotals[sec]+=Number(e.amount||0);
        const k = sec+'|'+e.mainCategory;
        if(!categoryTotals[k]) categoryTotals[k] = {sec, main:e.mainCategory, total:0};
        categoryTotals[k].total += Number(e.amount||0);
      });
    });
    Object.entries(m.savingsActuals||{}).forEach(([gid,amt])=>{
      if(goalTotals[gid]) goalTotals[gid].total += Number(amt||0);
      else goalTotals[gid] = {goal:null, name:'Deleted goal', target:null, total:Number(amt||0)};
    });
  });
  const pick = (fn, better)=> monthCalcs.reduce((b,x)=> (b===null || better(fn(x.calc), fn(b.calc))) ? x : b, null);
  return {monthCalcs, totalIncome, totalExpenses, totalSavings, totalDebtPaid, totalBudgetable, net, n, catTotals,
    categories: Object.values(categoryTotals).sort((a,b)=>b.total-a.total), goals: Object.values(goalTotals),
    highestIncome: pick(c=>c.totalIncome, (a,b)=>a>b), lowestIncome: pick(c=>c.totalIncome, (a,b)=>a<b),
    highestSpend: pick(c=>c.totalExpenses, (a,b)=>a>b), lowestSpend: pick(c=>c.totalExpenses, (a,b)=>a<b),
    bestSavings: pick(c=>c.savingsActualTotal, (a,b)=>a>b)};
}
function viewAnnual(year){
  const A = annualData(year);
  const years = new Set([today.getFullYear()]);
  Object.keys(state.months).forEach(k=>years.add(cur_yearOf(k)));
  const yearOptions = Array.from(years).sort((a,b)=>a-b);
  let body;
  if(curReportTab==='categories') body = reportCategories(A);
  else if(curReportTab==='cashflow') body = reportCashflow(A);
  else if(curReportTab==='savings') body = reportSavings(A);
  else if(curReportTab==='debt') body = annualDebtSection(year);
  else body = reportOverview(A, year);
  return `
    ${pageHead('Reports &amp; Insights', `${A.monthCalcs.length} month${A.monthCalcs.length===1?'':'s'} recorded in ${year}`,
      `<select id="annualYearSelect" class="card-chip" aria-label="Year">${yearOptions.map(y=>`<option value="${y}" ${y===year?'selected':''}>${y}</option>`).join('')}</select>
       <button class="btn" data-action="export-menu">${icon('download','ic-sm')}Export</button>`)}
    ${pillTabs('report', REPORT_TABS, curReportTab)}
    ${A.monthCalcs.length ? body : `<div class="card">${doodleNote('lantern', 'Nothing to report yet', `No data recorded for ${year} yet.`)}</div>`}
  `;
}
function reportOverview(A){
  const slices = [
    {key:'necessities', label:'Necessities', amount:A.catTotals.necessities},
    {key:'extra', label:'Extra Expenses', amount:A.catTotals.extra},
    {key:'playjar', label:'Play Jar', amount:A.catTotals.playjar},
    {key:'debt', label:'Debt Payments', amount:A.totalDebtPaid}
  ];
  const total = sumBy(slices, s=>s.amount);
  const tone = {necessities:'nec', extra:'extra', playjar:'play', debt:'debt'};
  const mn = x=> x ? `${MONTH_NAMES[x.i]}` : '—';
  return `
    <div class="kpi-row">
      ${kpiCard('Total Income', 'receipt', 'save', A.totalIncome, null)}
      ${kpiCard('Total Expenses', 'shopping-bag', 'extra', A.totalExpenses, null)}
      ${kpiCard('Total Savings', 'piggy-bank', 'nec', A.totalSavings, null)}
      ${kpiCard('Net Cash Flow', 'wallet', A.net>=0?'nec':'rose', A.net, null)}
    </div>
    <div class="dash-row-2">
      <div class="card">
        <div class="card-head"><h3 class="card-title">Income vs Expenses vs Savings</h3></div>
        <div style="position:relative;height:300px;"><canvas id="annual12Chart"></canvas></div>
      </div>
      <div class="card">
        <div class="card-head"><h3 class="card-title">Spending by Category</h3></div>
        ${total>0 ? `<div class="donut-wrap" style="margin:0 auto 14px;width:200px;height:200px;"><canvas id="annualSpendDonut"></canvas>
          <div class="donut-center"><b>${money(Math.round(total))}</b><span>spent in total</span></div></div>` : ''}
        <div class="legend-list">${slices.map(s=>`<div class="legend-item"><span class="dot" style="background:var(--c-${tone[s.key]})"></span><span>${s.label}</span><span class="lg-pct">${total>0?pct(s.amount/total*100):'—'}</span><span class="lg-amt">${money(s.amount)}</span></div>`).join('')}</div>
      </div>
    </div>
    <div class="highlights">
      ${[['Highest income', A.highestIncome, x=>x.calc.totalIncome, 'trending-up','save'],
         ['Lowest income', A.lowestIncome, x=>x.calc.totalIncome, 'trending-down','rose'],
         ['Best savings month', A.bestSavings, x=>x.calc.savingsActualTotal, 'piggy-bank','nec'],
         ['Highest spending', A.highestSpend, x=>x.calc.totalExpenses, 'flame','extra'],
         ['Lowest spending', A.lowestSpend, x=>x.calc.totalExpenses, 'leaf','play']].map(([l, x, f, ic, t])=>`
        <div class="card hl-card"><span class="badge-ic sm t-${t}">${icon(ic)}</span><div><div class="kpi-label" style="font-size:13px;">${l}</div><div style="font-weight:800;">${mn(x)}</div><small style="color:var(--text-2);">${x?money(f(x)):''}</small></div></div>`).join('')}
    </div>
  `;
}
function reportCategories(A){
  const max = Math.max(1, ...A.categories.map(c=>c.total));
  const sec = [['necessities','Necessities'],['extra','Extra Expenses'],['playjar','Play Jar']];
  return `<div class="page-2col">
    <div class="card">
      <div class="card-head"><h3 class="card-title">By Section</h3><span class="card-chip">${money(A.totalExpenses)}</span></div>
      <div class="budget-rows">${sec.map(([k,l])=>{
        const r = A.totalExpenses>0 ? A.catTotals[k]/A.totalExpenses : 0;
        return `<div class="budget-row" style="cursor:default;"><span class="badge-ic t-${SECTION_TONE[k]}">${icon(BUCKETS[k].icon)}</span><span class="br-name">${l}</span><span class="br-pct">${pct(r*100)}</span>${barHtml(r, SECTION_TONE[k])}<span class="br-amt"><b>${money(A.catTotals[k])}</b></span></div>`;
      }).join('')}</div>
      <div class="divider"></div>
      <div class="kv-list">
        <div><span>Average monthly spending</span><b>${money(A.totalExpenses/A.n)}</b></div>
        <div><span>Debt payments this year</span><b>${money(A.totalDebtPaid)}</b></div>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h3 class="card-title">By Category</h3><span class="card-chip">${A.categories.length} categories</span></div>
      ${A.categories.length ? `<div class="cb-list">${A.categories.map(c=>`<div class="cb-row">
        <span class="badge-ic sm t-${catTone(c.sec, c.main)}">${icon(catIconFor(c.sec, c.main))}</span>
        <div class="cb-main"><div class="cb-top"><span class="cb-name">${escapeHtml(c.main)} <small style="color:var(--text-3);font-weight:500;">${sectionLabel(c.sec).replace(' Expenses','')}</small></span><span class="br-amt"><b>${money(c.total)}</b></span></div>${barHtml(c.total/max, SECTION_TONE[c.sec], true)}</div>
        <span class="cb-pct">${A.totalExpenses>0?pct(c.total/A.totalExpenses*100):''}</span>
      </div>`).join('')}</div>` : emptyNote('tags','extra','No expenses recorded this year.')}
    </div>
  </div>`;
}
function reportCashflow(A){
  const rows = A.monthCalcs.map(x=>{
    const c = x.calc;
    const net = c.totalIncome - c.totalExpenses - c.debtPaymentsThisMonth - c.savingsActualTotal;
    return `<tr><td><b>${MONTH_NAMES[x.i]}</b></td><td class="num">${money(c.totalIncome)}</td><td class="num">${money(c.totalExpenses)}</td><td class="num">${money(c.debtPaymentsThisMonth)}</td><td class="num">${money(c.savingsActualTotal)}</td><td class="num"><span class="${net>=0?'pos':'neg'}">${money(net)}</span></td></tr>`;
  }).join('');
  return `
    <div class="kpi-row">
      ${kpiCard('Avg. Monthly Income', 'receipt', 'save', A.totalIncome/A.n, null)}
      ${kpiCard('Avg. Monthly Expenses', 'shopping-bag', 'extra', A.totalExpenses/A.n, null)}
      ${kpiCard('Budgetable Income', 'wallet', 'nec', A.totalBudgetable, null)}
      ${kpiCard('Savings Rate', 'piggy-bank', 'play', null, null, null, pct(A.totalIncome>0?A.totalSavings/A.totalIncome*100:0))}
    </div>
    <div class="card">
      <div class="card-head"><h3 class="card-title">Month by Month</h3></div>
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>Month</th><th class="num">Income</th><th class="num">Expenses</th><th class="num">Debt Paid</th><th class="num">Saved</th><th class="num">Net</th></tr></thead>
        <tbody>${rows}
          <tr class="total-row"><td><b>Total</b></td><td class="num"><b>${money(A.totalIncome)}</b></td><td class="num"><b>${money(A.totalExpenses)}</b></td><td class="num"><b>${money(A.totalDebtPaid)}</b></td><td class="num"><b>${money(A.totalSavings)}</b></td><td class="num"><b class="${A.net>=0?'pos':'neg'}">${money(A.net)}</b></td></tr>
        </tbody>
      </table></div>
    </div>`;
}
function reportSavings(A){
  return `
    <div class="kpi-row">
      ${kpiCard('Saved This Year', 'piggy-bank', 'nec', A.totalSavings, null)}
      ${kpiCard('Avg. Monthly Savings', 'sprout', 'save', A.totalSavings/A.n, null)}
      ${kpiCard('Savings Rate', 'percent', 'play', null, null, null, pct(A.totalIncome>0?A.totalSavings/A.totalIncome*100:0))}
    </div>
    <div class="card">
      <div class="card-head"><h3 class="card-title">Savings by Goal</h3></div>
      ${A.goals.length ? `<div class="cb-list">${A.goals.map((g,i)=>{
        const r = g.target ? g.total/g.target : (A.totalSavings>0 ? g.total/A.totalSavings : 0);
        return `<div class="cb-row">
          <span class="badge-ic sm t-${iconTone(goalIconFor(g.goal||{name:g.name}),'nec')}">${icon(goalIconFor(g.goal||{name:g.name}))}</span>
          <div class="cb-main"><div class="cb-top"><span class="cb-name">${escapeHtml(g.name)}</span><span class="br-amt"><b>${money(g.total)}</b>${g.target?` <span>/ ${money(g.target)}</span>`:''}</span></div>${barHtml(r,'nec',true)}</div>
          <span class="cb-pct">${pct(r*100)}</span>
        </div>`;
      }).join('')}</div>` : emptyNote('sprout','save','No savings goals yet.')}
      <p class="help-text" style="margin-top:12px;">Goals with a target show progress toward it; others show their share of everything saved this year.</p>
    </div>`;
}
function annualDebtSection(year){
  const startCutoff = (year-1)+'-12-31';
  const endCutoff = (year===today.getFullYear()) ? toISO(today) : year+'-12-31';
  const startingDebt = allDebtsBalanceAsOf(startCutoff);
  const endingDebt = allDebtsBalanceAsOf(endCutoff);
  const newDebt = borrowedFundsInRange(year+'-01-01', year+'-12-31');
  const totalPayments = debtPaymentsInRange(year+'-01-01', year+'-12-31');
  const interestThisYear = sumBy(state.debts.filter(d=> d.dateBorrowed>=(year+'-01-01') && d.dateBorrowed<=(year+'-12-31')), d=>{
    if(d.repaymentType==='installment') return d.installment.interestKnown ? (Number(d.installment.interestAmount)||0) : 0;
    const ia = debtInterestAmount(d); return ia.amount||0;
  });
  return `
    <div class="kpi-row">
      ${kpiCard('Starting Debt', 'landmark', 'debt', startingDebt, null)}
      ${kpiCard('New Debt', 'plus', 'rose', newDebt, null)}
      ${kpiCard('Payments Made', 'hand-coins', 'nec', totalPayments, null)}
      ${kpiCard('Ending Debt', 'target', 'play', endingDebt, null)}
    </div>
    <div class="card">
      <div class="card-head"><h3 class="card-title">Outstanding Debt — ${year}</h3><span class="card-chip">Reduced by ${money(startingDebt-endingDebt)}</span></div>
      <div style="position:relative;height:260px;"><canvas id="annualDebtChart"></canvas></div>
      <p class="help-text" style="margin-top:10px;">Known interest on debts taken out this year: ${money(interestThisYear)}. This isn’t a full amortization breakdown.</p>
    </div>`;
}
function progressBarPlain(label, val, total){
  const p = total>0? val/total*100 : 0;
  return `<div class="progress-wrap"><div class="progress-top"><span>${label}</span><span>${money(val)}</span></div>
    <div class="progress-track"><div class="progress-fill ok" style="width:${p}%"></div></div></div>`;
}
function drawAnnualCharts(year){
  const moneyTick = (v)=>{ const n = Number(v); return Math.abs(n)>=1000 ? currencySymbol()+(n/1000).toLocaleString(undefined,{maximumFractionDigits:1})+'k' : money(n); };
  destroyChart('annual12');
  const ctx = document.getElementById('annual12Chart');
  if(ctx){
    const income=[], expenses=[], debt=[], savings=[];
    for(let i=0;i<12;i++){
      const key = monthKey(year,i);
      const c = state.months[key] ? computeMonthShallowFull(key) : null;
      income.push(c?c.totalIncome:0); expenses.push(c?c.totalExpenses:0); debt.push(c?c.debtPaymentsThisMonth:0); savings.push(c?c.savingsActualTotal:0);
    }
    chartRegistry['annual12'] = new Chart(ctx, {
      type:'bar',
      data:{ labels: MONTH_NAMES.map(m=>m.slice(0,3)), datasets:[
        {label:'Income', data:income, backgroundColor:bucketColor('necessities'), maxBarThickness:14},
        {label:'Expenses (excl. debt)', data:expenses, backgroundColor:bucketColor('extra'), maxBarThickness:14},
        {label:'Debt Payments', data:debt, backgroundColor:bucketColor('playjar'), maxBarThickness:14},
        {label:'Savings', data:savings, backgroundColor:bucketColor('savings'), maxBarThickness:14}
      ]},
      options:{ responsive:true, maintainAspectRatio:false,
        plugins:{legend:{position:'top', align:'start'}, tooltip:{callbacks:{label:(it)=>` ${it.dataset.label}: ${money(it.parsed.y)}`}}},
        scales:{ x:{grid:{display:false}}, y:{ border:{display:false}, ticks:{ callback:moneyTick } } } }
    });
  }
  destroyChart('annualSpend');
  const dctx = document.getElementById('annualSpendDonut');
  if(dctx){
    const A = annualData(year);
    const slices = [['necessities',A.catTotals.necessities],['extra',A.catTotals.extra],['playjar',A.catTotals.playjar],['debt',A.totalDebtPaid]].filter(s=>s[1]>0);
    chartRegistry['annualSpend'] = new Chart(dctx, {
      type:'doughnut',
      data:{ labels:slices.map(s=>BUCKETS[s[0]].label), datasets:[{data:slices.map(s=>s[1]), backgroundColor:slices.map(s=>bucketColor(s[0])), borderWidth:0, spacing:2}] },
      options:{ responsive:true, maintainAspectRatio:false, cutout:'64%', plugins:{legend:{display:false}, tooltip:{callbacks:{label:(it)=>` ${it.label}: ${money(it.parsed)}`}}} }
    });
  }
  destroyChart('annualDebt');
  const debtCtx = document.getElementById('annualDebtChart');
  if(debtCtx){
    const outstanding = [];
    for(let i=0;i<12;i++) outstanding.push(allDebtsBalanceAsOf(monthKey(year,i)+'-'+String(daysInMonth(year,i)).padStart(2,'0')));
    chartRegistry['annualDebt'] = new Chart(debtCtx, {
      type:'line',
      data:{ labels: MONTH_NAMES.map(m=>m.slice(0,3)), datasets:[{label:'Outstanding debt', data:outstanding, borderColor:bucketColor('playjar'), backgroundColor:cssVar('--c-play-tint'), fill:true, pointRadius:0, pointHoverRadius:4, tension:0.3}] },
      options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}, tooltip:{callbacks:{label:(it)=>` ${money(it.parsed.y)}`}}},
        scales:{ x:{grid:{display:false}}, y:{ border:{display:false}, ticks:{ callback:moneyTick } } } }
    });
  }
}

/* =========================================================
   VIEW: SETTINGS
========================================================= */
let curSettingsTab = 'general';
const SETTINGS_TABS = [
  {id:'general', label:'General'},
  {id:'budget', label:'Budget & Categories'},
  {id:'alerts', label:'Alerts'},
  {id:'appearance', label:'Appearance & App'},
  {id:'data', label:'Data & Account'}
];
function viewSettings(){
  const s = state.settings;
  let body = '';
  if(curSettingsTab==='budget'){
    const a = s.allocations;
    const totalA = a.necessities+a.savings+a.extra+a.playjar;
    body = `
      <div class="card settings-group">
        <div class="card-head"><h3 class="card-title">Budget Allocation</h3><span class="card-chip ${totalA===100?'':'rose'}">Total ${totalA}%</span></div>
        <p class="small-muted" style="margin-top:-8px;margin-bottom:14px;">How your budgetable income (income after debt payments) is split each month. Must add up to 100%.</p>
        <div class="alloc-grid">
          ${[['allocNec','necessities','Necessities'],['allocSav','savings','Savings'],['allocExt','extra','Extra Expenses'],['allocPlay','playjar','Play Jar']].map(([id,k,l])=>`
            <div class="field"><label><span class="badge-ic xs t-${BUCKETS[k].tone}" style="margin-right:6px;">${icon(BUCKETS[k].icon)}</span>${l} %</label><input type="number" id="${id}" value="${a[k]}" min="0" max="100"></div>`).join('')}
        </div>
        <button class="btn btn-primary btn-sm" data-action="save-allocations">Save allocation</button>
      </div>
      ${['necessities','extra','playjar'].map(sec=>budgetDefaultsTable(sec, sectionLabel(sec))).join('')}`;
  } else if(curSettingsTab==='alerts'){
    const a = alertSettings();
    body = `<div class="card settings-group">
      <div class="card-head"><h3 class="card-title">Budget Alerts</h3><span class="badge-ic t-play">${icon('bell')}</span></div>
      <p class="small-muted" style="margin-top:-8px;margin-bottom:16px;">Alerts appear under the bell at the top of the screen, and as a quick message when an expense pushes a budget past the line.</p>
      <label class="toggle-row"><input type="checkbox" id="al-enabled" ${a.enabled?'checked':''}><span><b>Turn on alerts</b><small>Show the bell and budget warnings.</small></span></label>
      <div class="field" style="max-width:280px;margin-top:14px;"><label>Warn me when a budget reaches</label>
        <div class="input-affix"><input type="number" id="al-warn" min="50" max="100" step="5" value="${a.warnAt}" style="padding-left:12px;"><span class="affix" style="left:auto;right:12px;">%</span></div></div>
      <label class="toggle-row"><input type="checkbox" id="al-bills" ${a.bills?'checked':''}><span><b>Bills and debt payments</b><small>When something is due within 3 days or overdue.</small></span></label>
      <label class="toggle-row"><input type="checkbox" id="al-backup" ${a.backup?'checked':''}><span><b>Monthly backup reminder</b><small>If you haven’t exported a backup in 30 days.</small></span></label>
      <button class="btn btn-primary btn-sm" data-action="save-alerts" style="margin-top:8px;">Save</button>
    </div>`;
  } else if(curSettingsTab==='appearance'){
    body = `<div class="card settings-group">
      <div class="card-head"><h3 class="card-title">Install the App</h3><span class="badge-ic t-save">${icon('smartphone')}</span></div>
      <p class="small-muted" style="margin-top:-8px;margin-bottom:14px;">Add ${escapeHtml(APP_CONFIG.appName)} to your phone’s home screen so it opens full-screen like a regular app.</p>
      ${isStandalone() ? statusPill('ontrack','Installed on this device') : `<button class="btn btn-primary btn-sm" data-action="install-app">${icon('download','ic-sm')}Install app</button>`}
    </div>
    <div class="card settings-group">
      <div class="card-head"><h3 class="card-title">Theme</h3></div>
      <div class="segmented" role="radiogroup" aria-label="Theme">
        ${[['system','monitor','System'],['light','sun','Light'],['dark','moon','Dark']].map(([v,ic,l])=>`<button type="button" role="radio" aria-checked="${getThemePref()===v}" class="${getThemePref()===v?'active':''}" data-action="set-theme" data-theme="${v}">${icon(ic,'ic-sm')}${l}</button>`).join('')}
      </div>
      <p class="help-text">System follows your device’s light or dark setting. This choice is saved on this device only.</p>
    </div>`;
  } else if(curSettingsTab==='data'){
    body = `<div class="card settings-group">
      <div class="card-head"><h3 class="card-title">Your Data</h3></div>
      <div class="action-list">
        <div><span class="badge-ic t-nec">${icon('download')}</span><div><b>Export a backup</b><small>Download everything as a .json file.</small></div><button class="btn btn-sm" data-action="export-data">Export</button></div>
        <div><span class="badge-ic t-extra">${icon('sheet')}</span><div><b>Download a spreadsheet</b><small>Every transaction as a CSV file for Excel or Google Sheets.</small></div><span class="btn-row"><button class="btn btn-sm" data-action="export-csv" data-year="${cur.year}">${cur.year}</button><button class="btn btn-sm" data-action="export-csv" data-year="">All time</button></span></div>
        <div><span class="badge-ic t-save">${icon('upload')}</span><div><b>Import a backup</b><small>Replace your current data with a backup file.</small></div><label class="btn btn-sm" style="cursor:pointer;">Import<input type="file" id="importFile" accept="application/json" style="display:none;"></label></div>
        <div><span class="badge-ic t-warn">${icon('rotate-ccw')}</span><div><b>Reset ${MONTH_NAMES[cur.monthIndex]} ${cur.year}</b><small>Clear this month’s income, expenses, and savings.</small></div><button class="btn btn-sm btn-danger" data-action="reset-month">Reset month</button></div>
        <div><span class="badge-ic t-rose">${icon('trash-2')}</span><div><b>Reset all data</b><small>Start over. Your household, people, and currency are kept.</small></div><button class="btn btn-sm btn-danger" data-action="reset-all">Reset all</button></div>
      </div>
    </div>
    ${window.Store ? Store.accountSettingsHtml() : ''}`;
  } else {
    body = `
      <div class="card settings-group">
        <div class="card-head"><h3 class="card-title">Household Profile</h3></div>
        <div class="field-row">
          <div class="field"><label>Household name</label><input type="text" id="householdName" maxlength="60" value="${escapeHtml(s.householdName||'')}" placeholder="My Household"><div class="help-text">Shown in the sidebar.</div></div>
          <div class="field"><label>Currency</label><select id="currencySelect">${currencyOptionsHtml(s.currency)}</select></div>
        </div>
        <button class="btn btn-primary btn-sm" data-action="save-household">Save</button>
      </div>
      <div class="card settings-group">
        <div class="card-head"><h3 class="card-title">People &amp; Paydays</h3><button class="card-chip" data-action="add-earner">${icon('plus','ic-sm')}Add Person</button></div>
        <p class="small-muted" style="margin-top:-8px;margin-bottom:12px;">Everyone who brings in income. Their paydays appear on the dashboard and calendar.</p>
        ${earners().length ? `<div class="tbl-wrap"><table class="tbl">
          <thead><tr><th>Name</th><th>Pay schedule</th><th style="width:40px;"></th></tr></thead>
          <tbody>${earners().map(e=>`<tr><td>${personChip(e.id)}</td><td class="muted-cell">${escapeHtml(payScheduleLabel(e.schedule))}</td><td>${kebab('earner',{id:e.id})}</td></tr>`).join('')}</tbody>
        </table></div>` : emptyNote('users','save','No one added yet.')}
      </div>`;
  }
  return `
    ${pageHead('Settings', '', '')}
    ${pillTabs('settings', SETTINGS_TABS, curSettingsTab)}
    ${body}
  `;
}
function currencyOptionsHtml(selected){
  return CURRENCIES.map(([code,name])=>`<option value="${code}" ${code===selected?'selected':''}>${name} (${code})</option>`).join('');
}
function budgetDefaultsTable(sec, label){
  const key = monthKey(cur.year, cur.monthIndex);
  const m = getMonth(key, true);
  const tone = SECTION_TONE[sec];
  const rows = [];
  getCategoryTree(sec).forEach(main=>{
    if(main.subs.length){
      main.subs.forEach(sub=> rows.push({name:sub.name, parent:main.name, main:main.name, sub:sub.name, inactive:!isCategoryActiveForMonth(sub,key),
        def:getCategoryDefault(sec, main.name, sub.name), thisMonth:getCategoryBudget(m, sec, main.name, sub.name)}));
    } else {
      rows.push({name:main.name, main:main.name, sub:null, inactive:!isCategoryActiveForMonth(main,key),
        def:getCategoryDefault(sec, main.name, null), thisMonth:getCategoryBudget(m, sec, main.name, null)});
    }
  });
  return `<div class="card settings-group">
    <div class="card-head"><h3 class="card-title" style="display:flex;align-items:center;gap:10px;"><span class="badge-ic t-${tone}">${icon(BUCKETS[sec].icon)}</span>${label}</h3>
      <button class="card-chip" data-action="manage-categories" data-section="${sec}">${icon('tags','ic-sm')}Manage Categories</button></div>
    ${rows.length ? `<div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>Category</th><th class="num">Default budget</th><th class="num">${MONTH_NAMES[cur.monthIndex].slice(0,3)} budget</th><th style="width:40px;"></th></tr></thead>
      <tbody>${rows.map(r=>`<tr>
        <td><span class="cat-name"><span class="badge-ic xs t-${catTone(sec, r.main, r.sub)}">${icon(catIconFor(sec, r.main, r.sub))}</span><span>${escapeHtml(r.name)}${r.parent?` <small>in ${escapeHtml(r.parent)}</small>`:''}${r.inactive?' <span class="pill danger">hidden</span>':''}</span></span></td>
        <td class="num"><b>${money(r.def)}</b></td>
        <td class="num">${money(r.thisMonth)}</td>
        <td><button class="icon-btn" data-action="edit-default-budget" data-section="${sec}" data-main="${escapeHtml(r.main)}" data-sub="${r.sub?escapeHtml(r.sub):''}" title="Change default budget">${icon('pencil')}</button></td>
      </tr>`).join('')}</tbody>
    </table></div>` : emptyNote('tags', tone, 'No categories yet.')}
    <p class="help-text" style="margin-top:10px;">Defaults carry into every new month. When you change one, you choose whether it applies to this month, future months, or both.</p>
  </div>`;
}


/* =========================================================
   EVENT HANDLERS
========================================================= */
function attachViewHandlers(key){
  const main = document.getElementById('mainContent');
  main.onclick = (e)=>{
    const tab = e.target.closest('[data-debt-tab]');
    if(tab){ curDebtTab = tab.dataset.debtTab; curDebtDetailId = null; renderAll(); return; }
    const t = e.target.closest('[data-action]');
    if(!t) return;
    const action = t.dataset.action;
    handleAction(action, t, key);
  };
  const expCat = document.getElementById('expCatFilter');
  if(expCat) expCat.addEventListener('change', (e)=>{ curExpenseCatFilter = e.target.value; renderAll(); });
  const expSearch = document.getElementById('expSearch');
  if(expSearch) expSearch.addEventListener('input', (e)=>{
    curExpenseSearch = e.target.value; const pos = e.target.selectionStart; renderAll();
    const el2 = document.getElementById('expSearch'); if(el2){ el2.focus(); el2.setSelectionRange(pos,pos); }
  });
  const calEv = document.getElementById('calEventFilter');
  if(calEv) calEv.addEventListener('change', (e)=>{ curCalEventFilter = e.target.value; renderAll(); });
  const dashCat = document.getElementById('dashCatFilter');
  if(dashCat) dashCat.addEventListener('change', (e)=>{ curDashCatFilter = e.target.value; renderAll(); });
  const annualSel = document.getElementById('annualYearSelect');
  if(annualSel) annualSel.addEventListener('change', (e)=>{ curYearForAnnual = Number(e.target.value); renderAll(); });
  const importFile = document.getElementById('importFile');
  if(importFile) importFile.addEventListener('change', handleImport);
  const debtSearch = document.getElementById('debtSearchInput');
  if(debtSearch) debtSearch.addEventListener('input', (e)=>{
    curDebtSearch = e.target.value;
    const pos = e.target.selectionStart;
    renderAll();
    const el2 = document.getElementById('debtSearchInput');
    if(el2){ el2.focus(); el2.setSelectionRange(pos,pos); }
  });
  const debtTypeFilter = document.getElementById('debtTypeFilter');
  if(debtTypeFilter) debtTypeFilter.addEventListener('change', (e)=>{ curDebtTypeFilter = e.target.value; renderAll(); });
  const debtStatusFilter = document.getElementById('debtStatusFilter');
  if(debtStatusFilter) debtStatusFilter.addEventListener('change', (e)=>{ curDebtStatusFilter = e.target.value; renderAll(); });
  main.querySelectorAll('[data-cal-filter]').forEach(cb=>{
    cb.addEventListener('change', (e)=>{ curCalFilters[e.target.dataset.calFilter] = e.target.checked; renderAll(); });
  });
  const showCompletedCb = main.querySelector('[data-show-completed-debts]');
  if(showCompletedCb) showCompletedCb.addEventListener('change', (e)=>{ curShowCompletedDebts = e.target.checked; renderAll(); });
  const showDeactivatedGoalsCb = main.querySelector('[data-show-deactivated-goals]');
  if(showDeactivatedGoalsCb) showDeactivatedGoalsCb.addEventListener('change', (e)=>{ curShowDeactivatedGoals = e.target.checked; renderAll(); });
}

function handleAction(action, el, key){
  const m = getMonth(key,true);
  if(action==='add-income') return openIncomeModal(key, null);
  if(action==='edit-income') return openIncomeModal(key, el.dataset.id);
  if(action==='delete-income'){
    const idx = m.income.findIndex(i=>i.id===el.dataset.id); if(idx<0) return;
    const item = m.income[idx];
    return deleteWithUndo('Income deleted', ()=>m.income.splice(idx,1), ()=>m.income.splice(idx,0,item));
  }

  if(action==='add-expense') return openExpenseModal(key, el.dataset.section, null);
  if(action==='edit-expense') return openExpenseModal(key, el.dataset.section, el.dataset.id);
  if(action==='delete-expense'){
    const list = m[el.dataset.section].expenses;
    const idx = list.findIndex(x=>x.id===el.dataset.id); if(idx<0) return;
    const item = list[idx];
    return deleteWithUndo('Expense deleted', ()=>list.splice(idx,1), ()=>list.splice(idx,0,item));
  }

  if(action==='manage-categories') return openCategoriesModal(key, el.dataset.section);
  if(action==='edit-this-month-budget') return openThisMonthBudgetModal(key, el.dataset.section, el.dataset.main, el.dataset.sub||null);
  if(action==='filter-exp-cat'){
    curExpenseCatFilter = el.dataset.main;
    renderAll();
    const f = document.getElementById('expCatFilter'); if(f) f.scrollIntoView({behavior:'smooth', block:'center'});
    return;
  }
  if(action==='toggle-category-collapse'){
    const collapseKey = `${el.dataset.section}|${el.dataset.main}`;
    curExpandedCats[collapseKey] = !curExpandedCats[collapseKey];
    renderAll();
    return;
  }
  if(action==='edit-default-budget') return openDefaultBudgetModal(el.dataset.section, el.dataset.main, el.dataset.sub||null);

  if(action==='add-goal') return openGoalModal(null);
  if(action==='edit-goal') return openGoalModal(el.dataset.id);
  if(action==='delete-goal') return handleDeleteGoal(el.dataset.id);
  if(action==='toggle-goal-active'){
    const goal = state.settings.savingsGoals.find(g=>g.id===el.dataset.id);
    if(goal){ goal.active = !goal.active; saveState(); renderAll(); }
    return;
  }
  if(action==='record-savings') return openRecordSavingsModal(key, el.dataset.id);
  if(action==='edit-savings-amount') return openSavingsAmountModal(key);
  if(action==='edit-goal-alloc') return openGoalAllocModal(key, el.dataset.id);

  if(action==='decide-rollover') return openRolloverModal(el.dataset.monthkey, el.dataset.section);

  if(action==='add-debt') return openDebtModal(null);
  if(action==='edit-debt') return openDebtModal(el.dataset.id);
  if(action==='delete-debt') return confirmModal('Delete this debt and its entire payment history?', ()=>{
    state.debts = state.debts.filter(d=>d.id!==el.dataset.id);
    if(curDebtDetailId===el.dataset.id) curDebtDetailId = null;
    saveState(); renderAll();
  });
  if(action==='view-debt'){ curDebtDetailId = el.dataset.id; renderAll(); return; }
  if(action==='back-to-debts'){ curDebtDetailId = null; renderAll(); return; }
  if(action==='record-debt-payment') return openDebtPaymentModal(el.dataset.id, null);
  if(action==='edit-debt-payment') return openDebtPaymentModal(el.dataset.debtid, el.dataset.id);
  if(action==='delete-debt-payment'){
    const d = state.debts.find(x=>x.id===el.dataset.debtid); if(!d) return;
    const idx = d.payments.findIndex(p=>p.id===el.dataset.id); if(idx<0) return;
    const item = d.payments[idx];
    return deleteWithUndo('Payment deleted', ()=>d.payments.splice(idx,1), ()=>d.payments.splice(idx,0,item));
  }


  if(action==='manage-recurring') return openRecurringManageModal();
  if(action==='edit-recurring') return openRecurringModal(el.dataset.id);
  if(action==='delete-recurring') return confirmModal('Delete this recurring expense? Any expenses you already logged from it stay untouched.', ()=>{
    state.recurringBills = state.recurringBills.filter(b=>b.id!==el.dataset.id); saveState(); renderAll();
  });
  if(action==='toggle-recurring-active'){
    const rec = state.recurringBills.find(b=>b.id===el.dataset.id);
    if(rec){ rec.active = !rec.active; saveState(); renderAll(); }
    return;
  }
  if(action==='pay-recurring'){
    const rec = state.recurringBills.find(b=>b.id===el.dataset.id);
    if(!rec) return;
    const due = el.dataset.due;
    const dueMonthKey = due.slice(0,7);
    // Switch to the bill's due month so the recorded payment is immediately visible wherever you look next.
    cur.year = Number(dueMonthKey.split('-')[0]);
    cur.monthIndex = Number(dueMonthKey.split('-')[1])-1;
    return openExpenseModal(dueMonthKey, rec.section, null, {
      mainCategory: rec.mainCategory, subCategory: rec.subCategory,
      description: rec.name, amount: rec.expectedAmount, date: due,
      recurringId: rec.id, recurringDueDate: due
    });
  }

  if(action==='save-notes'){ m.notes = document.getElementById('monthNotes').value; saveState(); toast('Note saved'); return; }
  if(action==='customize-dashboard') return openDashboardCustomizeModal();
  if(action==='set-money-view'){ curDashboardMoneyView = el.dataset.view; renderAll(); return; }

  if(action==='save-allocations'){
    const nec=Number(document.getElementById('allocNec').value)||0;
    const sav=Number(document.getElementById('allocSav').value)||0;
    const ext=Number(document.getElementById('allocExt').value)||0;
    const play=Number(document.getElementById('allocPlay').value)||0;
    if(nec+sav+ext+play !== 100){ alertDialog('Allocations must add up to 100%', 'They currently add up to '+(nec+sav+ext+play)+'%.'); return; }
    state.settings.allocations = {necessities:nec, savings:sav, extra:ext, playjar:play};
    saveState(); renderAll(); toast('Allocation saved');
    return;
  }
  if(action==='save-household'){
    state.settings.householdName = document.getElementById('householdName').value.trim();
    state.settings.currency = document.getElementById('currencySelect').value;
    saveState(); renderAll(); toast('Saved'); return;
  }
  if(action==='set-theme') return setThemePref(el.dataset.theme);
  if(action==='add-recurring-income') return openRecurringIncomeModal(null);
  if(action==='edit-recurring-income') return openRecurringIncomeModal(el.dataset.id);
  if(action==='toggle-recurring-income'){ const r = recurringIncomeList().find(x=>x.id===el.dataset.id); if(r){ r.active = !r.active; saveState(); renderAll(); } return; }
  if(action==='delete-recurring-income'){
    const list = recurringIncomeList(); const idx = list.findIndex(x=>x.id===el.dataset.id); if(idx<0) return;
    const item = list[idx];
    return deleteWithUndo('Recurring income deleted', ()=>list.splice(idx,1), ()=>list.splice(idx,0,item));
  }
  if(action==='record-recurring-income'){
    const r = recurringIncomeList().find(x=>x.id===el.dataset.id); if(!r || !el.dataset.due) return;
    return openIncomeModal(el.dataset.due.slice(0,7), null, {title:`Record ${r.name}`, person:r.person, date:el.dataset.due, amount:r.amount, description:r.name, recurringIncomeId:r.id, recurringDueDate:el.dataset.due});
  }
  if(action==='record-expected'){
    const ds = el.dataset;
    return openIncomeModal(ds.date.slice(0,7), null, {title:`Record ${ds.label}`, person:ds.person, date:ds.date, amount:ds.amount, description: ds.recid ? ds.label : 'Salary', recurringIncomeId: ds.recid||undefined, recurringDueDate: ds.recid ? ds.date : undefined});
  }
  if(action==='export-csv') return exportCSV(el.dataset.year ? Number(el.dataset.year) : null);
  if(action==='export-menu') return openExportMenu(el, curYearForAnnual);
  if(action==='install-app') return installApp();
  if(action==='save-alerts'){
    const a = alertSettings();
    a.enabled = document.getElementById('al-enabled').checked;
    a.warnAt = Math.min(100, Math.max(50, Number(document.getElementById('al-warn').value)||80));
    a.bills = document.getElementById('al-bills').checked;
    a.backup = document.getElementById('al-backup').checked;
    saveState(); renderAll(); toast('Alert settings saved'); return;
  }
  if(action==='goto') return navTo(el.dataset.view);
  if(action==='goto-today'){ cur.year = today.getFullYear(); cur.monthIndex = today.getMonth(); renderAll(); return; }
  if(action==='set-tab'){
    const k = el.dataset.tabKind, t = el.dataset.tab;
    if(k==='debt'){ curDebtTab = t; curDebtDetailId = null; }
    else if(k==='report') curReportTab = t;
    else if(k==='settings') curSettingsTab = t;
    renderAll(); return;
  }
  if(action==='row-menu') return openMenu(el, rowMenuItems(el.dataset, key));
  if(action==='add-earner') return openEarnerModal(null);
  if(action==='edit-earner') return openEarnerModal(el.dataset.id);
  if(action==='delete-earner'){
    const e = earnerById(el.dataset.id);
    if(!e) return;
    const hasIncome = Object.values(state.months).some(mm=>(mm.income||[]).some(i=>i.person===e.id));
    if(hasIncome){ alertDialog(`Can't remove ${e.name}`, 'They have recorded income, and removing them would lose that history. You can rename them or set their schedule to "No fixed schedule" instead.'); return; }
    return confirmModal(`Remove ${e.name}?`, ()=>{
      state.settings.earners = earners().filter(x=>x.id!==e.id); saveState(); renderAll();
    });
  }
  if(action==='export-data') return exportData();
  if(action==='reset-month') return confirmModal('Reset all data for '+MONTH_NAMES[cur.monthIndex]+' '+cur.year+'? This cannot be undone.', ()=>{
    state.months[key] = defaultMonth(); saveState(); renderAll();
  });
  if(action==='reset-all') return confirmModal('Reset ALL data across every month? Your household, people, and currency are kept. This cannot be undone.', ()=>{
    const keep = state.settings;
    state = defaultState();
    Object.assign(state.settings, {householdName:keep.householdName, currency:keep.currency, earners:keep.earners, onboarded:true});
    saveState(); renderAll();
  });
  if(window.Store && Store.handleAction(action, el)) return;
}

/* ⋮ menus on table rows. Each item re-dispatches an existing action with the row's data. */
function rowMenuItems(ds, key){
  const run = (action, extra)=>()=>handleAction(action, {dataset:Object.assign({}, ds, extra||{})}, key);
  const edit = (a)=>({label:'Edit', icon:'pencil', onClick:run(a)});
  const del = (a)=>({label:'Delete', icon:'trash-2', tone:'danger', onClick:run(a)});
  switch(ds.kind){
    case 'income': return [edit('edit-income'), del('delete-income')];
    case 'expense': return [edit('edit-expense'), del('delete-expense')];
    case 'payment': return [edit('edit-debt-payment'), del('delete-debt-payment')];
    case 'earner': return [edit('edit-earner'), {label:'Remove', icon:'trash-2', tone:'danger', onClick:run('delete-earner')}];
    case 'debt': return [
      {label:'Record payment', icon:'hand-coins', tone:'c-nec', onClick:run('record-debt-payment')},
      {label:'View details', icon:'eye', onClick:run('view-debt')},
      edit('edit-debt'), del('delete-debt')];
    case 'goal': {
      const g = state.settings.savingsGoals.find(x=>x.id===ds.id) || {};
      return [
        {label:'Record savings', icon:'hand-coins', tone:'c-nec', onClick:run('record-savings')},
        {label:'Change this month’s %', icon:'percent', onClick:run('edit-goal-alloc')},
        edit('edit-goal'),
        {label:g.active?'Hide goal':'Show goal', icon:g.active?'eye-off':'eye', onClick:run('toggle-goal-active')},
        del('delete-goal')];
    }
    case 'recincome': {
      const r = recurringIncomeList().find(x=>x.id===ds.id) || {};
      const items = [];
      if(ds.due) items.push({label:`Record (${fmtDateHuman(ds.due)})`, icon:'hand-coins', tone:'c-nec', onClick:run('record-recurring-income')});
      items.push(edit('edit-recurring-income'));
      items.push({label:r.active?'Pause':'Resume', icon:r.active?'pause':'play', onClick:run('toggle-recurring-income')});
      items.push(del('delete-recurring-income'));
      return items;
    }
    case 'recurring': {
      const r = state.recurringBills.find(x=>x.id===ds.id) || {};
      const items = [];
      if(ds.due) items.push({label:`Record payment (${fmtDateHuman(ds.due)})`, icon:'hand-coins', tone:'c-nec', onClick:run('pay-recurring')});
      items.push(edit('edit-recurring'));
      items.push({label:r.active?'Pause':'Resume', icon:r.active?'pause':'play', onClick:run('toggle-recurring-active')});
      items.push(del('delete-recurring'));
      return items;
    }
  }
  return [];
}

/* ---------- Earner (person + pay schedule) editor ---------- */
function earnerFieldsHtml(e, idx){
  const sch = (e && e.schedule) || {type:'biweekly'};
  const days = sch.days || [15,30];
  const p = `ef${idx}-`;
  const show = (types)=> types.includes(sch.type) ? '' : 'display:none;';
  return `<div class="earner-fields" data-idx="${idx}">
    <div class="field-row">
      <div class="field"><label>Name</label><input type="text" id="${p}name" maxlength="40" value="${escapeHtml(e?e.name:'')}" placeholder="Me, Alex"></div>
      <div class="field"><label>Gets paid</label><select id="${p}type" data-earner-type="${idx}">
        ${PAY_SCHEDULE_TYPES.map(([v,l])=>`<option value="${v}" ${sch.type===v?'selected':''}>${l}</option>`).join('')}
      </select></div>
    </div>
    <div class="field" data-show-for="biweekly weekly" style="${show(['biweekly','weekly'])}"><label>A recent payday</label>
      <input type="date" id="${p}anchor" value="${sch.anchor||toISO(today)}"><div class="help-text">Future paydays are counted forward from this date.</div></div>
    <div class="field-row" data-show-for="semimonthly" style="${show(['semimonthly'])}">
      <div class="field"><label>First payday (day of month)</label><input type="number" min="1" max="31" id="${p}d1" value="${days[0]||15}"></div>
      <div class="field"><label>Second payday (day of month)</label><input type="number" min="1" max="31" id="${p}d2" value="${days[1]||30}"></div>
    </div>
    <div class="field" data-show-for="monthly" style="${show(['monthly'])}"><label>Payday (day of month)</label>
      <input type="number" min="1" max="31" id="${p}day" value="${sch.day||30}"><div class="help-text">If the month is shorter, the last day of the month is used.</div></div>
    <div class="field" data-show-for="biweekly weekly semimonthly monthly" style="${show(['biweekly','weekly','semimonthly','monthly'])}"><label>Usual pay per payday (optional)</label>
      ${moneyInputHtml(`${p}pay`, e && e.payAmount ? e.payAmount : '', '0.00')}
      <div class="help-text">Used as the expected amount on upcoming paydays, and pre-filled when you record one.</div></div>
  </div>`;
}
function wireEarnerFields(root){
  root.querySelectorAll('[data-earner-type]').forEach(sel=>{
    if(sel.dataset.wired) return; sel.dataset.wired = '1';
    sel.addEventListener('change', ()=>{
      const wrap = sel.closest('.earner-fields');
      wrap.querySelectorAll('[data-show-for]').forEach(f=>{ f.style.display = f.dataset.showFor.split(' ').includes(sel.value) ? '' : 'none'; });
    });
  });
}
/* Returns {name, schedule, payAmount} or a string error message */
function readEarnerFields(idx){
  const p = `ef${idx}-`;
  const name = document.getElementById(p+'name').value.trim();
  const type = document.getElementById(p+'type').value;
  if(!name) return 'Enter a name.';
  const clampDay = v=> Math.min(31, Math.max(1, Math.round(Number(v)||1)));
  let schedule = {type};
  if(type==='biweekly' || type==='weekly'){
    const anchor = document.getElementById(p+'anchor').value;
    if(!anchor) return `Pick a recent payday for ${name}.`;
    schedule.anchor = anchor;
  } else if(type==='semimonthly'){
    schedule.days = [clampDay(document.getElementById(p+'d1').value), clampDay(document.getElementById(p+'d2').value)].sort((a,b)=>a-b);
  } else if(type==='monthly'){
    schedule.day = clampDay(document.getElementById(p+'day').value);
  }
  const payAmount = Number(document.getElementById(p+'pay').value) || null;
  return {name, schedule, payAmount: type==='none' ? null : payAmount};
}
function openEarnerModal(id, afterSave, introText){
  const existing = id ? earnerById(id) : null;
  openModal(existing ? 'Edit person' : 'Add person',
    (introText?`<p class="small-muted" style="margin-top:-6px;">${escapeHtml(introText)}</p>`:'') + earnerFieldsHtml(existing, 0),
    ()=>{
      const r = readEarnerFields(0);
      if(typeof r==='string'){ showFormError(r); return false; }
      if(earners().some(e=>e.name.toLowerCase()===r.name.toLowerCase() && e!==existing)){ showFormError('Someone with that name already exists.'); return false; }
      if(existing) Object.assign(existing, r);
      else state.settings.earners.push({id:uid('earner'), ...r});
      saveState(); renderAll();
      if(afterSave) setTimeout(afterSave, 0);
      return true;
    });
  wireEarnerFields(document.getElementById('modalBody'));
}

/* =========================================================
   FIRST-RUN SETUP (full screen, 4 steps)
========================================================= */
function openOnboardingModal(){
  const root = document.getElementById('onboardRoot');
  const draft = {
    householdName: state.settings.householdName || '',
    currency: state.settings.currency || 'PHP',
    earners: earners().length ? JSON.parse(JSON.stringify(earners())) : [{name:'Me', schedule:{type:'semimonthly', days:[15,30]}}],
    allocations: Object.assign({}, state.settings.allocations)
  };
  let step = 0;
  const STEPS = ['Welcome', 'Income', 'Budget', 'Done'];
  const PRESETS = [
    {label:'Balanced', a:{necessities:50, savings:30, extra:10, playjar:10}},
    {label:'Saver', a:{necessities:50, savings:35, extra:10, playjar:5}},
    {label:'Classic 50/30/20', a:{necessities:50, savings:20, extra:20, playjar:10}}
  ];
  function captureStep(){
    if(step===0){
      draft.householdName = document.getElementById('ob-household').value.trim();
      draft.currency = document.getElementById('ob-currency').value;
    } else if(step===1){
      const list = [];
      for(let i=0;i<draft.earners.length;i++){
        const r = readEarnerFields(i);
        if(typeof r==='string') return r;
        list.push(Object.assign({id: draft.earners[i].id || uid('earner')}, r));
      }
      if(!list.length) return 'Add at least one person.';
      draft.earners = list;
    } else if(step===2){
      const a = {};
      ['necessities','savings','extra','playjar'].forEach(k=> a[k] = Number(document.getElementById('ob-a-'+k).value)||0);
      const total = a.necessities+a.savings+a.extra+a.playjar;
      if(total!==100) return `Your split adds up to ${total}% — it needs to total 100%.`;
      draft.allocations = a;
    }
    return null;
  }
  function stepHtml(){
    if(step===0) return `
      <span class="badge-ic lg t-nec">${icon('sprout')}</span>
      <h2>Welcome to ${escapeHtml(APP_CONFIG.appName)}</h2>
      <p class="ob-sub">A calm, simple way to plan your money each month. Let’s set up the basics — it takes about a minute, and you can change anything later.</p>
      <div class="field"><label>What should we call your household?</label><input type="text" id="ob-household" maxlength="60" value="${escapeHtml(draft.householdName)}" placeholder="My Household"></div>
      <div class="field"><label>Currency</label><select id="ob-currency">${currencyOptionsHtml(draft.currency)}</select></div>`;
    if(step===1) return `
      <span class="badge-ic lg t-save">${icon('users')}</span>
      <h2>Who brings in income?</h2>
      <p class="ob-sub">Add yourself, plus a partner or anyone whose pay you budget with. Their paydays will show up on your calendar.</p>
      <div id="ob-earners">${draft.earners.map((e,i)=>`<div class="ob-person">${draft.earners.length>1?`<button type="button" class="icon-btn danger ob-remove" data-remove="${i}" aria-label="Remove">${icon('x','ic-sm')}</button>`:''}${earnerFieldsHtml(e, i)}</div>`).join('')}</div>
      <button type="button" class="btn btn-sm" id="ob-add-earner">${icon('plus','ic-sm')}Add another person</button>`;
    if(step===2) return `
      <span class="badge-ic lg t-play">${icon('chart-pie')}</span>
      <h2>How should your income be split?</h2>
      <p class="ob-sub">Each month, income after debt payments is divided into four buckets. Pick a starting point — you can fine-tune it anytime.</p>
      <div class="ob-presets">${PRESETS.map((p,i)=>`<button type="button" class="card-chip" data-preset="${i}">${p.label}</button>`).join('')}</div>
      <div class="ob-alloc">${['necessities','savings','extra','playjar'].map(k=>`
        <label class="ob-alloc-row"><span class="badge-ic sm t-${BUCKETS[k].tone}">${icon(BUCKETS[k].icon)}</span><span class="ob-alloc-name">${BUCKETS[k].label.replace(' Target','')}</span>
          <span class="ob-pct"><input type="number" id="ob-a-${k}" min="0" max="100" value="${draft.allocations[k]}">%</span></label>`).join('')}
        <div class="ob-total" id="ob-total"></div>
      </div>`;
    return `
      <span class="badge-ic lg t-nec">${icon('party-popper')}</span>
      <h2>You’re all set${draft.householdName?`, ${escapeHtml(draft.householdName)}`:''}!</h2>
      <p class="ob-sub">Here’s what happens next:</p>
      <div class="ob-next">
        <div><span class="badge-ic sm t-save">${icon('banknote')}</span><span><b>Record your income</b><small>Use the + Add button whenever you get paid.</small></span></div>
        <div><span class="badge-ic sm t-extra">${icon('receipt')}</span><span><b>Log your spending</b><small>Necessities, extras, and your play jar each get a budget.</small></span></div>
        <div><span class="badge-ic sm t-play">${icon('bell')}</span><span><b>Watch for alerts</b><small>We’ll nudge you when a budget runs low or a bill is due.</small></span></div>
      </div>`;
  }
  function render(error){
    root.innerHTML = `<div class="onboard">
      <aside class="ob-side">
        <div class="brand">${brandLogoSVG()}<div class="brand-text"><div class="brand-name">${escapeHtml(APP_CONFIG.appName)}</div></div></div>
        <ol class="ob-steps">${STEPS.map((s,i)=>`<li class="${i===step?'active':''} ${i<step?'done':''}"><span>${i<step?icon('check','ic-sm'):i+1}</span>${s}</li>`).join('')}</ol>
      </aside>
      <main class="ob-main">
        <div class="ob-card card">
          <div class="ob-progress"><span style="width:${(step+1)/STEPS.length*100}%"></span></div>
          <form id="ob-form" novalidate>${stepHtml()}</form>
          ${error?`<div class="warn-text">${escapeHtml(error)}</div>`:''}
          <div class="ob-actions">
            ${step>0 && step<3 ? `<button type="button" class="btn btn-ghost" id="ob-back">${icon('arrow-left','ic-sm')}Back</button>` : '<span></span>'}
            <button type="button" class="btn btn-primary" id="ob-next">${step===3?'Start budgeting':step===2?'Finish':'Continue'}${icon('arrow-right','ic-sm')}</button>
          </div>
        </div>
      </main>
    </div>`;
    root.hidden = false;
    const form = document.getElementById('ob-form');
    enhanceForm(form); wireEarnerFields(form);
    form.addEventListener('submit', e=>{ e.preventDefault(); next(); });
    document.getElementById('ob-next').addEventListener('click', next);
    const back = document.getElementById('ob-back');
    if(back) back.addEventListener('click', ()=>{ captureStep(); step--; render(); });
    const add = document.getElementById('ob-add-earner');
    if(add) add.addEventListener('click', ()=>{ const err = captureStepLoose(); draft.earners.push({name:'', schedule:{type:'semimonthly', days:[15,30]}}); render(err); });
    root.querySelectorAll('[data-remove]').forEach(b=> b.addEventListener('click', ()=>{ captureStepLoose(); draft.earners.splice(Number(b.dataset.remove),1); render(); }));
    root.querySelectorAll('[data-preset]').forEach(b=> b.addEventListener('click', ()=>{ draft.allocations = Object.assign({}, PRESETS[Number(b.dataset.preset)].a); render(); }));
    const updateTotal = ()=>{
      const el = document.getElementById('ob-total'); if(!el) return;
      const t = ['necessities','savings','extra','playjar'].reduce((a,k)=>a+(Number(document.getElementById('ob-a-'+k).value)||0),0);
      el.innerHTML = `Total <b class="${t===100?'pos':'neg'}">${t}%</b>${t===100?'':' — needs to be 100%'}`;
    };
    root.querySelectorAll('.ob-alloc input').forEach(i=> i.addEventListener('input', updateTotal)); updateTotal();
    const first = form.querySelector('input:not([type=hidden])');
    if(first && window.matchMedia('(min-width:901px)').matches) setTimeout(()=>first.focus(), 40);
  }
  // Keep whatever was typed for people even if incomplete (used before adding/removing rows).
  function captureStepLoose(){
    if(step!==1) return null;
    draft.earners = draft.earners.map((e,i)=>{
      const nameEl = document.getElementById(`ef${i}-name`); if(!nameEl) return e;
      const r = readEarnerFields(i);
      return typeof r==='string' ? Object.assign({}, e, {name:nameEl.value}) : Object.assign({id:e.id}, r);
    });
    return null;
  }
  function next(){
    const err = captureStep();
    if(err) return render(err);
    if(step<3){ step++; return render(); }
    Object.assign(state.settings, {householdName:draft.householdName, currency:draft.currency, allocations:draft.allocations, onboarded:true});
    state.settings.earners = draft.earners.map(e=>Object.assign({id:e.id||uid('earner')}, e));
    saveState();
    root.hidden = true; root.innerHTML = '';
    renderAll(); toast('Welcome aboard!');
  }
  render();
}

/* =========================================================
   INCOME — manual entries, recurring income, expected paydays
========================================================= */
function openIncomeModal(key, id, prefill){
  prefill = prefill || {};
  const m = getMonth(key,true);
  const existing = id ? m.income.find(i=>i.id===id) : null;
  if(!earners().length){
    return openEarnerModal(null, ()=>openIncomeModal(key, id, prefill), 'Add yourself (or whoever earns this income) first.');
  }
  const person = existing ? existing.person : (prefill.person || earners()[0].id);
  const body = `
    <div class="field"><label>Person</label>
      <select id="f-person">${earners().map(e=>`<option value="${escapeHtml(e.id)}" ${person===e.id?'selected':''}>${escapeHtml(e.name)}</option>`).join('')}</select>
    </div>
    <div class="field"><label>Date received</label><input type="date" id="f-date" value="${existing?existing.date:(prefill.date||toISO(today))}"></div>
    <div class="field"><label>Amount (${currencySymbol()})</label><input type="number" id="f-amount" step="0.01" min="0" value="${existing?existing.amount:(prefill.amount||'')}" placeholder="0.00"></div>
    <div class="field"><label>Source (optional)</label><input type="text" id="f-desc" value="${escapeHtml(existing?(existing.description||''):(prefill.description||''))}" placeholder="Salary"></div>
    <div id="f-error" class="warn-text" style="display:none;"></div>
  `;
  openModal(existing?'Edit income':(prefill.title||'Add income'), body, ()=>{
    const personV = document.getElementById('f-person').value;
    const date = document.getElementById('f-date').value;
    const amount = Number(document.getElementById('f-amount').value);
    const description = document.getElementById('f-desc').value;
    if(!date || !amount || amount<=0){ showFormError('Enter a valid date and amount.'); return false; }
    if(existing){ Object.assign(existing, {date, person:personV, amount, description}); }
    else {
      // File new income under the month it was received in.
      const target = getMonth(date.slice(0,7), true);
      const rec = {id:uid('inc'), date, person:personV, amount, description};
      if(prefill.recurringIncomeId){ rec.recurringIncomeId = prefill.recurringIncomeId; rec.recurringDueDate = prefill.recurringDueDate; }
      target.income.push(rec);
    }
    saveState(); renderAll(); return true;
  });
}
function expectedPayAmount(e){ return (e && e.payAmount) || lastIncomeAmount(e && e.id) || null; }
function recurringIncomeList(){ return state.recurringIncome || (state.recurringIncome = []); }
function recurringIncomeStatus(rec, dueISO){
  for(const m of Object.values(state.months)){
    const hit = (m.income||[]).find(i=> i.recurringIncomeId===rec.id && i.recurringDueDate===dueISO);
    if(hit) return {status:'Received', actual:hit.amount};
  }
  return {status: dueISO < toISO(today) ? 'Missed' : 'Expected', actual:null};
}
function nextRecurringIncomeDate(rec){
  const dates = recurringOccurrences(rec, rec.startDate, addDaysISO(toISO(today), 400));
  return dates.find(d=> recurringIncomeStatus(rec,d).status!=='Received') || null;
}
/* Everything you expect to be paid in a month: earner paydays plus recurring income. */
function expectedIncomeForMonth(key){
  const [start, end] = monthRange(key);
  const items = [];
  earners().forEach(e=>{
    paydaysInRange(e, start, end).forEach(iso=>{
      const got = findIncomeOn(e.id, iso);
      items.push({date:iso, kind:'payday', person:e.id, label:`${e.name} payday`, amount: got ? got.amount : expectedPayAmount(e),
        status: got ? 'Received' : (iso < toISO(today) ? 'Missed' : 'Expected')});
    });
  });
  recurringIncomeList().filter(r=>r.active).forEach(rec=>{
    recurringOccurrences(rec, start, end).forEach(iso=>{
      const st = recurringIncomeStatus(rec, iso);
      items.push({date:iso, kind:'recurring', recId:rec.id, person:rec.person, label:rec.name, amount: st.actual!=null ? st.actual : rec.amount, status: st.status});
    });
  });
  return items.sort((a,b)=>a.date.localeCompare(b.date));
}
function incomeStatusPill(s){
  if(s==='Received') return statusPill('ontrack','Received');
  if(s==='Missed') return statusPill('delayed','Not recorded');
  return statusPill('upcoming','Expected');
}
function expectedIncomeCard(key){
  const items = expectedIncomeForMonth(key);
  const expectedTotal = sumBy(items, i=>i.amount||0);
  const receivedTotal = sumBy(items.filter(i=>i.status==='Received'), i=>i.amount||0);
  return `<div class="card">
    <div class="card-head"><h3 class="card-title">Expected This Month</h3><span class="card-chip">${money(receivedTotal)} of ${money(expectedTotal)} received</span></div>
    ${items.length ? `<div class="list-rows">${items.map(it=>{
      const d = new Date(it.date+'T00:00:00');
      return `<div class="list-row exp-row">
        <div class="lr-date">${fmtDateHuman(it.date)}<span>${d.toLocaleDateString('en-US',{weekday:'short'})}</span></div>
        <span class="badge-ic t-${it.kind==='payday'?'save':'nec'}">${icon(it.kind==='payday'?'user':'repeat')}</span>
        <div class="lr-name">${escapeHtml(it.label)}<small>${it.kind==='recurring'?'Recurring':'Payday'} · <span class="${it.status==='Missed'?'neg':''}">${it.status==='Received'?'Received':it.status==='Missed'?'Not recorded yet':'Expected'}</span></small></div>
        <div class="lr-amt">${it.amount!=null?money(it.amount):'—'}</div>
        <div class="exp-actions">${it.status==='Received' ? incomeStatusPill(it.status) : ''}${it.status!=='Received' ? `<button class="btn btn-sm" data-action="record-expected" data-person="${escapeHtml(it.person||'')}" data-date="${it.date}" data-amount="${it.amount||''}" data-label="${escapeHtml(it.label)}" data-recid="${it.recId||''}">Record</button>` : ''}</div>
      </div>`;
    }).join('')}</div>` : emptyNote('calendar-check','save','No paydays or recurring income expected this month. Set pay schedules in Settings, or add recurring income below.')}
  </div>`;
}
function recurringIncomeCard(){
  const list = recurringIncomeList();
  return `<div class="card">
    <div class="card-head"><h3 class="card-title">Recurring Income</h3><button class="card-chip" data-action="add-recurring-income">${icon('plus','ic-sm')}Add</button></div>
    ${list.length ? `<div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>Name</th><th>Person</th><th class="num">Amount</th><th>Schedule</th><th>Status</th><th style="width:40px;"></th></tr></thead>
      <tbody>${list.map(r=>{
        const next = r.active ? nextRecurringIncomeDate(r) : null;
        return `<tr>
          <td><span class="cat-name"><span class="badge-ic xs t-nec">${icon('repeat')}</span><b>${escapeHtml(r.name)}</b></span></td>
          <td>${personChip(r.person)}</td>
          <td class="num">${money(r.amount)}</td>
          <td class="nowrap">${frequencyLabel(r)}${next?`<small style="display:block;color:var(--text-3);">Next: ${fmtDateHuman(next)}</small>`:''}</td>
          <td>${r.active ? statusPill('recurring') : statusPill('paused')}</td>
          <td>${kebab('recincome',{id:r.id, due:next||''})}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>` : emptyNote('repeat','nec','Add income that repeats on its own schedule — rent you receive, an allowance, a side gig, or a pension.')}
  </div>`;
}
function openRecurringIncomeModal(id){
  const existing = id ? recurringIncomeList().find(r=>r.id===id) : null;
  if(!earners().length) return openEarnerModal(null, ()=>openRecurringIncomeModal(id), 'Add the person who receives this income first.');
  const f = existing ? existing.frequency : 'monthly';
  const body = `
    <div class="field"><label>Name</label><input type="text" id="f-name" value="${existing?escapeHtml(existing.name):''}" placeholder="Rental income"></div>
    <div class="field-row">
      <div class="field"><label>Received by</label><select id="f-person">${earners().map(e=>`<option value="${escapeHtml(e.id)}" ${existing&&existing.person===e.id?'selected':''}>${escapeHtml(e.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Amount (${currencySymbol()})</label><input type="number" id="f-amount" min="0" step="0.01" value="${existing?existing.amount:''}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>How often</label><select id="f-freq">${Object.entries(FREQUENCY_DEFS).map(([k,v])=>`<option value="${k}" ${f===k?'selected':''}>${k==='custom'?'Custom (every N days)':v.label}</option>`).join('')}</select></div>
      <div class="field" id="f-custom-wrap" style="${f==='custom'?'':'display:none;'}"><label>Every N days</label><input type="number" id="f-custom-days" min="1" value="${existing&&existing.customIntervalDays||30}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>First payment date</label><input type="date" id="f-start" value="${existing?existing.startDate:toISO(today)}"></div>
      <div class="field"><label>End date (optional)</label><input type="date" id="f-end" value="${existing&&existing.endDate?existing.endDate:''}"></div>
    </div>`;
  openModal(existing?'Edit recurring income':'Add recurring income', body, ()=>{
    const name = document.getElementById('f-name').value.trim();
    const amount = Number(document.getElementById('f-amount').value)||0;
    const frequency = document.getElementById('f-freq').value;
    const startDate = document.getElementById('f-start').value;
    if(!name || !startDate || amount<=0){ showFormError('Enter a name, an amount, and the first payment date.'); return false; }
    const data = {name, person:document.getElementById('f-person').value, amount, frequency,
      customIntervalDays: frequency==='custom' ? (Number(document.getElementById('f-custom-days').value)||30) : null,
      startDate, endDate: document.getElementById('f-end').value || null};
    if(existing) Object.assign(existing, data);
    else recurringIncomeList().push(Object.assign({id:uid('rinc'), active:true}, data));
    saveState(); renderAll(); return true;
  });
  document.getElementById('f-freq').addEventListener('change', e=>{ document.getElementById('f-custom-wrap').style.display = e.target.value==='custom' ? '' : 'none'; });
}

/* =========================================================
   ALERTS — budget warnings, bills due, backup reminders
========================================================= */
function alertSettings(){
  const s = state.settings;
  if(!s.alerts) s.alerts = {enabled:true, warnAt:80, bills:true, backup:true};
  return s.alerts;
}
function dismissedAlerts(){ try{ return JSON.parse(localStorage.getItem('kaban_dismissed_alerts')||'{}'); }catch(e){ return {}; } }
function dismissAlert(id){ const d = dismissedAlerts(); d[id] = true; try{ localStorage.setItem('kaban_dismissed_alerts', JSON.stringify(d)); }catch(e){} }
function computeAlerts(){
  const cfg = alertSettings();
  if(!cfg.enabled) return [];
  const key = monthKey(today.getFullYear(), today.getMonth());
  if(!state.months[key]) return backupAlerts(cfg);
  const calc = computeMonth(key);
  const m = getMonth(key, true);
  const warn = (Number(cfg.warnAt)||80)/100;
  const out = [];
  ['necessities','extra','playjar'].forEach(sec=>{
    const c = calc[sec];
    if(c.budget<=0) return;
    const r = c.actual/c.budget;
    if(r>1.0001) out.push({id:`${key}|sec|${sec}|over`, tone:'danger', icon:BUCKETS[sec].icon, title:`${sectionLabel(sec)} is over budget`, detail:`${money(c.actual)} spent of ${money(c.budget)} — ${money(c.actual-c.budget)} over.`, view:sec});
    else if(r>=warn) out.push({id:`${key}|sec|${sec}|warn`, tone:'warn', icon:BUCKETS[sec].icon, title:`${sectionLabel(sec)} is at ${pct(r*100)}`, detail:`${money(c.remaining)} left for the rest of ${MONTH_NAMES[today.getMonth()]}.`, view:sec});
    categoryBudgetRows(m, sec, key).forEach(row=>{
      if(row.budget<=0) return;
      const rr = row.actual/row.budget;
      if(rr>1.0001) out.push({id:`${key}|cat|${sec}|${row.main}|over`, tone:'danger', icon:catIconFor(sec,row.main), title:`${row.main} is over budget`, detail:`${money(row.actual)} of ${money(row.budget)} in ${sectionLabel(sec)}.`, view:sec});
      else if(rr>=warn) out.push({id:`${key}|cat|${sec}|${row.main}|warn`, tone:'warn', icon:catIconFor(sec,row.main), title:`${row.main} is at ${pct(rr*100)} of its budget`, detail:`${money(row.remaining)} left this month.`, view:sec});
    });
  });
  if(cfg.bills){
    const t0 = toISO(today), soon = addDaysISO(t0, 3);
    const nameOf = (it)=> it.kind==='loan' ? it.label.replace(/ loan due$/,'') : it.label;
    const overdue = {};
    computeUpcomingItems(key).forEach(it=>{
      if(it.kind==='payday' || it.kind==='income') return;
      if(it.status==='Overdue'){ (overdue[nameOf(it)] = overdue[nameOf(it)] || []).push(it); return; }
      if(it.date>=t0 && it.date<=soon) out.push({id:`bill|${it.label}|${it.date}`, tone:'info', icon:'calendar-clock', title:`${nameOf(it)} is due ${relativeDayLabel(it.date).toLowerCase()}`, detail:`${fmtDateLong(it.date)}${it.amount!=null?` · ${money(it.amount)}`:''}.`, view:'calendar'});
    });
    Object.entries(overdue).forEach(([name, list])=>{
      const total = sumBy(list, x=>x.amount||0);
      out.push({id:`overdue|${name}|${list.map(x=>x.date).join(',')}`, tone:'danger', icon:'circle-alert',
        title: list.length>1 ? `${name}: ${list.length} payments overdue` : `${name} is overdue`,
        detail: list.length>1 ? `Oldest was due ${fmtDateLong(list[0].date)} · ${money(total)} in total.` : `Was due ${fmtDateLong(list[0].date)}${list[0].amount!=null?` · ${money(list[0].amount)}`:''}.`, view:'calendar'});
    });
  }
  return out.concat(backupAlerts(cfg));
}
function backupAlerts(cfg){
  if(!cfg.backup) return [];
  const hasData = Object.keys(state.months).length || state.debts.length;
  if(!hasData) return [];
  const last = state.settings.lastExportAt;
  const days = last ? Math.floor((Date.now() - new Date(last).getTime())/86400000) : null;
  if(days!==null && days < 30) return [];
  return [{id:`backup|${toISO(today).slice(0,7)}`, tone:'info', icon:'download', title:'Time for a backup', detail: last ? `Your last export was ${days} days ago.` : 'You haven’t exported a backup yet. It takes one click.', action:'export-data'}];
}
function visibleAlerts(){ const d = dismissedAlerts(); return computeAlerts().filter(a=>!d[a.id]); }
/* Alerts already opened in the bell panel on this device; the badge only counts new ones. */
function seenAlertIds(){ try{ return new Set(JSON.parse(localStorage.getItem('kaban.alertsSeen')||'[]')); }catch(e){ return new Set(); } }
function markAlertsSeen(list){ try{ localStorage.setItem('kaban.alertsSeen', JSON.stringify(list.map(a=>a.id))); }catch(e){} }
function renderAlertBell(){
  const btn = document.getElementById('alertBtn');
  if(!btn) return;
  const seen = seenAlertIds();
  const list = visibleAlerts().filter(a=>!seen.has(a.id));
  const danger = list.some(a=>a.tone==='danger');
  btn.innerHTML = `${icon('bell')}${list.length?`<span class="bell-count ${danger?'danger':''}">${list.length>9?'9+':list.length}</span>`:''}`;
  btn.title = list.length ? `${list.length} new alert${list.length===1?'':'s'}` : 'Alerts';
}
function openAlertsPanel(anchor){
  const list = visibleAlerts();
  markAlertsSeen(list); renderAlertBell();
  const html = `<div class="alerts-head"><b>Alerts</b><button class="card-link" data-alert-settings>Settings</button></div>
    ${list.length ? list.map((a,i)=>`<div class="alert-item">
      <span class="badge-ic sm t-${a.tone==='danger'?'debt':a.tone==='warn'?'extra':'save'}">${icon(a.icon)}</span>
      <button class="alert-body" data-alert-go="${i}"><b>${escapeHtml(a.title)}</b><small>${escapeHtml(a.detail)}</small></button>
      <button class="icon-btn" data-alert-dismiss="${i}" aria-label="Dismiss">${icon('x','ic-sm')}</button>
    </div>`).join('') : `<div style="margin:6px;">${doodleNote(null, 'All caught up', 'No alerts right now.')}</div>`}`;
  const pop = openMenu(anchor, [], {html});
  pop.classList.add('alerts-pop');
  pop.addEventListener('click', e=>{
    const go = e.target.closest('[data-alert-go]'), dis = e.target.closest('[data-alert-dismiss]');
    if(e.target.closest('[data-alert-settings]')){ closeMenu(); curSettingsTab='alerts'; navTo('settings'); return; }
    if(dis){ dismissAlert(list[Number(dis.dataset.alertDismiss)].id); closeMenu(); renderAlertBell(); openAlertsPanel(anchor); return; }
    if(go){ const a = list[Number(go.dataset.alertGo)]; closeMenu(); if(a.action==='export-data') exportData(); else if(a.view) navTo(a.view); }
  });
}
/* After an expense is saved, warn right away if it pushed a budget past the alert line. */
function budgetCrossingToast(key, sec, mainCategory, before){
  const cfg = alertSettings();
  if(!cfg.enabled) return;
  const warn = (Number(cfg.warnAt)||80)/100;
  const after = budgetSnapshot(key, sec, mainCategory);
  const crossed = (b, a, budget)=> budget>0 && ((b/budget<=1.0001 && a/budget>1.0001) ? 'over' : (b/budget<warn && a/budget>=warn) ? 'warn' : null);
  const cat = crossed(before.cat, after.cat, after.catBudget);
  const secC = crossed(before.sec, after.sec, after.secBudget);
  if(cat==='over') toast(`${mainCategory} is now over its budget`);
  else if(secC==='over') toast(`${sectionLabel(sec)} is now over budget`);
  else if(cat==='warn') toast(`Heads up: ${mainCategory} is at ${pct(after.cat/after.catBudget*100)} of its budget`);
  else if(secC==='warn') toast(`Heads up: ${sectionLabel(sec)} is at ${pct(after.sec/after.secBudget*100)}`);
}
function budgetSnapshot(key, sec, mainCategory){
  const c = computeMonth(key)[sec];
  const row = categoryBudgetRows(getMonth(key,true), sec, key).find(r=>r.main===mainCategory) || {actual:0, budget:0};
  return {sec:c.actual, secBudget:c.budget, cat:row.actual, catBudget:row.budget};
}

/* =========================================================
   CSV EXPORT (for spreadsheets)
========================================================= */
function csvCell(v){
  const s = v==null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
}
function exportCSV(year){
  const rows = [['Date','Type','Section','Category','Subcategory','Description','Person / Lender','Amount']];
  const inYear = (iso)=> !year || iso.slice(0,4)===String(year);
  Object.keys(state.months).sort().forEach(k=>{
    const m = state.months[k];
    (m.income||[]).forEach(i=>{ if(inYear(i.date)) rows.push([i.date,'Income','','','',i.description||'Salary',earnerName(i.person),Number(i.amount)||0]); });
    ['necessities','extra','playjar'].forEach(sec=> (m[sec].expenses||[]).forEach(e=>{
      if(inYear(e.date)) rows.push([e.date,'Expense',sectionLabel(sec),e.mainCategory||'',e.subCategory||'',e.description||'','',-(Number(e.amount)||0)]);
    }));
    Object.entries(m.savingsActuals||{}).forEach(([gid,amt])=>{
      if(!Number(amt)) return;
      const end = monthRange(k)[1];
      if(!inYear(end)) return;
      const g = state.settings.savingsGoals.find(x=>x.id===gid);
      rows.push([end,'Savings','Savings',g?g.name:'Deleted goal','','Monthly savings total','',-(Number(amt)||0)]);
    });
  });
  state.debts.forEach(d=>{
    if(inYear(d.dateBorrowed)) rows.push([d.dateBorrowed,'Borrowed','Debt',DEBT_TYPE_LABEL[d.repaymentType],'',`Loan from ${d.lender}`,d.lender,Number(d.principal)||0]);
    d.payments.forEach(p=>{ if(inYear(p.date)) rows.push([p.date,'Debt payment','Debt',DEBT_TYPE_LABEL[d.repaymentType],'',p.note||`Payment to ${d.lender}`,d.lender,-(Number(p.amount)||0)]); });
  });
  const header = rows.shift();
  rows.sort((a,b)=> String(a[0]).localeCompare(String(b[0])));
  const csv = '﻿' + [header].concat(rows).map(r=>r.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${APP_CONFIG.appName.toLowerCase().replace(/[^a-z0-9]+/g,'-')}-${year||'all-time'}-transactions.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast(`Exported ${rows.length} transaction${rows.length===1?'':'s'}`);
}
function openExportMenu(anchor, year){
  openMenu(anchor, [
    {heading:'Download'},
    {label:`Spreadsheet (CSV) — ${year}`, icon:'sheet', tone:'c-nec', onClick:()=>exportCSV(year)},
    {label:'Spreadsheet (CSV) — all time', icon:'sheet', tone:'c-nec', onClick:()=>exportCSV(null)},
    {label:'Full backup (.json)', icon:'download', onClick:exportData}
  ]);
}

/* =========================================================
   INSTALL AS AN APP (PWA)
========================================================= */
let _installPrompt = null;
window.addEventListener('beforeinstallprompt', (e)=>{ e.preventDefault(); _installPrompt = e; });
window.addEventListener('appinstalled', ()=>{ _installPrompt = null; toast('Installed — find it on your home screen'); });
function isStandalone(){ return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true; }
function isIOS(){ return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform==='MacIntel' && navigator.maxTouchPoints>1); }
function installApp(){
  if(isStandalone()){ alertDialog('Already installed', 'You’re using the installed app right now.', 'info'); return; }
  if(_installPrompt){ _installPrompt.prompt(); _installPrompt.userChoice.finally(()=>{ _installPrompt = null; }); return; }
  const steps = isIOS()
    ? 'In Safari, tap the Share button (the square with an arrow), then choose “Add to Home Screen”.'
    : 'Open your browser menu (⋮) and choose “Install app” or “Add to Home screen”. On a computer, look for the install icon at the right end of the address bar.';
  askDialog({title:'Install on your phone', message:steps, icon:'smartphone', confirmLabel:'Got it', hideCancel:true});
}
if('serviceWorker' in navigator && (location.protocol==='https:' || location.hostname==='localhost' || location.hostname==='127.0.0.1')){
  // When a new version of the app takes over, reload once so the update shows immediately.
  const hadController = !!navigator.serviceWorker.controller;
  let reloadedForUpdate = false;
  navigator.serviceWorker.addEventListener('controllerchange', ()=>{
    if(!hadController || reloadedForUpdate) return;
    reloadedForUpdate = true;
    location.reload();
  });
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('sw.js', {updateViaCache:'none'}).then(reg=>{
      // Check for a newer version whenever the app is reopened or brought back to the front.
      document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='visible') reg.update().catch(()=>{}); });
    }).catch(()=>{});
  });
}

/* ---------- Modal: Expense ---------- */
function openExpenseModal(key, sec, id, prefill){
  const m = getMonth(key,true);
  const data = m[sec];
  const tree = getCategoryTree(sec);
  const existing = id ? data.expenses.find(x=>x.id===id) : null;
  prefill = prefill || {};
  const initialMain = existing ? existing.mainCategory : (prefill.mainCategory || (tree[0] ? tree[0].name : ''));
  // Only offer categories active as of this month — but never hide whatever's already selected.
  const selectableMains = tree.filter(c=> isCategoryActiveForMonth(c, key) || c.name===initialMain);
  function subOptionsHtml(mainName, selectedSub){
    const main = tree.find(c=>c.name===mainName);
    if(!main || !main.subs.length) return '';
    const subs = main.subs.filter(s=> isCategoryActiveForMonth(s, key) || s.name===selectedSub);
    return subs.map(s=>`<option value="${escapeHtml(s.name)}" ${selectedSub===s.name?'selected':''}>${escapeHtml(s.name)}</option>`).join('');
  }
  const body = `
    <div class="field"><label>Date</label><input type="date" id="f-date" value="${existing?existing.date:(prefill.date||toISO(today))}"></div>
    <div class="field"><label>Category</label>
      <select id="f-main">${selectableMains.map(c=>`<option value="${escapeHtml(c.name)}" ${initialMain===c.name?'selected':''}>${escapeHtml(c.name)}</option>`).join('')}</select>
    </div>
    <div class="field" id="f-sub-wrap" style="display:none;"><label>Subcategory</label>
      <select id="f-sub">${subOptionsHtml(initialMain, existing?existing.subCategory:(prefill.subCategory||null))}</select>
    </div>
    <div class="field"><label>Description</label><input type="text" id="f-desc" value="${existing?escapeHtml(existing.description||''):escapeHtml(prefill.description||'')}" placeholder="e.g. Weekly groceries"></div>
    <div class="field"><label>Amount (${currencySymbol()})</label><input type="number" id="f-amount" step="0.01" min="0" value="${existing?existing.amount:(prefill.amount!==undefined?prefill.amount:'')}" placeholder="0.00"></div>
  `;
  openModal((existing?'Edit expense':(prefill.recurringId?'Record payment':'Add expense'))+` <span style="font-weight:500;color:var(--text-3);font-size:15px;">· ${sectionLabel(sec)}</span>`, body, ()=>{
    const date = document.getElementById('f-date').value;
    const mainCategory = document.getElementById('f-main').value;
    const subWrap = document.getElementById('f-sub-wrap');
    const subCategory = (subWrap.style.display!=='none') ? (document.getElementById('f-sub').value||null) : null;
    const description = document.getElementById('f-desc').value;
    const amount = Number(document.getElementById('f-amount').value);
    if(!date || !amount || amount<=0){ showFormError('Enter a valid date and amount.'); return false; }
    const before = budgetSnapshot(key, sec, mainCategory);
    setTimeout(()=>budgetCrossingToast(key, sec, mainCategory, before), 0);
    if(existing){ existing.date=date; existing.mainCategory=mainCategory; existing.subCategory=subCategory; existing.description=description; existing.amount=amount; }
    else{
      const rec = {id:uid('exp'), date, mainCategory, subCategory, description, amount};
      if(prefill.recurringId){
        rec.recurringId = prefill.recurringId; rec.recurringDueDate = prefill.recurringDueDate;
      } else {
        const match = findMatchingRecurringOccurrence(sec, mainCategory, subCategory, date);
        if(match){ rec.recurringId = match.recurringId; rec.recurringDueDate = match.recurringDueDate; }
      }
      data.expenses.push(rec);
    }
    saveState(); renderAll(); return true;
  });
  function refreshSub(){
    const mainName = document.getElementById('f-main').value;
    const html = subOptionsHtml(mainName, existing?existing.subCategory:null);
    document.getElementById('f-sub-wrap').style.display = html ? '' : 'none';
    document.getElementById('f-sub').innerHTML = html;
  }
  document.getElementById('f-main').addEventListener('change', refreshSub);
  refreshSub();
}

/* ---------- Modal: Manage categories ---------- */
function goalHasAnyActuals(goalId){
  return Object.values(state.months).some(m=> Number(m.savingsActuals[goalId]||0) !== 0);
}
function handleDeleteGoal(goalId){
  const goal = state.settings.savingsGoals.find(g=>g.id===goalId);
  if(!goal) return;
  if(goalHasAnyActuals(goalId)){
    return confirmModal(`"${goal.name}" has savings recorded against it in one or more months. Deactivating keeps that history intact (it'll still show correctly in Annual view) but stops it from receiving new allocation or appearing on the Savings page going forward. Deactivate now?`, ()=>{
      goal.active = false; saveState(); renderAll();
    });
  }
  return confirmModal(`Delete "${goal.name}"? It has no savings recorded, so this is safe.`, ()=>{
    state.settings.savingsGoals = state.settings.savingsGoals.filter(g=>g.id!==goalId); saveState(); renderAll();
  });
}
function categoryHasAnyExpenses(sec, mainName, subName){
  return Object.values(state.months).some(mm=>
    mm[sec].expenses.some(x=> x.mainCategory===mainName && (subName ? x.subCategory===subName : true))
  );
}
function openCategoriesModal(key, sec){
  const m = getMonth(key,true);
  const data = m[sec];

  const tone = SECTION_TONE[sec];
  function render(){
    const tree = state.settings.categoryTree[sec];
    const rowsHtml = tree.map((main, mi)=>{
      const mainInactive = !isCategoryActiveForMonth(main, key);
      const otherMains = tree.filter(c=>c.id!==main.id);
      const subsHtml = main.subs.map((sub, si)=>{
        const subInactive = !isCategoryActiveForMonth(sub, key);
        return `<div class="cm-row sub ${subInactive?'is-hidden':''}">
          <button type="button" class="cm-icon" data-sub-icon="${main.id}" data-sub-idx="${si}" title="Change icon"><span class="badge-ic xs t-${catTone(sec, main.name, sub.name)}">${icon(catIconFor(sec, main.name, sub.name))}</span></button>
          <span class="cm-name">${escapeHtml(sub.name)}${subInactive?'<span class="pill danger">hidden</span>':''}</span>
          <span class="cm-actions">
            ${otherMains.length ? `<select data-sub-move="${main.id}" data-sub-idx="${si}" class="cm-move" aria-label="Move to another category"><option value="">Move…</option>${otherMains.map(o=>`<option value="${o.id}">${escapeHtml(o.name)}</option>`).join('')}</select>` : ''}
            <button type="button" class="icon-btn" data-sub-up="${main.id}" data-sub-idx="${si}" title="Move up">${icon('arrow-up','ic-sm')}</button>
            <button type="button" class="icon-btn" data-sub-down="${main.id}" data-sub-idx="${si}" title="Move down">${icon('arrow-down','ic-sm')}</button>
            <button type="button" class="icon-btn" data-sub-rename="${main.id}" data-sub-idx="${si}" title="Rename">${icon('pencil','ic-sm')}</button>
            <button type="button" class="icon-btn" data-sub-toggle-active="${main.id}" data-sub-idx="${si}" title="${subInactive?'Show again':'Hide from future months'}">${subInactive?icon('eye','ic-sm'):icon('eye-off','ic-sm')}</button>
            <button type="button" class="icon-btn danger" data-sub-del="${main.id}" data-sub-idx="${si}" title="Delete">${icon('trash-2','ic-sm')}</button>
          </span>
        </div>`;
      }).join('');
      return `<div class="cm-group ${mainInactive?'is-hidden':''}">
        <div class="cm-row">
          <button type="button" class="cm-icon" data-main-icon="${main.id}" title="Change icon"><span class="badge-ic sm t-${catTone(sec, main.name)}">${icon(catIconFor(sec, main.name))}</span></button>
          <span class="cm-name"><b>${escapeHtml(main.name)}</b>${mainInactive?'<span class="pill danger">hidden</span>':''}</span>
          <span class="cm-actions">
            <button type="button" class="card-chip" data-main-addsub="${main.id}" title="Add subcategory">${icon('plus','ic-sm')}Sub</button>
            <button type="button" class="icon-btn" data-main-up="${mi}" title="Move up">${icon('arrow-up','ic-sm')}</button>
            <button type="button" class="icon-btn" data-main-down="${mi}" title="Move down">${icon('arrow-down','ic-sm')}</button>
            <button type="button" class="icon-btn" data-main-rename="${main.id}" title="Rename">${icon('pencil','ic-sm')}</button>
            <button type="button" class="icon-btn" data-main-toggle-active="${main.id}" title="${mainInactive?'Show again':'Hide from future months'}">${mainInactive?icon('eye','ic-sm'):icon('eye-off','ic-sm')}</button>
            <button type="button" class="icon-btn danger" data-main-del="${main.id}" title="Delete">${icon('trash-2','ic-sm')}</button>
          </span>
        </div>
        ${subsHtml ? `<div class="cm-subs">${subsHtml}</div>` : ''}
      </div>`;
    }).join('');
    document.getElementById('catTreeRows').innerHTML = rowsHtml || `<p class="small-muted">No categories yet — add one below.</p>`;
  }

  const body = `
    <div id="catTreeRows"></div>
    <div class="field"><label>Add a main category</label>
      <div style="display:flex;gap:8px;"><input type="text" id="newMainName" placeholder="Housing" style="flex:1;"><button class="btn" id="addMainBtn" type="button">${icon('plus')}Add</button></div>
    </div>
    <p class="help-text">Click any icon to change it. Categories are shared across every month. Use <strong>+ Sub</strong> to add subcategories. Hide a category you no longer need with the eye icon — it disappears from future months but keeps its history. Delete only removes categories you never used.</p>
  `;
  openModal('Manage categories', body, ()=>{ return true; }, {submitLabel:'Done', hideCancel:true, wide:true, onClose:renderAll});
  render();

  function save(){ saveState(); render(); }

  document.getElementById('addMainBtn').addEventListener('click', async ()=>{
    const input = document.getElementById('newMainName');
    const name = input.value.trim();
    if(!name){ input.focus(); return; }
    const tree = state.settings.categoryTree[sec];
    if(tree.some(c=>c.name.toLowerCase()===name.toLowerCase())){ await alertDialog('Already exists', `There's already a category called "${name}".`); return; }
    const res = await askDialog({title:`Add "${name}"`, message:'Pick an icon and, if you like, a default monthly budget. You can change both later.', fields:[{id:'icon', type:'icon', label:'Icon', value:categoryIcon(name)==='tag'?'':categoryIcon(name), tone, allowAuto:true, autoIcon:categoryIcon(name)},{id:'budget', label:'Default monthly budget (optional)', money:true}], confirmLabel:'Add category'});
    if(!res) return;
    const budget = Number(res.budget)||0;
    tree.push({id:uid('cat'), name, icon:res.icon||undefined, subs:[], inactiveFrom:null});
    if(budget>0) ensureDefaultsNode(sec, name).own = budget;
    input.value = '';
    save();
  });

  document.getElementById('newMainName').addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); e.stopPropagation(); document.getElementById('addMainBtn').click(); } });
  document.getElementById('catTreeRows').addEventListener('click', async (e)=>{
    const t = e.target.closest('button');
    if(!t) return;
    const tree = state.settings.categoryTree[sec];
    if(t.dataset.mainIcon!==undefined){
      const main = tree.find(c=>c.id===t.dataset.mainIcon);
      const v = await pickIcon(main.icon||'', {title:`Icon for ${main.name}`, tone, allowAuto:true});
      if(v!==undefined){ main.icon = v || undefined; save(); }
      return;
    }
    if(t.dataset.subIcon!==undefined){
      const main = tree.find(c=>c.id===t.dataset.subIcon);
      const sub = main.subs[Number(t.dataset.subIdx)];
      const v = await pickIcon(sub.icon||'', {title:`Icon for ${sub.name}`, tone, allowAuto:true});
      if(v!==undefined){ sub.icon = v || undefined; save(); }
      return;
    }
    // Main category actions
    if(t.dataset.mainUp!==undefined){
      const i = Number(t.dataset.mainUp);
      if(i>0){ [tree[i-1],tree[i]]=[tree[i],tree[i-1]]; save(); }
      return;
    }
    if(t.dataset.mainDown!==undefined){
      const i = Number(t.dataset.mainDown);
      if(i<tree.length-1){ [tree[i+1],tree[i]]=[tree[i],tree[i+1]]; save(); }
      return;
    }
    if(t.dataset.mainRename!==undefined){
      const main = tree.find(c=>c.id===t.dataset.mainRename);
      const res = await askDialog({title:'Rename category', fields:[{id:'name', label:'Name', value:main.name, required:true}], confirmLabel:'Rename',
        validate:v=> tree.some(c=>c!==main && c.name.toLowerCase()===v.name.toLowerCase()) ? 'Another category already has that name.' : null});
      const name = res && res.name;
      if(name && name.trim()){
        const newName = name.trim();
        if(newName!==main.name){
          renameCategoryEverywhere(sec, main.name, newName);
          main.name = newName;
        }
        save();
      }
      return;
    }
    if(t.dataset.mainAddsub!==undefined){
      const main = tree.find(c=>c.id===t.dataset.mainAddsub);
      const res = await askDialog({title:`New subcategory in ${main.name}`, fields:[{id:'name', label:'Name', placeholder:'Electricity', required:true},{id:'icon', type:'icon', label:'Icon', value:'', tone, allowAuto:true, nameFrom:'name'},{id:'budget', label:'Default monthly budget (optional)', money:true}], confirmLabel:'Add',
        validate:v=> main.subs.some(s=>s.name.toLowerCase()===v.name.toLowerCase()) ? 'That subcategory already exists.' : null});
      if(res && res.name){
        const subName = res.name.trim();
        const budget = Number(res.budget)||0;
        main.subs.push({id:uid('sub'), name:subName, icon:res.icon||undefined, inactiveFrom:null});
        if(budget>0){ const d = ensureDefaultsNode(sec, main.name); d.subs[subName] = budget; }
        save();
      }
      return;
    }
    if(t.dataset.mainToggleActive!==undefined){
      const main = tree.find(c=>c.id===t.dataset.mainToggleActive);
      main.inactiveFrom = main.inactiveFrom ? null : key;
      save();
      return;
    }
    if(t.dataset.mainDel!==undefined){
      const main = tree.find(c=>c.id===t.dataset.mainDel);
      const everUsed = categoryHasAnyExpenses(sec, main.name);
      if(everUsed){ await alertDialog(`Can't delete "${main.name}"`, 'It has expenses recorded, and deleting it would erase that history. Hide it instead (eye icon) — it disappears from future months but keeps its history.'); return; }
      if(!await confirmDialog(`Delete "${main.name}"?`, `${main.subs.length?'This also deletes its subcategories. ':''}It has no recorded expenses, so nothing else is affected.`, {tone:'danger', confirmLabel:'Delete'})) return;
      state.settings.categoryTree[sec] = tree.filter(c=>c.id!==main.id);
      save();
      return;
    }
    // Subcategory actions
    if(t.dataset.subUp!==undefined){
      const main = tree.find(c=>c.id===t.dataset.subUp);
      const i = Number(t.dataset.subIdx);
      if(i>0){ [main.subs[i-1],main.subs[i]]=[main.subs[i],main.subs[i-1]]; save(); }
      return;
    }
    if(t.dataset.subDown!==undefined){
      const main = tree.find(c=>c.id===t.dataset.subDown);
      const i = Number(t.dataset.subIdx);
      if(i<main.subs.length-1){ [main.subs[i+1],main.subs[i]]=[main.subs[i],main.subs[i+1]]; save(); }
      return;
    }
    if(t.dataset.subRename!==undefined){
      const main = tree.find(c=>c.id===t.dataset.subRename);
      const sub = main.subs[Number(t.dataset.subIdx)];
      const res = await askDialog({title:'Rename subcategory', fields:[{id:'name', label:'Name', value:sub.name, required:true}], confirmLabel:'Rename',
        validate:v=> main.subs.some(x=>x!==sub && x.name.toLowerCase()===v.name.toLowerCase()) ? 'Another subcategory already has that name.' : null});
      const name = res && res.name;
      if(name && name.trim()){
        const newName = name.trim();
        if(newName!==sub.name){
          renameSubcategoryEverywhere(sec, main.name, sub.name, newName);
          sub.name = newName;
        }
        save();
      }
      return;
    }
    if(t.dataset.subToggleActive!==undefined){
      const main = tree.find(c=>c.id===t.dataset.subToggleActive);
      const sub = main.subs[Number(t.dataset.subIdx)];
      sub.inactiveFrom = sub.inactiveFrom ? null : key;
      save();
      return;
    }
    if(t.dataset.subDel!==undefined){
      const main = tree.find(c=>c.id===t.dataset.subDel);
      const sub = main.subs[Number(t.dataset.subIdx)];
      const everUsed = categoryHasAnyExpenses(sec, main.name, sub.name);
      if(everUsed){ await alertDialog(`Can't delete "${sub.name}"`, 'It has expenses recorded, and deleting it would erase that history. Hide it instead (eye icon).'); return; }
      if(!await confirmDialog(`Delete "${sub.name}"?`, 'It has no recorded expenses, so nothing else is affected.', {tone:'danger', confirmLabel:'Delete'})) return;
      main.subs = main.subs.filter(s=>s.id!==sub.id);
      save();
      return;
    }
  });
  document.getElementById('catTreeRows').addEventListener('change', (e)=>{
    const t = e.target;
    const tree = state.settings.categoryTree[sec];
    if(t.dataset.subMove!==undefined && t.value){
      const fromMain = tree.find(c=>c.id===t.dataset.subMove);
      const toMain = tree.find(c=>c.id===t.value);
      const sub = fromMain.subs[Number(t.dataset.subIdx)];
      if(toMain.subs.some(s=>s.name===sub.name)){ t.value=''; alertDialog('Name already used', `"${toMain.name}" already has a subcategory named "${sub.name}".`); return; }
      // Move expenses tagged with this main+sub to the new main, across every month
      Object.values(state.months).forEach(mm=>{
        mm[sec].expenses.forEach(x=>{ if(x.mainCategory===fromMain.name && x.subCategory===sub.name) x.mainCategory = toMain.name; });
      });
      // Move default/override budgets
      const fromDef = state.settings.categoryDefaults[sec][fromMain.name];
      if(fromDef && fromDef.subs[sub.name]!==undefined){
        ensureDefaultsNode(sec, toMain.name).subs[sub.name] = fromDef.subs[sub.name];
        delete fromDef.subs[sub.name];
      }
      fromMain.subs = fromMain.subs.filter(s=>s.id!==sub.id);
      toMain.subs.push(sub);
      save();
    }
  });
}
/* Rename propagation: keep expenses, defaults, and this-month overrides pointed at the new name */
function renameCategoryEverywhere(sec, oldName, newName){
  Object.values(state.months).forEach(m=>{
    m[sec].expenses.forEach(e=>{ if(e.mainCategory===oldName) e.mainCategory = newName; });
    if(m[sec].budgetOverrides[oldName]){ m[sec].budgetOverrides[newName] = m[sec].budgetOverrides[oldName]; delete m[sec].budgetOverrides[oldName]; }
  });
  if(state.settings.categoryDefaults[sec][oldName]){
    state.settings.categoryDefaults[sec][newName] = state.settings.categoryDefaults[sec][oldName];
    delete state.settings.categoryDefaults[sec][oldName];
  }
}
function renameSubcategoryEverywhere(sec, mainName, oldSub, newSub){
  Object.values(state.months).forEach(m=>{
    m[sec].expenses.forEach(e=>{ if(e.mainCategory===mainName && e.subCategory===oldSub) e.subCategory = newSub; });
    const ov = m[sec].budgetOverrides[mainName];
    if(ov && ov.subs && ov.subs[oldSub]!==undefined){ ov.subs[newSub] = ov.subs[oldSub]; delete ov.subs[oldSub]; }
  });
  const d = state.settings.categoryDefaults[sec][mainName];
  if(d && d.subs[oldSub]!==undefined){ d.subs[newSub] = d.subs[oldSub]; delete d.subs[oldSub]; }
}

/* ---------- Modal: This month's category budget (override only) ---------- */
function openThisMonthBudgetModal(key, section, mainName, subName){
  const m = getMonth(key,true);
  const current = getCategoryBudget(m, section, mainName, subName||null);
  const def = getCategoryDefault(section, mainName, subName||null);
  const label = subName ? `${mainName} — ${subName}` : mainName;
  const ovNode = m[section].budgetOverrides[mainName];
  const hasOverride = !!(ovNode && (subName ? ovNode.subs[subName]!==undefined : ovNode.own!==undefined));
  const body = `
    <p class="small-muted">Default budget for ${escapeHtml(label)}: <strong style="color:var(--ink);">${money(def)}</strong></p>
    <div class="field"><label>This month's budget for ${escapeHtml(label)} (${currencySymbol()})</label>
      <input type="number" id="f-amount" min="0" step="0.01" value="${current}">
    </div>
    <p class="help-text">This only changes ${MONTH_NAMES[cur.monthIndex]} ${cur.year} — the default stays the same for every other month.</p>
    ${hasOverride ? `<button type="button" class="btn btn-sm" id="resetToDefaultBtn" style="margin-top:6px;">Reset to default (${money(def)})</button>` : ''}
  `;
  openModal('Edit this month\'s budget', body, ()=>{
    const val = Number(document.getElementById('f-amount').value)||0;
    const ov = ensureOverrideNode(m, section, mainName);
    if(subName) ov.subs[subName] = val; else ov.own = val;
    saveState(); renderAll(); return true;
  }, {submitLabel:'Save'});
  const resetBtn = document.getElementById('resetToDefaultBtn');
  if(resetBtn) resetBtn.addEventListener('click', ()=>{
    const ov = m[section].budgetOverrides[mainName];
    if(ov){ if(subName) delete ov.subs[subName]; else delete ov.own; }
    saveState(); closeModal(); renderAll();
  });
}

/* ---------- Modal: Change a category's DEFAULT budget (with scope) ---------- */
function openDefaultBudgetModal(section, mainName, subName){
  const def = getCategoryDefault(section, mainName, subName||null);
  const label = subName ? `${mainName} — ${subName}` : mainName;
  const body = `
    <div class="field"><label>Default monthly budget for ${escapeHtml(label)} (${currencySymbol()})</label>
      <input type="number" id="f-default" min="0" step="0.01" value="${def}">
    </div>
    <div class="field"><label>Apply this change to</label>
      <select id="f-scope">
        <option value="currentAndFuture">This month and future months</option>
        <option value="future">Only future months (keep this month as-is)</option>
        <option value="current">Only this month (don't change the default)</option>
      </select>
    </div>
    <p class="help-text">Past months are never changed automatically, so your history stays accurate.</p>
  `;
  openModal('Change default budget', body, ()=>{
    const val = Number(document.getElementById('f-default').value)||0;
    const scope = document.getElementById('f-scope').value;
    applyCategoryDefaultChange(section, mainName, subName||null, val, scope);
    saveState(); renderAll(); return true;
  }, {submitLabel:'Save'});
}


function openGoalModal(id){
  const existing = id ? state.settings.savingsGoals.find(g=>g.id===id) : null;
  const body = `
    <div class="field"><label>Goal name</label><input type="text" id="f-name" value="${existing?escapeHtml(existing.name):''}" placeholder="e.g. Emergency Fund"></div>
    ${iconFieldHtml('f-icon', existing?existing.icon:'', 'Icon', {nameSrc:'f-name', allowAuto:true, tone:'save', autoKind:'goal', autoIcon: existing?goalIcon(existing.name):'piggy-bank'})}
    <div class="field"><label>Default allocation (% of monthly savings amount)</label><input type="number" id="f-alloc" min="0" max="100" value="${existing?existing.allocation:''}" placeholder="0"></div>
    ${existing ? `<div class="field"><label>Apply the allocation % change to</label>
      <select id="f-scope">
        <option value="currentAndFuture">This month and future months</option>
        <option value="future">Only future months (keep this month as-is)</option>
        <option value="current">Only this month (don't change the default)</option>
      </select>
    </div>` : ''}
    <div class="field"><label>Target amount (optional, ${currencySymbol()})</label><input type="number" id="f-target" min="0" value="${existing&&existing.target?existing.target:''}" placeholder="Leave blank if none"></div>
  `;
  openModal(existing?'Edit savings goal':'Add savings goal', body, ()=>{
    const name = document.getElementById('f-name').value.trim();
    const allocation = Number(document.getElementById('f-alloc').value)||0;
    const targetRaw = document.getElementById('f-target').value;
    const target = targetRaw ? Number(targetRaw) : null;
    const goalIc = document.getElementById('f-icon').value || undefined;
    if(!name){ showFormError('Enter a goal name.'); return false; }
    if(existing){
      existing.name=name; existing.target=target; existing.icon=goalIc;
      const scope = document.getElementById('f-scope').value;
      if(allocation!==existing.allocation) applyGoalAllocationChange(existing.id, allocation, scope);
    }
    else state.settings.savingsGoals.push({id:uid('goal'), name, icon:goalIc, allocation, target, active:true});
    saveState(); renderAll(); return true;
  });
}
function openRecordSavingsModal(key, goalId){
  const m = getMonth(key,true);
  const goal = state.settings.savingsGoals.find(g=>g.id===goalId);
  const body = `
    <div class="field"><label>Actual saved toward "${escapeHtml(goal.name)}" this month (${currencySymbol()})</label>
    <input type="number" id="f-amount" min="0" step="0.01" value="${m.savingsActuals[goalId]||''}" placeholder="0.00"></div>
  `;
  openModal('Record savings', body, ()=>{
    const amount = Number(document.getElementById('f-amount').value)||0;
    m.savingsActuals[goalId] = amount;
    saveState(); renderAll(); return true;
  });
}

/* ---------- Modal: Savings target override ---------- */
function openSavingsAmountModal(key){
  const calc = computeMonth(key);
  const body = `
    <p class="small-muted">Recommended target (${pct(state.settings.allocations.savings||0,0)} of this month's budgetable income): <strong style="color:var(--ink);">${money(calc.savings.autoBudgetTotal)}</strong></p>
    <div class="field"><label>How much can we save this month? (${currencySymbol()})</label>
      <input type="number" id="f-amount" min="0" step="0.01" value="${calc.savings.budgetTotal}">
    </div>
    <div class="field"><label>Apply this change to</label>
      <select id="f-scope">
        <option value="current">Only this month</option>
        <option value="currentAndFuture">This month and future months</option>
        <option value="future">Only future months (keep this month as-is)</option>
      </select>
    </div>
    <p class="help-text">This can be ${money(0)}, below, or above the recommended target — whatever you can actually set aside. Past months are never changed automatically.</p>
  `;
  openModal("Set this month's savings amount", body, ()=>{
    const val = Number(document.getElementById('f-amount').value)||0;
    const scope = document.getElementById('f-scope').value;
    applySavingsAmountChange(val, scope);
    saveState(); renderAll(); return true;
  }, {submitLabel:'Save'});
}
/* ---------- Modal: This month's goal allocation % (quick override) ---------- */
function openGoalAllocModal(key, goalId){
  const m = getMonth(key,true);
  const goal = state.settings.savingsGoals.find(g=>g.id===goalId);
  if(!goal) return;
  const hasOverride = m.savingsGoalAllocOverrides && m.savingsGoalAllocOverrides[goalId]!==undefined;
  const current = hasOverride ? m.savingsGoalAllocOverrides[goalId] : goal.allocation;
  const body = `
    <p class="small-muted">Default allocation for ${escapeHtml(goal.name)}: <strong style="color:var(--ink);">${pct(goal.allocation)}</strong></p>
    <div class="field"><label>This month's allocation % for ${escapeHtml(goal.name)}</label>
      <input type="number" id="f-amount" min="0" max="100" step="0.1" value="${current}">
    </div>
    <p class="help-text">This only changes ${MONTH_NAMES[cur.monthIndex]} ${cur.year} — the default stays the same for every other month.</p>
    ${hasOverride ? `<button type="button" class="btn btn-sm" id="resetToDefaultBtn" style="margin-top:6px;">Reset to default (${pct(goal.allocation)})</button>` : ''}
  `;
  openModal(`Edit this month's allocation`, body, ()=>{
    const val = Number(document.getElementById('f-amount').value)||0;
    if(!m.savingsGoalAllocOverrides) m.savingsGoalAllocOverrides = {};
    m.savingsGoalAllocOverrides[goalId] = val;
    saveState(); renderAll(); return true;
  }, {submitLabel:'Save'});
  const resetBtn = document.getElementById('resetToDefaultBtn');
  if(resetBtn) resetBtn.addEventListener('click', ()=>{
    if(m.savingsGoalAllocOverrides) delete m.savingsGoalAllocOverrides[goalId];
    saveState(); closeModal(); renderAll();
  });
}

/* ---------- Modal: Rollover decision ---------- */
/* ---------- Modal: Customize dashboard ---------- */
function openDashboardCustomizeModal(){
  const prefs = state.settings.dashboardPrefs;
  let localOrder = dashboardSectionOrder().slice();
  let localHidden = {...prefs.hidden};
  let localView = prefs.view;

  function render(){
    const rowsHtml = localOrder.map((id,i)=>{
      const def = DASHBOARD_SECTIONS[id];
      const hidden = !!localHidden[id];
      return `<div class="chip" style="width:100%;justify-content:space-between;margin-bottom:6px;">
        <span style="${hidden?'color:var(--ink-faint);text-decoration:line-through;':''}">${def.title}</span>
        <span>
          <button data-ord-up="${i}" title="Move up">${icon('arrow-up','ic-sm')}</button>
          <button data-ord-down="${i}" title="Move down">${icon('arrow-down','ic-sm')}</button>
          <button data-ord-toggle="${id}" title="${hidden?'Show':'Hide'}">${hidden?icon('eye'):icon('eye-off')}</button>
        </span>
      </div>`;
    }).join('');
    document.getElementById('dashCustomRows').innerHTML = rowsHtml;
  }

  const body = `
    <div class="field"><label>Dashboard view</label>
      <select id="f-dashview">
        <option value="detailed" ${localView==='detailed'?'selected':''}>Detailed (with insight cards)</option>
        <option value="simple" ${localView==='simple'?'selected':''}>Simple (main overview only)</option>
      </select>
    </div>
    <div class="field"><label>Insight cards and order</label><div id="dashCustomRows"></div></div>
    <p class="help-text">These are the extra insight cards under the main dashboard. Simple view hides all of them.</p>
  `;
  openModal('Customize dashboard', body, ()=>{
    prefs.view = document.getElementById('f-dashview').value;
    prefs.order = localOrder;
    prefs.hidden = localHidden;
    saveState(); renderAll(); return true;
  }, {submitLabel:'Save'});
  render();

  document.getElementById('dashCustomRows').addEventListener('click', (e)=>{
    const t = e.target.closest('button'); if(!t) return;
    if(t.dataset.ordUp!==undefined){
      const i = Number(t.dataset.ordUp);
      if(i>0){ [localOrder[i-1],localOrder[i]]=[localOrder[i],localOrder[i-1]]; render(); }
    } else if(t.dataset.ordDown!==undefined){
      const i = Number(t.dataset.ordDown);
      if(i<localOrder.length-1){ [localOrder[i+1],localOrder[i]]=[localOrder[i],localOrder[i+1]]; render(); }
    } else if(t.dataset.ordToggle!==undefined){
      const id = t.dataset.ordToggle;
      if(localHidden[id]) delete localHidden[id]; else localHidden[id] = true;
      render();
    }
  });
}

function openRolloverModal(monthKeyRef, sec){
  const pm = state.months[monthKeyRef];
  const shallow = computeMonthShallow(monthKeyRef);
  const remaining = shallow[sec].remaining;
  const body = `
    <p class="small-muted">Remaining ${sectionLabel(sec)} budget from ${MONTH_NAMES[cur_moOf(monthKeyRef)]}: <strong style="color:var(--ink);">${money(remaining)}</strong></p>
    <div class="field"><label>What should happen to it?</label>
      <select id="f-decision">
        <option value="rollover">Roll over into next month's budget</option>
        <option value="surplus">Keep as surplus (does not increase next month's budget)</option>
      </select>
    </div>
  `;
  openModal('Month-end rollover', body, ()=>{
    pm.rollover[sec] = document.getElementById('f-decision').value;
    saveState(); renderAll(); return true;
  }, {submitLabel:'Confirm'});
}

/* ---------- Modal: Recurring bills ---------- */
/* ---------- Modal: Add/Edit debt ---------- */
function openDebtModal(id){
  const existing = id ? state.debts.find(d=>d.id===id) : null;
  const borrowers = debtBorrowerList();
  const type = existing ? existing.repaymentType : 'standard';
  const it = existing ? existing.interest : {mode:'none'};
  const inst = existing ? existing.installment : {};
  const lf = existing ? existing.lateFee : {mode:'none'};
  const body = `
    <div class="field-row">
      <div class="field"><label>Lender</label><input type="text" id="f-lender" value="${existing?escapeHtml(existing.lender):''}" placeholder="e.g. BPI, Jane, Mom"></div>
      <div class="field"><label>Borrower</label><input type="text" id="f-borrower" list="borrowerList" value="${existing?escapeHtml(existing.borrower):escapeHtml((earners()[0]||{}).name||'')}"><datalist id="borrowerList">${borrowers.map(b=>`<option value="${escapeHtml(b)}">`).join('')}</datalist></div>
    </div>
    <div class="field"><label>Repayment type</label>
      <select id="f-type">
        <option value="standard" ${type==='standard'?'selected':''}>Standard Loan</option>
        <option value="installment" ${type==='installment'?'selected':''}>Installment / Fixed Payment</option>
        <option value="flexible" ${type==='flexible'?'selected':''}>Flexible / No Fixed Due Date</option>
      </select>
    </div>
    <div class="field-row">
      <div class="field"><label>Principal / original amount (${currencySymbol()})</label><input type="number" id="f-principal" min="0" step="0.01" value="${existing?existing.principal:''}"></div>
      <div class="field"><label>Date borrowed</label><input type="date" id="f-dateBorrowed" value="${existing?existing.dateBorrowed:toISO(today)}"></div>
    </div>

    <div id="grp-standard">
      <div class="field"><label>Due date (optional)</label><input type="date" id="f-dueDate" value="${existing&&existing.dueDate?existing.dueDate:''}"></div>
      <div class="field"><label>Interest</label>
        <select id="f-interestMode">
          <option value="none" ${it.mode==='none'?'selected':''}>No interest</option>
          <option value="fixed" ${it.mode==='fixed'?'selected':''}>Fixed interest amount</option>
          <option value="percentage" ${it.mode==='percentage'?'selected':''}>Percentage interest</option>
          <option value="unknown" ${it.mode==='unknown'?'selected':''}>Unknown</option>
        </select>
      </div>
      <div class="field sub-interest-fixed"><label>Interest amount (${currencySymbol()})</label><input type="number" id="f-interestAmount" min="0" step="0.01" value="${it.amount||''}"></div>
      <div class="field-row sub-interest-percentage">
        <div class="field"><label>Interest %</label><input type="number" id="f-interestPercent" min="0" step="0.01" value="${it.percent||''}"></div>
        <div class="field"><label>Period</label>
          <select id="f-interestPeriod">
            <option value="onetime" ${it.percentPeriod==='onetime'?'selected':''}>One-time</option>
            <option value="monthly" ${it.percentPeriod==='monthly'?'selected':''}>Monthly</option>
            <option value="annual" ${it.percentPeriod==='annual'?'selected':''}>Annual</option>
          </select>
        </div>
      </div>
      <div class="field grp-latefee"><label>Late fee</label>
        <select id="f-lateFeeMode">
          <option value="none" ${lf.mode==='none'?'selected':''}>None</option>
          <option value="fixed" ${lf.mode==='fixed'?'selected':''}>Fixed amount</option>
          <option value="percentage" ${lf.mode==='percentage'?'selected':''}>Percentage of overdue amount</option>
        </select>
      </div>
      <div class="field sub-latefee-fixed grp-latefee"><label>Late fee amount (${currencySymbol()})</label><input type="number" id="f-lateFeeAmount" min="0" step="0.01" value="${lf.amount||''}"></div>
      <div class="field sub-latefee-percentage grp-latefee"><label>Late fee %</label><input type="number" id="f-lateFeePercent" min="0" step="0.01" value="${lf.percent||''}"></div>
    </div>

    <div id="grp-installment">
      <div class="field-row">
        <div class="field"><label>Monthly payment (${currencySymbol()})</label><input type="number" id="f-instPayment" min="0" step="0.01" value="${inst.monthlyPayment||''}"></div>
        <div class="field"><label>Number of installments</label><input type="number" id="f-instCount" min="1" value="${inst.numPayments||''}"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Start date</label><input type="date" id="f-instStart" value="${inst.startDate||toISO(today)}"></div>
        <div class="field"><label>Payment frequency</label>
          <select id="f-instFreq">
            <option value="monthly" ${inst.frequency==='monthly'?'selected':''}>Monthly</option>
            <option value="weekly" ${inst.frequency==='weekly'?'selected':''}>Weekly</option>
            <option value="biweekly" ${inst.frequency==='biweekly'?'selected':''}>Biweekly</option>
            <option value="custom" ${inst.frequency==='custom'?'selected':''}>Custom</option>
          </select>
        </div>
      </div>
      <div class="field"><label><input type="checkbox" id="f-instInterestKnown" ${inst.interestKnown?'checked':''} style="width:auto;margin-right:8px;">I know the interest amount</label></div>
      <div class="field sub-inst-interest"><label>Interest amount (${currencySymbol()})</label><input type="number" id="f-instInterestAmount" min="0" step="0.01" value="${inst.interestAmount||''}"></div>
    </div>

    <div id="grp-flexible" class="help-text">Flexible loans track principal paid down over time with no due date — they're never marked overdue.</div>
  `;
  openModal(existing?'Edit debt':'Add debt', body, ()=>{
    const lender = document.getElementById('f-lender').value.trim();
    const borrower = document.getElementById('f-borrower').value.trim() || 'Clai';
    const repaymentType = document.getElementById('f-type').value;
    const principal = Number(document.getElementById('f-principal').value)||0;
    const dateBorrowed = document.getElementById('f-dateBorrowed').value;
    if(!lender || !dateBorrowed || principal<=0){ showFormError('Enter a lender, date borrowed, and a principal amount.'); return false; }
    const debt = existing || {id:uid('debt'), payments:[]};
    debt.lender = lender; debt.borrower = borrower; debt.repaymentType = repaymentType;
    debt.principal = principal; debt.dateBorrowed = dateBorrowed;
    if(repaymentType==='standard'){
      debt.dueDate = document.getElementById('f-dueDate').value || null;
      const mode = document.getElementById('f-interestMode').value;
      debt.interest = {mode,
        amount: mode==='fixed' ? Number(document.getElementById('f-interestAmount').value)||0 : null,
        percent: mode==='percentage' ? Number(document.getElementById('f-interestPercent').value)||0 : null,
        percentPeriod: mode==='percentage' ? document.getElementById('f-interestPeriod').value : null
      };
      const lfMode = document.getElementById('f-lateFeeMode').value;
      debt.lateFee = {mode:lfMode,
        amount: lfMode==='fixed' ? Number(document.getElementById('f-lateFeeAmount').value)||0 : null,
        percent: lfMode==='percentage' ? Number(document.getElementById('f-lateFeePercent').value)||0 : null
      };
      debt.installment = null;
    } else if(repaymentType==='installment'){
      const monthlyPayment = Number(document.getElementById('f-instPayment').value)||0;
      const numPayments = Number(document.getElementById('f-instCount').value)||0;
      const startDate = document.getElementById('f-instStart').value;
      if(monthlyPayment<=0 || numPayments<=0 || !startDate){ showFormError('Enter monthly payment, number of installments, and a start date.'); return false; }
      const interestKnown = document.getElementById('f-instInterestKnown').checked;
      debt.installment = {monthlyPayment, numPayments, startDate, frequency:document.getElementById('f-instFreq').value,
        interestKnown, interestAmount: interestKnown ? (Number(document.getElementById('f-instInterestAmount').value)||0) : null};
      debt.dueDate = null;
      debt.interest = {mode:'none'};
      const lfMode = document.getElementById('f-lateFeeMode').value;
      debt.lateFee = {mode:lfMode,
        amount: lfMode==='fixed' ? Number(document.getElementById('f-lateFeeAmount').value)||0 : null,
        percent: lfMode==='percentage' ? Number(document.getElementById('f-lateFeePercent').value)||0 : null
      };
    } else { // flexible
      debt.dueDate = null;
      debt.interest = {mode:'none'};
      debt.lateFee = {mode:'none'};
      debt.installment = null;
    }
    if(!existing) state.debts.push(debt);
    saveState(); renderAll(); return true;
  }, {submitLabel:'Save'});

  function applyTypeVisibility(){
    const type = document.getElementById('f-type').value;
    document.getElementById('grp-standard').style.display = type==='standard' ? '' : 'none';
    document.getElementById('grp-installment').style.display = type==='installment' ? '' : 'none';
    document.getElementById('grp-flexible').style.display = type==='flexible' ? '' : 'none';
    document.querySelectorAll('.grp-latefee').forEach(el=> el.style.display = (type==='standard'||type==='installment') ? '' : 'none');
  }
  function applyInterestVisibility(){
    const mode = document.getElementById('f-interestMode').value;
    document.querySelector('.sub-interest-fixed').style.display = mode==='fixed' ? '' : 'none';
    document.querySelector('.sub-interest-percentage').style.display = mode==='percentage' ? '' : 'none';
  }
  function applyLateFeeVisibility(){
    const mode = document.getElementById('f-lateFeeMode').value;
    document.querySelector('.sub-latefee-fixed').style.display = mode==='fixed' ? '' : 'none';
    document.querySelector('.sub-latefee-percentage').style.display = mode==='percentage' ? '' : 'none';
  }
  function applyInstInterestVisibility(){
    document.querySelector('.sub-inst-interest').style.display = document.getElementById('f-instInterestKnown').checked ? '' : 'none';
  }
  document.getElementById('f-type').addEventListener('change', applyTypeVisibility);
  document.getElementById('f-interestMode').addEventListener('change', applyInterestVisibility);
  document.getElementById('f-lateFeeMode').addEventListener('change', applyLateFeeVisibility);
  document.getElementById('f-instInterestKnown').addEventListener('change', applyInstInterestVisibility);
  applyTypeVisibility(); applyInterestVisibility(); applyLateFeeVisibility(); applyInstInterestVisibility();
}

/* ---------- Modal: Record/edit a debt payment ---------- */
function openDebtPaymentModal(debtId, paymentId){
  const d = state.debts.find(x=>x.id===debtId);
  if(!d) return;
  const existing = paymentId ? d.payments.find(p=>p.id===paymentId) : null;
  const body = `
    <p class="small-muted">Recording a payment for ${escapeHtml(d.lender)} (${escapeHtml(d.borrower)}). Balance: <strong style="color:var(--ink);">${money(debtBalance(d))}</strong></p>
    <div class="field"><label>Payment date</label><input type="date" id="f-date" value="${existing?existing.date:toISO(today)}"></div>
    <div class="field"><label>Amount paid (${currencySymbol()})</label><input type="number" id="f-amount" min="0" step="0.01" value="${existing?existing.amount:''}"></div>
    <div class="field"><label>Note (optional)</label><input type="text" id="f-note" value="${existing?escapeHtml(existing.note||''):''}" placeholder="e.g. Extra payment"></div>
  `;
  openModal(existing?'Edit payment':'Record payment', body, ()=>{
    const date = document.getElementById('f-date').value;
    const amount = Number(document.getElementById('f-amount').value);
    const note = document.getElementById('f-note').value;
    if(!date || !amount || amount<=0){ showFormError('Enter a valid date and amount.'); return false; }
    if(existing){ existing.date=date; existing.amount=amount; existing.note=note; }
    else d.payments.push({id:uid('pay'), date, amount, note});
    saveState(); renderAll(); return true;
  });
}

function openRecurringManageModal(){ openRecurringModal(null); }
function openRecurringModal(id){
  const existing = id ? state.recurringBills.find(b=>b.id===id) : null;
  const initialSection = existing ? existing.section : 'necessities';
  const nowKey = monthKey(cur.year, cur.monthIndex);
  function mainOptionsHtml(section, selectedMain){
    const tree = getCategoryTree(section);
    const mains = tree.filter(c=> isCategoryActiveForMonth(c, nowKey) || c.name===selectedMain);
    return mains.map(c=>`<option value="${escapeHtml(c.name)}" ${selectedMain===c.name?'selected':''}>${escapeHtml(c.name)}</option>`).join('');
  }
  function subOptionsHtml(section, mainName, selectedSub){
    const main = getCategoryTree(section).find(c=>c.name===mainName);
    if(!main || !main.subs.length) return '';
    const subs = main.subs.filter(s=> isCategoryActiveForMonth(s, nowKey) || s.name===selectedSub);
    return subs.map(s=>`<option value="${escapeHtml(s.name)}" ${selectedSub===s.name?'selected':''}>${escapeHtml(s.name)}</option>`).join('');
  }
  const initialMain = existing ? existing.mainCategory : (getCategoryTree(initialSection)[0] ? getCategoryTree(initialSection)[0].name : '');
  const body = `
    <div class="field"><label>Expense name</label><input type="text" id="f-name" value="${existing?escapeHtml(existing.name):''}" placeholder="e.g. Internet"></div>
    <div class="field-row">
      <div class="field"><label>Section</label>
        <select id="f-section">
          <option value="necessities" ${initialSection==='necessities'?'selected':''}>Necessities</option>
          <option value="extra" ${initialSection==='extra'?'selected':''}>Extra expenses</option>
          <option value="playjar" ${initialSection==='playjar'?'selected':''}>Play jar</option>
        </select>
      </div>
      <div class="field"><label>Main category</label><select id="f-main">${mainOptionsHtml(initialSection, initialMain)}</select></div>
    </div>
    <div class="field" id="f-sub-wrap" style="display:none;"><label>Subcategory</label><select id="f-sub">${subOptionsHtml(initialSection, initialMain, existing?existing.subCategory:null)}</select></div>
    <div class="field-row">
      <div class="field"><label>Expected amount (${currencySymbol()})</label><input type="number" id="f-amount" min="0" step="0.01" value="${existing?existing.expectedAmount:''}"></div>
      <div class="field"><label>Frequency</label>
        <select id="f-freq">
          <option value="monthly" ${(!existing||existing.frequency==='monthly')?'selected':''}>Monthly</option>
          <option value="biweekly" ${existing&&existing.frequency==='biweekly'?'selected':''}>Every 2 weeks</option>
          <option value="weekly" ${existing&&existing.frequency==='weekly'?'selected':''}>Weekly</option>
          <option value="every2months" ${existing&&existing.frequency==='every2months'?'selected':''}>Every 2 months</option>
          <option value="quarterly" ${existing&&existing.frequency==='quarterly'?'selected':''}>Quarterly</option>
          <option value="yearly" ${existing&&existing.frequency==='yearly'?'selected':''}>Yearly</option>
          <option value="custom" ${existing&&existing.frequency==='custom'?'selected':''}>Custom (every N days)</option>
        </select>
      </div>
    </div>
    <div class="field" id="f-custom-wrap" style="display:none;"><label>Repeat every N days</label><input type="number" id="f-custom-days" min="1" value="${existing&&existing.customIntervalDays?existing.customIntervalDays:''}"></div>
    <div class="field-row">
      <div class="field"><label>Start date</label><input type="date" id="f-start" value="${existing?existing.startDate:toISO(today)}"></div>
      <div class="field"><label>End date (optional)</label><input type="date" id="f-end" value="${existing&&existing.endDate?existing.endDate:''}"></div>
    </div>
    <div class="field"><label>Notes (optional)</label><input type="text" id="f-notes" value="${existing?escapeHtml(existing.notes||''):''}"></div>
    <div class="field"><label><input type="checkbox" id="f-active" ${(!existing||existing.active)?'checked':''} style="width:auto;margin-right:8px;">Active</label></div>
  `;
  openModal(existing?'Edit recurring expense':'Add recurring expense', body, ()=>{
    const name = document.getElementById('f-name').value.trim();
    const section = document.getElementById('f-section').value;
    const mainCategory = document.getElementById('f-main').value;
    const subWrap = document.getElementById('f-sub-wrap');
    const subCategory = (subWrap.style.display!=='none') ? (document.getElementById('f-sub').value||null) : null;
    const expectedAmount = Number(document.getElementById('f-amount').value)||0;
    const frequency = document.getElementById('f-freq').value;
    const customIntervalDays = frequency==='custom' ? (Number(document.getElementById('f-custom-days').value)||30) : null;
    const startDate = document.getElementById('f-start').value;
    const endDate = document.getElementById('f-end').value || null;
    const notes = document.getElementById('f-notes').value;
    const active = document.getElementById('f-active').checked;
    if(!name || !startDate || expectedAmount<=0){ showFormError('Enter a name, start date, and an expected amount.'); return false; }
    if(existing){
      Object.assign(existing, {name, section, mainCategory, subCategory, expectedAmount, frequency, customIntervalDays, startDate, endDate, notes, active});
    } else {
      state.recurringBills.push({id:uid('rec'), name, section, mainCategory, subCategory, expectedAmount, frequency, customIntervalDays, startDate, endDate, notes, active});
    }
    saveState(); renderAll(); return true;
  });
  function refreshSub(){
    const section = document.getElementById('f-section').value;
    const mainName = document.getElementById('f-main').value;
    const html = subOptionsHtml(section, mainName, existing?existing.subCategory:null);
    document.getElementById('f-sub-wrap').style.display = html ? '' : 'none';
    document.getElementById('f-sub').innerHTML = html;
  }
  function refreshMain(){
    const section = document.getElementById('f-section').value;
    document.getElementById('f-main').innerHTML = mainOptionsHtml(section, existing&&existing.section===section?existing.mainCategory:'');
    refreshSub();
  }
  document.getElementById('f-section').addEventListener('change', refreshMain);
  document.getElementById('f-main').addEventListener('change', refreshSub);
  document.getElementById('f-freq').addEventListener('change', ()=>{
    document.getElementById('f-custom-wrap').style.display = document.getElementById('f-freq').value==='custom' ? '' : 'none';
  });
  refreshSub();
  document.getElementById('f-custom-wrap').style.display = frequency_initial_display();
  function frequency_initial_display(){ return (existing&&existing.frequency==='custom') ? '' : 'none'; }
}

/* =========================================================
   MODAL / CONFIRM / TOAST INFRASTRUCTURE
========================================================= */
function openModal(title, bodyHtml, onSubmit, opts){
  opts = opts||{};
  closeMenu();
  _modalOnClose = opts.onClose || null;
  const root = document.getElementById('modalRoot');
  const dismissable = opts.dismissable!==false;
  root.innerHTML = `
    <div class="modal-backdrop" id="modalBackdrop">
      <div class="modal-card ${opts.wide?'wide':''}" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
        <div class="modal-header"><h3 id="modalTitle">${title}</h3>${dismissable?`<button class="icon-btn" data-close-modal aria-label="Close">${icon('x')}</button>`:''}</div>
        <form id="modalBody" novalidate>${bodyHtml}</form>
        <div class="modal-actions">
          ${dismissable && !opts.hideCancel?'<button type="button" class="btn btn-ghost" data-close-modal>Cancel</button>':''}
          <button type="button" class="btn ${opts.danger?'btn-danger-solid':'btn-primary'}" id="modalSubmitBtn">${opts.submitLabel||'Save'}</button>
        </div>
      </div>
    </div>`;
  const submit = ()=>{
    const ok = onSubmit();
    if(ok!==false) closeModal();
  };
  document.getElementById('modalSubmitBtn').addEventListener('click', submit);
  // Enter submits single-line fields (but not textareas or selects).
  document.getElementById('modalBody').addEventListener('submit', (e)=>{ e.preventDefault(); submit(); });
  document.getElementById('modalBody').addEventListener('keydown', (e)=>{
    if(e.key==='Enter' && e.target.tagName==='INPUT' && !['checkbox','radio','button'].includes(e.target.type)){ e.preventDefault(); submit(); }
  });
  root.querySelectorAll('[data-close-modal]').forEach(b=>b.addEventListener('click', closeModal));
  if(dismissable) root.querySelector('#modalBackdrop').addEventListener('mousedown', (e)=>{ if(e.target.id==='modalBackdrop') closeModal(); });
  if(dismissable) document.addEventListener('keydown', modalEsc);
  enhanceForm(document.getElementById('modalBody'));
  wireIconFields(document.getElementById('modalBody'));
  const first = root.querySelector('#modalBody #f-amount') || root.querySelector('#modalBody input:not([type=hidden]):not([type=checkbox]):not([type=date]), #modalBody select');
  if(first && window.matchMedia('(min-width:901px)').matches) setTimeout(()=>first.focus(), 40);
}
function modalEsc(e){
  if(e.key!=='Escape' || document.getElementById('dialogRoot').children.length || document.getElementById('popoverRoot').children.length) return;
  const closeBtn = document.querySelector('#modalRoot [data-close-modal]');
  if(closeBtn) closeBtn.click(); else closeModal();
}
let _modalOnClose = null;
function closeModal(){
  document.getElementById('modalRoot').innerHTML=''; document.removeEventListener('keydown', modalEsc);
  const cb = _modalOnClose; _modalOnClose = null; if(cb) cb();
}
function showFormError(msg){
  let el = document.getElementById('f-error');
  if(!el){
    el = document.createElement('div'); el.id='f-error'; el.className='warn-text';
    document.getElementById('modalBody').appendChild(el);
  }
  el.textContent = msg; el.style.display='block';
}
/* Confirmation for bigger, harder-to-undo actions. */
function confirmModal(msg, onYes, opts){
  opts = opts || {};
  const destructive = /^(delete|reset|remove)/i.test(msg);
  const verb = (msg.match(/^(delete|reset|remove)/i)||[])[1];
  confirmDialog(opts.title || (destructive ? `${verb.charAt(0).toUpperCase()+verb.slice(1).toLowerCase()}?` : 'Are you sure?'), msg,
    {tone: destructive ? 'danger' : (opts.tone||'warn'), confirmLabel: opts.confirmLabel || (destructive ? verb.charAt(0).toUpperCase()+verb.slice(1).toLowerCase() : 'Continue')})
    .then(ok=>{ if(ok) onYes(); });
}
/* =========================================================
   DATA EXPORT / IMPORT
========================================================= */
function exportData(){
  const blob = new Blob([JSON.stringify(state, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = APP_CONFIG.appName.toLowerCase().replace(/[^a-z0-9]+/g,'-')+'-backup-'+toISO(today)+'.json';
  state.settings.lastExportAt = new Date().toISOString();
  setTimeout(()=>{ saveState(); renderAlertBell(); }, 0);
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
function handleImport(e){
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = (ev)=>{
    try{
      const parsed = coerceState(JSON.parse(ev.target.result));
      confirmModal('Importing will replace all current data. Continue?', ()=>{
        state = parsed; saveState(); renderAll(); toast('Data imported');
      });
    }catch(err){ alertDialog('Couldn’t import that file', 'Choose a backup (.json) that was exported from this app.', 'danger'); }
    e.target.value = '';
  };
  reader.readAsText(file);
}

/* =========================================================
   INIT — rendering starts from bootApp(), once cloud.js has loaded the user's data.
========================================================= */
