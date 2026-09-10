# Widget Grist — Validation BISO

Widget custom Grist (HTML/CSS/JS statique, sans build) pour valider des indicateurs :
sélection d'une feuille (table) du document, filtrage sur `id_indicateur`, affichage
des 10 premières lignes correspondantes, saisie de `validation` (Oui/Non) et
`commentaires` écrite directement dans le document Grist.

## Fichiers

- `index.html` — structure de la page
- `style.css` — mise en forme
- `app.js` — point d'entrée (câblage des événements, initialisation), importe les modules ES `js/*.js` :
  - `js/dom.js` — références DOM et affichage du statut
  - `js/utils.js` — petites fonctions pures partagées
  - `js/table-render.js` — rendu générique d'un tableau avec cellules éditables
  - `js/main-table.js` — table `main_validation` (indicateurs, compteurs)
  - `js/stats-chart.js` — table `data_validation` (chargement, année, statistiques, graphique)

## Déploiement sur GitHub Pages

1. Pousser ce dépôt sur GitHub.
2. Dans les paramètres du dépôt → **Pages**, choisir la branche `main` et le
   dossier racine (`/`).
3. Récupérer l'URL publiée, du type
   `https://<utilisateur>.github.io/<depot>/index.html`.

## Instance Grist ciblée

`index.html` charge une copie locale committée du script client Grist
(`grist-plugin-api.js`) plutôt que l'URL de l'instance ciblée
(`<instance>/grist-plugin-api.js`), gardée en commentaire pour référence.
Le script client étant générique (pas spécifique à un document ni à une
instance), cette même copie fonctionne aussi bien contre l'instance Docker
locale que contre `grist.numerique.gouv.fr`.

⚠️ Sur `grist.numerique.gouv.fr`, charger le script directement depuis l'URL
de l'instance peut se heurter à une protection anti-bot (Incapsula/Imperva) :
redirections 307 en boucle (`ERR_TOO_MANY_REDIRECTS`) empêchant le script de
se charger — d'où la copie locale committée par défaut plutôt que l'URL de
l'instance.

## Statistiques sur `data_validation`

`data_validation` provient d'un CSV source d'une vingtaine de Mo — assez pour
être rapatrié entièrement dans le navigateur en un seul `fetchTable` (voir
`ensureBottomTableLoaded` dans `js/stats-chart.js`), mis en cache, puis utilisé
pour tous les calculs de distribution (déciles, quartiles, écart-type…),
tableaux géo et badges, faits en JS à chaque changement de filtre.

⚠️ L'API REST SQL de Grist (`POST /api/docs/:docId/sql`) n'est pas utilisable
ici : contrairement à `fetchTable`/`listTables` (canal RPC `postMessage` entre
le widget et Grist), elle nécessite un `fetch()` HTTP direct cross-origin vers
`grist.numerique.gouv.fr`, et le WAF de cette instance bloque ces requêtes
(erreur CORS côté navigateur, faute d'en-têtes CORS dans la réponse du WAF),
a priori en détectant des mots-clés SQL dans le payload. À reconsidérer si
`data_validation` grossit significativement (le `fetchTable` deviendrait alors
trop lourd).

## Installation dans Grist

1. Dans le document Grist, ajouter un nouveau widget → **Custom** (Widget URL personnalisée).
2. Coller l'URL GitHub Pages de `index.html`.
3. Lorsque Grist demande le niveau d'accès, choisir **Full document access**
   (nécessaire pour lister les tables du document et écrire dans des tables
   autres que celle liée par défaut au widget).
4. Le sélecteur de feuille propose par défaut `base biso doc` si elle existe
   dans le document ; sinon, choisir la table voulue dans la liste.

## Prérequis sur les tables

Pour que la validation et les commentaires fonctionnent sur une feuille donnée,
celle-ci doit contenir des colonnes nommées (insensible à la casse) :

- `id_indicateur` — utilisée pour le filtre
- `validation` — recevra `Oui` / `Non`
- `commentaires` — texte libre

Si une de ces colonnes est absente sur la feuille sélectionnée, le widget
affiche un avertissement et désactive la fonctionnalité correspondante (il ne
crée jamais de colonne automatiquement).

## Numéro de version

Le coin supérieur droit du widget affiche `vN` (constante `APP_VERSION` en haut de
`app.js`). Comme il n'y a ni build ni cache-busting, c'est le seul moyen simple
de vérifier depuis Grist que la version chargée est bien la dernière déployée
sur GitHub Pages. **À incrémenter de 1 à chaque modification** d'un des
fichiers du widget (`app.js`, `js/*.js`, `index.html`, `style.css`).

## Test local (avec Grist, Docker)

⚠️ Les tests locaux se font avec `docker-compose.yml`, pas en ouvrant
`index.html` directement — le widget a besoin d'être chargé en iframe par un
vrai Grist (RPC `postMessage`, `docApi`, etc.), ce qu'un simple serveur de
fichiers statiques ne peut pas simuler.

```bash
docker compose up --build
```

Démarre une instance Grist locale (`http://localhost:8484`) et sert ce dépôt
en statique à sa place de GitHub Pages (`http://localhost:8585`, rechargement
à chaud via bind-mount — voir `docker-compose.yml`). Dans Grist, créer/ouvrir
un document avec les tables `main_validation` et `data_validation`, ajouter le
widget comme Custom Widget (voir "Installation dans Grist" ci-dessus) en
collant `http://localhost:8585/index.html` comme URL.

## Test local (hors Grist)

```bash
python3 -m http.server
```

Puis ouvrir `http://localhost:8000`. Hors du contexte Grist, le widget affiche
seulement un message indiquant qu'il doit être ouvert en tant que Custom
Widget — utile pour vérifier que les fichiers statiques se servent
correctement, pas pour tester le widget lui-même (voir section Docker
ci-dessus pour ça).
</content>
