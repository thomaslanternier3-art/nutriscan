'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const MEALS = { breakfast: 'Petit-déjeuner', lunch: 'Déjeuner', snack: 'Collation', dinner: 'Dîner' };
const KCAL_PER_KG_FAT = 7700;
const ASSET_CATEGORIES = {
  real_estate: 'Immobilier',
  stocks: 'Bourse',
  bank: 'Banque & épargne',
  crypto: 'Cryptoactifs',
  vehicles: 'Véhicules',
  valuables: 'Biens de valeur',
  other: 'Autres',
};
const PROPERTY_TYPES = {
  unfurnished: 'Location nue',
  furnished_long: 'Location meublée longue durée',
  tourism_classified: 'Meublé de tourisme classé',
  tourism_unclassified: 'Meublé de tourisme non classé',
};
const PROPERTY_TRANSACTION_LABELS = {
  rent: 'Loyer encaissé',
  other_income: 'Autre recette / indemnité',
  recovered_charges: 'Charges récupérées / provisions',
  property_tax: 'Taxe foncière',
  coproperty: 'Copropriété non récupérable',
  insurance: 'Assurance propriétaire',
  management: 'Gestion / administration',
  repairs: 'Travaux / réparations',
  major_works: 'Gros travaux / amélioration',
  loan_interest: 'Intérêts d’emprunt',
  accounting: 'Comptabilité / frais divers',
  cfe: 'CFE',
  acquisition_fees: 'Frais d’acquisition',
  utilities: 'Énergie / fluides à charge',
  loan_principal: 'Remboursement du capital',
  other_expense: 'Autre charge à vérifier',
};
const PROPERTY_INCOME = new Set(['rent', 'other_income', 'recovered_charges']);
const PROPERTY_DEDUCTIBLE = new Set(['property_tax', 'coproperty', 'insurance', 'management', 'repairs', 'loan_interest', 'accounting', 'utilities']);
const euro = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
const compactEuro = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', notation: 'compact', maximumFractionDigits: 1 });
const SIMULATION_FIELDS = [
  ['purchasePrice', 'sim-price'], ['notaryRate', 'sim-notary'], ['agencyRate', 'sim-agency'],
  ['works', 'sim-works'], ['furnishing', 'sim-furnishing'], ['acquisitionOther', 'sim-acquisition-other'],
  ['rentMonthly', 'sim-rent'], ['otherIncomeMonthly', 'sim-income-other'], ['vacancyRate', 'sim-vacancy'],
  ['rentGrowthRate', 'sim-rent-growth'], ['propertyTaxAnnual', 'sim-property-tax'], ['condoAnnual', 'sim-condo'],
  ['insuranceAnnual', 'sim-insurance'], ['maintenanceAnnual', 'sim-maintenance'], ['managementRate', 'sim-management'],
  ['otherExpensesAnnual', 'sim-expenses-other'], ['expenseGrowthRate', 'sim-expense-growth'],
  ['downPayment', 'sim-down'], ['interestRate', 'sim-interest'], ['loanTermYears', 'sim-term'],
  ['loanInsuranceRate', 'sim-loan-insurance'], ['holdingYears', 'sim-horizon'],
  ['propertyGrowthRate', 'sim-property-growth'], ['saleFeeRate', 'sim-sale-fees'],
  ['taxRegime', 'sim-tax-regime'], ['incomeTaxRate', 'sim-tax-rate'], ['socialRate', 'sim-social-rate'],
];

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

const state = {
  date: toISO(new Date()), mode: 'day', profile: null, entries: [], assets: [], properties: [],
  wealthTab: 'overview', activePropertyId: '', propertyTransactions: [],
};
let renderToken = 0;
let wealthRenderToken = 0;

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

const NAV_ITEMS = {
  home: [
    { view: 'home', icon: '&#8962;', label: 'Modules' },
  ],
  modules: {
    nutriscan: {
      title: 'NutriScan',
      views: ['nutriscan', 'scan', 'profile'],
      items: [
        { view: 'home', icon: '&#8962;', label: 'Modules' },
        { view: 'nutriscan', icon: '&#128202;', label: 'Résumé' },
        { view: 'scan', icon: '&#128247;', label: 'Scanner' },
        { view: 'profile', icon: '&#128100;', label: 'Profil' },
      ],
    },
    patrimoine: {
      title: 'Patrimoine',
      views: ['patrimoine'],
      items: [
        { view: 'home', icon: '&#8962;', label: 'Modules' },
        { view: 'patrimoine', icon: '&#128188;', label: 'Patrimoine' },
      ],
    },
    simulation: {
      title: 'Simulation',
      views: ['simulation'],
      items: [
        { view: 'home', icon: '&#8962;', label: 'Modules' },
        { view: 'simulation', icon: '&#128200;', label: 'Simulation' },
      ],
    },
  },
};

function moduleForView(view) {
  return Object.entries(NAV_ITEMS.modules).find(([, module]) => module.views.includes(view))?.[0];
}

function renderNav(view) {
  const moduleId = moduleForView(view);
  const items = moduleId ? NAV_ITEMS.modules[moduleId].items : NAV_ITEMS.home;
  $('.bottom-nav').innerHTML = items.map(({ view: destination, icon, label }) => `
    <button class="nav-item${destination === view ? ' active' : ''}" data-view="${destination}" type="button">
      <span class="nav-icon" aria-hidden="true">${icon}</span><span>${label}</span>
    </button>`).join('');
}

function showView(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  const moduleId = moduleForView(name);
  renderNav(name);
  $('#home-button').hidden = !moduleId;
  $('#app-title').textContent = moduleId ? NAV_ITEMS.modules[moduleId].title : 'Mon espace';
  if (name !== 'scan') stopScanner();
  if (name === 'nutriscan') renderDashboard();
  if (name === 'profile') renderProfile();
  if (name === 'patrimoine') {
    renderPatrimoine();
    if (state.wealthTab === 'realestate') loadProperties(state.activePropertyId);
  }
  if (name === 'simulation') enterSimulation();
}

