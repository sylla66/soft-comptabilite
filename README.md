# 🐟 Comptabilité — Vente de poisson

Gestion des **entrées**, **sorties** et **investissements** d'un commerce de vente de poisson.
Hébergée sur **Render**, base de données sur **Neon PostgreSQL**.

---

## Démarrage local

Il faut un PostgreSQL. Le plus rapide est un conteneur Docker :

```bash
docker run -d --name compta-pg -p 5433:5432 ^
  -e POSTGRES_USER=compta -e POSTGRES_PASSWORD=secret_test -e POSTGRES_DB=compta_test ^
  postgres:16-alpine
```

Puis, dans le dossier du projet :

```bash
npm install
set DATABASE_URL=postgresql://compta:secret_test@127.0.0.1:5433/compta_test
npm start
```

Ouvrez **http://127.0.0.1:3000**. Le schéma et les catégories par défaut sont créés
automatiquement au démarrage.

Pour arrêter : `Ctrl + C`

### Créer des comptes de test

```bash
set SEED_ADMIN_NOM=admin
set SEED_ADMIN_MDP=VotreMotDePasse1
set SEED_SAISIE_NOM=saisie
set SEED_SAISIE_MDP=AutreMotDePasse2
npm run seed
```

Les identifiants sont affichés une seule fois. Un compte déjà présent n'est jamais
écrasé : relancer le script est sans risque.

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
> calcule pas l'amortissement. Si vous avez besoin d'amortissements linéaires pour la
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
| Cookies | `HttpOnly` + `SameSite=Strict` + `Secure` (automatiquement sur l'URL HTTPS de Render) + expiration 7 jours |
| Premier accès | Le compte d'amorçage est forcé de changer son mot de passe avant d'accéder au journal |
| CSRF | Jeton par session exigé sur **toutes** les écritures, comparé en temps constant |
| Anti-force | 8 échecs par IP sur 15 minutes, puis blocage (code 429) |
| En-têtes | CSP, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, HSTS, `Permissions-Policy` |
| API | Toutes les routes exigent une session ; les routes d'écriture exigent le rôle `admin` |
| Fuite d'information | Message d'erreur identique que le compte existe ou non, et temps de hachage constant |
| Injection | Tout passe par des requêtes SQL préparées (paramétrées) |
| Exécution | Conteneur non-root, `node:24-alpine` |

---

## 📤 Déploiement sur Render + Neon

### 1. La base sur Neon

1. Créez un compte sur [neon.tech](https://neon.tech) et un projet PostgreSQL.
2. Dans **Connection Details**, copiez la chaîne de connexion **pooled**
   (elle contient `?sslmode=require`). C'est celle qu'il faut : elle passe par un
   proxy prévu pour les applications serverless, alors que la chaîne *directe*
   est faite pour un poste ou un serveur traditionnel.

Le schéma et les catégories sont créés automatiquement au premier démarrage de
l'application : il n'y a rien à importer.

### 2. Le service sur Render

Le dépôt contient un `render.yaml` : Render peut créer le service tout seul.

1. Poussez le code sur GitHub.
2. Dans Render : **New → Blueprint**, choisissez le dépôt. Render lit `render.yaml`.
3. Render vous demandera **`DATABASE_URL`** : collez-y la chaîne Neon de l'étape 1.
4. Render génère un `ADMIN_PASSWORD` (`generateValue: true`). **Notez-le**, il ne
   sera plus affiché ensuite.
5. Déployez. Au premier démarrage, le compte administrateur est créé avec ce mot
   de passe, et l'application affiche son adresse.

### 3. Première connexion : changez le mot de passe

Le mot de passe généré par Render n'est qu'un **secret d'amorçage**. À la première
connexion, l'application affiche un écran bloquant qui oblige à choisir un mot de
passe personnel (10 caractères minimum, avec une lettre et un chiffre). Tant que
ce n'est pas fait, l'interface refuse d'ouvrir le journal.

Toutes les sessions ouvertes sont alors invalidées, et il faut se reconnecter.

Dès que le nouveau mot de passe est enregistré, **retirez `ADMIN_PASSWORD`** :
Render → *Environment* → *Remove ADMIN_PASSWORD*. Le compte s'authentifie
désormais par sa base ; le secret ne sert plus à rien et resterait lisible par
quiconque a accès à votre compte Render.

> Notez bien votre nouveau mot de passe : il n'est stocké que sous forme de hash.
> Ni l'application ni Neon ne peuvent vous le rappeler.

### Option : créer des comptes de test

Sur le poste où vous travaillez, avec la même `DATABASE_URL` que celle de Render :

```bash
set DATABASE_URL=<la chaîne Neon>
set SEED_ADMIN_NOM=admin
set SEED_ADMIN_MDP=VotreMotDePasse1
set SEED_SAISIE_NOM=saisie
set SEED_SAISIE_MDP=AutreMotDePasse2
npm run seed
```

### À savoir sur l'offre gratuite

- Le service Render se met en veille après quelques minutes d'inactivité : la
  première requête suivante peut prendre quelques secondes. La base, elle, reste
  bien en place — c'est tout l'intérêt d'avoir externalisé le stockage.
- L'offre gratuite de Neon a des limites d'usage (stockage et heures de calcul).
  Pour un commerce, c'est largement suffisant.

---

## Sauvegarde

Vos données sont dans PostgreSQL, chez Neon. C'est plus robuste qu'un fichier
local, mais **ça ne dispense pas de sauvegarder** : un compte peut être résilié
par erreur, ou un `Reset` peut être cliqué par mégarde.

- **Neon** : *Branching* permet de dupliquer la base à un instant donné ; c'est
  aussi le moyen de tester une migration. Sinon, l'onglet **Backup & Restore**
  propose des restauration à chaud sur les offre payantes.
- **Depuis l'application** : *Utilisateurs → Sauvegarde complète* (administrateur)
  télécharge un JSON contenant les catégories et toutes les opérations. C'est la
  sauvegarde à faire régulièrement, sur une clé USB ou Google Drive.
- **Export** : *Journal → Exporter CSV* pour une lecture dans Excel.

---

## Configuration

| Variable | Défaut | Rôle |
|----------|--------|------|
| `DATABASE_URL` | — | **obligatoire** — chaîne de connexion PostgreSQL (Neon) |
| `NODE_ENV` | — | `production` active `Secure` + HSTS + écoute sur `0.0.0.0` |
| `PORT` | `3000` | port d'écoute (Render le fournit) |
| `HOST` | `127.0.0.1` (dev) / `0.0.0.0` (prod) | interface réseau |
| `ADMIN_USER` | `admin` | identifiant du premier compte (1er lancement, base vide) |
| `ADMIN_PASSWORD` | — | si fourni, définit le 1er mot de passe ; sinon il est généré et affiché |
| `PGPOOL_MAX` | `5` | connexions simultanées dans le pool |
| `SEED_ADMIN_NOM` / `SEED_ADMIN_MDP` | — | compte de test créé par `npm run seed` |
| `SEED_SAISIE_NOM` / `SEED_SAISIE_MDP` | — | compte de saisie créé par `npm run seed` |

Le pool de 5 connexions est volontairement modeste : une base Neon gratuite
limite le nombre de connexions simultanées, et l'application en a peu besoin.

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
soft-comptabilite/
├── server.js          serveur HTTP, routage, en-têtes de sécurité
├── auth.js            sessions, cookies, CSRF, limitation des tentatives
├── db.js              schéma PostgreSQL, requêtes, calculs, scrypt, export
├── seed.js            création des comptes de test
├── public/            interface (connexion, journal, bilan, catégories, utilisateurs)
├── render.yaml        configuration Render
├── Dockerfile         image de production (utilisateur non-root)
├── Procfile           pour Render / Railway
├── .env.example       modèle de variables d'environnement
└── .gitignore         bloque .env et node_modules
```

`db.js` contient tout l'accès aux données : le reste de l'application ne fait
jamais de SQL lui-même. Toutes les fonctions sont asynchrones, puisqu'une
requête PostgreSQL demande un aller-retour réseau.
