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
  - `js/grist-api.js` — accès à l'API Grist (jeton, SQL, schéma)
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

`index.html` charge le script client Grist directement depuis l'instance ciblée
(`<instance>/grist-plugin-api.js`) plutôt qu'une copie locale committée. En
développement, ça pointe vers l'instance Docker locale
(`http://localhost:8484/grist-plugin-api.js`, voir `docker-compose.yml`) ; en
production il faut remplacer cette URL par celle de l'instance Grist réelle
(ex. `https://grist.numerique.gouv.fr/grist-plugin-api.js`) avant déploiement.

Sur `grist.numerique.gouv.fr`, ce script (et l'API REST SQL, voir ci-dessous) se
sont déjà heurtés par le passé à une protection anti-bot (Incapsula/Imperva) :
redirections 307 en boucle (`ERR_TOO_MANY_REDIRECTS`) empêchant le script de se
charger, ou requêtes `/sql` échouant en `Failed to fetch`. Si ça se reproduit,
une copie locale du script (comme avant ce changement) ou un proxy same-origin
pour l'API SQL sont les contournements à envisager.

## Statistiques sur `data_validation` (SQL Grist)

`data_validation` peut contenir plusieurs centaines de milliers de lignes — trop
pour recalculer des statistiques de distribution (déciles, quartiles, écart-type…)
à la main en JS à chaque changement de filtre. `js/grist-api.js` délègue donc ce
calcul au serveur via l'API REST SQL de Grist (`POST /api/docs/:docId/sql`,
lecture seule, contre le SQLite interne du document), atteinte via un jeton
d'accès (`grist.docApi.getAccessToken`) — voir `runSql()`. Toutes les requêtes
(statistiques par `niv_geo`, quantiles, graphique par département) tournent
côté serveur ; aucune ligne de `data_validation` n'est jamais rapatriée dans le
navigateur.


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
