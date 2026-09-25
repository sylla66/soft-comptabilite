'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const fmt = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const argent = (n) => fmt.format(Number(n) || 0);
const MOIS_NOMS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin',
                    'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

const NATURES = {
  entree: { label: 'Entrée', classe: 'entree-txt', aide: 'Argent reçu (recette).' },
  sortie: { label: 'Sortie', classe: 'sortie-txt', aide: 'Dépense courante (glace, transport, salaires…).' },
  investissement: {
    label: 'Investissement', classe: 'invest-txt',
    aide: 'Bien durable (bâche, balance, véhicule). Sort de la caisse mais ne réduit pas le résultat.',
  },
};

let categories = [];
let utilisateur = null;
let csrf = null;
let vueCourante = 'journal';

/* ================================================================== */
/* Reseau                                                              */
/* ================================================================== */

async function api(chemin, options = {}) {
  const opts = { headers: {}, ...options };
  opts.headers = { ...(options.headers || {}) };
  if (opts.body) opts.headers['Content-Type'] = 'application/json';
  const methode = (opts.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD'].includes(methode) && csrf) opts.headers['X-CSRF-Token'] = csrf;

  let reponse;
  try {
    reponse = await fetch(chemin, { ...opts, credentials: 'same-origin' });
  } catch {
    throw new Error('Connexion au serveur impossible.');
  }

  if (reponse.status === 401 && vueCourante !== 'connexion') {
    await deconnecter(true);
    throw new Error('Session expirée, veuillez vous reconnecter.');
  }

  const texte = await reponse.text();
  let data = null;
  try { data = texte ? JSON.parse(texte) : null; } catch { data = null; }
  if (!reponse.ok) throw new Error((data && data.erreur) || `Erreur ${reponse.status}`);
  return data;
}

/* ================================================================== */
/* Utilitaires                                                         */
/* ================================================================== */

const echapper = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const dateDuJour = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function toast(msg, type = 'info') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast visible ${type === 'erreur' ? 'erreur' : 'succes'}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.className = 'toast'), 3000);
}

function filtresCourants() {
  const f = {};
  for (const [cle, selecteur] of [['debut', '#f-debut'], ['fin', '#f-fin'], ['type', '#f-type'], ['categorie_id', '#f-categorie']]) {
    const v = $(selecteur).value;
    if (v) f[cle] = v;
  }
  const texte = $('#f-texte').value.trim();
  if (texte) f.texte = texte;
  return f;
}

const qs = (f) => new URLSearchParams(f).toString();
const estAdmin = () => utilisateur && utilisateur.role === 'admin';

/* ================================================================== */
/* Connexion                                                           */
/* ================================================================== */

function afficherConnexion() {
  $('#ecran-connexion').classList.remove('cache');
  $('#application').classList.add('cache');
  setTimeout(() => $('#connexion-nom').focus(), 50);
}

async function deconnecter(silencieux = false) {
  try { await api('/api/deconnexion', { method: 'POST' }); } catch {}
  utilisateur = null;
  csrf = null;
  afficherConnexion();
  if (!silencieux) toast('Vous êtes déconnecté.');
}

$('#form-connexion').addEventListener('submit', async (e) => {
  e.preventDefault();
  const bouton = $('#btn-connexion');
  const erreur = $('#connexion-erreur');
  erreur.textContent = '';
  bouton.disabled = true;
  bouton.textContent = 'Connexion…';
  try {
    const r = await api('/api/connexion', {
      method: 'POST',
      body: JSON.stringify({
        nom: $('#connexion-nom').value.trim(),
        mot_de_passe: $('#connexion-mdp').value,
      }),
    });
    utilisateur = r.utilisateur;
    csrf = r.csrf;
    $('#connexion-mdp').value = '';
    await demarrerApplication();
  } catch (err) {
    erreur.textContent = err.message;
    $('#connexion-mdp').value = '';
    $('#connexion-mdp').focus();
  } finally {
    bouton.disabled = false;
    bouton.textContent = 'Se connecter';
  }
});

