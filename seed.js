'use strict';

/**
 * Creation des comptes de test.
 *
 *   DATABASE_URL=... npm run seed
 *
 * Les mots de passe ne sont jamais codes en dur : ils viennent des variables
 * d'environnement et ne sont affiches qu'une fois, dans le terminal qui
 * execute le script. Un compte existant n'est jamais ecrase (on ne touche pas
 * aux mots de passe deja definis par un humain).
 *
 * Variables lues :
 *   SEED_ADMIN_NOM / SEED_ADMIN_MDP     compte administrateur
 *   SEED_SAISIE_NOM / SEED_SAISIE_MDP   compte de saisie
 * Si SEED_ADMIN_NOM n'est pas defini, le compte administrateur est ignore.
 */

const db = require('./db');

const Mdp = (valeur, min = 10) => {
  const m = String(valeur || '');
  if (m.length < min) throw new Error(`Mot de passe trop court : ${min} caracteres minimum.`);
  if (!/[a-zA-Z]/.test(m) || !/[0-9]/.test(m)) {
    throw new Error('Le mot de passe doit contenir au moins une lettre et un chiffre.');
  }
  return m;
};

async function creer({ nom, motDePasse, role, doitChangerMdp = false }) {
  const nomPropre = String(nom || '').trim();
  if (!nomPropre) return null;

  const existant = await db.getUtilisateurParNom(nomPropre);
  if (existant) {
    console.log(`  - ${nomPropre} (${role}) : deja present, ignore.`);
    return null;
  }
  const u = await db.creerUtilisateur({ nom: nomPropre, mot_de_passe: Mdp(motDePasse), role, doit_changer_mdp: doitChangerMdp });
  console.log(`  - ${nomPropre} (${u.role}) : cree.`);
  return { nom: u.nom, role: u.role, motDePasse };
}

(async () => {
  console.log('\n  Creation des comptes de test');
  console.log('  -----------------------------');

  const adminNom = process.env.SEED_ADMIN_NOM || process.env.ADMIN_USER;
  const saisieNom = process.env.SEED_SAISIE_NOM;

  if (!adminNom && !saisieNom) {
    console.error('\n  Rien a faire : definissez au moins SEED_ADMIN_NOM ou SEED_SAISIE_NOM.');
    console.error('  Exemple :');
    console.error('    SEED_ADMIN_NOM=admin SEED_ADMIN_MDP=... \\');
    console.error('    SEED_SAISIE_NOM=saisie SEED_SAISIE_MDP=... npm run seed\n');
    process.exit(1);
  }

  await db.init();

  const crees = [];
  if (adminNom) {
    const c = await creer({ nom: adminNom, motDePasse: process.env.SEED_ADMIN_MDP || process.env.ADMIN_PASSWORD, role: 'admin' });
    if (c) crees.push(c);
  }
  if (saisieNom) {
    const c = await creer({ nom: saisieNom, motDePasse: process.env.SEED_SAISIE_MDP, role: 'saisie' });
    if (c) crees.push(c);
  }

  const total = await db.compterUtilisateurs();
  console.log(`\n  ${total} compte(s) au total sur la base.`);

  if (crees.length) {
    console.log('\n  ============================================================');
    console.log('   IDENTIFIANTS CREES (a noter puis supprimer)');
    for (const c of crees) {
      console.log(`      ${c.nom} / ${c.motDePasse}`);
    }
    console.log('  ============================================================\n');
  }

  await db.fermer();
})().catch((e) => {
  console.error('\n  Echec du seed :', e.message);
  process.exit(1);
});
