// ============================================================
// worker/index.js — Worker Postik (Railway) — V6.2 « streaming »
// API Gemini en STREAMING (les en-têtes arrivent immédiatement,
// l'image ensuite en morceaux) -> plus jamais de HeadersTimeout,
// même quand Google est lent. Repli pro -> flash conservé.
//   POST /generate  { prompt, aspect_ratio }                       -> JPEG (binaire)
//   POST /typeset   { prompt, image_url, logo_url?, aspect_ratio } -> JPEG (binaire, logo composité)
//   POST /compose   { html, width, height }                        -> JPEG (binaire, secours)
// Variables Railway : WORKER_KEY, GOOGLE_API_KEY
// package.json dependencies : express, puppeteer, sharp, undici
// ============================================================

import express from "express";
import puppeteer from "puppeteer";
import sharp from "sharp";
import { Agent } from "undici";

const gAgent = new Agent({ connectTimeout: 15_000, headersTimeout: 60_000, bodyTimeout: 420_000 });

const app = express();
app.use(express.json({ limit: "3mb" }));

app.use((req, res, next) => {
  if (req.headers["x-worker-key"] !== process.env.WORKER_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

// ---------- Appel Gemini en streaming : principal + repli ----------
const GEMINI_MODELS = ["gemini-3-pro-image-preview", "gemini-2.5-flash-image"];
const geminiUrl = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;

async function geminiImage({ prompt, refImages = [], aspectRatio = "4:5" }, tries = 3) {
  const parts = [{ text: prompt }];
  for (const img of refImages) {
    parts.push({ inline_data: { mime_type: img.mime, data: img.b64 } });
  }
  const body = {
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ["IMAGE"],
      imageConfig: { aspectRatio },
    },
  };

  for (let sweep = 1; sweep <= 2; sweep++) {
    for (const model of GEMINI_MODELS) {
      for (let i = 1; i <= tries; i++) {
        let res;
        try {
          res = await fetch(geminiUrl(model), {
            dispatcher: gAgent,
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-goog-api-key": process.env.GOOGLE_API_KEY,
            },
            body: JSON.stringify(body),
          });
        } catch (e) {
          console.warn(`gemini ${model} réseau (essai ${i}/${tries}, passage ${sweep}): ${String(e.message ?? e).slice(0, 120)}`);
          if (i < tries) { await new Promise((r) => setTimeout(r, 12000)); continue; }
          break;
        }

        if (res.ok) {
          const text = await res.text();
          const bufs = [];
          for (const line of text.split("\n")) {
            const l = line.trim();
            if (!l.startsWith("data:")) continue;
            const payload = l.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              const chunk = JSON.parse(payload);
              const partsOut = chunk?.candidates?.[0]?.content?.parts ?? [];
              for (const p of partsOut) {
                const d = p.inline_data?.data ?? p.inlineData?.data;
                if (d) bufs.push(Buffer.from(d, "base64"));
              }
            } catch { /* morceau non-JSON, on ignore */ }
          }
          if (!bufs.length) {
            console.warn(`gemini ${model}: flux sans image (essai ${i}/${tries}, passage ${sweep})`);
            if (i < tries) { await new Promise((r) => setTimeout(r, 12000)); continue; }
            break;
          }
          const out = Buffer.concat(bufs);
          console.log(`gemini OK via ${model} (${Math.round(out.length / 1024)} Ko, passage ${sweep})`);
          return out;
        }

        const txt = await res.text();
        const transient = [429, 500, 503].includes(res.status);
        console.warn(`gemini ${model} ${res.status} (essai ${i}/${tries}, passage ${sweep}): ${txt.slice(0, 150)}`);
        if (transient && i < tries) { await new Promise((r) => setTimeout(r, 20000)); continue; }
        if (transient) break; // saturé -> modèle suivant
        throw new Error(`gemini ${res.status}: ${txt.slice(0, 300)}`);
      }
    }
    if (sweep === 1) {
      console.warn("tous les modèles saturés -> pause 45s puis second passage");
      await new Promise((r) => setTimeout(r, 45000));
    }
  }
  throw new Error("tous les modèles Gemini sont indisponibles — réessaie dans quelques minutes");
}

