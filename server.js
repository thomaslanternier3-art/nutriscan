import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectDb } from './src/db.js';
import { authRouter } from './src/auth.js';
import { apiRouter } from './src/api.js';

const { MONGODB_URI, MONGODB_DB = 'nutriscan', JWT_SECRET, PORT = 3000 } = process.env;
if (!MONGODB_URI) throw new Error('Variable MONGODB_URI manquante');
if (!JWT_SECRET || JWT_SECRET.length < 32) throw new Error('Variable JWT_SECRET manquante ou trop courte (32 caractères min.)');

const isProd = process.env.NODE_ENV === 'production';
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

const app = express();
// Derrière le proxy de Render : nécessaire pour l'IP réelle (rate limit) et les cookies secure
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      'img-src': ["'self'", 'data:', 'blob:', 'https://images.openfoodfacts.org'],
      'connect-src': ["'self'"],
      'upgrade-insecure-requests': isProd ? [] : null,
    },
  },
  strictTransportSecurity: isProd,
}));
app.use(express.json({ limit: '20kb' }));
app.use(cookieParser());

app.use('/api/auth', authRouter);
app.use('/api', apiRouter);
app.use('/api', (req, res) => res.status(404).json({ error: 'Route introuvable' }));
app.use(express.static(publicDir));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.expose ? err.message : 'Erreur serveur' });
});

await connectDb(MONGODB_URI, MONGODB_DB);
app.listen(PORT, () => console.log(`NutriScan démarré sur http://localhost:${PORT}`));
