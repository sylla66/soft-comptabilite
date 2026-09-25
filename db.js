'use strict';

const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = process.env.COMPA_DB || path.join(DATA_DIR, 'compta.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

class ErreurValidation extends Error {
  constructor(message) {
    super(message);
    this.name = 'ErreurValidation';
    this.statut = 400;
  }
}
const invalide = (m) => {
  throw new ErreurValidation(m);
};

const TYPES = ['entree', 'sortie', 'investissement'];
const LIBELLES = {
  entree: 'Entrée',
  sortie: 'Sortie',
  investissement: 'Investissement',
};

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

/* ------------------------------------------------------------------ */
/* Mot de passe : scrypt (dans node:crypto, sans dependance)          */
/* ------------------------------------------------------------------ */

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const LONGUEUR_CLE = 64;

async function hacherMotDePasse(motDePasse) {
  const sel = crypto.randomBytes(16);
  const cle = await scrypt(motDePasse.normalize('NFKC'), sel, LONGUEUR_CLE, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, sel.toString('base64'), cle.toString('base64')].join('$');
}

async function verifierMotDePasse(motDePasse, stocke) {
  try {
    const parties = String(stocke || '').split('$');
    if (parties.length !== 6 || parties[0] !== 'scrypt') return false;
    const [, N, r, p, selB64, cleB64] = parties;
    const sel = Buffer.from(selB64, 'base64');
    const attendu = Buffer.from(cleB64, 'base64');
    if (!sel.length || !attendu.length) return false;
    const cle = await scrypt(motDePasse.normalize('NFKC'), sel, attendu.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
    });
    return cle.length === attendu.length && crypto.timingSafeEqual(cle, attendu);
  } catch {
    return false;
  }
}

const hacherJeton = (jeton) => crypto.createHash('sha256').update(jeton).digest('hex');

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

