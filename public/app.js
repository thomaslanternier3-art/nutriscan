'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const MEALS = { breakfast: 'Petit-déjeuner', lunch: 'Déjeuner', snack: 'Collation', dinner: 'Dîner' };
const KCAL_PER_KG_FAT = 7700;

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (res.status === 401 && !path.startsWith('/auth/')) showAuth();
  if (!res.ok) throw new Error(data?.error || `Erreur ${res.status}`);
  return data;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const round = (n) => Math.round(n);
const num = (v) => (v === '' || v == null || isNaN(v) ? 0 : Number(v));

// Dates locales au format YYYY-MM-DD (évite les décalages de fuseau de toISOString)
const toISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fromISO = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
const weekStart = (iso) => { const d = fromISO(iso); return addDays(d, -((d.getDay() + 6) % 7)); };

const state = { date: toISO(new Date()), mode: 'day', profile: null, entries: [] };
let renderToken = 0;

/* ---------- Calculs nutritionnels ---------- */

// Mifflin-St Jeor
function computeNeeds(p) {
  if (!p || !p.weight || !p.height || !p.age) return null;
  const bmr = 10 * p.weight + 6.25 * p.height - 5 * p.age + (p.sex === 'male' ? 5 : -161);
  const tdee = bmr * p.activity;
  const floor = p.sex === 'male' ? 1500 : 1200;
  const raw = tdee - p.deficit;
  const target = Math.max(raw, floor);
  const bmi = p.weight / (p.height / 100) ** 2;
  return { bmr, tdee, target, bmi, floor, floorApplied: raw < floor };
}

function bmiLabel(bmi) {
  if (bmi < 18.5) return 'Insuffisance pondérale';
  if (bmi < 25) return 'Corpulence normale';
  if (bmi < 30) return 'Surpoids';
  return 'Obésité';
}

const entriesFor = (date) => state.entries.filter((e) => e.date === date);

function nutrition(e) {
  const f = e.quantity / 100;
  return { kcal: e.kcal100 * f, p: e.p100 * f, c: e.c100 * f, f: e.f100 * f };
}

function sumDay(date) {
  return entriesFor(date).reduce((acc, e) => {
    const n = nutrition(e);
    acc.kcal += n.kcal; acc.p += n.p; acc.c += n.c; acc.f += n.f;
    return acc;
  }, { kcal: 0, p: 0, c: 0, f: 0 });
}

/* ---------- Navigation ---------- */

