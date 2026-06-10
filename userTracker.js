// userTracker.js — passive dwell tracking on supported product pages

const PASSIVE_DWELL_TIME_SEC = 30;
const sessionId = crypto.randomUUID();
let passiveSent = false;
let startTime = Date.now();

function getOrCreateInstallationId(callback) {
    chrome.storage.local.get(['installation_id', 'user_id'], (result) => {
        if (result.installation_id) {
            callback(result.installation_id);
            return;
        }

        if (result.user_id) {
            chrome.storage.local.set({ installation_id: result.user_id }, () => {
                callback(result.user_id);
            });
            return;
        }

        const newId = crypto.randomUUID();
        chrome.storage.local.set({ installation_id: newId }, () => {
            console.log('[Tracker] New installation:', newId);
            callback(newId);
        });
    });
}

function sendToBackground(message) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(message, (response) => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError.message);
                return;
            }
            if (!response?.ok) {
                reject(response?.error || response?.data?.reason || 'Request failed');
                return;
            }
            resolve(response.data);
        });
    });
}

function isValidEan(ean) {
    return /^\d{8,14}$/.test(String(ean || ''));
}

function extractProductContext() {
    const hostname = window.location.hostname;
    const config = typeof getSiteConfig === 'function'
        ? getSiteConfig(hostname)
        : (typeof SITES_CONFIG !== 'undefined' && typeof isSiteEnabled === 'function'
            ? (isSiteEnabled(SITES_CONFIG[hostname]) ? SITES_CONFIG[hostname] : null)
            : (typeof SITES_CONFIG !== 'undefined' ? SITES_CONFIG[hostname] : null));

    if (!config || config.siteType !== 'retail') return null;

    let ean = null;
    if (typeof extractEan === 'function') {
        ean = extractEan(config);
    }

    if (!isValidEan(ean)) return null;

    const productName = (document.title || '').split('|')[0].trim();
    const brand = config.displayName || config.name || hostname;

    return {
        ean,
        source_site: hostname,
        source_url: window.location.href,
        product_name: productName,
        brand
    };
}

async function sendPassiveTrack(dwellSeconds) {
    const context = extractProductContext();
    if (!context) return;

    getOrCreateInstallationId(async (installationId) => {
        try {
            const response = await sendToBackground({
                type: 'TRACK_PRODUCT',
                payload: {
                    installation_id: installationId,
                    ean: context.ean,
                    source_site: context.source_site,
                    tracking_type: 'passive',
                    dwell_seconds: dwellSeconds,
                    source_url: context.source_url,
                    product_name: context.product_name,
                    brand: context.brand,
                    session_id: sessionId,
                    extension_version: chrome.runtime.getManifest().version,
                    locale: navigator.language,
                    platform: navigator.platform
                }
            });

            console.log('[Tracker] Passive track recorded:', response);
        } catch (err) {
            console.warn('[Tracker] Passive track skipped:', err);
        }
    });
}

function resetDwellTimer() {
    startTime = Date.now();
    passiveSent = false;
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        resetDwellTimer();
    } else {
        startTime = Date.now();
    }
});

setInterval(() => {
    if (passiveSent || document.visibilityState !== 'visible') return;

    const dwellSeconds = Math.floor((Date.now() - startTime) / 1000);
    if (dwellSeconds < PASSIVE_DWELL_TIME_SEC) return;

    passiveSent = true;
    console.log('[Tracker] Passive dwell reached:', dwellSeconds, 's');
    sendPassiveTrack(dwellSeconds);
}, 5000);

console.log('[Tracker] Passive tracking active (threshold:', PASSIVE_DWELL_TIME_SEC, 's)');
