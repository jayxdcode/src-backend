// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { createClient } from '@libsql/client';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import os from 'os';

import config from "./config.default.js";
import { initAdblock, refreshLists } from "./adblockEngine.js";
import { createProxyRouter } from "./proxyMiddleware.js";
import { callProviders, getProviderModels } from './lib/googleAI.mjs';

const app = express();
const port = process.env.PORT || 3000;

// ---------- TRUST PROXY SETTING (fixes ERR_ERL_UNEXPECTED_X_FORWARDED_FOR) ----------
const tp = process.env.TRUST_PROXY;
if (tp !== undefined) {
  if (tp === 'true') app.set('trust proxy', true);
  else if (tp === 'false') app.set('trust proxy', false);
  else if (!Number.isNaN(Number(tp))) app.set('trust proxy', Number(tp));
  else app.set('trust proxy', tp);
} else {
  // Default to true for hosted environments (Render/Heroku) so rate limiter and req.ip work correctly.
  // If you want stricter behavior on local dev set TRUST_PROXY=false in your .env
  app.set('trust proxy', true);
}
// -------------------------------------------------------------------------------

// Start adblock proxy
await initAdblock();
setInterval(refreshLists, config.listRefreshIntervalMs);
app.use("/adblock/", createProxyRouter());

// Custom Error for Flow Control
class NoProvidersAvailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NoProvidersAvailableError';
  }
}

// Database Setup (Turso)
if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
    throw new Error('FATAL_ERROR: Turso database URL or auth token is not defined in .env file.');
}

const db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
    migrations: {
        loadMode: 'none'
    }
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
        console.log("Connected to Turso DB and ensured 'cache' table exists.");
    } catch (err) {
        console.error("Error initializing database schema:", err);
        process.exit(1);
    }
})();

// In-flight Request Handling
const inFlightRequests = new Map();

// Security Middleware
app.use(helmet());
// --- Server API Key Auth ---
const MASTER_API_KEY = process.env.SERVER_MASTER_API_KEY || '';
const CLIENT_API_KEYS = (process.env.SERVER_API_KEYS || '')
	.split(',')
	.map(k => k.trim())
	.filter(Boolean);

if (!MASTER_API_KEY) {
	console.warn('[WARN] SERVER_MASTER_API_KEY is not set. /api is unprotected!');
}

function apiKeyMiddleware(req, res, next) {
	const key =
		req.headers['x-api-key'] ||
		req.headers['authorization']?.replace(/^Bearer\s+/i, '');

	if (!MASTER_API_KEY) return next(); // dev fallback

	if (!key) {
		return res.status(401).json({ error: 'API key required' });
	}

	if (key === MASTER_API_KEY) {
		return next();
	}

	if (CLIENT_API_KEYS.includes(key)) {
		return next();
	}

	return res.status(403).json({ error: 'Invalid API key' });
}

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again after 15 minutes.' },
});
app.use('/api/', apiKeyMiddleware, apiLimiter);

// Standard Middleware
app.use(cors());
app.use(express.json({ limit: '50kb' }));

// Keep existing per-key env style variables for compatibility (optional)
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_API_KEY_2 = process.env.GOOGLE_API_KEY_2;
const GOOGLE_API_KEY_3 = process.env.GOOGLE_API_KEY_3;

// Helper functions (unchanged)
const tryParse = (text) => {
    if (!text) return null;
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end < 0) return null;
    try {
        const parsed = JSON.parse(text.slice(start, end + 1));
        if (parsed && parsed.rom && parsed.transl) return parsed;
        return null;
    } catch { return null; }
};