function showView(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  $$('.bottom-nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (name !== 'scan') stopScanner();
  if (name === 'dashboard') renderDashboard();
  if (name === 'profile') renderProfile();
}

$$('.bottom-nav button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
document.addEventListener('click', (e) => {
  const link = e.target.closest('[data-goto]');
  if (link) { e.preventDefault(); showView(link.dataset.goto); }
});

/* ---------- Authentification ---------- */

let authMode = 'login';

function setAuthMode(mode) {
  authMode = mode;
  const login = mode === 'login';
  $('#auth-title').textContent = login ? 'Connexion' : 'Créer un compte';
  $('#auth-submit').textContent = login ? 'Se connecter' : 'Créer mon compte';
  $('#auth-toggle').textContent = login ? 'Pas encore de compte ? Créer un compte' : 'Déjà un compte ? Se connecter';
  $('#a-password').autocomplete = login ? 'current-password' : 'new-password';
  $('#auth-msg').textContent = '';
}

function showAuth() {
  stopScanner();
  state.profile = null;
  state.entries = [];
  $('.bottom-nav').hidden = true;
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-auth'));
}

function onLoggedIn(user) {
  state.profile = user.profile;
  $('#account-email').textContent = user.email;
  $('.bottom-nav').hidden = false;
  showView(user.profile ? 'dashboard' : 'profile');
}

$('#auth-toggle').addEventListener('click', () => setAuthMode(authMode === 'login' ? 'register' : 'login'));

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#auth-msg').textContent = '';
  try {
    const user = await api(`/auth/${authMode}`, {
      method: 'POST',
      body: { email: $('#a-email').value, password: $('#a-password').value },
    });
    $('#a-password').value = '';
    onLoggedIn(user);
  } catch (err) {
    $('#auth-msg').textContent = err.message;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  showAuth();
});

/* ---------- Tableau de bord ---------- */

$$('.segmented button').forEach((b) => b.addEventListener('click', () => {
  state.mode = b.dataset.mode;
  $$('.segmented button').forEach((x) => x.classList.toggle('active', x === b));
  renderDashboard();
}));

$('#prev-date').addEventListener('click', () => shiftDate(-1));
$('#next-date').addEventListener('click', () => shiftDate(1));

function shiftDate(dir) {
  state.date = toISO(addDays(fromISO(state.date), dir * (state.mode === 'week' ? 7 : 1)));
  renderDashboard();
}

async function renderDashboard() {
  // Ignore les réponses obsolètes si l'utilisateur navigue vite
  const token = ++renderToken;
  const start = weekStart(state.date);
  let entries;
  try {
    entries = await api(`/entries?from=${toISO(start)}&to=${toISO(addDays(start, 6))}`);
  } catch (err) {
    $('#entries').innerHTML = `<p class="card msg error">${esc(err.message)}</p>`;
    return;
  }
  if (token !== renderToken) return;
  state.entries = entries;

  const needs = computeNeeds(state.profile);
  $('#profile-hint').hidden = !!needs;
  $('#day-panel').hidden = state.mode !== 'day';
  $('#week-panel').hidden = state.mode !== 'week';

  if (state.mode === 'day') {
    const today = toISO(new Date());
    $('#date-label').textContent = state.date === today
      ? "Aujourd'hui"
      : fromISO(state.date).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    renderDay(needs);
  } else {
    const start = weekStart(state.date);
    const opts = { day: 'numeric', month: 'short' };
    $('#date-label').textContent = `${start.toLocaleDateString('fr-FR', opts)} – ${addDays(start, 6).toLocaleDateString('fr-FR', opts)}`;
    renderWeek(needs);
  }
}

function renderDay(needs) {
  const t = sumDay(state.date);
  const target = needs?.target;
  const remaining = target ? target - t.kcal : null;
  const over = remaining != null && remaining < 0;

  $('#kcal-consumed').textContent = round(t.kcal);
  $('#kcal-target').textContent = target ? round(target) : '—';
  $('#kcal-remaining').textContent = remaining == null ? '' : over
    ? `Dépassement de ${round(-remaining)} kcal`
    : `Reste ${round(remaining)} kcal`;
  $('#kcal-remaining').classList.toggle('over', over);
  $('#progress-bar').style.width = `${target ? Math.min((t.kcal / target) * 100, 100) : 0}%`;
  $('#progress-bar').classList.toggle('over', over);
  $('#macro-p').textContent = `${round(t.p)} g`;
  $('#macro-c').textContent = `${round(t.c)} g`;
  $('#macro-f').textContent = `${round(t.f)} g`;

  const entries = entriesFor(state.date);
  if (!entries.length) {
    $('#entries').innerHTML = '<p class="card muted">Aucun aliment enregistré ce jour. Utilisez l\'onglet Scanner pour en ajouter.</p>';
    return;
  }
  $('#entries').innerHTML = Object.entries(MEALS).map(([key, label]) => {
    const items = entries.filter((e) => e.meal === key);
    if (!items.length) return '';
    const total = items.reduce((s, e) => s + nutrition(e).kcal, 0);
    return `<div class="meal"><h3>${label}<span>${round(total)} kcal</span></h3>${items.map((e) => `
      <div class="entry">
        <div><strong>${esc(e.name)}</strong><small>${esc(e.brand)}${e.brand ? ' · ' : ''}${esc(e.quantity)} g</small></div>
        <div class="entry-right">${round(nutrition(e).kcal)} kcal
          <button class="icon-btn" data-del="${esc(e.id)}" aria-label="Supprimer">&#10005;</button>
        </div>
      </div>`).join('')}</div>`;
  }).join('');
}

$('#entries').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-del]');
  if (!btn || !confirm('Supprimer cet aliment ?')) return;
  try {
    await api(`/entries/${encodeURIComponent(btn.dataset.del)}`, { method: 'DELETE' });
  } catch (err) {
    alert(err.message);
  }
  renderDashboard();
});

