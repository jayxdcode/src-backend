// frontend/adblock/adblockEngine.mjs

import fetch from "cross-fetch";
import { FiltersEngine } from "@ghostery/adblocker";
import config from "./config.default.js";

let engine = null;

export async function initAdblock() {
	engine = await FiltersEngine.fromLists(
		fetch,
		config.blockLists,
		{ enableCompression: true }
	);
	console.log("[adblock] engine loaded");
}

export function isBlocked({ url, type, documentUrl }) {
	if (!engine) return false;
	return engine.match(url, { type, documentUrl }).blocked;
}

export async function refreshLists() {
	console.log("[adblock] refreshing filter lists...");
	await initAdblock();
}
