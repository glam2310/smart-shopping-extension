// popup.js

const API_BASE = 'http://localhost:3000';

const CONFETTI_COLORS = ['#450693', '#8C00FF', '#FF3F7F', '#FFC400', '#12b76a', '#ffffff'];
let confettiFired = false;
let currentSitePrice = null;

function sanitizePrice(value) {
    if (value == null || value === '') return null;

    if (typeof value === 'number') {
        return Number.isFinite(value) && value > 0 && value < 100000 ? value : null;
    }

    const normalized = String(value).replace(/\s+/g, ' ').trim();
    if (!/\d/.test(normalized)) return null;

    const shekelPatterns = [
        /₪\s*([\d,]+(?:\.\d{1,2})?)/,
        /([\d,]+(?:\.\d{1,2})?)\s*₪/
    ];
    for (const pattern of shekelPatterns) {
        const match = normalized.match(pattern);
        if (match) {
            const val = parseFloat(match[1].replace(/,/g, ''));
            if (Number.isFinite(val) && val > 0 && val < 100000) return val;
        }
    }

    const numeric = normalized.match(/(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/);
    if (numeric) {
        const val = parseFloat(numeric[1].replace(/,/g, ''));
        if (Number.isFinite(val) && val > 0 && val < 100000) return val;
    }

    return null;
}

function formatDisplayPrice(price) {
    const val = sanitizePrice(price);
    if (val == null) return null;
    return val % 1 === 0 ? String(val) : val.toFixed(2);
}

document.addEventListener('DOMContentLoaded', async () => {
    document.getElementById('closePopupBtn')?.addEventListener('click', () => window.close());

    const container = document.getElementById('dynamicButtonsContainer');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.id) {
        container.innerHTML = '<div class="info-text">לא ניתן לגשת לטאב</div>';
        return;
    }

    let currentHostname = '';
    try {
        currentHostname = new URL(tab.url).hostname;
    } catch (_) {
        container.innerHTML = '<div class="info-text">כתובת לא תקינה</div>';
        return;
    }

    const siteConfig = typeof getSiteConfig === 'function'
        ? getSiteConfig(currentHostname)
        : SITES_CONFIG[currentHostname];

    if (!siteConfig) {
        container.innerHTML = '<div class="info-text">האתר אינו נתמך כרגע</div>';
        return;
    }

    chrome.tabs.sendMessage(tab.id, { action: 'GET_PRODUCT_DATA' }, async (response) => {
        if (chrome.runtime.lastError || !response) {
            container.innerHTML = '<div class="info-text">לא ניתן לקרוא נתונים מהדף</div>';
            return;
        }

        currentSitePrice = sanitizePrice(response.price);

        if (!response.ean || response.ean === 'unknown_sku') {
            const noEanMsg = siteConfig?.noEanMessage || 'לא נמצא ברקוד במוצר';
            container.innerHTML = `<div class="info-text">${noEanMsg}</div>`;
            updateProductInfo(response);
            return;
        }

        updateProductInfo(response);
        setupActiveTracking(response, currentHostname, tab.url);

        const currentKeys = new Set([
            currentHostname,
            currentHostname.replace(/^www\./, ''),
            currentHostname.startsWith('www.') ? currentHostname : `www.${currentHostname}`
        ]);

        const targetSites = Object.keys(SITES_CONFIG).filter(site => {
            const cfg = SITES_CONFIG[site];
            if (typeof isSiteEnabled === 'function' && !isSiteEnabled(cfg)) return false;
            if (cfg.enabled === false) return false;
            if (currentKeys.has(site)) return false;
            if (cfg.siteType !== 'retail') return false;
            if (cfg.compareRole === 'origin-only') return false;
            return true;
        });

        if (targetSites.length === 0) {
            container.innerHTML = '<div class="info-text">אין אתרים נוספים להשוואה</div>';
            return;
        }

        container.innerHTML = `
            <div class="loading-state">
                <span class="loading-state__dot"></span>
                <span class="loading-state__text">בודק זמינות באתרים אחרים...</span>
            </div>`;
        await buildComparisonButtons(response.ean, response.productName, targetSites, container);
    });
});