$('#btn-deconnexion').addEventListener('click', () => deconnecter());

/* ================================================================== */
/* Demarrage de l'application                                          */
/* ================================================================== */

async function demarrerApplication() {
  if (utilisateur.doit_changer_mdp) return afficherChangementMdp();

  $('#ecran-connexion').classList.add('cache');
  $('#ecran-mdp').classList.add('cache');
  $('#application').classList.remove('cache');

  $('#qui-est-ce').textContent = `${utilisateur.nom} — ${estAdmin() ? 'administrateur' : 'saisie'}`;
  $('#onglet-utilisateurs').classList.toggle('cache', !estAdmin());
  $('#bloc-form-cat').classList.toggle('cache', !estAdmin());

  await chargerCategories();
  await reinitialiserFormulaire();
  await rafraichirVue();
}

/* ================================================================== */
/* Changement de mot de passe obligatoire                              */
/* ================================================================== */

function afficherChangementMdp() {
  $('#ecran-connexion').classList.add('cache');
  $('#ecran-mdp').classList.remove('cache');
  $('#application').classList.add('cache');
  $('#mdp-erreur').textContent = '';
  setTimeout(() => $('#mdp-actuel').focus(), 50);
}

$('#form-mdp').addEventListener('submit', async (e) => {
  e.preventDefault();
  const neuf = $('#mdp-neuf').value;
  const erreur = $('#mdp-erreur');
  erreur.textContent = '';

  if (neuf.length < 10) return (erreur.textContent = 'Le mot de passe doit contenir au moins 10 caractères.');
  if (!/[a-zA-Z]/.test(neuf) || !/[0-9]/.test(neuf)) {
    return (erreur.textContent = 'Le mot de passe doit contenir au moins une lettre et un chiffre.');
  }
  if (neuf !== $('#mdp-confirm').value) return (erreur.textContent = 'Les deux mots de passe ne correspondent pas.');
  if (neuf === $('#mdp-actuel').value) return (erreur.textContent = "Le nouveau mot de passe doit être différent de l'ancien.");

  const bouton = $('#btn-mdp');
  bouton.disabled = true;
  try {
    await api('/api/utilisateurs/' + utilisateur.id + '/mot-de-passe', {
      method: 'PUT',
      body: JSON.stringify({ actuel: $('#mdp-actuel').value, nouveau: neuf }),
    });
    $('#form-mdp').reset();
    const reCo = await api('/api/connexion', { method: 'POST', body: JSON.stringify({ nom: utilisateur.nom, mot_de_passe: neuf }) });
    utilisateur = reCo.utilisateur;
    csrf = reCo.csrf;
    await demarrerApplication();
    toast('Mot de passe enregistré. Tout est sécurisé.');
  } catch (err) {
    erreur.textContent = err.message;
  } finally {
    bouton.disabled = false;
  }
});

/* Mot de passe : la touche Entree ne doit pas envoyer si les champs ne concordent pas */
$('#mdp-neuf').addEventListener('input', () => {
  const n = $('#mdp-neuf').value;
  const ok = n.length >= 10 && /[a-zA-Z]/.test(n) && /[0-9]/.test(n);
  $('#force').textContent = ok
    ? '✓ Mot de passe assez solide.'
    : `Encore ${Math.max(0, 10 - n.length)} caractère(s), avec au moins une lettre et un chiffre.`;
  $('#force').style.color = ok ? 'var(--vert)' : 'var(--gris)';
});

function afficherVue(nom) {
  vueCourante = nom;
  $$('.onglet').forEach((b) => b.classList.toggle('actif', b.dataset.vue === nom));
  $$('.vue').forEach((v) => v.classList.add('cache'));
  $(`#vue-${nom}`).classList.remove('cache');
  rafraichirVue();
}

function rafraichirVue() {
  if (vueCourante === 'journal') return chargerJournal();
  if (vueCourante === 'bilan') return chargerBilan();
  if (vueCourante === 'categories') return chargerCategoriesVue();
  if (vueCourante === 'utilisateurs') return chargerUtilisateurs();
}

