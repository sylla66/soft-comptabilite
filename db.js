'use strict';

/**
 * Couche base de donnees - PostgreSQL (Neon en production).
 *
 * Toutes les fonctions sont asynchrones : une requete PostgreSQL demande un
 * aller-retour reseau, la base ne peut donc pas etre interrogee de facon
 * synchrone comme pouvait l'etre SQLite.
 */

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const { Pool, types } = require('pg');

const TYPES = ['entree', 'sortie', 'investissement'];
const LIBELLES = { entree: 'Entrée', sortie: 'Sortie', investissement: 'Investissement' };
const ORDRE_TYPE = { entree: 0, sortie: 1, investissement: 2 };
const DUREE_SESSION_JOURS = 7;

/* PostgreSQL renvoie nativement les DATE et TIMESTAMP sous forme d'objet
   Date. On les garde en texte 'AAAA-MM-JJ' / 'AAAA-MM-JJ HH:MM:SS' :
   l'interface fait du .slice(0,10) sur ces valeurs, et cela evite tout
   decalage de fuseau horaire cote client. */
types.setTypeParser(1082, (v) => v);   // date
types.setTypeParser(1114, (v) => v);   // timestamp
types.setTypeParser(1184, (v) => v);   // timestamptz

class ErreurValidation extends Error {
  constructor(message) {
    super(message);
    this.name = 'ErreurValidation';
    this.statut = 400;
  }
}
const invalide = (m) => { throw new ErreurValidation(m); };

/* ------------------------------------------------------------------ */
/* Mot de passe : scrypt (dans node:crypto, sans dependance)          */
/* ------------------------------------------------------------------ */

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const LONGUEUR_CLE = 64;

async function hacherMotDePasse(motDePasse) {
  const sel = crypto.randomBytes(16);
  const cle = await scrypt(String(motDePasse).normalize('NFKC'), sel, LONGUEUR_CLE, SCRYPT);
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
    const cle = await scrypt(String(motDePasse).normalize('NFKC'), sel, attendu.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
    });
    return cle.length === attendu.length && crypto.timingSafeEqual(cle, attendu);
  } catch {
    return false;
  }
}

const hacherJeton = (jeton) => crypto.createHash('sha256').update(jeton).digest('hex');

/* ------------------------------------------------------------------ */
/* Connexion                                                           */
/* ------------------------------------------------------------------ */

let pool = null;

function urlConnection() {
  const u = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
  if (!u) {
    console.error('\n  DATABASE_URL est obligatoire : cette version attend PostgreSQL (Neon).');
    console.error('  Render : variable d\'environnement = chaine de connexion Neon.');
    console.error('  Local  : docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=x postgres:16\n');
    process.exit(1);
  }
  return u;
}

function estLocal(hote) {
  return /^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1|postgres|db|host\.docker\.internal)$/i.test(String(hote || ''));
}

/**
 * Nettoie la chaine de connexion avant de la donner a `pg`.
 *
 * Neon publie plusieurs formes de la meme chaine, et certains tableaux de
 * bord ajoutent `channel_binding=require`. C'est une option de `libpq`, pas
 * un parametre de PostgreSQL : transmise au serveur, elle le fait echouer
 * au demarrage ("unrecognized configuration parameter"). On la retire donc
 * - le chiffrement reste assure par `sslmode`.
 */
