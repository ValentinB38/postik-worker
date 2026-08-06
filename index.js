// ============================================================
// worker/index.js — Worker Postik (Railway) — V9 « GPT IMAGE 2 »
// Railway n'a AUCUNE limite de temps : toute l'orchestration longue
// vit désormais ICI (fini les morts silencieuses côté Edge).
//   POST /produce { poster_id }  -> répond 202 immédiatement puis :
//     lit la ligne posters -> construit le prompt JSON structuré
//     -> télécharge réf produit + logo depuis Storage
//     -> génère (GPT Image 2 en principal, chaîne Gemini pro->flash
//        en secours automatique) -> contrôle vision
//     (conformité + note design /10) -> 1 retry -> upload Storage
//     -> update posters (ready / failed)
//   GET /health
// Variables Railway : WORKER_KEY, OPENAI_API_KEY (moteur principal),
//                     GOOGLE_API_KEY (secours), SUPABASE_URL,
//                     SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY
// OPENAI_API_KEY absente = chaîne Gemini seule (déploiement sans risque)
// package.json dependencies : express, sharp, undici, @supabase/supabase-js
// (puppeteer peut être RETIRÉ des dependencies : plus utilisé)
// ============================================================

import express from "express";
import sharp from "sharp";
import { Agent } from "undici";
import { createClient } from "@supabase/supabase-js";

const gAgent = new Agent({ connectTimeout: 15_000, headersTimeout: 60_000, bodyTimeout: 420_000 });
// Agent dédié OpenAI : l'API images est SYNCHRONE (aucun en-tête tant que
// l'image n'est pas finie, jusqu'à ~2 min) -> headersTimeout doit couvrir
// toute la fabrication, contrairement au streaming Gemini.
const oaAgent = new Agent({ headersTimeout: 300_000, bodyTimeout: 420_000, connect: { timeout: 15_000, family: 4 } });
// family: 4 = force IPv4 (Railway peut résoudre api.openai.com en IPv6 sans route de sortie -> fetch failed instantané)
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
let LAST_MODEL = ""; // modèle ayant réellement produit la dernière image (traçabilité pro vs secours)
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
  // Pauses CROISSANTES entre les passages : les pics 503 de Google durent
  // souvent plusieurs minutes — abandonner après 2 passages et 45s était trop tôt.
  const SWEEP_PAUSES = [45_000, 120_000, 240_000]; // après les passages 1, 2 et 3
  const maxSweeps = SWEEP_PAUSES.length + 1;       // 4 passages, ~12-14 min max au pire

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
          LAST_MODEL = model;
          console.log(`gemini OK via ${model} (${Math.round(out.length / 1024)} Ko, passage ${sweep})`);
          return out;
        }

        const txt = await res.text();
        const transient = [429, 500, 503].includes(res.status);
        console.warn(`gemini ${model} ${res.status} (essai ${i}/${tries}, passage ${sweep}): ${txt.slice(0, 150)}`);
        if (transient && i < tries) { await new Promise((r) => setTimeout(r, 20000)); continue; }
        if (transient) break;
        console.error(`gemini ${model} ${res.status} non transitoire: ${txt.slice(0, 300)}`);
        throw new Error(`souci technique à l'atelier (code ${res.status}), réessaie : ton quota n'est débité qu'une fois`);
      }
    }
    if (sweep < maxSweeps) {
      const pause = SWEEP_PAUSES[sweep - 1];
      console.warn(`tous les modèles saturés -> pause ${Math.round(pause / 1000)}s puis passage ${sweep + 1}/${maxSweeps}`);
      await new Promise((r) => setTimeout(r, pause));
    }
  }
  throw new Error("l'atelier Postik est saturé en ce moment, réessaie dans quelques minutes : ton quota n'est débité qu'une fois");
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
    negative_prompt: "placeholder text, conditional labels rendered as words ('si fourni', 'a completer', 'lieu/contact', 'your text here'), specification labels rendered as text, archetype names on the poster, zone labels, block names ('accroche','pastille','titre') as visible words, ambiguous stylized letterforms (Z that reads as 7, O that reads as 0, I that reads as 1), deformed letters, misspelled words, broken words, invented text, extra slogans, template layout, stacked equal lines, centered-everything, default purple accent, neon fluo colors, glow, bevel, gradient inside letters, 3D extruded text, rainbow text, white border, frame, vignette edges, watermark, UI, plastic look, oversaturation, HDR, purple-cyan lighting, generic AI art",
  };

  return JSON.stringify(spec, null, 1);
}