function renderWeek(needs) {
  const start = weekStart(state.date);
  const today = toISO(new Date());
  const days = Array.from({ length: 7 }, (_, i) => {
    const iso = toISO(addDays(start, i));
    return { iso, ...sumDay(iso) };
  });
  const target = needs?.target || 0;
  const max = Math.max(target, ...days.map((d) => d.kcal), 1) * 1.1;

  $('#week-chart').innerHTML = days.map((d) => `
    <div class="bar-col${d.iso === today ? ' today' : ''}" data-day="${d.iso}">
      <span class="bar-val">${d.kcal ? round(d.kcal) : ''}</span>
      <div class="bar-track">
        <div class="bar${target && d.kcal > target ? ' over' : ''}" style="height:${(d.kcal / max) * 100}%"></div>
        ${target ? `<div class="target-mark" style="bottom:${(target / max) * 100}%"></div>` : ''}
      </div>
      <span class="bar-label">${fromISO(d.iso).toLocaleDateString('fr-FR', { weekday: 'short' })}</span>
    </div>`).join('');

  const logged = days.filter((d) => d.kcal > 0);
  const total = logged.reduce((s, d) => s + d.kcal, 0);
  const avg = logged.length ? total / logged.length : 0;
  let html = `
    <div class="stat"><span>Total de la semaine</span><strong>${round(total)} kcal</strong></div>
    <div class="stat"><span>Moyenne / jour enregistré</span><strong>${round(avg)} kcal</strong></div>
    <div class="stat"><span>Jours enregistrés</span><strong>${logged.length} / 7</strong></div>`;
  if (needs) {
    html += `<div class="stat"><span>Objectif journalier</span><strong>${round(needs.target)} kcal</strong></div>`;
    if (logged.length) {
      const deficit = logged.reduce((s, d) => s + (needs.tdee - d.kcal), 0);
      html += `
        <div class="stat"><span>Déficit cumulé</span><strong>${round(deficit)} kcal</strong></div>
        <div class="stat highlight"><span>Perte de poids estimée</span><strong>${(deficit / KCAL_PER_KG_FAT).toFixed(2)} kg</strong></div>`;
    }
  }
  $('#week-stats').innerHTML = html;
}

$('#week-chart').addEventListener('click', (e) => {
  const col = e.target.closest('[data-day]');
  if (!col) return;
  state.date = col.dataset.day;
  $('.segmented [data-mode="day"]').click();
});

/* ---------- Scanner ---------- */

let scanner = null;

function showScanMsg(text, isError = false) {
  $('#scan-msg').textContent = text;
  $('#scan-msg').classList.toggle('error', isError);
}

function toggleScanButtons(scanning) {
  $('#start-scan').hidden = scanning;
  $('#stop-scan').hidden = !scanning;
}

async function startScanner() {
  if (typeof Html5Qrcode === 'undefined') {
    showScanMsg('Module de scan indisponible (connexion Internet requise au premier chargement).', true);
    return;
  }
  $('#product-form').hidden = true;
  showScanMsg('');
  const F = Html5QrcodeSupportedFormats;
  scanner = new Html5Qrcode('reader', { formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E], verbose: false });
  try {
    await scanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 260, height: 140 } },
      (code) => {
        if (!scanner) return;
        if (navigator.vibrate) navigator.vibrate(100);
        stopScanner();
        lookup(code);
      },
    );
    toggleScanButtons(true);
  } catch {
    scanner = null;
    showScanMsg("Impossible d'accéder à la caméra. Autorisez l'accès (le site doit être servi en HTTPS).", true);
  }
}

