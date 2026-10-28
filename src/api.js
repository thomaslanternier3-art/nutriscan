import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { ObjectId } from 'mongodb';
import { requireAuth } from './auth.js';
import { users, entries, weights } from './db.js';

const MEALS = ['breakfast', 'lunch', 'snack', 'dinner'];
const ACTIVITY = [1.2, 1.375, 1.55, 1.725, 1.9];
const DEFICITS = [250, 500, 750];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isDate = (v) => typeof v === 'string' && DATE_RE.test(v) && !isNaN(Date.parse(v));
const isNum = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

const badRequest = (res, error) => res.status(400).json({ error });

function toEntryDto({ _id, userId, ...rest }) {
  return { id: _id.toString(), ...rest };
}

export const apiRouter = Router();

apiRouter.get('/health', (req, res) => res.json({ ok: true }));

apiRouter.use(requireAuth);

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