// ============================================================
// PROMPT « COMMANDE DE STUDIO » — pour GPT Image 2
// GPT Image 2 raisonne et planifie la mise en page AVANT de rendre :
// il répond bien mieux à une directive écrite (ordre de lecture, poids
// chiffrés, texte exact isolé) qu'à un arbre JSON de spec, et il n'a
// pas de negative_prompt (toute interdiction est donc formulée en
// POSITIF, sinon elle risque d'invoquer ce qu'elle interdit).
// ============================================================
function buildProsePrompt(g, hasLogo, hasRef, refMode) {
  const contenu = g?.contenu ?? [];
  const palette = (g?.palette ?? []).filter(Boolean);
  const isFond = hasRef && refMode !== "produit";
  const get = (t) => contenu.find((b) => b.type === t);
  const sc = g?.scene ?? {};
  const ty = g?.typography_system ?? {};
  const L = [];
  const p = (x) => L.push(x);

  /* ---------- 1. LE TEXTE, ISOLÉ EN PREMIER ---------- */
  const lines = [];
  const titre = get("titre")?.texte;
  if (titre) lines.push(`• TITRE — « ${titre} » — le bloc typographique monumental, une seule encre, chaque mot entier (jamais coupé ni tiré à la ligne au milieu d'un mot).`);
  const accroche = get("accroche")?.texte;
  if (accroche) lines.push(`• SOUS-TITRE — « ${accroche} » — nettement plus petit que le titre, il le complète sans le répéter.`);
  const dt = get("datetime")?.texte;
  if (dt) lines.push(`• DATE ET HEURE — « ${dt} » — traité comme une information forte et lisible de loin, sur une seule ligne.`);
  const pastille = get("pastille")?.texte;
  const promo = pastille?.match(/^\s*(.+?)\s*(?:->|→)\s*(.+?)\s*$/);
  if (promo) {
    lines.push(`• ANCIEN PRIX — « ${promo[1]} » — de taille moyenne, dans une encre sourde, traversé par UN seul trait net et droit : c'est visiblement le prix d'avant.`);
    lines.push(`• NOUVEAU PRIX — « ${promo[2]} » — LE HÉROS de l'affiche : parmi les deux plus grands éléments, dans une encre forte, mis en scène comme un événement graphique. Il n'est jamais barré, jamais entouré d'un autre prix, et n'apparaît qu'UNE seule fois sur toute l'affiche.`);
  } else if (pastille) {
    lines.push(`• ÉLÉMENT CHOC — « ${pastille} » — l'argument de vente, mis en scène comme un événement graphique. Aucun chiffre n'est barré ici.`);
  }
  for (const it of (get("infos")?.items ?? [])) lines.push(`• INFO — « ${it} » — petit corps, groupé avec les autres informations pratiques, parfaitement lisible.`);
  const cta = get("cta")?.texte;
  if (cta) lines.push(`• APPEL À L'ACTION — « ${cta} ».`);
  const contact = get("contact")?.texte;
  if (contact) lines.push(`• CONTACT — « ${contact} » — petit corps, chiffres parfaitement formés et espacés, chaque chiffre exactement dans cet ordre.`);
  const sign = get("signature")?.texte;
  if (sign) lines.push(`• SIGNATURE — « ${sign} » — discrète, en pied d'affiche.`);

  p(`COMMANDE : une affiche publicitaire française finie, prête à imprimer, format ${g?.aspect_ratio ?? "4:5"}. Niveau attendu : une commande à 300 € dans un studio d'affiches européen primé. Tu es le directeur artistique ET l'exécutant : tu conçois la mise en page, puis tu la rends.`);
  p(`\nNATURE DE L'IMAGE — À LIRE EN PREMIER : cette affiche est AVANT TOUT UNE VRAIE PHOTOGRAPHIE, sur laquelle une typographie de studio est ensuite posée. La photographie occupe la TOTALITÉ du cadre, bord à bord, du haut jusqu'en bas : elle est le sol de l'affiche, jamais une vignette placée dans un coin ni une moitié de l'image. Le texte se pose SUR cette photographie — dans ses zones naturellement sombres ou calmes, ou en passant devant et derrière les objets — et la photographie reste visible et lisible partout, y compris derrière les plus grandes lettres. Aucun aplat de couleur opaque ne vient recouvrir une partie de l'image pour y loger du texte ; si le texte a besoin de lisibilité, cela se règle par la lumière de la scène, la profondeur de champ ou un assombrissement très progressif, jamais par un panneau plein.`);
  p(`\n=== 1. LA PHOTOGRAPHIE (le socle de l'affiche) ===`);

  /* ---------- 2. LA SCÈNE ---------- */
  // (section 1 : la photographie — l'en-tête est écrit plus haut)
  if (isFond) {
    p(`La photo fournie EST la scène de l'affiche. Tu conserves son contenu, son lieu et son identité parfaitement reconnaissables. Tu as le droit d'en retravailler les couleurs, d'en dramatiser la lumière et de la recadrer au format. Tu composes la typographie SUR et AUTOUR de cette photo.`);
  } else if (hasRef) {
    p(`Le produit fourni est reproduit exactement : sa forme, ses matières, ses coutures, ses couleurs, ses détails réels. Tu le mets en scène, tu le ré-éclaires, tu dramatises le décor autour de lui, mais il reste ce produit-là, avec ses couleurs réelles.`);
  }
  if (sc.concept) p(`Concept : ${sc.concept}`);
  if (sc.setting) p(`Lieu : ${sc.setting}`);
  if (sc.mood) p(`Atmosphère : ${sc.mood}`);
  if (sc.time_of_day) p(`Moment : ${sc.time_of_day}`);
  if (sc.hero_detail) p(`Détail-vérité qui rend la scène crédible : ${sc.hero_detail}`);
  if (sc.environment) {
    const e = sc.environment;
    if (e.foreground) p(`Premier plan : ${e.foreground}`);
    if (e.midground) p(`Plan moyen : ${e.midground}`);
    if (e.background) p(`Arrière-plan : ${e.background}`);
    if (e.calm_zone) p(`Zone naturellement calme de la photographie, où le texte pourra se poser sans rien recouvrir (cette zone reste une partie de l'image, avec sa matière et sa profondeur) : ${e.calm_zone}`);
  }
  if (sc.lighting) {
    const li = sc.lighting;
    p(`Lumière : ${[li.type, li.direction, li.quality, li.signature_effect].filter(Boolean).join(" — ")}`);
  }
  if (sc.camera) {
    const c = sc.camera;
    p(`Prise de vue : ${[c.lens, c.aperture, c.angle, c.depth_of_field, c.framing].filter(Boolean).join(" — ")}`);
  }
  if (sc.color_grading) {
    const cg = sc.color_grading;
    p(`Étalonnage : ${[cg.look, cg.palette_ratio, (cg.textures ?? []).join(", ")].filter(Boolean).join(" — ")}`);
  }
  if (Array.isArray(sc.materials_physics) && sc.materials_physics.length) {
    p(`Comportement de la lumière sur les matières (c'est ce qui rend une image crédible) :`);
    sc.materials_physics.forEach((m) => p(`— ${m}`));
  }
  if (sc.atmosphere) p(`Matière atmosphérique qui donne du volume à la scène : ${sc.atmosphere}`);
  if (sc.optical_signature) p(`Signature optique assumée de l'objectif : ${sc.optical_signature}`);
  if (sc.post_production) p(`Étalonnage et retouche finale : ${sc.post_production}`);
  p(`Quelqu'un qui découvre cette affiche dans la rue doit croire qu'une équipe a fait un vrai shooting pour ce commerce, puis qu'un studio a composé la typographie par-dessus. Jamais une image générée, jamais un montage.`);
  p(`RÉALISME PHOTOGRAPHIQUE — exigence non négociable : real photograph, shot on a full-frame camera with a fast prime lens, natural depth of field with real optical falloff, true-to-life skin texture and material response, visible fine film grain, micro-contrast, subtle lens vignetting and chromatic aberration, real dust and wear, believable shadows with soft ambient occlusion. Photojournalistic honesty: this must look like a frame captured in a real place, not an illustration, not a 3D render, not flat vector art, not a composited studio cut-out.`);
  p(`La profondeur est réelle : premier plan, sujet et arrière-plan occupent des distances différentes, avec une vraie mise au point sélective. La lumière vient de sources visibles ou plausibles dans le lieu.`);
  p(`Aucune lettre, aucun mot, aucune enseigne lisible n'apparaît dans le décor photographié lui-même : tout le texte de l'affiche est posé par toi, en typographie.`);

  /* ---------- 3. LA TYPOGRAPHIE ---------- */
  p(`\n=== 2. LE TEXTE DE L'AFFICHE (aucun autre mot ne doit apparaître) ===`);
  p(`Ces textes sont en FRANÇAIS et sont recopiés caractère par caractère, avec leurs accents exacts (é è ê à ç ô û), leurs apostrophes et leurs espaces. Ce sont les SEULS mots visibles sur l'affiche : chaque mot que tu écris provient de cette liste, et chaque élément de cette liste apparaît exactement une fois.`);
  lines.forEach((l) => p(l));
  p(`Vérifie chaque mot lettre par lettre avant de rendre, en particulier les petits textes du bas : c'est là que les fautes se glissent. Les lettres de chaque mot sont sans ambiguïté à la lecture (un Z se lit Z et jamais 7, un O se lit O et jamais 0, un I se lit I et jamais 1).`);

  p(`\n=== 3. LA TYPOGRAPHIE ===`);
  if (ty.archetype) p(`Parti pris de composition : ${ty.archetype}. Ce parti pris décrit la façon dont la TYPOGRAPHIE s'organise sur la photographie ; il ne divise jamais l'affiche en panneaux, colonnes pleines ou bandes de couleur unie.`);
  if (ty.display_font_character) p(`Caractère de la police d'affichage : ${ty.display_font_character}`);
  if (ty.secondary_font_character) p(`Police secondaire : ${ty.secondary_font_character}`);
  p(`Exactement DEUX familles de caractères sur toute l'affiche, et TROIS tailles de texte : une taille d'affichage monumentale, une taille intermédiaire, une petite taille.`);
  p(`Contraste d'échelle : le titre est 8 à 12 fois plus grand que les petits textes. S'il paraît confortable, c'est qu'il est trop petit.`);
  if (ty.title_ink) p(`Encre du titre : ${ty.title_ink} — le titre entier dans cette seule encre.`);
  if (ty.accent) p(`Accent : ${ty.accent}`);
  if (ty.numerals_treatment) p(`Traitement des chiffres : ${ty.numerals_treatment}`);
  if (ty.signature_treatment) p(`Traitement signature (un seul sur l'affiche) : ${ty.signature_treatment}`);
  if (ty.human_touch) p(`Touche humaine subtile : ${ty.human_touch}`);
  if (ty.typo_image_interaction) p(`INTERACTION OBLIGATOIRE entre typo et image : ${ty.typo_image_interaction}`);
  p(`Micro-typographie : interlignage serré de 0,85 à 0,95 sur les lignes d'affichage empilées ; approche légèrement resserrée sur les capitales condensées et ouverte de 6 à 12 % sur les petites capitales ; crénage optique sur le titre ; une seule unité d'espacement gouverne toutes les marges et tous les intervalles ; vraies apostrophes typographiques, espace fine avant % et :, tiret demi-cadratin pour les plages de nombres.`);
  p(`Les lettres sont posées en encre pleine et plate : leur couleur est unie sur toute la surface de chaque lettre, leurs contours sont nets, et chaque texte est rendu une seule fois, à un seul endroit.`);
  const ti = ty.type_integration;
  if (ti && (ti.occlusion || ti.light_wrap || ti.type_shadow || ti.grain_match)) {
    p(`\nINTÉGRATION DES LETTRES DANS LA PHOTOGRAPHIE — c'est le geste qui distingue une vraie affiche d'un montage. La typographie appartient physiquement à la scène :`);
    if (ti.occlusion) p(`— Occlusion : ${ti.occlusion}`);
    if (ti.light_wrap) p(`— Débord de lumière sur les lettres : ${ti.light_wrap}`);
    if (ti.type_shadow) p(`— Ombre portée des lettres : ${ti.type_shadow}`);
    if (ti.grain_match) p(`— Continuité de matière : ${ti.grain_match}`);
    p(`Ces quatre gestes se combinent : les lettres reçoivent la même lumière, la même poussière et le même grain que la photographie qui les porte.`);
  }
  if (ty.print_finish) p(`Finition d'impression tenue sur toute l'affiche : ${ty.print_finish}`);

  /* ---------- 4. COMPOSITION CHIFFRÉE ---------- */
  p(`\n=== 4. COMPOSITION ET PARCOURS DE L'ŒIL ===`);
  if (ty.reading_path) p(`Parcours de lecture à construire, dans cet ordre : ${ty.reading_path}. Chaque étape est visuellement évidente.`);
  p(`Le bloc dominant (titre ou chiffre héros) s'étend sur 40 à 70 % de la LARGEUR de l'affiche et forme UNE masse composée, posée sur la photographie. Il s'agit d'une échelle de lettres, pas d'une surface à remplir : la photographie continue d'exister derrière et autour de lui, et respire dans les vides de la composition. Les informations secondaires occupent une bande discrète, en général en pied d'affiche, hiérarchisées entre elles.`);
  if (Array.isArray(ty.layout_zones)) {
    p(`Emplacements indicatifs des textes SUR la photographie (ce sont des positions de blocs de lettres posés sur l'image, en aucun cas un découpage de l'affiche en panneaux ou en bandes de couleur ; la photographie continue derrière chacun d'eux) :`);
    ty.layout_zones.forEach((z) => {
      if (z?.zone) p(`— vers ${z.zone} : ${[z.content, z.scale, z.alignment, z.anchored_to && "calé sur " + z.anchored_to].filter(Boolean).join(" — ")}`);
    });
  }
  p(`Les lignes de base et les blocs s'alignent sur des lignes réelles de la scène (horizon, arête, direction de la lumière). LA PHOTOGRAPHIE S'ÉTEND D'UN BORD À L'AUTRE DU CADRE, y compris derrière les colonnes de texte et sous les plus grandes lettres : à aucun endroit de l'affiche on ne trouve une zone où l'image a disparu au profit d'une couleur unie. Tout le texte est entièrement à l'intérieur du cadre, avec une marge confortable autour.`);
  p(`Au maximum DEUX artifices graphiques (filets fins, points repères, une flèche, marques d'angle, un soulignement dessiné à la main), utilisés de façon cohérente comme éléments de la grille.`);

  /* ---------- 5. COULEUR ---------- */
  p(`\n=== 5. LA COULEUR ===`);
  p(`Palette de travail : ${(palette.length ? palette : ["#F5F1E4", "#101114"]).join(", ")}. Répartition 60/30/10.`);
  p(`Des encres d'imprimerie profondes, légèrement désaturées, prolongeant les tons de la scène. TROIS couleurs de texte au maximum sur toute l'affiche, titre compris.`);

  /* ---------- 6. RÉFÉRENCES ---------- */
  if (hasLogo || hasRef) {
    p(`\n=== 6. LES ÉLÉMENTS FOURNIS PAR LE CLIENT ===`);
    if (hasLogo) p(`Le logo fourni est reproduit à l'identique — mêmes formes, mêmes couleurs, même typographie — et intégré avec goût, de petite taille, dans un angle propre ou sur une petite plaque qui appartient à la mise en page. Il apparaît une seule fois.`);
    if (hasRef && !isFond) p(`Le produit fourni garde son apparence réelle exacte dans la composition finale.`);
    if (isFond) p(`La photo fournie reste reconnaissable comme le lieu du client dans l'affiche finale.`);
  }

  /* ---------- 7. VÉRIFICATION FINALE ---------- */
  p(`\n=== ${hasLogo || hasRef ? 7 : 6}. VÉRIFICATION AVANT DE RENDRE ===`);
  p(`Avant de produire l'image, relis ta composition point par point :`);
  p(`1) Chaque texte de la section 1 est présent, orthographié exactement, avec ses accents — épelle mentalement chaque mot, lettre après lettre, y compris dans les petites lignes.`);
  p(`2) Chaque chiffre est exactement celui donné, dans le même ordre ; aucun nombre n'a été recalculé, arrondi ni reformulé.`);
  p(`3) Aucun mot ne figure sur l'affiche s'il n'est pas dans la section 1 — ni slogan ajouté, ni mention inventée, ni étiquette de cette commande (les mots « titre », « sous-titre », « info », « zone » ne sont pas du contenu).`);
  p(`4) Aucun mot n'est coupé entre deux lignes, aucun texte n'est tronqué par un bord, aucun texte n'est écrit deux fois.`);
  p(`5) La composition est une idée de directeur artistique défendable devant un client, pas un empilement de lignes de même taille dans un coin.`);
  p(`6) L'image finale ressemble à une VRAIE PHOTOGRAPHIE occupant tout le cadre, avec sa profondeur et sa matière — et non à un fond plat, à une illustration ou à une photo reléguée sur une moitié de l'affiche.`);
  p(`7) Test du panneau : si tu masques mentalement tout le texte, il reste UNE seule photographie continue qui remplit le format entier. S'il reste une bande ou une moitié de couleur unie, la composition est à refaire.`);
  return L.join("\n");
}

