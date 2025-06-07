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

// 1. Set security-related HTTP headers with Helmet
app.use(helmet());

// 2. Configure the rate limiter
const apiLimiter = rateLimit({
	windowMs: 15 * 60 * 1000, // 15 minutes
	limit: 100, // Limit each IP to 100 requests per `window` (here, per 15 minutes)
	standardHeaders: 'draft-7', // Recommended: draft-7 specifies `RateLimit` header names
	legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    message: { error: 'Too many requests, please try again after 15 minutes.' },
});

// 3. Apply the rate limiting middleware to all API requests
app.use('/api/', apiLimiter);


// --- Standard Middleware ---
app.use(cors()); // For a production app, restrict to https://open.spotify.com

// 4. Limit request body size to prevent large payload attacks
app.use(express.json({ limit: '50kb' }));


// --- API Keys from Environment Variables ---
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_API_KEY_2 = process.env.GOOGLE_API_KEY_2;
const GOOGLE_API_KEY_3 = process.env.GOOGLE_API_KEY_3;
const HUGGINGFACE_API_KEY = process.env.HUGGINGFACE_API_KEY;
const CHUTES_API_KEY = process.env.CHUTES_API_KEY;

// --- Helper Functions (tryParse, generateHash) ---
// ... (These functions remain unchanged from the previous version)
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


// --- AI Provider Functions (googleAI, huggingfaceAI, chutesAI) ---
// ... (These functions remain unchanged from the previous version)
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
    console.log(`Success: Google AI (${modelName})`);
    return parsed;
}
async function huggingfaceAI(combinedPrompt) {
    if (!HUGGINGFACE_API_KEY) return Promise.reject(new Error("HuggingFace API key is missing"));
    const model = "mistralai/Mixtral-8x7B-Instruct-v0.1";
    const endpoint = `https://api-inference.huggingface.co/models/${model}`;
    const response = await fetch(endpoint, { headers: { "Authorization": `Bearer ${HUGGINGFACE_API_KEY}`, "Content-Type": "application/json", }, method: "POST", body: JSON.stringify({ inputs: combinedPrompt }), });
    if (!response.ok) throw new Error(`HuggingFace API error: ${response.status}`);
    const result = await response.json();
    const content = result[0]?.generated_text ?? "";
    const parsed = tryParse(content);
    if (!parsed) throw new Error("HuggingFace parsing failed");
    console.log("Success: HuggingFace");
    return parsed;
}
async function chutesAI(combinedPrompt) {
    if (!CHUTES_API_KEY) return Promise.reject(new Error("Chutes.ai API key is missing"));
    const model = "gemini-pro";
    const endpoint = 'https://api.chutes.ai/v1/chat/completions';
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Authorization': `Bearer ${CHUTES_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: model, messages: [{ role: 'user', content: combinedPrompt }] }) });
    if (!response.ok) throw new Error(`Chutes.ai API error: ${response.status}`);
    const result = await response.json();
    const content = result.choices?.[0]?.message?.content ?? '';
    const parsed = tryParse(content);
    if (!parsed) throw new Error('Chutes.ai parsing failed');
    console.log("Success: Chutes.ai");
    return parsed;
}


// --- Main API Endpoint (remains the same) ---
app.post('/api/translate', async (req, res) => {
    // ... The logic for caching, in-flight requests, and AI provider racing is unchanged
    const { lrcText, title } = req.body;
    if (!lrcText) return res.status(400).json({ error: 'lrcText is required in the request body.' });
    const lrcHash = generateHash(lrcText);
    console.log(`Request received for title: "${title || 'Unknown'}" (Hash: ${lrcHash.substring(0, 8)}...)`);
    if (inFlightRequests.has(lrcHash)) {
        console.log("Identical request in-flight. Awaiting result...");
        try {
            const result = await inFlightRequests.get(lrcHash);
            return res.json(result);
        } catch (error) { return res.status(500).json({ error: "The initial request failed. Please try again." }); }
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
        const systemIns = `You are an LRC romanizer and translator... [rest of prompt]`.trim();
        const userPrompt = `Title of song: ${title}\n\nLRC input:\n${lrcText}`;
        const combinedPrompt = `${systemIns}\n\n${userPrompt}`;
        const providers = [
            googleAI(combinedPrompt, GOOGLE_API_KEY, "gemini-1.5-flash-latest"),
            googleAI(combinedPrompt, GOOGLE_API_KEY_2, "gemini-pro"),
            googleAI(combinedPrompt, GOOGLE_API_KEY_3, "gemini-1.5-pro-latest"),
            huggingfaceAI(combinedPrompt),
            chutesAI(combinedPrompt)
        ];
        try {
            const result = await Promise.any(providers);
            const finalResult = { rom: result.rom.replace(/\\n/g, '\n'), transl: result.transl.replace(/\\n/g, '\n') };
            db.run("INSERT INTO cache (hash, rom, transl) VALUES (?, ?, ?)", [lrcHash, finalResult.rom, finalResult.transl], (err) => {
                if (err) console.error("Failed to write to cache:", err.message);
                else console.log("Result successfully cached.");
            });
            return finalResult;
        } catch (error) {
            console.error("All AI providers failed.", error.errors || error);
            throw new Error("All AI providers failed.");
        }
    };
    const promise = fetchAndCache();
    inFlightRequests.set(lrcHash, promise);
    try {
        const finalResult = await promise;
        res.json(finalResult);
    } catch (error) { res.status(503).json({ error: "Service Unavailable: All AI translation providers failed." }); } finally {
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
    db.close((err) => {
        if (err) {
            console.error(err.message);
        }
        console.log('Closed the database connection.');
        process.exit(0);
    });
});