async function renderPatrimoine() {
  const token = ++wealthRenderToken;
  try {
    [state.assets, state.properties] = await Promise.all([api('/assets'), api('/properties')]);
  } catch (err) {
    $('#wealth-categories').innerHTML = `<p class="msg error">${esc(err.message)}</p>`;
    $('#wealth-assets').innerHTML = '';
    return;
  }
  if (token !== wealthRenderToken) return;
  $('#wealth-overview-panel').hidden = state.wealthTab !== 'overview';
  $('#wealth-realestate-panel').hidden = state.wealthTab !== 'realestate';
  $$('[data-wealth-tab]').forEach((button) => {
    const active = button.dataset.wealthTab === state.wealthTab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });

  const propertyAssets = state.properties.map((property) => ({
    id: `property:${property.id}`,
    propertyId: property.id,
    name: property.name,
    category: 'real_estate',
    value: property.currentValue * property.ownershipShare / 100,
    notes: property.address,
    isProperty: true,
  }));
  const displayAssets = [...state.assets, ...propertyAssets];
  const total = displayAssets.reduce((sum, asset) => sum + asset.value, 0);
  $('#wealth-total').textContent = euro.format(total);
  $('#wealth-count').textContent = `${displayAssets.length} actif${displayAssets.length === 1 ? '' : 's'}`;

  const groups = Object.keys(ASSET_CATEGORIES).map((category) => ({
    category,
    items: displayAssets.filter((asset) => asset.category === category),
  })).filter((group) => group.items.length);

  $('#wealth-categories').innerHTML = groups.length
    ? groups.map(({ category, items }) => {
      const value = items.reduce((sum, asset) => sum + asset.value, 0);
      const share = total ? (value / total) * 100 : 0;
      return `<div class="allocation-row" data-category="${category}">
        <div class="allocation-label"><span>${ASSET_CATEGORIES[category]}</span><strong>${euro.format(value)}</strong></div>
        <div class="allocation-track"><span style="width:${share}%"></span></div>
        <small>${share.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} % du patrimoine</small>
      </div>`;
    }).join('')
    : '<p class="muted">Ajoutez un actif pour voir sa répartition ici.</p>';

  $('#wealth-assets').innerHTML = groups.length
    ? groups.map(({ category, items }) => `
      <section class="asset-group" data-category="${category}">
        <div class="asset-group-heading"><h3>${ASSET_CATEGORIES[category]}</h3><span>${items.length}</span></div>
        ${items.map((asset) => `
          <div class="asset-row">
            <div class="asset-description"><strong>${esc(asset.name)}</strong>${asset.notes ? `<small>${esc(asset.notes)}</small>` : ''}</div>
            ${asset.isProperty
              ? `<button class="asset-value-link" type="button" data-open-property="${esc(asset.propertyId)}">${euro.format(asset.value)} &#8594;</button>`
              : `<div class="asset-actions"><strong>${euro.format(asset.value)}</strong>
                  <button class="icon-btn" type="button" data-edit-asset="${esc(asset.id)}" aria-label="Modifier ${esc(asset.name)}" title="Modifier">&#9998;</button>
                  <button class="icon-btn" type="button" data-delete-asset="${esc(asset.id)}" aria-label="Supprimer ${esc(asset.name)}" title="Supprimer">&#10005;</button>
                </div>`}
          </div>`).join('')}
      </section>`).join('')
    : '<p class="muted">Aucun actif enregistré pour le moment.</p>';
}

function openAssetForm(asset = null) {
  const form = $('#asset-form');
  form.dataset.assetId = asset?.id || '';
  $('#asset-form-title').textContent = asset ? 'Modifier l’actif' : 'Nouvel actif';
  $('#asset-name').value = asset?.name || '';
  $('#asset-category').value = asset?.category || 'real_estate';
  $('#asset-value').value = asset?.value ?? '';
  $('#asset-notes').value = asset?.notes || '';
  $('#asset-save').textContent = asset ? 'Enregistrer les modifications' : 'Enregistrer';
  form.hidden = false;
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('#asset-name').focus();
}

$('#asset-add').addEventListener('click', () => {
  $('#wealth-msg').textContent = '';
  $('#wealth-msg').classList.remove('error');
  openAssetForm();
});

$('#asset-cancel').addEventListener('click', () => {
  $('#asset-form').hidden = true;
  $('#asset-form').dataset.assetId = '';
});

$('#asset-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const id = form.dataset.assetId;
  const payload = {
    name: $('#asset-name').value.trim(),
    category: $('#asset-category').value,
    value: num($('#asset-value').value),
    notes: $('#asset-notes').value.trim(),
  };
  $('#asset-save').disabled = true;
  try {
    await api(id ? `/assets/${encodeURIComponent(id)}` : '/assets', { method: id ? 'PUT' : 'POST', body: payload });
    form.reset();
    form.dataset.assetId = '';
    form.hidden = true;
    await renderPatrimoine();
    $('#wealth-msg').textContent = id ? 'Actif mis à jour.' : 'Actif ajouté.';
    $('#wealth-msg').classList.remove('error');
  } catch (err) {
    $('#wealth-msg').textContent = err.message;
    $('#wealth-msg').classList.add('error');
  } finally {
    $('#asset-save').disabled = false;
  }
});

$('#wealth-assets').addEventListener('click', async (e) => {
  const propertyLink = e.target.closest('[data-open-property]');
  if (propertyLink) {
    setWealthTab('realestate', propertyLink.dataset.openProperty);
    return;
  }
  const edit = e.target.closest('[data-edit-asset]');
  if (edit) {
    const asset = state.assets.find((item) => item.id === edit.dataset.editAsset);
    if (asset) openAssetForm(asset);
    return;
  }
  const remove = e.target.closest('[data-delete-asset]');
  if (!remove || !confirm('Supprimer cet actif ?')) return;
  try {
    await api(`/assets/${encodeURIComponent(remove.dataset.deleteAsset)}`, { method: 'DELETE' });
    await renderPatrimoine();
    $('#wealth-msg').textContent = 'Actif supprimé.';
    $('#wealth-msg').classList.remove('error');
  } catch (err) {
    $('#wealth-msg').textContent = err.message;
    $('#wealth-msg').classList.add('error');
  }
});

let propertyDetailToken = 0;

function currentYear() {
  return new Date().getFullYear();
}

function setYearOptions(select, preferredYear = currentYear()) {
  select.innerHTML = Array.from({ length: 11 }, (_, i) => currentYear() - i)
    .map((year) => `<option value="${year}">${year}</option>`).join('');
  select.value = String(preferredYear);
}