async function stopScanner() {
  const s = scanner;
  scanner = null;
  toggleScanButtons(false);
  if (!s) return;
  try { await s.stop(); s.clear(); } catch { /* déjà arrêté */ }
}

$('#start-scan').addEventListener('click', startScanner);
$('#stop-scan').addEventListener('click', stopScanner);
$('#manual-code').addEventListener('submit', (e) => {
  e.preventDefault();
  stopScanner();
  lookup($('#code-input').value);
});
$('#manual-entry').addEventListener('click', () => {
  stopScanner();
  fillProduct({});
  showScanMsg('');
  $('#f-name').focus();
});

async function lookup(rawCode) {
  const code = String(rawCode).trim();
  if (!/^\d{6,14}$/.test(code)) { showScanMsg('Code-barres invalide.', true); return; }
  showScanMsg(`Recherche du produit ${code}…`);
  try {
    const { found, product } = await api(`/products/${code}`);
    if (found) {
      fillProduct({ code, ...product });
      const missing = product.kcal100 == null;
      showScanMsg(missing ? 'Produit trouvé, mais les calories sont manquantes : complétez-les.' : 'Produit trouvé.', missing);
    } else {
      fillProduct({ code });
      showScanMsg('Produit introuvable dans Open Food Facts. Saisissez les valeurs manuellement.', true);
    }
  } catch (err) {
    fillProduct({ code });
    showScanMsg(`${err.message}. Saisissez les valeurs manuellement.`, true);
  }
}

function defaultMeal() {
  const h = new Date().getHours();
  if (h < 10) return 'breakfast';
  if (h < 15) return 'lunch';
  if (h < 18) return 'snack';
  return 'dinner';
}

const fmtNum = (v) => (v == null || v === '' ? '' : Math.round(Number(v) * 10) / 10);

function fillProduct(p) {
  const form = $('#product-form');
  form.dataset.code = p.code || '';
  $('#f-name').value = p.name || '';
  $('#f-brand').value = p.brand || '';
  $('#f-kcal').value = fmtNum(p.kcal100);
  $('#f-p').value = fmtNum(p.p100);
  $('#f-c').value = fmtNum(p.c100);
  $('#f-f').value = fmtNum(p.f100);
  $('#f-qty').value = p.quantity || 100;
  $('#f-meal').value = defaultMeal();
  $('#f-date').value = toISO(new Date());
  const img = $('#f-image');
  img.hidden = !(p.image && p.image.startsWith('https://'));
  if (!img.hidden) img.src = p.image;
  updateTotal();
  form.hidden = false;
  form.scrollIntoView({ behavior: 'smooth' });
}

function updateTotal() {
  $('#f-total').textContent = round((num($('#f-kcal').value) * num($('#f-qty').value)) / 100);
}
['#f-kcal', '#f-qty'].forEach((s) => $(s).addEventListener('input', updateTotal));

$('#cancel-product').addEventListener('click', () => {
  $('#product-form').hidden = true;
  showScanMsg('');
});

$('#product-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const submit = e.submitter;
  const entry = {
    date: $('#f-date').value,
    meal: $('#f-meal').value,
    code: e.target.dataset.code,
    name: $('#f-name').value.trim(),
    brand: $('#f-brand').value.trim(),
    quantity: num($('#f-qty').value),
    kcal100: num($('#f-kcal').value),
    p100: num($('#f-p').value),
    c100: num($('#f-c').value),
    f100: num($('#f-f').value),
  };
  if (submit) submit.disabled = true;
  try {
    await api('/entries', { method: 'POST', body: entry });
  } catch (err) {
    showScanMsg(err.message, true);
    return;
  } finally {
    if (submit) submit.disabled = false;
  }
  e.target.hidden = true;
  $('#code-input').value = '';
  showScanMsg('');
  state.date = entry.date;
  state.mode = 'day';
  $$('.segmented button').forEach((x) => x.classList.toggle('active', x.dataset.mode === 'day'));
  showView('dashboard');
});

