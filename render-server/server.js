// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { createClient } from '@libsql/client/web';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import os from 'os';
import fetch from 'cross-fetch';
import { load as cheerioLoad } from 'cheerio';
import fs from 'fs';
import https from 'https';
import path from 'path';

// Internal Library Imports
import config from "./config.default.js";
import { initAdblock, refreshLists, isBlocked } from "./adblockEngine.js";
import { getCached, setCached } from "./cache.js";
import { callProviders, getProviderModels } from './lib/googleAI.mjs';

const app = express();
const port = process.env.PORT || 3000;

/* -------------------------------------------------
   LOGGING HELPERS (format matches your earlier style)
------------------------------------------------- */
function logIncoming(method, ip) {
	console.log(`====== INCOMING ${method} REQUEST FROM ${ip} =====`);
}

function adblockLog(level, msg, target) {
	// produce "[adblock]       INFO     processing request for target: target"
	const svc = '[adblock]';
	const lvl = (level || 'INFO').toUpperCase();
	// adjust padding similar to previous output
	console.log(svc.padEnd(15) + lvl.padEnd(9) + (msg || '') + (target ? ` ${target}` : ''));
}

/* -------------------------------------------------
   1. SHARED CONSTANTS & MONKEY PATCH
------------------------------------------------- */
const NETWORK_PATCH = (host) => {
	const template = `
(() => {
		try {
				if (window.concurredByMe) return;
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
				window.fetch.toString = () => "function fetch() { [native code] }";
				const open = XMLHttpRequest.prototype.open;
				XMLHttpRequest.prototype.open = function(m, u, ...r) {
						if (shouldProxy(u)) { u = toProxy(u); }
						return open.call(this, m, u, ...r);
				};
				console.debug("[proxy] fetch/XHR patched");
				window.parent.postMessage({ type: 'log', data: '[proxy] I haved conquered this domain. (Patched successfully!)' }, '*');
				window.concurredByMe = true;
		} catch (e) {
				console.error("[proxy] patch unsuccessful")
				window.parent.postMessage({ type: 'log', data: \`Patch failed.\\n\\n\${e}\` }, '*');
		}
})();
`;
	const changeHost = true;
	if (host && changeHost) return template.replace("location.href", `"${host}"`);
	else return template;
};

const HTML_PATH_HELPER = `
(function() {
    // The base URL of the site you are proxying
    const BASE_URL = location.href;
    // Define the attributes you want to monitor
    const TARGET_ATTRIBUTES = ['src', 'href', 'data-original-src', 'data-src', 'action'];

    const makeAbsolute = (element, attr) => {
        const value = element.getAttribute(attr);
        if (!value || value.startsWith('data:') || value.startsWith('blob:')) return;

        try {
            const absoluteURL = new URL(value, BASE_URL).href;
            if (value !== absoluteURL) {
                element.setAttribute(attr, absoluteURL);
            }
        } catch (e) {
            console.error(\`Failed to resolve URL: \${value}\`, e);
        }
    };

    const processNodes = (node) => {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        TARGET_ATTRIBUTES.forEach(attr => {
            if (node.hasAttribute(attr)) makeAbsolute(node, attr);
        });
        TARGET_ATTRIBUTES.forEach(attr => {
            const children = node.querySelectorAll(\`[\${attr}]\`);
            children.forEach(child => makeAbsolute(child, attr));
        });
    };

    processNodes(document.documentElement);

    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            if (mutation.type === 'childList') {
                mutation.addedNodes.forEach(node => processNodes(node));
            } else if (mutation.type === 'attributes') {
                if (TARGET_ATTRIBUTES.includes(mutation.attributeName)) {
                    makeAbsolute(mutation.target, mutation.attributeName);
                }
            }
        });
    });

    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: TARGET_ATTRIBUTES
    });

    console.log("Path absolute helper initialized.");
})();
`;

// Safe nuke helper
function stripHopByHop(headers) {
	const banned = new Set([
		'connection',
		'keep-alive',
		'proxy-authenticate',
		'proxy-authorization',
		'te',
		'trailer',
		'transfer-encoding',
		'upgrade',
		'content-length'
	]);

	for (const key of Object.keys(headers)) {
		if (banned.has(key.toLowerCase())) {
			delete headers[key];
		}
	}
}