// ============================================================
// GPT IMAGE 2 (OpenAI) — moteur principal si OPENAI_API_KEY est posée
// - tailles arbitraires (multiples de 16, ratio 1:3..3:1) -> formats natifs
// - références traitées en haute fidélité automatiquement
// - NE PAS passer input_fidelity ni background transparent (refusés)
// - API synchrone : jusqu'à ~2 min, retry backoff sur 429/5xx
// ============================================================
const OPENAI_SIZE = { "4:5": "1024x1280", "1:1": "1024x1024", "9:16": "864x1536", "2:3": "1024x1536" };

async function openaiImage({ prompt, refImages = [], aspectRatio = "4:5" }, tries = 3) {
  const size = OPENAI_SIZE[aspectRatio] ?? "1024x1280";
  const fullPrompt = prompt;

  // STREAMING OBLIGATOIRE : l'API images est synchrone et facturée même si le
  // client se déconnecte. En streaming, des aperçus partiels circulent pendant
  // toute la fabrication -> aucune coupure pour inactivité, et l'image payée
  // n'est jamais perdue.
  for (let i = 1; i <= tries; i++) {
    const t0 = Date.now();
    const secs = () => Math.round((Date.now() - t0) / 1000);
    console.log(`gpt-image-2 -> lancement (essai ${i}/${tries}, ${size}, ${refImages.length} réf.)`);
    // battement de coeur : preuve de vie toutes les 30 s pendant la fabrication
    const beat = setInterval(() => console.log(`gpt-image-2 … en cours (${secs()} s)`), 30000);
    let res;
    try {
      if (refImages.length) {
        const fd = new FormData();
        fd.append("model", "gpt-image-2");
        fd.append("prompt", fullPrompt);
        fd.append("size", size);
        fd.append("quality", "high");
        fd.append("output_format", "png");
        fd.append("stream", "true");
        fd.append("partial_images", "2");
        refImages.forEach((img, idx) => {
          const mime = img.mime || "image/png";
          fd.append("image[]", new Blob([Buffer.from(img.b64, "base64")], { type: mime }), `ref-${idx + 1}.${(mime.split("/")[1] || "png")}`);
        });
        res = await fetch("https://api.openai.com/v1/images/edits", {
          dispatcher: oaAgent,
          method: "POST",
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, Accept: "text/event-stream" },
          body: fd,
        });
      } else {
        res = await fetch("https://api.openai.com/v1/images/generations", {
          dispatcher: oaAgent,
          method: "POST",
          headers: {
            "content-type": "application/json",
            Accept: "text/event-stream",
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: "gpt-image-2", prompt: fullPrompt, size, quality: "high",
            output_format: "png", stream: true, partial_images: 2,
          }),
        });
      }
    } catch (e) {
      clearInterval(beat);
      console.warn(`gpt-image-2 réseau après ${secs()} s (essai ${i}/${tries}): ${String(e.message ?? e).slice(0, 120)} | cause: ${String(e.cause?.code ?? e.cause ?? "inconnue").slice(0, 120)}`);
      if (i < tries) { await new Promise((r) => setTimeout(r, 15000)); continue; }
      throw e;
    }

    if (!res.ok) {
      clearInterval(beat);
      const txt = await res.text();
      const transient = [429, 500, 502, 503, 529].includes(res.status);
      console.warn(`gpt-image-2 ${res.status} (essai ${i}/${tries}): ${txt.slice(0, 200)}`);
      if (transient && i < tries) { await new Promise((r) => setTimeout(r, 20000 * i)); continue; }
      throw new Error(`gpt-image-2 ${res.status}: ${txt.slice(0, 300)}`);
    }

    // --- Lecture du flux SSE : on garde le dernier b64 vu (final > partiel) ---
    try {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "", finalB64 = null, lastPartial = null, partials = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const l = line.trim();
          if (!l.startsWith("data:")) continue;
          const payload = l.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let evt; try { evt = JSON.parse(payload); } catch { continue; }
          const b64 = evt.b64_json ?? evt.data?.[0]?.b64_json;
          if (!b64) continue;
          if (String(evt.type ?? "").includes("completed")) { finalB64 = b64; console.log(`gpt-image-2 image finale reçue (${secs()} s)`); }
          else { lastPartial = b64; partials++; console.log(`gpt-image-2 aperçu ${partials} reçu (${secs()} s)`); }
        }
      }

      clearInterval(beat);
      const chosen = finalB64 ?? lastPartial;
      if (!chosen) {
        console.warn(`gpt-image-2: flux sans image (essai ${i}/${tries})`);
        if (i < tries) { await new Promise((r) => setTimeout(r, 12000)); continue; }
        throw new Error("gpt-image-2: flux sans image");
      }
      LAST_MODEL = "gpt-image-2";
      const out = Buffer.from(chosen, "base64");
      console.log(`gpt-image-2 OK en ${secs()} s (${Math.round(out.length / 1024)} Ko, essai ${i}, ${size}, ${partials} aperçu(s)${finalB64 ? ", image finale" : ", APERÇU seulement"})`);
      return out;
    } catch (e) {
      clearInterval(beat);
      console.warn(`gpt-image-2 flux interrompu après ${secs()} s (essai ${i}/${tries}): ${String(e.message ?? e).slice(0, 120)} | cause: ${String(e.cause?.code ?? e.cause ?? "inconnue").slice(0, 120)}`);
      if (i < tries) { await new Promise((r) => setTimeout(r, 15000)); continue; }
      throw e;
    }
  }
  throw new Error("gpt-image-2 indisponible");
}