/* ---------- Profil ---------- */

async function renderProfile() {
  const p = state.profile;
  if (p) {
    $('#p-sex').value = p.sex;
    $('#p-age').value = p.age;
    $('#p-height').value = p.height;
    $('#p-weight').value = p.weight;
    $('#p-activity').value = String(p.activity);
    $('#p-deficit').value = String(p.deficit);
  }

  const needs = computeNeeds(p);
  const results = $('#profile-results');
  results.hidden = !needs;
  if (needs) {
    const weeklyLoss = ((needs.tdee - needs.target) * 7) / KCAL_PER_KG_FAT;
    results.innerHTML = `
      <h2>Vos besoins</h2>
      <div class="stat"><span>IMC</span><strong>${needs.bmi.toFixed(1)} – ${bmiLabel(needs.bmi)}</strong></div>
      <div class="stat"><span>Métabolisme de base</span><strong>${round(needs.bmr)} kcal</strong></div>
      <div class="stat"><span>Dépense journalière (maintien)</span><strong>${round(needs.tdee)} kcal</strong></div>
      <div class="stat highlight"><span>Objectif régime</span><strong>${round(needs.target)} kcal / jour</strong></div>
      <div class="stat"><span>Perte estimée</span><strong>~${weeklyLoss.toFixed(2)} kg / semaine</strong></div>
      ${needs.floorApplied ? `<p class="muted">Objectif relevé au minimum recommandé de ${needs.floor} kcal/jour.</p>` : ''}
      <p class="muted">Estimation (formule Mifflin-St Jeor). Demandez l'avis d'un professionnel de santé avant un régime.</p>`;
  }

  let weights;
  try {
    weights = await api('/weights');
  } catch (err) {
    $('#weight-history').innerHTML = `<p class="msg error">${esc(err.message)}</p>`;
    return;
  }
  $('#weight-history').innerHTML = weights.length
    ? weights.slice(0, 15).map((w, i) => {
      const prev = weights[i + 1];
      const diff = prev ? w.weight - prev.weight : 0;
      const cls = diff < 0 ? 'down' : diff > 0 ? 'up' : '';
      return `<div class="weight-row">
        <span>${fromISO(w.date).toLocaleDateString('fr-FR')}</span>
        <span><strong>${w.weight.toFixed(1)} kg</strong> ${prev ? `<small class="${cls}">(${diff > 0 ? '+' : ''}${diff.toFixed(1)})</small>` : ''}</span>
      </div>`;
    }).join('')
    : '<p class="muted">Aucune pesée enregistrée.</p>';
}

$('#profile-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const profile = {
    sex: $('#p-sex').value,
    age: num($('#p-age').value),
    height: num($('#p-height').value),
    weight: num($('#p-weight').value),
    activity: num($('#p-activity').value),
    deficit: num($('#p-deficit').value),
  };
  const msg = $('#profile-msg');
  try {
    state.profile = await api('/profile', { method: 'PUT', body: { ...profile, date: toISO(new Date()) } });
    msg.textContent = 'Profil enregistré.';
    msg.classList.remove('error');
    setTimeout(() => { msg.textContent = ''; }, 2500);
    renderProfile();
  } catch (err) {
    msg.textContent = err.message;
    msg.classList.add('error');
  }
});

/* ---------- Initialisation ---------- */

setAuthMode('login');
api('/auth/me').then(onLoggedIn).catch(() => showAuth());

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
