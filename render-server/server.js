// Load environment variables from the .env file
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@libsql/client');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const os = require('os'); // For system status

const app = express();
const port = process.env.PORT || 3000;

// --- Custom Error for Flow Control ---
class NoProvidersAvailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NoProvidersAvailableError';
  }
}

// --- Database Setup (Turso) ---
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

// Asynchronously create the table if it doesn't exist
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
        process.exit(1); // Exit if we can't set up the database
    }
})();

// --- In-flight Request Handling ---
const inFlightRequests = new Map();

// --- Security Middleware (DDOS Protection & Hardening) ---
app.use(helmet());
const apiLimiter = rateLimit({
	windowMs: 15 * 60 * 1000,
	limit: 100,
	standardHeaders: 'draft-7',
	legacyHeaders: false,
    message: { error: 'Too many requests, please try again after 15 minutes.' },
});
// Apply rate limiter only to the API endpoint
app.use('/api/', apiLimiter);

// --- Standard Middleware ---
app.use(cors());
app.use(express.json({ limit: '50kb' }));

// --- API Keys from Environment Variables ---
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_API_KEY_2 = process.env.GOOGLE_API_KEY_2;
const GOOGLE_API_KEY_3 = process.env.GOOGLE_API_KEY_3;

// --- Helper Functions ---
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
    function pad(s) {
        return (s < 10 ? '0' : '') + s;
    }
    const days = Math.floor(seconds / (24 * 3600));
    seconds %= (24 * 3600);
    const hours = Math.floor(seconds / 3600);
    seconds %= 3600;
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);

    return `${days}d ${pad(hours)}h ${pad(minutes)}m ${pad(secs)}s`;
}

// --- AI Provider Functions ---
async function googleAI(combinedPrompt, apiKey, modelName) {
    if (!apiKey) return Promise.reject(new Error(`Google AI (${modelName}) key is missing`));
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
    const payload = { contents: [{ parts: [{ text: combinedPrompt }] }] };
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!response.ok) throw new Error(`Google AI (${modelName}) error: ${response.status}`);
    const result = await response.json();
    const content = result.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const parsed = tryParse(content);
    if (!parsed) throw new Error(`Google AI (${modelName}) parsing failed`);
    return parsed;
}

// --- Provider Management ---
let providersConfig = [
    { id: 'google1_gemini2.0-flash', key: GOOGLE_API_KEY,   model: 'gemini-2.0-flash', fn: googleAI, busy: false },
    { id: 'google2_gemini2.0-flash', key: GOOGLE_API_KEY_2, model: 'gemini-2.0-flash', fn: googleAI, busy: false },
    { id: 'google3_gemini2.0-flash', key: GOOGLE_API_KEY_3, model: 'gemini-2.0-flash', fn: googleAI, busy: false },
    { id: 'google1_gemini1.5-flash', key: GOOGLE_API_KEY,   model: 'gemini-1.5-flash', fn: googleAI, busy: false },
    { id: 'google2_gemini1.5-flash', key: GOOGLE_API_KEY_2, model: 'gemini-1.5-flash', fn: googleAI, busy: false },
    { id: 'google3_gemini1.5-flash', key: GOOGLE_API_KEY_3, model: 'gemini-1.5-flash', fn: googleAI, busy: false },
].filter(p => p.key);

function getPrioritizedProviders() {
    return [...providersConfig].sort((a, b) => a.busy - b.busy);
}

// --- Status Endpoint (Root) ---
app.get('/', async (req, res) => {
    let dbStatus = 'disconnected';
    let dbLatency = -1;

    try {
        const startTime = performance.now();
        await db.execute('SELECT 1'); // Simple, fast query to check connection
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
            // NOTE: On Render, these reflect the underlying host, not just your container.
            cpuLoad: os.loadavg(), // [1m, 5m, 15m] load averages
            freeMemory: `${(os.freemem() / 1024 / 1024).toFixed(2)} MB`
        },
        storage: {
            note: 'Primary data storage is on Turso. Ephemeral disk space is managed by Render.'
        }
    };

    res.json(status);
});

// --- Main API Endpoint ---
app.post('/api/translate', async (req, res) => {
    const { lrcText, geniusTr, title, artist } = req.body;
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

    // --- Integrated Genius Scraper ---
    const geniusLyrics = geniusTr !== '' ? geniusTr : null;

    const fetchAndCache = async () => {
        // --- AI System Prompts ---
        const systemInsDefault = `
You are an LRC romanizer and translator.
Your response must be a single valid JSON object with exactly two keys: "rom" and "transl". Each value is a string of properly formatted LRC lines. Output only the JSON object, no markdown or any extra formatting.
Rules:
1. Preserve all metadata/tag lines (like [ti:], [ar:], [al:], credits) exactly as-is in both "rom" and "transl".
2. Preserve every timestamp (e.g. [00:05.00]) exactly.
3. For any line whose lyrics are entirely in English or any other Latin-alphabet script: In "rom" and "transl", output only the timestamp (e.g. "[00:12.34]") with no text following.
4. For any instrumental or musical marker lines: Output only the timestamp in both "rom" and "transl".
5. For non-Latin scripts: In "rom", romanize as sung (performance-style phonetics).
6. For non-English lines: In "transl", provide a natural, human-sounding English translation.
7. Mixed Latin + non-Latin on the same line: romanize every syllable (leave Latin words unchanged).
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
`.trim();

        const systemInsGenius = `
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
        if (geniusLyrics) {
            console.log("Using Genius-based prompt.");
            const userPrompt = `Title of song: ${title}\n\nOriginal LRC input:\n${lrcText}\n\nPre-existing English Translation to use:\n${geniusLyrics}`;
            combinedPrompt = `${systemInsGenius}\n\n${userPrompt}`;
        } else {
            console.log("Using default translation prompt.");
            const userPrompt = `Title of song: ${title}\n\nLRC input:\n${lrcText}`;
            combinedPrompt = `${systemInsDefault}\n\n${userPrompt}`;
        }

        const prioritizedProviders = getPrioritizedProviders();

        if (!prioritizedProviders.length || prioritizedProviders[0].busy) {
            console.warn("All providers are busy. Rejecting request temporarily.");
            throw new NoProvidersAvailableError("All AI providers are currently busy. Please try again shortly.");
        }

        let lastError = null;
        for (const provider of prioritizedProviders) {
            if (provider.busy) continue;

            try {
                provider.busy = true;
                console.log(`Attempting translation with provider: ${provider.id}`);
                const result = await provider.fn(combinedPrompt, provider.key, provider.model);
                console.log(`Success with provider: ${provider.id}`);
                const finalResult = { rom: result.rom.replace(/\\n/g, '\n'), transl: result.transl.replace(/\\n/g, '\n') };
                
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
            } catch (error) {
                console.error(`Provider ${provider.id} failed:`, error.message);
                lastError = error;
            } finally {
                provider.busy = false;
            }
        }

        console.error("All available AI providers failed.", lastError);
        throw new Error("All AI providers failed.");
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

// --- Start the server ---
const server = app.listen(port, () => {
    console.log(`Spotify Lyrics Backend listening at http://localhost:${port}`);
});

server.setTimeout(30000); // 30 seconds

// --- Graceful Shutdown ---
process.on('SIGINT', () => {
    console.log('Shutting down gracefully...');
    server.close(() => {
        console.log('Server closed.');
        db.close();
        console.log('Closed the database connection.');
        process.exit(0);
    });
});
