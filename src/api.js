import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { ObjectId } from 'mongodb';
import { requireAuth } from './auth.js';
import { users, entries, weights, assets, simulations } from './db.js';

const MEALS = ['breakfast', 'lunch', 'snack', 'dinner'];
const ACTIVITY = [1.2, 1.375, 1.55, 1.725, 1.9];
const DEFICITS = [250, 500, 750];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ASSET_CATEGORIES = new Set(['real_estate', 'stocks', 'bank', 'crypto', 'vehicles', 'valuables', 'other']);
const SIMULATION_LIMITS = {
  purchasePrice: [1, 100_000_000], notaryRate: [0, 20], agencyRate: [0, 20], works: [0, 100_000_000],
  furnishing: [0, 10_000_000], acquisitionOther: [0, 10_000_000], rentMonthly: [0, 1_000_000],
  otherIncomeMonthly: [0, 1_000_000], vacancyRate: [0, 100], rentGrowthRate: [-20, 30],
  propertyTaxAnnual: [0, 10_000_000], condoAnnual: [0, 10_000_000], insuranceAnnual: [0, 1_000_000],
  maintenanceAnnual: [0, 10_000_000], managementRate: [0, 30], otherExpensesAnnual: [0, 10_000_000],
  expenseGrowthRate: [-10, 30], downPayment: [0, 100_000_000], interestRate: [0, 30],
  loanTermYears: [1, 30], loanInsuranceRate: [0, 5], holdingYears: [1, 30],
  propertyGrowthRate: [-20, 30], saleFeeRate: [0, 20], incomeTaxRate: [0, 60], socialRate: [0, 30],
};

const isDate = (v) => typeof v === 'string' && DATE_RE.test(v) && !isNaN(Date.parse(v));
const isNum = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

const badRequest = (res, error) => res.status(400).json({ error });

function toEntryDto({ _id, userId, ...rest }) {
  return { id: _id.toString(), ...rest };
}

function toAssetDto({ _id, userId, ...rest }) {
  return { id: _id.toString(), ...rest };
}

function parseAsset(body) {
  const name = text(body?.name, 100);
  const category = body?.category;
  const value = body?.value;
  if (!name) return { error: 'Le nom de l’actif est requis' };
  if (!ASSET_CATEGORIES.has(category)) return { error: 'Catégorie invalide' };
  if (!isNum(value, 0, 1_000_000_000_000)) return { error: 'La valeur doit être comprise entre 0 et 1 000 000 000 000 €' };
  return { asset: { name, category, value, notes: text(body?.notes, 500) } };
}

function parseSimulation(body) {
  const name = text(body?.name, 80);
  if (!name) return { error: 'Le nom du scénario est requis' };
  if (!body.inputs || typeof body.inputs !== 'object' || Array.isArray(body.inputs)) {
    return { error: 'Hypothèses de simulation invalides' };
  }
  const inputs = {};
  for (const [key, [min, max]] of Object.entries(SIMULATION_LIMITS)) {
    if (!isNum(body.inputs[key], min, max)) return { error: `Valeur invalide pour ${key}` };
    inputs[key] = body.inputs[key];
  }
  if (!Number.isInteger(inputs.loanTermYears) || !Number.isInteger(inputs.holdingYears)) {
    return { error: 'Les durées du crédit et de détention doivent être des années entières' };
  }
  if (!['real', 'micro', 'none'].includes(body.inputs.taxRegime)) return { error: 'Régime fiscal invalide' };
  inputs.taxRegime = body.inputs.taxRegime;
  return { simulation: { name, inputs } };
}

export const apiRouter = Router();

apiRouter.get('/health', (req, res) => res.json({ ok: true }));

apiRouter.use(requireAuth);

/* ---------- Simulations immobilières ---------- */

function toSimulationDto({ _id, userId, ...rest }) {
  return { id: _id.toString(), ...rest };
}

apiRouter.get('/simulations', async (req, res) => {
  const list = await simulations().find({ userId: req.userId }).sort({ updatedAt: -1 }).limit(100).toArray();
  res.json(list.map(toSimulationDto));
});

apiRouter.post('/simulations', async (req, res) => {
  const parsed = parseSimulation(req.body);
  if (parsed.error) return badRequest(res, parsed.error);
  const simulation = { ...parsed.simulation, userId: req.userId, createdAt: new Date(), updatedAt: new Date() };
  const { insertedId } = await simulations().insertOne(simulation);
  res.status(201).json(toSimulationDto({ _id: insertedId, ...simulation }));
});

apiRouter.put('/simulations/:id', async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return badRequest(res, 'Identifiant invalide');
  const parsed = parseSimulation(req.body);
  if (parsed.error) return badRequest(res, parsed.error);
  const result = await simulations().updateOne(
    { _id: new ObjectId(req.params.id), userId: req.userId },
    { $set: { ...parsed.simulation, updatedAt: new Date() } },
  );
  if (!result.matchedCount) return res.status(404).json({ error: 'Scénario introuvable' });
  res.json({ id: req.params.id, ...parsed.simulation });
});

