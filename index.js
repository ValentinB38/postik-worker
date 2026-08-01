// ============================================================
// worker/index.js — Worker Postik (Railway) — V4
//   POST /generate  { prompt, aspect_ratio }                        -> { bg_url }
//   POST /typeset   { prompt, image_url, logo_url?, aspect_ratio }  -> { out_url }
//   POST /removebg  { image_url }                                   -> { cutout_url }
//   POST /compose   { html, width, height }                         -> JPEG (binaire)
// Sécurité : header x-worker-key
// ============================================================

import express from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, unlink } from "node:fs/promises";
import puppeteer from "puppeteer";

const exec = promisify(execFile);
const app = express();
app.use(express.json({ limit: "3mb" }));

app.use((req, res, next) => {
  if (req.headers["x-worker-key"] !== process.env.WORKER_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

// ---------- Helpers CLI ----------
async function hf(args, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const { stdout } = await exec("higgsfield", [...args, "--json"], {
        timeout: 180_000, env: process.env, maxBuffer: 20 * 1024 * 1024,
      });
      const out = stdout.trim();
      try { return JSON.parse(out); } catch { return { raw: out }; }
    } catch (e) {
      const msg = String(e.message ?? e);
      const transient = /503|502|Service Unavailable|timeout|ECONNRESET/i.test(msg);
      if (transient && i < tries) {
        console.warn(`hf retry ${i}/${tries} dans 15s (${msg.slice(0, 120)})`);
        await new Promise((r) => setTimeout(r, 15000));
        continue;
      }
      throw e;
    }
  }
}

function firstUrl(x) {
  const s = typeof x === "string" ? x : JSON.stringify(x);
  const m = s.match(/https:\/\/[^\s"']+\.(png|jpg|jpeg|webp)/i);
  return m ? m[0] : null;
}

async function downloadTo(url, path) {
  const dl = await fetch(url);
  if (!dl.ok) throw new Error(`téléchargement impossible: ${url.slice(0, 80)}`);
  await writeFile(path, Buffer.from(await dl.arrayBuffer()));
}

// ---------- POST /generate ----------
app.post("/generate", async (req, res) => {
  const { prompt, aspect_ratio = "4:5" } = req.body ?? {};
  if (!prompt) return res.status(400).json({ error: "prompt requis" });
  try {
    const gen = await hf([
      "generate", "create", "nano_banana_pro",
      "--prompt", prompt,
      "--aspect_ratio", aspect_ratio,
      "--wait",
    ]);
    const bg_url = firstUrl(gen);
    if (!bg_url) return res.status(502).json({ error: "pas d'url dans la sortie", gen });
    res.json({ bg_url, cutout_url: null });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: "generation_failed", detail: String(e.message ?? e) });
  }
});

// ---------- POST /typeset ----------
// Typographie posée par le modèle image.
// Références locales : le fond (obligatoire) + le logo (optionnel).
app.post("/typeset", async (req, res) => {
  const { prompt, image_url, logo_url = null, aspect_ratio = "4:5" } = req.body ?? {};
  if (!prompt || !image_url) return res.status(400).json({ error: "prompt et image_url requis" });
  const tmpBg = `/tmp/ref-bg-${Date.now()}.png`;
  const tmpLogo = `/tmp/ref-logo-${Date.now()}.png`;
  let logoOk = false;
  try {
    await downloadTo(image_url, tmpBg);
    if (logo_url) {
      try { await downloadTo(logo_url, tmpLogo); logoOk = true; }
      catch (e) { console.warn("logo non téléchargé, on continue sans", e.message); }
    }

    const args = [
      "generate", "create", "nano_banana_pro",
      "--prompt", prompt,
      "--image-references", tmpBg,
    ];
    if (logoOk) args.push("--image-references", tmpLogo);
    args.push("--aspect_ratio", aspect_ratio, "--wait");

    const gen = await hf(args);
    const out_url = firstUrl(gen);
    if (!out_url) return res.status(502).json({ error: "pas d'url dans la sortie", gen });
    res.json({ out_url });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: "typeset_failed", detail: String(e.message ?? e) });
  } finally {
    unlink(tmpBg).catch(() => {});
    unlink(tmpLogo).catch(() => {});
  }
});

// ---------- POST /removebg ----------
app.post("/removebg", async (req, res) => {
  const { image_url } = req.body ?? {};
  if (!image_url) return res.status(400).json({ error: "image_url requis" });
  try {
    const cut = await hf(["workflow", "run", "remove_background", "--image-url", image_url, "--wait"]);
    const cutout_url = firstUrl(cut);
    if (!cutout_url) return res.status(502).json({ error: "pas de cutout", cut });
    res.json({ cutout_url });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: "removebg_failed", detail: String(e.message ?? e) });
  }
});

// ---------- POST /compose (conservé en secours) ----------
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
    await page.setViewport({ width, height, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 60_000 });
    await page.evaluate(() => document.fonts.ready);
    await new Promise((r) => setTimeout(r, 200));
    const img = await page.screenshot({ type: "jpeg", quality: 92 });
    res.setHeader("content-type", "image/jpeg");
    res.send(Buffer.from(img));
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
