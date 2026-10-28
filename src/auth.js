import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { ObjectId } from 'mongodb';
import { users } from './db.js';

const COOKIE = 'ns_token';
const SESSION_DAYS = 30;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Hash factice pour garder un temps de réponse constant quand l'email n'existe pas
const DUMMY_HASH = bcrypt.hashSync('dummy-password', 12);

function setSession(res, userId) {
  const token = jwt.sign({ sub: userId.toString() }, process.env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: `${SESSION_DAYS}d`,
  });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: SESSION_DAYS * 24 * 3600 * 1000,
  });
}

export function requireAuth(req, res, next) {
  try {
    const { sub } = jwt.verify(req.cookies?.[COOKIE] ?? '', process.env.JWT_SECRET, { algorithms: ['HS256'] });
    req.userId = new ObjectId(sub);
    next();
  } catch {
    res.status(401).json({ error: 'Non authentifié' });
  }
}

function readCredentials(body) {
  const { email, password } = body ?? {};
  if (typeof email !== 'string' || email.length > 254 || !EMAIL_RE.test(email.trim())) {
    return { error: 'Email invalide' };
  }
  // bcrypt ignore tout ce qui dépasse 72 octets
  if (typeof password !== 'string' || password.length < 8 || Buffer.byteLength(password) > 72) {
    return { error: 'Le mot de passe doit contenir entre 8 et 72 caractères' };
  }
  return { email: email.trim().toLowerCase(), password };
}

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });

export const authRouter = Router();

authRouter.post('/register', authLimiter, async (req, res) => {
  if (process.env.ALLOW_REGISTRATION === 'false') {
    return res.status(403).json({ error: 'Les inscriptions sont fermées' });
  }
  const creds = readCredentials(req.body);
  if (creds.error) return res.status(400).json({ error: creds.error });

  const passwordHash = await bcrypt.hash(creds.password, 12);
  try {
    const { insertedId } = await users().insertOne({
      email: creds.email,
      passwordHash,
      profile: null,
      createdAt: new Date(),
    });
    setSession(res, insertedId);
    res.status(201).json({ email: creds.email, profile: null });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Cet email est déjà utilisé' });
    throw err;
  }
});

authRouter.post('/login', authLimiter, async (req, res) => {
  const creds = readCredentials(req.body);
  if (creds.error) return res.status(401).json({ error: 'Identifiants invalides' });

  const user = await users().findOne({ email: creds.email });
  const valid = await bcrypt.compare(creds.password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !valid) return res.status(401).json({ error: 'Identifiants invalides' });

  setSession(res, user._id);
  res.json({ email: user.email, profile: user.profile });
});

authRouter.post('/logout', (req, res) => {
  res.clearCookie(COOKIE, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict' });
  res.status(204).end();
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const user = await users().findOne({ _id: req.userId }, { projection: { email: 1, profile: 1 } });
  if (!user) return res.status(401).json({ error: 'Non authentifié' });
  res.json({ email: user.email, profile: user.profile });
});
