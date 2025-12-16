const memoryCache = new Map();

export function getCached(key) {
	const entry = memoryCache.get(key);
	if (!entry) return null;

	if (Date.now() > entry.expiry) {
		memoryCache.delete(key);
		return null;
	}
	return entry.data;
}

export function setCached(key, data, ttlMs) {
	memoryCache.set(key, {
		data,
		expiry: Date.now() + ttlMs
	});
}
