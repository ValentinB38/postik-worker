#!/bin/sh
# ============================================================
# worker/start.sh — démarrage du worker Postik
# Recrée ~/.config/higgsfield/{credentials.json,config.json}
# depuis les variables d'environnement, puis lance le serveur.
# ============================================================
set -e

CFG_DIR="$HOME/.config/higgsfield"
mkdir -p "$CFG_DIR"
echo "$HF_CREDENTIALS_B64" | base64 -d > "$CFG_DIR/credentials.json"
echo "$HF_CONFIG_B64"      | base64 -d > "$CFG_DIR/config.json"
chmod 600 "$CFG_DIR/credentials.json" "$CFG_DIR/config.json"

# Contrôle au démarrage (log utile dans Railway)
higgsfield workspace list || echo "WARN: workspace list a échoué — vérifier les credentials"

node index.js