/**
 * Inserts a space at Latin↔Hebrew script boundaries so mixed product names
 * render correctly (e.g. "Xerjoffיוניסקס" → "Xerjoff יוניסקס").
 */
function fixMixedScriptSpacing(text) {
    if (!text) return text;

    return String(text)
        .replace(/([\u0590-\u05FF])([A-Za-z0-9])/g, '$1 $2')
        .replace(/([A-Za-z0-9])([\u0590-\u05FF])/g, '$1 $2')
        .replace(/\s+/g, ' ')
        .trim();
}

function updateProductInfo(data) {
    const productEl = document.getElementById('productName');
    const eanEl = document.getElementById('eanValue');
    const imgEl = document.getElementById('productImage');
    const imgFallback = document.getElementById('productImageFallback');

    if (productEl) {
        productEl.textContent = fixMixedScriptSpacing(data.productName) || '-';
    }
    if (eanEl) eanEl.textContent = data.ean || '-';

    if (imgEl && imgFallback) {
        if (data.imageUrl) {
            imgEl.src = data.imageUrl;
            imgEl.alt = fixMixedScriptSpacing(data.productName) || 'Product image';
            imgEl.onerror = () => {
                imgEl.hidden = true;
                imgFallback.hidden = false;
            };
            imgEl.hidden = false;
            imgFallback.hidden = true;
        } else {
            imgEl.hidden = true;
            imgEl.removeAttribute('src');
            imgFallback.hidden = false;
        }
    }
}

function getOrCreateInstallationId() {
    return new Promise((resolve) => {
        chrome.storage.local.get(['installation_id', 'user_id'], (result) => {
            if (result.installation_id) {
                resolve(result.installation_id);
                return;
            }
            if (result.user_id) {
                chrome.storage.local.set({ installation_id: result.user_id }, () => {
                    resolve(result.user_id);
                });
                return;
            }
            const newId = crypto.randomUUID();
            chrome.storage.local.set({ installation_id: newId }, () => resolve(newId));
        });
    });
}

function sendBackgroundMessage(message) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(message, (response) => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError.message);
                return;
            }
            if (!response?.ok) {
                reject(response?.error || 'Request failed');
                return;
            }
            resolve(response.data);
        });
    });
}

async function setupActiveTracking(productData, sourceSite, sourceUrl) {
    const alertBtn = document.getElementById('createAlertBtn');
    const alertStatus = document.getElementById('alertStatus');
    if (!alertBtn) return;

    const installationId = await getOrCreateInstallationId();

    try {
        const status = await sendBackgroundMessage({
            type: 'GET_TRACK_STATUS',
            payload: {
                installation_id: installationId,
                ean: productData.ean,
                source_site: sourceSite
            }
        });

        if (status.tracked) {
            alertBtn.disabled = true;
            alertBtn.textContent = status.tracking_type === 'active'
                ? 'מעקב פעיל'
                : 'נצפה לאחרונה';
            if (alertStatus) {
                alertStatus.textContent = 'המוצר כבר ברשימת המעקב שלך';
                alertStatus.className = 'alert-status';
            }
        }
    } catch (_) {
        // Server offline — button still usable
    }

    alertBtn.addEventListener('click', async () => {
        alertBtn.disabled = true;
        try {
            await sendBackgroundMessage({
                type: 'TRACK_PRODUCT',
                payload: {
                    installation_id: installationId,
                    ean: productData.ean,
                    source_site: sourceSite,
                    tracking_type: 'active',
                    source_url: sourceUrl,
                    product_name: productData.productName,
                    brand: productData.brand,
                    extension_version: chrome.runtime.getManifest().version,
                    locale: navigator.language,
                    platform: navigator.platform
                }
            });

            alertBtn.textContent = 'מעקב פעיל';
            if (alertStatus) {
                alertStatus.textContent = 'המוצר נשמר למעקב';
                alertStatus.className = 'alert-status';
            }
        } catch (err) {
            alertBtn.disabled = false;
            if (alertStatus) {
                alertStatus.textContent = 'שגיאה בשמירה למעקב';
                alertStatus.className = 'alert-status alert-status--error';
            }
            console.error('Active track failed:', err);
        }
    });
}