db.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    nom    TEXT    NOT NULL UNIQUE,
    type   TEXT    NOT NULL CHECK (type IN ('entree', 'sortie')),
    unite  TEXT,
    ordre  INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS operations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    date         TEXT    NOT NULL,
    categorie_id INTEGER NOT NULL REFERENCES categories(id),
    montant      REAL    NOT NULL DEFAULT 0,
    quantite     REAL,
    prix_unitaire REAL,
    unite        TEXT,
    note         TEXT,
    cree_le      TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    nom          TEXT    NOT NULL UNIQUE,
    mot_de_passe TEXT    NOT NULL,
    role         TEXT    NOT NULL CHECK (role IN ('admin', 'saisie')),
    actif        INTEGER NOT NULL DEFAULT 1,
    cree_le      TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf       TEXT    NOT NULL,
    cree_le    TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    expire_le  TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_operations_date     ON operations(date);
  CREATE INDEX IF NOT EXISTS idx_operations_categorie ON operations(categorie_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_user       ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expiration  ON sessions(expire_le);
`);

/* ------------------------------------------------------------------ */
/* Migration : ajout de la nature "investissement"                     */
/* ------------------------------------------------------------------ */

(function migrerNatureInvestissement() {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='categories'").get();
  if (!table || table.sql.includes("'investissement'")) return;

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    db.exec(`CREATE TABLE categories_migration (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      nom    TEXT    NOT NULL UNIQUE,
      type   TEXT    NOT NULL CHECK (type IN ('entree','sortie','investissement')),
      unite  TEXT,
      ordre  INTEGER NOT NULL DEFAULT 0
    )`);
    db.exec('INSERT INTO categories_migration (id, nom, type, unite, ordre) SELECT id, nom, type, unite, ordre FROM categories');
    db.exec('DELETE FROM categories WHERE id NOT IN (SELECT id FROM categories_migration)');
    db.exec('DROP TABLE categories');
    db.exec('ALTER TABLE categories_migration RENAME TO categories');
    db.exec(`INSERT INTO sqlite_sequence (name, seq)
             SELECT 'categories', COALESCE(MAX(id), 0) FROM categories
             WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name='categories')`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
})();

(function migrerColonneChangementMdp() {
  const colonnes = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (colonnes.includes('doit_changer_mdp')) return;
  db.exec('ALTER TABLE users ADD COLUMN doit_changer_mdp INTEGER NOT NULL DEFAULT 0');
})();

/* ------------------------------------------------------------------ */
/* Categories                                                          */
/* ------------------------------------------------------------------ */

const CATEGORIES_PAR_DEFAUT = [
  { nom: 'Vente détail',          type: 'entree',        unite: 'kg', ordre: 1 },
  { nom: 'Vente gros',            type: 'entree',        unite: 'kg', ordre: 2 },
  { nom: 'Achat poisson',         type: 'sortie',        unite: 'kg', ordre: 3 },
  { nom: 'Glace / conservation',  type: 'sortie',        unite: null, ordre: 4 },
  { nom: 'Transport',             type: 'sortie',        unite: null, ordre: 5 },
  { nom: 'Emballage',             type: 'sortie',        unite: null, ordre: 6 },
  { nom: 'Location étal',         type: 'sortie',        unite: null, ordre: 7 },
  { nom: 'Salaires',              type: 'sortie',        unite: null, ordre: 8 },
  { nom: 'Investissement',        type: 'investissement', unite: null, ordre: 9 },
];

const insertCat = db.prepare(
  'INSERT OR IGNORE INTO categories (nom, type, unite, ordre) VALUES (?, ?, ?, ?)'
);
for (const c of CATEGORIES_PAR_DEFAUT) insertCat.run(c.nom, c.type, c.unite, c.ordre);

const catParNomDb = db.prepare('SELECT id, unite FROM categories WHERE nom = ?');
for (const c of CATEGORIES_PAR_DEFAUT) {
  const row = catParNomDb.get(c.nom);
  if (row) db.prepare('UPDATE categories SET unite = ? WHERE id = ?').run(c.unite, row.id);
}

const ORDRE_TYPE = { entree: 0, sortie: 1, investissement: 2 };

function listCategories() {
  return db
    .prepare('SELECT * FROM categories')
    .all()
    .map((r) => ({ ...r, id: Number(r.id), ordre: Number(r.ordre) }))
    .sort((a, b) => (ORDRE_TYPE[a.type] - ORDRE_TYPE[b.type]) || (a.ordre - b.ordre) || a.nom.localeCompare(b.nom, 'fr'));
}

function getCategorie(id) {
  const r = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
  return r ? { ...r, id: Number(r.id), ordre: Number(r.ordre) } : null;
}

function createCategorie({ nom, type, unite = null }) {
  if (!nom || !String(nom).trim()) invalide('Le nom de la catégorie est obligatoire.');
  if (!TYPES.includes(type)) invalide(`Le type doit être l'un de : ${TYPES.join(', ')}.`);
  const nomPropre = String(nom).trim();
  if (db.prepare('SELECT id FROM categories WHERE nom = ?').get(nomPropre)) {
    invalide(`La catégorie « ${nomPropre} » existe déjà.`);
  }
  const max = db.prepare('SELECT COALESCE(MAX(ordre), 0) AS m FROM categories').get();
  const res = db
    .prepare('INSERT INTO categories (nom, type, unite, ordre) VALUES (?, ?, ?, ?)')
    .run(nomPropre, type, unite || null, Number(max.m) + 1);
  return getCategorie(Number(res.lastInsertRowid));
}

function updateCategorie(id, { nom, type, unite }) {
  if (!getCategorie(id)) invalide('Catégorie introuvable.');
  if (nom !== undefined) {
    if (!String(nom).trim()) invalide('Le nom de la catégorie est obligatoire.');
    db.prepare('UPDATE categories SET nom = ? WHERE id = ?').run(String(nom).trim(), id);
  }
  if (type !== undefined) {
    if (!TYPES.includes(type)) invalide(`Le type doit être l'un de : ${TYPES.join(', ')}.`);
    db.prepare('UPDATE categories SET type = ? WHERE id = ?').run(type, id);
  }
  if (unite !== undefined) {
    db.prepare('UPDATE categories SET unite = ? WHERE id = ?').run(unite || null, id);
  }
  return getCategorie(id);
}

function deleteCategorie(id) {
  const cat = getCategorie(id);
  if (!cat) invalide('Catégorie introuvable.');
  const nb = db.prepare('SELECT COUNT(*) AS n FROM operations WHERE categorie_id = ?').get(id);
  if (Number(nb.n) > 0) {
    invalide(`Impossible de supprimer « ${cat.nom} » : ${nb.n} opération(s) utilisent cette catégorie.`);
  }
  db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  return { supprime: true };
}