function generateHash(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

function formatUptime(seconds) {
    function pad(s) { return (s < 10 ? '0' : '') + s; }
    const days = Math.floor(seconds / (24 * 3600));
    seconds %= (24 * 3600);
    const hours = Math.floor(seconds / 3600);
    seconds %= 3600;
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${days}d ${pad(hours)}h ${pad(minutes)}m ${pad(secs)}s`;
}

app.get('/', async (req, res) => {
    const text = "I'm too lazy for a homepage lol. Go to /status for current status (not real-time tho)";
    res.send(text);
});

// Status endpoint (unchanged)
app.get('/status', async (req, res) => {
    let dbStatus = 'disconnected';
    let dbLatency = -1;

    try {
        const startTime = performance.now();
        // optional ping: await db.execute('SELECT 1');
        const endTime = performance.now();
        dbStatus = 'connected';
        dbLatency = parseFloat((endTime - startTime).toFixed(2));
    } catch (error) {
        console.error("Health check DB ping failed:", error.message);
    }

    const memoryUsage = process.memoryUsage();

    const status = {
        status: 'ok',
        uptime: formatUptime(process.uptime()),
        timestamp: new Date().toISOString(),
        database: {
            status: dbStatus,
            provider: 'Turso',
            latency_ms: dbLatency > -1 ? dbLatency : 'N/A'
        },
        memory: {
            rss: `${(memoryUsage.rss / 1024 / 1024).toFixed(2)} MB`,
            heapTotal: `${(memoryUsage.heapTotal / 1024 / 1024).toFixed(2)} MB`,
            heapUsed: `${(memoryUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`
        },
        platform: {
            cpuLoad: os.loadavg(),
            freeMemory: `${(os.freemem() / 1024 / 1024).toFixed(2)} MB`
        },
        storage: {
            note: 'Primary data storage is on Turso. Ephemeral disk space is managed by Render.'
        }
    };

    res.json(status);
});

// Main API endpoint
const MODEL_FALLBACK = process.env.MODEL_FALLBACK ? process.env.MODEL_FALLBACK.split(',').map(s => s.trim()).filter(Boolean) : getProviderModels();

app.post('/api/translate', async (req, res) => {
    const { lrcText, humanTr, title, artist } = req.body;
    if (!lrcText) return res.status(400).json({ error: 'lrcText is required in the request body.' });
    const lrcHash = generateHash(lrcText);
    console.log(`Request received for title: "${title || 'Unknown'}"`);
    console.log(`Artist: "${artist || 'Unknown'}"`);
    console.log(`Raw lrc Hash: ${lrcHash.substring(0, 8)}...)`);

    if (inFlightRequests.has(lrcHash)) {
        console.log("Identical request in-flight. Awaiting result...");
        try {
            const result = await inFlightRequests.get(lrcHash);
            return res.json(result);
        } catch (error) {
            if (error instanceof NoProvidersAvailableError) {
                return res.status(503).set('Retry-After', 30).json({ error: error.message });
            }
            return res.status(500).json({ error: "The initial request failed. Please try again." });
        }
    }

    try {
        const cacheResult = await db.execute({
            sql: "SELECT rom, transl FROM cache WHERE hash = ?",
            args: [lrcHash]
        });

        if (cacheResult.rows.length > 0) {
            console.log("Cache hit. Returning cached result.");
            const row = cacheResult.rows[0];
            return res.json({ rom: row.rom, transl: row.transl });
        }
        console.log("Cache miss. Proceeding to AI providers.");
    } catch (dbError) {
        console.error("Database check failed:", dbError);
    }

    const humanLyrics = humanTr !== '' ? humanTr : null;

    const fetchAndCache = async () => {
        const systemInsDefault = `
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
`.trim();

        const systemInsHuman = `
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
`.trim();

        let combinedPrompt;
        if (humanLyrics) {
            console.log("Using prompt for human-made tr/rom.");
            const userPrompt = `Title of song: ${title}\n\nOriginal LRC input:\n${lrcText}\n\nPre-existing English Translation to use:\n${humanLyrics}`;
            combinedPrompt = `${systemInsHuman}\n\n${userPrompt}`;
        } else {
            console.log("Using default translation prompt.");
            const userPrompt = `Title of song: ${title}\n\nLRC input:\n${lrcText}`;
            combinedPrompt = `${systemInsDefault}\n\n${userPrompt}`;
        }

        try {
            const { model, parsed } = await callProviders({ prompt: combinedPrompt, modelFallbackList: MODEL_FALLBACK });
            console.log(`Success with model: ${model}`);
            const finalResult = { rom: parsed.rom.replace(/\\n/g, '\n'), transl: parsed.transl.replace(/\\n/g, '\n') };

            try {
                await db.execute({
                    sql: "INSERT OR IGNORE INTO cache (hash, rom, transl) VALUES (?, ?, ?)",
                    args: [lrcHash, finalResult.rom, finalResult.transl]
                });
                console.log("Result successfully cached.");
            } catch (cacheErr) {
                console.error("Failed to write to cache:", cacheErr.message);
            }

            return finalResult;
        } catch (err) {
            console.error('All models failed:', err && err.message ? err.message : err);
            throw err;
        }
    };

    const promise = fetchAndCache();
    inFlightRequests.set(lrcHash, promise);
    try {
        const finalResult = await promise;
        res.json(finalResult);
    } catch (error) {
        if (error instanceof NoProvidersAvailableError) {
            res.status(503).set('Retry-After', 30).json({ error: error.message });
        } else {
            res.status(503).json({ error: "Service Unavailable: All AI translation providers failed." });
        }
    } finally {
        inFlightRequests.delete(lrcHash);
    }
});

// Start server
const server = app.listen(port, () => {
    console.log(`Spotify Lyrics Backend listening at http://localhost:${port}`);
});
server.setTimeout(30000);

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('Shutting down gracefully...');
    server.close(() => {
        console.log('Server closed.');
        db.close();
        console.log('Closed the database connection.');
        process.exit(0);
    });
});