$$('.onglet').forEach((b) => b.addEventListener('click', () => afficherVue(b.dataset.vue)));

/* ================================================================== */
/* Categories                                                          */
/* ================================================================== */

async function chargerCategories() {
  categories = await api('/api/categories');
  const remplir = (sel, avecToutes) => {
    const actuel = sel.value;
    sel.innerHTML = '';
    if (avecToutes) sel.add(new Option('Toutes', ''));
    for (const nature of ['entree', 'sortie', 'investissement']) {
      const groupe = document.createElement('optgroup');
      groupe.label = NATURES[nature].label + (nature === 'investissement' ? ' (biens durables)' : nature === 'entree' ? 's (recettes)' : 's (dépenses)');
      for (const c of categories.filter((x) => x.type === nature)) groupe.add(new Option(c.nom, c.id));
      sel.append(groupe);
    }
    if (actuel) sel.value = actuel;
  };
  remplir($('#op-categorie'), false);
  remplir($('#f-categorie'), true);
}

const catParId = (id) => categories.find((c) => c.id === Number(id));

function majSelectCatego() {
  const type = $('input[name="type-op"]:checked').value;
  const sel = $('#op-categorie');
  const actuel = sel.value;
  const dispo = categories.filter((c) => c.type === type);
  sel.innerHTML = '';
  if (!dispo.length) sel.add(new Option(`— aucune catégorie de type « ${NATURES[type].label} » —`, ''));
  for (const c of dispo) sel.add(new Option(c.nom, c.id));
  if (dispo.some((c) => String(c.id) === String(actuel))) sel.value = actuel;
  $('#aide-nature').textContent = NATURES[type].aide;
  majUniteAuto();
}

function majUniteAuto() {
  const cat = catParId($('#op-categorie').value);
  if (cat && cat.unite && [...$('#op-unite').options].some((o) => o.value === cat.unite)) {
    $('#op-unite').value = cat.unite;
  }
}

/* ================================================================== */
/* Formulaire operation                                                */
/* ================================================================== */

function totalCalcule() {
  const detail = $('input[name="mode"]:checked').value === 'detail';
  const q = parseFloat($('#op-quantite').value);
  const p = parseFloat($('#op-prix').value);
  const m = parseFloat($('#op-montant').value);
  let total = 0;
  if (detail && Number.isFinite(q) && Number.isFinite(p)) total = q * p;
  else if (!detail && Number.isFinite(m)) total = m;
  const el = $('#op-total');
  el.textContent = argent(total);
  el.parentElement.classList.toggle('negatif', total < 0);
  return Math.round(total * 100) / 100;
}

function basculerMode() {
  const detail = $('input[name="mode"]:checked').value === 'detail';
  $('#bloc-detail').classList.toggle('cache', !detail);
  $('#bloc-montant').classList.toggle('cache', detail);
  totalCalcule();
}

async function reinitialiserFormulaire() {
  $('#form-op').reset();
  $('#op-id').value = '';
  $('#op-date').value = dateDuJour();
  $('#titre-saisie').textContent = 'Nouvelle opération';
  $('#btn-valider').textContent = 'Enregistrer';
  majSelectCatego();
  basculerMode();
}