/* -------------------------------------------------
   CA bundle loading & HTTPS agent
------------------------------------------------- */

let httpsAgent = new https.Agent({ rejectUnauthorized: true });

async function ensureCABundle() {
	const defaultPath = '/data/data/com.termux/files/usr/etc/tls/cert.pem';
	const caEnv = process.env.NODE_EXTRA_CA_CERTS;
	const caPath = caEnv || defaultPath;

	console.log(`[tls] Checking for CA bundle. NODE_EXTRA_CA_CERTS=${caEnv ?? '(unset)'}, defaultPath=${defaultPath}`);

	function loadCA(pathToLoad) {
		try {
			const ca = fs.readFileSync(pathToLoad);
			httpsAgent = new https.Agent({ ca });
			console.log(`[tls] Loaded CA bundle from: ${pathToLoad}`);
			return true;
		} catch (err) {
			console.warn(`[tls] Failed to load CA bundle from ${pathToLoad}: ${err.message}`);
			return false;
		}
	}

	if (caEnv) {
		if (fs.existsSync(caEnv)) {
			if (loadCA(caEnv)) return;
		} else {
			console.warn(`[tls] NODE_EXTRA_CA_CERTS is set but file does not exist: ${caEnv}`);
		}
	}

	if (fs.existsSync(defaultPath)) {
		if (loadCA(defaultPath)) return;
	}

	if (process.env.ALLOW_AUTO_INSTALL_CA === '1') {
		console.log('[tls] CA bundle missing. ALLOW_AUTO_INSTALL_CA=1 -> attempting to download cacert.pem to default path.');
		try {
			const res = await fetch('https://curl.se/ca/cacert.pem');
			if (!res.ok) throw new Error(`Failed to download CA bundle. status=${res.status}`);
			const buf = Buffer.from(await res.arrayBuffer());
			const dir = path.dirname(defaultPath);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(defaultPath, buf, { mode: 0o644 });
			console.log(`[tls] Downloaded CA bundle to ${defaultPath}`);
			if (loadCA(defaultPath)) return;
		} catch (err) {
			console.error('[tls] Auto-download of CA bundle failed:', err.message);
		}
	} else {
		console.warn('[tls] CA bundle missing and ALLOW_AUTO_INSTALL_CA is not set. To enable automatic download set ALLOW_AUTO_INSTALL_CA=1 (only for dev).');
	}

	console.warn('[tls] No CA bundle loaded. HTTPS requests may fail for hosts requiring system CAs from Termux.');
}

await ensureCABundle();

/**
 * fetchWithAgent(url, opts)
 * - wraps cross-fetch to automatically attach httpsAgent for https requests when not provided
 */
async function fetchWithAgent(url, opts = {}) {
	const options = { ...(opts || {}) };
	try {
		const u = (typeof url === 'string') ? url : (url && url.url);
		if (u && u.startsWith && u.startsWith('https:')) {
			if (!options.agent && !(url && url.agent)) {
				options.agent = httpsAgent;
			}
		}
	} catch (err) {
		// ignore parsing errors, use as-is
	}
	return fetch(url, options);
}

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
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true }));

/* -------------------------------------------------
   3. DATABASE & SERVICES INIT
------------------------------------------------- */
adblockLog('INFO', 'Initializing Adblock engine and starting list refresh interval...');
await initAdblock();
setInterval(refreshLists, config.listRefreshIntervalMs);
adblockLog('INFO', 'Adblock engine loaded');

if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
	console.error('[init] FATAL: Turso DB credentials missing in environment.');
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
		console.log("[init] Connected to Turso DB.");
	} catch (err) {
		console.error("[init] DB Init Error:", err);
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
	windowMs: 15 * 60 * 1000,
	limit: 100,
	standardHeaders: 'draft-7',
	legacyHeaders: false,
});

/* -------------------------------------------------
   5. ADBLOCK ROUTER (method-specific)
------------------------------------------------- */
const adblockRouter = express.Router();

