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

function isValidPrice(val) {
    return typeof val === 'number' && Number.isFinite(val) && val > 0 && val < 100000;
}

function parsePriceFromText(text) {
    if (!text || !/\d/.test(text)) return null;

    const normalized = String(text).replace(/\s+/g, ' ').trim();

    const shekelPatterns = [
        /₪\s*([\d,]+(?:\.\d{1,2})?)/,
        /([\d,]+(?:\.\d{1,2})?)\s*₪/
    ];
    for (const pattern of shekelPatterns) {
        const match = normalized.match(pattern);
        if (match) {
            const val = parseFloat(match[1].replace(/,/g, ''));
            if (isValidPrice(val)) return val;
        }
    }

    const commaThousands = normalized.match(/(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?)/);
    if (commaThousands) {
        const val = parseFloat(commaThousands[1].replace(/,/g, ''));
        if (isValidPrice(val)) return val;
    }

    const plain = normalized.match(/(\d+(?:\.\d{1,2})?)/);
    if (plain) {
        const val = parseFloat(plain[1].replace(/,/g, ''));
        if (isValidPrice(val)) return val;
    }

    return null;
}

function walkJsonLdForPrice(obj, paths) {
    if (!obj || typeof obj !== 'object') return null;

    for (const path of paths || ['offers.price']) {
        if (path.startsWith('offers.')) {
            const field = path.split('.')[1];
            const offers = obj.offers;
            const list = Array.isArray(offers) ? offers : offers ? [offers] : [];
            for (const offer of list) {
                const val = parseFloat(String(offer?.[field]).replace(/,/g, ''));
                if (isValidPrice(val)) return val;
            }
        }
    }

    if (Array.isArray(obj['@graph'])) {
        for (const node of obj['@graph']) {
            const found = walkJsonLdForPrice(node, paths);
            if (found) return found;
        }
    }

    return null;
}

function extractPriceFromJsonLd(strategy) {
    const paths = strategy.paths || ['offers.price', 'offers.lowPrice'];

    for (const script of document.querySelectorAll("script[type='application/ld+json']")) {
        const raw = (script.textContent || '').trim();
        if (!raw) continue;

        try {
            const data = JSON.parse(raw);
            const items = Array.isArray(data) ? data : [data];
            for (const item of items) {
                const price = walkJsonLdForPrice(item, paths);
                if (price) return price;
            }
        } catch (_) {
            const offerMatch = raw.match(/"price"\s*:\s*"?([\d.]+)"?/);
            if (offerMatch) {
                const val = parseFloat(offerMatch[1]);
                if (isValidPrice(val)) return val;
            }
        }
    }

    return null;
}

function extractPriceFromDataAttributes(strategy) {
    const root = document.querySelector(strategy.selector);
    if (!root) return null;

    for (const attr of strategy.attributes || []) {
        const raw = root.getAttribute(attr);
        if (raw == null || raw === '') continue;
        const val = parseFloat(String(raw).replace(/,/g, ''));
        if (isValidPrice(val)) return val;
    }

    if (strategy.textSelector) {
        const el = root.querySelector(strategy.textSelector);
        return parsePriceFromText(el?.innerText || el?.textContent || '');
    }

    return parsePriceFromText(root.innerText || root.textContent || '');
}

function extractPriceFromDom(strategy) {
    const excludeClosest = strategy.excludeClosest || [];

    for (const sel of strategy.selectors || []) {
        for (const el of document.querySelectorAll(sel)) {
            if (excludeClosest.some(ex => el.closest(ex))) continue;
            const price = parsePriceFromText(el.innerText || el.textContent || '');
            if (price) return price;
        }
    }

    return null;
}

function extractCurrentPrice(config) {
    const strategies = config.scrape?.priceExtraction || [];

    for (const strategy of strategies) {
        let price = null;

        if (strategy.type === 'json-ld') {
            price = extractPriceFromJsonLd(strategy);
        } else if (strategy.type === 'data-attributes') {
            price = extractPriceFromDataAttributes(strategy);
        } else if (strategy.type === 'dom') {
            price = extractPriceFromDom(strategy);
        }

        if (price) return price;
    }

    if (config.selectors?.price) {
        const legacySelectors = String(config.selectors.price).split(',').map(s => s.trim());
        for (const sel of legacySelectors) {
            const el = document.querySelector(sel);
            if (!el) continue;
            const price = parsePriceFromText(el.innerText || el.textContent || '');
            if (price) return price;
        }
    }

    const ogPrice = document.querySelector('meta[property="product:price:amount"], meta[property="og:price:amount"]');
    if (ogPrice?.content) {
        const val = parseFloat(String(ogPrice.content).replace(/,/g, ''));
        if (isValidPrice(val)) return val;
    }

    return null;
}

function extractProductImageUrl(config) {
    const ogImage = document.querySelector('meta[property="og:image"], meta[name="og:image"]');
    if (ogImage?.content && /^https?:\/\//i.test(ogImage.content)) {
        return ogImage.content;
    }

    const configSelectors = config.selectors?.image
        ? String(config.selectors.image).split(',').map(s => s.trim()).filter(Boolean)
        : [];

    const genericSelectors = [
        '.product-media img',
        '.product-image img',
        '.product__media img',
        '[class*="product-gallery"] img',
        '[class*="ProductImage"] img',
        'img[itemprop="image"]',
        'main img'
    ];

    for (const sel of [...configSelectors, ...genericSelectors]) {
        const img = document.querySelector(sel);
        const src = img?.currentSrc || img?.src;
        if (src && /^https?:\/\//i.test(src) && !/placeholder|spacer|1x1/i.test(src)) {
            return src;
        }
    }

    return null;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'GET_PRODUCT_DATA') {
        const hostname = window.location.hostname;
        const config = typeof getSiteConfig === 'function'
            ? getSiteConfig(hostname)
            : (typeof SITES_CONFIG !== 'undefined' ? SITES_CONFIG[hostname] : null);

        if (config && typeof isSiteEnabled === 'function' && !isSiteEnabled(config)) {
            sendResponse({ error: 'Site not supported' });
            return true;
        }

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

            price = extractCurrentPrice(config);

            productName = productName.replace(/[\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim();
        } catch (err) {
            console.error('[Smart Shopping] Error during extraction:', err);
        }

        const imageUrl = extractProductImageUrl(config);

        const payload = {
            sku: ean,
            ean,
            price,
            brand,
            productName,
            imageUrl,
            hostname
        };

        console.log('[Smart Shopping] Data successfully extracted:', payload);
        sendResponse(payload);
    }
    return true;
});