function findBestDealSite(results) {
    const current = sanitizePrice(currentSitePrice);
    if (current == null) return null;

    const priced = results
        .map(r => ({ ...r, price: sanitizePrice(r.price) }))
        .filter(r => r.price != null);

    if (!priced.length) return null;

    const cheapest = priced.reduce((min, r) => (r.price < min.price ? r : min), priced[0]);
    return cheapest.price < current ? cheapest.site : null;
}

function createPriceButton(site, price, productUrl, isBestDeal = false) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = isBestDeal ? 'deal-btn deal-btn--best' : 'deal-btn deal-btn--primary';

    const label = document.createElement('span');
    label.textContent = `${SITES_CONFIG[site].displayName}: ₪${price}`;
    btn.appendChild(label);

    if (isBestDeal) {
        const badge = document.createElement('span');
        badge.className = 'deal-btn__badge';
        badge.textContent = 'הכי זול';
        btn.appendChild(badge);
    }

    btn.addEventListener('click', () => {
        chrome.tabs.create({ url: productUrl });
    });
    return btn;
}

function createFallbackButton(site, productUrl) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'deal-btn deal-btn--outline';
    btn.textContent = `צפה ב-${SITES_CONFIG[site].displayName}`;
    btn.addEventListener('click', () => {
        chrome.tabs.create({ url: productUrl });
    });
    return btn;
}

function createGenericLoadingMessage() {
    const row = document.createElement('div');
    row.className = 'loading-state';
    row.id = 'compareStreamLoading';
    row.innerHTML = `
        <span class="loading-state__dot"></span>
        <span class="loading-state__text">ממשיכים לחפש באתרים נוספים...</span>`;
    return row;
}

function streamResultToEntry(data) {
    const site = data.site;
    const price = data.price ?? data.cachedPrice ?? null;
    const productUrl = data.productUrl || null;

    if (!data.exists || !productUrl || productUrl.toLowerCase().includes('/search')) {
        return null;
    }

    return {
        site,
        price: sanitizePrice(price),
        productUrl
    };
}

function parseSSEBlock(block) {
    let event = 'message';
    let data = '';

    for (const line of block.split('\n')) {
        if (line.startsWith('event:')) {
            event = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
            data += line.slice(5).trim();
        }
    }

    if (!data) return { event, data: null };

    try {
        return { event, data: JSON.parse(data) };
    } catch (_) {
        return { event, data: null };
    }
}

function createSSEParser() {
    let buffer = '';

    return {
        feed(chunk) {
            buffer += chunk;
            const events = [];
            let boundary;

            while ((boundary = buffer.indexOf('\n\n')) !== -1) {
                const block = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                events.push(parseSSEBlock(block));
            }

            return events;
        }
    };
}

function maybeCelebrateCheaperDeal(results) {
    const current = sanitizePrice(currentSitePrice);
    if (confettiFired || current == null) return;

    const priced = results
        .map(r => sanitizePrice(r.price))
        .filter(p => p != null);

    if (!priced.some(p => p < current)) return;

    confettiFired = true;
    launchConfetti();
}

function launchConfetti() {
    const canvas = document.getElementById('confettiCanvas');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.offsetWidth * dpr;
    canvas.height = canvas.offsetHeight * dpr;
    ctx.scale(dpr, dpr);

    const w = canvas.offsetWidth;
    const h = canvas.offsetHeight;
    const particles = Array.from({ length: 90 }, () => ({
        x: w * 0.5 + (Math.random() - 0.5) * 80,
        y: h * 0.35,
        vx: (Math.random() - 0.5) * 6,
        vy: Math.random() * -7 - 3,
        size: Math.random() * 6 + 3,
        color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
        rotation: Math.random() * 360,
        spin: (Math.random() - 0.5) * 12,
        life: 1
    }));

    const start = performance.now();
    const duration = 2200;

    function frame(now) {
        const elapsed = now - start;
        const progress = elapsed / duration;
        ctx.clearRect(0, 0, w, h);

        for (const p of particles) {
            p.x += p.vx;
            p.y += p.vy;
            p.vy += 0.18;
            p.rotation += p.spin;
            p.life = Math.max(0, 1 - progress);

            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate((p.rotation * Math.PI) / 180);
            ctx.globalAlpha = p.life;
            ctx.fillStyle = p.color;
            ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
            ctx.restore();
        }

        if (elapsed < duration) {
            requestAnimationFrame(frame);
        } else {
            ctx.clearRect(0, 0, w, h);
        }
    }

    requestAnimationFrame(frame);
}

