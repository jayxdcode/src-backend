import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { createClient } from '@libsql/client';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import os from 'os';
import fetch from "cross-fetch";
import { load as cheerioLoad } from "cheerio";

// Internal Library Imports
import config from "./config.default.js";
import { initAdblock, refreshLists, isBlocked } from "./adblockEngine.js";
import { getCached, setCached } from "./cache.js";
import { callProviders, getProviderModels } from './lib/googleAI.mjs';

const app = express();
const port = process.env.PORT || 3000;

const serverConfig = {
	defaultIns: `
You are an LRC romanizer and translator.
Your response must be a single valid JSON object with exactly two keys: "rom" and "transl". Each value is a string of properly formatted LRC lines. Output only the JSON object, no markdown or any extra formatting.
Rules:
1. Preserve all metadata/tag lines (like [ti:], [ar:], [al:], credits) exactly as-is in both "rom" and "transl".
2. Preserve every timestamp (e.g. [00:05.00]) exactly.
3. For any line whose lyrics are entirely in English or any other Latin-alphabet script: In "rom" and "transl", output only the timestamp (e.g. "[00:12.34]") with no text following.
4. For any instrumental or musical marker lines: Output only the timestamp in both "rom" and "transl".
5. For non-Eglish or generally, non Latin scripts: In "rom", romanize as sung (performance-style phonetics).
6. For non-English lines: In "transl", provide a natural, human-sounding English translation.
7. Mixed Latin + non-Latin on the same line: romanize every syllable (leave Latin words unchanged but remember to just return the timestamp if its fully English or generally, Latin script alphabet).
8. Escape newlines inside JSON strings as "\\n".
9. Do not add any explanation — return only the raw JSON object.
NOTE: If a line is mixed English and other language, do romanize and translate it.
Example output: {"rom":"[00:01.00] konnichiwa\\n[00:02.00]","transl":"[00:01.00] Hello\\n[00:02.00]"}
--
Handling a purely English line:
Original: [00:10.00] I don't care if it hurts
rom: [00:10.00]
transl: [00:10.00]
--
Also check the title as it may be present in the translation of non English songs that has English title.
`.trim(),

	humanTrIns: `
You are an expert LRC file formatter. You will be given an original LRC file and a pre-existing English translation.
Your task is to combine these into a single valid JSON object with two keys: "rom" (romanization) and "transl" (the provided translation, aligned).
Your response must be a single valid JSON object. Output only the JSON object, no markdown or any extra formatting.

Rules for "rom" (Romanization):
1. From the original LRC, romanize any non-Latin script lyrics as they are sung (performance-style phonetics).
2. If a line in the original LRC is entirely in English or other Latin script, output only the timestamp for that line (e.g., "[00:12.34]").
3. For mixed Latin + non-Latin lines, romanize the non-Latin parts and keep the Latin parts as they are.
4. Preserve all metadata ([ti:]) and timestamps exactly as they appear in the original LRC.
5. For instrumental lines, output only the timestamp.

Rules for "transl" (Translation Alignment):
1. Use the "Pre-existing English Translation" provided below. Your main job is to ALIGN its phrases with the timestamps from the original LRC.
2. If a line in the original LRC has no translatable content (e.g., it's instrumental or already English), output only the timestamp for that line in "transl".
3. Preserve all metadata ([ti:]) and timestamps exactly as they appear in the original LRC.

General Rules:
- Escape newlines inside JSON strings as "\\n".
- Do not add any explanation — return only the raw JSON object.
`.trim()
}

/* -------------------------------------------------
   1. SHARED CONSTANTS & MONKEY PATCH
------------------------------------------------- */
const NETWORK_PATCH = `
(() => {
	const PROXY = "/adblock/proxy?url=";
	const shouldProxy = (url) => {
		try {
			const u = new URL(url, location.href);
			return u.protocol === "http:" || u.protocol === "https:";
		} catch { return false; }
	};
	const toProxy = (url) => PROXY + encodeURIComponent(url);
	const _fetch = window.fetch;
	window.fetch = function(input, init) {
		if (typeof input === "string" && shouldProxy(input)) {
			input = toProxy(input);
		} else if (input instanceof Request && shouldProxy(input.url)) {
			input = new Request(toProxy(input.url), input);
		}
		return _fetch.call(this, input, init);
	};
	const open = XMLHttpRequest.prototype.open;
	XMLHttpRequest.prototype.open = function(m, u, ...r) {
		if (shouldProxy(u)) { u = toProxy(u); }
		return open.call(this, m, u, ...r);
	};
	console.debug("[proxy] fetch/XHR patched");
})();
`;

