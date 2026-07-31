// ============================================================
// worker/index.js — Worker Postik (Railway)
//   POST /generate  { prompt, aspect_ratio }        -> { bg_url }
//   POST /removebg  { image_url }                   -> { cutout_url }
//   POST /compose   { html, width, height }         -> JPEG (binaire)
// Sécurité : header x-worker-key
// ============================================================

import express from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
async function hf(args) {
  const { stdout } = await exec("higgsfield", [...args, "--json"], {
    timeout: 180_000,
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
  });
  const out = stdout.trim();
  try { return JSON.parse(out); } catch { return { raw: out }; }
}
function firstUrl(x) {
  const s = typeof x === "string" ? x : JSON.stringify(x);
  const m = s.match(/https:\/\/[^\s"']+\.(png|jpg|jpeg|webp)/i);
  return m ? m[0] : null;
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

// ---------- POST /compose ----------
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
