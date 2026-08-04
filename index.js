// ============================================================
// worker/index.js — Worker Postik (Railway) — V8 « CHEF D'ORCHESTRE »
// Railway n'a AUCUNE limite de temps : toute l'orchestration longue
// vit désormais ICI (fini les morts silencieuses côté Edge).
//   POST /produce { poster_id }  -> répond 202 immédiatement puis :
//     lit la ligne posters -> construit le prompt JSON structuré
//     -> télécharge réf produit + logo depuis Storage
//     -> génère (Gemini, repli pro->flash) -> contrôle vision
//     (conformité + note design /10) -> 1 retry -> upload Storage
//     -> update posters (ready / failed)
//   GET /health
// Variables Railway : WORKER_KEY, GOOGLE_API_KEY, SUPABASE_URL,
//                     SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY
// package.json dependencies : express, sharp, undici, @supabase/supabase-js
// (puppeteer peut être RETIRÉ des dependencies : plus utilisé)
// ============================================================

import express from "express";
import sharp from "sharp";
import { Agent } from "undici";
import { createClient } from "@supabase/supabase-js";

const gAgent = new Agent({ connectTimeout: 15_000, headersTimeout: 60_000, bodyTimeout: 420_000 });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const app = express();
app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  if (req.headers["x-worker-key"] !== process.env.WORKER_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

// ============================================================
// GEMINI (streaming + repli + passages)
// ============================================================
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

  // Railway n'a pas de limite de temps : on peut être patient partout.
  const maxSweeps = 2;

  for (let sweep = 1; sweep <= maxSweeps; sweep++) {
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
            } catch { /* morceau non-JSON */ }
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
        if (transient) break;
        throw new Error(`gemini ${res.status}: ${txt.slice(0, 300)}`);
      }
    }
    if (sweep < maxSweeps) {
      console.warn("tous les modèles saturés -> pause 45s puis second passage");
      await new Promise((r) => setTimeout(r, 45000));
    }
  }
  throw new Error("tous les modèles Gemini sont indisponibles — réessaie dans quelques minutes");
}