function modifierOperation(op) {
  $('#op-id').value = op.id;
  $('#op-date').value = op.date;
  $(`input[name="type-op"][value="${op.type_categorie}"]`).checked = true;
  majSelectCatego();
  $('#op-categorie').value = op.categorie_id;
  if (op.unite) $('#op-unite').value = op.unite;
  if (op.quantite !== null && op.prix_unitaire !== null) {
    $('input[name="mode"][value="detail"]').checked = true;
    $('#op-quantite').value = op.quantite;
    $('#op-prix').value = op.prix_unitaire;
    $('#op-montant').value = op.montant;
  } else {
    $('input[name="mode"][value="montant"]').checked = true;
    $('#op-montant').value = op.montant;
  }
  $('#op-note').value = op.note || '';
  $('#titre-saisie').textContent = `Modifier — ${op.categorie}`;
  $('#btn-valider').textContent = 'Mettre à jour';
  basculerMode();
  totalCalcule();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

$('#form-op').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#op-id').value;
  const detail = $('input[name="mode"]:checked').value === 'detail';
  const corps = {
    date: $('#op-date').value,
    categorie_id: $('#op-categorie').value,
    quantite: detail ? ($('#op-quantite').value || null) : null,
    prix_unitaire: detail ? ($('#op-prix').value || null) : null,
    unite: $('#op-unite').value || null,
    note: $('#op-note').value,
  };
  if (!detail) corps.montant = $('#op-montant').value;

  try {
    if (id) {
      await api('/api/operations/' + id, { method: 'PUT', body: JSON.stringify(corps) });
      toast('Opération mise à jour.');
    } else {
      await api('/api/operations', { method: 'POST', body: JSON.stringify(corps) });
      toast('Opération enregistrée.');
    }
    await reinitialiserFormulaire();
    await rafraichirVue();
  } catch (err) {
    toast(err.message, 'erreur');
  }
});

['#op-quantite', '#op-prix', '#op-montant'].forEach((s) => $(s).addEventListener('input', totalCalcule));
$$('input[name="mode"]').forEach((r) => r.addEventListener('change', basculerMode));
$('#btn-annuler').addEventListener('click', reinitialiserFormulaire);
$('#op-categorie').addEventListener('change', majUniteAuto);
$$('input[name="type-op"]').forEach((r) => r.addEventListener('change', majSelectCatego));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && vueCourante === 'journal' && utilisateur) reinitialiserFormulaire();
});

/* ================================================================== */
/* Journal                                                             */
/* ================================================================== */

function htmlOperation(op) {
  const n = NATURES[op.type_categorie] || NATURES.sortie;
  const signe = op.type_categorie === 'entree' ? '+' : '−';
  const detail = op.quantite !== null && op.prix_unitaire !== null
    ? `${fmt.format(op.quantite)} ${op.unite || ''} × ${argent(op.prix_unitaire)}${op.note ? ' — ' + op.note : ''}`
    : op.note || '';

  return `<tr data-id="${op.id}">
    <td style="white-space:nowrap">${op.date.split('-').reverse().join('/')}</td>
    <td><span class="etiquette ${op.type_categorie}">${n.label}</span></td>
    <td><strong>${echapper(op.categorie)}</strong></td>
    <td class="detail-txt">${echapper(detail)}</td>
    <td class="num ${n.classe}">${signe} ${argent(op.montant)}</td>
    <td class="actions">
      <a class="lien link-accent" data-act="edit">Modifier</a>
      ${estAdmin() ? '<a class="lien link-danger" data-act="del">Supprimer</a>' : ''}
    </td>
  </tr>`;
}

async function chargerJournal() {
  const f = filtresCourants();
  const ops = await api('/api/operations?' + qs(f));
  const body = $('#table-op tbody');
  body.innerHTML = ops.map(htmlOperation).join('');
  $('#nb-op').textContent = ops.length;
  $('#liste-vide').classList.toggle('cache', ops.length > 0);

  const somme = (t) => ops.filter((o) => o.type_categorie === t).reduce((s, o) => s + o.montant, 0);
  const entrees = somme('entree');
  const sorties = somme('sortie');
  const invest = somme('investissement');
  const resultat = entrees - sorties;

  $('#resume-liste').innerHTML =
    `<span class="entree-txt">+${argent(entrees)}</span>` +
    `<span class="sortie-txt">−${argent(sorties + invest)}</span>` +
    `<span class="invest-txt">dont ${argent(invest)} invest.</span>` +
    `<span style="color:var(--bleu)">Résultat : ${argent(resultat)}</span>`;

  $('#resume-filtre').innerHTML =
    `<span class="puce entree">Entrées : ${argent(entrees)}</span>` +
    `<span class="puce sortie">Sorties : ${argent(sorties)}</span>` +
    `<span class="puce invest">Investissements : ${argent(invest)}</span>` +
    `<span class="puce resultat">Résultat d'exploitation : ${argent(resultat)}</span>` +
    `<span class="puce">Trésorerie nette : ${argent(resultat - invest)}</span>`;

  $('#btn-export').onclick = () => {
    const url = '/api/export.csv' + (qs(f) ? '?' + qs(f) : '');
    window.location.assign(url);
  };
}

