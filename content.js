// content.js

function normalizeEan(value) {
    const digits = String(value || '').replace(/\D/g, '');
    if (digits.length >= 8 && digits.length <= 14) return digits;
    return null;
}

function extractEanByLabel(label) {
    const elements = document.querySelectorAll('p, span, div, td, th, li, dt, dd, label');

    for (const el of elements) {
        const text = (el.textContent || '').trim();
        if (text !== label) continue;

        const next = el.nextElementSibling;
        if (next) {
            const ean = normalizeEan(next.textContent);
            if (ean) return ean;
        }

        const parent = el.parentElement;
        if (parent) {
            const children = [...parent.children];
            const idx = children.indexOf(el);
            for (let i = idx + 1; i < children.length; i++) {
                const ean = normalizeEan(children[i].textContent);
                if (ean) return ean;
            }
        }
    }

    return null;
}

function extractEanByDom(strategy) {
    const el = document.querySelector(strategy.selector);
    if (!el) return null;

    if (strategy.regex) {
        const match = (el.innerText || '').match(strategy.regex);
        if (match?.[1]) return normalizeEan(match[1]);
    }

    return normalizeEan(el.innerText);
}

function extractEanByScript(strategy) {
    for (const script of document.querySelectorAll('script')) {
        const match = (script.innerText || '').match(strategy.regex);
        if (match?.[1]) {
            const ean = normalizeEan(match[1]);
            if (ean) return ean;
        }
    }
    return null;
}

function extractEanByPageScan(strategy) {
    const html = document.documentElement.innerHTML;

    for (const pattern of strategy.patterns || []) {
        const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
        const match = html.match(regex);
        if (match?.[1]) {
            const ean = normalizeEan(match[1]);
            if (ean) return ean;
        }
    }

    return null;
}

function extractEanByUrl(strategy) {
    const match = window.location.href.match(strategy.regex || strategy.identifier);
    if (match?.[1]) return normalizeEan(match[1]);
    return null;
}

function runEanStrategy(strategy) {
    if (!strategy?.type) return null;

    switch (strategy.type) {
        case 'label':
            return extractEanByLabel(strategy.label);
        case 'dom':
            return extractEanByDom(strategy);
        case 'script':
            return extractEanByScript(strategy);
        case 'page-scan':
            return extractEanByPageScan(strategy);
        case 'url':
            return extractEanByUrl(strategy);
        default:
            return null;
    }
}

function extractEan(config) {
    const extraction = config.eanExtraction;
    if (!extraction) return null;

    const strategies = extraction.strategies
        || [{ ...extraction, type: extraction.type }];

    for (const strategy of strategies) {
        const ean = runEanStrategy(strategy);
        if (ean) return ean;
    }

    return null;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'GET_PRODUCT_DATA') {
        const hostname = window.location.hostname;
        const config = typeof getSiteConfig === 'function'
            ? getSiteConfig(hostname)
            : (typeof SITES_CONFIG !== 'undefined' ? SITES_CONFIG[hostname] : null);

        if (!config) {
            console.log(`[Smart Shopping] Hostname ${hostname} is not supported in config.js`);
            sendResponse({ error: 'Site not supported' });
            return true;
        }

        console.log(`[Smart Shopping] Extracting data for: ${config.name}...`);

        let ean = 'unknown_sku';
        let price = null;
        let brand = config.name;
        let productName = document.title.split('|')[0].trim();

        try {
            const extractedEan = extractEan(config);
            if (extractedEan) {
                ean = extractedEan;
            }

            const domSelectors = (config.scrape?.priceExtraction || [])
                .filter(s => s.type === 'dom')
                .flatMap(s => s.selectors || []);

            const legacySelector = config.selectors?.price
                ? String(config.selectors.price).split(',').map(s => s.trim())
                : [];

            const priceSelectors = [...domSelectors, ...legacySelector];

            for (const sel of priceSelectors) {
                const priceEl = document.querySelector(sel);
                if (!priceEl) continue;

                const rawPrice = priceEl.innerText.replace(/[^\d.]/g, '');
                if (rawPrice) {
                    price = parseFloat(rawPrice);
                    break;
                }
            }

            productName = productName.replace(/[\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim();
        } catch (err) {
            console.error('[Smart Shopping] Error during extraction:', err);
        }

        const payload = {
            sku: ean,
            ean,
            price,
            brand,
            productName,
            hostname
        };

        console.log('[Smart Shopping] Data successfully extracted:', payload);
        sendResponse(payload);
    }
    return true;
});
