/* =========================================================
   ACCOUNTS + CLOUD SYNC (Supabase)
   Each user's whole budget is stored as one JSON document in the `finance_data` table, guarded by
   Row Level Security so a signed-in user can only ever read or write their own row.
   Saves are debounced and use optimistic concurrency (the `rev` column): if another device or tab
   saved in the meantime, the user is asked which version to keep instead of silently overwriting.
========================================================= */
(function(){
  const cfg = window.APP_CONFIG || {};
  const appName = cfg.appName || 'Budget';
  const GUEST_KEY = 'kaban_guest_data_v1';
  const MODE_KEY = 'kaban_mode';
  const TABLE = 'finance_data';
  const SAVE_DEBOUNCE_MS = 800;

  // Read auth redirect info before the Supabase client consumes the URL.
  const urlParams = new URLSearchParams(location.hash.replace(/^#/, '') + '&' + location.search.replace(/^\?/, ''));
  let recovering = urlParams.get('type') === 'recovery';
  const redirectError = urlParams.get('error_description');

  const cloudConfigured = !!(cfg.supabaseUrl && cfg.supabaseAnonKey);
  let sb = null;
  if(cloudConfigured){
    if(window.supabase && window.supabase.createClient) sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    else console.error('Supabase library failed to load.');
  }

  let mode = null;        // 'cloud' | 'guest'
  let user = null;
  let booted = false;
  let rev = 0;            // server revision our in-memory data is based on (0 = no row saved yet)
  let latest = null;      // newest state object handed to persist()
  let dirty = false, saving = false, conflict = false;
  let saveTimer = null, retryDelay = 2000, lastError = null;

  const siteUrl = location.origin + location.pathname;
  const authRoot = document.getElementById('authRoot');
  const appEl = document.getElementById('app');

  /* ---------- branding ---------- */
  document.title = `${appName} — Personal Finance Journal`;
  document.querySelectorAll('[data-app-name]').forEach(el=> el.textContent = appName);


  /* ---------- helpers ---------- */
  const esc = s => String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function readGuest(){
    try{ const raw = localStorage.getItem(GUEST_KEY); return raw ? JSON.parse(raw) : null; }catch(e){ return null; }
  }
  function hasGuestData(){
    const g = readGuest();
    return !!(g && g.months && (Object.keys(g.months).length || (g.debts||[]).length || (g.settings && g.settings.onboarded)));
  }
  function setMode(m){ try{ m ? localStorage.setItem(MODE_KEY, m) : localStorage.removeItem(MODE_KEY); }catch(e){} }
  function getMode(){ try{ return localStorage.getItem(MODE_KEY); }catch(e){ return null; } }
  function friendlyError(err){
    const msg = (err && (err.message || err.error_description)) || String(err||'Unknown error');
    if(/failed to fetch|network|load failed/i.test(msg)) return 'Can’t reach the server. Check your connection.';
    if(/invalid login credentials/i.test(msg)) return 'Incorrect email or password.';
    if(/email not confirmed/i.test(msg)) return 'Please confirm your email first — check your inbox for the link.';
    if(/rate limit/i.test(msg)) return 'Too many attempts. Please wait a few minutes and try again.';
    return msg;
  }

  /* Small promise-based chooser using the app's modal styling. buttons: [{key,label,primary,danger}] */
  function choose(title, html, buttons){
    return new Promise(resolve=>{
      const root = document.getElementById('modalRoot');
      root.innerHTML = `<div class="modal-backdrop"><div class="modal-card">
        <div class="modal-header"><h3>${esc(title)}</h3></div>
        <div id="modalBody">${html}</div>
        <div class="modal-actions">${buttons.map(b=>`<button type="button" class="btn ${b.primary?'btn-primary':''} ${b.danger?'btn-danger':''}" data-choice="${b.key}">${esc(b.label)}</button>`).join('')}</div>
      </div></div>`;
      root.querySelectorAll('[data-choice]').forEach(btn=> btn.addEventListener('click', ()=>{ root.innerHTML=''; resolve(btn.dataset.choice); }));
    });
  }

  /* ---------- auth screen ---------- */
  function showAuth(view, message, isError){
    appEl.hidden = true;
    const msg = message ? `<div class="auth-msg ${isError?'error':''}">${esc(message)}</div>` : '';
    const guestLink = `<button type="button" class="linkbtn" data-auth="guest">Try it without an account</button>`;
    let inner = '';
    if(view==='signin'){
      inner = `<h2>Welcome back</h2><p class="auth-sub">Sign in to see your budget on any device.</p>${msg}
        <form data-form="signin">
          <div class="field"><label>Email</label><input type="email" name="email" autocomplete="email" required></div>
          <div class="field"><label>Password</label><input type="password" name="password" autocomplete="current-password" required></div>
          <button class="btn btn-primary auth-submit" type="submit">Sign in</button>
        </form>
        <div class="auth-links"><button type="button" class="linkbtn" data-auth="forgot">Forgot password?</button>
        <span>New here? <button type="button" class="linkbtn" data-auth="signup">Create an account</button></span></div>
        <div class="auth-alt">${guestLink}</div>`;
    } else if(view==='signup'){
      inner = `<h2>Create your account</h2><p class="auth-sub">Free. Your budget syncs across your phone and computer.</p>${msg}
        <form data-form="signup">
          <div class="field"><label>Email</label><input type="email" name="email" autocomplete="email" required></div>
          <div class="field"><label>Password</label><input type="password" name="password" autocomplete="new-password" minlength="8" required><div class="help-text">At least 8 characters.</div></div>
          <button class="btn btn-primary auth-submit" type="submit">Create account</button>
        </form>
        <div class="auth-links"><span>Already have an account? <button type="button" class="linkbtn" data-auth="signin">Sign in</button></span></div>
        <div class="auth-alt">${guestLink}</div>`;
    } else if(view==='forgot'){
      inner = `<h2>Reset your password</h2><p class="auth-sub">We’ll email you a link to choose a new one.</p>${msg}
        <form data-form="forgot">
          <div class="field"><label>Email</label><input type="email" name="email" autocomplete="email" required></div>
          <button class="btn btn-primary auth-submit" type="submit">Send reset link</button>
        </form>
        <div class="auth-links"><button type="button" class="linkbtn" data-auth="signin">Back to sign in</button></div>`;
    } else if(view==='reset'){
      inner = `<h2>Choose a new password</h2>${msg}
        <form data-form="reset">
          <div class="field"><label>New password</label><input type="password" name="password" autocomplete="new-password" minlength="8" required></div>
          <div class="field"><label>Confirm new password</label><input type="password" name="confirm" autocomplete="new-password" minlength="8" required></div>
          <button class="btn btn-primary auth-submit" type="submit">Save password</button>
        </form>`;
    } else if(view==='check-email'){
      inner = `<h2>Check your email</h2><p class="auth-sub">${esc(message)}</p>
        <div class="auth-links"><button type="button" class="linkbtn" data-auth="signin">Back to sign in</button></div>`;
    } else if(view==='loading'){
      inner = `<p class="auth-sub" style="text-align:center;margin:30px 0;">${esc(message||'Loading your budget…')}</p>`;
    } else if(view==='error'){
      inner = `<h2>Something went wrong</h2><div class="auth-msg error">${esc(message)}</div>
        <button class="btn btn-primary auth-submit" type="button" data-auth="retry">Try again</button>
        <div class="auth-links"><button type="button" class="linkbtn" data-auth="signout">Sign out</button></div>`;
    }
    const scene = (typeof authSceneSVG==='function') ? `<div class="auth-scene"><div class="hand">Good plans,<br>brighter days ♡</div>${authSceneSVG()}</div>` : '';
    authRoot.innerHTML = `<div class="auth-screen"><div class="auth-split">${scene}<div class="auth-card">
      <div class="brand auth-brand">${typeof brandLogoSVG==='function'?brandLogoSVG():''}<div class="brand-text"><div class="brand-name">${esc(appName)}</div></div></div>
      ${inner}
      <p class="auth-foot">Your budget is private to your account. It’s stored securely in the cloud and never shared or sold.</p>
    </div></div></div>`;
    authRoot.hidden = false;
    const firstInput = authRoot.querySelector('input'); if(firstInput) firstInput.focus();
    authRoot.querySelectorAll('[data-auth]').forEach(b=> b.addEventListener('click', ()=> onAuthLink(b.dataset.auth)));
    const form = authRoot.querySelector('form');
    if(form) form.addEventListener('submit', (e)=>{ e.preventDefault(); onAuthSubmit(form.dataset.form, form); });
  }
  function hideAuth(){ authRoot.hidden = true; authRoot.innerHTML = ''; }

  function onAuthLink(what){
    if(what==='guest') return startGuest();
    if(what==='retry') return location.reload();
    if(what==='signout') return signOut();
    showAuth(what);
  }
  async function onAuthSubmit(kind, form){
    const btn = form.querySelector('.auth-submit');
    const fd = new FormData(form);
    const email = String(fd.get('email')||'').trim();
    const password = String(fd.get('password')||'');
    btn.disabled = true; const label = btn.textContent; btn.textContent = 'Please wait…';
    try{
      if(kind==='signin'){
        const {error} = await sb.auth.signInWithPassword({email, password});
        if(error) throw error;
        // onAuthStateChange(SIGNED_IN) takes it from here
      } else if(kind==='signup'){
        if(password.length < 8) throw new Error('Password must be at least 8 characters.');
        const {data, error} = await sb.auth.signUp({email, password, options:{emailRedirectTo: siteUrl}});
        if(error) throw error;
        if(!data.session) showAuth('check-email', `We sent a confirmation link to ${email}. Click it to activate your account, then sign in.`);
      } else if(kind==='forgot'){
        const {error} = await sb.auth.resetPasswordForEmail(email, {redirectTo: siteUrl});
        if(error) throw error;
        showAuth('check-email', `If an account exists for ${email}, a password reset link is on its way.`);
      } else if(kind==='reset'){
        if(password.length < 8) throw new Error('Password must be at least 8 characters.');
        if(password !== String(fd.get('confirm')||'')) throw new Error('Passwords don’t match.');
        const {error} = await sb.auth.updateUser({password});
        if(error) throw error;
        recovering = false;
        history.replaceState(null, '', siteUrl);
        const {data} = await sb.auth.getSession();
        if(data.session) await startCloud(data.session.user); else showAuth('signin', 'Password updated. Please sign in.');
      }
    }catch(err){
      showAuth(kind, friendlyError(err), true);
      const emailInput = authRoot.querySelector('input[name=email]'); if(emailInput) emailInput.value = email;
      return;
    }
    if(btn.isConnected){ btn.disabled = false; btn.textContent = label; }
  }

  /* ---------- starting a session ---------- */
  function startGuest(){
    mode = 'guest'; setMode('guest'); booted = true;
    hideAuth();
    bootApp(readGuest());
  }
  let starting = false;
  async function startCloud(u){
    if(starting || (booted && user && user.id===u.id)) return;
    starting = true;
    user = u; mode = 'cloud'; setMode(null);
    showAuth('loading');
    const {data, error} = await sb.from(TABLE).select('data, rev').eq('user_id', u.id).maybeSingle();
    starting = false;
    if(error){ showAuth('error', friendlyError(error)); return; }
    hideAuth();
    booted = true;
    if(data){
      rev = data.rev;
      bootApp(data.data);
      return;
    }
    rev = 0;
    if(hasGuestData()){
      const pick = await choose('Bring your data along?',
        `<p style="font-size:14px;line-height:1.6;">You have a budget saved on this device from using ${esc(appName)} without an account. Do you want to copy it into your new account?</p>`,
        [{key:'fresh', label:'Start fresh'}, {key:'import', label:'Yes, copy it', primary:true}]);
      if(pick==='import'){
        bootApp(readGuest());
        persist(getState());
        try{ localStorage.removeItem(GUEST_KEY); }catch(e){}
        return;
      }
    }
    bootApp(null);
  }
  async function signOut(){
    if(dirty || saving){
      const pick = await choose('Unsaved changes', '<p style="font-size:14px;">Some changes haven’t finished saving yet. Sign out anyway?</p>',
        [{key:'stay', label:'Stay'}, {key:'go', label:'Sign out', danger:true}]);
      if(pick!=='go') return;
    }
    dirty = false;
    if(sb) await sb.auth.signOut();
    setMode(null);
    location.replace(siteUrl);
  }

  /* ---------- saving ---------- */
  function persist(s){
    latest = s;
    if(mode==='guest'){
      try{ localStorage.setItem(GUEST_KEY, JSON.stringify(s)); lastError = null; }
      catch(e){ lastError = 'This browser’s storage is full or blocked.'; }
      renderStatus();
      return;
    }
    if(mode!=='cloud') return;
    dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, SAVE_DEBOUNCE_MS);
    renderStatus();
  }
  async function flush(){
    clearTimeout(saveTimer); saveTimer = null;
    if(mode!=='cloud' || saving || conflict || !dirty || !latest) return;
    saving = true; dirty = false; renderStatus();
    const snapshot = JSON.parse(JSON.stringify(latest));
    let failed = false;
    try{
      let res;
      if(rev===0){
        res = await sb.from(TABLE).insert({user_id:user.id, data:snapshot, rev:1}).select('rev');
        if(res.error && res.error.code==='23505'){ saving = false; dirty = true; return handleConflict(); }
      } else {
        res = await sb.from(TABLE).update({data:snapshot, rev:rev+1, updated_at:new Date().toISOString()})
          .eq('user_id', user.id).eq('rev', rev).select('rev');
        if(!res.error && (!res.data || !res.data.length)){ saving = false; dirty = true; return handleConflict(); }
      }
      if(res.error) throw res.error;
      rev = res.data[0].rev;
      lastError = null; retryDelay = 2000;
    }catch(err){
      failed = true;
      dirty = true;
      lastError = friendlyError(err);
    }
    saving = false;
    if(dirty){
      saveTimer = setTimeout(flush, failed ? retryDelay : SAVE_DEBOUNCE_MS);
      if(failed) retryDelay = Math.min(retryDelay*2, 60000);
    }
    renderStatus();
  }
  async function fetchServer(){
    const {data, error} = await sb.from(TABLE).select('data, rev').eq('user_id', user.id).maybeSingle();
    if(error) throw error;
    return data;
  }
  async function handleConflict(){
    conflict = true; renderStatus();
    let server;
    try{ server = await fetchServer(); }
    catch(err){ conflict = false; dirty = true; lastError = friendlyError(err); saveTimer = setTimeout(flush, retryDelay); renderStatus(); return; }
    const pick = await choose('Changed on another device',
      `<p style="font-size:14px;line-height:1.6;">Your budget was updated from another device or browser tab since this page loaded. Which version do you want to keep?</p>
       <p class="small-muted">“Use the other version” discards the changes you just made here. “Keep this version” overwrites the changes made elsewhere.</p>`,
      [{key:'mine', label:'Keep this version'}, {key:'theirs', label:'Use the other version', primary:true}]);
    conflict = false;
    if(!server){ rev = 0; dirty = true; return flush(); } // row was deleted elsewhere: recreate it
    rev = server.rev;
    if(pick==='theirs'){ dirty = false; replaceState(server.data); toast('Loaded the latest version'); renderStatus(); }
    else { dirty = true; flush(); }
  }
  /* When the tab regains focus, quietly pick up changes saved from another device. */
  async function refreshIfStale(){
    if(mode!=='cloud' || !booted || dirty || saving || conflict || document.getElementById('modalRoot').children.length) return;
    try{
      const {data, error} = await sb.from(TABLE).select('rev').eq('user_id', user.id).maybeSingle();
      if(error || !data || data.rev <= rev) return;
      const server = await fetchServer();
      if(!server || dirty || saving) return;
      rev = server.rev;
      replaceState(server.data);
      toast('Updated with changes from another device');
    }catch(e){ /* offline — try again next time */ }
  }

  /* ---------- status + account UI (called from app.js) ---------- */
  function renderStatus(){
    const els = document.querySelectorAll('[data-sync-status]');
    if(!els.length) return;
    let text, tone;
    if(mode==='guest'){
      text = lastError || (cloudConfigured ? 'Saved on this device only' : 'Local mode — saved in this browser');
      tone = lastError ? 'bad' : 'warn';
    } else if(conflict){ text = 'Needs your attention'; tone = 'warn'; }
    else if(saving){ text = 'Saving…'; tone = 'busy'; }
    else if(lastError){ text = 'Not saved — retrying. ' + lastError; tone = 'bad'; }
    else if(dirty){ text = 'Saving…'; tone = 'busy'; }
    else { text = 'All changes saved'; tone = 'ok'; }
    els.forEach(el=>{
      el.innerHTML = `<span class="sync-dot ${tone}"></span><span>${esc(text)}</span>`;
      el.title = (user ? `Signed in as ${user.email}. ` : '') + text;
    });
  }
  function accountSettingsHtml(){
    if(mode==='cloud'){
      return `<div class="card settings-group">
        <h4>Account</h4>
        <p class="small-muted" style="margin-top:-6px;margin-bottom:14px;">Signed in as <strong style="color:var(--ink);">${esc(user.email)}</strong></p>
        <div class="btn-row">
          <button class="btn" data-action="account-change-password">Change password</button>
          <button class="btn" data-action="account-signout">Sign out</button>
          <button class="btn btn-danger" data-action="account-delete">Delete account</button>
        </div>
      </div>`;
    }
    return `<div class="card settings-group">
      <h4>Account</h4>
      <p class="small-muted" style="margin-top:-6px;margin-bottom:14px;">You’re using ${esc(appName)} without an account, so your data is saved only in this browser. Clearing your browser data will erase it.${cloudConfigured?' Create a free account to keep it safe and use it on other devices.':''}</p>
      ${cloudConfigured?`<div class="btn-row"><button class="btn btn-primary" data-action="account-create">Create account / Sign in</button></div>`:''}
    </div>`;
  }
  function handleAction(action){
    if(action==='account-signout'){ signOut(); return true; }
    if(action==='account-create'){ setMode(null); mode = null; booted = false; showAuth('signup'); return true; }
    if(action==='account-change-password'){
      openModal('Change password', `
        <div class="field"><label>New password</label><input type="password" id="f-newpw" autocomplete="new-password" minlength="8"></div>
        <div class="field"><label>Confirm new password</label><input type="password" id="f-newpw2" autocomplete="new-password" minlength="8"></div>`, ()=>{
        const pw = document.getElementById('f-newpw').value, pw2 = document.getElementById('f-newpw2').value;
        if(pw.length < 8){ showFormError('Password must be at least 8 characters.'); return false; }
        if(pw !== pw2){ showFormError('Passwords don’t match.'); return false; }
        const btn = document.getElementById('modalSubmitBtn'); btn.disabled = true;
        sb.auth.updateUser({password:pw}).then(({error})=>{
          if(error){ btn.disabled = false; showFormError(friendlyError(error)); return; }
          closeModal(); toast('Password changed');
        });
        return false;
      });
      return true;
    }
    if(action==='account-delete'){
      openModal('Delete account', `
        <p style="font-size:14px;line-height:1.6;">This permanently deletes your account and <strong>all of your budget data</strong>. It can’t be undone. Consider exporting a backup first.</p>
        <div class="field"><label>Type DELETE to confirm</label><input type="text" id="f-confirm-delete" autocomplete="off"></div>`, ()=>{
        if(document.getElementById('f-confirm-delete').value.trim() !== 'DELETE'){ showFormError('Type DELETE to confirm.'); return false; }
        const btn = document.getElementById('modalSubmitBtn'); btn.disabled = true; btn.textContent = 'Deleting…';
        sb.rpc('delete_my_account').then(async ({error})=>{
          if(error){ btn.disabled = false; btn.textContent = 'Delete forever'; showFormError(friendlyError(error)); return; }
          dirty = false; mode = null;
          try{ await sb.auth.signOut(); }catch(e){}
          location.replace(siteUrl);
        });
        return false;
      }, {submitLabel:'Delete forever'});
      return true;
    }
    return false;
  }

  function accountInfo(){ return {mode, email: user ? user.email : null, cloudConfigured}; }
  window.Store = { persist, renderStatus, accountSettingsHtml, handleAction, flush, accountInfo };

  /* ---------- page lifecycle ---------- */
  window.addEventListener('beforeunload', (e)=>{
    if(mode==='cloud' && (dirty || saving)){ flush(); e.preventDefault(); e.returnValue = ''; }
  });
  document.addEventListener('visibilitychange', ()=>{
    if(document.visibilityState==='hidden') flush();
    else refreshIfStale();
  });
  window.addEventListener('online', ()=>{ retryDelay = 2000; flush(); });

  /* ---------- boot ---------- */
  async function init(){
    if(!sb){
      if(cloudConfigured){ showAuth('error', 'Couldn’t load the sign-in service. Check your connection and reload.'); return; }
      return startGuest(); // no Supabase configured: local-only mode
    }
    sb.auth.onAuthStateChange((event, session)=>{
      // Defer: calling Supabase from inside this callback can deadlock the auth client.
      setTimeout(()=>{
        if(event==='PASSWORD_RECOVERY'){ recovering = true; showAuth('reset'); return; }
        if(event==='SIGNED_IN' && session && !recovering && !booted) startCloud(session.user);
        if(event==='SIGNED_OUT' && mode==='cloud'){ mode = null; location.replace(siteUrl); }
      }, 0);
    });
    showAuth('loading', 'Loading…');
    const {data} = await sb.auth.getSession();
    if(recovering){ showAuth('reset'); return; }
    if(data.session){ await startCloud(data.session.user); return; }
    if(getMode()==='guest') return startGuest();
    if(redirectError) return showAuth('signin', redirectError.replace(/\+/g,' '), true);
    showAuth('signin');
  }
  init();
})();
