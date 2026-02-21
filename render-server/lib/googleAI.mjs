// lib/googleAI.mjs
import fetch from 'cross-fetch';
import LZString from 'lz-string';

const DEBUG = !!process.env.DEBUG_RENDER_SERVER;

/**
 * Collect provider API keys from environment variables using the
 * existing per-key env style: GOOGLE_API_KEY, GOOGLE_API_KEY_2, GOOGLE_API_KEY3, ...
 */
function collectKeysFromEnv() {
  const envKeys = Object.keys(process.env)
    .filter(k => /^GOOGLE_API_KEY(?:_?\d+)?$/i.test(k));

  // Sort by trailing digits to get a stable order:
  envKeys.sort((a, b) => {
    const aNum = (a.match(/\d+$/) || ['1'])[0] | 0;
    const bNum = (b.match(/\d+$/) || ['1'])[0] | 0;
    return aNum - bNum;
  });

  return envKeys.map(k => process.env[k]).filter(Boolean);
}

const KEYS = collectKeysFromEnv();
if (KEYS.length === 0) {
  console.warn('[googleAI] No provider keys found via GOOGLE_API_KEY* environment variables.');
}

// MODEL fallback list (ordered). You can set MODEL_FALLBACK env var as comma-separated values
// RIP 1.5 models :<
// 2.0's gonna go on March :/
const DEFAULT_MODELS = ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];
const PROVIDER_MODELS = (process.env.MODEL_FALLBACK ? process.env.MODEL_FALLBACK.split(',').map(s => s.trim()).filter(Boolean) : DEFAULT_MODELS);

/* --- state for rotation/health --- */
let keyIndex = 0;
const keyCooldownUntil = KEYS.map(() => 0); // ms timestamp until key is considered cooling
const provider404Until = {}; // modelName -> ms timestamp until considered unhealthy

const now = () => Date.now();

function nextKey() {
  if (KEYS.length === 0) return null;
  for (let i = 0; i < KEYS.length; i++) {
    const idx = (keyIndex + i) % KEYS.length;
    if (keyCooldownUntil[idx] <= now()) {
      keyIndex = (idx + 1) % KEYS.length;
      return { key: KEYS[idx], idx };
    }
  }
  // fallback: return the current key even if cooling (best-effort)
  return { key: KEYS[keyIndex], idx: keyIndex };
}

function markKeyCooldown(idx, ms) {
  if (typeof idx !== 'number' || idx < 0 || idx >= keyCooldownUntil.length) return;
  keyCooldownUntil[idx] = now() + ms;
}

function markProvider404(model, cooldownMs = 5 * 60 * 1000) {
  provider404Until[model] = now() + cooldownMs;
}

function isProviderHealthy(model) {
  const until = provider404Until[model] || 0;
  return now() > until;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function callModel({ model, apiKey, prompt, timeoutMs = 12000 }) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;
  const body = { contents: [{ parts: [{ text: prompt }] }] };

  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(id);
    return res;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

/**
 * Extract a JSON object from a model response text.
 * The model often returns a textual blob — we attempt to find the first {...} substring and parse it.
 */
function parseJsonFromText(text) {
  if (!text || typeof text !== 'string') return null;
  // direct parse
  try {
    return JSON.parse(text);
  } catch (e) {
    // try to extract substring between first { and last }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const candidate = text.slice(start, end + 1);
      try {
        return JSON.parse(candidate);
      } catch (e2) {
        return null;
      }
    }
    return null;
  }
}

/**
 * Try the configured models in order. For each model, attempt up to maxRetries
 * with progressive exponential backoff and rotating keys.
 * Throws the last error if all models/keys fail.
 */
export async function callProviders({ prompt, modelFallbackList = PROVIDER_MODELS, maxRetries = 3 }) {
  let lastErr = null;
  const initialBackoff = Number(process.env.INITIAL_BACKOFF_MS || 200);
  const multiplier = Number(process.env.BACKOFF_MULTIPLIER || 2);

  for (const model of modelFallbackList) {
    if (!isProviderHealthy(model)) {
      if (DEBUG) console.warn(`[googleAI] skipping model ${model} (recent 404 cooldown)`);
      continue;
    }

    let attempt = 0;
    let backoff = initialBackoff;

    while (attempt <= maxRetries) {
      attempt++;
      const { key, idx } = nextKey() || { key: null, idx: null };
      if (!key) {
        lastErr = new Error('No API keys available (no process.env GOOGLE_API_KEY*)');
        break;
      }

      try {
        if (DEBUG) console.log(`[googleAI] calling model=${model} attempt=${attempt}`);
        const res = await callModel({ model, apiKey: key, prompt, timeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 12000) });

        if (res.status === 404) {
          markProvider404(model);
          lastErr = new Error(`model ${model} returned 404`);
          break; // go to next model
        }

        if (res.status === 429) {
          // mark key cooldown and retry with backoff
          if (idx !== null) {
            markKeyCooldown(idx, backoff * 5 + 1000);
          }
          lastErr = new Error(`model ${model} rate limited (429)`);
          if (attempt <= maxRetries) {
            await sleep(backoff);
            backoff *= multiplier;
            continue;
          }
          break;
        }

        const txt = await res.text().catch(() => '<no-body>');
        if (!res.ok) {
          lastErr = new Error(`model ${model} returned ${res.status}: ${txt}`);
          break;
        }

        const json = await res.json().catch(() => null);
        const content = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

        const parsed = parseJsonFromText(content);
        if (!parsed) {
          lastErr = new Error(`model ${model} returned unparsable content`);
          
          // verbosity exp (feb 22, 2026)
          const data = {model: model, json: json, txt: txt, content: content, parsed: parsed, __mResStat: res.status};
          const dbginfo = LZstring.compress(JSON.stringify(data));
          console.log(`[debug] compressed info (feed to LZstring.decompress): ${dbginfo}`);

          // try next model (break inner loop)
          break;
        }

        // successful parse
        return { model, parsed };
      } catch (err) {
        // Network/abort error
        lastErr = err;
        if (attempt <= maxRetries) {
          await sleep(backoff);
          backoff *= multiplier;
          continue;
        }
        break;
      }
    }
  }

  throw lastErr || new Error('All models failed');
}

export function getProviderModels() {
  return PROVIDER_MODELS.slice();
}
