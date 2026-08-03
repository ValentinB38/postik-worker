// ============================================================
// worker/index.js — Worker Postik (Railway) — V6.1
// API Gemini directe avec MODÈLE DE REPLI automatique :
//   gemini-3-pro-image-preview (nano banana pro) saturé (503/429)
//   -> bascule sur gemini-2.5-flash-image (nano banana 1)
//   POST /generate  { prompt, aspect_ratio }                       -> JPEG (binaire)
//   POST /typeset   { prompt, image_url, logo_url?, aspect_ratio } -> JPEG (binaire, logo composité)
//   POST /compose   { html, width, height }                        -> JPEG (binaire, secours)
// Sécurité : header x-worker-key
// Variables Railway : WORKER_KEY, GOOGLE_API_KEY
// package.json dependencies : express, puppeteer, sharp, undici
// ============================================================

import express from "express";
import puppeteer from "puppeteer";
import sharp from "sharp";
import { Agent } from "undici";

const gAgent = new Agent({ connectTimeout: 15_000, headersTimeout: 180_000, bodyTimeout: 240_000 });

const app = express();
app.use(express.json({ limit: "3mb" }));

app.use((req, res, next) => {
  if (req.headers["x-worker-key"] !== process.env.WORKER_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

// ---------- Appel Gemini : principal + repli ----------
const GEMINI_MODELS = ["gemini-3-pro-image-preview", "gemini-2.5-flash-image"];
const geminiUrl = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

async function geminiImage({ prompt, refImages = [], aspectRatio = "4:5" }, tries = 2) {
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

  for (const model of GEMINI_MODELS) {
    for (let i = 1; i <= tries; i++) {
      const res = await fetch(geminiUrl(model), {
        dispatcher: gAgent,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": process.env.GOOGLE_API_KEY,
        },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json();
        const partsOut = data?.candidates?.[0]?.content?.parts ?? [];
        const imgPart = partsOut.find((p) => p.inline_data?.data || p.inlineData?.data);
        const b64 = imgPart?.inline_data?.data ?? imgPart?.inlineData?.data;
        if (!b64) throw new Error("réponse Gemini sans image: " + JSON.stringify(data).slice(0, 300));
        console.log(`gemini OK via ${model}`);
        return Buffer.from(b64, "base64");
      }
      const txt = await res.text();
      const transient = [429, 500, 503].includes(res.status);
      console.warn(`gemini ${model} ${res.status} (essai ${i}/${tries}): ${txt.slice(0, 150)}`);
      if (transient && i < tries) {
        await new Promise((r) => setTimeout(r, 15000));
        continue;
      }
      if (transient) break; // modèle saturé -> on tente le modèle suivant
      throw new Error(`gemini ${res.status}: ${txt.slice(0, 300)}`);
    }
  }
  throw new Error("tous les modèles Gemini sont indisponibles (surcharge) — réessaie dans quelques minutes");
}

async function fetchAsB64(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`téléchargement impossible: ${url.slice(0, 80)}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const mime = r.headers.get("content-type")?.split(";")[0] ?? "image/png";
  return { b64: buf.toString("base64"), mime, buf };
}

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

app.get("/health", (_req, res) => res.json({ ok: true, engine: "gemini", models: GEMINI_MODELS }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Worker Postik (Gemini + repli) sur :${port}`));
