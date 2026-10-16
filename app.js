/* Debit Hours — phone app (offline-capable). Talks to the Apps Script backend in the Google Sheet. */
(function () {
  'use strict';

  const APP_BUILD = '1.3 · Oct 16, 2026'; // shown at the bottom of the screens — bump it so you can tell when phones have the update
  const CFG = window.APP_CONFIG || {};
  const API = String(CFG.API_URL || '').trim();
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
  const fmtH = n => (n == null ? '—' : String(round2(n)));
  const hrs = n => fmtH(n) + (round2(n) === 1 ? ' hr' : ' hrs');
  const p2 = n => (n < 10 ? '0' : '') + n;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } },
  };
  const K = { member: 'dh.member', admin: 'dh.admin', status: 'dh.status', queue: 'dh.queue', dash: 'dh.dash', cat: 'dh.lastCat', pay: 'dh.lastPay', email: 'dh.lastEmail', names: 'dh.names', lastName: 'dh.lastName' };
  const PAY = [['Overtime', 'Overtime'], ['Debit Reduction', 'Debit reduction'], ['Split', 'Split']];
  // Entries saved by the first version of the app had no pay type: they were debit reduction.
  const qDebit = q => (q.payType === 'Split' ? q.debit : q.payType === 'Overtime' ? 0 : q.hours);
  const qOt = q => (q.payType === 'Split' ? q.ot : q.payType === 'Overtime' ? q.hours : 0);
  const payText = e => (e.payType === 'Overtime' ? 'Overtime' : e.payType === 'Split' ? 'Split' : 'Debit');

  const S = {
    member: store.get(K.member, null),
    admin: store.get(K.admin, null),
    status: store.get(K.status, null),
    queue: store.get(K.queue, []),
    dash: store.get(K.dash, null),
    names: store.get(K.names, []), namesLoaded: false, namesError: '',
    tab: 'members', edits: {}, filter: '', sort: 'name', open: null, entryCat: 'All',
    syncing: false, loadingDash: false, lastError: '', installEvt: null,
  };
  const save = k => store.set(K[k], S[k]);

  /* ───────── dates ───────── */
  function todayYmd() { const d = new Date(); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
  function pretty(ymd, noYear) {
    if (!ymd) return '';
    const p = ymd.split('-').map(Number);
    return MONTHS[p[1] - 1] + ' ' + p[2] + (noYear ? '' : ', ' + p[0]);
  }
  function weekday(ymd) { const p = ymd.split('-').map(Number); return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(p[0], p[1] - 1, p[2]).getDay()]; }
  function daysUntil(ymd) {
    const p = ymd.split('-').map(Number);
    const now = new Date(); now.setHours(0, 0, 0, 0);
    return Math.round((new Date(p[0], p[1] - 1, p[2]) - now) / 864e5);
  }
  function ago(iso) {
    if (!iso) return '';
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    if (m < 1440) return Math.round(m / 60) + ' hr ago';
    return Math.round(m / 1440) + ' days ago';
  }
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12));

  /* ───────── API ───────── */
  class ApiError extends Error { constructor(m, c) { super(m); this.code = c; } }
  async function api(action, data) {
    if (!API || /PASTE_YOUR/.test(API)) throw new ApiError('The app isn\'t connected to the sheet yet — put the Web App URL in config.js.', 'CONFIG');
    let res;
    try {
      res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action: action }, data || {})),
        redirect: 'follow',
      });
    } catch (e) { throw new ApiError('No connection right now.', 'OFFLINE'); }
    let j;
    try { j = await res.json(); } catch (e) { throw new ApiError('Unexpected reply from the sheet. Check the Web App URL and that it is deployed with access "Anyone".', 'BAD'); }
    if (!j.ok) throw new ApiError(j.error || 'Something went wrong.', j.code || 'ERROR');
    return j;
  }

  /* ───────── toast & pill ───────── */
  let toastTimer;
  function toast(msg, kind) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast ' + (kind || '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
  }
  const myQueue = () => (S.member ? S.queue.filter(q => q.email === S.member.email) : []);
  function renderPill() {
    const pill = $('#pill');
    const n = myQueue().length;
    let txt, cls;
    if (!navigator.onLine) { txt = 'Offline' + (n ? ' · ' + n + ' waiting' : ''); cls = 'off'; }
    else if (S.syncing) { txt = 'Uploading…'; cls = 'busy'; }
    else if (n) { txt = n + ' waiting'; cls = 'wait'; }
    else { txt = 'Online'; cls = 'ok'; }
    pill.textContent = txt;
    pill.className = 'pill ' + cls;
  }

  /* ───────── member data ───────── */
  function derived() {
    const st = S.status;
    if (!st) return null;
    const pend = myQueue().filter(q => q.date >= st.cycleStart && q.date < st.deadline);
    const pendHours = round2(pend.reduce((a, q) => a + q.hours, 0));
    const pendDebit = round2(pend.reduce((a, q) => a + qDebit(q), 0));
    const pendOt = round2(pend.reduce((a, q) => a + qOt(q), 0));
    const worked = round2(st.worked + pendDebit);
    const overtime = round2((st.overtime || 0) + pendOt);
    const remaining = st.obligated == null ? null : Math.max(0, round2(st.obligated - worked));
    const pct = st.obligated ? Math.min(100, Math.round(worked / st.obligated * 100)) : (st.obligated === 0 ? 100 : 0);
    return { st, worked, overtime, remaining, pct, pendHours };
  }

  async function refreshStatus(quiet) {
    if (!S.member || !navigator.onLine) return;
    try {
      const r = await api('me', { token: S.member.token });
      S.status = r.status; save('status');
      if (S.member.expired) { S.member.expired = false; save('member'); }
      render();
    } catch (e) { handleMemberError(e, quiet); }
  }

  function handleMemberError(e, quiet) {
    if (e.code === 'AUTH') {
      S.member = Object.assign({}, S.member, { expired: true }); save('member');
      render();
      if (!quiet) toast(e.message, 'bad');
    } else if (!quiet && e.code !== 'OFFLINE') toast(e.message, 'bad');
  }

  async function sync(quiet) {
    if (!S.member || S.member.expired || S.syncing || !navigator.onLine) { renderPill(); return; }
    const batch = myQueue();
    if (!batch.length) { renderPill(); return; }
    S.syncing = true; renderPill();
    try {
      const r = await api('logHours', { token: S.member.token, entries: batch.map(q => ({ id: q.id, date: q.date, category: q.category, payType: q.payType || 'Debit Reduction', hours: q.hours, debitHours: qDebit(q), otHours: qOt(q), notes: q.notes })) });
      const done = {};
      r.accepted.forEach(id => { done[id] = true; });
      r.rejected.forEach(x => { done[x.id] = true; });
      S.queue = S.queue.filter(q => !done[q.id]); save('queue');
      S.status = r.status; save('status');
      if (r.rejected.length) {
        const map = {}; batch.forEach(q => { map[q.id] = q; });
        alert('Some entries were not accepted:\n\n' + r.rejected.map(x => {
          const q = map[x.id] || {};
          return '• ' + pretty(q.date) + ' ' + (q.category || '') + ' ' + (q.hours || '') + ' hrs — ' + x.reason;
        }).join('\n'));
      }
      if (r.added) {
        const em = r.emailed && r.emailed.errors && r.emailed.errors.length ? ' (email problem — tell an admin)' : ' — confirmation emailed';
        toast(hrs(batch.filter(q => done[q.id] && !r.rejected.some(x => x.id === q.id)).reduce((a, q) => a + q.hours, 0)) + ' uploaded' + em, 'good');
      }
    } catch (e) {
      handleMemberError(e, quiet);
    } finally {
      S.syncing = false;
      render();
    }
  }

  /* ───────── views: member ───────── */
  /* ───────── searchable name list ───────── */
  const norm = v => String(v || '').toLowerCase().replace(/\s+/g, ' ').trim();
  function filterNames(q) {
    q = norm(q);
    if (!q) return S.names.slice();
    const starts = [], word = [], has = [];
    S.names.forEach(n => {
      const l = norm(n);
      if (l.indexOf(q) === 0) starts.push(n);
      else if (l.split(' ').some(w => w.indexOf(q) === 0)) word.push(n);
      else if (l.indexOf(q) > 0) has.push(n);
    });
    return starts.concat(word, has);
  }
  function hilite(name, q) {
    q = norm(q);
    const l = name.toLowerCase();
    let i = q ? l.indexOf(q) : -1;
    if (i > 0) { const w = l.search(new RegExp('(^|\\s)' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))); if (w >= 0) i = w + (l[w] === ' ' ? 1 : 0); }
    if (i < 0) return esc(name);
    return esc(name.slice(0, i)) + '<mark>' + esc(name.slice(i, i + q.length)) + '</mark>' + esc(name.slice(i + q.length));
  }
  function nameListHtml(q) {
    if (!S.names.length) {
      return `<li class="nl-empty">${S.namesLoaded ? 'No members found in the sheet.' : (S.namesError || 'Loading names…')}</li>`;
    }
    const list = filterNames(q);
    if (!list.length) return '<li class="nl-empty">No name matches "' + esc(q) + '"</li>';
    return list.map((n, i) => `<li role="option" class="nl-item ${i === 0 && q ? 'active' : ''}" data-act="pick-name" data-name="${esc(n)}">${hilite(n, q)}</li>`).join('');
  }
  function openNameList(show) {
    const ul = $('#name-list'), inp = $('#name-search');
    if (!ul || !inp) return;
    ul.innerHTML = nameListHtml(inp.value);
    ul.hidden = !show;
    inp.setAttribute('aria-expanded', show ? 'true' : 'false');
  }
  function pickName(n) {
    const inp = $('#name-search');
    inp.value = n;
    $('#member-name').value = n;
    inp.classList.add('picked');
    openNameList(false);
    $('#f-login input[name=password]').focus();
  }
  async function loadNames() {
    if (!navigator.onLine) { if (!S.names.length) S.namesError = 'You\'re offline — connect once to load the member list.'; return; }
    try {
      const r = await api('memberNames', {});
      S.names = r.names || []; S.namesLoaded = true; S.namesError = '';
      store.set(K.names, S.names);
    } catch (e) {
      S.namesError = e.message;
    }
    const ul = $('#name-list');
    if (ul && !ul.hidden) openNameList(true);
  }

  function loginView() {
    const lastName = (S.member && S.member.name) || store.get(K.lastName, '');
    const known = lastName && S.names.some(n => norm(n) === norm(lastName));
    return `
      <section class="card narrow">
        <h1>Sign in</h1>
        <p class="muted">Log your Dive Team, SORT and Command Staff Meeting hours as overtime or debit reduction.</p>
        ${S.member && S.member.expired ? '<p class="note">Your sign-in expired. Sign in again — anything waiting on this phone will upload afterwards.</p>' : ''}
        <form id="f-login" class="stack" autocomplete="on">
          <div class="combo">
            <label for="name-search">Your name</label>
            <input type="text" id="name-search" role="combobox" aria-autocomplete="list" aria-controls="name-list" aria-expanded="false"
              autocomplete="off" autocapitalize="words" spellcheck="false" placeholder="Start typing your name…" value="${esc(known ? lastName : '')}" class="${known ? 'picked' : ''}">
            <input type="hidden" name="memberName" id="member-name" value="${esc(known ? lastName : '')}">
            <input type="text" name="username" autocomplete="username" value="${esc(known ? lastName : '')}" hidden>
            <ul id="name-list" class="namelist" role="listbox" hidden></ul>
          </div>
          <label>Password<input type="password" name="password" autocomplete="current-password" required></label>
          <button class="btn primary" type="submit">Sign in</button>
          <p class="err" id="err"></p>
        </form>
        ${!navigator.onLine ? '<p class="note">You\'re offline. Signing in needs a connection the first time; after that, logging hours works without signal.</p>' : ''}
      </section>
      <nav class="links"><a href="#/install">Install on your phone</a><span>·</span><a href="#/admin">Admin</a></nav>`;
  }

  function homeView() {
    if (S.member.expired) return loginView();
    const d = derived();
    if (!d) return '<p class="muted center">Loading your hours…</p>';
    const st = d.st;
    const days = daysUntil(st.deadline);
    const lastCat = store.get(K.cat, st.categories[0]);
    const cat = st.categories.indexOf(lastCat) >= 0 ? lastCat : st.categories[0];
    const pending = myQueue().slice().sort((a, b) => (a.date < b.date ? 1 : -1));
    const first = (S.member.name || '').split(' ')[0];

    let hero;
    if (st.obligated == null) {
      hero = `<div class="big"><span class="num">${fmtH(d.worked)}</span><span class="unit">debit hrs worked</span></div>
        <p class="muted">Your debit reduction obligation hasn't been entered yet. Your hours still count — an admin will set your total.</p>`;
    } else if (d.remaining === 0) {
      hero = `<div class="big done"><span class="num">✓</span><span class="unit">Obligation met</span></div>
        <div class="bar"><i style="width:100%"></i></div>
        <p class="muted">${hrs(d.worked)} debit reduction worked of ${hrs(st.obligated)} obligated.</p>`;
    } else {
      hero = `<div class="big"><span class="num">${fmtH(d.remaining)}</span><span class="unit">debit hrs remaining</span></div>
        <div class="bar"><i style="width:${d.pct}%"></i></div>
        <p class="muted">${hrs(d.worked)} debit reduction worked of ${hrs(st.obligated)} obligated</p>`;
    }
    const dueTxt = days > 1 ? `Due ${pretty(st.deadline)} · ${days} days left` : days === 1 ? `Due tomorrow (${pretty(st.deadline)})` : days === 0 ? 'Due today' : `Deadline ${pretty(st.deadline)} has passed`;

    const cats = st.categories.map((c, i) => `
      <label class="seg"><input type="radio" name="category" value="${esc(c)}" ${c === cat ? 'checked' : ''}><span>${esc(c)}</span></label>`).join('');

    const breakdown = catBreakdown(st.categories, st.byCategory, st.otByCategory);
    const lastPay = store.get(K.pay, 'Debit Reduction');
    const pay = PAY.some(x => x[0] === lastPay) ? lastPay : 'Debit Reduction';
    const pays = PAY.map(x => `
      <label class="seg pay"><input type="radio" name="payType" value="${x[0]}" ${x[0] === pay ? 'checked' : ''}><span>${x[1]}</span></label>`).join('');

    const pendList = pending.map(q => entryItem(q, true)).join('');
    const recent = (st.entries || []).map(e => entryItem(e, false)).join('');

    return `
      <section class="card hero">
        <p class="hello">Hi ${esc(first || 'there')}</p>
        ${hero}
        <p class="due ${days <= 7 ? 'soon' : ''}">${dueTxt}</p>
        <div class="otline"><span>Overtime this year</span><b>${hrs(d.overtime)}</b></div>
        <div class="breakdown">${breakdown}</div>
        <p class="tiny muted">${d.pendHours ? 'Includes ' + hrs(d.pendHours) + ' waiting to upload. ' : ''}Updated ${ago(st.asOf)}</p>
      </section>

      <section class="card">
        <h2>Log hours</h2>
        <form id="f-log" class="stack">
          <fieldset class="segs"><legend>Type</legend>${cats}</fieldset>
          <fieldset class="segs"><legend>Pay as</legend>${pays}</fieldset>
          <label>Date worked<input type="date" name="date" required value="${todayYmd()}" max="${todayYmd()}"></label>
          <div class="one-h" ${pay === 'Split' ? 'hidden' : ''}>
            <label><span class="h-label">${pay === 'Overtime' ? 'Overtime hours' : 'Debit reduction hours'}</span><input type="number" name="hours" inputmode="decimal" min="0.25" max="${st.maxHours}" step="0.25" placeholder="0"></label>
            <div class="chips">${[1, 2, 3, 4, 8].map(n => `<button type="button" class="chip" data-act="hours" data-h="${n}">${n} hr${n > 1 ? 's' : ''}</button>`).join('')}</div>
          </div>
          <div class="split-h row2" ${pay === 'Split' ? '' : 'hidden'}>
            <label>Debit reduction hours<input type="number" name="debitHours" inputmode="decimal" min="0.25" step="0.25" placeholder="0"></label>
            <label>Overtime hours<input type="number" name="otHours" inputmode="decimal" min="0.25" step="0.25" placeholder="0"></label>
          </div>
          <label>Notes <span class="muted">(optional)</span><input type="text" name="notes" maxlength="500" placeholder="e.g. Rope drill at Station 31"></label>
          <button class="btn primary" type="submit">Log hours</button>
        </form>
      </section>

      ${pending.length ? `<section class="card"><h2>Waiting to upload</h2><ul class="entries">${pendList}</ul>
        <button class="btn" data-act="sync" ${navigator.onLine ? '' : 'disabled'}>${navigator.onLine ? 'Upload now' : 'Will upload when you have signal'}</button></section>` : ''}

      <section class="card">
        <div class="h2row"><h2>This year's entries</h2><button class="btn small" data-act="refresh">Refresh</button></div>
        ${recent ? `<ul class="entries">${recent}</ul>` : '<p class="muted">Nothing logged yet this year.</p>'}
      </section>

      <nav class="links"><a href="#/install">Install on phone</a><span>·</span><a href="#/admin">Admin</a><span>·</span><a href="#" data-act="signout">Sign out</a></nav>`;
  }

  function catBreakdown(cats, deb, ot) {
    return cats.map(c => {
      const o = (ot || {})[c] || 0;
      return `<div><span>${esc(c)}</span><b>${fmtH((deb || {})[c] || 0)}<small> debit</small></b>${o ? `<em>${fmtH(o)} OT</em>` : ''}</div>`;
    }).join('');
  }
  function payTag(e) {
    const t = payText(e);
    const cls = t === 'Overtime' ? 'ot' : t === 'Split' ? 'split' : 'debit';
    const txt = t === 'Split' ? `Split ${fmtH(qDebit(e))} debit / ${fmtH(qOt(e))} OT` : t === 'Overtime' ? 'Overtime' : 'Debit reduction';
    return `<span class="tag ${cls}">${txt}</span> `;
  }

  function entryItem(e, pending) {
    const voided = String(e.status || '').toLowerCase() === 'void';
    const tag = payTag(e) + (pending ? '<span class="tag wait">Waiting</span>'
      : voided ? '<span class="tag void">Removed</span>'
      : e.counted === false ? '<span class="tag">Not this year</span>' : '');
    return `<li class="entry ${voided ? 'voided' : ''}">
      <div class="e-main"><b>${esc(e.category)}</b> ${tag}<span class="muted">${weekday(e.date)} ${pretty(e.date)}${e.notes ? ' · ' + esc(e.notes) : ''}</span>
      ${voided && e.voidReason ? `<span class="tiny muted">Reason: ${esc(e.voidReason)}</span>` : ''}</div>
      <div class="e-h">${fmtH(e.hours)}<small>hrs</small></div></li>`;
  }

  /* ───────── views: admin ───────── */
  function adminLoginView() {
    return `
      <section class="card narrow">
        <h1>Admin sign in</h1>
        <p class="muted">Use your email and the admin password from the Admin tab of the sheet.</p>
        <form id="f-admin" class="stack">
          <label>Email<input type="email" name="email" autocomplete="username" required value="${esc(store.get(K.email, ''))}"></label>
          <label>Admin password<input type="password" name="password" autocomplete="current-password" required></label>
          <button class="btn primary" type="submit">Sign in as admin</button>
          <p class="err" id="err"></p>
        </form>
      </section>
      <nav class="links"><a href="#/">Back to logging hours</a></nav>`;
  }

  function adminView() {
    const D = S.dash;
    const tabs = [['members', 'Members'], ['entries', 'Entries'], ['settings', 'Settings']].map(t =>
      `<button class="tab ${S.tab === t[0] ? 'on' : ''}" data-act="tab" data-tab="${t[0]}">${t[1]}</button>`).join('');
    let body = '';
    if (!D) body = `<p class="muted center">${S.loadingDash ? 'Loading…' : (S.lastError || 'No data yet.')}</p>`;
    else if (S.tab === 'members') body = adminMembers(D);
    else if (S.tab === 'entries') body = adminEntries(D);
    else body = adminSettings(D);
    return `
      <div class="adminbar">
        <h1>Admin</h1>
        <button class="btn small" data-act="adm-refresh" ${navigator.onLine ? '' : 'disabled'}>${S.loadingDash ? 'Loading…' : 'Refresh'}</button>
      </div>
      ${!navigator.onLine ? '<p class="note">You\'re offline — showing the last data loaded. Changes need a connection.</p>' : ''}
      <div class="tabs">${tabs}</div>
      ${body}
      <nav class="links"><a href="#/">Log hours</a><span>·</span><a href="#" data-act="adm-signout">Sign out of admin</a></nav>
      <div id="savebar" class="savebar" hidden><span id="savecount"></span><button class="btn" data-act="discard">Discard</button><button class="btn primary" data-act="save-ob">Save</button></div>`;
  }

  function memberVal(m) { return Object.prototype.hasOwnProperty.call(S.edits, m.email) ? S.edits[m.email] : (m.obligated == null ? '' : m.obligated); }

  function adminMembers(D) {
    const act = D.members.filter(m => m.active);
    const withOb = act.filter(m => m.obligated != null);
    const complete = withOb.filter(m => m.remaining === 0).length;
    const sum = k => round2(act.reduce((a, m) => a + (m[k] || 0), 0));
    const days = daysUntil(D.settings.DEADLINE);
    const q = S.filter.trim().toLowerCase();
    let list = D.members.filter(m => !q || (m.name + ' ' + m.email).toLowerCase().indexOf(q) >= 0);
    list = list.slice().sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      if (S.sort === 'remaining') {
        const ra = a.remaining == null ? -1 : a.remaining, rb = b.remaining == null ? -1 : b.remaining;
        if (rb !== ra) return rb - ra;
      }
      return (a.name || a.email).localeCompare(b.name || b.email);
    });
    const blanks = act.filter(m => m.obligated == null).length;

    const rows = list.map(m => {
      const pct = m.obligated ? Math.min(100, Math.round(m.worked / m.obligated * 100)) : (m.obligated === 0 ? 100 : 0);
      const open = S.open === m.email;
      const ents = open ? D.entries.filter(e => e.email === m.email) : [];
      const state = !m.active ? 'inactive' : m.obligated == null ? 'unset' : m.remaining === 0 ? 'done' : 'behind';
      return `<div class="mrow ${state} ${open ? 'open' : ''}">
        <div class="mtop">
          <button class="mname" data-act="open" data-email="${esc(m.email)}">
            <b>${esc(m.name || m.email)}</b>${!m.active ? ' <span class="tag">Inactive</span>' : ''}
            <small>${esc(m.email)}</small>
          </button>
          <label class="ob">Obligated<input type="number" inputmode="decimal" min="0" step="0.5" data-ob="${esc(m.email)}" value="${esc(memberVal(m))}" placeholder="—"></label>
        </div>
        <div class="bar thin"><i style="width:${pct}%"></i></div>
        <div class="mnums"><span>Debit worked <b>${fmtH(m.worked)}</b></span><span>Remaining <b class="${m.remaining > 0 ? 'red' : ''}">${m.remaining == null ? '—' : fmtH(m.remaining)}</b></span><span>OT <b>${fmtH(m.overtime || 0)}</b></span>
          <span class="muted">${m.lastDate ? 'Last ' + pretty(m.lastDate, true) : 'No hours yet'}</span></div>
        ${open ? `<div class="mdetail">
          <div class="breakdown">${catBreakdown(D.categories, m.byCategory, m.otByCategory)}</div>
          ${ents.length ? `<ul class="entries">${ents.map(e => adminEntryItem(e, false)).join('')}</ul>` : '<p class="muted">No entries this year.</p>'}
        </div>` : ''}
      </div>`;
    }).join('');

    return `
      <div class="stats">
        <div><b>${complete}/${act.length}</b><span>complete</span></div>
        <div><b>${sum('worked')}</b><span>debit hrs worked</span></div>
        <div><b>${sum('remaining')}</b><span>debit hrs remaining</span></div>
        <div><b>${sum('overtime')}</b><span>overtime hrs</span></div>
        <div><b>${days >= 0 ? days : '—'}</b><span>days to ${pretty(D.settings.DEADLINE, true)}</span></div>
      </div>
      <div class="tools">
        <input type="search" id="m-filter" placeholder="Search members" value="${esc(S.filter)}">
        <select id="m-sort"><option value="name" ${S.sort === 'name' ? 'selected' : ''}>A–Z</option><option value="remaining" ${S.sort === 'remaining' ? 'selected' : ''}>Most remaining</option></select>
      </div>
      ${blanks ? `<div class="bulk"><span>${blanks} member${blanks > 1 ? 's have' : ' has'} no obligation set.</span>
        <input type="number" id="bulk-h" inputmode="decimal" min="0" step="0.5" placeholder="hrs"><button class="btn small" data-act="bulk">Fill blanks</button></div>` : ''}
      <p class="tiny muted">Type each member's obligated hours, then tap Save. Tap a name to see their entries. Members are added in the Members tab of the sheet.</p>
      <div class="mlist">${rows || '<p class="muted">No members found. Add them to the Members tab (Name, Password, Email).</p>'}</div>`;
  }

  function adminEntryItem(e, showName) {
    const voided = String(e.status).toLowerCase() === 'void';
    return `<li class="entry ${voided ? 'voided' : ''}">
      <div class="e-main"><b>${showName ? esc(e.name || e.email) + ' · ' : ''}${esc(e.category)}</b>
        <span>${payTag(e)}</span>
        ${voided ? '<span class="tag void">Removed</span>' : e.counted ? '' : '<span class="tag">Not this year</span>'}
        <span class="muted">${weekday(e.date)} ${pretty(e.date)}${e.notes ? ' · ' + esc(e.notes) : ''}</span>
        ${voided && e.voidReason ? `<span class="tiny muted">Reason: ${esc(e.voidReason)}</span>` : ''}</div>
      <div class="e-h">${fmtH(e.hours)}<small>hrs</small></div>
      <button class="btn small ${voided ? '' : 'ghost'}" data-act="${voided ? 'restore' : 'void'}" data-id="${esc(e.id)}">${voided ? 'Restore' : 'Remove'}</button>
    </li>`;
  }

  function adminEntries(D) {
    const cats = ['All'].concat(D.categories);
    const list = D.entries.filter(e => S.entryCat === 'All' || e.category === S.entryCat);
    return `
      <div class="chips">${cats.map(c => `<button class="chip ${S.entryCat === c ? 'on' : ''}" data-act="ecat" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}</div>
      <p class="tiny muted">${list.length} entries (${hrs(list.filter(e => e.counted && String(e.status).toLowerCase() !== 'void').reduce((a, e) => a + (e.ot || 0), 0))} overtime) since ${pretty(D.settings.CYCLE_START)}. "Remove" takes an entry out of the totals (it stays in the sheet marked Void).</p>
      <ul class="entries">${list.map(e => adminEntryItem(e, true)).join('') || '<li class="muted">No entries.</li>'}</ul>`;
  }

  function adminSettings(D) {
    const s = D.settings;
    return `
      <section class="card">
        <h2>Obligation period</h2>
        <form id="f-settings" class="stack">
          <div class="row2">
            <label>Counts hours from<input type="date" name="CYCLE_START" value="${esc(s.CYCLE_START)}" required></label>
            <label>Due by (deadline)<input type="date" name="DEADLINE" value="${esc(s.DEADLINE)}" required></label>
          </div>
          <p class="tiny muted">Hours dated before the deadline count. Team leads get the summary email the morning of ${pretty(D.summaryDate)}${s.LAST_SUMMARY_FOR === s.DEADLINE ? ' (already sent for this deadline)' : ''}.</p>
          <label>Copy every submission to<input type="text" name="NOTIFY_EMAIL" value="${esc(s.NOTIFY_EMAIL)}"></label>
          <label>Types of hours (comma-separated)<input type="text" name="CATEGORIES" value="${esc(s.CATEGORIES)}" required></label>
          <div class="row2">
            <label>Max hours per entry<input type="number" name="MAX_HOURS_PER_ENTRY" min="1" step="0.5" value="${esc(s.MAX_HOURS_PER_ENTRY)}"></label>
            <label>App name<input type="text" name="APP_NAME" value="${esc(s.APP_NAME)}"></label>
          </div>
          <button class="btn primary" type="submit" ${navigator.onLine ? '' : 'disabled'}>Save settings</button>
        </form>
      </section>
      <section class="card">
        <h2>Team-lead summary</h2>
        <p class="muted">${D.teamLeads.length ? 'Goes to: <b>' + D.teamLeads.map(esc).join(', ') + '</b>' : 'No team lead is marked in column C of the Admin tab — the summary will go to all admins.'}</p>
        <div class="btnrow">
          <button class="btn" data-act="summary" ${navigator.onLine ? '' : 'disabled'}>Send summary now</button>
          <button class="btn" data-act="testmail" ${navigator.onLine ? '' : 'disabled'}>Send me a test email</button>
        </div>
      </section>
      <section class="card">
        <h2>Start next year</h2>
        <p class="muted">After ${pretty(s.DEADLINE)}, roll the period forward to ${pretty(s.DEADLINE)} – ${pretty(addYear(s.DEADLINE))}. Past entries stay in the sheet.</p>
        <label class="check"><input type="checkbox" id="clear-ob"> Also clear everyone's obligated hours</label>
        <button class="btn" data-act="newcycle" ${navigator.onLine ? '' : 'disabled'}>Start next period</button>
      </section>
      <p class="tiny muted center">Signed in as ${esc(D.admin.email)} · data ${ago(D.asOf)}</p>`;
  }
  const addYear = ymd => (Number(ymd.slice(0, 4)) + 1) + ymd.slice(4);

  async function loadDash(quiet) {
    if (!S.admin || !navigator.onLine) return;
    S.loadingDash = true; S.lastError = '';
    if (!quiet) render();
    try {
      const r = await api('adminDashboard', { token: S.admin.token });
      setDash(r.dashboard);
    } catch (e) { adminError(e); }
    finally { S.loadingDash = false; render(); }
  }
  function setDash(d) { S.dash = d; save('dash'); }
  function adminError(e) {
    if (e.code === 'AUTH') { S.admin = null; save('admin'); S.dash = null; save('dash'); }
    S.lastError = e.message;
    toast(e.message, 'bad');
  }
  async function adminCall(action, data, okMsg) {
    try {
      const r = await api(action, Object.assign({ token: S.admin.token }, data || {}));
      if (r.dashboard) setDash(r.dashboard);
      if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg, 'good');
      render();
      return r;
    } catch (e) { adminError(e); render(); return null; }
  }

  function updateSaveBar() {
    const bar = $('#savebar');
    if (!bar) return;
    const n = Object.keys(S.edits).length;
    bar.hidden = !n;
    $('#savecount').textContent = n + ' unsaved change' + (n === 1 ? '' : 's');
  }

  /* ───────── install view ───────── */
  function installView() {
    const ua = navigator.userAgent;
    const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && 'ontouchend' in document);
    const android = /Android/.test(ua);
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    const link = CFG.SHARE_URL || location.origin + location.pathname;
    return `
      <section class="card">
        <h1>Install on your phone</h1>
        ${standalone ? '<p class="note good">You\'re using the installed app. 👍</p>' : ''}
        ${S.installEvt ? '<button class="btn primary" data-act="install">Install app</button>' : ''}
        <h3 class="${ios ? 'hl' : ''}">iPhone</h3>
        <ol><li>Open this page in <b>Safari</b>.</li><li>Tap the <b>Share</b> button (square with arrow).</li><li>Scroll down, tap <b>Add to Home Screen</b> → <b>Add</b>.</li></ol>
        <h3 class="${android ? 'hl' : ''}">Android</h3>
        <ol><li>Open this page in <b>Chrome</b>.</li><li>Tap <b>⋮</b> (top right).</li><li>Tap <b>Install app</b> or <b>Add to Home screen</b>.</li></ol>
        <p class="muted">Sign in once while you have signal. After that you can log hours with no connection — they upload automatically when you're back in range.</p>
        <h3>Share with a member</h3>
        <div class="linkbox"><input type="text" readonly value="${esc(link)}" id="share-link"></div>
        <div class="btnrow">
          ${navigator.share ? '<button class="btn" data-act="share">Share link</button>' : ''}
          <button class="btn" data-act="copy">Copy link</button>
        </div>
      </section>
      <nav class="links"><a href="#/">Back</a></nav>`;
  }

  /* ───────── render & routing ───────── */
  function route() { return (location.hash || '#/').replace(/^#/, ''); }

  function render() {
    const r = route();
    const app = $('#app');
    let html;
    if (r.indexOf('/install') === 0) html = installView();
    else if (r.indexOf('/admin') === 0) html = S.admin ? adminView() : adminLoginView();
    else html = S.member ? homeView() : loginView();
    const y = window.scrollY;
    const focus = document.activeElement && document.activeElement.id;
    app.innerHTML = html + `<p class="build">Version ${APP_BUILD}</p>`;
    window.scrollTo(0, y);
    if (focus && $('#' + focus)) { const el = $('#' + focus); el.focus(); if (el.setSelectionRange && el.type === 'search') el.setSelectionRange(el.value.length, el.value.length); }
    $$('[data-ob]').forEach(inp => { if (Object.prototype.hasOwnProperty.call(S.edits, inp.dataset.ob)) inp.classList.add('changed'); });
    updateSaveBar();
    renderPill();
    const name = (S.status && S.status.appName) || (S.dash && S.dash.settings.APP_NAME) || CFG.APP_NAME || 'Debit Hours';
    $('#brand-name').textContent = name;
    document.title = name;
  }

  /* ───────── events ───────── */
  document.addEventListener('submit', async ev => {
    const f = ev.target;
    ev.preventDefault();
    const fd = Object.fromEntries(new FormData(f).entries());
    const btn = f.querySelector('button[type=submit]');
    const err = f.querySelector('#err');

    if (f.id === 'f-login' || f.id === 'f-admin') {
      if (err) err.textContent = '';
      btn.disabled = true; btn.textContent = 'Signing in…';
      try {
        if (f.id === 'f-login') {
          const typed = $('#name-search').value;
          const name = fd.memberName || S.names.find(n => norm(n) === norm(typed)) || '';
          if (!name) {
            const one = filterNames(typed);
            throw new ApiError(one.length === 1 && typed ? 'Tap your name in the list: ' + one[0] : 'Pick your name from the list.');
          }
          store.set(K.lastName, name);
          const r = await api('login', { name: name, password: fd.password });
          store.set(K.email, r.email);
          S.member = { token: r.token, name: r.name, email: r.email };
          S.status = r.status; save('member'); save('status');
          render(); sync();
        } else {
          const email = fd.email.trim().toLowerCase();
          store.set(K.email, email);
          const r = await api('adminLogin', { email: email, password: fd.password });
          S.admin = { token: r.token, email: r.email, name: r.name }; save('admin');
          S.tab = 'members';
          loadDash();
        }
      } catch (e) {
        if (err) err.textContent = e.message;
        btn.disabled = false; btn.textContent = f.id === 'f-login' ? 'Sign in' : 'Sign in as admin';
      }
      return;
    }

    if (f.id === 'f-log') {
      const st = S.status;
      const payType = fd.payType;
      const date = fd.date;
      let debit = 0, ot = 0;
      if (payType === 'Split') { debit = round2(fd.debitHours); ot = round2(fd.otHours); }
      else if (payType === 'Overtime') ot = round2(fd.hours);
      else debit = round2(fd.hours);
      const hours = round2(debit + ot);
      if (!fd.category) return toast('Pick a type of hours.', 'bad');
      if (!payType) return toast('Pick Overtime, Debit reduction or Split.', 'bad');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return toast('Pick the date you worked.', 'bad');
      if (date > todayYmd()) return toast('The date can\'t be in the future.', 'bad');
      if (debit < 0 || ot < 0) return toast('Hours can\'t be negative.', 'bad');
      if (payType === 'Split' && !(debit > 0 && ot > 0)) return toast('For a split, enter both debit reduction and overtime hours.', 'bad');
      if (!(hours > 0)) return toast('Enter the number of hours.', 'bad');
      if (hours > st.maxHours) return toast('That\'s more than ' + st.maxHours + ' hours in one entry.', 'bad');
      if (date < st.cycleStart && !confirm('That date is before ' + pretty(st.cycleStart) + ', so it won\'t count toward this year\'s obligation. Log it anyway?')) return;
      S.queue.push({ id: uuid(), email: S.member.email, date: date, category: fd.category, payType: payType, hours: hours, debit: debit, ot: ot, notes: (fd.notes || '').trim(), createdAt: new Date().toISOString() });
      save('queue');
      store.set(K.cat, fd.category);
      store.set(K.pay, payType);
      render();
      if (navigator.onLine) { toast('Saved — uploading…'); sync(); }
      else toast('Saved on this phone. It will upload when you have signal.', 'good');
      return;
    }

    if (f.id === 'f-settings') {
      btn.disabled = true;
      await adminCall('adminSaveSettings', { settings: fd }, 'Settings saved');
    }
  });

  document.addEventListener('input', ev => {
    const t = ev.target;
    if (t.dataset && t.dataset.ob) {
      const email = t.dataset.ob;
      const m = S.dash.members.find(x => x.email === email);
      const orig = m.obligated == null ? '' : String(m.obligated);
      if (t.value.trim() === orig) delete S.edits[email]; else S.edits[email] = t.value.trim();
      t.classList.toggle('changed', Object.prototype.hasOwnProperty.call(S.edits, email));
      updateSaveBar();
    } else if (t.id === 'm-filter') {
      S.filter = t.value; render();
    } else if (t.id === 'name-search') {
      $('#member-name').value = '';
      t.classList.remove('picked');
      const exact = S.names.find(n => norm(n) === norm(t.value));
      if (exact) $('#member-name').value = exact;
      openNameList(true);
    }
  });
  document.addEventListener('change', ev => {
    if (ev.target.id === 'm-sort') { S.sort = ev.target.value; render(); }
    if (ev.target.name === 'payType') {
      const f = ev.target.form, v = ev.target.value;
      f.querySelector('.one-h').hidden = v === 'Split';
      f.querySelector('.split-h').hidden = v !== 'Split';
      f.querySelector('.h-label').textContent = v === 'Overtime' ? 'Overtime hours' : 'Debit reduction hours';
      store.set(K.pay, v);
    }
  });

  document.addEventListener('click', async ev => {
    const el = ev.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (el.tagName === 'A') ev.preventDefault();

    switch (act) {
      case 'pick-name': pickName(el.dataset.name); break;
      case 'hours': { const i = $('#f-log input[name=hours]'); i.value = el.dataset.h; break; }
      case 'sync': sync(); break;
      case 'refresh': el.textContent = 'Refreshing…'; await sync(true); await refreshStatus(); break;
      case 'signout': {
        const n = myQueue().length;
        if (n && !confirm(n + ' entr' + (n === 1 ? 'y hasn\'t' : 'ies haven\'t') + ' uploaded yet. They stay on this phone and upload next time you sign in. Sign out?')) return;
        if (!n && !confirm('Sign out?')) return;
        const tok = S.member.token;
        S.member = null; S.status = null; save('member'); save('status');
        render();
        api('logout', { token: tok }).catch(() => {});
        break;
      }
      case 'tab': S.tab = el.dataset.tab; render(); break;
      case 'adm-refresh':
        if (Object.keys(S.edits).length && !confirm('Discard unsaved obligation changes?')) return;
        S.edits = {}; loadDash(); break;
      case 'adm-signout': {
        if (Object.keys(S.edits).length && !confirm('Discard unsaved obligation changes?')) return;
        const tok = S.admin.token;
        S.admin = null; S.dash = null; S.edits = {}; save('admin'); save('dash');
        location.hash = '#/admin'; render();
        api('logout', { token: tok }).catch(() => {});
        break;
      }
      case 'open': S.open = S.open === el.dataset.email ? null : el.dataset.email; render(); break;
      case 'bulk': {
        const v = $('#bulk-h').value.trim();
        if (!(Number(v) >= 0) || v === '') return toast('Enter hours to fill in.', 'bad');
        S.dash.members.filter(m => m.active && m.obligated == null && !Object.prototype.hasOwnProperty.call(S.edits, m.email))
          .forEach(m => { S.edits[m.email] = v; });
        render();
        toast('Filled in — tap Save to keep.', '');
        break;
      }
      case 'discard': S.edits = {}; render(); break;
      case 'save-ob': {
        const updates = Object.keys(S.edits).map(email => ({ email: email, hours: S.edits[email] }));
        const bad = updates.find(u => u.hours !== '' && !(Number(u.hours) >= 0));
        if (bad) return toast('Check the hours entered — numbers only.', 'bad');
        el.disabled = true; el.textContent = 'Saving…';
        const r = await adminCall('adminSetObligations', { updates: updates }, r2 => 'Saved ' + r2.changed + ' change' + (r2.changed === 1 ? '' : 's'));
        if (r) { S.edits = {}; render(); }
        break;
      }
      case 'void': {
        const reason = prompt('Remove this entry from the totals? Reason (optional):', '');
        if (reason === null) return;
        await adminCall('adminVoidEntry', { id: el.dataset.id, reason: reason }, 'Entry removed');
        break;
      }
      case 'restore': await adminCall('adminVoidEntry', { id: el.dataset.id, restore: true }, 'Entry restored'); break;
      case 'ecat': S.entryCat = el.dataset.cat; render(); break;
      case 'summary':
        if (!confirm('Email the worked-vs-obligated summary to the team lead(s) now?')) return;
        el.disabled = true;
        await adminCall('adminSendSummary', {}, r => 'Summary sent to ' + r.sentTo.join(', '));
        break;
      case 'testmail': el.disabled = true; await adminCall('adminTestEmail', {}, r => 'Test sent to ' + r.sentTo.join(', ')); break;
      case 'newcycle': {
        const clear = $('#clear-ob').checked;
        const s = S.dash.settings;
        if (!confirm('Start the period ' + pretty(s.DEADLINE) + ' – ' + pretty(addYear(s.DEADLINE)) + '?' + (clear ? '\n\nEveryone\'s obligated hours will be cleared.' : ''))) return;
        await adminCall('adminNewCycle', { clearObligations: clear }, 'New period started');
        break;
      }
      case 'install':
        if (S.installEvt) { S.installEvt.prompt(); S.installEvt = null; render(); }
        break;
      case 'share': navigator.share({ title: document.title, text: 'Log your debit reduction hours here:', url: $('#share-link').value }).catch(() => {}); break;
      case 'copy': {
        const i = $('#share-link');
        try { await navigator.clipboard.writeText(i.value); toast('Link copied', 'good'); } catch (e) { i.select(); document.execCommand('copy'); toast('Link copied', 'good'); }
        break;
      }
    }
  });

  document.addEventListener('focusin', ev => {
    if (ev.target.id === 'name-search') { ev.target.select(); openNameList(true); }
  });
  document.addEventListener('pointerdown', ev => {
    if (!ev.target.closest('.combo')) openNameList(false);
  });
  document.addEventListener('keydown', ev => {
    if (ev.target.id !== 'name-search') return;
    const items = $$('#name-list .nl-item');
    let i = items.findIndex(x => x.classList.contains('active'));
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      if ($('#name-list').hidden) openNameList(true);
      const list = $$('#name-list .nl-item');
      if (!list.length) return;
      if (i >= 0 && list[i]) list[i].classList.remove('active');
      i = ev.key === 'ArrowDown' ? Math.min(list.length - 1, i + 1) : Math.max(0, i - 1);
      list[i].classList.add('active'); list[i].scrollIntoView({ block: 'nearest' });
    } else if (ev.key === 'Enter' && !$('#name-list').hidden && items.length) {
      ev.preventDefault();
      pickName((items[i >= 0 ? i : 0]).dataset.name);
    } else if (ev.key === 'Escape') openNameList(false);
  });

  window.addEventListener('hashchange', () => {
    window.scrollTo(0, 0);
    render();
    if (route().indexOf('/admin') === 0 && S.admin && navigator.onLine) loadDash(true);
  });
  window.addEventListener('online', () => { if (!S.namesLoaded) loadNames(); render(); sync(true).then(() => refreshStatus(true)); if (S.admin && route().indexOf('/admin') === 0) loadDash(true); });
  window.addEventListener('offline', render);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(true); });
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); S.installEvt = e; if (route().indexOf('/install') === 0) render(); });

  /* ───────── start ───────── */
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
      // Check GitHub for a new version every time the app is brought to the front.
      document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
    }).catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) return; // first install, nothing to refresh
      const busy = document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
      if (busy) toast('App updated — it will refresh next time you open it.');
      else location.reload();
    });
  }
  render();
  loadNames();
  if (S.member && !S.member.expired) { sync(true).then(() => refreshStatus(true)); }
  if (S.admin && route().indexOf('/admin') === 0) loadDash(!!S.dash);
})();