$('#table-op tbody').addEventListener('click', async (e) => {
  const lien = e.target.closest('a[data-act]');
  if (!lien) return;
  const id = Number(lien.closest('tr').dataset.id);
  const op = await api('/api/operations/' + id).catch(() => null);
  if (!op) return toast('Opération introuvable.', 'erreur');

  if (lien.dataset.act === 'edit') return modifierOperation(op);
  if (lien.dataset.act === 'del') {
    if (!confirm(`Supprimer définitivement cette opération ?\n\n${op.date} — ${op.categorie} — ${argent(op.montant)}`)) return;
    await api('/api/operations/' + id, { method: 'DELETE' });
    toast('Opération supprimée.');
    if ($('#op-id').value === String(id)) await reinitialiserFormulaire();
    await rafraichirVue();
  }
});

/* ================================================================== */
/* Filtres                                                             */
/* ================================================================== */

let minuteur;
const rechargerFiltres = () => {
  clearTimeout(minuteur);
  minuteur = setTimeout(rafraichirVue, 200);
};
['#f-debut', '#f-fin', '#f-type', '#f-categorie'].forEach((s) => $(s).addEventListener('change', rechargerFiltres));
$('#f-texte').addEventListener('input', rechargerFiltres);

$('#btn-mois').addEventListener('click', () => {
  const d = new Date();
  $('#f-debut').value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  $('#f-fin').value = dateDuJour();
  chargerJournal();
});

$('#btn-tout').addEventListener('click', () => {
  ['#f-debut', '#f-fin', '#f-type', '#f-categorie'].forEach((s) => ($(s).value = ''));
  $('#f-texte').value = '';
  chargerJournal();
});

/* ================================================================== */
/* Tableau de bord                                                     */
/* ================================================================== */

const libelleMois = (ym) => `${MOIS_NOMS[Number(ym.split('-')[1]) - 1]} ${ym.split('-')[0]}`;

async function chargerBilan() {
  const s = await api('/api/stats?' + qs(filtresCourants()));

  $('#k-entrees').textContent = argent(s.entrees);
  $('#k-sorties').textContent = argent(s.sorties);
  $('#k-invest').textContent = argent(s.investissements);
  $('#k-resultat').textContent = argent(s.resultat);
  $('#k-entrees-n').textContent = `${s.nb_entrees} opération(s)`;
  $('#k-sorties-n').textContent = `${s.nb_sorties} opération(s)`;
  $('#k-invest-n').textContent = `${s.nb_investissements} opération(s)`;
  $('#k-marge').textContent = s.taux_marge === null ? 'Marge : —' : `Marge : ${s.taux_marge} %`;

  const max = Math.max(1, ...s.par_categorie.map((c) => Math.abs(c.total)));
  $('#barres-categories').innerHTML = s.par_categorie.map((c) => `
    <div class="barre-ligne">
      <div class="barre-tete">
        <span>${echapper(c.nom)} <span class="etiquette ${c.type}">${NATURES[c.type].label}</span></span>
        <span class="mont ${NATURES[c.type].classe}">${argent(c.total)}</span>
      </div>
      <div class="barre-piste"><div class="barre-part ${c.type}" style="width:${(Math.abs(c.total) / max) * 100}%"></div></div>
      <div class="barre-meta">${c.nb} opération(s)</div>
    </div>`).join('');

  $('#tbody-mois').innerHTML = s.par_mois.map((m) => `
    <tr>
      <td>${libelleMois(m.mois)}</td>
      <td class="num entree-txt">${argent(m.entrees)}</td>
      <td class="num sortie-txt">${argent(m.sorties)}</td>
      <td class="num invest-txt">${argent(m.investissements)}</td>
      <td class="num" style="font-weight:700;color:${m.resultat >= 0 ? 'var(--vert)' : 'var(--rouge)'}">${argent(m.resultat)}</td>
    </tr>`).join('');

  $('#encadre-bilan').innerHTML = `
    <p><b>Résultat d'exploitation</b> = ${argent(s.entrees)} (entrées) − ${argent(s.sorties)} (sorties courantes) =
       <b class="${s.resultat >= 0 ? 'entree-txt' : 'sortie-txt'}">${argent(s.resultat)}</b></p>
    <p><b>Trésorerie nette de la période</b> = résultat − ${argent(s.investissements)} (investissements) =
       <b class="${s.tresorerie_nette >= 0 ? 'entree-txt' : 'sortie-txt'}">${argent(s.tresorerie_nette)}</b></p>
    <p><b>Valeur totale des biens durables</b> acquis sur la période : <b class="invest-txt">${argent(s.valeur_investissements)}</b></p>
    <p class="aide">Les investissements (bâche, balance, véhicule, glacière…) ne sont pas des dépenses :
       ils restent au patrimoine. Ne les comptez pas parmi les sorties si vous voulez connaître le résultat réel de votre activité.</p>`;
}