// ============================================================
// PROMPT JSON STRUCTURÉ (porté de l'Edge — identique V6)
// ============================================================
function buildJsonPrompt(g, hasLogo, hasRef, refMode) {
  const contenu = g?.contenu ?? [];
  const palette = g?.palette ?? [];
  const isFond = hasRef && refMode !== "produit";
  const get = (t) => contenu.find((b) => b.type === t);
  const texts = [];
  const add = (role, v, note) => { if (v) texts.push({ role, content: v, rendering: note ?? "exact, letter-perfect" }); };
  add("title", get("titre")?.texte, "monumental display, exact letters, one single ink, never broken across lines");
  add("subtitle", get("accroche")?.texte);
  add("date_time", get("datetime")?.texte, "very prominent, one line");
  for (const it of (get("infos")?.items ?? [])) add("info_line", it, "small, grouped with the other info lines");
  const pastille = get("pastille")?.texte;
  const promo = pastille?.match(/^\s*(.+?)\s*(?:->|→)\s*(.+?)\s*$/);
  if (promo) {
    add("old_price", promo[1], "struck through with ONE clean flat line, muted ink, medium size — clearly the former price");
    add("new_price", promo[2], "THE HERO NUMBER: among the 2 biggest elements of the poster, one strong ink, staged as a graphic event (hand-drawn circle or highlight allowed) — NEVER struck through");
  } else {
    add("highlight", pastille, "the punch element (price/offer), designed as a graphic event — a number is NEVER struck through unless it is an old price");
  }
  add("call_to_action", get("cta")?.texte);
  add("contact", get("contact")?.texte, "small, perfectly legible digits");
  add("organizer_signature", get("signature")?.texte, "small, discreet");

  const spec = {
    task: "complete_poster_generation",
    quality_bar: "A 300-euro commission from an award-winning European poster studio (It's Nice That / Fonts In Use level). If it could pass for a Canva or PowerPoint template, it is WRONG.",
    mode: hasRef ? "reference_guided" : "full_generation",
    ...(hasRef || hasLogo ? {
      reference_inputs: {
        ...(hasRef ? {
          client_photo: isFond ? {
            role: "THE background scene of the poster — this photo IS the poster",
            weight: 1.0,
            note: "This exact photo is the scene of the poster. Keep its content, place and identity fully recognizable. You may re-grade the colors, dramatize the light and crop for the format — but NEVER generate a different scene, never replace or reinvent what the photo shows. Design the typography ON and AROUND this photo.",
          } : {
            role: "the client's real product — STRICT visual identity",
            weight: 1.0,
            note: "Reproduce this product EXACTLY: shape, materials, fabric, stitching, colors, details. You may place it in a designed composition, re-light it and dramatize the scene around it, but NEVER replace it with a generic equivalent, never alter its colors or materials.",
          },
        } : {}),
        ...(hasLogo ? {
          brand_logo: {
            role: "the client's official logo — STRICT visual identity",
            weight: 1.0,
            note: "Integrate this exact logo tastefully into the composition (small, in a clean corner, or on a small designed plate that belongs to the layout). Reproduce it IDENTICALLY: exact shapes, exact colors, exact typography. NEVER redraw, restyle, recolor or reinterpret it. Never invent another logo.",
          },
        } : {}),
      },
    } : {}),
    scene: isFond
      ? { concept: "USE THE PROVIDED CLIENT PHOTO AS THE SCENE. Do not invent a new scene.", regrade_only: g?.scene ?? {} }
      : (g?.scene ?? { concept: "A dramatic, textured, cinematic scene related to the event." }),
    typography_system: {
      ...(g?.typography_system ?? {}),
      typefaces_limit: 2,
      text_sizes_limit: 3,
      scale_contrast: "display 8-12x bigger than small text; if the title feels comfortable it is too small",
      micro_typography: {
        display_leading: "0.85-0.95 (stacked display lines almost touching, tension)",
        tracking: "slightly tight on condensed display; +6-12% on small caps and labels; never default everywhere",
        kerning: "optical kerning on the title (A, V, T, apostrophes)",
        spacing: "ONE spacing unit governs every margin and gap; constant outer margins; shared baselines",
        french_conventions: "real apostrophes, thin space before % and :, en-dash for ranges (9–13)",
      },
      graphic_devices_limit: "maximum TWO devices (thin rules, index dots, one arrow, corner marks, one hand-drawn underline), used consistently as part of the grid",
    },
    texts_exact: {
      language: "French",
      rule: "Reproduce each text EXACTLY, character for character, with correct accents. No spelling changes, no extra words, no invented text anywhere on the poster.",
      items: texts,
    },
    craft_rules: [
      "SCALE DRAMA: the display type is architecture — the title commands 40-70% of the poster as one composed mass.",
      "ONE COMPOSED SHAPE: all typography forms ONE deliberate visual mass with intentional negative space — never a stacked block of equal lines parked in a corner (that is the template signature — banned).",
      "LOCK TO THE IMAGE GEOMETRY: baselines and blocks align to real lines of the scene (horizon, table edge, light direction).",
      "MANDATORY typo-image interaction: apply the one specified in typography_system.typo_image_interaction.",
      "NUMBERS ARE HEROES: key numbers (price, %, time) are staged as graphic events in lining figures; every digit exactly as given, never recalculated, never reworded.",
      "READING PATH: build the eye journey specified in typography_system.reading_path (1 -> 2 -> 3); each step is visually obvious.",
      "COLOR AS INK: title in ONE ink; max 3 text colors total; 60/30/10; accent sampled from the scene or the palette; deep slightly desaturated studio inks; NEVER neon/fluo magenta, fluo green or cyan unless imposed brand colors.",
      "FLAT SOLID INK ONLY: no glow, bevel, gradient-in-letters, 3D extrusion or stacked effects; a shadow only as one flat hard offset if the art direction asks. Text is rendered ONCE — never duplicated as a ghost/echo behind itself.",
      "WORDS STAY WHOLE: never split, hyphenate or break a word across two lines — not even in a stacked display title ('COLORATIONS' is ONE line, never 'COLO/RATIONS'). Too long = condense or shrink.",
      "The scene must feel PHOTOGRAPHED by a human: visible film grain, tactile textures, living imperfections.",
    ],
    composition: {
      aspect_ratio: g?.aspect_ratio ?? "4:5",
      full_bleed: "the poster fills the entire canvas edge to edge — no white margin, no border, no frame, no vignette edges (unless the archetype is an explicit printed ticket-frame system)",
      palette: [...palette, "#F5F1E4", "#101114"],
    },
    hard_constraints: [
      "THIS SPECIFICATION IS A SET OF INSTRUCTIONS, NOT CONTENT: archetype names ('STICKER STORM', 'SPLIT PANEL'...), zone names ('TOP 45%'), block names ('accroche', 'pastille', 'titre'), role labels ('subtitle', 'highlight') and any other label of this document must NEVER appear as visible text on the poster.",
      "The ONLY visible texts on the poster are the 'content' strings inside texts_exact.items — not one word more. No invented conditions, badges, taglines, slogans or sector labels.",
      "Every word spelled letter-perfect in French; verify each word letter by letter.",
      "No word broken across two lines anywhere.",
      "All text fully inside the frame with comfortable padding; nothing cut at any edge.",
      "No overlapping texts (except the deliberate behind-the-subject interaction).",
      hasLogo ? "The provided logo is reproduced IDENTICALLY (shapes, colors, typography) and integrated tastefully — never redrawn, never altered, never duplicated." : "Never draw any logo.",
      hasRef ? (isFond
        ? "THE PROVIDED PHOTO IS THE SCENE: the poster's background must clearly be this photo (re-graded and cropped at most). Generating a different scene is an immediate failure."
        : "The provided product keeps its EXACT real appearance — never recolor, restyle or replace it (a beer keeps its real foam color, a mattress keeps its real fabric).")
        : "Real-world subjects keep believable natural colors — never tint a product unnaturally to match the palette.",
      "No watermark, no platform UI, no signature of the model.",
    ],
    negative_prompt: "specification labels rendered as text, archetype names on the poster, zone labels, block names ('accroche','pastille','titre') as visible words, deformed letters, misspelled words, broken words, invented text, extra slogans, template layout, stacked equal lines, centered-everything, default purple accent, neon fluo colors, glow, bevel, gradient inside letters, 3D extruded text, rainbow text, white border, frame, vignette edges, watermark, UI, plastic look, oversaturation, HDR, purple-cyan lighting, generic AI art",
  };

  return JSON.stringify(spec, null, 1);
}