apiRouter.delete('/simulations/:id', async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return badRequest(res, 'Identifiant invalide');
  const { deletedCount } = await simulations().deleteOne({ _id: new ObjectId(req.params.id), userId: req.userId });
  if (!deletedCount) return res.status(404).json({ error: 'Scénario introuvable' });
  res.status(204).end();
});

/* ---------- Module Patrimoine ---------- */

apiRouter.get('/assets', async (req, res) => {
  const list = await assets()
    .find({ userId: req.userId })
    .sort({ category: 1, name: 1 })
    .limit(1000)
    .toArray();
  res.json(list.map(toAssetDto));
});

apiRouter.post('/assets', async (req, res) => {
  const parsed = parseAsset(req.body);
  if (parsed.error) return badRequest(res, parsed.error);
  const asset = { ...parsed.asset, userId: req.userId, createdAt: new Date(), updatedAt: new Date() };
  const { insertedId } = await assets().insertOne(asset);
  res.status(201).json(toAssetDto({ _id: insertedId, ...asset }));
});

apiRouter.put('/assets/:id', async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return badRequest(res, 'Identifiant invalide');
  const parsed = parseAsset(req.body);
  if (parsed.error) return badRequest(res, parsed.error);
  const result = await assets().updateOne(
    { _id: new ObjectId(req.params.id), userId: req.userId },
    { $set: { ...parsed.asset, updatedAt: new Date() } },
  );
  if (!result.matchedCount) return res.status(404).json({ error: 'Actif introuvable' });
  res.json({ id: req.params.id, ...parsed.asset });
});

apiRouter.delete('/assets/:id', async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return badRequest(res, 'Identifiant invalide');
  const { deletedCount } = await assets().deleteOne({ _id: new ObjectId(req.params.id), userId: req.userId });
  if (!deletedCount) return res.status(404).json({ error: 'Actif introuvable' });
  res.status(204).end();
});

/* ---------- Profil & poids ---------- */

apiRouter.put('/profile', async (req, res) => {
  const { sex, age, height, weight, activity, deficit, date } = req.body ?? {};
  if (!['male', 'female'].includes(sex)) return badRequest(res, 'Sexe invalide');
  if (!isNum(age, 15, 100)) return badRequest(res, 'Âge invalide (15-100)');
  if (!isNum(height, 100, 250)) return badRequest(res, 'Taille invalide (100-250 cm)');
  if (!isNum(weight, 30, 300)) return badRequest(res, 'Poids invalide (30-300 kg)');
  if (!ACTIVITY.includes(activity)) return badRequest(res, "Niveau d'activité invalide");
  if (!DEFICITS.includes(deficit)) return badRequest(res, 'Rythme de régime invalide');
  if (!isDate(date)) return badRequest(res, 'Date invalide');

  const profile = { sex, age, height, weight, activity, deficit };
  await users().updateOne({ _id: req.userId }, { $set: { profile } });
  // Une pesée par jour : la dernière saisie remplace celle du jour
  await weights().updateOne({ userId: req.userId, date }, { $set: { weight } }, { upsert: true });
  res.json(profile);
});

apiRouter.get('/weights', async (req, res) => {
  const list = await weights()
    .find({ userId: req.userId }, { projection: { _id: 0, date: 1, weight: 1 } })
    .sort({ date: -1 })
    .limit(30)
    .toArray();
  res.json(list);
});

/* ---------- Journal alimentaire ---------- */

apiRouter.get('/entries', async (req, res) => {
  const { from, to } = req.query;
  if (!isDate(from) || !isDate(to)) return badRequest(res, 'Paramètres from/to invalides');
  const list = await entries()
    .find({ userId: req.userId, date: { $gte: from, $lte: to } })
    .sort({ createdAt: 1 })
    .toArray();
  res.json(list.map(toEntryDto));
});

apiRouter.post('/entries', async (req, res) => {
  const b = req.body ?? {};
  const name = text(b.name, 120);
  const code = text(b.code, 14);
  if (!isDate(b.date)) return badRequest(res, 'Date invalide');
  if (!MEALS.includes(b.meal)) return badRequest(res, 'Repas invalide');
  if (!name) return badRequest(res, 'Nom requis');
  if (code && !/^\d+$/.test(code)) return badRequest(res, 'Code-barres invalide');
  if (!isNum(b.quantity, 0.1, 5000)) return badRequest(res, 'Quantité invalide');
  if (!isNum(b.kcal100, 0, 900)) return badRequest(res, 'Calories invalides');
  for (const k of ['p100', 'c100', 'f100']) {
    if (!isNum(b[k], 0, 100)) return badRequest(res, 'Macronutriments invalides (0-100 g)');
  }

  const entry = {
    userId: req.userId,
    date: b.date,
    meal: b.meal,
    code,
    name,
    brand: text(b.brand, 120),
    quantity: b.quantity,
    kcal100: b.kcal100,
    p100: b.p100,
    c100: b.c100,
    f100: b.f100,
    createdAt: new Date(),
  };
  const { insertedId } = await entries().insertOne(entry);
  res.status(201).json(toEntryDto({ _id: insertedId, ...entry }));
});