function appendDealButtons(container, results, loadingEl) {
    container.querySelectorAll('.deal-btn').forEach(el => el.remove());

    const bestSite = findBestDealSite(results);
    const withPrice = results.filter(r => sanitizePrice(r.price) != null);
    const withoutPrice = results.filter(r => sanitizePrice(r.price) == null);

    withPrice
        .sort((a, b) => sanitizePrice(a.price) - sanitizePrice(b.price))
        .forEach(({ site, price, productUrl }) => {
            const displayPrice = formatDisplayPrice(price);
            container.insertBefore(
                createPriceButton(site, displayPrice, productUrl, site === bestSite),
                loadingEl?.parentNode === container ? loadingEl : null
            );
        });

    withoutPrice.forEach(({ site, productUrl }) => {
        container.insertBefore(
            createFallbackButton(site, productUrl),
            loadingEl?.parentNode === container ? loadingEl : null
        );
    });

    maybeCelebrateCheaperDeal(results);
}

function renderComparisonResults(container, results) {
    container.innerHTML = '';

    const withPrice = results.filter(r => r.price > 0);
    const withoutPrice = results.filter(r => !r.price || r.price <= 0);

    if (withPrice.length === 0 && withoutPrice.length === 0) {
        container.innerHTML = '<div class="info-text">לא נמצא במותגים אחרים</div>';
        return;
    }

    appendDealButtons(container, results, null);
}

function updatePendingLoading(container, pendingCount, loadingEl) {
    if (pendingCount > 0) {
        if (!loadingEl.parentNode) {
            container.appendChild(loadingEl);
        }
        return;
    }

    if (loadingEl.parentNode) {
        loadingEl.remove();
    }
}

async function buildComparisonButtons(ean, sourceProductName, targetSites, container) {
    const sitesSettings = {};
    for (const site of targetSites) {
        sitesSettings[site] = SITES_CONFIG[site];
    }

    const results = [];
    let pendingLiveCount = targetSites.length;
    const loadingEl = createGenericLoadingMessage();

    container.innerHTML = '';
    container.appendChild(loadingEl);

    try {
        const response = await fetch(`${API_BASE}/api/compare-stream`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'text/event-stream'
            },
            body: JSON.stringify({
                ean,
                compareWith: targetSites,
                sourceProductName,
                sitesSettings
            })
        });

        if (!response.ok || !response.body) {
            throw new Error(`Stream failed: HTTP ${response.status}`);
        }

        const parser = createSSEParser();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            for (const evt of parser.feed(decoder.decode(value, { stream: true }))) {
                if (evt.event === 'progress' && evt.data?.pending != null) {
                    pendingLiveCount = evt.data.pending;
                    updatePendingLoading(container, pendingLiveCount, loadingEl);
                } else if (evt.event === 'result' && evt.data?.site) {
                    const entry = streamResultToEntry(evt.data);
                    if (entry) {
                        const existing = results.findIndex(r => r.site === entry.site);
                        if (existing >= 0) {
                            results[existing] = entry;
                        } else {
                            results.push(entry);
                        }
                        appendDealButtons(container, results, loadingEl);
                    }
                    if (!evt.data.fromCache) {
                        pendingLiveCount = Math.max(0, pendingLiveCount - 1);
                        updatePendingLoading(container, pendingLiveCount, loadingEl);
                    }
                } else if (evt.event === 'error' && evt.data?.site) {
                    pendingLiveCount = Math.max(0, pendingLiveCount - 1);
                    updatePendingLoading(container, pendingLiveCount, loadingEl);
                } else if (evt.event === 'done') {
                    pendingLiveCount = 0;
                    updatePendingLoading(container, 0, loadingEl);
                }
            }
        }

        if (results.length === 0) {
            renderComparisonResults(container, results);
        }
    } catch (err) {
        console.error('Compare stream failed:', err);
        container.innerHTML = '<div class="info-text">שגיאה בחיבור לשרת</div>';
    }
}
