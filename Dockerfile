# ============================================================
# worker/Dockerfile — Worker Postik (Railway)
# Node + Chromium (Puppeteer) + CLI Higgsfield
# ============================================================
FROM node:20-slim

# Dépendances Chromium pour Puppeteer
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates fonts-liberation fonts-noto-color-emoji \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 \
    libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 libx11-xcb1 \
    libxcomposite1 libxdamage1 libxrandr2 xdg-utils wget \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# CLI Higgsfield (globale)
RUN npm i -g @higgsfield/cli

COPY package.json ./
RUN npm install
COPY index.js start.sh ./
RUN chmod +x start.sh

# start.sh écrit les credentials Higgsfield depuis la variable d'env
# HF_CREDENTIALS_B64 (base64 du fichier créé par `higgsfield auth login`
# sur ton Mac), puis sélectionne le workspace et lance le serveur.
CMD ["./start.sh"]

# ------------------------------------------------------------
# worker/start.sh  (à créer à côté, contenu ci-dessous)
# ------------------------------------------------------------
#   #!/bin/sh
#   set -e
#   mkdir -p "$HOME/$HF_CREDENTIALS_DIR"
#   echo "$HF_CREDENTIALS_B64" | base64 -d > "$HOME/$HF_CREDENTIALS_PATH"
#   higgsfield workspace set "$HF_WORKSPACE_ID" || true
#   node index.js
#
# Variables Railway à définir :
#   WORKER_KEY          = secret partagé (généré, long)
#   HF_WORKSPACE_ID     = b7ac3a60-c5d8-4704-a0ba-63f753b98a75
#   HF_CREDENTIALS_B64  = base64 du fichier credentials du Mac
#   HF_CREDENTIALS_DIR  = dossier du fichier (ex: .config/higgsfield)
#   HF_CREDENTIALS_PATH = chemin complet (ex: .config/higgsfield/credentials.json)
#
# Pour trouver le fichier sur ton Mac :
#   ls -la ~/.higgsfield ~/.config/higgsfield 2>/dev/null
# puis l'encoder :
#   base64 -i LE/CHEMIN/TROUVE | pbcopy   (le résultat est dans ton presse-papier)
#
# ------------------------------------------------------------
# worker/package.json  (à créer à côté)
# ------------------------------------------------------------
#   {
#     "name": "postik-worker",
#     "type": "module",
#     "dependencies": {
#       "express": "^4.19.0",
#       "puppeteer": "^23.0.0"
#     }
#   }
