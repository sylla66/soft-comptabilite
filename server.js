'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('./db');
const auth = require('./auth');

const PORT = Number(process.env.PORT) || 3000;
const PRODUCTION = process.env.NODE_ENV === 'production';
const HOST = process.env.HOST || (PRODUCTION ? '0.0.0.0' : '127.0.0.1');
const PUBLIC = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

if (PRODUCTION) {
  auth.EN_TETES_SECURITE['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
}

function envoyerJson(res, code, data, entetes = {}) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    ...auth.EN_TETES_SECURITE,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...entetes,
  });
  res.end(body);
}

const envoyerErreur = (res, code, message, entetes) =>
  envoyerJson(res, code, { erreur: message }, entetes);

async function lireCorps(req) {
  return new Promise((resolve, reject) => {
    const morceaux = [];
    let taille = 0;
    let tropGros = false;
    req.on('data', (c) => {
      if (tropGros) return;
      taille += c.length;
      if (taille > 100_000) {
        tropGros = true;
        morceaux.length = 0;
        return;
      }
      morceaux.push(c);
    });
    req.on('end', () => {
      if (tropGros) {
        const e = new Error('Requête trop volumineuse (maximum 100 Ko).');
        e.statut = 413;
        return reject(e);
      }
      const brut = Buffer.concat(morceaux).toString('utf8');
      if (!brut.trim()) return resolve({});
      try {
        resolve(JSON.parse(brut));
      } catch {
        const e = new Error('JSON invalide.');
        e.statut = 400;
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function filtres(url) {
  const q = url.searchParams;
  return {
    debut: q.get('debut') || undefined,
    fin: q.get('fin') || undefined,
    categorie_id: q.get('categorie_id') || undefined,
    type: q.get('type') || undefined,
    texte: q.get('texte') || undefined,
    ordre: q.get('ordre') || undefined,
  };
}

function servirStatique(res, cheminRelatif) {
  const rel = cheminRelatif === '/' ? 'index.html' : cheminRelatif.replace(/^\/+/, '');
  const cible = path.resolve(PUBLIC, rel);
  if (cible !== PUBLIC && !cible.startsWith(PUBLIC + path.sep)) {
    return envoyerErreur(res, 403, 'Accès refusé.');
  }
  fs.stat(cible, (err, st) => {
    if (err || !st.isFile()) {
      return fs.readFile(path.join(PUBLIC, 'index.html'), (e2, data) => {
        if (e2) return envoyerErreur(res, 404, 'Introuvable.');
        res.writeHead(404, { ...auth.EN_TETES_SECURITE, 'Content-Type': MIME['.html'] });
        res.end(data);
      });
    }
    res.writeHead(200, {
      ...auth.EN_TETES_SECURITE,
      'Content-Type': MIME[path.extname(cible).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    if (res.req.method === 'HEAD') return res.end();
    fs.createReadStream(cible).pipe(res);
  });
}

/* ------------------------------------------------------------------ */
/* Premier demarrage : creation du compte administrateur               */
/* ------------------------------------------------------------------ */

async function verifierPremierLancement() {
  if (db.compterUtilisateurs() > 0) return;

  const mdp = process.env.ADMIN_PASSWORD;
  if (mdp) {
    if (String(mdp).length < 8) {
      console.error('\n  ADMIN_PASSWORD doit contenir au moins 8 caracteres.');
      process.exit(1);
    }
    await db.creerUtilisateur({ nom: process.env.ADMIN_USER || 'admin', mot_de_passe: mdp, role: 'admin' });
    console.log(`\n  Compte administrateur cree : ${process.env.ADMIN_USER || 'admin'}`);
  } else {
    const genere = crypto.randomBytes(9).toString('base64url');
    await db.creerUtilisateur({ nom: 'admin', mot_de_passe: genere, role: 'admin' });
    console.log('\n  ============================================================');
    console.log('   PREMIER LANCEMENT - notez ces identifiants :');
    console.log(`      Identifiant : admin`);
    console.log(`      Mot de passe : ${genere}`);
    console.log('   Changez-le des que vous etes connecte.');
    console.log('  ============================================================\n');
  }
}

/* ------------------------------------------------------------------ */
/* Routage                                                             */
/* ------------------------------------------------------------------ */

const ROUTES_API = [
  /^\/api\/session$/, /^\/api\/connexion$/, /^\/api\/deconnexion$/,
  /^\/api\/utilisateurs$/, /^\/api\/utilisateurs\/[^/]+$/,
  /^\/api\/categories$/, /^\/api\/categories\/[^/]+$/,
  /^\/api\/operations$/, /^\/api\/operations\/[^/]+$/,
  /^\/api\/stats$/, /^\/api\/export\.csv$/, /^\/api\/sauvegarde$/,
  /^\/api\/sante$/,
];

async function router(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const chemin = url.pathname;
  const methode = req.method;

  /* ---- Sonde de sante (sans authentification) ---- */
  if (methode === 'GET' && chemin === '/api/sante') {
    return envoyerJson(res, 200, { ok: true, utilisateurs: db.compterUtilisateurs() });
  }

  /* ---- Connexion ---- */
  if (methode === 'POST' && chemin === '/api/connexion') {
    const cle = auth.ip(req);
    const limite = auth.tentativeAutorisee(cle);
    if (!limite.autorise) {
      return envoyerErreur(res, 429,
        `Trop de tentatives. Réessayez dans ${limite.reste} secondes.`);
    }
    const { nom, mot_de_passe } = await lireCorps(req);
    const utilisateur = await db.connecter(nom, mot_de_passe);
    if (!utilisateur) {
      auth.enregistrerEchec(cle);
      return envoyerErreur(res, 401, 'Identifiant ou mot de passe incorrect.');
    }
    auth.reinitialiserTentatives(cle);
    const { jeton, csrf } = db.creerSession(utilisateur.id);
    return envoyerJson(res, 200,
      { utilisateur, csrf },
      { 'Set-Cookie': auth.cookieSession(jeton) });
  }

  /* ---- Deconnexion ---- */
  if (methode === 'POST' && chemin === '/api/deconnexion') {
    db.supprimerSession(auth.parserCookies(req)[auth.COOKIE]);
    return envoyerJson(res, 200, { deconnecte: true },
      { 'Set-Cookie': auth.cookieVide() });
  }

  /* ---- Session courante ---- */
  if (methode === 'GET' && chemin === '/api/session') {
    const s = auth.session(req);
    if (!s) return envoyerJson(res, 200, { connecte: false });
    return envoyerJson(res, 200, {
      connecte: true,
      utilisateur: { id: s.id, nom: s.nom, role: s.role },
      csrf: s.csrf,
    });
  }

  /* ---- Utilisateurs (admin) ---- */
  if (methode === 'GET' && chemin === '/api/utilisateurs') {
    const refus = auth.verifierAcces(req, 'utilisateurs:ecrire');
    if (refus) return envoyerErreur(res, refus.code, refus.erreur);
    return envoyerJson(res, 200, db.listerUtilisateurs());
  }

  if (methode === 'POST' && chemin === '/api/utilisateurs') {
    const refus = auth.verifierAcces(req, 'utilisateurs:ecrire');
    if (refus) return envoyerErreur(res, refus.code, refus.erreur);
    return envoyerJson(res, 201, await db.creerUtilisateur(await lireCorps(req)));
  }

  if (methode === 'PUT' && chemin.startsWith('/api/utilisateurs/')) {
    const refus = auth.verifierAcces(req, 'utilisateurs:ecrire');
    if (refus) return envoyerErreur(res, refus.code, refus.erreur);
    const id = Number(chemin.split('/').pop());
    return envoyerJson(res, 200, await db.modifierUtilisateur(id, await lireCorps(req)));
  }

  if (methode === 'DELETE' && chemin.startsWith('/api/utilisateurs/')) {
    const refus = auth.verifierAcces(req, 'utilisateurs:ecrire');
    if (refus) return envoyerErreur(res, refus.code, refus.erreur);
    const id = Number(chemin.split('/').pop());
    if (id === auth.session(req).id) return envoyerErreur(res, 400, 'Vous ne pouvez pas supprimer votre propre compte.');
    return envoyerJson(res, 200, await db.supprimerUtilisateur(id));
  }

  /* ---- Categories ---- */
  if (methode === 'GET' && chemin === '/api/categories') {
    const refus = auth.verifierAcces(req, 'categories:lire');
    if (refus) return envoyerErreur(res, refus.code, refus.erreur);
    return envoyerJson(res, 200, db.listCategories());
  }

  if (methode === 'POST' && chemin === '/api/categories') {
    const refus = auth.verifierAcces(req, 'categories:ecrire');
    if (refus) return envoyerErreur(res, refus.code, refus.erreur);
    return envoyerJson(res, 201, db.createCategorie(await lireCorps(req)));
  }

  if (methode === 'PUT' && chemin.startsWith('/api/categories/')) {
    const refus = auth.verifierAcces(req, 'categories:ecrire');
    if (refus) return envoyerErreur(res, refus.code, refus.erreur);
    return envoyerJson(res, 200, db.updateCategorie(Number(chemin.split('/').pop()), await lireCorps(req)));
  }

  if (methode === 'DELETE' && chemin.startsWith('/api/categories/')) {
    const refus = auth.verifierAcces(req, 'categories:ecrire');
    if (refus) return envoyerErreur(res, refus.code, refus.erreur);
    return envoyerJson(res, 200, db.deleteCategorie(Number(chemin.split('/').pop())));
  }

  /* ---- Operations ---- */
  if (methode === 'GET' && chemin === '/api/operations') {
    const refus = auth.verifierAcces(req, 'operations:lire');
    if (refus) return envoyerErreur(res, refus.code, refus.erreur);
    return envoyerJson(res, 200, db.listOperations(filtres(url)));
  }

  if (methode === 'POST' && chemin === '/api/operations') {
    const refus = auth.verifierAcces(req, 'operations:ecrire');
    if (refus) return envoyerErreur(res, refus.code, refus.erreur);
    return envoyerJson(res, 201, db.createOperation(await lireCorps(req)));
  }

  if (methode === 'PUT' && chemin.startsWith('/api/operations/')) {
    const refus = auth.verifierAcces(req, 'operations:ecrire');
    if (refus) return envoyerErreur(res, refus.code, refus.erreur);
    return envoyerJson(res, 200, db.updateOperation(Number(chemin.split('/').pop()), await lireCorps(req)));
  }

  if (methode === 'DELETE' && chemin.startsWith('/api/operations/')) {
    const refus = auth.verifierAcces(req, 'operations:supprimer');
    if (refus) return envoyerErreur(res, refus.code, refus.erreur);
    return envoyerJson(res, 200, db.deleteOperation(Number(chemin.split('/').pop())));
  }

  /* ---- Statistiques, export, sauvegarde ---- */
  if (methode === 'GET' && chemin === '/api/stats') {
    const refus = auth.verifierAcces(req, 'stats:lire');
    if (refus) return envoyerErreur(res, refus.code, refus.erreur);
    return envoyerJson(res, 200, db.stats(filtres(url)));
  }

  if (methode === 'GET' && chemin === '/api/export.csv') {
    const refus = auth.verifierAcces(req, 'operations:lire');
    if (refus) return envoyerErreur(res, refus.code, refus.erreur);
    const csv = Buffer.from('﻿' + db.exportCsv(filtres(url)), 'utf8');
    res.writeHead(200, {
      ...auth.EN_TETES_SECURITE,
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="operations-${new Date().toISOString().slice(0, 10)}.csv"`,
      'Content-Length': csv.length,
      'Cache-Control': 'no-store',
    });
    return res.end(csv);
  }

  if (methode === 'GET' && chemin === '/api/sauvegarde') {
    const refus = auth.verifierAcces(req, 'utilisateurs:ecrire');
    if (refus) return envoyerErreur(res, refus.code, refus.erreur);
    return envoyerJson(res, 200, {
      genere_le: new Date().toISOString(),
      categories: db.listCategories(),
      operations: db.db.prepare('SELECT * FROM operations').all(),
    });
  }

  if (chemin.startsWith('/api/')) {
    if (ROUTES_API.some((r) => r.test(chemin))) {
      return envoyerErreur(res, 405, `Méthode ${methode} non autorisée pour ${chemin}.`);
    }
    return envoyerErreur(res, 404, 'Route inconnue.');
  }

  if (methode === 'GET' || methode === 'HEAD') return servirStatique(res, chemin);

  return envoyerErreur(res, 405, 'Méthode non autorisée.');
}

const serveur = http.createServer((req, res) => {
  Promise.resolve()
    .then(() => router(req, res))
    .catch((e) => {
      const msg = e && e.message ? e.message : 'Erreur interne du serveur.';
      const code = Number.isInteger(e && e.statut) ? e.statut : 500;
      if (code === 500) console.error('[erreur]', e);
      if (!res.headersSent) envoyerErreur(res, code, msg);
      else res.end();
    });
});

serveur.headersTimeout = 20000;
serveur.requestTimeout = 30000;

(async () => {
  await verifierPremierLancement();
  const nettoyes = db.nettoyerSessionsExpirees();
  if (nettoyes) console.log(`  ${nettoyes} session(s) expiree(s) supprimee(s).`);
  setInterval(() => db.nettoyerSessionsExpirees(), 3600_000).unref();

  serveur.listen(PORT, HOST, () => {
    console.log('');
    console.log('  Comptabilite - Vente de poisson');
    console.log('  ---------------------------------');
    console.log(`  Serveur : http://${HOST}:${PORT}`);
    console.log(`  Base    : ${db.DB_PATH}`);
    console.log(`  Mode    : ${PRODUCTION ? 'production' : 'developpement'}`);
    console.log('');
  });
})();

serveur.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  Le port ${PORT} est deja utilise.`);
    console.error(`  Changez de port :  set PORT=3001  puis  node server.js\n`);
    process.exit(1);
  }
  console.error(e);
  process.exit(1);
});

process.on('SIGINT', () => { console.log('\n  Arret du serveur.'); process.exit(0); });
process.on('SIGTERM', () => { process.exit(0); });
