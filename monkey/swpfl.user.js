// ==UserScript==
// @name         [Genius + AI Translations] Spotify Web Player Floating Lyrics
// @namespace    http://tampermonkey.net/
// @version      2025.06.11-0
// @description  Synced lyrics with translation and romanization display; strict OpenRouter API, robust merging, accurate LRC parsing, panel resizable/draggable, themed, opacity, supports transl/rom lines.
// @author       jayxdcode
// @match        https://open.spotify.com/*
// @grant        GM.xmlHttpRequest
// @connect      genuis.com
// @connect      google.com
// @cooyright      2025, jayxdcode
// @updateURL  https://raw.githubusercontent.com/jayxdcode/src-backend/main/monkey/swpfl.user.js
// ==/UserScript==


(function() {
    'use strict';
    
    const mobileDebug = true; // only set to true if you have eruda.
    
    const BACKEND_URL = "https://src-backend.onrender.com/api/translate";
    
    const HTTP_REFERER = "https://src-backend.onrender.com"; // optional but recommended
    const X_TITLE = "SpotifyLyricsUserScript"; // optional but recommended
    
    const POLL_INTERVAL = 1000;
    const STORAGE_KEY = 'tm-lyrics-panel-position';
    const SIZE_KEY = 'tm-lyrics-panel-size';
    const THEME_KEY = 'tm-lyrics-theme';
    const OPACITY_KEY = 'tm-lyrics-opacity';
    const CONFIG_KEY = 'tm-lyrics-config';
    
    let lyricsConfig = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}');
    // lyricsConfig shape:
    //   { "[title|artist]": { manualLrc: "<full LRC text>", offset: 1234 }, … }
    
    let lastCandidates = [];
    
    let currentTrackId = null;
    let currentTrackDur = null;
    let currInf = null;
    let syncIntervalId = null;
    let lyricsData = null;
    let observer = null;
    let isDragging = false;
    let dragLocked = false;
    let isResizing = false;
    let resizeStart = {};
    let openrouterCallCount = 0;
    let openrouterCalled = false;
    let currentOpacity = parseFloat(localStorage.getItem(OPACITY_KEY)) || 0.85;
    let currentTheme = localStorage.getItem(THEME_KEY) || 'dark';
    let lastRenderedIdx = -1;
    
    // --- Utility Functions ---
    function debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }
    
    // --- Panel viewport adjustment logic ---
    function handleViewportChange() {
        const panel = document.getElementById('tm-lyrics-panel');
        if (!panel) return;
        
        const rect = panel.getBoundingClientRect();
        const winWidth = window.innerWidth;
        const winHeight = window.innerHeight;
        
        const isOutOfBounds =
            rect.left < 0 ||
            rect.top < 0 ||
            rect.right > winWidth ||
            rect.bottom > winHeight;
        
        const isTooLarge =
            rect.width > winWidth ||
            rect.height > winHeight;
        
        if (isOutOfBounds || isTooLarge) {
            debug('Panel is out of bounds or too large for viewport. Adjusting...');
            
            // Clamp size to fit viewport with a small margin
            const newWidth = Math.min(rect.width, winWidth - 20);
            const newHeight = Math.min(rect.height, winHeight - 20);
            panel.style.width = newWidth + 'px';
            panel.style.height = newHeight + 'px';
            
            // Re-check rect after resize
            const newRect = panel.getBoundingClientRect();
            
            // Clamp position to keep the panel fully inside the viewport
            const newLeft = Math.max(10, Math.min(newRect.left, winWidth - newRect.width - 10));
            const newTop = Math.max(10, Math.min(newRect.top, winHeight - newRect.height - 10));
            panel.style.left = newLeft + 'px';
            panel.style.top = newTop + 'px';
            
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ left: panel.style.left, top: panel.style.top }));
            localStorage.setItem(SIZE_KEY, JSON.stringify({ width: panel.style.width, height: panel.style.height }));
        }
    }
    
    
    // Updated showManualLyricsMenu with overlay, Reset Pick button, and 3-line preview
    function showManualLyricsMenu(trackKey) {
        // Ensure we have candidates
        if (!lastCandidates || !lastCandidates.length) {
            const manualQuery = prompt('No lyric candidates available. Search manually:');
            if (manualQuery && manualQuery.trim() !== '') {
                loadLyrics('', '', '', currentTrackDur, (parsed) => {
                    lyricsData = parsed;
                    renderLyrics(0);
                    setupProgressSync(currInf.bar, currInf.duration);
                }, { flag: true, query: manualQuery });
            }
            return;
        }
        
        // Add blur overlay
        const existingOverlay = document.getElementById('tm-manual-overlay');
        if (existingOverlay) existingOverlay.remove();
        const overlay = document.createElement('div');
        overlay.id = 'tm-manual-overlay';
        Object.assign(overlay.style, {
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh',
            background: 'rgba(0,0,0,0.5)',
            backdropFilter: 'blur(5px)',
            zIndex: 9999
        });
        document.body.appendChild(overlay);
        
        // Remove any existing menu
        document.getElementById('tm-manual-menu')?.remove();
        
        // Container
        const menu = document.createElement('div');
        menu.id = 'tm-manual-menu';
        Object.assign(menu.style, {
            position: 'fixed',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: '90vw',
            maxWidth: '600px',
            maxHeight: '70vh',
            background: '#2a2a2a',
            color: '#fff',
            borderRadius: '12px',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            zIndex: 10000,
            boxShadow: '0 4px 20px rgba(0,0,0,0.5)'
        });
        document.body.appendChild(menu);
        
        // Header with title & close
        const header = document.createElement('div');
        header.textContent = 'Choose Lyrics Source';
        Object.assign(header.style, { padding: '12px 16px', fontWeight: 'bold', borderBottom: '1px solid #444', display: 'flex', justifyContent: 'space-between', alignItems: 'center' });
        const closeBtn = document.createElement('button');
        closeBtn.textContent = '×';
        Object.assign(closeBtn.style, { background: 'none', border: 'none', color: '#fff', fontSize: '20px', cursor: 'pointer' });
        closeBtn.onclick = () => {
            overlay.remove();
            menu.remove();
        };
        header.appendChild(closeBtn);
        menu.appendChild(header);
        
        // Scrollable list
        const list = document.createElement('div');
        Object.assign(list.style, { flex: '1', overflowY: 'auto', padding: '8px' });
        menu.appendChild(list);
        
        lastCandidates.forEach((c, idx) => {
            const panel = document.createElement('div');
            Object.assign(panel.style, { background: '#333', borderRadius: '8px', marginBottom: '8px', overflow: 'hidden' });
            
            // Summary row
            const summary = document.createElement('div');
            Object.assign(summary.style, { padding: '10px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' });
            summary.innerHTML = `<span>Candidate ${idx+1}</span><span style="font-size:12px; opacity:.7;">▼</span>`;
            panel.appendChild(summary);
            
            // 3-line preview
            const preview = document.createElement('pre');
            const lines = c.syncedLyrics ? c.syncedLyrics.trim().split('\n').slice(0, 3) : c.plainLyrics.trim().split('\n').slice(0, 3);
            preview.textContent = lines.join('\n');
            Object.assign(preview.style, { margin: '0 12px 8px', padding: '0', fontSize: '12px', lineHeight: '1.2', color: '#ccc' });
            panel.appendChild(preview);
            
            // Body (hidden full lyrics)
            const body = document.createElement('pre');
            body.textContent = c.syncedLyrics ? c.syncedLyrics.trim() : c.plainLyrics.trim();
            Object.assign(body.style, { margin: 0, padding: '8px 12px', fontSize: '13px', lineHeight: '1.4', whiteSpace: 'pre-wrap', display: 'none', background: '#2b2b2b' });
            panel.appendChild(body);
            
            // Toggle on click
            summary.onclick = () => {
                const isOpen = body.style.display === 'block';
                body.style.display = isOpen ? 'none' : 'block';
                summary.querySelector('span:last-child').textContent = isOpen ? '▼' : '▲';
            };
            
            list.appendChild(panel);
        });
        
        // Footer with offset input + buttons
        const footer = document.createElement('div');
        Object.assign(footer.style, { padding: '12px 16px', borderTop: '1px solid #444', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' });
        
        // Offset
        const offLabel = document.createElement('label');
        offLabel.textContent = 'Offset (ms):';
        Object.assign(offLabel.style, { fontSize: '14px' });
        const offInput = document.createElement('input');
        offInput.type = 'number';
        offInput.value = lyricsConfig[trackKey]?.offset || 0;
        Object.assign(offInput.style, { width: '60px', padding: '4px', borderRadius: '4px', border: '1px solid #555', background: '#444', color: '#fff' });
        footer.appendChild(offLabel);
        footer.appendChild(offInput);
        
        // Manual Search button
        const searchBtn = document.createElement('button');
        searchBtn.textContent = 'Manual Search';
        Object.assign(searchBtn.style, { padding: '6px 12px', background: 'none', color: '#fff', border: '2px solid #555', borderRadius: '4px', cursor: 'pointer' });
        searchBtn.onclick = () => {
            const manualQuery = prompt('Enter manual search query (e.g., song title and artist):');
            if (manualQuery && manualQuery.trim() !== '') {
                overlay.remove();
                menu.remove();
                loadLyrics('', '', '', currentTrackDur, (parsed) => {
                    lyricsData = parsed;
                    renderLyrics(0);
                    if (currInf) { setupProgressSync(currInf.bar, currInf.duration); }
                }, { flag: true, query: manualQuery });
            }
        };
        footer.appendChild(searchBtn);
        
        // Reset Pick button
        const resetBtn = document.createElement('button');
        resetBtn.textContent = 'Reset Pick';
        Object.assign(resetBtn.style, { padding: '6px 12px', background: 'none', color: '#fff', border: '2px solid #555', borderRadius: '4px', cursor: 'pointer' });
        resetBtn.onclick = () => {
            delete lyricsConfig[trackKey];
            localStorage.setItem(CONFIG_KEY, JSON.stringify(lyricsConfig));
        };
        footer.appendChild(resetBtn);
        
        // Use Selected button
        const useBtn = document.createElement('button');
        useBtn.textContent = 'Use Selected';
        Object.assign(useBtn.style, { padding: '6px 12px', background: 'none', color: '#fff', border: '2px solid #333', borderRadius: '4px', cursor: 'pointer' });
        useBtn.onclick = () => {
            const openBodies = Array.from(list.children)
                .filter(p => p.querySelector('pre:last-of-type').style.display === 'block');
            let rawLrc = openBodies.length ?
                openBodies[0].querySelector('pre:last-of-type').textContent :
                lastCandidates[0].syncedLyrics;
            const offset = parseInt(offInput.value, 10) || 0;
            
            lyricsConfig[trackKey] = { manualLrc: rawLrc, offset };
            localStorage.setItem(CONFIG_KEY, JSON.stringify(lyricsConfig));
            overlay.remove();
            menu.remove();
            
            const [t, a] = trackKey.split('|');
            loadLyrics(t, a, '', 0, parsed => {
                lyricsData = parsed;
                renderLyrics(0);
                setupProgressSync(null, 0);
            });
        };
        footer.appendChild(useBtn);
        
        menu.appendChild(footer);
    }
    
    // --- Panel creation and drag/resize logic ---
    function createPanel() {
        // Remove existing overlay
        document.getElementById('tm-lyrics-overlay')?.remove();
        
        // Overlay container
        const overlay = document.createElement('div');
        overlay.id = 'tm-lyrics-overlay';
        Object.assign(overlay.style, {
            position: 'fixed',
            top: '0',
            left: '0',
            width: '100vw',
            height: '100vh',
            zIndex: 9998,
            pointerEvents: 'none'
        });
        
        // Main panel
        const panel = document.createElement('div');
        panel.id = 'tm-lyrics-panel';
        Object.assign(panel.style, {
            position: 'fixed',
            width: '340px',
            height: '320px',
            minWidth: '460px',
            minHeight: '400px',
            boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
            borderRadius: '10px',
            fontSize: '25px',
            lineHeight: '1.6',
            padding: '0',
            overflow: 'hidden',
            pointerEvents: 'auto',
            userSelect: 'none',
            zIndex: 9999,
            border: '2px solid #333',
            display: 'flex', // Use Flexbox for robust layout
            flexDirection: 'column' // Stack items vertically
        });
        
        // Default position
        const defaultPos = { left: '100px', top: '100px' };
        const savedPos = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
        if (savedPos && savedPos.left && savedPos.top) {
            panel.style.left = savedPos.left;
            panel.style.top = savedPos.top;
        } else {
            panel.style.left = defaultPos.left;
            panel.style.top = defaultPos.top;
            localStorage.setItem(STORAGE_KEY, JSON.stringify(defaultPos));
        }
        
        // Restore size
        const savedSize = JSON.parse(localStorage.getItem(SIZE_KEY) || 'null');
        if (savedSize && savedSize.width && savedSize.height) {
            panel.style.width = savedSize.width;
            panel.style.height = savedSize.height;
        }
        
        // Header (drag handle)
        const header = document.createElement('div');
        header.id = 'tm-lyrics-header';
        Object.assign(header.style, {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '7px 14px',
            cursor: 'move',
            userSelect: 'none',
            borderTopLeftRadius: '10px',
            borderTopRightRadius: '10px',
            flexShrink: 0 // Prevent header from shrinking
        });
        
        // Title
        const title = document.createElement('span');
        title.id = 'tm-header-title';
        title.innerHTML = dragLocked ? '<b>Lyrics (Locked)</b>' : '<b>Lyrics</b>';
        header.appendChild(title);
        
        // Controls
        const controls = document.createElement('div');
        Object.assign(controls.style, { display: 'flex', gap: '8px', alignItems: 'center' });
        const opDown = document.createElement('button');
        opDown.id = 'opacity-down';
        opDown.textContent = '- Opacity';
        const opUp = document.createElement('button');
        opUp.id = 'opacity-up';
        opUp.textContent = '+ Opacity';
        
        opDown.addEventListener('click', () => {
            currentOpacity = Math.max(0.2, parseFloat((currentOpacity - 0.1).toFixed(2)));
            localStorage.setItem(OPACITY_KEY, currentOpacity);
            applyTheme(panel);
        });
        opUp.addEventListener('click', () => {
            currentOpacity = Math.min(1, parseFloat((currentOpacity + 0.1).toFixed(2)));
            localStorage.setItem(OPACITY_KEY, currentOpacity);
            applyTheme(panel);
        });
        
        const manualBtn = document.createElement('button');
        manualBtn.textContent = 'Manual LRC';
        manualBtn.onclick = () => {
            const trackKey = currentTrackId;
            showManualLyricsMenu(trackKey);
        };
        const ghIcon = document.createElement('div');
        ghIcon.style.display = 'flex';
        ghIcon.style.alignItems = 'center';
        ghIcon.style.paddingTop = '5px';
        ghIcon.style.fontSize = '14px';
        ghIcon.innerHTML = `
        <a href="https://github.com/jayxdcode" target="_blank" title="View on GitHub" style="opacity:0.8; color:white">
            jayxdcode <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" viewBox="0 0 16 16">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8"/>
            </svg>
        </a>`;
        
        controls.append(manualBtn, opDown, opUp, ghIcon);
        header.appendChild(controls);
        
        const btns = controls.querySelectorAll('button');
        btns.forEach(btn => {
            Object.assign(btn.style, {
                background: 'transparent',
                color: '#fff',
                border: '2px solid #333',
                borderRadius: '4px',
                padding: '6px 10px',
                fontSize: '14px',
                cursor: 'pointer',
                transition: 'opacity 0.2s'
            });
        });
        
        // Lyrics container
        const content = document.createElement('div');
        content.id = 'tm-lyrics-lines';
        Object.assign(content.style, {
            padding: '12px',
            overflowY: 'auto',
            scrollBehavior: 'smooth',
            flex: '1 1 auto', // Make content area fill remaining space
            minHeight: '0' // Crucial for flex + scroll
        });
        content.innerHTML = '<em>Lyrics will appear here</em>';
        
        // Resize handle
        const resizeHandle = document.createElement('div');
        resizeHandle.id = 'tm-lyrics-resize';
        Object.assign(resizeHandle.style, {
            position: 'absolute',
            right: '2px',
            bottom: '2px',
            width: '16px',
            height: '16px',
            cursor: 'nwse-resize',
            background: 'linear-gradient(135deg,transparent 60%,#888 60%)',
            opacity: 0.6
        });
        
        // Assemble the panel and add to DOM
        panel.appendChild(header);
        panel.appendChild(content);
        panel.appendChild(resizeHandle);
        overlay.appendChild(panel);
        document.body.appendChild(overlay);
        
        // Apply theme now that all elements are structured
        applyTheme(panel);
        
        // Drag logic
        let dragX = 0,
            dragY = 0;
        header.addEventListener('mousedown', e => {
            if (dragLocked) return;
            isDragging = true;
            dragX = e.clientX - panel.offsetLeft;
            dragY = e.clientY - panel.offsetTop;
            document.body.style.userSelect = 'none';
        });
        document.addEventListener('mousemove', e => {
            if (!isDragging) return;
            let x = e.clientX - dragX;
            let y = e.clientY - dragY;
            x = Math.min(Math.max(0, x), window.innerWidth - panel.offsetWidth);
            y = Math.min(Math.max(0, y), window.innerHeight - panel.offsetHeight);
            panel.style.left = x + 'px';
            panel.style.top = y + 'px';
        });
        document.addEventListener('mouseup', () => {
            if (!isDragging) return;
            isDragging = false;
            document.body.style.userSelect = '';
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ left: panel.style.left, top: panel.style.top }));
        });
        
        // Touch drag
        header.addEventListener('touchstart', e => {
            if (dragLocked) return;
            const t = e.touches[0];
            isDragging = true;
            dragX = t.clientX - panel.offsetLeft;
            dragY = t.clientY - panel.offsetTop;
            document.body.style.userSelect = 'none';
        }, { passive: false });
        document.addEventListener('touchmove', e => {
            if (!isDragging) return;
            const t = e.touches[0];
            let x = t.clientX - dragX;
            let y = t.clientY - dragY;
            x = Math.min(Math.max(0, x), window.innerWidth - panel.offsetWidth);
            y = Math.min(Math.max(0, y), window.innerHeight - panel.offsetHeight);
            panel.style.left = x + 'px';
            panel.style.top = y + 'px';
        }, { passive: false });
        document.addEventListener('touchend', () => {
            if (!isDragging) return;
            isDragging = false;
            document.body.style.userSelect = '';
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ left: panel.style.left, top: panel.style.top }));
        });
        
        // Resize logic
        let startW, startH, startX, startY;
        resizeHandle.addEventListener('mousedown', e => {
            isResizing = true;
            startW = panel.offsetWidth;
            startH = panel.offsetHeight;
            startX = e.clientX;
            startY = e.clientY;
            e.preventDefault();
            e.stopPropagation();
        });
        document.addEventListener('mousemove', e => {
            if (!isResizing) return;
            let w = Math.max(200, startW + e.clientX - startX);
            let h = Math.max(120, startH + e.clientY - startY);
            w = Math.min(w, window.innerWidth - panel.offsetLeft);
            h = Math.min(h, window.innerHeight - panel.offsetTop);
            panel.style.width = w + 'px';
            panel.style.height = h + 'px';
        });
        document.addEventListener('mouseup', () => {
            if (!isResizing) return;
            isResizing = false;
            localStorage.setItem(SIZE_KEY, JSON.stringify({ width: panel.style.width, height: panel.style.height }));
        });
        resizeHandle.addEventListener('touchstart', e => {
            const t = e.touches[0];
            isResizing = true;
            startW = panel.offsetWidth;
            startH = panel.offsetHeight;
            startX = t.clientX;
            startY = t.clientY;
            e.preventDefault();
            e.stopPropagation();
        }, { passive: false });
        document.addEventListener('touchmove', e => {
            if (!isResizing) return;
            const t = e.touches[0];
            let w = Math.max(200, startW + t.clientX - startX);
            let h = Math.max(120, startH + t.clientY - startY);
            w = Math.min(w, window.innerWidth - panel.offsetLeft);
            h = Math.min(h, window.innerHeight - panel.offsetTop);
            panel.style.width = w + 'px';
            panel.style.height = h + 'px';
        }, { passive: false });
        document.addEventListener('touchend', () => {
            if (!isResizing) return;
            isResizing = false;
            localStorage.setItem(SIZE_KEY, JSON.stringify({ width: panel.style.width, height: panel.style.height }));
        });
    }
    
    function applyTheme(panel) {
        const header = panel.querySelector('#tm-lyrics-header');
        if (currentTheme === 'light') {
            panel.style.background = `rgba(245, 245, 245, ${currentOpacity})`;
            panel.style.color = '#000';
            if (header) {
                header.style.background = `rgba(220, 220, 220, ${currentOpacity})`;
            }
        } else { // dark theme
            panel.style.background = `rgba(0, 0, 0, ${currentOpacity})`;
            panel.style.color = '#fff';
            if (header) {
                header.style.background = `rgba(33, 33, 33, ${currentOpacity})`;
            }
        }
    }
    
    function updateHeaderStyle(header, headerTitle) {
        if (dragLocked) {
            header.querySelectorAll('button').forEach(btn => {
                if (btn.id != 'tm-header-title') {
                    btn.style.display = dragLocked ? 'none' : 'block';
                }
            });
        }
        
        header.style.background = dragLocked ? '#888' : '#333';
        headerTitle.innerHTML = dragLocked ? '<b>Lyrics (Locked)</b>' : '<b>Lyrics</b>';
    }
    
    function gmFetch(url, headers = {}) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                headers,
                onload: res => resolve(res),
                onerror: err => reject(err)
            });
        });
    }
    
    async function parseAl(url) {
        try {
            if (!url) return '';
            const res = await fetch(url);
            const html = await res.text();
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const titleText = doc.querySelector('title')?.textContent;
            if (titleText) {
                const regex = /^(.*?) - Album by .*? \| Spotify$/;
                const match = titleText.match(regex);
                if (match && match.length > 1) {
                    return match[1];
                }
            }
        } catch (e) {
            debug('parseAl error:', e);
        }
        return '';
    }
    
    /**
     * Fetch up to 3 Genius English Translation links via strict Google search.
     * @param {string} title
     * @param {string} artist
     * @returns {Promise<string[]>} Array of up to 3 Genius URLs
     */
    async function fetchStrictGeniusLinks(title, artist) {
        if (!title || !artist) return [];
        
        const query = `site:genius.com ${title} ${artist} "(english translation)"`;
        const googleSearchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
        
        console.log(`🔍 Google search: ${googleSearchUrl}`);
        let searchRes;
        try {
            searchRes = await gmFetch(googleSearchUrl, {
                'User-Agent': 'Mozilla/5.0',
                'Accept': 'text/html'
            });
        } catch (err) {
            console.warn('❌ Failed to fetch Google search results:', err);
            return [];
        }
        
        // Parse result HTML
        const parser = new DOMParser();
        const doc = parser.parseFromString(searchRes.responseText, 'text/html');
        
        // Extract links matching https://genius.com/Genius-english-translations-*
        const anchors = Array.from(doc.querySelectorAll('a[href^="/url?q=https://genius.com/Genius-english-translations-"]'));
        const geniusLinks = [];
        
        for (let a of anchors) {
            if (geniusLinks.length >= 3) break;
            const href = a.getAttribute('href');
            const match = href.match(/\/url\?q=(https:\/\/genius\.com\/Genius-english-translations-[^&]+)/i);
            if (match && match[1]) {
                const decoded = decodeURIComponent(match[1]);
                if (!geniusLinks.includes(decoded)) geniusLinks.push(decoded);
            }
        }
        
        console.log('✅ Found Genius links:', geniusLinks);
        return geniusLinks;
    }
    
    async function fetchTranslations(userPrompt, title, artist) {
        try {
            const response = await fetch(BACKEND_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ lrcText: userPrompt, title: title, artist: artist }),
            });
            if (!response.ok) {
                console.error('Backend server returned an error: ', response.status);
                return { rom: "", transl: "" };
            }
            const data = await response.json();
            console.log('Recieved backend data: ', data);
            return data;
        } catch (error) {
            console.error('Failed fetch from backend server:', error);
            return { rom: "", transl: "" };
        }
    }
    
    function parseLRCToArray(lrc) {
        if (!lrc) return [];
        const lines = [];
        const regex = /\[(\d+):(\d+)(?:\.(\d+))?\](.*)/g;
        for (const raw of lrc.split('\n')) {
            let matches;
            let l = raw;
            while ((matches = regex.exec(l)) !== null) {
                const min = parseInt(matches[1], 10);
                const sec = parseInt(matches[2], 10);
                const ms = matches[3] ? parseInt(matches[3].padEnd(3, '0'), 10) : 0;
                const time = min * 60 * 1000 + sec * 1000 + ms;
                let text = l.replace(/\[\d+:\d+(?:\.\d+)?\]/g, '').trim();
                lines.push({ time, text });
            }
            regex.lastIndex = 0;
        }
        lines.sort((a, b) => a.time - b.time);
        if (lines.length && lines[0].time !== 0) {
            lines.unshift({ time: 0, text: '' });
        }
        return lines;
    }
    
    function mergeLRC(origArr, romArr, transArr) {
        const romMap = new Map();
        if (romArr)
            for (const r of romArr) romMap.set(r.time, r.text);
        const transMap = new Map();
        if (transArr)
            for (const t of transArr) transMap.set(t.time, t.text);
        return origArr.map(o => ({
            time: o.time,
            text: o.text,
            roman: romMap.get(o.time) || '',
            trans: transMap.get(o.time) || ''
        }));
    }
    
    function parseLRC(lrc, romLrc, translLrc) {
        const origArr = parseLRCToArray(lrc);
        const romArr = romLrc ? parseLRCToArray(romLrc) : [];
        const transArr = translLrc ? parseLRCToArray(translLrc) : [];
        return mergeLRC(origArr, romArr, transArr);
    }
    
    async function loadLyrics(title, artist, album, duration, onTransReady, manual = { flag: false, query: "" }) {
        if (!manual.flag) { debug('Searching for lyrics:', title, artist, album, duration); } else { debug(`Manually searching lyrics: using user prompt "${manual.query}"...`); }
        
        const trackKey = `${title}|${artist}`;
        
        try {
            // --- 1) Manual override check ---
            if (lyricsConfig[trackKey]?.manualLrc && !manual.flag) {
                const rawLrc = lyricsConfig[trackKey].manualLrc;
                const offset = lyricsConfig[trackKey].offset || 0;
                
                let origParsed = parseLRC(rawLrc, '', '');
                origParsed.forEach(line => line.time += offset);
                onTransReady(origParsed);
                
                const userPrompt = `Title of song: ${title}\n\nLRC input:\n${rawLrc}`;
                const { rom, transl } = await fetchTranslations(userPrompt, title, artist);
                
                const merged = parseLRC(rawLrc, rom, transl);
                merged.forEach(line => line.time += offset);
                onTransReady(merged);
                
                const metadata = encodeURIComponent([title, artist, album].filter(Boolean).join(' '));
                const searchUrl = `https://lrclib.net/api/search?q=${metadata}`;
                const searchRes = await fetch(searchUrl);
                if (searchRes.ok) lastCandidates = await searchRes.json();
                return;
            }
            
            // --- 2) Fetch from lrclib (with fallback) ---
            let searchData;
            const primaryMetadata = manual.flag ? encodeURIComponent(manual.query) : encodeURIComponent([title, artist, album].filter(Boolean).join(' '));
            const primarySearchUrl = `https://lrclib.net/api/search?q=${primaryMetadata}`;
            const primarySearchRes = await fetch(primarySearchUrl);
            if (!primarySearchRes.ok) throw new Error('Search HTTP error ' + primarySearchRes.status);
            searchData = await primarySearchRes.json();
            
            // --- FALLBACK LOGIC ---
            // If the initial search yields no synced lyrics, try again without the album.
            const hasSyncedResult = Array.isArray(searchData) && searchData.some(c => c.syncedLyrics);
            if (!hasSyncedResult && !manual.flag && album) {
                debug('Initial search (with album) had no synced lyrics. Retrying without album.');
                const fallbackMetadata = encodeURIComponent([title, artist].join(' '));
                const fallbackUrl = `https://lrclib.net/api/search?q=${fallbackMetadata}`;
                const fallbackRes = await fetch(fallbackUrl);
                if (fallbackRes.ok) {
                    const fallbackData = await fallbackRes.json();
                    if (Array.isArray(fallbackData) && fallbackData.length > 0) {
                        searchData = fallbackData; // Use fallback results if they are better
                    }
                }
            }
            
            lastCandidates = Array.isArray(searchData) ? searchData : [];
            
            // --- 3) Pick best candidate ---
            let candidate = null,
                minDelta = Infinity;
            for (const c of lastCandidates.filter(ca => ca.syncedLyrics)) {
                const delta = Math.abs(Number(c.duration) - duration);
                if (delta < minDelta && delta < 8000) {
                    candidate = c;
                    minDelta = delta;
                }
            }
            if (!candidate) { // If no synced lyrics match, try plain lyrics
                for (const c of lastCandidates) {
                    const delta = Math.abs(Number(c.duration) - duration);
                    if (delta < minDelta && delta < 8000) {
                        candidate = c;
                        minDelta = delta;
                    }
                }
            }
            if (!candidate) candidate = lastCandidates[0] || null;
            
            // --- 4) Process candidate (synced or plain) ---
            if (!candidate || (!candidate.syncedLyrics && !candidate.plainLyrics)) {
                onTransReady([{ time: 0, text: 'Failed to find any lyrics for this track.', roman: '', trans: '' }]);
                return;
            }
            
            let rawLrc, originalPlainText;
            const isPlainText = !candidate.syncedLyrics && !!candidate.plainLyrics;
            const separator = '|||NEWLINE|||';
            
            if (isPlainText) {
                originalPlainText = candidate.plainLyrics;
                rawLrc = `[00:00.01] ${originalPlainText.replace(/\n/g, separator)}`;
                onTransReady([{
                    time: 10,
                    text: originalPlainText,
                    roman: 'Loading...',
                    trans: 'Loading...'
                }]);
            } else {
                rawLrc = candidate.syncedLyrics;
                onTransReady(parseLRC(rawLrc, '', ''));
            }
            
            // --- 5) Fetch translations for either type ---
            const userPrompt = `LRC input:\n${rawLrc}`;
            const { rom, transl } = await fetchTranslations(userPrompt, title, artist);
            
            // --- 6) Final merge and render ---
            if (isPlainText) {
                const separatorRegex = new RegExp(separator.replace(/\|/g, '\\|'), 'g');
                const romText = (parseLRCToArray(rom)[0]?.text || '').replace(separatorRegex, '\n');
                const translText = (parseLRCToArray(transl)[0]?.text || '').replace(separatorRegex, '\n');
                onTransReady([{
                    time: 10,
                    text: originalPlainText,
                    roman: romText,
                    trans: translText
                }]);
            } else {
                const mergedParsed = parseLRC(rawLrc, rom, transl);
                onTransReady(mergedParsed);
            }
            
        } catch (e) {
            console.warn('[Lyrics] loadLyrics error:', e);
            onTransReady([{ time: 0, text: 'An error occurred while loading lyrics.', roman: '', trans: '' }]);
        }
    }
    
    function parseTimeString(str) {
        if (!str) return 0;
        const parts = str.split(':').map(Number);
        if (parts.length === 2) {
            return (parts[0] * 60 + parts[1]) * 1000;
        }
        if (parts.length === 3) {
            return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
        }
        return 0;
    }
    
    async function getTrackInfo() {
        const bars = [
            document.querySelector('[data-testid="now-playing-bar"]'),
            document.querySelector('[data-testid="main-view-player-bar"]'),
            document.querySelector('[data-testid="bottom-bar"]'),
            document.querySelector('footer')
        ];
        let bar = bars.find(Boolean);
        if (!bar) return null;
        
        let title = '';
        let artist = '';
        let ti = bar.querySelector('[data-testid="context-item-info-title"] [data-testid="context-item-link"], [data-testid="nowplaying-track-link"], [data-testid="now-playing-widget-title"] a, .track-info__name a');
        let ar = bar.querySelector('[data-testid="context-item-info-artist"], [data-testid="nowplaying-artist"], [data-testid="now-playing-widget-artist"] a, .track-info__artists a');
        if (ti && ar) {
            title = ti.textContent.trim();
            artist = ar.textContent.trim();
        } else {
            const spans = bar.querySelectorAll('span');
            if (spans.length >= 2) {
                title = spans[0].textContent.trim();
                artist = spans[1].textContent.trim();
            }
        }
        
        let album = '';
        let albumHref = ti && ti.href ? ti.href : '';
        if (albumHref) {
            album = await parseAl(albumHref);
        }
        
        let duration = null;
        let durationEl = bar.querySelector('[data-testid="playback-duration"]') || bar.querySelector('[data-testid="playback_duration"]');
        if (durationEl) {
            duration = parseTimeString(durationEl.textContent.trim());
        }
        
        currentTrackDur = duration;
        
        return {
            id: title + '|' + artist,
            title,
            artist,
            album,
            duration,
            bar
        };
    }
    
    async function fetchGeniusLyrics(title = null, artist = null) {
        if (title = null) title = currInf.title;
        if (artist = null) artist = currInf.artist;
        
        const q = encodeURIComponent(`${title} ${artist}`);
        const searchUrl = `https://genius.com/search?q=${q}`;
        
        // 1) Fetch Genius search page
        const searchHtml = await new Promise((resolve, reject) => {
            GM.xmlHttpRequest({
                method: 'GET',
                url: searchUrl,
                onload: res => resolve(res.responseText),
                onerror: err => reject(err)
            });
        });
        
        // 2) Find the first mini-song-card link to English Translations
        const searchDoc = new DOMParser().parseFromString(searchHtml, 'text/html');
        const cards = searchDoc.querySelectorAll('mini-song-card a');
        let translationUrl = null;
        for (let a of cards) {
            if (a.textContent.includes('Genius English Translations')) {
                translationUrl = a.href;
                break;
            }
        }
        if (!translationUrl) throw new Error('No “Genius English Translations” link found');
        
        // 3) Fetch the translation page
        const lyricsHtml = await new Promise((resolve, reject) => {
            GM.xmlHttpRequest({
                method: 'GET',
                url: translationUrl,
                onload: res => resolve(res.responseText),
                onerror: err => reject(err)
            });
        });
        
        // 4) Scrape all <div data-lyrics-container="true">, stripping excludes
        const lyricsDoc = new DOMParser().parseFromString(lyricsHtml, 'text/html');
        const containers = lyricsDoc.querySelectorAll('div[data-lyrics-container="true"]');
        if (!containers.length) throw new Error('No lyrics containers found');
        
        // 5) Build the final lyrics string
        const blocks = [];
        containers.forEach(div => {
            // clone and remove any <… data-exclude-from-selection="true">
            const clone = div.cloneNode(true);
            clone.querySelectorAll('[data-exclude-from-selection="true"]').forEach(e => e.remove());
            blocks.push(clone.innerText.trim());
        });
        
        return blocks.join('\n');
    }
    
    function getProgressBarTimeMs(bar, durationMs) {
        if (!bar || !durationMs) return 0;
        const pbar = bar.querySelector('[data-testid="progress-bar"]');
        if (pbar && pbar.style) {
            const styleText = pbar.getAttribute('style');
            if (styleText && styleText.includes('--progress-bar-transform')) {
                const match = styleText.match(/--progress-bar-transform:\s*([\d.]+)%/);
                if (match && match[1]) {
                    const percent = parseFloat(match[1]);
                    if (!isNaN(percent)) {
                        return durationMs * percent / 100;
                    }
                }
            }
        }
        let slider = bar.querySelector('div[role="slider"][aria-valuenow][aria-valuemax]');
        if (slider) {
            let v = Number(slider.getAttribute('aria-valuenow'));
            let vmax = Number(slider.getAttribute('aria-valuemax'));
            if (vmax && vmax > 0 && durationMs && durationMs > 0) {
                if (vmax === 100 && v <= 100) {
                    return Math.floor(durationMs * v / 100);
                }
                if (Math.abs(vmax - Math.round(durationMs / 1000)) <= 2) {
                    return Math.floor(v * 1000);
                }
            }
        }
        
        let input = bar.querySelector('input[type="range"]');
        if (input && durationMs) {
            let v = Number(input.value);
            let max = Number(input.max);
            if (max && max > 0) {
                return Math.floor(durationMs * v / max);
            }
        }
        let posEl = bar.querySelector('[data-testid="player-position"]');
        if (posEl) {
            return parseTimeString(posEl.textContent.trim());
        }
        return 0;
    }
    
    function renderLyrics(currentIdx) {
        const linesDiv = document.getElementById('tm-lyrics-lines');
        if (!linesDiv) return;
        const after = 50,
            before = 50;
        let html = '';
        const color = (currentTheme === 'light') ? '#000' : '#fff';
        const subColor = (currentTheme === 'light') ? '#555' : '#ccc';
        for (let i = Math.max(0, currentIdx - before); i <= Math.min(lyricsData.length - 1, currentIdx + after); i++) {
            const ln = lyricsData[i];
            // Empty lines: show a blank line with minHeight set so it takes up the same space.
            if (!ln.text && !ln.roman && !ln.trans) {
                html += `<div class="tm-lyric-line" style="min-height:1.6em;height:1.6em;"> </div>`;
                continue;
            }
            let lineClass = (i === currentIdx) ? "tm-lyric-current" : "tm-lyric-line";
            let lineStyle = `white-space: pre-wrap; color:${color};${i === currentIdx ? "font-weight:bold;" : "opacity:.7;"}margin:10px 0;min-height:1.6em;display:block;`;
            html += `<div class="${lineClass}" style="${lineStyle}">` +
                (ln.text ? ln.text : " ");
            // rom and transl
            if (ln.roman) {
                html += `<div style="font-size:.75em;color:${subColor};margin-top:2px;">${ln.roman ? ln.roman : '-'}</div>`;
            }
            if (ln.trans) {
                html += `<div style="font-size:.75em;color:${subColor};margin-top:2px;">${ln.trans ? ln.trans : '-'}</div>`;
            }
            html += `</div>`;
        }
        linesDiv.innerHTML = html;
        
        // Scroll current line to middle
        const currElem = linesDiv.querySelector('.tm-lyric-current');
        if (currElem) {
            const containerHeight = linesDiv.clientHeight;
            const elemTop = currElem.offsetTop;
            const elemHeight = currElem.offsetHeight;
            linesDiv.scrollTop = elemTop - containerHeight / 2 + elemHeight / 2;
        }
    }
    
    function syncLyrics(bar, durationMs) {
        if (!bar || !lyricsData) return;
        let t = getProgressBarTimeMs(bar, durationMs);
        if (lyricsData.length === 1) { // Handle plain text block
            if (lastRenderedIdx !== 0) {
                lastRenderedIdx = 0;
                renderLyrics(0);
            }
            return;
        }
        let idx = lyricsData.findIndex((line, i) =>
            i === lyricsData.length - 1 || (line.time <= t && t < lyricsData[i + 1].time)
        );
        if (idx === -1) idx = lyricsData.length - 1;
        if (idx !== lastRenderedIdx) {
            lastRenderedIdx = idx;
            renderLyrics(idx);
        }
    }
    
    function setupProgressSync(bar, durationMs) {
        if (!bar) return;
        if (observer) observer.disconnect();
        if (syncIntervalId) clearInterval(syncIntervalId);
        
        observer = new MutationObserver(() => {
            syncLyrics(bar, durationMs);
        });
        const pbar = bar.querySelector('[data-testid="progress-bar"]');
        if (pbar) {
            observer.observe(pbar, { attributes: true, attributeFilter: ['style'] });
        }
        
        syncIntervalId = setInterval(() => syncLyrics(bar, durationMs), 300);
    }
    
    async function poller() {
        const info = await getTrackInfo();
        if (!info || !info.title || !info.artist) return;
        currInf = info;
        if (info.id !== currentTrackId) {
            debug('Track changed:', info.title, '-', info.artist, 'album:', info.album, 'duration:', info.duration);
            currentTrackId = info.id;
            lyricsData = null;
            lastRenderedIdx = -1;
            const lines = document.getElementById('tm-lyrics-lines');
            lines.innerHTML = '<em>Loading lyrics...</em>';
            // Show original LRC first, then update with rom/trans
            await loadLyrics(info.title, info.artist, info.album, info.duration, (parsed) => {
                lyricsData = parsed;
                renderLyrics(0);
                setupProgressSync(info.bar, info.duration);
            });
        }
    }
    
    function debug(...args) {
        // Uncomment for logs
        console.log('[Lyrics]', ...args);
    }
    
    function initLyricsPanel() {
        debug('initLyricsPanel called');
        createPanel();
        window.addEventListener('resize', debounce(handleViewportChange, 250));
        setInterval(poller, POLL_INTERVAL);
    }
    
    function ready(fn) {
        if (document.readyState === 'complete' || document.readyState === 'interactive') {
            setTimeout(fn, 0);
        } else {
            document.addEventListener('DOMContentLoaded', fn);
        }
    }
    
    ready(() => {
        debug('DOM ready');
        
        if (mobileDebug) {
            waitForScript('eruda', () => {
                setTimeout(function() {
                    debug('Eruda loaded');
                    initLyricsPanel();
                }, 1900);
            });
        } else {
            setTimeout(initLyricsPanel, 1500);
        }
    });
    
    /**
     * Waits for a <script> with a keyword in the `src` to be loaded.
     */
    function waitForScript(keyword, callback) {
        const alreadyLoaded = [...document.scripts].find(
            script => script.src.includes(keyword)
        );
        
        if (alreadyLoaded && alreadyLoaded.readyState === 'complete') {
            callback();
            return;
        }
        
        // Watch for new scripts
        const observer = new MutationObserver((mutations, obs) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (
                        node.tagName === 'SCRIPT' &&
                        node.src.includes(keyword)
                    ) {
                        node.addEventListener('load', () => {
                            obs.disconnect();
                            callback();
                        });
                    }
                }
            }
        });
        
        observer.observe(document.head, { childList: true });
        observer.observe(document.body, { childList: true });
    }
    
    if (mobileDebug) { alert("[LYRICS PANEL DEBUG] mobileDebug flag set to `true`. Load eruda to start the panel."); }
    
    
})();