/* -------------------------------------------------
   2. TRUST PROXY & MIDDLEWARE
------------------------------------------------- */
const tp = process.env.TRUST_PROXY;
if (tp !== undefined) {
    if (tp === 'true') app.set('trust proxy', true);
    else if (tp === 'false') app.set('trust proxy', false);
    else if (!Number.isNaN(Number(tp))) app.set('trust proxy', Number(tp));
    else app.set('trust proxy', tp);
} else {
    app.set('trust proxy', true);
}

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '50kb' }));

/* -------------------------------------------------
   3. DATABASE & SERVICES INIT
------------------------------------------------- */
await initAdblock();
setInterval(refreshLists, config.listRefreshIntervalMs);

if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
    throw new Error('FATAL_ERROR: Turso database URL or auth token is not defined.');
}

const db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN
});

(async () => {
    try {
        await db.execute(`
            CREATE TABLE IF NOT EXISTS cache (
                hash TEXT PRIMARY KEY,
                rom TEXT NOT NULL,
                transl TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log("Connected to Turso DB.");
    } catch (err) {
        console.error("DB Init Error:", err);
        process.exit(1);
    }
})();

/* -------------------------------------------------
   4. AUTH & RATE LIMITING (for /api)
------------------------------------------------- */
const MASTER_API_KEY = process.env.SERVER_MASTER_API_KEY || '';
const CLIENT_API_KEYS = (process.env.SERVER_API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);

function apiKeyMiddleware(req, res, next) {
    const key = req.headers['x-api-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
    if (!MASTER_API_KEY) return next();
    if (!key) return res.status(401).json({ error: 'API key required' });
    if (key === MASTER_API_KEY || CLIENT_API_KEYS.includes(key)) return next();
    return res.status(403).json({ error: 'Invalid API key' });
}

const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: "Too many requests from this IP. Current limits: 10 req/min"
});

/* -------------------------------------------------
   5. ADBLOCK PROXY ROUTES (/adblock/...)
------------------------------------------------- */
const adblockRouter = express.Router();

// Resource Proxy (Images/Other)
adblockRouter.get("/r", async (req, res) => {
    const target = req.query.url;
    if (!target) return res.sendStatus(400);

    if (isBlocked({ url: target, type: "other", documentUrl: req.headers.referer })) {
        if (config.logBlocked) console.log("[BLOCK]", target);
        return res.sendStatus(403);
    }

    const cached = getCached(target);
    if (cached) {
        res.set(cached.headers);
        return res.send(cached.body);
    }

    try {
        const upstream = await fetch(target);
        const buf = Buffer.from(await upstream.arrayBuffer());
        const headers = {};
        upstream.headers.forEach((v, k) => headers[k] = v);

        setCached(target, { body: buf, headers }, config.cache.maxAgeMs);
        res.set(headers);
        res.send(buf);
    } catch (e) {
        res.status(502).send("Upstream error");
    }
});

// Main Proxy (HTML/JS/Raw)
adblockRouter.get("/proxy", async (req, res) => {
    const target = req.query.url;
    const modeOverride = req.query.mode;
    if (!target) return res.sendStatus(400);

    if (isBlocked({ url: target, type: "other", documentUrl: req.headers.referer })) {
        if (config.logBlocked) console.log("[BLOCK]", target);
        return res.sendStatus(403);
    }

    const cacheKey = target + "|" + (modeOverride || "auto");
    const cached = getCached(cacheKey);
    if (cached) {
        res.set(cached.headers);
        return res.send(cached.body);
    }

    try {
        const upstream = await fetch(target);
        const ct = upstream.headers.get("content-type") || "";
        const buf = Buffer.from(await upstream.arrayBuffer());
        const headers = {};
        upstream.headers.forEach((v, k) => headers[k] = v);

        let mode = modeOverride || (ct.includes("text/html") ? "html" : (ct.includes("javascript") ? "js" : "raw"));

        if (mode === "js") {
            headers["content-type"] = "application/javascript";
            const patchedJs = `;${NETWORK_PATCH}\n` + buf.toString("utf8");
            setCached(cacheKey, { body: patchedJs, headers }, config.cache.maxAgeMs);
            res.set(headers);
            return res.send(patchedJs);
        }

        if (mode === "html") {
            const $ = cheerioLoad(buf.toString("utf8"));
            $("script[src],link[href],img[src],iframe[src]").each((_, el) => {
                const attr = el.name === "link" ? "href" : "src";
                const val = $(el).attr(attr);
                if (val && /^https?:\/\//.test(val)) {
                    $(el).attr(attr, `/adblock/proxy?url=${encodeURIComponent(val)}`);
                }
            });
            $("head").append(`<script>${NETWORK_PATCH}</script>`);
            const out = $.html();
            setCached(cacheKey, { body: out, headers }, config.cache.maxAgeMs);
            res.set(headers);
            return res.send(out);
        }

        // Raw Mode
        setCached(cacheKey, { body: buf, headers }, config.cache.maxAgeMs);
        res.set(headers);
        res.send(buf);
    } catch (e) {
        res.status(502).send("Upstream error");
    }
});

// Mount the router under /adblock
app.use("/adblock", adblockRouter);

/* -------------------------------------------------
   6. TRANSLATION API LOGIC (/api/...)
------------------------------------------------- */
const inFlightRequests = new Map();
const MODEL_FALLBACK = process.env.MODEL_FALLBACK ? process.env.MODEL_FALLBACK.split(',').map(s => s.trim()).filter(Boolean) : getProviderModels();

app.post('/api/translate', apiKeyMiddleware, apiLimiter, async (req, res) => {
    const { lrcText, humanTr, title } = req.body;
    if (!lrcText) return res.status(400).json({ error: 'lrcText is required.' });
    
    const lrcHash = crypto.createHash('sha256').update(lrcText).digest('hex');

    if (inFlightRequests.has(lrcHash)) {
        try {
            return res.json(await inFlightRequests.get(lrcHash));
        } catch (e) { return res.status(500).json({ error: "Request failed" }); }
    }

    try {
        const cacheResult = await db.execute({ sql: "SELECT rom, transl FROM cache WHERE hash = ?", args: [lrcHash] });
        if (cacheResult.rows.length > 0) return res.json(cacheResult.rows[0]);
    } catch (dbError) { console.error("Cache Read Error", dbError); }

    const fetchAndCache = async () => {
        const systemPrompt = humanTr ? serverConfig.humanTrIns : serverConfig.defaultIns;
        const userPrompt = `Title: ${title}\nLRC:\n${lrcText}${humanTr ? `\nTranslation:\n${humanTr}` : ''}`;
        
        const { parsed } = await callProviders({ prompt: `${systemPrompt}\n\n${userPrompt}`, modelFallbackList: MODEL_FALLBACK });
        const finalResult = { rom: parsed.rom.replace(/\\n/g, '\n'), transl: parsed.transl.replace(/\\n/g, '\n') };

        db.execute({
            sql: "INSERT OR IGNORE INTO cache (hash, rom, transl) VALUES (?, ?, ?)",
            args: [lrcHash, finalResult.rom, finalResult.transl]
        }).catch(e => console.error("Cache Write Error", e));

        return finalResult;
    };

    const promise = fetchAndCache();
    inFlightRequests.set(lrcHash, promise);
    try {
        const result = await promise;
        res.json(result);
    } catch (err) {
        res.status(503).json({ error: "Translation service unavailable" });
        console.error(err.stack || err);
    } finally {
        inFlightRequests.delete(lrcHash);
    }
});

/* -------------------------------------------------
   7. STATUS & BASE ROUTES (+ DEBUG IP)
------------------------------------------------- */
app.get('/debug-ip', (req, res) => {
  res.json({
    'your-real-ip': req.ip,
    'forwarded-for-header': req.headers['x-forwarded-for']
  });
});

app.get('/status', async (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        database: 'Turso'
    });
});

app.get('/', (req, res) => res.send("LRC Proxy & Translation Server"));

/* -------------------------------------------------
   8. START SERVER
------------------------------------------------- */
const server = app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});

process.on('SIGINT', () => {
    server.close(() => {
        db.close();
        process.exit(0);
    });
});