async function proxyCoreHandler(req, res, modeOverride) {
	logIncoming(req.method, req.ip);
	adblockLog('INFO', 'processing request for target:', req.query.url);

	const target = req.query.url;
	const modeQuery = modeOverride || req.query.mode;
	if (!target) return res.status(400).json({ error: 'missing required "url" parameter' });

	if (isBlocked({ url: target, type: 'other', documentUrl: req.headers.referer })) {
		if (config.logBlocked) adblockLog('INFO', 'BLOCK', target);
		return res.status(200).send('{}');
	}

	const cacheKey = target + '|' + (modeQuery || 'auto');
	const cached = getCached(cacheKey);
	if (cached) {
		if (config.logCache) adblockLog('INFO', 'Cache hit for target', target);
		res.set(cached.headers);
		return res.status(200).send(cached.body);
	}

	try {
		// Prepare upstream request headers
		const upstreamReqHeaders = { ...req.headers };
		stripHopByHop(upstreamReqHeaders);
		// We will request compressed data at first; if we need to modify text we will re-fetch with accept-encoding removed.

		const upstream = await fetchWithAgent(target, {
			method: req.method,
			headers: upstreamReqHeaders,
			body: ['GET', 'HEAD'].includes(req.method) ? undefined : req
		});

		// build plain object of upstream response headers
		const respHeaders = {};
		if (upstream.headers && typeof upstream.headers.forEach === 'function') {
			upstream.headers.forEach((v, k) => { respHeaders[k.toLowerCase()] = v; });
		}
		stripHopByHop(respHeaders);

		const ct = respHeaders['content-type'] || '';
		let mode = modeQuery || (ct.includes('text/html') ? 'html' : (ct.includes('javascript') ? 'js' : 'raw'));

		// Buffer & modify for JS/HTML
		if (mode === 'js' || mode === 'html') {
			// If upstream response is compressed, re-fetch with accept-encoding disabled
			if (upstream.headers && upstream.headers.has && upstream.headers.has('content-encoding')) {
				adblockLog('INFO', 'upstream response is compressed; re-fetching uncompressed for patching', target);
				delete upstreamReqHeaders['accept-encoding'];
				const upstream2 = await fetchWithAgent(target, {
					method: req.method,
					headers: upstreamReqHeaders,
					body: ['GET', 'HEAD'].includes(req.method) ? undefined : req
				});
				const buf2 = Buffer.from(await upstream2.arrayBuffer());
				if (mode === 'js') {
					respHeaders['content-type'] = 'application/javascript';
					const patchedJs = `;${NETWORK_PATCH(target)}\n` + buf2.toString('utf8');
					const out = Buffer.from(patchedJs, 'utf8');
					respHeaders['content-length'] = Buffer.byteLength(out);
					setCached(cacheKey, { body: out, headers: respHeaders }, config.cache.maxAgeMs);
					res.set(respHeaders);
					return res.status(upstream2.status).send(out);
				} else {
					const $ = cheerioLoad(buf2.toString('utf8'));

					// inject base href so relative requests resolve to upstream origin
					try {
						const upstreamOrigin = new URL(target).origin;
						$('head').prepend(`<base href="${upstreamOrigin}">`);
					} catch (err) {
						adblockLog('INFO', 'failed to compute upstream origin for base tag', target);
					}

					$("script[src],link[href],img[src],iframe[src]").each((_, el) => {
						const attr = el.name === 'link' ? 'href' : 'src';
						const val = $(el).attr(attr);
						if (val) {
							$(el).attr(attr, `/adblock/proxy?url=${encodeURIComponent(new URL(val, target))}`);
						}
					});
					$("head").prepend(`<script>${HTML_PATH_HELPER}</script>`);
					$("head").prepend(`<script>${NETWORK_PATCH(target)}</script>`);
					const out = Buffer.from($.html(), 'utf8');
					respHeaders['content-type'] = 'text/html; charset=utf-8';
					respHeaders['content-length'] = Buffer.byteLength(out);
					setCached(cacheKey, { body: out, headers: respHeaders }, config.cache.maxAgeMs);
					res.set(respHeaders);
					return res.status(upstream2.status).send(out);
				}
			} else {
				// upstream was already uncompressed
				const buf = Buffer.from(await upstream.arrayBuffer());
				if (mode === 'js') {
					respHeaders['content-type'] = 'application/javascript';
					const patchedJs = `;${NETWORK_PATCH(target)}\n` + buf.toString('utf8');
					const out = Buffer.from(patchedJs, 'utf8');
					respHeaders['content-length'] = Buffer.byteLength(out);
					setCached(cacheKey, { body: out, headers: respHeaders }, config.cache.maxAgeMs);
					res.set(respHeaders);
					return res.status(upstream.status).send(out);
				} else {
					const $ = cheerioLoad(buf.toString('utf8'));

					// inject base href so relative requests resolve to upstream origin
					try {
						const upstreamOrigin = new URL(target).origin;
						$('head').prepend(`<base href="${upstreamOrigin}">`);
					} catch (err) {
						adblockLog('INFO', 'failed to compute upstream origin for base tag', target);
					}

					$("script[src],link[href],img[src],iframe[src]").each((_, el) => {
						const attr = el.name === 'link' ? 'href' : 'src';
						const val = $(el).attr(attr);
						if (val) {
							$(el).attr(attr, `/adblock/proxy?url=${encodeURIComponent(new URL(val, target))}`);
						}
					});
					$("head").prepend(`<script>${HTML_PATH_HELPER}</script>`);
					$("head").prepend(`<script>${NETWORK_PATCH(target)}</script>`);
					const out = Buffer.from($.html(), 'utf8');
					respHeaders['content-type'] = 'text/html; charset=utf-8';
					respHeaders['content-length'] = Buffer.byteLength(out);
					setCached(cacheKey, { body: out, headers: respHeaders }, config.cache.maxAgeMs);
					res.set(respHeaders);
					return res.status(upstream.status).send(out);
				}
			}
		}

		// Raw streaming: stream upstream body to client
		adblockLog('INFO', 'streaming raw asset for', target);
		// Optionally cache headers only for raw (avoid caching big bodies)
		setCached(cacheKey, { body: null, headers: respHeaders }, config.cache.maxAgeMs);
		res.writeHead(upstream.status, respHeaders);
		if (upstream.body && typeof upstream.body.pipe === 'function') {
			upstream.body.pipe(res);
		} else {
			const buf = Buffer.from(await upstream.arrayBuffer());
			res.end(buf);
		}
	} catch (e) {
		console.error('[adblock] ERROR endpoint /adblock/proxy:\n', e.stack || e);
		res.status(502).send(`Upstream error:\n\n ${e.stack ?? "no error stack available"}`);
	}
}