/* ================================================================== */
/* Vue categories                                                      */
/* ================================================================== */

async function chargerCategoriesVue() {
  const compte = {};
  (await api('/api/stats')).par_categorie.forEach((c) => (compte[c.id] = c.nb));
  $('#tbody-cats').innerHTML = categories.map((c) => `
    <tr data-id="${c.id}">
      <td><strong>${echapper(c.nom)}</strong></td>
      <td><span class="etiquette ${c.type}">${NATURES[c.type].label}</span></td>
      <td class="detail-txt">${echapper(c.unite || '—')}</td>
      <td class="num">${compte[c.id] || 0}</td>
      <td class="actions">
        <a class="lien link-accent" data-act="edit">Modifier</a>
        <a class="lien link-danger" data-act="del">Supprimer</a>
      </td>
    </tr>`).join('');
}

$('#tbody-cats').addEventListener('click', async (e) => {
  const lien = e.target.closest('a[data-act]');
  if (!lien) return;
  const id = Number(lien.closest('tr').dataset.id);
  const cat = catParId(id);
  if (!cat) return;

  if (lien.dataset.act === 'edit') {
    $('#cat-id').value = cat.id;
    $('#cat-nom').value = cat.nom;
    $('#cat-unite').value = cat.unite || '';
    $(`input[name="type-cat"][value="${cat.type}"]`).checked = true;
    $('#titre-cat').textContent = `Modifier — ${cat.nom}`;
  } else {
    if (!confirm(`Supprimer la catégorie « ${cat.nom} » ?`)) return;
    try {
      await api('/api/categories/' + id, { method: 'DELETE' });
      toast('Catégorie supprimée.');
      await chargerCategories();
      await chargerCategoriesVue();
    } catch (err) { toast(err.message, 'erreur'); }
  }
});

$('#form-cat').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#cat-id').value;
  const corps = {
    nom: $('#cat-nom').value,
    type: $('input[name="type-cat"]:checked').value,
    unite: $('#cat-unite').value || null,
  };
  try {
    if (id) await api('/api/categories/' + id, { method: 'PUT', body: JSON.stringify(corps) });
    else await api('/api/categories', { method: 'POST', body: JSON.stringify(corps) });
    toast(id ? 'Catégorie mise à jour.' : 'Catégorie ajoutée.');
    $('#form-cat').reset();
    $('#cat-id').value = '';
    $('#titre-cat').textContent = 'Nouvelle catégorie';
    await chargerCategories();
    await chargerCategoriesVue();
  } catch (err) { toast(err.message, 'erreur'); }
});

$('#btn-cat-annuler').addEventListener('click', () => {
  $('#form-cat').reset();
  $('#cat-id').value = '';
  $('#titre-cat').textContent = 'Nouvelle catégorie';
});

/* ================================================================== */
/* Vue utilisateurs                                                    */
/* ================================================================== */