/* ------------------------------------------------------------------ */
/* Operations                                                          */
/* ------------------------------------------------------------------ */

const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;

function normaliser({ date, categorie_id, montant, quantite, prix_unitaire, unite, note }) {
  const cat = getCategorie(categorie_id);
  if (!cat) invalide('Catégorie introuvable.');
  if (!date || !RE_DATE.test(date)) invalide('Date invalide (format attendu : AAAA-MM-JJ).');

  const q = quantite === '' || quantite === null || quantite === undefined ? null : Number(quantite);
  const pu = prix_unitaire === '' || prix_unitaire === null || prix_unitaire === undefined
    ? null
    : Number(prix_unitaire);

  if (q !== null && (!Number.isFinite(q) || q <= 0)) invalide('La quantité doit être un nombre positif.');
  if (pu !== null && (!Number.isFinite(pu) || pu < 0)) invalide('Le prix unitaire doit être un nombre positif ou nul.');

  let m;
  if (q !== null && pu !== null) m = Math.round(q * pu * 100) / 100;
  else if (montant !== '' && montant !== null && montant !== undefined) {
    m = Number(montant);
    if (!Number.isFinite(m)) invalide('Le montant doit être un nombre.');
  } else {
    invalide('Renseignez soit un montant, soit une quantité et un prix unitaire (le total est calculé).');
  }
  if (m < 0) invalide('Le montant ne peut pas être négatif.');

  return {
    date,
    categorie_id: Number(categorie_id),
    montant: m,
    quantite: q,
    prix_unitaire: pu,
    unite: unite || cat.unite || null,
    note: note ? String(note).trim() : null,
  };
}

const SELECT_OP = `
  SELECT o.*, c.nom AS categorie, c.type AS type_categorie, c.unite AS unite_categorie
  FROM operations o
  JOIN categories c ON c.id = o.categorie_id
`;

const mapOp = (r) =>
  r
    ? {
        ...r,
        id: Number(r.id),
        categorie_id: Number(r.categorie_id),
        montant: Number(r.montant),
        quantite: r.quantite === null ? null : Number(r.quantite),
        prix_unitaire: r.prix_unitaire === null ? null : Number(r.prix_unitaire),
      }
    : null;

