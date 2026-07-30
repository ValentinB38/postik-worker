// ============================================================
// worker/index.js — Worker Postik (Railway)
// Deux endpoints :
//   POST /generate  { prompt, aspect_ratio, remove_bg }   -> { bg_url, cutout_url }
//   POST /compose   { html, width, height }               -> PNG (binaire)
// Sécurité : header  x-worker-key  (secret partagé avec les Edge Functions)
// ============================================================

import express from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import puppeteer from "puppeteer";

const exec = promisify(execFile);
const app = express();
app.use(express.json({ limit: "2mb" }));

// --- Auth simple par secret partagé ---
app.use((req, res, next) => {
  if (req.headers["x-worker-key"] !== process.env.WORKER_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

// ---------- Helpers CLI ----------
async function hf(args) {
  const { stdout } = await exec("higgsfield", [...args, "--json"], {
    timeout: 180_000,
    env: process.env,
  });
  const out = stdout.trim();
  try { return JSON.parse(out); } catch { return { raw: out }; }
}

/** Extrait la première URL https d'une sortie CLI (json ou texte). */
function firstUrl(x) {
  const s = typeof x === "string" ? x : JSON.stringify(x);
  const m = s.match(/https:\/\/[^\s"']+\.(png|jpg|jpeg|webp)/i);
  return m ? m[0] : null;
}

// ---------- POST /generate ----------
app.post("/generate", async (req, res) => {
  const { prompt, aspect_ratio = "4:5", remove_bg = false } = req.body ?? {};
  if (!prompt) return res.status(400).json({ error: "prompt requis" });
  try {
    // Génération (nano_banana_pro = 2 crédits)
    const gen = await hf([
      "generate", "create", "nano_banana_pro",
      "--prompt", prompt,
      "--aspect_ratio", aspect_ratio,
      "--wait",
    ]);
    const bg_url = firstUrl(gen);
    if (!bg_url) return res.status(502).json({ error: "pas d'url dans la sortie", gen });

    // Détourage optionnel (layout percée)
    let cutout_url = null;
    if (remove_bg) {
      // Le détourage passe par les workflows CLI.
      // `higgsfield workflow list --json` donne l'identifiant exact si celui-ci diffère.
      try {
        const cut = await hf(["workflow", "run", "remove_background", "--image-url", bg_url, "--wait"]);
        cutout_url = firstUrl(cut);
      } catch (e) {
        console.error("remove_bg failed (non bloquant)", e.message);
      }
    }
    res.json({ bg_url, cutout_url });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: "generation_failed", detail: String(e.message ?? e) });
  }
});

// ---------- POST /compose ----------
// Reçoit du HTML autonome (template rempli côté Edge Function, étage 4)
// et rend un PNG net aux dimensions exactes. Le fit-to-width mesuré tourne
// dans la page elle-même (script inclus au template) avant la capture.
let browser;
async function getBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--font-render-hinting=none"],
    });
  }
  return browser;
}

app.post("/compose", async (req, res) => {
  const { html, width = 1080, height = 1350 } = req.body ?? {};
  if (!html) return res.status(400).json({ error: "html requis" });
  let page;
  try {
    page = await (await getBrowser()).newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 2 }); // rendu 2x pour le piqué
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 60_000 });
    await page.evaluate(() => document.fonts.ready);                  // polices chargées
    await new Promise((r) => setTimeout(r, 150));                     // laisser le fit-to-width s'appliquer
    const png = await page.screenshot({ type: "jpeg", quality: 92 });
    res.setHeader("content-type", "image/jpeg");
    res.send(Buffer.from(png));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "compose_failed", detail: String(e.message ?? e) });
  } finally {
    if (page) await page.close();
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Worker Postik sur :${port}`));
