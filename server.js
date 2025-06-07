// Load environment variables from the .env file
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const port = process.env.PORT || 3000;

// --- Database Setup (Caching) ---
const dbFile = './translations.db';
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) {
        console.error("Error opening database", err.message);
    } else {
        console.log("Connected to the SQLite database.");
        // Create the cache table if it doesn't exist
        db.run(`CREATE TABLE IF NOT EXISTS cache (
            hash TEXT PRIMARY KEY,
            rom TEXT NOT NULL,
            transl TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
    }
});

// --- In-flight Request Handling ---
// This map holds promises for requests that are currently being processed.
// Key: lrcHash, Value: Promise that resolves with the translation result.
const inFlightRequests = new Map();

// --- Middleware ---
app.use(cors()); // For a production app, restrict to https://open.spotify.com
app.use(express.json());

// --- API Keys and Headers from Environment Variables ---
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_API_KEY_2 = process.env.GOOGLE_API_KEY_2; // Second key for concurrency
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const HUGGINGFACE_API_KEY = process.env.HUGGINGFACE_API_KEY; // For HuggingFace model

const HTTP_REFERER = process.env.HTTP_REFERER || "https://example.com";
const X_TITLE = process.env.X_TITLE || "SpotifyLyricsBackend";

// --- Helper Functions ---

/**
 * A utility to parse JSON from a model's raw text response.
 * @param {string} text - The raw text from the AI.
 * @returns {object|null} A parsed object or null if parsing fails.
 */
const tryParse = (text) => {
    if (!text) return null;
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end < 0) return null;
    try {
        const parsed = JSON.parse(text.slice(start, end + 1));
        // Ensure the parsed object has the required keys
        if (parsed && parsed.rom && parsed.transl) {
            return parsed;
        }
        return null;
    } catch {
        return null;
    }
};

/**
 * Hashes LRC text to create a unique, consistent key for caching.
 * @param {string} text - The raw LRC text.
 * @returns {string} A SHA256 hash.
 */
function generateHash(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

// --- AI Provider Functions (Refactored for Concurrency) ---
// Each function now returns a Promise that resolves with the parsed {rom, transl} object
// or rejects if the API call or parsing fails. This is crucial for Promise.any().

async function openRouterAI(combinedPrompt) {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
            "HTTP-Referer": HTTP_REFERER,
            "X-Title": X_TITLE,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model: "mistralai/mistral-7b-instruct:free",
            messages: [{ role: "user", content: combinedPrompt }]
        })
    });
    if (!response.ok) throw new Error(`OpenRouter API error: ${response.status}`);
    const result = await response.json();
    const content = result.choices?.[0]?.message?.content ?? "";
    const parsed = tryParse(content);
    if (!parsed) throw new Error("OpenRouter parsing failed");
    console.log("Success: OpenRouter");
    return parsed;
}

async function mistralAI(systemIns, rawLyrics) {
    const endpoint = `https://api.mistral.ai/v1/chat/completions`;
    const payload = {
        model: "mistral-small",
        messages: [{ role: "system", content: systemIns }, { role: "user", content: rawLyrics }]
    };
    const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${MISTRAL_API_KEY}` },
        body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error(`Mistral API error: ${response.status}`);
    const result = await response.json();
    const content = result.choices?.[0]?.message?.content ?? "";
    const parsed = tryParse(content);
    if (!parsed) throw new Error("Mistral parsing failed");
    console.log("Success: Mistral");
    return parsed;
}

async function googleAI(combinedPrompt, apiKey, modelName = "gemini-1.5-flash") {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
    const payload = { contents: [{ parts: [{ text: combinedPrompt }] }] };
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error(`Google AI (${modelName}) error: ${response.status}`);
    const result = await response.json();
    const content = result.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const parsed = tryParse(content);
    if (!parsed) throw new Error(`Google AI (${modelName}) parsing failed`);
    console.log(`Success: Google AI (${modelName})`);
    return parsed;
}

async function huggingfaceAI(combinedPrompt) {
    // Using a popular free model on the HuggingFace Inference API
    const model = "mistralai/Mixtral-8x7B-Instruct-v0.1";
    const endpoint = `https://api-inference.huggingface.co/models/${model}`;
    const response = await fetch(endpoint, {
		headers: {
			"Authorization": `Bearer ${HUGGINGFACE_API_KEY}`,
			"Content-Type": "application/json",
		},
		method: "POST",
		body: JSON.stringify({ inputs: combinedPrompt }),
	});
    if (!response.ok) throw new Error(`HuggingFace API error: ${response.status}`);
    const result = await response.json();
    const content = result[0]?.generated_text ?? "";
    // The response from HF often includes the prompt, so we isolate the JSON part.
    const parsed = tryParse(content);
    if (!parsed) throw new Error("HuggingFace parsing failed");
    console.log("Success: HuggingFace");
    return parsed;
}

// --- Main API Endpoint ---
app.post('/api/translate', async (req, res) => {
    const { lrcText, title } = req.body;

    if (!lrcText) {
        return res.status(400).json({ error: 'lrcText is required in the request body.' });
    }

    const lrcHash = generateHash(lrcText);
    console.log(`Request received for title: "${title || 'Unknown'}" (Hash: ${lrcHash.substring(0, 8)}...)`);

    // 1. DEDUPLICATION: Check if this exact request is already in-flight
    if (inFlightRequests.has(lrcHash)) {
        console.log("Identical request in-flight. Awaiting result...");
        try {
            const result = await inFlightRequests.get(lrcHash);
            return res.json(result);
        } catch (error) {
            return res.status(500).json({ error: "The initial request failed. Please try again." });
        }
    }

    // 2. CACHING: Check the database for a cached result
    try {
        const row = await new Promise((resolve, reject) => {
            db.get("SELECT rom, transl FROM cache WHERE hash = ?", [lrcHash], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (row) {
            console.log("Cache hit. Returning cached result.");
            return res.json({ rom: row.rom, transl: row.transl });
        }
        console.log("Cache miss. Proceeding to AI providers.");
    } catch (dbError) {
        console.error("Database check failed:", dbError);
        // Don't halt; proceed to AI as if it's a cache miss.
    }

    // This function will be the core logic for fetching from AI providers
    const fetchAndCache = async () => {
        const systemIns = `
You are an LRC romanizer and translator...
// [The rest of your detailed prompt goes here, same as in your original file]
// ...
// ...
English title.
`.trim();

        const userPrompt = `Title of song: ${title}\n\nLRC input:\n${lrcText}`;
        const combinedPrompt = `${systemIns}\n\n${userPrompt}`;

        // 3. CONCURRENT AI REQUESTS: Create a list of promises to race
        const providers = [
            openRouterAI(combinedPrompt),
            mistralAI(systemIns, lrcText), // Mistral has a different signature
            googleAI(combinedPrompt, GOOGLE_API_KEY, "gemini-1.5-flash"),
            googleAI(combinedPrompt, GOOGLE_API_KEY_2, "gemini-pro"), // Using a second key/model
            huggingfaceAI(combinedPrompt)
            // Add another provider here if you have one
        ];

        try {
            // Promise.any() resolves with the value of the first promise that fulfills.
            const result = await Promise.any(providers);

            // Clean the result (remove escaped newlines) before caching and sending
            const finalResult = {
                rom: result.rom.replace(/\\n/g, '\n'),
                transl: result.transl.replace(/\\n/g, '\n')
            };

            // 4. CACHE THE NEW RESULT: Store the successful result in the database
            db.run(
                "INSERT INTO cache (hash, rom, transl) VALUES (?, ?, ?)",
                [lrcHash, finalResult.rom, finalResult.transl],
                (err) => {
                    if (err) console.error("Failed to write to cache:", err.message);
                    else console.log("Result successfully cached.");
                }
            );

            return finalResult; // This is the successful result
        } catch (error) {
            // This block is reached only if ALL promises in Promise.any() reject.
            console.error("All AI providers failed.", error.errors || error);
            throw new Error("All AI providers failed."); // Propagate error
        }
    };


    // Execute the logic and handle in-flight requests
    const promise = fetchAndCache();
    inFlightRequests.set(lrcHash, promise);

    try {
        const finalResult = await promise;
        res.json(finalResult);
    } catch (error) {
        res.status(503).json({ error: "Service Unavailable: All AI translation providers failed." });
    } finally {
        // IMPORTANT: Always remove the request from the in-flight map when it's done.
        inFlightRequests.delete(lrcHash);
    }
});

// --- Start the server ---
app.listen(port, () => {
    console.log(`Spotify Lyrics Backend listening at http://localhost:${port}`);
});

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