function nettoyerUrl(u) {
  return String(u)
    .replace(/([?&])channel_binding=[^&#]*&?/i, '$1')
    .replace(/[?&]{2,}/g, (m) => m[0])
    .replace(/[?&]$/, '');
}

/**
 * Options de connexion.
 *
 * Pour une base hebergee, le TLS est obligatoire : Neon refuse le trafic en
 * clair, et une chaine copiee depuis le tableau de bord peut l'avoir perdu.
 * On ajoute donc `sslmode=require` quand il manque, plutot que de laisser
 * partir des identifiants en clair. Un PostgreSQL local (localhost, docker)
 * est laisse intact : le forcer casserait une base configuree sans SSL.
 */
function optionsConnexion(u) {
  let chaine = nettoyerUrl(u);
  const options = {
    connectionString: chaine,
    max: Number(process.env.PGPOOL_MAX || 5),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 20_000,
  };
  if (/[?&]sslmode=/i.test(chaine)) return options;

  let hote = '';
  try { hote = new URL(chaine).hostname; } catch { /* URL illisible : rien a dire */ }
  if (hote && !estLocal(hote)) {
    console.warn(`  DATABASE_URL ne precise pas de sslmode : ajout de sslmode=require pour ${hote}.`);
    chaine += (chaine.includes('?') ? '&' : '?') + 'sslmode=require';
    options.connectionString = chaine;
  }
  return options;
}

const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS categories (
  id     SERIAL PRIMARY KEY,
  nom    TEXT    NOT NULL UNIQUE,
  type   TEXT    NOT NULL CHECK (type IN ('entree','sortie','investissement')),
  unite  TEXT,
  ordre  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS operations (
  id            SERIAL PRIMARY KEY,
  date          DATE    NOT NULL,
  categorie_id  INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  montant       NUMERIC NOT NULL DEFAULT 0,
  quantite      NUMERIC,
  prix_unitaire NUMERIC,
  unite         TEXT,
  note          TEXT,
  cree_le       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id               SERIAL PRIMARY KEY,
  nom              TEXT    NOT NULL UNIQUE,
  mot_de_passe     TEXT    NOT NULL,
  role             TEXT    NOT NULL CHECK (role IN ('admin','saisie')),
  actif            BOOLEAN NOT NULL DEFAULT TRUE,
  cree_le          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  doit_changer_mdp BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf       TEXT    NOT NULL,
  cree_le    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expire_le  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_operations_date      ON operations(date);
CREATE INDEX IF NOT EXISTS idx_operations_categorie ON operations(categorie_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user        ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiration   ON sessions(expire_le);
`;

async function init() {
  pool = new Pool(optionsConnexion(urlConnection()));
  // Une base Neon peut se mettre en veille : on retente quelques fois avant
  // d'abandonner, pour absorber un demarrage a froid.
  pool.on('error', (e) => console.error('  [base] erreur du pool :', e.message));
  await pool.query(SCHEMA);
  await ensureDefaultCategories();
}

const fermer = async () => { if (pool) { await pool.end(); pool = null; } };

const CATEGORIES_PAR_DEFAUT = [
  ['Vente détail', 'entree', 'kg', 1],
  ['Vente gros', 'entree', 'kg', 2],
  ['Achat poisson', 'sortie', 'kg', 3],
  ['Glace / conservation', 'sortie', null, 4],
  ['Transport', 'sortie', null, 5],
  ['Emballage', 'sortie', null, 6],
  ['Location étal', 'sortie', null, 7],
  ['Salaires', 'sortie', null, 8],
  ['Investissement', 'investissement', null, 9],
];

async function ensureDefaultCategories() {
  for (const [nom, type, unite, ordre] of CATEGORIES_PAR_DEFAUT) {
    await pool.query(
      `INSERT INTO categories (nom, type, unite, ordre) VALUES ($1,$2,$3,$4)
       ON CONFLICT (nom) DO NOTHING`,
      [nom, type, unite, ordre]
    );
  }
}

/* ------------------------------------------------------------------ */
/* Categories                                                          */
/* ------------------------------------------------------------------ */

const mapCategorie = (r) => (r ? { ...r, id: Number(r.id), ordre: Number(r.ordre) } : null);
const trier = (a, b) =>
  (ORDRE_TYPE[a.type] - ORDRE_TYPE[b.type]) || (a.ordre - b.ordre) || a.nom.localeCompare(b.nom, 'fr');

async function listCategories() {
  return (await q('SELECT * FROM categories')).map(mapCategorie).sort(trier);
}

async function getCategorie(id) {
  const [row] = await q('SELECT * FROM categories WHERE id = $1', [id]);
  return mapCategorie(row);
}

async function createCategorie({ nom, type, unite = null }) {
  if (!nom || !String(nom).trim()) invalide('Le nom de la catégorie est obligatoire.');
  if (!TYPES.includes(type)) invalide(`Le type doit être l'un de : ${TYPES.join(', ')}.`);
  const nomPropre = String(nom).trim();
  if (await getCategorieParNom(nomPropre)) invalide(`La catégorie « ${nomPropre} » existe déjà.`);
  const [{ m }] = await q('SELECT COALESCE(MAX(ordre), 0) AS m FROM categories');
  const [res] = await q(
    'INSERT INTO categories (nom, type, unite, ordre) VALUES ($1,$2,$3,$4) RETURNING id',
    [nomPropre, type, unite || null, Number(m) + 1]
  );
  return getCategorie(Number(res.id));
}

async function getCategorieParNom(nom) {
  const [row] = await q('SELECT * FROM categories WHERE nom = $1', [nom]);
  return mapCategorie(row);
}

async function updateCategorie(id, { nom, type, unite }) {
  if (!(await getCategorie(id))) invalide('Catégorie introuvable.');
  if (nom !== undefined) {
    if (!String(nom).trim()) invalide('Le nom de la catégorie est obligatoire.');
    await q('UPDATE categories SET nom = $1 WHERE id = $2', [String(nom).trim(), id]);
  }
  if (type !== undefined) {
    if (!TYPES.includes(type)) invalide(`Le type doit être l'un de : ${TYPES.join(', ')}.`);
    await q('UPDATE categories SET type = $1 WHERE id = $2', [type, id]);
  }
  if (unite !== undefined) await q('UPDATE categories SET unite = $1 WHERE id = $2', [unite || null, id]);
  return getCategorie(id);
}

async function deleteCategorie(id) {
  const cat = await getCategorie(id);
  if (!cat) invalide('Catégorie introuvable.');
  const [{ n }] = await q('SELECT COUNT(*) AS n FROM operations WHERE categorie_id = $1', [id]);
  if (Number(n) > 0) {
    invalide(`Impossible de supprimer « ${cat.nom} » : ${n} opération(s) utilisent cette catégorie.`);
  }
  await q('DELETE FROM categories WHERE id = $1', [id]);
  return { supprime: true };
}

/* ------------------------------------------------------------------ */
/* Operations                                                          */
/* ------------------------------------------------------------------ */

const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;

async function normaliser({ date, categorie_id, montant, quantite, prix_unitaire, unite, note }) {
  const cat = await getCategorie(categorie_id);
  if (!cat) invalide('Catégorie introuvable.');
  if (!date || !RE_DATE.test(date)) invalide('Date invalide (format attendu : AAAA-MM-JJ).');

  const qte = quantite === '' || quantite === null || quantite === undefined ? null : Number(quantite);
  const pu = prix_unitaire === '' || prix_unitaire === null || prix_unitaire === undefined
    ? null
    : Number(prix_unitaire);

  if (qte !== null && (!Number.isFinite(qte) || qte <= 0)) invalide('La quantité doit être un nombre positif.');
  if (pu !== null && (!Number.isFinite(pu) || pu < 0)) invalide('Le prix unitaire doit être un nombre positif ou nul.');

  let m;
  if (qte !== null && pu !== null) m = Math.round(qte * pu * 100) / 100;
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
    quantite: qte,
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

const mapOp = (r) => (r ? {
  ...r,
  id: Number(r.id),
  categorie_id: Number(r.categorie_id),
  montant: Number(r.montant),
  quantite: r.quantite === null ? null : Number(r.quantite),
  prix_unitaire: r.prix_unitaire === null ? null : Number(r.prix_unitaire),
} : null);

/** Construit la clause WHERE et les arguments correspondants. */
function construireFiltres(f) {
  const where = [];
  const args = [];
  const ajouter = (sql, valeur) => { where.push(sql); args.push(valeur); };

  if (f.debut) ajouter('o.date >= $' + (args.length + 1), f.debut);
  if (f.fin) ajouter('o.date <= $' + (args.length + 1), f.fin);
  if (f.categorie_id) ajouter('o.categorie_id = $' + (args.length + 1), Number(f.categorie_id));
  if (TYPES.includes(f.type)) ajouter('c.type = $' + (args.length + 1), f.type);
  if (f.texte) {
    const t = '%' + String(f.texte).toLowerCase() + '%';
    ajouter("(COALESCE(o.note,'') ILIKE $" + (args.length + 1) + " OR c.nom ILIKE $" + (args.length + 1) + ")", t);
  }
  return { clause: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
}

async function listOperations(f = {}) {
  const { clause, args } = construireFiltres(f);
  const ordre = f.ordre === 'asc' ? 'ASC' : 'DESC';
  return (await q(`${SELECT_OP} ${clause} ORDER BY o.date ${ordre}, o.id ${ordre}`, args)).map(mapOp);
}

async function getOperation(id) {
  const [row] = await q(`${SELECT_OP} WHERE o.id = $1`, [id]);
  return mapOp(row);
}

async function createOperation(input) {
  const d = await normaliser(input);
  const [res] = await q(
    `INSERT INTO operations (date, categorie_id, montant, quantite, prix_unitaire, unite, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [d.date, d.categorie_id, d.montant, d.quantite, d.prix_unitaire, d.unite, d.note]
  );
  return getOperation(Number(res.id));
}

async function updateOperation(id, input) {
  const actuel = await getOperation(id);
  if (!actuel) invalide('Opération introuvable.');
  const quantite = input.quantite !== undefined ? input.quantite : actuel.quantite;
  const prixUnitaire = input.prix_unitaire !== undefined ? input.prix_unitaire : actuel.prix_unitaire;
  const d = await normaliser({
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
  await q(
    `UPDATE operations
     SET date = $1, categorie_id = $2, montant = $3, quantite = $4, prix_unitaire = $5, unite = $6, note = $7
     WHERE id = $8`,
    [d.date, d.categorie_id, d.montant, d.quantite, d.prix_unitaire, d.unite, d.note, id]
  );
  return getOperation(id);
}

async function deleteOperation(id) {
  if (!(await getOperation(id))) invalide('Opération introuvable.');
  await q('DELETE FROM operations WHERE id = $1', [id]);
  return { supprime: true };
}

const compterOperations = async () => Number((await q('SELECT COUNT(*) AS n FROM operations'))[0].n);

/* ------------------------------------------------------------------ */
/* Statistiques                                                         */
/* ------------------------------------------------------------------ */

const arrondi = (n) => Math.round(n * 100) / 100;

async function stats(f = {}) {
  const { clause, args } = construireFiltres(f);

  const [g] = await q(
    `SELECT
        COALESCE(SUM(CASE WHEN c.type='entree'         THEN o.montant END), 0) AS entrees,
        COALESCE(SUM(CASE WHEN c.type='sortie'         THEN o.montant END), 0) AS sorties,
        COALESCE(SUM(CASE WHEN c.type='investissement' THEN o.montant END), 0) AS investissements,
        COALESCE(SUM(CASE WHEN c.type='entree'         THEN 1 END), 0) AS nb_entrees,
        COALESCE(SUM(CASE WHEN c.type='sortie'         THEN 1 END), 0) AS nb_sorties,
        COALESCE(SUM(CASE WHEN c.type='investissement' THEN 1 END), 0) AS nb_investissements
     FROM operations o JOIN categories c ON c.id = o.categorie_id ${clause}`,
    args
  );

  const entrees = Number(g.entrees);
  const sorties = Number(g.sorties);
  const investissements = Number(g.investissements);
  const resultat = arrondi(entrees - sorties);

  // Memes filtres, mais appliques dans le LEFT JOIN pour garder les categories
  // vides (elles doivent apparaitre avec un total de 0).
  const jointureSupplement = clause ? 'AND ' + clause.replace(/^WHERE /, '') : '';

  const parCategorie = (await q(
    `SELECT c.id, c.nom, c.type,
            COALESCE(SUM(o.montant), 0) AS total, COUNT(o.id) AS nb
     FROM categories c
     LEFT JOIN operations o ON o.categorie_id = c.id ${jointureSupplement}
     GROUP BY c.id
     ORDER BY total DESC`,
    args
  )).map((r) => ({ ...r, id: Number(r.id), total: Number(r.total), nb: Number(r.nb) }));

  const parMois = (await q(
    `SELECT to_char(o.date, 'YYYY-MM') AS mois,
            COALESCE(SUM(CASE WHEN c.type='entree'         THEN o.montant END), 0) AS entrees,
            COALESCE(SUM(CASE WHEN c.type='sortie'         THEN o.montant END), 0) AS sorties,
            COALESCE(SUM(CASE WHEN c.type='investissement' THEN o.montant END), 0) AS investissements
     FROM operations o JOIN categories c ON c.id = o.categorie_id
     ${clause}
     GROUP BY mois ORDER BY mois DESC`,
    args
  )).map((r) => ({
    mois: r.mois,
    entrees: Number(r.entrees),
    sorties: Number(r.sorties),
    investissements: Number(r.investissements),
    resultat: arrondi(Number(r.entrees) - Number(r.sorties)),
    tresorerie: arrondi(Number(r.entrees) - Number(r.sorties) - Number(r.investissements)),
  }));

  const parJourInvestissement = (await q(
    `SELECT to_char(o.date, 'YYYY-MM') AS mois, COALESCE(SUM(o.montant), 0) AS total
     FROM operations o JOIN categories c ON c.id = o.categorie_id
     ${clause ? clause + ' AND' : 'WHERE'} c.type='investissement'
     GROUP BY mois ORDER BY mois`,
    args
  )).map((r) => ({ mois: r.mois, total: Number(r.total) }));

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

async function exportCsv(f = {}) {
  const echapper = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const fr = (n) => String(n).replace('.', ',');
  const entete = ['Date', 'Nature', 'Categorie', 'Montant', 'Quantite', 'Prix unitaire', 'Unite', 'Note'];
  const lignes = (await listOperations(f)).map((o) =>
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

const mapUser = (r) => (r ? {
  id: Number(r.id),
  nom: r.nom,
  role: r.role,
  actif: r.actif === true || Number(r.actif) === 1,
  cree_le: r.cree_le,
  doit_changer_mdp: r.doit_changer_mdp === true || Number(r.doit_changer_mdp) === 1,
} : null);

const listerUtilisateurs = async () => (await q('SELECT * FROM users ORDER BY id')).map(mapUser);

const getUtilisateur = async (id) => mapUser((await q('SELECT * FROM users WHERE id = $1', [id]))[0]);

const getUtilisateurParNom = async (nom) =>
  (await q('SELECT * FROM users WHERE nom = $1', [String(nom || '').trim()]))[0] || null;

/** Hash stocke, pour verifier un mot de passe sans l'exposer. */
const motDePasseHache = async (id) => {
  const [r] = await q('SELECT mot_de_passe FROM users WHERE id = $1', [id]);
  return r ? r.mot_de_passe : null;
};

async function creerUtilisateur({ nom, mot_de_passe, role = 'saisie', actif = true, doit_changer_mdp = false }) {
  const nomPropre = String(nom || '').trim();
  if (!nomPropre) invalide("Le nom d'utilisateur est obligatoire.");
  if (!['admin', 'saisie'].includes(role)) invalide("Le rôle doit être 'admin' ou 'saisie'.");
  const mdp = String(mot_de_passe || '');
  if (mdp.length < 8) invalide('Le mot de passe doit contenir au moins 8 caractères.');
  if (await getUtilisateurParNom(nomPropre)) invalide(`L'utilisateur « ${nomPropre} » existe déjà.`);

  // Premier compte de la base : automatiquement administrateur.
  const [{ n }] = await q("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND actif=TRUE");
  const roleFinal = Number(n) === 0 ? 'admin' : role;

  const [res] = await q(
    `INSERT INTO users (nom, mot_de_passe, role, actif, doit_changer_mdp)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [nomPropre, await hacherMotDePasse(mdp), roleFinal, actif, doit_changer_mdp]
  );
  return getUtilisateur(Number(res.id));
}

async function exigerUnAdminRestant(idExclu) {
  const [{ n }] = await q(
    "SELECT COUNT(*) AS n FROM users WHERE role='admin' AND actif=TRUE AND id <> $1",
    [idExclu]
  );
  if (Number(n) === 0) invalide('Impossible : il doit rester au moins un administrateur actif.');
}

async function modifierUtilisateur(id, { nom, mot_de_passe, role, actif }) {
  const u = await getUtilisateur(id);
  if (!u) invalide('Utilisateur introuvable.');

  if (nom !== undefined) {
    const nomPropre = String(nom).trim();
    if (!nomPropre) invalide("Le nom d'utilisateur est obligatoire.");
    if (await getUtilisateurParNom(nomPropre)) invalide(`L'utilisateur « ${nomPropre} » existe déjà.`);
    await q('UPDATE users SET nom = $1 WHERE id = $2', [nomPropre, id]);
  }
  if (role !== undefined) {
    if (!['admin', 'saisie'].includes(role)) invalide("Le rôle doit être 'admin' ou 'saisie'.");
    if (u.role === 'admin' && role !== 'admin') await exigerUnAdminRestant(id);
    await q('UPDATE users SET role = $1 WHERE id = $2', [role, id]);
  }
  if (actif !== undefined) {
    if (!actif && u.role === 'admin') await exigerUnAdminRestant(id);
    await q('UPDATE users SET actif = $1 WHERE id = $2', [actif, id]);
    if (!actif) await q('DELETE FROM sessions WHERE user_id = $1', [id]);
  }
  if (mot_de_passe !== undefined && String(mot_de_passe) !== '') {
    if (String(mot_de_passe).length < 8) invalide('Le mot de passe doit contenir au moins 8 caractères.');
    await q('UPDATE users SET mot_de_passe = $1, doit_changer_mdp = FALSE WHERE id = $2',
      [await hacherMotDePasse(String(mot_de_passe)), id]);
    await q('DELETE FROM sessions WHERE user_id = $1', [id]);
  }
  return getUtilisateur(id);
}

async function supprimerUtilisateur(id) {
  const u = await getUtilisateur(id);
  if (!u) invalide('Utilisateur introuvable.');
  if (u.role === 'admin') await exigerUnAdminRestant(id);
  await q('DELETE FROM sessions WHERE user_id = $1', [id]);
  await q('DELETE FROM users WHERE id = $1', [id]);
  return { supprime: true };
}

const connecter = (nom, motDePasse) => verifierUtilisateurParNom(nom, motDePasse);

async function verifierUtilisateurParNom(nom, motDePasse) {
  const ligne = await getUtilisateurParNom(nom);
  const mdp = String(motDePasse || '');
  if (!ligne || !mdp) {
    // Meme cout de calcul que pour un compte existant : on ne revele pas
    // par le temps de reponse si le nom existe ou non.
    await verifierMotDePasse(mdp || 'x', ligne ? ligne.mot_de_passe : 'scrypt$16384$8$1$AAAA$AAAA');
    return null;
  }
  if (!(await verifierMotDePasse(mdp, ligne.mot_de_passe))) return null;
  if (ligne.actif === false || Number(ligne.actif) === 0) return null;
  return mapUser(ligne);
}

async function creerSession(userId) {
  const jeton = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  const expire = new Date(Date.now() + DUREE_SESSION_JOURS * 864e5);
  await q(
    'INSERT INTO sessions (token_hash, user_id, csrf, expire_le) VALUES ($1,$2,$3,$4)',
    [hacherJeton(jeton), userId, csrf, expire.toISOString()]
  );
  return { jeton, csrf, expire };
}

async function lireSession(jeton) {
  if (!jeton) return null;
  const [l] = await q(
    `SELECT s.token_hash, s.csrf, s.expire_le, u.id, u.nom, u.role, u.actif
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1`,
    [hacherJeton(jeton)]
  );
  if (!l) return null;
  if (new Date(l.expire_le) < new Date()) {
    await q('DELETE FROM sessions WHERE token_hash = $1', [l.token_hash]);
    return null;
  }
  if (l.actif === false) {
    await q('DELETE FROM sessions WHERE token_hash = $1', [l.token_hash]);
    return null;
  }
  return { id: Number(l.id), nom: l.nom, role: l.role, csrf: l.csrf, expire: l.expire_le };
}

const supprimerSession = async (jeton) => {
  if (!jeton) return;
  await q('DELETE FROM sessions WHERE token_hash = $1', [hacherJeton(jeton)]);
};

const supprimerSessionsUtilisateur = async (userId) => {
  await q('DELETE FROM sessions WHERE user_id = $1', [userId]);
};

async function nettoyerSessionsExpirees() {
  const r = await pool.query('DELETE FROM sessions WHERE expire_le < NOW()');
  return r.rowCount || 0;
}

const compterUtilisateurs = async () => Number((await q('SELECT COUNT(*) AS n FROM users'))[0].n);

/** Description de la base, pour l'ecran de sauvegarde. */
const listerOperationsBrutes = async () => (await q('SELECT * FROM operations ORDER BY id')).map(mapOp);

const descriptionBase = () => {
  try {
    const h = new URL(process.env.DATABASE_URL || '').hostname;
    return h;
  } catch {
    return 'postgresql';
  }
};

module.exports = {
  TYPES, LIBELLES, DUREE_SESSION_JOURS,
  hacherMotDePasse, verifierMotDePasse,
  listCategories, getCategorie, createCategorie, updateCategorie, deleteCategorie,
  listOperations, getOperation, createOperation, updateOperation, deleteOperation,
  compterOperations, listerOperationsBrutes, descriptionBase,
  stats, exportCsv,
  listerUtilisateurs, getUtilisateur, getUtilisateurParNom, motDePasseHache,
  creerUtilisateur, modifierUtilisateur, supprimerUtilisateur, supprimerSessionsUtilisateur,
  connecter, creerSession, lireSession, supprimerSession, nettoyerSessionsExpirees,
  compterUtilisateurs, init, fermer, ensureDefaultCategories,
};