async function fetchAsB64(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`téléchargement impossible: ${url.slice(0, 80)}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const mime = r.headers.get("content-type")?.split(";")[0] ?? "image/png";
  return { b64: buf.toString("base64"), mime, buf };
}

// ---------- POST /poster ----------
// AFFICHE COMPLÈTE en UNE génération (image + typographie ensemble).
// ref_url (optionnel) : photo/produit du client — référence STRICTE.
// logo_url (optionnel) : logo officiel — référence STRICTE, intégré
// par le modèle lui-même (consignes de fidélité dans le prompt).
app.post("/poster", async (req, res) => {
  const { prompt, ref_url = null, logo_url = null, aspect_ratio = "4:5" } = req.body ?? {};
  if (!prompt) return res.status(400).json({ error: "prompt requis" });
  try {
    const refImages = [];
    if (ref_url) {
      const ref = await fetchAsB64(ref_url);
      refImages.push({ mime: ref.mime, b64: ref.b64 });
    }
    if (logo_url) {
      const logo = await fetchAsB64(logo_url);
      refImages.push({ mime: logo.mime, b64: logo.b64 });
    }
    const raw = await geminiImage({ prompt, refImages, aspectRatio: aspect_ratio });
    const baseBuf = await sharp(raw).jpeg({ quality: 92 }).toBuffer();
    res.setHeader("content-type", "image/jpeg");
    res.send(baseBuf);
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: "poster_failed", detail: String(e.message ?? e) });
  }
});

// ---------- POST /generate ----------
app.post("/generate", async (req, res) => {
  const { prompt, aspect_ratio = "4:5" } = req.body ?? {};
  if (!prompt) return res.status(400).json({ error: "prompt requis" });
  try {
    const raw = await geminiImage({ prompt, aspectRatio: aspect_ratio });
    const jpeg = await sharp(raw).jpeg({ quality: 95 }).toBuffer();
    res.setHeader("content-type", "image/jpeg");
    res.send(jpeg);
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: "generation_failed", detail: String(e.message ?? e) });
  }
});

// ---------- POST /typeset ----------
app.post("/typeset", async (req, res) => {
  const { prompt, image_url, logo_url = null, aspect_ratio = "4:5" } = req.body ?? {};
  if (!prompt || !image_url) return res.status(400).json({ error: "prompt et image_url requis" });
  try {
    const bg = await fetchAsB64(image_url);
    const raw = await geminiImage({
      prompt,
      refImages: [{ mime: bg.mime, b64: bg.b64 }],
      aspectRatio: aspect_ratio,
    });
    let baseBuf = raw;

    if (logo_url) {
      try {
        const logo = await fetchAsB64(logo_url);
        const meta = await sharp(baseBuf).metadata();
        const W = meta.width ?? 1080, H = meta.height ?? 1350;
        const logoBuf = await sharp(logo.buf).resize({ width: Math.round(W * 0.2) }).png().toBuffer();
        const logoMeta = await sharp(logoBuf).metadata();
        baseBuf = await sharp(baseBuf).composite([{
          input: logoBuf,
          top: Math.round(H * 0.04),
          left: Math.round(W - (logoMeta.width ?? 0) - W * 0.05),
        }]).jpeg({ quality: 92 }).toBuffer();
      } catch (e) {
        console.warn("composite logo raté, rendu sans logo :", e.message);
        baseBuf = await sharp(baseBuf).jpeg({ quality: 92 }).toBuffer();
      }
    } else {
      baseBuf = await sharp(baseBuf).jpeg({ quality: 92 }).toBuffer();
    }

    res.setHeader("content-type", "image/jpeg");
    res.send(baseBuf);
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: "typeset_failed", detail: String(e.message ?? e) });
  }
});

// ---------- POST /compose (secours) ----------
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

app.get("/health", (_req, res) => res.json({ ok: true, engine: "gemini-stream", models: GEMINI_MODELS }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Worker Postik (Gemini streaming) sur :${port}`));