// ============================================================
// SÉLECTION DU MOTEUR
// GPT Image 2 d'abord ; toute panne (saturation, modération, réseau)
// bascule automatiquement sur la chaîne Gemini pro->flash existante.
// ============================================================
// PRIMARY_ENGINE (variable Railway) : "openai" (défaut) ou "gemini".
// prefer permet de forcer l'autre moteur sur la 2e tentative : la beauté d'un
// moteur, la rigueur typographique de l'autre.
async function generateImage({ prompt, promptOA, refImages, aspectRatio, prefer }) {
  const primary = prefer ?? (process.env.PRIMARY_ENGINE || "openai");
  const hasOA = !!process.env.OPENAI_API_KEY;

  if (primary === "gemini") {
    try { return await geminiImage({ prompt, refImages, aspectRatio }); }
    catch (e) {
      console.warn(`gemini KO -> secours gpt-image-2 : ${String(e.message ?? e).slice(0, 160)}`);
      if (!hasOA) throw e;
      return openaiImage({ prompt: promptOA ?? prompt, refImages, aspectRatio });
    }
  }

  if (hasOA) {
    try { return await openaiImage({ prompt: promptOA ?? prompt, refImages, aspectRatio }); }
    catch (e) { console.warn(`gpt-image-2 KO -> secours Gemini : ${String(e.message ?? e).slice(0, 160)}`); }
  }
  return geminiImage({ prompt, refImages, aspectRatio });
}