// Resource proxy (images/other) - GET/HEAD
async function resourceHandler(req, res) {
	logIncoming(req.method, req.ip);
	adblockLog('INFO', 'resource request', req.query.url);

	const target = req.query.url;
	if (!target) return res.status(400).json({ error: 'missing required "url" parameter' });

	if (isBlocked({ url: target, type: 'other', documentUrl: req.headers.referer })) {
		if (config.logBlocked) adblockLog('INFO', 'BLOCK', target);
		return res.status(200).send('{}');
	}

	const cached = getCached(target);
	if (cached) {
		adblockLog('INFO', 'resource cache hit for', target);
		res.set(cached.headers);
		return res.send(cached.body);
	}

	try {
		const upstreamReqHeaders = { ...req.headers };
		stripHopByHop(upstreamReqHeaders);
		const upstream = await fetchWithAgent(target, {
			method: req.method,
			headers: upstreamReqHeaders,
			body: ['GET', 'HEAD'].includes(req.method) ? undefined : req
		});

		const respHeaders = {};
		if (upstream.headers && typeof upstream.headers.forEach === 'function') {
			upstream.headers.forEach((v, k) => { respHeaders[k.toLowerCase()] = v; });
		}
		stripHopByHop(respHeaders);

		const buf = Buffer.from(await upstream.arrayBuffer());
		setCached(target, { body: buf, headers: respHeaders }, config.cache.maxAgeMs);
		res.set(respHeaders);
		return res.status(upstream.status).send(buf);
	} catch (e) {
		console.error('[adblock] ERROR endpoint /adblock/r:\n', e.stack || e);
		res.status(502).send(`Upstream error:\n\n ${e.stack ?? 'no error stack available'}`);
	}
}

// Register method-specific routes for adblock
adblockRouter.get('/r', resourceHandler);
adblockRouter.head('/r', resourceHandler);

adblockRouter.get('/proxy', (req, res) => proxyCoreHandler(req, res, req.query.mode));
adblockRouter.head('/proxy', (req, res) => proxyCoreHandler(req, res, req.query.mode));
adblockRouter.post('/proxy', (req, res) => proxyCoreHandler(req, res, req.query.mode));
adblockRouter.put('/proxy', (req, res) => proxyCoreHandler(req, res, req.query.mode));
adblockRouter.delete('/proxy', (req, res) => proxyCoreHandler(req, res, req.query.mode));
adblockRouter.options('/proxy', (req, res) => proxyCoreHandler(req, res, req.query.mode));

