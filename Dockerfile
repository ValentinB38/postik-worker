# ============================================================
# worker/Dockerfile — Worker Postik (Railway) — V9 « GPT IMAGE 2 »
# Node seul. Plus de CLI Higgsfield, plus de Chromium/Puppeteer,
# plus de start.sh : la génération passe par les API OpenAI/Gemini,
# sharp embarque ses binaires précompilés.
# ============================================================
FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY index.js ./

CMD ["node", "index.js"]

# ------------------------------------------------------------
# worker/package.json attendu (dependencies) :
#   {
#     "name": "postik-worker",
#     "type": "module",
#     "dependencies": {
#       "express": "^4.19.0",
#       "sharp": "^0.33.0",
#       "undici": "^6.0.0",
#       "@supabase/supabase-js": "^2.45.0"
#     }
#   }
# (puppeteer SUPPRIMÉ — plus utilisé depuis la V8)
#
# Variables Railway nécessaires :
#   WORKER_KEY, OPENAI_API_KEY, GOOGLE_API_KEY,
#   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY
# Variables à SUPPRIMER de Railway (fossiles Higgsfield) :
#   HF_WORKSPACE_ID, HF_CREDENTIALS_B64,
#   HF_CREDENTIALS_DIR, HF_CREDENTIALS_PATH
# ------------------------------------------------------------
