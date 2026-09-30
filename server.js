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
  if (await db.compterUtilisateurs() > 0) return;

  const mdp = process.env.ADMIN_PASSWORD;
  if (mdp) {
    if (String(mdp).length < 8) {
      console.error('\n  ADMIN_PASSWORD doit contenir au moins 8 caracteres.');
      process.exit(1);
    }
    await db.creerUtilisateur({
      nom: process.env.ADMIN_USER || 'admin',
      mot_de_passe: mdp,
      role: 'admin',
      doit_changer_mdp: true,
    });
    console.log('\n  ============================================================');
    console.log('   PREMIER LANCEMENT - compte administrateur cree');
    console.log(`      Identifiant : ${process.env.ADMIN_USER || 'admin'}`);
    console.log('      Mot de passe : celui defini dans ADMIN_PASSWORD');
    console.log('');
    console.log('   Un changement de mot de passe vous sera demande a la');
    console.log('   premiere connexion. Faites-le immediatement.');
    console.log('   Ensuite, SUPPRIMEZ la variable afin qu\'elle ne soit plus');
    console.log('   exposee : Render > Environment > Remove ADMIN_PASSWORD');
    console.log('  ============================================================\n');
  } else {
    const genere = crypto.randomBytes(12).toString('base64url');
    await db.creerUtilisateur({ nom: 'admin', mot_de_passe: genere, role: 'admin', doit_changer_mdp: true });
    console.log('\n  ============================================================');
    console.log('   PREMIER LANCEMENT - notez ces identifiants :');
    console.log('      Identifiant : admin');
    console.log(`      Mot de passe : ${genere}`);
    console.log('');
    console.log('   Un changement de mot de passe vous sera demande a la');
    console.log('   premiere connexion.');
    console.log('  ============================================================\n');
  }
}

/**
 * Sur une base hebergee, l'equivalent d'un volume perdu est une base qui a ete
 * reinitialisee ou une chaine de connexion qui pointe ailleurs. Si des
 * operations existent mais plus aucun utilisateur, on le dit : creer un admin
 * dans ce cas vous feriez repartir d'une base vide sans vous en apercevoir.
 */
async function avertirSiBaseVide() {
  const [nbOps, nbUsers] = await Promise.all([db.compterOperations(), db.compterUtilisateurs()]);
  if (nbOps === 0 || nbUsers > 0) return;
  console.log('\n  ###########################################################');
  console.log('   ATTENTION : aucun utilisateur, mais ' + nbOps + ' operation(s)');
  console.log('   existent dans la base. DATABASE_URL pointe probablement');
  console.log('   vers une autre base que celle d\'avant (Neon : branche du');
  console.log('  plien differente, ou "Reset" dans le tableau de bord).');
  console.log('   NE CONNECTEZ PAS : vous creeriez un admin sur une base vide.');
  console.log('  ###########################################################\n');
}

/* ------------------------------------------------------------------ */
/* Routage                                                             */
/* ------------------------------------------------------------------ */