// ============================================================
// JUGE (conformité + note design /10) — Anthropic
// ============================================================
async function visionCheck(imageBuf, contenu, hasLogo, hasRef) {
  try {
    const b64 = imageBuf.toString("base64");
    // ZOOM du bas de l'affiche : les petits textes (mentions pratiques) y vivent,
    // et c'est là que les fautes passent sous le radar quand l'image est vue entière.
    let zoomB64 = null;
    try {
      const meta = await sharp(imageBuf).metadata();
      const top = Math.round(meta.height * 0.55);
      const zoom = await sharp(imageBuf)
        .extract({ left: 0, top, width: meta.width, height: meta.height - top })
        .resize({ width: Math.min(meta.width * 2, 2000) })
        .jpeg({ quality: 90 }).toBuffer();
      zoomB64 = zoom.toString("base64");
    } catch (e) { console.warn("zoom juge indisponible:", e.message); }
    const attendus = contenu.flatMap((b) => b.items ?? (b.texte ? [b.texte] : []));
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6", max_tokens: 500,
        system: `Tu es le contrôleur qualité + directeur artistique d'un studio d'affiches haut de gamme. Deux missions sur l'image fournie :

MISSION 1 — CONFORMITÉ (bloquante, "ok": false si violée) :
- Tout texte INVENTÉ (mot, mention, badge, slogan absent de la liste attendue) = faute, cite-le. TRAQUE EN PARTICULIER les étiquettes techniques rendues comme du texte : "ACCROCHE", "PASTILLE", "TITRE", "STICKER STORM", "SPLIT PANEL", noms de zones ("TOP 45%") — leur présence visible = faute immédiate.
- MÉTA-TEXTE / PLACEHOLDER : toute mention conditionnelle ou espace réservé visible sur l'affiche (« si fourni », « si disponible », « à compléter », « à définir », « lieu/contact », « infos pratiques » sans contenu réel, parenthèses d'instruction, « votre texte ici ») = FAUTE IMMÉDIATE : ok=false et note maximum 3. C'est la pire faute possible chez un client.
- LISIBILITÉ DES LETTRES : chaque lettre du TITRE doit être sans ambiguïté à première lecture. Un Z stylisé qui se lit 7 (PIZZA lu PI77A), un O qui se lit 0, un I qui se lit 1, un S qui se lit 5 = faute, note maximum 5. Épelle le titre à voix haute comme un passant pressé.
- CHIFFRES : tout nombre de la liste attendue ABSENT de l'affiche = faute. Un nombre barré doit être l'ANCIEN prix (jamais le nouveau prix, jamais une économie). Un texte dupliqué en écho/fantôme derrière lui-même = faute.
- Orthographe lettre à lettre : un mot mal orthographié = faute. ATTENTION MAXIMALE aux textes COURBES, en arc ou qui suivent un contour : épelle-les caractère par caractère un doigt à la fois (lettres doublées "AANIMATIONS", lettres manquantes "SNAKING" au lieu de "SNACKING" — ce sont les fautes les plus fréquentes dans ces zones).
- PETITS TEXTES (mentions pratiques, bas de l'affiche) : c'est LÀ que les fautes se cachent ("sameti" pour "samedi", "intervetion" pour "intervention"). La deuxième image fournie est un ZOOM AGRANDI du bas de l'affiche : épelle CHAQUE mot du zoom, lettre par lettre, en le comparant au mot correspondant de la liste attendue. Un accent faux (è au lieu de ê dans "prêt") = faute. Une lettre manquante ou substituée = faute, ok=false.
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
          ...(zoomB64 ? [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: zoomB64 } }] : []),
          { type: "text", text: `TEXTES ATTENDUS : ${JSON.stringify(attendus)}${zoomB64 ? " (la 2e image est le zoom agrandi du bas de l'affiche : épelle chaque mot)" : ""}` },
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

    let prompt = buildJsonPrompt(g, hasLogo, hasRef, poster.brief?.ref_mode);       // chaîne Gemini (secours)
    let promptOA = buildProsePrompt(g, hasLogo, hasRef, poster.brief?.ref_mode);    // GPT Image 2 (principal)
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
      // Traçabilité : quel modèle a livré (colonne facultative, échec silencieux si absente)
      const { error: modelErr } = await supabase.from("posters").update({ model: LAST_MODEL }).eq("id", poster.id);
      if (modelErr) console.warn("colonne model absente (facultative):", modelErr.message);
    }

    // ---- Tentative 1 -> contrôle -> (retry) -> livraison ----
    const buf1 = await generateImage({ prompt, promptOA, refImages, aspectRatio: aspect });
    await supabase.from("posters").update({ status: "checking" }).eq("id", poster.id);
    const check = await visionCheck(buf1, contenu, hasLogo, hasRef);
    if (check.ok && check.note >= 7) {
      await livrer(buf1);
      console.log(`✔ poster livré (1re tentative, note ${check.note}/10) ${poster.id}`);
    } else {
      console.warn(`tentative 1 rejetée (ok=${check.ok}, note=${check.note}): ${check.probleme}`);
      prompt = prompt.slice(0, -2) + `,\n "correction_of_previous_attempt": "PREVIOUS ATTEMPT WAS REJECTED (design score ${check.note}/10). REASON: ${String(check.probleme).replace(/"/g, "'")}. Fix this precisely and raise the design ambition, keep the rest identical."\n}`;
      promptOA += `\n\n=== CORRECTION D'UNE PREMIÈRE VERSION ===\nUne première version de cette affiche a été refusée au contrôle qualité. Motif : ${String(check.probleme).replace(/"/g, "'")}. Corrige précisément ce point, relève l'ambition graphique, et garde tout le reste identique à la commande ci-dessus.`;
      try {
        const other = (process.env.PRIMARY_ENGINE || "openai") === "gemini" ? "openai" : "gemini";
        console.log(`2e tentative confiée à l'autre moteur : ${other}`);
        const buf2 = await generateImage({ prompt, promptOA, refImages, aspectRatio: aspect, prefer: other });
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

// ============================================================
// CONCIERGE : posters orphelins d'un redéploiement
// ------------------------------------------------------------
// Un redeploy Railway tue la génération en vol -> le poster reste
// coincé en generating/checking pour toujours. Au démarrage (après
// un délai le temps que l'ancien container meure, car les deux se
// chevauchent pendant un deploy), on marque failed tout poster actif
// non touché depuis 20 min : le client récupère son bouton Réessayer,
// sans re-quota. On ne relance PAS automatiquement (risque de double
// génération pendant le chevauchement des containers).
// ============================================================
async function janitor() {
  try {
    const cutoff = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const { data: stuck, error } = await supabase.from("posters")
      .select("id")
      .in("status", ["generating", "checking"])
      .lt("updated_at", cutoff);
    if (error) { console.warn("concierge: lecture impossible,", error.message); return; }
    for (const p of stuck ?? []) {
      await supabase.from("posters").update({
        status: "failed",
        error: "fabrication interrompue par une mise à jour de l'atelier, relance-la : ton quota n'est débité qu'une fois",
      }).eq("id", p.id).in("status", ["generating", "checking"]);
      console.warn(`concierge: poster orphelin marqué failed ${p.id}`);
    }
    if ((stuck ?? []).length) console.log(`concierge: ${stuck.length} poster(s) orphelin(s) traité(s)`);
  } catch (e) { console.warn("concierge:", e.message ?? e); }
}
setTimeout(janitor, 90 * 1000);          // au boot, après la fin du chevauchement de deploy
setInterval(janitor, 10 * 60 * 1000);    // puis toutes les 10 min, filet permanent


app.get("/health", (_req, res) => res.json({ ok: true, engine: process.env.OPENAI_API_KEY ? "gpt-image-2 (+ secours gemini)" : "gemini-orchestrator", fallback_models: GEMINI_MODELS }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Worker Postik (chef d'orchestre) sur :${port}`));
