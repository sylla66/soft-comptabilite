'use strict';

const crypto = require('node:crypto');
const db = require('./db');

const COOKIE = 'compa_session';
const DUREE_COOKIE_S = db.DUREE_SESSION_JOURS * 86400;

const EN_TETES_SECURITE = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=(), interest-cohort=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; '),
};

/* ------------------------------------------------------------------ */
/* Limitation des tentatives de connexion                              */
/* ------------------------------------------------------------------ */

const FENETRE_MS = 15 * 60 * 1000;
const MAX_TENTATIVES = 8;
const tentatives = new Map();

function ip(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'inconnu';
}

function tentativeAutorisee(cle) {
  const maintenant = Date.now();
  const entrees = tentatives.get(cle) || [];
  const recentes = entrees.filter((t) => maintenant - t < FENETRE_MS);
  if (recentes.length >= MAX_TENTATIVES) {
    tentatives.set(cle, recentes);
    return { autorise: false, reste: Math.ceil((FENETRE_MS - (maintenant - recentes[0])) / 1000) };
  }
  tentatives.set(cle, recentes);
  return { autorise: true, reste: 0 };
}

function enregistrerEchec(cle) {
  const entrees = tentatives.get(cle) || [];
  entrees.push(Date.now());
  tentatives.set(cle, entrees);
}

const reinitialiserTentatives = (cle) => tentatives.delete(cle);

setInterval(() => {
  const maintenant = Date.now();
  for (const [cle, entrees] of tentatives) {
    if (!entrees.some((t) => maintenant - t < FENETRE_MS)) tentatives.delete(cle);
  }
}, FENETRE_MS).unref();

/* ------------------------------------------------------------------ */
/* Cookies                                                             */
/* ------------------------------------------------------------------ */

function parserCookies(req) {
  const brut = req.headers.cookie;
  const out = {};
  if (!brut) return out;
  for (const morceau of brut.split(';')) {
    const i = morceau.indexOf('=');
    if (i < 1) continue;
    const nom = morceau.slice(0, i).trim();
    try {
      out[nom] = decodeURIComponent(morceau.slice(i + 1).trim());
    } catch {
      out[nom] = morceau.slice(i + 1).trim();
    }
  }
  return out;
}

const enProduction = () => process.env.NODE_ENV === 'production';

function cookieSession(jeton, maxAge = DUREE_COOKIE_S) {
  const parts = [
    `${COOKIE}=${jeton}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
  ];
  if (enProduction()) parts.push('Secure');
  return parts.join('; ');
}

const cookieVide = () => cookieSession('', 0);

/* ------------------------------------------------------------------ */
/* Session et acces                                                   */
/* ------------------------------------------------------------------ */

function session(req) {
  if (!req._session) req._session = db.lireSession(parserCookies(req)[COOKIE]) || null;
  return req._session;
}

const estConnecte = (req) => session(req) !== null;
const estAdmin = (req) => session(req)?.role === 'admin';

/* ------------------------------------------------------------------ */
/* Acces aux operations : qui peut faire quoi                          */
/* ------------------------------------------------------------------ */

const DROITS = {
  'operations:lire': () => true,
  'operations:ecrire': (s) => !!s,
  'operations:supprimer': (s) => s?.role === 'admin',
  'categories:lire': (s) => !!s,
  'categories:ecrire': (s) => s?.role === 'admin',
  'utilisateurs:ecrire': (s) => s?.role === 'admin',
  'stats:lire': () => true,
};

function aLeDroit(req, droit) {
  const s = session(req);
  const test = DROITS[droit];
  return !!test && test(s);
}

const METHODES_ECRITURE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Verifie l'authentification, le role et le jeton CSRF.
 * Renvoie { code, erreur } en cas de refus, sinon null.
 */
function verifierAcces(req, droit) {
  if (!estConnecte(req)) {
    return { code: 401, erreur: 'Authentification requise.' };
  }
  if (!aLeDroit(req, droit)) {
    return { code: 403, erreur: "Droits insuffisants : cette action est réservée à un administrateur." };
  }
  if (METHODES_ECRITURE.has(req.method)) {
    const fourni = req.headers['x-csrf-token'];
    const attendu = session(req).csrf;
    if (typeof fourni !== 'string' || fourni.length !== attendu.length ||
        !crypto.timingSafeEqual(Buffer.from(fourni), Buffer.from(attendu))) {
      return { code: 403, erreur: 'Jeton CSRF invalide. Rechargez la page.' };
    }
  }
  return null;
}

module.exports = {
  COOKIE, EN_TETES_SECURITE, DUREE_COOKIE_S,
  parserCookies, cookieSession, cookieVide, enProduction,
  session, estConnecte, estAdmin, aLeDroit, verifierAcces,
  tentativeAutorisee, enregistrerEchec, reinitialiserTentatives, ip,
};
