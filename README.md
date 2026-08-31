# Widget Grist — Validation BISO

Widget custom Grist (HTML/CSS/JS statique, sans build) pour valider des indicateurs :
sélection d'une feuille (table) du document, filtrage sur `id_indicateur`, affichage
des 10 premières lignes correspondantes, saisie de `validation` (Oui/Non) et
`commentaires` écrite directement dans le document Grist.

## Fichiers

- `index.html` — structure de la page
- `style.css` — mise en forme
- `app.js` — logique (appels à l'API Grist, filtrage, écriture des cellules)

## Déploiement sur GitHub Pages

1. Pousser ce dépôt sur GitHub.
2. Dans les paramètres du dépôt → **Pages**, choisir la branche `main` et le
   dossier racine (`/`).
3. Récupérer l'URL publiée, du type
   `https://<utilisateur>.github.io/<depot>/index.html`.

## Instance Grist ciblée

Le script `grist-plugin-api.js` est chargé depuis
`https://grist.numerique.gouv.fr/grist-plugin-api.js` — il doit obligatoirement
provenir de la **même instance Grist** que celle qui héberge le document dans
lequel le widget est utilisé (sinon erreur `Unknown forward destination: grist`
à l'initialisation). Si le document est un jour hébergé sur une autre instance
Grist, mettre à jour cette URL dans `index.html`.

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