async function chargerUtilisateurs() {
  const liste = await api('/api/utilisateurs');
  $('#tbody-users').innerHTML = liste.map((u) => `
    <tr data-id="${u.id}">
      <td><strong>${echapper(u.nom)}</strong>${u.id === utilisateur.id ? ' <span class="detail-txt">(vous)</span>' : ''}</td>
      <td class="${u.role === 'admin' ? 'entree-txt' : ''}">${u.role === 'admin' ? 'Administrateur' : 'Saisie'}</td>
      <td>${u.actif ? '<span class="etiquette entree">Actif</span>' : '<span class="etiquette sortie">Désactivé</span>'}</td>
      <td class="detail-txt">${echapper((u.cree_le || '').slice(0, 10))}</td>
      <td class="actions">
        <a class="lien link-accent" data-act="edit">Modifier</a>
        ${u.id === utilisateur.id ? '' : '<a class="lien link-danger" data-act="del">Supprimer</a>'}
      </td>
    </tr>`).join('');
}

$('#tbody-users').addEventListener('click', async (e) => {
  const lien = e.target.closest('a[data-act]');
  if (!lien) return;
  const id = Number(lien.closest('tr').dataset.id);
  const liste = await api('/api/utilisateurs');
  const u = liste.find((x) => x.id === id);
  if (!u) return;

  if (lien.dataset.act === 'edit') {
    $('#user-id').value = u.id;
    $('#user-nom').value = u.nom;
    $('#user-mdp').value = '';
    $('#user-role').value = u.role;
    $('#user-actif').checked = !!u.actif;
    $('#bloc-user-actif').classList.remove('cache');
    $('#titre-user').textContent = `Modifier — ${u.nom}`;
  } else {
    if (!confirm(`Supprimer le compte « ${u.nom} » ?\nIl sera immédiatement déconnecté.`)) return;
    try {
      await api('/api/utilisateurs/' + id, { method: 'DELETE' });
      toast('Utilisateur supprimé.');
      await chargerUtilisateurs();
    } catch (err) { toast(err.message, 'erreur'); }
  }
});

$('#form-user').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#user-id').value;
  const corps = {
    nom: $('#user-nom').value.trim(),
    role: $('#user-role').value,
    actif: $('#user-actif').checked,
  };
  const mdp = $('#user-mdp').value;
  if (mdp) corps.mot_de_passe = mdp;
  if (!id && !mdp) return toast('Choisissez un mot de passe (8 caractères minimum).', 'erreur');

  try {
    if (id) await api('/api/utilisateurs/' + id, { method: 'PUT', body: JSON.stringify(corps) });
    else await api('/api/utilisateurs', { method: 'POST', body: JSON.stringify(corps) });
    toast(id ? 'Utilisateur mis à jour.' : 'Utilisateur créé.');
    $('#form-user').reset();
    $('#user-id').value = '';
    $('#user-mdp').value = '';
    $('#user-actif').checked = true;
    $('#titre-user').textContent = 'Nouvel utilisateur';
    if (!id) $('#user-mdp').setAttribute('required', 'required');
    await chargerUtilisateurs();
  } catch (err) { toast(err.message, 'erreur'); }
});

$('#btn-user-annuler').addEventListener('click', () => {
  $('#form-user').reset();
  $('#user-id').value = '';
  $('#user-mdp').value = '';
  $('#user-actif').checked = true;
  $('#titre-user').textContent = 'Nouvel utilisateur';
});

/* ================================================================== */
/* Demarrage                                                           */
/* ================================================================== */

(async function init() {
  const d = new Date();
  $('#f-debut').value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  $('#f-fin').value = dateDuJour();
  vueCourante = 'connexion';

  try {
    const s = await api('/api/session');
    if (s.connecte) {
      utilisateur = s.utilisateur;
      csrf = s.csrf;
      await demarrerApplication();
    } else {
      afficherConnexion();
    }
  } catch (err) {
    afficherConnexion();
    toast('Serveur injoignable : ' + err.message, 'erreur');
  }
})();