apiRouter.delete('/entries/:id', async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return badRequest(res, 'Identifiant invalide');
  const { deletedCount } = await entries().deleteOne({ _id: new ObjectId(req.params.id), userId: req.userId });
  if (!deletedCount) return res.status(404).json({ error: 'Entrée introuvable' });
  res.status(204).end();
});

/* ---------- Proxy Open Food Facts (API v3.6) ---------- */

// Limite OFF : 15 lectures produit / minute
const productLimiter = rateLimit({ windowMs: 60 * 1000, limit: 15, standardHeaders: 'draft-7', legacyHeaders: false });
const productSearchLimiter = rateLimit({ windowMs: 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false });
const luceneSpecial = new Set(['+', '-', '&', '=', '|', '>', '<', '!', '(', ')', '{', '}', '[', ']', '^', '"', '~', '*', '?', ':', '\\', '/']);

function escapeSearchText(value) {
  return [...value].map((char) => luceneSpecial.has(char) ? `\\${char}` : char).join('');
}

apiRouter.get('/product-search', productSearchLimiter, async (req, res) => {
  const name = typeof req.query.name === 'string' ? req.query.name.trim().slice(0, 80) : '';
  const brand = typeof req.query.brand === 'string' ? req.query.brand.trim().slice(0, 80) : '';
  if (name.length < 2 && brand.length < 2) return badRequest(res, 'Saisissez au moins 2 caractères de nom ou de marque');

  const query = [
    name ? escapeSearchText(name) : '',
    brand ? `brands:"${escapeSearchText(brand)}"` : '',
  ].filter(Boolean).join(' ');
  const params = new URLSearchParams({ q: query, langs: 'fr,en', page_size: '12', fields: 'code,product_name,brands' });

  try {
    const searchRes = await fetch(`https://search.openfoodfacts.org/search?${params}`, {
      headers: { 'User-Agent': `NutriScan/1.0 (${process.env.OFF_CONTACT_EMAIL || 'contact@example.com'})` },
      signal: AbortSignal.timeout(8000),
    });
    if (!searchRes.ok) return res.status(502).json({ error: 'La recherche Open Food Facts a échoué' });
    const data = await searchRes.json();
    const results = (Array.isArray(data.hits) ? data.hits : []).map((hit) => ({
      code: typeof hit.code === 'string' ? hit.code : '',
      name: typeof hit.product_name === 'string' ? hit.product_name : 'Produit sans nom',
      brand: Array.isArray(hit.brands) ? hit.brands.filter((v) => typeof v === 'string').join(', ') : '',
    }));
    res.json({ results, count: Number(data.count) || results.length });
  } catch {
    res.status(502).json({ error: 'Open Food Facts est injoignable' });
  }
});

function nutrientValue(nutrients, key) {
  const n = nutrients[key];
  if (n?.value == null) return null;
  return n.unit === 'mg' ? n.value / 1000 : Number(n.value);
}

apiRouter.get('/products/:code', productLimiter, async (req, res) => {
  const { code } = req.params;
  if (!/^\d{6,14}$/.test(code)) return badRequest(res, 'Code-barres invalide');

  const fields = 'product_name,product_name_fr,brands,nutrition,image_front_small_url,serving_quantity';
  let data;
  try {
    const offRes = await fetch(`https://world.openfoodfacts.org/api/v3.6/product/${code}.json?fields=${fields}`, {
      headers: { 'User-Agent': `NutriScan/1.0 (${process.env.OFF_CONTACT_EMAIL || 'contact@example.com'})` },
      signal: AbortSignal.timeout(8000),
    });
    data = await offRes.json();
  } catch {
    return res.status(502).json({ error: 'Open Food Facts est injoignable' });
  }

  // v3 renvoie status "failure" (HTTP 404) si le produit n'existe pas
  if (!data?.product || data.status === 'failure') return res.json({ found: false });

  const p = data.product;
  const n = p.nutrition?.aggregated_set?.nutrients || {};
  const kj = nutrientValue(n, 'energy');
  res.json({
    found: true,
    product: {
      name: p.product_name_fr || p.product_name || 'Produit sans nom',
      brand: (p.brands || '').split(',')[0].trim(),
      image: typeof p.image_front_small_url === 'string' ? p.image_front_small_url : null,
      kcal100: nutrientValue(n, 'energy-kcal') ?? (kj != null ? kj / 4.184 : null),
      p100: nutrientValue(n, 'proteins'),
      c100: nutrientValue(n, 'carbohydrates'),
      f100: nutrientValue(n, 'fat'),
      quantity: Number(p.serving_quantity) || 100,
    },
  });
});