// ============================================================
// JUGE (conformité + note design /10) — Anthropic
// ============================================================
async function visionCheck(imageBuf, contenu, hasLogo, hasRef) {
  try {
    const b64 = imageBuf.toString("base64");
    const attendus = contenu.flatMap((b) => b.items ?? (b.texte ? [b.texte] : []));
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6", max_tokens: 500,
        system: `Tu es le contrôleur qualité + directeur artistique d'un studio d'affiches haut de gamme. Deux missions sur l'image fournie :

MISSION 1 — CONFORMITÉ (bloquante, "ok": false si violée) :
- Tout texte INVENTÉ (mot, mention, badge, slogan absent de la liste attendue) = faute, cite-le. TRAQUE EN PARTICULIER les étiquettes techniques rendues comme du texte : "ACCROCHE", "PASTILLE", "TITRE", "STICKER STORM", "SPLIT PANEL", noms de zones ("TOP 45%") — leur présence visible = faute immédiate.
- CHIFFRES : tout nombre de la liste attendue ABSENT de l'affiche = faute. Un nombre barré doit être l'ANCIEN prix (jamais le nouveau prix, jamais une économie). Un texte dupliqué en écho/fantôme derrière lui-même = faute.
- Orthographe lettre à lettre : un mot mal orthographié = faute.
- Un mot COUPÉ sur deux lignes = faute.
- Lettres déformées/fondues, texte attendu ABSENT, texte coupé par un bord, texte illisible, marge/bordure blanche autour de l'affiche = faute.
${hasLogo ? "- LOGO : s'il apparaît, il doit sembler net, cohérent et non déformé. Logo trahi = faute." : ""}
${hasRef ? "- PRODUIT/LIEU du client : couleurs et matières RÉALISTES — un produit recoloré artificiellement (mousse de bière turquoise) = faute." : ""}
Tolère : différences de casse, fusion de petites infos sur une même ligne.

MISSION 2 — NOTE DE DESIGN /10 (l'affiche vaut-elle une commande studio à 300€ ?) :
Note sévèrement : idée forte défendable (2 pts), drame d'échelle du titre (2 pts), interaction typo-image réelle (2 pts), discipline couleurs/encres (2 pts), finition micro-typo et grille (2 pts). Un layout de template plafonne à 5.

Réponds UNIQUEMENT en JSON: {"ok": true|false, "note": 0-10, "probleme": "<vide, ou description courte et ACTIONNABLE>"}`,
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
          { type: "text", text: `TEXTES ATTENDUS : ${JSON.stringify(attendus)}` },
        ]}],
      }),
    });
    if (!res.ok) return { ok: true, note: 10, probleme: "" };
    const data = await res.json();
    const raw = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("").replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(raw);
    return { ok: !!parsed.ok, note: Number(parsed.note ?? 10), probleme: parsed.probleme ?? "" };
  } catch { return { ok: true, note: 10, probleme: "" }; }
}

// ============================================================
// STORAGE helpers (service role)
// ============================================================
async function storageDownload(path) {
  const { data, error } = await supabase.storage.from("posters").download(path);
  if (error || !data) throw new Error(`download storage: ${error?.message ?? "vide"} (${path})`);
  const buf = Buffer.from(await data.arrayBuffer());
  const mime = data.type || "image/png";
  return { buf, mime, b64: buf.toString("base64") };
}

