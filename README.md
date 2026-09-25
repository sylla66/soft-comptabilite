# 🐟 Comptabilité — Vente de poisson

Gestion des **entrées**, **sorties** et **investissements** d'un commerce de vente de poisson.
Aucune dépendance à installer, aucun compte cloud, aucune clé d'API.

---

## Démarrage local

```bash
node server.js
```

Puis ouvrez **http://127.0.0.1:3000**.

Au **premier lancement**, un compte administrateur est créé et son mot de passe s'affiche
dans la fenêtre du serveur. Notez-le, puis changez-le depuis l'onglet **Utilisateurs**.

Pour arrêter : `Ctrl + C`

---

## Les trois natures d'opération

C'est le point le plus important pour avoir un résultat juste.

| Nature | Signification | Compté dans |
|--------|---------------|-------------|
| **Entrée** | Argent reçu (vente détail, vente gros) | Résultat |
| **Sortie** | Dépense courante (glace, transport, salaires, emballage) | Résultat |
| **Investissement** | Bien durable (bâche, balance, véhicule, glacière) | **Pas** dans le résultat |

**Pourquoi ?** Une bâche à 450 € n'est pas consommée : elle vous sert pendant des années.
Si vous la comptez en sortie, votre bénéfice paraît plus faible qu'il ne l'est réellement.
L'application la sort donc du résultat et affiche à part :