const ROUTES_API = [
  /^\/api\/session$/, /^\/api\/connexion$/, /^\/api\/deconnexion$/,
  /^\/api\/utilisateurs$/, /^\/api\/utilisateurs\/[^/]+\/mot-de-passe$/, /^\/api\/utilisateurs\/[^/]+$/,
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
    return envoyerJson(res, 200, { ok: true, utilisateurs: await db.compterUtilisateurs() });
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
    const { jeton, csrf } = await db.creerSession(utilisateur.id);
    return envoyerJson(res, 200,
      { utilisateur, csrf },
      { 'Set-Cookie': auth.cookieSession(jeton, auth.DUREE_COOKIE_S, req) });
  }

  /* ---- Deconnexion ---- */
  if (methode === 'POST' && chemin === '/api/deconnexion') {
    await db.supprimerSession(auth.parserCookies(req)[auth.COOKIE]);
    return envoyerJson(res, 200, { deconnecte: true },
      { 'Set-Cookie': auth.cookieVide(req) });
  }

  /* ---- Session courante ---- */
  if (methode === 'GET' && chemin === '/api/session') {
    const s = await auth.session(req);
    if (!s) return envoyerJson(res, 200, { connecte: false });
    const complet = await db.getUtilisateur(s.id);
    return envoyerJson(res, 200, {
      connecte: true,
      utilisateur: {
        id: s.id,
        nom: s.nom,
        role: s.role,
        doit_changer_mdp: complet ? complet.doit_changer_mdp : false,
      },
      csrf: s.csrf,
    });
  }

  /* ---- Changer SON propre mot de passe (accessible meme si changement impose) ---- */
  if (methode === 'PUT' && chemin.endsWith('/mot-de-passe')) {
    const s = await auth.session(req);
    if (!s) return envoyerErreur(res, 401, 'Authentification requise.');
    const id = Number(chemin.split('/')[3]);
    if (id !== s.id) return envoyerErreur(res, 403, "Vous ne pouvez changer que votre propre mot de passe.");
    if (req.headers['x-csrf-token'] !== s.csrf) return envoyerErreur(res, 403, 'Jeton CSRF invalide. Rechargez la page.');

    const { actuel, nouveau } = await lireCorps(req);
    const u = await db.getUtilisateur(id);
    if (!u) return envoyerErreur(res, 404, 'Utilisateur introuvable.');
    const motStocke = await db.motDePasseHache(id);
    if (!(await db.verifierMotDePasse(String(actuel || ''), motStocke))) {
      auth.enregistrerEchec(auth.ip(req));
      return envoyerErreur(res, 401, 'Mot de passe actuel incorrect.');
    }
    const mdp = String(nouveau || '');
    if (mdp.length < 10) return envoyerErreur(res, 400, 'Le nouveau mot de passe doit contenir au moins 10 caractères.');
    if (!/[a-zA-Z]/.test(mdp) || !/[0-9]/.test(mdp)) {
      return envoyerErreur(res, 400, 'Le nouveau mot de passe doit contenir au moins une lettre et un chiffre.');
    }
    if (mdp === String(actuel || '')) return envoyerErreur(res, 400, "Le nouveau mot de passe doit être différent de l'ancien.");
    if (process.env.ADMIN_PASSWORD) {
      console.log("  Rappel : ADMIN_PASSWORD est toujours defini dans les variables d'environnement.");
      console.log("  Retirez-la (Render : Environment) : le compte s'authentifie desormais par sa base PostgreSQL.");
    }

    await db.modifierUtilisateur(id, { mot_de_passe: mdp });
    return envoyerJson(res, 200, { modifie: true },
      { 'Set-Cookie': auth.cookieVide(req) });
  }

  /* ---- Utilisateurs (admin) ---- */
  if (methode === 'GET' && chemin === '/api/utilisateurs') {
    const refus = await auth.verifierAcces(req, 'utilisateurs:ecrire');
    if (refus) return envoyerErreur(res, refus.code, refus.erreur);
    return envoyerJson(res, 200, await db.listerUtilisateurs());
  }

  if (methode === 'POST' && chemin === '/api/utilisateurs') {
    const refus = await auth.verifierAcces(req, 'utilisateurs:ecrire');
    if (refus) return envoyerErreur(res, refus.code, refus.erreur);
    return envoyerJson(res, 201, await db.creerUtilisateur(await lireCorps(req)));
  }

  if (methode === 'PUT' && chemin.startsWith('/api/utilisateurs/')) {
    const refus = await auth.verifierAcces(req, 'utilisateurs:ecrire');
    if (refus) return envoyerErreur(res, refus.code, refus.erreur);
    const id = Number(chemin.split('/').pop());
    return envoyerJson(res, 200, await db.modifierUtilisateur(id, await lireCorps(req)));
  }

  if (methode === 'DELETE' && chemin.startsWith('/api/utilisateurs/')) {
    const refus = await auth.verifierAcces(req, 'utilisateurs:ecrire');
    if (refus) return envoyerErreur(res, refus.code, refus.erreur);
    const id = Number(chemin.split('/').pop());
    const s = await auth.session(req);
    if (id === s?.id) return envoyerErreur(res, 400, 'Vous ne pouvez pas supprimer votre propre compte.');
    return envoyerJson(res, 200, await db.supprimerUtilisateur(id));
  }

  /* ---- Categories ---- */
  if (methode === 'GET' && chemin === '/api/categories') {
    const refus = await auth.verifierAcces(req, 'categories:lire');
    if (refus) return envoyerErreur(res, refus.code, refus.erreur);
    return envoyerJson(res, 200, await db.listCategories());
  }

  if (methode === 'POST' && chemin === '/api/categories') {
    const refus = await auth.verifierAcces(req, 'categories:ecrire');
    if (refus) return envoyerErreur(res, refus.code, refus.erreur);
    return envoyerJson(res, 201, await db.createCategorie(await lireCorps(req)));
  }

  if (methode === 'PUT' && chemin.startsWith('/api/categories/')) {
    const refus = await auth.verifierAcces(req, 'categories:ecrire');
    if (refus) return envoyerErreur(res, refus.code, refus.erreur);
    return envoyerJson(res, 200, await db.updateCategorie(Number(chemin.split('/').pop()), await lireCorps(req)));
  }

  if (methode === 'DELETE' && chemin.startsWith('/api/categories/')) {
    const refus = await auth.verifierAcces(req, 'categories:ecrire');
    if (refus) return envoyerErreur(res, refus.code, refus.erreur);
    return envoyerJson(res, 200, await db.deleteCategorie(Number(chemin.split('/').pop())));
  }

  /* ---- Operations ---- */
  if (methode === 'GET' && chemin === '/api/operations') {
    const refus = await auth.verifierAcces(req, 'operations:lire');
    if (refus) return envoyerErreur(res, refus.code, refus.erreur);
    return envoyerJson(res, 200, await db.listOperations(filtres(url)));
  }

  if (methode === 'POST' && chemin === '/api/operations') {
    const refus = await auth.verifierAcces(req, 'operations:ecrire');
    if (refus) return envoyerErreur(res, refus.code, refus.erreur);
    return envoyerJson(res, 201, await db.createOperation(await lireCorps(req)));
  }

  if (methode === 'PUT' && chemin.startsWith('/api/operations/')) {
    const refus = await auth.verifierAcces(req, 'operations:ecrire');
    if (refus) return envoyerErreur(res, refus.code, refus.erreur);
    return envoyerJson(res, 200, await db.updateOperation(Number(chemin.split('/').pop()), await lireCorps(req)));
  }

  if (methode === 'DELETE' && chemin.startsWith('/api/operations/')) {
    const refus = await auth.verifierAcces(req, 'operations:supprimer');
    if (refus) return envoyerErreur(res, refus.code, refus.erreur);
    return envoyerJson(res, 200, await db.deleteOperation(Number(chemin.split('/').pop())));
  }

  /* ---- Statistiques, export, sauvegarde ---- */
  if (methode === 'GET' && chemin === '/api/stats') {
    const refus = await auth.verifierAcces(req, 'stats:lire');
    if (refus) return envoyerErreur(res, refus.code, refus.erreur);
    return envoyerJson(res, 200, await db.stats(filtres(url)));
  }

  if (methode === 'GET' && chemin === '/api/export.csv') {
    const refus = await auth.verifierAcces(req, 'operations:lire');
    if (refus) return envoyerErreur(res, refus.code, refus.erreur);
    const csv = Buffer.from('﻿' + await db.exportCsv(filtres(url)), 'utf8');
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
    const refus = await auth.verifierAcces(req, 'utilisateurs:ecrire');
    if (refus) return envoyerErreur(res, refus.code, refus.erreur);
    return envoyerJson(res, 200, {
      genere_le: new Date().toISOString(),
      categories: await db.listCategories(),
      operations: await db.listerOperationsBrutes(),
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
  await db.init();
  await verifierPremierLancement();
  await avertirSiBaseVide();
  const nettoyes = await db.nettoyerSessionsExpirees();
  if (nettoyes) console.log(`  ${nettoyes} session(s) expiree(s) supprimee(s).`);
  setInterval(() => { db.nettoyerSessionsExpirees().catch(() => {}); }, 3600_000).unref();

  serveur.listen(PORT, HOST, () => {
    console.log('');
    console.log('  Comptabilite - Vente de poisson');
    console.log('  ---------------------------------');
    console.log(`  Serveur : http://${HOST}:${PORT}`);
    console.log(`  Base    : PostgreSQL (${db.descriptionBase()})`);
    console.log(`  Mode    : ${PRODUCTION ? 'production' : 'developpement'}`);
    if (PRODUCTION) {
      console.log(`  HTTPS   : cookie Secure ${auth.estHttps({ headers: {}, socket: {} }) ? 'actif' : 'actif uniquement sur les requetes HTTPS'}`);
    }
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

/** Render envoie SIGTERM a chaque redemarrage/redploiement : on ferme le
 *  pool de connexions avant de quitter, sinon PostgreSQL note des connexions
 *  restees ouvertes et peut les refuser temporairement. */
const arreter = async (signal) => {
  console.log(`\n  Arret du serveur (${signal}).`);
  serveur.close();
  try { await db.fermer(); } catch { /* deja fermee */ }
  process.exit(0);
};
process.on('SIGINT', () => { arreter('SIGINT'); });
process.on('SIGTERM', () => { arreter('SIGTERM'); });