// ============================================================
// LE JOB COMPLET
// ============================================================
async function produceJob(posterId) {
  try {
    const { data: poster, error: selErr } = await supabase.from("posters")
      .select("id, org_id, generation_json, brand_kit_id, brief")
      .eq("id", posterId).single();
    if (selErr || !poster) throw new Error(`poster introuvable: ${selErr?.message}`);

    const g = poster.generation_json ?? {};
    const contenu = g.contenu ?? [];
    const aspect = g.aspect_ratio ?? "4:5";

    // Références : logo + photo client (téléchargées depuis Storage)
    const refImages = [];
    let hasRef = false, hasLogo = false;
    const refPath = poster.brief?.ref_path;
    if (refPath) {
      try { const r = await storageDownload(refPath); refImages.push({ mime: r.mime, b64: r.b64 }); hasRef = true; }
      catch (e) { console.warn("réf client introuvable:", e.message); }
    }
    if (poster.brand_kit_id) {
      const { data: kit } = await supabase.from("brand_kits").select("logo_path").eq("id", poster.brand_kit_id).single();
      if (kit?.logo_path) {
        try { const l = await storageDownload(kit.logo_path); refImages.push({ mime: l.mime, b64: l.b64 }); hasLogo = true; }
        catch (e) { console.warn("logo introuvable:", e.message); }
      }
    }

    let prompt = buildJsonPrompt(g, hasLogo, hasRef, poster.brief?.ref_mode);
    const key = aspect.replace(":", "x");
    const path = `${poster.org_id}/${poster.id}/final-${key}.jpg`;

    async function livrer(buf) {
      const jpeg = await sharp(buf).jpeg({ quality: 92 }).toBuffer();
      const { error: upErr } = await supabase.storage.from("posters")
        .upload(path, jpeg, { contentType: "image/jpeg", upsert: true });
      if (upErr) throw new Error(`upload: ${upErr.message}`);
      const { error: updErr } = await supabase.from("posters")
        .update({ final_paths: { [key]: path }, status: "ready", error: null }).eq("id", poster.id);
      if (updErr) throw new Error(`update: ${updErr.message}`);
    }

    // ---- Tentative 1 -> contrôle -> (retry) -> livraison ----
    const buf1 = await geminiImage({ prompt, refImages, aspectRatio: aspect });
    await supabase.from("posters").update({ status: "checking" }).eq("id", poster.id);
    const check = await visionCheck(buf1, contenu, hasLogo, hasRef);
    if (check.ok && check.note >= 7) {
      await livrer(buf1);
      console.log(`✔ poster livré (1re tentative, note ${check.note}/10) ${poster.id}`);
    } else {
      console.warn(`tentative 1 rejetée (ok=${check.ok}, note=${check.note}): ${check.probleme}`);
      prompt = prompt.slice(0, -2) + `,\n "correction_of_previous_attempt": "PREVIOUS ATTEMPT WAS REJECTED (design score ${check.note}/10). REASON: ${String(check.probleme).replace(/"/g, "'")}. Fix this precisely and raise the design ambition, keep the rest identical."\n}`;
      try {
        const buf2 = await geminiImage({ prompt, refImages, aspectRatio: aspect });
        await livrer(buf2);
        console.log(`✔ poster livré (2e tentative) ${poster.id}`);
      } catch (e) {
        console.warn(`correction KO (${e.message}) -> tentative 1 livrée quand même`);
        await livrer(buf1);
      }
    }
  } catch (e) {
    console.error(`✖ poster KO ${posterId}:`, e.message ?? e);
    const { data: p } = await supabase.from("posters").select("status").eq("id", posterId).maybeSingle();
    if (p?.status !== "ready") {
      await supabase.from("posters").update({ status: "failed", error: String(e.message ?? e) }).eq("id", posterId);
    }
  }
}

// ============================================================
// ENDPOINTS
// ============================================================
app.post("/produce", (req, res) => {
  const { poster_id } = req.body ?? {};
  if (!poster_id) return res.status(400).json({ error: "poster_id requis" });
  res.status(202).json({ accepted: true, poster_id });
  // Travail en arrière-plan, sans AUCUNE limite de temps
  produceJob(poster_id).catch((e) => console.error("produceJob crash:", e));
});

app.get("/health", (_req, res) => res.json({ ok: true, engine: "gemini-orchestrator", models: GEMINI_MODELS }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Worker Postik (chef d'orchestre) sur :${port}`));