function listOperations(f = {}) {
  const where = [];
  const args = [];
  if (f.debut) { where.push('o.date >= ?'); args.push(f.debut); }
  if (f.fin) { where.push('o.date <= ?'); args.push(f.fin); }
  if (f.categorie_id) { where.push('o.categorie_id = ?'); args.push(Number(f.categorie_id)); }
  if (TYPES.includes(f.type)) { where.push('c.type = ?'); args.push(f.type); }
  if (f.texte) {
    where.push("(LOWER(IFNULL(o.note,'')) LIKE ? OR LOWER(c.nom) LIKE ?)");
    const t = `%${String(f.texte).toLowerCase()}%`;
    args.push(t, t);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const ordre = f.ordre === 'asc' ? 'ASC' : 'DESC';
  return db.prepare(`${SELECT_OP} ${clause} ORDER BY o.date ${ordre}, o.id ${ordre}`).all(...args).map(mapOp);
}

const getOperation = (id) => mapOp(db.prepare(`${SELECT_OP} WHERE o.id = ?`).get(id));

function createOperation(input) {
  const d = normaliser(input);
  const res = db
    .prepare(`INSERT INTO operations (date, categorie_id, montant, quantite, prix_unitaire, unite, note)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(d.date, d.categorie_id, d.montant, d.quantite, d.prix_unitaire, d.unite, d.note);
  return getOperation(Number(res.lastInsertRowid));
}

function updateOperation(id, input) {
  const actuel = getOperation(id);
  if (!actuel) invalide('Opération introuvable.');
  const quantite = input.quantite !== undefined ? input.quantite : actuel.quantite;
  const prixUnitaire = input.prix_unitaire !== undefined ? input.prix_unitaire : actuel.prix_unitaire;
  const d = normaliser({
    date: input.date ?? actuel.date,
    categorie_id: input.categorie_id ?? actuel.categorie_id,
    quantite,
    prix_unitaire: prixUnitaire,
    montant:
      input.montant !== undefined && input.montant !== null && input.montant !== ''
        ? input.montant
        : quantite === null || prixUnitaire === null
          ? actuel.montant
          : undefined,
    unite: input.unite !== undefined ? input.unite : actuel.unite,
    note: input.note !== undefined ? input.note : actuel.note,
  });
  db.prepare(`UPDATE operations
              SET date = ?, categorie_id = ?, montant = ?, quantite = ?, prix_unitaire = ?, unite = ?, note = ?
              WHERE id = ?`)
    .run(d.date, d.categorie_id, d.montant, d.quantite, d.prix_unitaire, d.unite, d.note, id);
  return getOperation(id);
}

function deleteOperation(id) {
  if (!getOperation(id)) invalide('Opération introuvable.');
  db.prepare('DELETE FROM operations WHERE id = ?').run(id);
  return { supprime: true };
}

/* ------------------------------------------------------------------ */
/* Statistiques                                                         */
/* ------------------------------------------------------------------ */

function conditionsFils(f) {
  const where = [];
  const args = [];
  if (f.debut) { where.push('o.date >= ?'); args.push(f.debut); }
  if (f.fin) { where.push('o.date <= ?'); args.push(f.fin); }
  if (f.categorie_id) { where.push('o.categorie_id = ?'); args.push(Number(f.categorie_id)); }
  if (TYPES.includes(f.type)) { where.push('c.type = ?'); args.push(f.type); }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}

const arrondi = (n) => Math.round(n * 100) / 100;

function stats(f = {}) {
  const { clause, args } = conditionsFils(f);

  const g = db
    .prepare(`SELECT
        COALESCE(SUM(CASE WHEN c.type='entree'         THEN o.montant END), 0) AS entrees,
        COALESCE(SUM(CASE WHEN c.type='sortie'         THEN o.montant END), 0) AS sorties,
        COALESCE(SUM(CASE WHEN c.type='investissement' THEN o.montant END), 0) AS investissements,
        COALESCE(SUM(CASE WHEN c.type='entree'         THEN 1 END), 0) AS nb_entrees,
        COALESCE(SUM(CASE WHEN c.type='sortie'         THEN 1 END), 0) AS nb_sorties,
        COALESCE(SUM(CASE WHEN c.type='investissement' THEN 1 END), 0) AS nb_investissements
      FROM operations o JOIN categories c ON c.id = o.categorie_id ${clause}`)
    .get(...args);

  const entrees = Number(g.entrees);
  const sorties = Number(g.sorties);
  const investissements = Number(g.investissements);
  const resultat = arrondi(entrees - sorties);

  const sousFils = conditionsFils(f);
  const jointureSupplement =
    sousFils.clause ? 'AND ' + sousFils.clause.replace(/^WHERE /, '') : '';

  const parCategorie = db
    .prepare(`SELECT c.id, c.nom, c.type,
                     COALESCE(SUM(o.montant), 0) AS total, COUNT(o.id) AS nb
              FROM categories c
              LEFT JOIN operations o ON o.categorie_id = c.id ${jointureSupplement}
              GROUP BY c.id
              ORDER BY total DESC`)
    .all(...sousFils.args)
    .map((r) => ({ ...r, id: Number(r.id), total: Number(r.total), nb: Number(r.nb) }));

  const parMois = db
    .prepare(`SELECT substr(o.date, 1, 7) AS mois,
                     COALESCE(SUM(CASE WHEN c.type='entree'         THEN o.montant END), 0) AS entrees,
                     COALESCE(SUM(CASE WHEN c.type='sortie'         THEN o.montant END), 0) AS sorties,
                     COALESCE(SUM(CASE WHEN c.type='investissement' THEN o.montant END), 0) AS investissements
              FROM operations o JOIN categories c ON c.id = o.categorie_id
              ${clause}
              GROUP BY mois ORDER BY mois DESC`)
    .all(...args)
    .map((r) => ({
      mois: r.mois,
      entrees: Number(r.entrees),
      sorties: Number(r.sorties),
      investissements: Number(r.investissements),
      resultat: arrondi(Number(r.entrees) - Number(r.sorties)),
      tresorerie: arrondi(Number(r.entrees) - Number(r.sorties) - Number(r.investissements)),
    }));

  const parJourInvestissement = db
    .prepare(`SELECT substr(o.date, 1, 7) AS mois, COALESCE(SUM(o.montant), 0) AS total
              FROM operations o JOIN categories c ON c.id = o.categorie_id
              ${clause ? clause + ' AND' : 'WHERE'} c.type='investissement'
              GROUP BY mois ORDER BY mois`)
    .all(...args)
    .map((r) => ({ mois: r.mois, total: Number(r.total) }));

  const valeurInvestissements = parJourInvestissement.reduce((s, m) => s + m.total, 0);

  return {
    entrees: arrondi(entrees),
    sorties: arrondi(sorties),
    investissements: arrondi(investissements),
    resultat,
    tresorerie_nette: arrondi(resultat - investissements),
    valeur_investissements: arrondi(valeurInvestissements),
    nb_entrees: Number(g.nb_entrees),
    nb_sorties: Number(g.nb_sorties),
    nb_investissements: Number(g.nb_investissements),
    taux_marge: entrees > 0 ? arrondi((resultat / entrees) * 100) : null,
    par_categorie: parCategorie,
    par_mois: parMois,
    investissements_par_mois: parJourInvestissement,
  };
}

/* ------------------------------------------------------------------ */
/* Export CSV                                                          */
/* ------------------------------------------------------------------ */

function exportCsv(f = {}) {
  const echapper = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const fr = (n) => String(n).replace('.', ',');
  const entete = ['Date', 'Nature', 'Categorie', 'Montant', 'Quantite', 'Prix unitaire', 'Unite', 'Note'];
  const lignes = listOperations(f).map((o) =>
    [o.date, LIBELLES[o.type_categorie], o.categorie, fr(o.montant),
     o.quantite === null ? '' : fr(o.quantite),
     o.prix_unitaire === null ? '' : fr(o.prix_unitaire),
     o.unite || '', o.note || ''].map(echapper).join(';')
  );
  return entete.join(';') + '\n' + lignes.join('\n') + '\n';
}

/* ------------------------------------------------------------------ */
/* Utilisateurs et sessions                                            */
/* ------------------------------------------------------------------ */

const mapUser = (r) =>
  r
    ? {
        id: Number(r.id),
        nom: r.nom,
        role: r.role,
        actif: Number(r.actif) === 1,
        cree_le: r.cree_le,
        doit_changer_mdp: Number(r.doit_changer_mdp) === 1,
      }
    : null;

const listerUtilisateurs = () =>
  db.prepare('SELECT * FROM users ORDER BY id').all().map(mapUser);

const getUtilisateur = (id) => mapUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));

const getUtilisateurParNom = (nom) =>
  db.prepare('SELECT * FROM users WHERE nom = ?').get(String(nom || '').trim());

const DUREE_SESSION_JOURS = 7;

async function creerUtilisateur({ nom, mot_de_passe, role = 'saisie', actif = true, doit_changer_mdp = false }) {
  const nomPropre = String(nom || '').trim();
  if (!nomPropre) invalide("Le nom d'utilisateur est obligatoire.");
  if (!['admin', 'saisie'].includes(role)) invalide("Le rôle doit être 'admin' ou 'saisie'.");
  const mdp = String(mot_de_passe || '');
  if (mdp.length < 8) invalide('Le mot de passe doit contenir au moins 8 caractères.');
  if (getUtilisateurParNom(nomPropre)) invalide(`L'utilisateur « ${nomPropre} » existe déjà.`);

  const nbAdmins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND actif=1").get();
  const roleFinal = Number(nbAdmins.n) === 0 ? 'admin' : role;

  const res = await db
    .prepare('INSERT INTO users (nom, mot_de_passe, role, actif, doit_changer_mdp) VALUES (?, ?, ?, ?, ?)')
    .run(nomPropre, await hacherMotDePasse(mdp), roleFinal, actif ? 1 : 0, doit_changer_mdp ? 1 : 0);
  return getUtilisateur(Number(res.lastInsertRowid));
}

async function modifierUtilisateur(id, { nom, mot_de_passe, role, actif }) {
  const u = getUtilisateur(id);
  if (!u) invalide('Utilisateur introuvable.');

  if (nom !== undefined) {
    const nomPropre = String(nom).trim();
    if (!nomPropre) invalide("Le nom d'utilisateur est obligatoire.");
    const autre = db.prepare('SELECT id FROM users WHERE nom = ? AND id <> ?').get(nomPropre, id);
    if (autre) invalide(`L'utilisateur « ${nomPropre} » existe déjà.`);
    db.prepare('UPDATE users SET nom = ? WHERE id = ?').run(nomPropre, id);
  }
  if (role !== undefined) {
    if (!['admin', 'saisie'].includes(role)) invalide("Le rôle doit être 'admin' ou 'saisie'.");
    if (u.role === 'admin' && role !== 'admin') await exigerUnAdminRestant(id);
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  }
  if (actif !== undefined) {
    if (!actif && u.role === 'admin') await exigerUnAdminRestant(id);
    db.prepare('UPDATE users SET actif = ? WHERE id = ?').run(actif ? 1 : 0, id);
    if (!actif) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  }
  if (mot_de_passe !== undefined && String(mot_de_passe) !== '') {
    if (String(mot_de_passe).length < 8) invalide('Le mot de passe doit contenir au moins 8 caractères.');
    db.prepare('UPDATE users SET mot_de_passe = ?, doit_changer_mdp = 0 WHERE id = ?')
      .run(await hacherMotDePasse(String(mot_de_passe)), id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  }
  return getUtilisateur(id);
}

async function exigerUnAdminRestant(idExclu) {
  const autres = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND actif=1 AND id <> ?").get(idExclu);
  if (Number(autres.n) === 0) {
    invalide('Impossible : il doit rester au moins un administrateur actif.');
  }
}

async function supprimerUtilisateur(id) {
  const u = getUtilisateur(id);
  if (!u) invalide('Utilisateur introuvable.');
  if (u.role === 'admin') await exigerUnAdminRestant(id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  return { supprime: true };
}

const connecter = (nom, motDePasse) =>
  verifierUtilisateurParNom(nom, motDePasse);

async function verifierUtilisateurParNom(nom, motDePasse) {
  const ligne = getUtilisateurParNom(nom);
  const mdp = String(motDePasse || '');
  if (!ligne || !mdp) {
    await verifierMotDePasse(mdp || 'x', ligne ? ligne.mot_de_passe : 'scrypt$16384$8$1$AAAA$AAAA');
    return null;
  }
  const ok = await verifierMotDePasse(mdp, ligne.mot_de_passe);
  if (!ok) return null;
  if (Number(ligne.actif) !== 1) return null;
  return mapUser(ligne);
}

function creerSession(userId) {
  const jeton = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  const expire = new Date(Date.now() + DUREE_SESSION_JOURS * 864e5);
  db.prepare('INSERT INTO sessions (token_hash, user_id, csrf, expire_le) VALUES (?, ?, ?, ?)')
    .run(hacherJeton(jeton), userId, csrf, expire.toISOString());
  return { jeton, csrf, expire };
}

function lireSession(jeton) {
  if (!jeton) return null;
  const ligne = db.prepare(
    `SELECT s.token_hash, s.csrf, s.expire_le, u.id, u.nom, u.role, u.actif
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?`
  ).get(hacherJeton(jeton));
  if (!ligne) return null;
  if (new Date(ligne.expire_le) < new Date()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(ligne.token_hash);
    return null;
  }
  if (Number(ligne.actif) !== 1) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(ligne.token_hash);
    return null;
  }
  return { id: Number(ligne.id), nom: ligne.nom, role: ligne.role, csrf: ligne.csrf, expire: ligne.expire_le };
}

const supprimerSession = (jeton) => {
  if (jeton) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hacherJeton(jeton));
};

const supprimerSessionsUtilisateur = (userId) =>
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);

function nettoyerSessionsExpirees() {
  const r = db.prepare("DELETE FROM sessions WHERE expire_le < datetime('now')").run();
  return Number(r.changes || 0);
}

function compterUtilisateurs() {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM users').get().n);
}

module.exports = {
  db, DB_PATH, TYPES, LIBELLES, DUREE_SESSION_JOURS,
  hacherMotDePasse, verifierMotDePasse,
  listCategories, getCategorie, createCategorie, updateCategorie, deleteCategorie,
  listOperations, getOperation, createOperation, updateOperation, deleteOperation,
  stats, exportCsv,
  listerUtilisateurs, getUtilisateur, creerUtilisateur, modifierUtilisateur,
  supprimerUtilisateur, supprimerSessionsUtilisateur, connecter, creerSession,
  lireSession, supprimerSession, nettoyerSessionsExpirees, compterUtilisateurs,
};
