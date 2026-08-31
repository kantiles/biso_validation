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

## Test local (hors Grist)

```bash
python3 -m http.server
```

Puis ouvrir `http://localhost:8000`. Hors du contexte Grist, le widget affiche
un message indiquant qu'il doit être ouvert en tant que Custom Widget.
