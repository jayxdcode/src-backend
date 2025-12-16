import express from "express";
import fetch from "cross-fetch";
import * as cheerio from "cheerio";
import { isBlocked } from "./adblockEngine.js";
import { getCached, setCached } from "./cache.js";
import config from "./config.default.js";

/* -------------------------------------------------
	Shared network monkey patch
------------------------------------------------- */
const NETWORK_PATCH = `
(() => {
	const PROXY = "/adblock/proxy?url=";

	const shouldProxy = (url) => {
		try {
			const u = new URL(url, location.href);
			return u.protocol === "http:" || u.protocol === "https:";
		} catch {
			return false;
		}
	};

	const toProxy = (url) =>
		PROXY + encodeURIComponent(url);

	const _fetch = window.fetch;
	window.fetch = function(input, init) {
		if (typeof input === "string" && shouldProxy(input)) {
			input = toProxy(input);
		} else if (input instanceof Request && shouldProxy(input.url)) {
			input = new Request(
				toProxy(input.url),
				input
			);
		}
		return _fetch.call(this, input, init);
	};

	const open = XMLHttpRequest.prototype.open;
	XMLHttpRequest.prototype.open = function(m, u, ...r) {
		if (shouldProxy(u)) {
			u = toProxy(u);
		}
		return open.call(this, m, u, ...r);
	};

	console.debug("[proxy] fetch/XHR patched");
})();
`;

/* -------------------------------------------------
	Router
------------------------------------------------- */
export function createProxyRouter() {
  const router = express.Router();
  
  // -------- Resource proxy --------
  router.get("/adblock/r", async (req, res) => {
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
    
    const upstream = await fetch(target);
    const buf = Buffer.from(await upstream.arrayBuffer());
    
    const headers = {};
    upstream.headers.forEach((v, k) => headers[k] = v);
    
    setCached(target, { body: buf, headers }, config.cache.maxAgeMs);
    res.set(headers);
    res.send(buf);
  });
  
  router.get("/adblock/proxy", async (req, res) => {
    const target = req.query.url;
    const modeOverride = req.query.mode;
    
    if (!target) return res.sendStatus(400);
    
    /* ---------- Adblock check ---------- */
    if (isBlocked({
        url: target,
        type: "other",
        documentUrl: req.headers.referer
      })) {
      if (config.logBlocked) console.log("[BLOCK]", target);
      return res.sendStatus(403);
    }
    
    /* ---------- Cache ---------- */
    const cacheKey = target + "|" + (modeOverride || "auto");
    const cached = getCached(cacheKey);
    if (cached) {
      res.set(cached.headers);
      return res.send(cached.body);
    }
    
    /* ---------- Fetch upstream ---------- */
    const upstream = await fetch(target);
    const ct = upstream.headers.get("content-type") || "";
    const buf = Buffer.from(await upstream.arrayBuffer());
    
    const headers = {};
    upstream.headers.forEach((v, k) => headers[k] = v);
    
    /* ---------- Mode resolution ---------- */
    let mode = modeOverride;
    
    if (!mode) {
      if (ct.includes("text/html")) {
        mode = "html";
      } else if (
        ct.includes("javascript") ||
        ct.includes("ecmascript")
      ) {
        mode = "js";
      } else {
        mode = "raw";
      }
    }
    
    /* -------------------------------------------------
    	RAW passthrough
    ------------------------------------------------- */
    if (mode === "raw") {
      setCached(
        cacheKey, { body: buf, headers },
        config.cache.maxAgeMs
      );
      
      res.set(headers);
      return res.send(buf);
    }
    
    /* -------------------------------------------------
    	JS passthrough + patch injection
    ------------------------------------------------- */
    if (mode === "js") {
      headers["content-type"] ||= "application/javascript";
      
      const patchedJs =
        `;${NETWORK_PATCH}\n` +
        buf.toString("utf8");
      
      setCached(
        cacheKey, { body: patchedJs, headers },
        config.cache.maxAgeMs
      );
      
      res.set(headers);
      return res.send(patchedJs);
    }
    
    /* -------------------------------------------------
    	HTML rewrite + patch injection
    ------------------------------------------------- */
    const html = buf.toString("utf8");
    const $ = cheerio.load(html);
    
    $("script[src],link[href],img[src],iframe[src]").each((_, el) => {
      const attr = el.name === "link" ? "href" : "src";
      const val = $(el).attr(attr);
      
      if (val && /^https?:\/\//.test(val)) {
        $(el).attr(
          attr,
          `/adblock/proxy?url=${encodeURIComponent(val)}`
        );
      }
    });
    
    $("head").append(`
<script>
${NETWORK_PATCH}
</script>
`);
    
    const out = $.html();
    
    setCached(
      cacheKey, { body: out, headers },
      config.cache.maxAgeMs
    );
    
    res.set(headers);
    res.send(out);
  });
  
  return router;
}