// Mount adblock router
app.use('/adblock', adblockRouter);

/* -------------------------------------------------
   Redirect fallbacks for iframe special endpoints
   (so requests hitting the proxy origin get redirected
    into the proxy or forwarded to real upstream)
------------------------------------------------- */
app.get(['/iframe_api', '/ytplayer_config'], (req, res) => {
	// compute upstream host from referer or default to youtube
	let upstreamHost = 'https://www.youtube.com';
	if (req.headers.referer) {
		try { upstreamHost = new URL(req.headers.referer).origin; } catch (e) {}
	}
	const upstream = upstreamHost + req.path;
	adblockLog('INFO', 'redirecting special path', req.path);
	// redirect into proxy pipeline so we can handle TLS / caching etc.
	return res.redirect(`/adblock/proxy?url=${encodeURIComponent(upstream)}`);
});

/* -------------------------------------------------
   6. API ROUTER (separated from adblock)
------------------------------------------------- */
const apiRouter = express.Router();

const inFlightRequests = new Map();
const MODEL_FALLBACK = process.env.MODEL_FALLBACK ? process.env.MODEL_FALLBACK.split(',').map(s => s.trim()).filter(Boolean) : getProviderModels();

apiRouter.post('/translate', apiKeyMiddleware, apiLimiter, async (req, res) => {
	const { lrcText, humanTr, title } = req.body;
	if (!lrcText) return res.status(400).json({ error: 'lrcText is required.' });

	const lrcHash = crypto.createHash('sha256').update(lrcText).digest('hex');

	if (inFlightRequests.has(lrcHash)) {
		try { return res.json(await inFlightRequests.get(lrcHash)); } catch (e) { return res.status(500).json({ error: 'Request failed' }); }
	}

	try {
		const cacheResult = await db.execute({ sql: 'SELECT rom, transl FROM cache WHERE hash = ?', args: [lrcHash] });
		if (cacheResult.rows.length > 0) return res.json(cacheResult.rows[0]);
	} catch (dbError) { console.error('Cache Read Error', dbError); }

	const fetchAndCache = async () => {
		const systemPrompt = humanTr ? 'You are an expert LRC file formatter...' : 'You are an LRC romanizer and translator...';
		const userPrompt = `Title: ${title}\nLRC:\n${lrcText}${humanTr ? `\nTranslation:\n${humanTr}` : ''}`;

		const { parsed } = await callProviders({ prompt: `${systemPrompt}\n\n${userPrompt}`, modelFallbackList: MODEL_FALLBACK });
		const finalResult = { rom: parsed.rom.replace(/\\n/g, '\n'), transl: parsed.transl.replace(/\\n/g, '\n') };

		try {
			await db.execute({ sql: 'INSERT OR IGNORE INTO cache (hash, rom, transl) VALUES (?, ?, ?)', args: [lrcHash, finalResult.rom, finalResult.transl] });
		} catch (e) { console.error('Cache Write Error', e); }

		return finalResult;
	};

	const promise = fetchAndCache();
	inFlightRequests.set(lrcHash, promise);
	try {
		const result = await promise;
		res.json(result);
	} catch (err) {
		res.status(503).json({ error: 'Translation service unavailable' });
	} finally {
		inFlightRequests.delete(lrcHash);
	}
});

app.use('/api', apiRouter);

/* -------------------------------------------------
   7. STATUS & BASE ROUTES
------------------------------------------------- */
app.get('/status', async (req, res) => {
	res.json({
		status: 'ok',
		uptime: process.uptime(),
		memory: process.memoryUsage(),
		database: 'Turso'
	});
});

app.get('/', (req, res) => res.send('LRC Proxy & Translation Server'));

/* -------------------------------------------------
   8. START SERVER
------------------------------------------------- */
const server = app.listen(port, () => {
	console.log(`Server running on port ${port}`);
	console.log('[init] Node version:', process.version, 'Platform:', process.platform, 'Arch:', process.arch);
});

process.on('SIGINT', () => {
	server.close(() => {
		db.close();
		process.exit(0);
	});
});
