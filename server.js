// Load environment variables from the .env file
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const helmet = require('helmet'); // For security headers
const rateLimit = require('express-rate-limit'); // For rate limiting

const app = express();
const port = process.env.PORT || 3000;

// --- Custom Error for Flow Control ---
class NoProvidersAvailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NoProvidersAvailableError';
  }
}

// --- Database Setup (Caching) ---
const dbFile = './translations.db';
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) {
        console.error("Error opening database", err.message);
    } else {
        console.log("Connected to the SQLite database.");
        db.run(`CREATE TABLE IF NOT EXISTS cache (
            hash TEXT PRIMARY KEY,
            rom TEXT NOT NULL,
            transl TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
    }
});

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
app.use('/api/', apiLimiter);

// --- Standard Middleware ---
app.use(cors());
app.use(express.json({ limit: '50kb' }));

// --- API Keys from Environment Variables ---
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_API_KEY_2 = process.env.GOOGLE_API_KEY_2;
const GOOGLE_API_KEY_3 = process.env.GOOGLE_API_KEY_3;

// --- Helper Functions (Unchanged) ---
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

// --- AI Provider Functions (Unchanged) ---
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
].filter(p => p.key); // Filter out providers without a configured key

function getPrioritizedProviders() {
    return [...providersConfig].sort((a, b) => a.busy - b.busy);
}

// --- Main API Endpoint ---
app.post('/api/translate', async (req, res) => {
    const { lrcText, title } = req.body;
    if (!lrcText) return res.status(400).json({ error: 'lrcText is required in the request body.' });
    const lrcHash = generateHash(lrcText);
    console.log(`Request received for title: "${title || 'Unknown'}" (Hash: ${lrcHash.substring(0, 8)}...)`);

    if (inFlightRequests.has(lrcHash)) {
        console.log("Identical request in-flight. Awaiting result...");
        try {
            const result = await inFlightRequests.get(lrcHash);
            return res.json(result);
        } catch (error) {
            // Check if the in-flight request failed because providers were busy
            if (error instanceof NoProvidersAvailableError) {
                return res.status(503).set('Retry-After', 30).json({ error: error.message });
            }
            return res.status(500).json({ error: "The initial request failed. Please try again." });
        }
    }
    try {
        const row = await new Promise((resolve, reject) => { db.get("SELECT rom, transl FROM cache WHERE hash = ?", [lrcHash], (err, row) => err ? reject(err) : resolve(row)); });
        if (row) {
            console.log("Cache hit. Returning cached result.");
            return res.json({ rom: row.rom, transl: row.transl });
        }
        console.log("Cache miss. Proceeding to AI providers.");
    } catch (dbError) { console.error("Database check failed:", dbError); }

    const fetchAndCache = async () => {
        const systemIns = `
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
        const userPrompt = `Title of song: ${title}\n\LRC input:\n${lrcText}`;
        const combinedPrompt = `${systemIns}\n\n${userPrompt}`;

        const prioritizedProviders = getPrioritizedProviders();

        // **NEW**: Check if all providers are busy before proceeding.
        if (!prioritizedProviders.length || prioritizedProviders[0].busy) {
            console.warn("All providers are busy. Rejecting request temporarily.");
            throw new NoProvidersAvailableError("All AI providers are currently busy. Please try again shortly.");
        }

        let lastError = null;
        for (const provider of prioritizedProviders) {
            // Since we checked for busy state above, we can now attempt a request.
            // If this provider is busy, the sort pushed it to the end, and we'll only
            // reach it if all idle providers before it have failed.
            if (provider.busy) continue;

            try {
                provider.busy = true;
                console.log(`Attempting translation with provider: ${provider.id}`);
                const result = await provider.fn(combinedPrompt, provider.key, provider.model);
                console.log(`Success with provider: ${provider.id}`);
                const finalResult = { rom: result.rom.replace(/\\n/g, '\n'), transl: result.transl.replace(/\\n/g, '\n') };
                db.run("INSERT OR IGNORE INTO cache (hash, rom, transl) VALUES (?, ?, ?)", [lrcHash, finalResult.rom, finalResult.transl], (err) => {
                    if (err) console.error("Failed to write to cache:", err.message);
                    else console.log("Result successfully cached.");
                });
                return finalResult;
            } catch (error) {
                console.error(`Provider ${provider.id} failed:`, error.message);
                lastError = error;
            } finally {
                provider.busy = false; // Free up the provider
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
        // **NEW**: Specific handling for the "all busy" case
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

// 5. Add a server-wide timeout to prevent slowloris attacks
server.setTimeout(30000); // 30 seconds

// --- Graceful Shutdown ---
process.on('SIGINT', () => {
    console.log('Shutting down gracefully...');
    server.close(() => {
        console.log('Server closed.');
        db.close((err) => {
            if (err) {
                console.error(err.message);
            }
            console.log('Closed the database connection.');
            process.exit(0);
        });
    });
});
