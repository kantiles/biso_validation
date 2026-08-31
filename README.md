# Widget Grist — Validation BISO

Widget custom Grist (HTML/CSS/JS statique, sans build) pour valider des indicateurs :
sélection d'une feuille (table) du document, filtrage sur `id_indicateur`, affichage
des 10 premières lignes correspondantes, saisie de `validation` (Oui/Non) et
`commentaires` écrite directement dans le document Grist.

## Fichiers

- `index.html` — structure de la page
- `style.css` — mise en forme
- `grist-plugin-api.js` — copie locale du script client Grist (voir "Instance Grist ciblée" ci-dessous)
- `app.js` — point d'entrée (câblage des événements, initialisation), importe les modules ES `js/*.js` :
  - `js/dom.js` — références DOM et affichage du statut
  - `js/utils.js` — petites fonctions pures partagées
  - `js/grist-api.js` — backend SQL local (DuckDB-Wasm) pour les requêtes sur `data_validation`
  - `js/table-render.js` — rendu générique d'un tableau avec cellules éditables
  - `js/main-table.js` — table `main_validation` (indicateurs, compteurs)
  - `js/stats-chart.js` — table `data_validation` (année, statistiques, graphique)

## Déploiement sur GitHub Pages

1. Pousser ce dépôt sur GitHub.
2. Dans les paramètres du dépôt → **Pages**, choisir la branche `main` et le
   dossier racine (`/`).
3. Récupérer l'URL publiée, du type
   `https://<utilisateur>.github.io/<depot>/index.html`.

## Instance Grist ciblée

Le script `grist-plugin-api.js` est servi en local (copie du fichier téléchargé
depuis `https://grist.numerique.gouv.fr/grist-plugin-api.js`, committée à la
racine du dépôt) plutôt que chargé directement depuis cette URL. Ce choix
contourne un problème de protection anti-bot (Incapsula/Imperva) sur
`grist.numerique.gouv.fr` : le premier appel au script renvoie une redirection
307 accompagnée d'un cookie, et ce cookie n'est pas correctement renvoyé lors du
rechargement quand le script est chargé depuis l'iframe (sandboxée, origine
GitHub Pages) dans laquelle Grist exécute le widget — ce qui produit une boucle
de redirections infinie (`ERR_TOO_MANY_REDIRECTS`) et empêche le script de se
charger.

Le fichier lui-même ne code en dur aucune origine (ses appels `postMessage`
utilisent `"*"` ou l'origine de l'expéditeur), donc le servir depuis un autre
domaine que celui de l'instance Grist ne casse rien à l'exécution.

En revanche cette copie ne se met pas à jour automatiquement : si l'instance
Grist (`https://grist.numerique.gouv.fr`) est un jour mise à niveau et que le
protocole du plugin API change, il faudra retélécharger
`https://grist.numerique.gouv.fr/grist-plugin-api.js` et remplacer le fichier
local (une erreur `Unknown forward destination: grist` à l'initialisation est
un signe possible de désynchronisation entre les deux). Si le document est un
jour hébergé sur une autre instance Grist, il faudra aussi retélécharger le
script depuis la nouvelle instance.

## Statistiques sur `data_validation` (DuckDB-Wasm)

`data_validation` peut contenir plusieurs centaines de milliers de lignes — trop
pour recalculer des statistiques de distribution (déciles, quartiles, écart-type…)
à la main en JS à chaque changement de filtre. Le widget appelait auparavant
l'API REST SQL de Grist (`POST /api/docs/:docId/sql`) pour déléguer ce calcul au
serveur, mais cet appel est une requête HTTP cross-origin directement depuis le
widget vers `grist.numerique.gouv.fr`, qui se heurte à la même protection
anti-bot (Incapsula/Imperva) que `grist-plugin-api.js` (redirections 307 en
boucle → `Failed to fetch`) — voir la section précédente.

À la place : `js/stats-chart.js` rapatrie `data_validation` en une fois via
`grist.docApi.fetchTable()` (RPC `postMessage` entre le widget et la page Grist
parente — jamais de requête réseau directe, donc insensible au WAF), puis
`js/grist-api.js` charge ces lignes dans une base [DuckDB](https://duckdb.org/)
en mémoire, dans le navigateur (via [DuckDB-Wasm](https://duckdb.org/docs/api/wasm/overview),
chargé depuis jsDelivr). Toutes les requêtes SQL (statistiques par `niv_geo`,
quantiles, graphique par département) tournent ensuite localement contre cette
base — plus aucun appel réseau vers Grist une fois la table chargée. DuckDB
diffère de SQLite sur quelques points dont le SQL de `stats-chart.js` tient
compte : identifiants non quotés repliés en minuscules (d'où les alias
`"naCount"`/`"meanSq"` explicitement quotés), `CAST` strict plutôt que permissif
(`TRY_CAST` utilisé à la place), et `MAX(a, b)` scalaire absent (remplacé par
`GREATEST(a, b)`).

## Bibliothèques externes

Chargées via import ES depuis jsDelivr (pas de build, pas de `node_modules`) :

- [`@duckdb/duckdb-wasm`](https://duckdb.org/docs/api/wasm/overview) + [`apache-arrow`](https://arrow.apache.org/docs/js/) — voir "Statistiques sur `data_validation`" ci-dessus.
- [`@observablehq/plot`](https://observablehq.com/plot/) — dessine le graphique en barres par département (`renderDepartmentBars` dans `js/stats-chart.js`), plutôt que du HTML/CSS fait main.

Ces deux imports pointent vers une version précise (ex. `@observablehq/plot@0.6.17/+esm`)
plutôt qu'une plage — à mettre à jour manuellement si besoin, `+esm` n'étant qu'un
mode de livraison (bundle ES module), pas un mécanisme de versioning.

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
sur GitHub Pages (utile par exemple après un changement qui semble ne pas
s'appliquer). **À incrémenter de 1 à chaque modification** d'un des fichiers du
widget (`app.js`, `js/*.js`, `index.html`, `style.css`).

## Test local (hors Grist)

```bash
python3 -m http.server
```

Puis ouvrir `http://localhost:8000`. Hors du contexte Grist, le widget affiche
un message indiquant qu'il doit être ouvert en tant que Custom Widget.
