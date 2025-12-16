export default {
	blockLists: [
		"https://easylist.to/easylist/easylist.txt",
		"https://easylist.to/easylist/easyprivacy.txt"
	],

	listRefreshIntervalMs: 1000 * 60 * 60 * 12, // 12h

	cache: {
		maxEntries: 5000,
		maxAgeMs: 1000 * 60 * 60 * 6 // 6h
	},

	logBlocked: true
};