- **Résultat d'exploitation** = entrées − sorties courantes *(le vrai bénéfice de votre activité)*
- **Trésorerie nette** = résultat − investissements *(l'argent réellement dépensé sur la période)*
- **Valeur des biens durables** = total de vos investissements *(ce que vous avez investi)*

> ⚠️ Un investissement n'est pas non plus « gratuit » : il se déprécie. Cette application ne
> calcule pas l'amortissement. Si vous avez besoin d'amortissements lineaires pour la
> déclaration fiscale, c'est une fonctionnalité à ajouter.

### Catégories incluses

| Nature | Catégories |
|--------|-----------|
| **Entrées** | Vente détail, Vente gros |
| **Sorties** | Achat poisson, Glace / conservation, Transport, Emballage, Location étal, Salaires |
| **Investissement** | Investissement (à personnaliser : bâches, balances, matériel…) |

Créez vos propres catégories dans l'onglet **Catégories** — choisissez bien la nature.

---

## Deux modes de saisie

- **Quantité × prix unitaire** — le total se calcule seul (ex : 25,5 kg × 6,50 € = 165,75 €)
- **Montant direct** — pour une dépense ou une vente au forfait

---

## Utilisateurs et rôles

Un administrateur crée les comptes depuis l'onglet **Utilisateurs**.

| Action | Administrateur | Saisie |
|--------|:--------------:|:------:|
| Voir le journal, les statistiques, exporter | ✅ | ✅ |
| Ajouter / modifier une opération | ✅ | ✅ |
| **Supprimer** une opération | ✅ | ❌ |
| Créer / modifier / supprimer une catégorie | ✅ | ❌ |
| Gérer les utilisateurs | ✅ | ❌ |
| Sauvegarde complète | ✅ | ❌ |

---

## Sécurité en place

| Mesure | Détail |
|--------|--------|
| Mots de passe | Hachés avec **scrypt** (sel aléatoire, 16 Mio de mémoire), jamais en clair — même pas dans la base |
| Sessions | Jeton aléatoire de 32 octets ; **seul son empreinte SHA-256** est stockée en base |
| Cookies | `HttpOnly` + `SameSite=Strict` + `Secure` (uniquement quand la requête arrive en HTTPS, donc automatiquement sur l'URL Fly.io) + expiration 7 jours |
| Premier accès | Le compte d'amorçage est forcé de changer son mot de passe avant d'accéder au journal |
| CSRF | Jeton par session exigé sur **toutes** les écritures, comparé en temps constant |
| Anti-force | 8 échecs par IP sur 15 minutes, puis blocage (code 429) |
| En-têtes | CSP, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, HSTS, `Permissions-Policy` |
| API | Toutes les routes exigent une session ; les routes d'écriture exigent le rôle `admin` |
| Fuite d'information | Message d'erreur identique que le compte existe ou non |
| Injection | Tout passe par des requêtes SQL préparées (paramétrées) |
| Exécution | Conteneur non-root, `node:22-alpine` |

---

## 📤 Déploiement

### 1. Sur GitHub (le code seul)

```bash
cd comptabilite-poisson
git init
git add .
git commit -m "Comptabilite vente de poisson"
git branch -M main
git remote add origin https://github.com/VOTRE-PSEUDO/comptabilite-poisson.git
git push -u origin main
```

Le `.gitignore` est déjà en place : **la base et les secrets ne peuvent pas être publiés.**
Vérifiez toujours avec `git status` avant de pousser.

### 2. Sur un hébergeur gratuit à disque persistant

Render, Railway et Heroku **effacent le disque à chaque redéploiement** : n'utilisez pas la
base SQLite locale chez eux, vos données seraient perdues. Utilisez **Fly.io** (volume
persistant inclus dans l'offre gratuite) ou un VPS gratuit type Oracle Cloud.

#### Fly.io (recommandé)

```bash
# 1. Installer l'outil
npm i -g flyctl

# 2. Se connecter (ouvre le navigateur)
fly auth login

# 3. Créer l'application (indispensable AVANT le volume)
fly launch --no-deploy --copy-config --name comptabilite-poisson

# 4. Créer le volume persistant (UNE SEULE FOIS — il contient vos données)
fly volumes create compta_data --size 1 --region cdg

# 5. Définir un mot de passe administrateur provisoire (secret chiffré, hors dépôt)
fly secrets set ADMIN_USER='patron'
fly secrets set ADMIN_PASSWORD='UnMotDePasseLongEtUniqueAChange2026'

# 6. Déployer
fly deploy

# 7. Ouvrir l'application
fly open
```

L'URL obtenue est en HTTPS, donc le cookie `Secure` s'active automatiquement.

> ⚠️ Ne mettez **jamais** `ADMIN_PASSWORD` dans `fly.toml` ou un fichier versionné.
> Utilisez toujours `fly secrets set`.

#### Première connexion : changez le mot de passe

Le mot de passe de l'étape 5 n'est qu'un **secret d'amorçage**. À la première
connexion, l'application affiche un écran bloquant qui oblige à choisir un mot de
passe personnel (10 caractères minimum, avec une lettre et un chiffre). Tant que
ce n'est pas fait, l'interface refuse d'ouvrir le journal.

Toutes les sessions ouvertes sont alors invalidées, et il faut se reconnecter.

Dès que le nouveau mot de passe est enregistré, **supprimez le secret** : il ne sert
plus à rien et il resterait lisible par quiconque a accès à votre compte Fly.io.

```bash
fly secrets unset ADMIN_PASSWORD
```

> Notez bien votre nouveau mot de passe : il n'est stocké que sous forme de hash.
> Ni l'application ni l'hébergeur ne peuvent vous le rappeler.

---

## Sauvegarde

Vos données tiennent dans un seul fichier. **Sauvegardez-le régulièrement** (clé USB,
Google Drive, un autre disque) : un hébergeur gratuit peut disparaître du jour au lendemain,
et c'est vous le seul à avoir une copie de vos chiffres.

```bash
# Copie de sécurité à froid (serveur arrêté)
copy data\compta.db votre-sauvegarde\compta-2026-09-25.db
```

Sur Fly.io : `fly ssh console -C "cat /data/compta.db" > compta-2026-09-25.db`

**Restauration** : arrêtez l'application, remplacez `data/compta.db` par votre sauvegarde,
relancez. Supprimez aussi les fichiers `compta.db-wal` et `compta.db-shm` s'ils existent.

---

## Configuration

| Variable | Défaut | Rôle |
|----------|--------|------|
| `NODE_ENV` | — | `production` active `Secure` + HSTS + écoute sur `0.0.0.0` |
| `PORT` | `3000` | port d'écoute |
| `HOST` | `127.0.0.1` (dev) / `0.0.0.0` (prod) | interface réseau |
| `ADMIN_USER` | `admin` | identifiant du premier compte (1er lancement, base vide) |
| `ADMIN_PASSWORD` | — | si fourni, définit le 1er mot de passe ; sinon il est généré et affiché |
| `DATA_DIR` | `./data` | dossier de la base |
| `COMPA_DB` | `./data/compta.db` | chemin exact du fichier SQLite |

---

## API

Toutes les routes sauf `/api/sante` et `/api/connexion` exigent un cookie de session valide.
Les écritures exigent en plus l'en-tête `X-CSRF-Token`.

| Méthode | Route | Accès |
|---------|-------|-------|
| GET | `/api/sante` | public (sonde de supervision) |
| POST | `/api/connexion` · `/api/deconnexion` | public |
| GET | `/api/session` | public |
| GET/POST | `/api/categories` | lecture : tous · écriture : admin |
| PUT/DELETE | `/api/categories/:id` | admin |
| GET/POST | `/api/operations` | tous |
| PUT | `/api/operations/:id` | tous |
| DELETE | `/api/operations/:id` | **admin** |
| GET | `/api/stats` · `/api/export.csv` | tous |
| GET/POST | `/api/utilisateurs` | admin |
| PUT/DELETE | `/api/utilisateurs/:id` | admin |
| GET | `/api/sauvegarde` | admin |

Filtres acceptés : `debut`, `fin`, `type` (`entree`\|`sortie`\|`investissement`),
`categorie_id`, `texte`, `ordre` (`asc`\|`desc`).

---

## Structure

```
comptabilite-poisson/
├── server.js          serveur HTTP, routage, en-têtes de sécurité
├── auth.js            sessions, cookies, CSRF, limitation des tentatives
├── db.js              schéma SQLite, calculs, scrypt, export
├── public/            interface (connexion, journal, bilan, catégories, utilisateurs)
├── data/              compta.db  ← VOS DONNÉES, jamais versionnées
├── Dockerfile         image de production (utilisateur non-root)
├── fly.toml           configuration Fly.io (volume persistant)
├── Procfile           pour Render / Railway
├── .env.example       modèle de variables d'environnement
└── .gitignore         bloque data/ et .env
```
