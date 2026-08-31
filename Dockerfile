# Sert les fichiers statiques du widget (aucun build : HTML/CSS/JS bruts)
# avec les en-têtes CORS nécessaires pour que l'instance Grist locale
# (autre origine : http://localhost:8484) puisse charger manifest.json.
FROM nginx:alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf

# En dev, ce dossier est de toute façon écrasé par le bind-mount du
# docker-compose.yml (voir volumes: du service `widget`) pour avoir le
# rechargement à chaud ; ce COPY ne sert qu'à builder une image autonome.
COPY . /usr/share/nginx/html
