// server.js (ESM)
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());
app.use(cors()); // dev: allow all origins. In prod restrict origins.

const PORT = process.env.PORT || 4000;
const DEEPINFRA_API_KEY = process.env.DEEPINFRA_API_KEY || "";
const DEV_FALLBACK = (process.env.DEV_FALLBACK || "true").toLowerCase() === "true";
const TEXT_MODEL = process.env.TEXT_MODEL || "meta-llama/Meta-Llama-3-8B-Instruct";
const IMAGE_MODEL = process.env.IMAGE_MODEL || "stabilityai/stable-diffusion-2-1";

// Simple health endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime(), time: Date.now() });
});

// Utility: fetch with timeout
async function fetchWithTimeout(url, options = {}, timeout = 60000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return resp;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

// Parse DeepInfra text response robustly (best-effort)
function extractTextFromDeepInfra(respJson) {
  // DeepInfra responses differ by model. Try a few common shapes:
  if (!respJson) return null;
  if (typeof respJson === "string") return respJson;
  if (respJson.output) return respJson.output;
  if (Array.isArray(respJson.results) && respJson.results[0]) {
    const r0 = respJson.results[0];
    return r0.output ?? r0.content ?? r0.text ?? JSON.stringify(r0);
  }
  if (respJson.choices && Array.isArray(respJson.choices) && respJson.choices[0]) {
    return respJson.choices[0].text ?? respJson.choices[0].message?.content ?? JSON.stringify(respJson.choices[0]);
  }
  if (respJson.detail && respJson.detail.error) return JSON.stringify(respJson.detail);
  return JSON.stringify(respJson);
}

app.post("/api/generate-story", async (req, res) => {
  try {
    const { genre = "fantasy", characters = [], paragraphs = 3, imagesPerParagraph = false } = req.body;
    const charStr = Array.isArray(characters) ? characters.join(", ") : characters;

    // Basic prompt template
    const prompt = `System: You are a helpful creative fiction writer.\nUser: Write a ${Number(paragraphs)}-paragraph ${genre} short story for adults. Characters: ${charStr}.\nConstraints: Each paragraph should be distinct and between 2-6 sentences. After the story include a 1-2 sentence preface/summary. Output only the story and the preface.`;

    // If DEV_FALLBACK=true, optionally skip calling DeepInfra when key missing or to avoid cost
    if (DEV_FALLBACK) {
      if (!DEEPINFRA_API_KEY) {
        console.warn("DEV_FALLBACK active and no DEEPINFRA_API_KEY set: returning dummy response.");
      } else {
        // You can still try to call DeepInfra while in DEV_FALLBACK, but fallback on error.
      }
    }

    // If no API key and fallback allowed -> return dummy immediately
    if (!DEEPINFRA_API_KEY && DEV_FALLBACK) {
      const paragraphsArr = Array.from({ length: Number(paragraphs || 1) }, (_, i) => `Paragraph ${i+1}: A short ${genre} scene featuring ${charStr || "characters"}.`);
      const dummyStory = paragraphsArr.join("\n\n") + `\n\nPreface: This is a placeholder summary.`;
      return res.json({ story: dummyStory, paragraphs: paragraphsArr, images: [] });
    }

    // ==== CALL DeepInfra Text model ====
    const modelUrl = `https://api.deepinfra.com/v1/inference/${TEXT_MODEL}`;
    let textResp;
    try {
      const resp = await fetchWithTimeout(modelUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${DEEPINFRA_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ input: prompt, max_output_tokens: 800 })
      }, 60000);
      // If upstream returns non-OK, parse body and surface meaningful message
      if (!resp.ok) {
        const bodyText = await resp.text();
        console.error("DeepInfra text model returned non-OK:", resp.status, bodyText.slice(0, 2000));
        // detect insufficient balance message
        if (bodyText.toLowerCase().includes("balance") || bodyText.toLowerCase().includes("top-up")) {
          return res.status(402).json({
            code: "insufficient_balance",
            message: "DeepInfra account has insufficient balance. Top up to enable inference.",
            detail: bodyText
          });
        }
        // other upstream error
        return res.status(502).json({ code: "upstream_error", status: resp.status, detail: bodyText });
      }
      textResp = await resp.json();
    } catch (err) {
      console.error("Error calling DeepInfra text model:", err && err.message ? err.message : err);
      if (DEV_FALLBACK) {
        console.warn("Falling back to dummy story due to DeepInfra error (DEV_FALLBACK=true).");
        const paragraphsArr = Array.from({ length: Number(paragraphs || 1) }, (_, i) => `Paragraph ${i+1}: A fallback ${genre} scene featuring ${charStr || "characters"}.`);
        const dummyStory = paragraphsArr.join("\n\n") + `\n\nPreface: This is a fallback placeholder.`;
        return res.json({ story: dummyStory, paragraphs: paragraphsArr, images: [] });
      }
      return res.status(502).json({ error: "network_or_upstream", message: String(err) });
    }

    const storyText = extractTextFromDeepInfra(textResp) ?? JSON.stringify(textResp);

    // Optionally generate images (slow & costs money). imagesPerParagraph boolean toggles it.
    const images = [];
    if (imagesPerParagraph) {
      try {
        // attempt to split story into paragraphs
        const paraArr = typeof storyText === "string" ? storyText.split(/\n{1,}/).filter(p => p.trim()).slice(0, paragraphs) : [storyText];
        for (let i = 0; i < paraArr.length; i++) {
          const p = paraArr[i];
          const imgPrompt = `Create an illustration for: ${p}\nStyle: cinematic, detailed, suitable for a book illustration.`;
          const imgUrl = `https://api.deepinfra.com/v1/inference/${IMAGE_MODEL}`;
          const resp = await fetchWithTimeout(imgUrl, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${DEEPINFRA_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ prompt: imgPrompt })
          }, 90000);
          if (!resp.ok) {
            const txt = await resp.text();
            console.error("DeepInfra image model returned non-OK:", resp.status, txt.slice(0, 1000));
            images.push({ error: `image_upstream_${resp.status}`, detail: txt });
            continue;
          }
          const imgJson = await resp.json();
          // Many image endpoints return either { url } or base64 in results - adapt if needed
          // Best-effort:
          const url = imgJson?.output_url ?? imgJson?.url ?? imgJson?.results?.[0]?.output ?? null;
          if (url) images.push({ url });
          else images.push({ raw: imgJson });
        }
      } catch (err) {
        console.error("Error generating images:", err);
        images.push({ error: "image_generation_failed", message: String(err) });
      }
    }

    // Send the parsed story and images back
    return res.json({ story: String(storyText), raw: textResp, images });

  } catch (err) {
    console.error("Unhandled server error:", err && err.stack ? err.stack : err);
    return res.status(500).json({ error: "server_error", message: String(err) });
  }
});

app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`));