async function loadProperties(openId = '') {
  try {
    state.properties = await api('/properties');
    renderPropertyList();
    if (openId) await openPropertyDetail(openId);
  } catch (err) {
    $('#property-msg').textContent = err.message;
    $('#property-msg').classList.add('error');
  }
}

function renderPropertyList() {
  $('#property-list').hidden = false;
  $('#property-detail').hidden = true;
  $('#property-form').hidden = true;
  $('#property-list').innerHTML = state.properties.length
    ? state.properties.map((property) => `
      <button class="property-card" type="button" data-property-id="${esc(property.id)}">
        <span><strong>${esc(property.name)}</strong><small>${esc(PROPERTY_TYPES[property.type] || '')}${property.address ? ` · ${esc(property.address)}` : ''}</small></span>
        <span class="property-card-value">${euro.format(property.currentValue * property.ownershipShare / 100)}<small>votre quote-part</small></span>
      </button>`).join('')
    : '<p class="muted empty-properties">Aucun bien immobilier enregistré.</p>';
}

function setWealthTab(tab, openId = '') {
  state.wealthTab = tab;
  $$('[data-wealth-tab]').forEach((button) => {
    const active = button.dataset.wealthTab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  $('#wealth-overview-panel').hidden = tab !== 'overview';
  $('#wealth-realestate-panel').hidden = tab !== 'realestate';
  if (tab === 'realestate') loadProperties(openId);
  else renderPatrimoine();
}

$$('[data-wealth-tab]').forEach((button) => button.addEventListener('click', () => setWealthTab(button.dataset.wealthTab)));

$('#property-list').addEventListener('click', (e) => {
  const card = e.target.closest('[data-property-id]');
  if (card) openPropertyDetail(card.dataset.propertyId);
});

function openPropertyForm(property = null) {
  const form = $('#property-form');
  form.dataset.propertyId = property?.id || '';
  $('#property-form-title').textContent = property ? 'Modifier le bien' : 'Nouveau bien immobilier';
  $('#property-name').value = property?.name || '';
  $('#property-address').value = property?.address || '';
  $('#property-type').value = property?.type || 'unfurnished';
  $('#property-regime').value = property?.taxRegime || 'micro';
  $('#property-landlord-status').value = property?.landlordStatus || 'non_professional';
  $('#property-share').value = property?.ownershipShare ?? 100;
  $('#property-acquired').value = property?.acquisitionDate || '';
  $('#property-purchase').value = property?.purchasePrice ?? 0;
  $('#property-value').value = property?.currentValue ?? 0;
  $('#property-rent').value = property?.monthlyRent ?? 0;
  $('#property-notes').value = property?.notes || '';
  form.hidden = false;
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('#property-add').addEventListener('click', () => {
  $('#property-msg').textContent = '';
  $('#property-msg').classList.remove('error');
  openPropertyForm();
});

$('#property-cancel').addEventListener('click', () => {
  $('#property-form').hidden = true;
  $('#property-form').dataset.propertyId = '';
});

$('#property-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const id = form.dataset.propertyId;
  const payload = {
    name: $('#property-name').value.trim(),
    address: $('#property-address').value.trim(),
    type: $('#property-type').value,
    taxRegime: $('#property-regime').value,
    landlordStatus: $('#property-landlord-status').value,
    ownershipShare: num($('#property-share').value),
    acquisitionDate: $('#property-acquired').value,
    purchasePrice: num($('#property-purchase').value),
    currentValue: num($('#property-value').value),
    monthlyRent: num($('#property-rent').value),
    notes: $('#property-notes').value.trim(),
  };
  $('#property-save').disabled = true;
  try {
    const saved = await api(id ? `/properties/${encodeURIComponent(id)}` : '/properties', { method: id ? 'PUT' : 'POST', body: payload });
    form.reset();
    form.dataset.propertyId = '';
    form.hidden = true;
    $('#property-msg').textContent = id ? 'Bien mis à jour.' : 'Bien ajouté.';
    $('#property-msg').classList.remove('error');
    await loadProperties(saved.id);
    await renderPatrimoine();
  } catch (err) {
    $('#property-msg').textContent = err.message;
    $('#property-msg').classList.add('error');
  } finally {
    $('#property-save').disabled = false;
  }
});

$('#property-back').addEventListener('click', renderPropertyList);
$('#property-edit').addEventListener('click', () => {
  const property = state.properties.find((item) => item.id === state.activePropertyId);
  if (property) openPropertyForm(property);
});

$('#property-delete').addEventListener('click', async () => {
  if (!state.activePropertyId || !confirm('Supprimer ce bien et toutes ses écritures ?')) return;
  try {
    await api(`/properties/${encodeURIComponent(state.activePropertyId)}`, { method: 'DELETE' });
    state.activePropertyId = '';
    $('#property-msg').textContent = 'Bien et journal supprimés.';
    $('#property-msg').classList.remove('error');
    await loadProperties();
    await renderPatrimoine();
  } catch (err) {
    $('#property-msg').textContent = err.message;
    $('#property-msg').classList.add('error');
  }
});

async function openPropertyDetail(id) {
  const property = state.properties.find((item) => item.id === id);
  if (!property) return;
  state.activePropertyId = id;
  const token = ++propertyDetailToken;
  const chartYear = Number($('#property-chart-year').value) || currentYear();
  const taxYear = Number($('#tax-year').value) || currentYear();
  $('#property-list').hidden = true;
  $('#property-form').hidden = true;
  $('#property-detail').hidden = false;
  $('#property-summary').innerHTML = `
    <div class="property-summary-name"><span>Bien immobilier</span><strong>${esc(property.name)}</strong></div>
    <div><span>Valeur actuelle · quote-part ${property.ownershipShare} %</span><strong>${euro.format(property.currentValue * property.ownershipShare / 100)}</strong></div>
    <div><span>Loyer mensuel indicatif</span><strong>${euro.format(property.monthlyRent)}</strong></div>
    <div><span>Régime déclaré</span><strong>${property.taxRegime === 'micro' ? 'Micro' : 'Réel'} · ${PROPERTY_TYPES[property.type]}</strong></div>
    ${property.address ? `<p>${esc(property.address)}</p>` : ''}`;

  setYearOptions($('#property-chart-year'), chartYear);
  setYearOptions($('#tax-year'), taxYear);
  try {
    state.propertyTransactions = await api(`/properties/${encodeURIComponent(id)}/transactions`);
  } catch (err) {
    if (token === propertyDetailToken) $('#property-msg').textContent = err.message;
    return;
  }
  if (token !== propertyDetailToken || state.activePropertyId !== id) return;
  renderPropertyYear();
  renderPropertyTransactionList();
  renderPropertyTaxReport();
}

function renderPropertyYear() {
  const year = Number($('#property-chart-year').value || currentYear());
  const property = state.properties.find((item) => item.id === state.activePropertyId);
  if (!property) return;
  const months = Array.from({ length: 12 }, (_, index) => ({
    month: index,
    income: 0,
    expenses: 0,
  }));
  for (const transaction of state.propertyTransactions) {
    if (Number(transaction.date.slice(0, 4)) !== year) continue;
    const month = Number(transaction.date.slice(5, 7)) - 1;
    if (month < 0 || month > 11) continue;
    const total = transaction.amount * property.ownershipShare / 100;
    if (transaction.type === 'income') months[month].income += total;
    else months[month].expenses += total;
  }
  const max = Math.max(1, ...months.flatMap((item) => [item.income, item.expenses]));
  $('#property-profit-chart').innerHTML = `<div class="property-month-chart">${months.map((item) => {
    const net = item.income - item.expenses;
    const monthLabel = new Date(year, item.month, 1).toLocaleDateString('fr-FR', { month: 'short' });
    return `<div class="property-month" title="${monthLabel} ${year} · recettes ${euro.format(item.income)} · dépenses ${euro.format(item.expenses)} · solde ${euro.format(net)}">
      <div class="property-month-bars"><i class="income" style="height:${item.income / max * 100}%"></i><i class="expense" style="height:${item.expenses / max * 100}%"></i></div>
      <small>${monthLabel}</small>
    </div>`;
  }).join('')}</div>`;
  $('#property-monthly-breakdown').innerHTML = `<table><thead><tr><th>Mois</th><th>Recettes</th><th>Dépenses</th><th>Solde</th></tr></thead><tbody>
    ${months.map((item) => `<tr><td>${new Date(year, item.month, 1).toLocaleDateString('fr-FR', { month: 'long' })}</td>
      <td>${euro.format(item.income)}</td><td>${euro.format(item.expenses)}</td>
      <td class="${item.income >= item.expenses ? 'positive-text' : 'negative-text'}">${euro.format(item.income - item.expenses)}</td></tr>`).join('')}
  </tbody></table>`;
  const income = months.reduce((sum, item) => sum + item.income, 0);
  const expenses = months.reduce((sum, item) => sum + item.expenses, 0);
  $('#property-year-totals').innerHTML = `
    <span><i class="legend-dot income"></i> Recettes ${euro.format(income)}</span>
    <span><i class="legend-dot expense"></i> Dépenses ${euro.format(expenses)}</span>
    <strong class="${income >= expenses ? 'positive-text' : 'negative-text'}">Solde ${euro.format(income - expenses)}</strong>`;
}

$('#property-chart-year').addEventListener('change', renderPropertyYear);
$('#tax-year').addEventListener('change', renderPropertyTaxReport);

function renderPropertyTransactionList() {
  const property = state.properties.find((item) => item.id === state.activePropertyId);
  if (!property) return;
  $('#property-transactions').innerHTML = state.propertyTransactions.length
    ? state.propertyTransactions.map((transaction) => {
      const signedValue = transaction.type === 'income' ? transaction.amount : -transaction.amount;
      const ownedValue = signedValue * property.ownershipShare / 100;
      return `<div class="transaction-row">
        <div><strong>${PROPERTY_TRANSACTION_LABELS[transaction.category] || 'Mouvement'}</strong>
          <small>${fromISO(transaction.date).toLocaleDateString('fr-FR')}${transaction.description ? ` · ${esc(transaction.description)}` : ''}</small></div>
        <div class="transaction-actions"><strong class="${ownedValue >= 0 ? 'positive-text' : 'negative-text'}">${euro.format(ownedValue)}</strong>
          <button class="icon-btn" type="button" data-delete-transaction="${esc(transaction.id)}" aria-label="Supprimer le mouvement">&#10005;</button></div>
      </div>`;
    }).join('')
    : '<p class="muted">Aucun mouvement enregistré pour ce bien.</p>';
}

$('#transaction-add').addEventListener('click', () => {
  const form = $('#transaction-form');
  form.reset();
  $('#transaction-date').value = toISO(new Date());
  form.hidden = false;
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

$('#transaction-cancel').addEventListener('click', () => { $('#transaction-form').hidden = true; });

$('#transaction-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = $('#transaction-save');
  button.disabled = true;
  try {
    await api(`/properties/${encodeURIComponent(state.activePropertyId)}/transactions`, {
      method: 'POST',
      body: {
        date: $('#transaction-date').value,
        category: $('#transaction-category').value,
        amount: num($('#transaction-amount').value),
        description: $('#transaction-description').value.trim(),
      },
    });
    $('#transaction-form').hidden = true;
    await openPropertyDetail(state.activePropertyId);
  } catch (err) {
    $('#property-msg').textContent = err.message;
    $('#property-msg').classList.add('error');
  } finally {
    button.disabled = false;
  }
});

$('#property-transactions').addEventListener('click', async (e) => {
  const button = e.target.closest('[data-delete-transaction]');
  if (!button || !confirm('Supprimer ce mouvement ?')) return;
  try {
    await api(`/properties/${encodeURIComponent(state.activePropertyId)}/transactions/${encodeURIComponent(button.dataset.deleteTransaction)}`, { method: 'DELETE' });
    await openPropertyDetail(state.activePropertyId);
  } catch (err) {
    $('#property-msg').textContent = err.message;
    $('#property-msg').classList.add('error');
  }
});

function transactionsForYear(year) {
  return state.propertyTransactions.filter((item) => Number(item.date.slice(0, 4)) === year);
}

function propertyTaxNumbers(property, transactions) {
  const share = property.ownershipShare / 100;
  const sum = (items) => items.reduce((total, item) => total + item.amount, 0) * share;
  const receipts = transactions.filter((item) => item.type === 'income');
  const expenses = transactions.filter((item) => item.type === 'expense');
  const rents = sum(receipts.filter((item) => item.category === 'rent'));
  const otherIncome = sum(receipts.filter((item) => item.category === 'other_income'));
  const recoveredCharges = sum(receipts.filter((item) => item.category === 'recovered_charges'));
  const deductible = sum(expenses.filter((item) => PROPERTY_DEDUCTIBLE.has(item.category)));
  const interest = sum(expenses.filter((item) => item.category === 'loan_interest'));
  const chargesNotInterest = sum(expenses.filter((item) => PROPERTY_DEDUCTIBLE.has(item.category) && item.category !== 'loan_interest'));
  const excludedExpenses = sum(expenses.filter((item) => !PROPERTY_DEDUCTIBLE.has(item.category)));
  return { share, rents, otherIncome, recoveredCharges, deductible, interest, chargesNotInterest, excludedExpenses, income: sum(receipts) };
}

function taxBoxHTML(box, description, amount, hint = '') {
  return `<div class="tax-box-row"><strong>${box}</strong><span>${description}${hint ? `<small>${hint}</small>` : ''}</span><b>${amount == null ? 'À calculer' : euro.format(amount)}</b></div>`;
}

function renderPropertyTaxReport() {
  const property = state.properties.find((item) => item.id === state.activePropertyId);
  if (!property) return;
  const year = Number($('#tax-year').value || currentYear());
  const items = transactionsForYear(year);
  const totals = propertyTaxNumbers(property, items);
  const printIntro = `<h1>Rapport préparatoire – Revenus immobiliers ${year}</h1>
    <p><strong>${esc(property.name)}</strong> · ${esc(property.address || 'Adresse non renseignée')}</p>
    <p>Type : ${PROPERTY_TYPES[property.type]} · Régime : ${property.taxRegime === 'micro' ? 'micro' : 'réel'} · Quote-part : ${property.ownershipShare} %</p>
    <p>Édité le ${new Date().toLocaleDateString('fr-FR')}</p>`;
  let rows = '';
  let disclaimer = '';

  if (property.type === 'unfurnished' && property.taxRegime === 'micro') {
    const gross = totals.rents + totals.otherIncome;
    rows = taxBoxHTML('2042 · 4BE', 'Revenus fonciers bruts à déclarer au micro-foncier', gross)
      + taxBoxHTML('Estimation', 'Base après abattement forfaitaire de 30 %', gross * 0.7);
    disclaimer = 'Les charges récupérées sont isolées et ne sont pas ajoutées automatiquement au montant 4BE. Leur traitement dépend de leur nature. Le micro-foncier est soumis à conditions et à un plafond global du foyer fiscal.';
  } else if (property.type === 'unfurnished' && property.taxRegime === 'real') {
    const net = totals.rents + totals.otherIncome + totals.recoveredCharges - totals.deductible;
    if (net >= 0) {
      rows = taxBoxHTML('2042 · 4BA', 'Revenu foncier net positif estimé (après déclaration 2044)', net);
    } else {
      const nonInterestDeficit = Math.max(0, totals.chargesNotInterest - totals.rents - totals.otherIncome - totals.recoveredCharges);
      const interestDeficit = Math.min(totals.interest, Math.max(0, -net));
      const globalDeductible = Math.min(10700, nonInterestDeficit);
      rows = taxBoxHTML('2042 · 4BC', 'Déficit imputable estimatif, plafond général de 10 700 €', globalDeductible)
        + taxBoxHTML('2042 · 4BB', 'Part estimée reportable sur revenus fonciers futurs', Math.max(0, -net - globalDeductible), 'Inclut la part liée aux intérêts d’emprunt et dépassements de plafond.');
    }
    rows += `<div class="tax-breakdown"><strong>À reporter / vérifier sur la déclaration 2044</strong>
      <p>Loyers et autres recettes : ${euro.format(totals.rents + totals.otherIncome + totals.recoveredCharges)}</p>
      <p>Charges déductibles enregistrées : ${euro.format(totals.deductible)}</p>
      <p>Dont intérêts d’emprunt : ${euro.format(totals.interest)}</p>
      <p>Dépenses exclues du calcul : ${euro.format(totals.excludedExpenses)}</p></div>`;
    disclaimer = 'Estimation simplifiée : vérifiez la déductibilité de chaque dépense, les régularisations de copropriété, les déficits antérieurs et les éventuels plafonds majorés pour travaux énergétiques. Le report 4BB dépend aussi de votre historique fiscal.';
  } else if (property.taxRegime === 'micro' && property.landlordStatus === 'non_professional') {
    let box;
    let allowance;
    if (property.type === 'tourism_classified') { box = '5NG / 5OG / 5PG'; allowance = '50 %'; }
    else if (property.type === 'tourism_unclassified') { box = '5NH / 5OH / 5PH'; allowance = '30 %'; }
    else { box = '5NI / 5OI / 5PI'; allowance = '50 %'; }
    rows = taxBoxHTML(`2042-C-PRO · ${box}`, 'Recettes brutes de location meublée non professionnelle à déclarer', totals.income)
      + `<div class="tax-breakdown"><strong>Abattement forfaitaire officiel indicatif : ${allowance}</strong><p>Le calcul de l’abattement et du revenu imposable est effectué par l’administration.</p></div>`;
    disclaimer = 'Les suffixes de cases varient selon le déclarant du foyer. Seuils et conditions du micro à vérifier pour l’année concernée ; le minimum d’abattement s’apprécie au niveau de l’activité déclarée.';
  } else if (property.taxRegime === 'real' && property.landlordStatus === 'non_professional') {
    const box = property.type === 'unfurnished' ? '' : '5NA / 5OA / 5PA';
    rows = taxBoxHTML('Liasse 2031-SD', 'Résultat comptable à faire établir (dont amortissements)', null, 'Non calculé par cette application')
      + (box ? taxBoxHTML(`2042-C-PRO · ${box}`, 'Bénéfice LMNP issu de la liasse 2031', null, 'À recopier depuis le résultat fiscal validé') : '');
    disclaimer = 'Le régime réel meublé requiert une comptabilité et une liasse 2031, notamment pour traiter amortissements et déficits. Aucun montant de case ne peut être déduit du seul journal de recettes et dépenses.';
  } else if (property.taxRegime === 'real' && property.landlordStatus === 'professional') {
    rows = taxBoxHTML('Liasse 2031-SD', 'Résultat professionnel à faire établir', null, 'Non calculé par cette application')
      + taxBoxHTML('2042-C-PRO · 5KC / 5LC / 5MC', 'Bénéfice BIC professionnel issu de la liasse', null, 'À recopier depuis le résultat fiscal validé');
    disclaimer = 'Le régime réel BIC nécessite une comptabilité complète et la liasse 2031. Vérifiez le statut LMP au niveau du foyer fiscal et les cases de l’année déclarée.';
  } else {
    rows = `<p>Pour un loueur professionnel au micro, vérifiez la case applicable à votre activité et à l’année sur la notice 2042-C-PRO.</p>`;
    disclaimer = 'Les recettes et charges ci-dessous sont une synthèse du journal, pas un calcul comptable ou fiscal validé.';
  }

  const sourceLinks = `<p class="tax-sources">Sources officielles : <a href="https://www.impots.gouv.fr/particulier/location-vide-de-meubles" target="_blank" rel="noreferrer">Location vide de meubles</a> · <a href="https://www.impots.gouv.fr/particulier/location-meublee" target="_blank" rel="noreferrer">Location meublée</a>.</p>`;
  const journalSummary = `<div class="tax-breakdown"><strong>Synthèse saisie · quote-part ${property.ownershipShare} %</strong>
    <p>Recettes totales du journal : ${euro.format(totals.income)}</p>
    <p>Dépenses totales du journal : ${euro.format(items.filter((item) => item.type === 'expense').reduce((sum, item) => sum + item.amount, 0) * totals.share)}</p></div>`;
  const reportHTML = `${printIntro}<p class="tax-perimeter">Montants calculés pour ce bien et votre quote-part. Ils doivent être agrégés avec vos autres biens et revenus relevant du même régime avant déclaration.</p>
    ${journalSummary}<div class="tax-report-rows">${rows}</div>
    <p class="tax-warning">Rapport préparatoire non télétransmis. Pour les revenus ${year}, vérifiez les cases et règles sur les formulaires officiels de la campagne déclarative correspondante. ${disclaimer}</p>
    ${sourceLinks}`;
  $('#tax-report').innerHTML = reportHTML;
  $('#tax-print-report').innerHTML = `${reportHTML}<h2>Journal annuel</h2>${renderPrintTransactions(property, items)}`;
}

function renderPrintTransactions(property, items) {
  if (!items.length) return '<p>Aucun mouvement enregistré pour cette année.</p>';
  return `<table><thead><tr><th>Date</th><th>Nature</th><th>Description</th><th>Montant · quote-part</th></tr></thead><tbody>
    ${items.slice().sort((a, b) => a.date.localeCompare(b.date)).map((item) => `
      <tr><td>${fromISO(item.date).toLocaleDateString('fr-FR')}</td><td>${PROPERTY_TRANSACTION_LABELS[item.category]}</td>
      <td>${esc(item.description || '')}</td><td>${euro.format(item.amount * property.ownershipShare / 100)}</td></tr>`).join('')}
  </tbody></table>`;
}

$('#tax-print').addEventListener('click', () => {
  renderPropertyTaxReport();
  document.body.classList.add('tax-printing');
  window.print();
  window.setTimeout(() => document.body.classList.remove('tax-printing'), 1000);
});

let savedSimulations = [];
let currentSimulationId = '';

function readSimulationInputs() {
  return Object.fromEntries(SIMULATION_FIELDS.map(([key, id]) => [
    key,
    id === 'sim-tax-regime' ? $(`#${id}`).value : num($(`#${id}`).value),
  ]));
}

function writeSimulationInputs(inputs) {
  for (const [key, id] of SIMULATION_FIELDS) {
    if (inputs[key] != null) $(`#${id}`).value = inputs[key];
  }
}

function calculateSimulation(inputs) {
  const purchasePrice = inputs.purchasePrice;
  const projectCost = purchasePrice
    + purchasePrice * (inputs.notaryRate + inputs.agencyRate) / 100
    + inputs.works + inputs.furnishing + inputs.acquisitionOther;
  const loanAmount = Math.max(0, projectCost - inputs.downPayment);
  const initialCash = projectCost - loanAmount;
  const termMonths = inputs.loanTermYears * 12;
  const monthlyRate = inputs.interestRate / 1200;
  const monthlyPayment = loanAmount === 0 ? 0 : monthlyRate === 0
    ? loanAmount / termMonths
    : loanAmount * monthlyRate / (1 - (1 + monthlyRate) ** -termMonths);
  const fixedExpenses = inputs.propertyTaxAnnual + inputs.condoAnnual + inputs.insuranceAnnual
    + inputs.maintenanceAnnual + inputs.otherExpensesAnnual;
  let loanBalance = loanAmount;
  let cumulativeCashFlow = 0;
  let elapsedMonths = 0;
  const years = [];

  for (let year = 1; year <= inputs.holdingYears; year += 1) {
    let interestPaid = 0;
    let paidMonths = 0;
    for (let month = 0; month < 12 && elapsedMonths < termMonths; month += 1) {
      const interest = loanBalance * monthlyRate;
      const principal = Math.min(loanBalance, Math.max(0, monthlyPayment - interest));
      interestPaid += interest;
      loanBalance = Math.max(0, loanBalance - principal);
      elapsedMonths += 1;
      paidMonths += 1;
    }

    const growthYear = year - 1;
    const rentCollected = (inputs.rentMonthly + inputs.otherIncomeMonthly) * 12
      * (1 - inputs.vacancyRate / 100) * (1 + inputs.rentGrowthRate / 100) ** growthYear;
    const operatingCosts = fixedExpenses * (1 + inputs.expenseGrowthRate / 100) ** growthYear
      + rentCollected * inputs.managementRate / 100;
    const taxableIncome = inputs.taxRegime === 'micro'
      ? rentCollected * 0.7
      : inputs.taxRegime === 'real'
        ? rentCollected - operatingCosts - interestPaid
        : 0;
    const tax = inputs.taxRegime === 'none'
      ? 0
      : Math.max(0, taxableIncome) * (inputs.incomeTaxRate + inputs.socialRate) / 100;
    const loanInsurance = loanAmount * inputs.loanInsuranceRate / 100 * paidMonths / 12;
    const debtService = monthlyPayment * paidMonths + loanInsurance;
    const cashFlow = rentCollected - operatingCosts - tax - debtService;
    cumulativeCashFlow += cashFlow;

    const estimatedValue = purchasePrice * (1 + inputs.propertyGrowthRate / 100) ** year;
    const saleCosts = estimatedValue * inputs.saleFeeRate / 100;
    const netEquity = estimatedValue - saleCosts - loanBalance;
    years.push({
      year, rentCollected, operatingCosts, interestPaid, tax, debtService, cashFlow,
      estimatedValue, loanBalance, netEquity, cumulativeCashFlow,
      netGain: netEquity + cumulativeCashFlow - initialCash,
    });
  }

  return {
    projectCost, loanAmount, initialCash, monthlyPayment,
    grossYield: projectCost ? (inputs.rentMonthly + inputs.otherIncomeMonthly) * 12 / projectCost * 100 : 0,
    netYield: projectCost ? (years[0].rentCollected - years[0].operatingCosts) / projectCost * 100 : 0,
    years,
  };
}

function renderCashFlowChart(years) {
  const maxFlow = Math.max(1, ...years.map((row) => Math.abs(row.cashFlow)));
  $('#sim-cashflow-chart').innerHTML = `<div class="sim-bars">${years.map((row) => {
    const height = Math.max(1, Math.abs(row.cashFlow) / maxFlow * 46);
    const top = row.cashFlow >= 0 ? 50 - height : 50;
    return `<div class="sim-bar-column" title="Année ${row.year} : ${euro.format(row.cashFlow)}">
      <span>${compactEuro.format(row.cashFlow)}</span>
      <div class="sim-bar-track"><i class="${row.cashFlow < 0 ? 'negative' : ''}" style="top:${top}%;height:${height}%"></i></div>
      <small>${row.year}</small>
    </div>`;
  }).join('')}</div>`;
}

function renderGainChart(result) {
  const series = [{ year: 0, netGain: -result.initialCash }, ...result.years];
  const width = Math.max(560, series.length * 52);
  const height = 250;
  const left = 76;
  const right = width - 18;
  const top = 18;
  const bottom = height - 34;
  const minValue = Math.min(0, ...series.map((row) => row.netGain));
  const maxValue = Math.max(0, ...series.map((row) => row.netGain));
  const range = Math.max(maxValue - minValue, 1);
  const x = (index) => left + index / (series.length - 1 || 1) * (right - left);
  const y = (value) => bottom - (value - minValue) / range * (bottom - top);
  const points = series.map((row, index) => `${x(index)},${y(row.netGain)}`).join(' ');
  const tickValues = [0, 0.25, 0.5, 0.75, 1].map((fraction) => minValue + range * fraction);
  const grids = tickValues.map((value) => `
    <line x1="${left}" y1="${y(value)}" x2="${right}" y2="${y(value)}" class="chart-grid" />
    <text x="${left - 8}" y="${y(value) + 4}" text-anchor="end">${compactEuro.format(value)}</text>`).join('');
  const labels = series.filter((row) => row.year === 0 || row.year === result.years.length || row.year % 5 === 0)
    .map((row) => {
      const index = series.findIndex((point) => point.year === row.year);
      return `<text x="${x(index)}" y="${height - 8}" text-anchor="middle">${row.year === 0 ? 'Départ' : `${row.year} ans`}</text>`;
    }).join('');
  const dots = series.map((row, index) => `<circle cx="${x(index)}" cy="${y(row.netGain)}" r="3.5"><title>${row.year === 0 ? 'Départ' : `Année ${row.year}`} : ${euro.format(row.netGain)}</title></circle>`).join('');
  $('#sim-gain-chart').innerHTML = `<svg class="gain-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Évolution du gain net potentiel entre le départ et l'année ${result.years.length}">
    ${grids}<line x1="${left}" y1="${y(0)}" x2="${right}" y2="${y(0)}" class="zero-line" />
    <polyline points="${points}" class="gain-line" />${dots}${labels}</svg>`;
}

function renderSimulation() {
  const inputs = readSimulationInputs();
  const result = calculateSimulation(inputs);
  const horizon = result.years.at(-1);
  const breakEven = result.years.find((row) => row.netGain >= 0);
  const profitable = horizon.netGain >= 0;
  $('#simulation-results').hidden = false;
  $('#sim-verdict').classList.toggle('profitable', profitable);
  $('#sim-verdict').classList.toggle('unprofitable', !profitable);
  $('#sim-verdict-label').textContent = profitable ? 'Rentable à l’horizon simulé' : 'Non rentable à l’horizon simulé';
  $('#sim-verdict-value').textContent = `${horizon.netGain >= 0 ? '+' : ''}${euro.format(horizon.netGain)}`;
  $('#sim-verdict-detail').textContent = `Après ${inputs.holdingYears} ans, en tenant compte des cash-flows, du crédit restant et des frais de vente estimés.`;

  const roi = result.initialCash ? horizon.netGain / result.initialCash * 100 : null;
  const firstYear = result.years[0];
  const monthlyCashFlow = firstYear.cashFlow / 12;
  const metrics = [
    ['Coût total du projet', euro.format(result.projectCost)],
    ['Crédit estimé', `${euro.format(result.loanAmount)} · ${euro.format(result.monthlyPayment)}/mois`],
    ['Rendement brut', `${result.grossYield.toFixed(2)} %`],
    ['Rendement net avant financement', `${result.netYield.toFixed(2)} %`],
    ['Cash-flow mensuel (année 1)', `${monthlyCashFlow >= 0 ? '+' : ''}${euro.format(monthlyCashFlow)}`],
    ['Rentabilité cumulée', roi == null ? 'Apport nul : ratio non calculable' : `${roi >= 0 ? '+' : ''}${roi.toFixed(1)} %`],
    ['Seuil de rentabilité', breakEven ? `${breakEven.year} an${breakEven.year > 1 ? 's' : ''}` : `Non atteint en ${inputs.holdingYears} ans`],
    ['Capital restant dû à la sortie', euro.format(horizon.loanBalance)],
  ];
  $('#sim-key-metrics').innerHTML = metrics.map(([label, value]) => `
    <div class="sim-metric"><span>${label}</span><strong>${value}</strong></div>`).join('');

  renderCashFlowChart(result.years);
  renderGainChart(result);
  $('#sim-year-table').innerHTML = `<table><thead><tr>
    <th>Année</th><th>Loyers encaissés</th><th>Charges</th><th>Impôts</th><th>Crédit + assurance</th>
    <th>Cash-flow annuel</th><th>Valeur estimée</th><th>Capital restant dû</th><th>Gain net si revente</th>
  </tr></thead><tbody>${result.years.map((row) => `<tr>
    <td>${row.year}</td><td>${euro.format(row.rentCollected)}</td><td>${euro.format(row.operatingCosts)}</td>
    <td>${euro.format(row.tax)}</td><td>${euro.format(row.debtService)}</td>
    <td class="${row.cashFlow < 0 ? 'negative-text' : 'positive-text'}">${euro.format(row.cashFlow)}</td>
    <td>${euro.format(row.estimatedValue)}</td><td>${euro.format(row.loanBalance)}</td>
    <td class="${row.netGain < 0 ? 'negative-text' : 'positive-text'}">${euro.format(row.netGain)}</td>
  </tr>`).join('')}</tbody></table>`;
}

async function loadSavedSimulations() {
  savedSimulations = await api('/simulations');
  $('#saved-simulations').innerHTML = '<option value="">Nouveau scénario</option>' + savedSimulations
    .map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('');
  const exists = savedSimulations.some((item) => item.id === currentSimulationId);
  if (!exists) currentSimulationId = '';
  $('#saved-simulations').value = currentSimulationId;
  $('#simulation-delete').hidden = !currentSimulationId;
}

async function enterSimulation() {
  renderSimulation();
  try {
    await loadSavedSimulations();
  } catch (err) {
    $('#simulation-msg').textContent = err.message;
    $('#simulation-msg').classList.add('error');
  }
}

$('#simulation-form').addEventListener('submit', (e) => {
  e.preventDefault();
  renderSimulation();
  $('#simulation-msg').textContent = '';
  $('#simulation-msg').classList.remove('error');
  $('#simulation-results').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

$('#saved-simulations').addEventListener('change', () => {
  currentSimulationId = $('#saved-simulations').value;
  const simulation = savedSimulations.find((item) => item.id === currentSimulationId);
  if (simulation) {
    $('#sim-name').value = simulation.name;
    writeSimulationInputs(simulation.inputs);
    $('#simulation-delete').hidden = false;
    renderSimulation();
    $('#simulation-results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    $('#simulation-delete').hidden = true;
  }
});

$('#simulation-save').addEventListener('click', async () => {
  if (!$('#sim-name').reportValidity() || !$('#simulation-form').reportValidity()) return;
  renderSimulation();
  const payload = { name: $('#sim-name').value.trim(), inputs: readSimulationInputs() };
  $('#simulation-save').disabled = true;
  try {
    const saved = await api(currentSimulationId ? `/simulations/${encodeURIComponent(currentSimulationId)}` : '/simulations', {
      method: currentSimulationId ? 'PUT' : 'POST', body: payload,
    });
    currentSimulationId = saved.id;
    await loadSavedSimulations();
    $('#simulation-msg').textContent = 'Scénario enregistré.';
    $('#simulation-msg').classList.remove('error');
  } catch (err) {
    $('#simulation-msg').textContent = err.message;
    $('#simulation-msg').classList.add('error');
  } finally {
    $('#simulation-save').disabled = false;
  }
});

$('#simulation-new').addEventListener('click', () => {
  currentSimulationId = '';
  $('#saved-simulations').value = '';
  $('#simulation-delete').hidden = true;
  $('#simulation-form').reset();
  $('#simulation-msg').textContent = '';
  $('#simulation-msg').classList.remove('error');
  renderSimulation();
});

$('#simulation-delete').addEventListener('click', async () => {
  if (!currentSimulationId || !confirm('Supprimer ce scénario enregistré ?')) return;
  try {
    await api(`/simulations/${encodeURIComponent(currentSimulationId)}`, { method: 'DELETE' });
    currentSimulationId = '';
    $('#simulation-form').reset();
    await loadSavedSimulations();
    renderSimulation();
    $('#simulation-msg').textContent = 'Scénario supprimé.';
    $('#simulation-msg').classList.remove('error');
  } catch (err) {
    $('#simulation-msg').textContent = err.message;
    $('#simulation-msg').classList.add('error');
  }
});

$('.bottom-nav').addEventListener('click', (e) => {
  const button = e.target.closest('[data-view]');
  if (button) showView(button.dataset.view);
});
$('#home-button').addEventListener('click', () => showView('home'));
$$('[data-module]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.module)));
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
  state.assets = [];
  state.properties = [];
  state.activePropertyId = '';
  state.propertyTransactions = [];
  $('.bottom-nav').hidden = true;
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-auth'));
}

function onLoggedIn(user) {
  state.profile = user.profile;
  $('#account-email').textContent = user.email;
  $('.bottom-nav').hidden = false;
  showView('home');
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

$('#product-search').addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = $('#search-submit');
  const results = $('#search-results');
  const params = new URLSearchParams({ name: $('#search-name').value.trim(), brand: $('#search-brand').value.trim() });
  button.disabled = true;
  $('#search-msg').textContent = 'Recherche en cours…';
  $('#search-msg').classList.remove('error');
  results.innerHTML = '';
  try {
    const data = await api(`/product-search?${params}`);
    $('#search-msg').textContent = data.results.length
      ? `${data.results.length} résultat${data.results.length > 1 ? 's' : ''} affiché${data.results.length > 1 ? 's' : ''}`
      : 'Aucun produit trouvé. Essayez un autre nom ou une autre marque.';
    results.innerHTML = data.results.map((product) => `
      <button class="search-result" type="button" data-product-code="${esc(product.code)}" ${product.code ? '' : 'disabled'}>
        <span><strong>${esc(product.name)}</strong><small>${esc(product.brand || 'Marque non renseignée')}</small></span>
        <span class="result-code">${product.code ? esc(product.code) : 'Sans code-barres'}</span>
      </button>`).join('');
  } catch (err) {
    $('#search-msg').textContent = err.message;
    $('#search-msg').classList.add('error');
  } finally {
    button.disabled = false;
  }
});

$('#search-results').addEventListener('click', (e) => {
  const result = e.target.closest('[data-product-code]');
  if (result?.dataset.productCode) lookup(result.dataset.productCode);
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
  showView('nutriscan');
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
