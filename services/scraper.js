const express = require('express');
const puppeteer = require('puppeteer-core');
const { Cluster } = require('puppeteer-cluster');

const app = express();
app.use(express.json());

const PORT = 3001;
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MAX_CONCURRENCY = Number(process.env.SCRAPER_MAX_CONCURRENCY || 3);
const CLUSTER_TASK_TIMEOUT_MS = Number(process.env.SCRAPER_TASK_TIMEOUT_MS || 120000);

let clusterInstance = null;
let clusterInitPromise = null;

const DEFAULT_SCRAPE = {
    renderDelay: 3500,
    maxPrice: 9999,
    waitUntil: 'domcontentloaded',
    searchWaitTimeout: 12000,
    headless: true,
    launchArgs: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled'
    ],
    blockResources: ['image', 'font'],
    extraHeaders: {
        'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
    },
    searchPageHints: ['/search', 'catalogsearch', '?text=', '?search='],
    priceExtraction: [],
    navigation: {
        productPageHints: ['/p/', '/product/', '/web/item', '/products/'],
        productLinkSelectors: [
            "a[href*='/p/']",
            "a[href*='/product/']",
            "a[href*='/web/item']",
            "a[href*='/products/']"
        ],
        cardSelectors: [
            '[class*="product"]',
            '.product-item',
            '.product-box',
            'li.item',
            'article'
        ],
        singleResultFallback: true
    }
};

function log(level, message, meta = null) {
    const ts = new Date().toISOString();
    const tag = `[${ts}] [Scraper] [${level}]`;
    if (meta) console.log(`${tag} ${message}`, meta);
    else console.log(`${tag} ${message}`);
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

const NAME_STOP_WORDS = new Set([
    'the', 'and', 'for', 'with', 'from', 'ml', 'spf', 'edp', 'edt', 'eau', 'de', 'parfum',
    'מ', 'ל', 'של', 'עם', 'את', 'על', 'מל', 'מ"ל', 'גרם', 'יח', 'בושם', 'לאישה', 'לגבר',
    'מוצר', 'חדש', 'מבצע', 'sale', 'או'
]);

const BRAND_TOKEN_ALIASES = {
    ysl: ['yves', 'saint', 'laurent'],
    ck: ['calvin', 'klein'],
    jpg: ['jean', 'paul', 'gaultier'],
    yslb: ['yves', 'saint', 'laurent']
};

function normalizeProductName(name) {
    return String(name || '')
        .toLowerCase()
        .normalize('NFKC')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function tokenizeProductName(name) {
    return normalizeProductName(name)
        .replace(/(\d+)([a-z\u0590-\u05ff]{1,4})/gi, '$1 $2')
        .split(' ')
        .filter(token => token.length >= 2 && !NAME_STOP_WORDS.has(token));
}

function countAliasMatches(srcTokens, tgtTokens) {
    let bonus = 0;
    const tgtSet = new Set(tgtTokens);
    const srcSet = new Set(srcTokens);

    for (const [alias, expanded] of Object.entries(BRAND_TOKEN_ALIASES)) {
        const aliasInTgt = tgtSet.has(alias);
        const aliasInSrc = srcSet.has(alias);
        if (!aliasInTgt && !aliasInSrc) continue;

        const expandedInSrc = expanded.filter(t => srcSet.has(t)).length;
        const expandedInTgt = expanded.filter(t => tgtSet.has(t)).length;

        if (aliasInTgt && expandedInSrc >= 2) bonus++;
        if (aliasInSrc && expandedInTgt >= 2) bonus++;
    }

    return bonus;
}

function evaluateNameSimilarity(sourceName, targetName, config = {}) {
    const minSimilarity = config.minSimilarity ?? 0.25;
    const minMatchingTokens = config.minMatchingTokens ?? 2;

    if (!sourceName?.trim()) {
        return { score: 1, matchingTokens: 0, pass: true, skipped: true };
    }
    if (!targetName?.trim()) {
        return { score: 0, matchingTokens: 0, pass: false, skipped: false };
    }

    const srcTokens = tokenizeProductName(sourceName);
    const tgtNorm = normalizeProductName(targetName);
    const tgtTokens = new Set(tokenizeProductName(targetName));

    let matchingTokens = 0;
    for (const token of srcTokens) {
        if (tgtTokens.has(token)) {
            matchingTokens++;
            continue;
        }
        if (token.length < 3) continue;

        let matched = false;
        for (const tgtToken of tgtTokens) {
            if (tgtToken.length >= 3 && (token.includes(tgtToken) || tgtToken.includes(token))) {
                matched = true;
                break;
            }
        }
        if (!matched && tgtNorm.includes(token)) {
            matched = true;
        }
        if (matched) matchingTokens++;
    }

    matchingTokens += countAliasMatches(srcTokens, [...tgtTokens]);

    const score = srcTokens.length ? matchingTokens / srcTokens.length : 0;
    const pass = matchingTokens >= minMatchingTokens || score >= minSimilarity;

    return { score, matchingTokens, pass, skipped: false, srcTokenCount: srcTokens.length };
}

function resolveScrapeConfig(siteSettings) {
    const scrape = siteSettings.scrape || {};
    const navigation = { ...DEFAULT_SCRAPE.navigation, ...(scrape.navigation || {}) };

    let priceExtraction = scrape.priceExtraction;
    if (!priceExtraction || priceExtraction.length === 0) {
        const legacySelectors = siteSettings.selectors?.price;
        const selectors = Array.isArray(legacySelectors)
            ? legacySelectors
            : String(legacySelectors || '').split(',').map(s => s.trim()).filter(Boolean);

        if (selectors.length > 0) {
            priceExtraction = [{ type: 'dom', selectors }];
        } else {
            priceExtraction = [];
        }
    }

    // Wait for product links to render on the search page before collecting.
    // Falls back to the configured product-link selectors so React/CSR sites
    // get a real "links exist" signal instead of a fixed sleep.
    const searchWaitForSelector = scrape.searchWaitForSelector
        || (navigation.productLinkSelectors || []).join(', ')
        || null;

    return {
        renderDelay: scrape.renderDelay ?? DEFAULT_SCRAPE.renderDelay,
        waitForSelector: scrape.waitForSelector || null,
        searchWaitForSelector,
        searchWaitTimeout: scrape.searchWaitTimeout ?? DEFAULT_SCRAPE.searchWaitTimeout,
        waitUntil: scrape.waitUntil || DEFAULT_SCRAPE.waitUntil,
        headless: scrape.headless ?? DEFAULT_SCRAPE.headless,
        launchArgs: scrape.launchArgs || DEFAULT_SCRAPE.launchArgs,
        ignoreDefaultArgs: scrape.ignoreDefaultArgs || null,
        userDataDir: scrape.userDataDir || null,
        blockResources: scrape.blockResources || DEFAULT_SCRAPE.blockResources,
        extraHeaders: { ...DEFAULT_SCRAPE.extraHeaders, ...(scrape.extraHeaders || {}) },
        maxPrice: scrape.maxPrice ?? DEFAULT_SCRAPE.maxPrice,
        searchPageHints: scrape.searchPageHints || DEFAULT_SCRAPE.searchPageHints,
        priceExtraction,
        navigation,
        productNameVerification: {
            enabled: false,
            trustEanMatch: false,
            minSimilarity: 0.25,
            minMatchingTokens: 2,
            productPageSelectors: [
                'h1',
                '.product-title',
                '.product-name',
                'meta[property="og:title"]'
            ],
            searchCardTitleSelectors: [
                'h2', 'h3', '.product-title', '.card__heading', '[class*="product-title"]'
            ],
            ...(scrape.productNameVerification || {})
        }
    };
}

async function extractProductNameOnPage(page, selectors) {
    const sels = selectors?.length
        ? selectors
        : ['h1', 'meta[property="og:title"]'];

    return page.evaluate((selList) => {
        for (const sel of selList) {
            const el = document.querySelector(sel);
            if (!el) continue;
            const text = el.getAttribute?.('content') || el.textContent || '';
            if (text.trim()) return text.trim();
        }
        return (document.title || '').split('|')[0].trim();
    }, sels);
}

async function verifyProductNameOnPage(page, sourceProductName, nameConfig) {
    if (!nameConfig?.enabled || !sourceProductName?.trim()) {
        return { pass: true, skipped: true };
    }

    const targetName = await extractProductNameOnPage(page, nameConfig.productPageSelectors);
    const result = evaluateNameSimilarity(sourceProductName, targetName, nameConfig);

    return {
        ...result,
        sourceName: sourceProductName,
        targetName
    };
}

async function collectProductLinks(page, scrapeConfig) {
    const nav = scrapeConfig.navigation || {};

    return page.evaluate((navConfig) => {
        function isExcluded(href) {
            const lower = (href || '').toLowerCase().trim();
            if (!lower.startsWith('http://') && !lower.startsWith('https://')) return true;
            if (lower.includes('/search')) return true;
            for (const pattern of navConfig.productLinkExclude || []) {
                if (lower.includes(String(pattern).toLowerCase())) return true;
            }
            return false;
        }

        function toAbsolute(path) {
            const trimmed = String(path || '').trim();
            if (!trimmed) return '';
            if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
            if (trimmed.startsWith('/')) return location.origin + trimmed;
            return location.origin + '/' + trimmed;
        }

        const attrRegex = navConfig.linkAttributeRegex
            ? new RegExp(navConfig.linkAttributeRegex)
            : null;

        const elementInfos = [];
        const elSeen = new Set();

        function addEl(el, url) {
            if (!el || !url || elSeen.has(el)) return;
            elSeen.add(el);
            elementInfos.push({ el, url });
        }

        for (const sel of navConfig.productLinkSelectors || []) {
            let nodes = [];
            try { nodes = document.querySelectorAll(sel); } catch (_) { continue; }
            for (const el of nodes) {
                const href = el.href || '';
                if (href && !isExcluded(href)) addEl(el, href);
            }
        }

        if (attrRegex) {
            for (const sel of navConfig.linkAttributeSelectors || []) {
                let nodes = [];
                try { nodes = document.querySelectorAll(sel); } catch (_) { continue; }
                for (const el of nodes) {
                    const match = (el.outerHTML || '').match(attrRegex);
                    if (!match) continue;
                    const url = toAbsolute(match[0]);
                    if (url && !isExcluded(url)) addEl(el, url);
                }
            }
        }

        elementInfos.sort((a, b) => {
            const pos = a.el.compareDocumentPosition(b.el);
            if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
            if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
            return 0;
        });

        const links = [];
        const urlSeen = new Set();
        for (const info of elementInfos) {
            if (!urlSeen.has(info.url)) {
                urlSeen.add(info.url);
                links.push(info.url);
            }
        }
        return links;
    }, nav);
}

function shouldUseFirstResultFallback(nav, resultCount) {
    if (!nav.firstResultFallback || resultCount <= 0) return false;
    if (nav.firstResultFallbackOnlyWhenSingle && resultCount > 1) return false;
    return true;
}

function serializeEanStrategies(eanExtraction) {
    const strategies = eanExtraction?.strategies
        || (eanExtraction?.type ? [{ ...eanExtraction }] : []);

    return strategies.map(strategy => ({
        type: strategy.type,
        label: strategy.label,
        selector: strategy.selector,
        regexSource: strategy.regex?.source,
        regexFlags: strategy.regex?.flags || 'i',
        patterns: (strategy.patterns || []).map(pattern =>
            pattern instanceof RegExp ? pattern.source : String(pattern)
        )
    }));
}

async function extractEanOnPage(page, eanExtraction) {
    const strategies = serializeEanStrategies(eanExtraction);

    return page.evaluate((strategyList) => {
        function normalize(value) {
            const digits = String(value || '').replace(/\D/g, '');
            return digits.length >= 8 && digits.length <= 14 ? digits : null;
        }

        function byLabel(label) {
            for (const el of document.querySelectorAll('p, span, div, td, th, li, dt, dd, label')) {
                if ((el.textContent || '').trim() !== label) continue;

                const next = el.nextElementSibling;
                if (next) {
                    const ean = normalize(next.textContent);
                    if (ean) return ean;
                }

                const parent = el.parentElement;
                if (parent) {
                    const children = [...parent.children];
                    const idx = children.indexOf(el);
                    for (let i = idx + 1; i < children.length; i++) {
                        const ean = normalize(children[i].textContent);
                        if (ean) return ean;
                    }
                }
            }
            return null;
        }

        function toRegex(strategy) {
            if (!strategy.regexSource) return null;
            return new RegExp(strategy.regexSource, strategy.regexFlags || 'i');
        }

        function byScript(strategy) {
            const regex = toRegex(strategy);
            if (!regex) return null;

            for (const script of document.querySelectorAll('script')) {
                const match = (script.innerText || '').match(regex);
                if (match?.[1]) {
                    const ean = normalize(match[1]);
                    if (ean) return ean;
                }
            }

            const pageMatch = document.documentElement.innerHTML.match(regex);
            if (pageMatch?.[1]) {
                const ean = normalize(pageMatch[1]);
                if (ean) return ean;
            }

            return null;
        }

        function byPageScan(patterns) {
            const html = document.documentElement.innerHTML;
            for (const pattern of patterns || []) {
                const regex = new RegExp(pattern, 'i');
                const match = html.match(regex);
                if (match?.[1]) {
                    const ean = normalize(match[1]);
                    if (ean) return ean;
                }
            }
            return null;
        }

        for (const strategy of strategyList) {
            let ean = null;
            if (strategy.type === 'label') ean = byLabel(strategy.label);
            else if (strategy.type === 'script') ean = byScript(strategy);
            else if (strategy.type === 'page-scan') ean = byPageScan(strategy.patterns);
            else if (strategy.type === 'dom') {
                const el = document.querySelector(strategy.selector);
                if (el) {
                    const regex = toRegex(strategy) || /\d{8,14}/;
                    const match = (el.innerText || '').match(regex);
                    ean = normalize(match?.[1] || el.innerText);
                }
            }
            if (ean) return ean;
        }

        return null;
    }, strategies);
}

async function verifyEanOnPage(page, ean) {
    const found = await page.evaluate((targetEan) => {
        const html = document.documentElement.innerHTML;
        const exact = new RegExp(`"(?:barcode|sku)"\\s*:\\s*"${targetEan}"`, 'i');
        return exact.test(html);
    }, ean);
    return found;
}

async function prioritizeLinksBySearchMatch(page, links, ean, sourceProductName, nameConfig) {
    if (!links.length) return links;

    const sourceTokens = nameConfig?.enabled
        ? tokenizeProductName(sourceProductName)
        : [];

    return page.evaluate((linkList, targetEan, tokens, cardSelectors, minMatchingTokens) => {
        const barcodeRe = new RegExp(`"barcode"\\s*:\\s*"${targetEan}"`, 'i');
        const skuRe = new RegExp(`"sku"\\s*:\\s*"${targetEan}"`, 'i');
        const barcodeMatched = [];
        const nameMatched = [];
        const rest = [];
        const seen = new Set();

        function cardMatches(html) {
            return barcodeRe.test(html) || skuRe.test(html);
        }

        function normalize(text) {
            return String(text || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
        }

        function countNameMatches(title) {
            if (!tokens?.length) return 0;
            const norm = normalize(title);
            const titleTokens = new Set(norm.split(' ').filter(Boolean));
            let hits = 0;
            for (const token of tokens) {
                if (titleTokens.has(token) || (token.length >= 4 && norm.includes(token))) hits++;
            }
            return hits;
        }

        function cardTitle(card) {
            if (!card) return '';
            for (const sel of cardSelectors || []) {
                const el = card.querySelector(sel);
                if (el?.textContent?.trim()) return el.textContent.trim();
            }
            return card.textContent?.trim() || '';
        }

        for (const url of linkList) {
            let barcodeHit = false;
            let nameHits = 0;

            for (const el of document.querySelectorAll('a[href], button[class*="quickview"]')) {
                const href = el.href || '';
                const outer = el.outerHTML || '';
                const inScope = href === url
                    || outer.includes(url.replace(location.origin, ''))
                    || (url.includes('/products/') && outer.includes(url.split('/products/')[1]?.split('?')[0] || ''));

                if (!inScope) continue;

                const card = el.closest('[class*="product"]')
                    || el.closest('li')
                    || el.closest('article')
                    || el.parentElement;
                const html = (card?.innerHTML || '') + outer;
                if (cardMatches(html)) barcodeHit = true;
                nameHits = Math.max(nameHits, countNameMatches(cardTitle(card)));
            }

            if (seen.has(url)) continue;

            if (barcodeHit) {
                barcodeMatched.push(url);
                seen.add(url);
            } else if (nameHits >= (minMatchingTokens || 2)) {
                nameMatched.push(url);
                seen.add(url);
            }
        }

        for (const url of linkList) {
            if (!seen.has(url)) rest.push(url);
        }

        return [...barcodeMatched, ...nameMatched, ...rest];
    }, links, ean, sourceTokens, nameConfig?.searchCardTitleSelectors || [], nameConfig?.minMatchingTokens ?? 2);
}

async function tryProductLinksByEan(page, ean, scrapeConfig, siteSettings, siteLabel, preCollectedLinks, sourceProductName) {
    const nav = scrapeConfig.navigation || {};
    const rawLinks = preCollectedLinks || await collectProductLinks(page, scrapeConfig);
    const links = await prioritizeLinksBySearchMatch(
        page, rawLinks, ean, sourceProductName, scrapeConfig.productNameVerification
    );
    const maxAttempts = nav.maxProductAttempts || 8;

    log('INFO', 'Trying product links by EAN verification', {
        siteLabel,
        ean,
        linkCount: links.length,
        prioritizedMatches: links.length !== rawLinks.length,
        maxAttempts
    });

    for (const link of links.slice(0, maxAttempts)) {
        try {
            await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 45000 });
            await sleep(scrapeConfig.renderDelay);

            const pageEan = await extractEanOnPage(page, siteSettings.eanExtraction);
            const htmlMatch = pageEan === ean || await verifyEanOnPage(page, ean);
            if (!htmlMatch) continue;

            const nameConfig = scrapeConfig.productNameVerification;
            if (nameConfig.enabled && !nameConfig.trustEanMatch) {
                const nameCheck = await verifyProductNameOnPage(
                    page, sourceProductName, nameConfig
                );
                if (!nameCheck.pass) {
                    log('WARN', 'Product link rejected: name mismatch', {
                        siteLabel,
                        ean,
                        productUrl: link,
                        score: nameCheck.score,
                        matchingTokens: nameCheck.matchingTokens,
                        sourceName: nameCheck.sourceName,
                        targetName: nameCheck.targetName
                    });
                    continue;
                }
            }

            log('INFO', 'EAN verified on product page', { siteLabel, ean, productUrl: link });
            return extractFromPage(page, ean, scrapeConfig);
        } catch (err) {
            log('WARN', 'Product link attempt failed', { siteLabel, link, error: err.message });
        }
    }

    return null;
}

async function extractFromPage(page, ean, scrapeConfig) {
    return page.evaluate((ean, config) => {
        const MAX_PRICE = config.maxPrice || 9999;
        const nav = config.navigation || {};

        function isValidPrice(val) {
            if (!val || val <= 0 || val > MAX_PRICE) return false;
            const decimals = String(val).split('.')[1];
            return !decimals || decimals.length <= 2;
        }

        function normalizeRawPrice(raw) {
            if (raw == null || raw === '') return null;
            const str = String(raw).trim().replace(/,/g, '');
            const val = parseFloat(str);
            if (!Number.isFinite(val) || val <= 0) return null;

            if (val > MAX_PRICE && val % 100 === 0) {
                const scaled = val / 100;
                if (isValidPrice(scaled)) return scaled;
            }

            return isValidPrice(val) ? val : null;
        }

        function parsePriceText(text) {
            if (!text || !/\d/.test(text)) return null;

            const normalized = text.replace(/\s+/g, ' ').trim();

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
                if (normalized.includes(',') && val < 10) return null;
                if (isValidPrice(val)) return val;
            }

            return null;
        }

        function isExcludedElement(el, excludeClosest) {
            if (!el || !excludeClosest?.length) return false;
            return excludeClosest.some(sel => el.closest(sel));
        }

        function extractJsonLd(strategy) {
            const paths = strategy.paths || ['offers.price'];
            const scriptSelector = strategy.scriptSelector || "script[type='application/ld+json']";

            function walkLdObject(obj) {
                if (!obj || typeof obj !== 'object') return null;

                for (const path of paths) {
                    if (path.startsWith('offers.')) {
                        const field = path.split('.')[1];
                        const offers = obj.offers;
                        const list = Array.isArray(offers) ? offers : offers ? [offers] : [];

                        for (const offer of list) {
                            const val = normalizeRawPrice(offer?.[field]);
                            if (val) {
                                return { price: val, text: String(val), selector: `json-ld ${path}` };
                            }
                        }
                    } else {
                        const val = normalizeRawPrice(path.split('.').reduce((o, k) => o?.[k], obj));
                        if (val) {
                            return { price: val, text: String(val), selector: `json-ld ${path}` };
                        }
                    }
                }

                if (Array.isArray(obj['@graph'])) {
                    for (const node of obj['@graph']) {
                        const found = walkLdObject(node);
                        if (found) return found;
                    }
                }

                return null;
            }

            for (const script of document.querySelectorAll(scriptSelector)) {
                const raw = (script.textContent || '').trim();
                if (!raw) continue;

                let data = null;
                try {
                    data = JSON.parse(raw);
                } catch (_) {
                    try {
                        data = JSON.parse(raw.replace(/'/g, '"'));
                    } catch (_2) {
                        const offerMatch = raw.match(/"offers"\s*:\s*\{[^}]*"price"\s*:\s*"?([\d.]+)"?/s);
                        if (offerMatch) {
                            const val = normalizeRawPrice(offerMatch[1]);
                            if (val) {
                                return {
                                    price: val,
                                    text: offerMatch[1],
                                    selector: 'json-ld offers.price (regex)'
                                };
                            }
                        }
                        continue;
                    }
                }

                const items = Array.isArray(data) ? data : [data];
                for (const item of items) {
                    const found = walkLdObject(item);
                    if (found) return found;
                }
            }

            return null;
        }

        function extractDataAttributes(strategy) {
            const root = document.querySelector(strategy.selector);
            if (!root) return null;

            for (const attr of strategy.attributes || []) {
                const raw = root.getAttribute(attr);
                const val = normalizeRawPrice(raw);
                if (val) {
                    return {
                        price: val,
                        text: raw,
                        selector: `${strategy.selector}[${attr}]`
                    };
                }
            }

            if (strategy.textSelector) {
                const el = root.querySelector(strategy.textSelector);
                if (el) {
                    const price = parsePriceText((el.innerText || '').trim());
                    if (price) {
                        return {
                            price,
                            text: el.innerText.trim(),
                            selector: `${strategy.selector} ${strategy.textSelector}`
                        };
                    }
                }
            }

            return null;
        }

        function extractDom(strategy) {
            const excludeClosest = strategy.excludeClosest || [
                'input', 'select', 'textarea', '[name="quantity"]', '[class*="quantity"]'
            ];
            const skipTags = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'OPTION']);
            const candidates = [];

            for (const sel of strategy.selectors || []) {
                for (const el of document.querySelectorAll(sel)) {
                    if (skipTags.has(el.tagName)) continue;
                    if (isExcludedElement(el, excludeClosest)) continue;

                    const text = (el.innerText || el.textContent || '').trim();
                    const price = parsePriceText(text);
                    if (price) {
                        candidates.push({
                            price,
                            text,
                            selector: sel,
                            hasShekel: text.includes('₪'),
                            hasComma: /,\d{3}/.test(text)
                        });
                    }
                }
            }

            if (!candidates.length) return null;

            candidates.sort((a, b) => {
                const score = (c) =>
                    (c.hasShekel ? 4 : 0) + (c.hasComma ? 2 : 0) + (c.price >= 10 ? 1 : 0);
                const diff = score(b) - score(a);
                return diff !== 0 ? diff : b.price - a.price;
            });

            const best = candidates[0];
            return { price: best.price, text: best.text, selector: best.selector };
        }

        function extractPrice() {
            for (const strategy of config.priceExtraction || []) {
                let result = null;

                if (strategy.type === 'json-ld') result = extractJsonLd(strategy);
                else if (strategy.type === 'data-attributes') result = extractDataAttributes(strategy);
                else if (strategy.type === 'dom') result = extractDom(strategy);

                if (result) return result;
            }

            return { price: null, text: null, selector: null };
        }

        function isSearchPage() {
            const href = location.href.toLowerCase();
            return (config.searchPageHints || []).some(hint => href.includes(hint.toLowerCase()));
        }

        function isProductPage() {
            const href = location.href.toLowerCase();
            if (isSearchPage()) return false;

            const hints = nav.productPageHints || [];
            if (hints.some(hint => href.includes(hint.toLowerCase()))) return true;

            if (nav.productPageConfirmSelector) {
                return document.querySelector(nav.productPageConfirmSelector) !== null;
            }

            return true;
        }

        function isExcludedProductLink(href) {
            const lower = (href || '').toLowerCase().trim();
            if (!lower.startsWith('http://') && !lower.startsWith('https://')) return true;
            if (lower.includes('/search')) return true;

            for (const pattern of nav.productLinkExclude || []) {
                if (lower.includes(String(pattern).toLowerCase())) return true;
            }

            return false;
        }

        function findProductLinkByPatterns() {
            for (const pattern of nav.productLinkPatterns || []) {
                const token = String(pattern).replace('{{ean}}', ean);

                for (const link of document.querySelectorAll('a[href]')) {
                    const href = link.href || '';
                    if (!href.includes(token)) continue;
                    if (isExcludedProductLink(href)) continue;

                    return { url: href, reason: 'product-link-pattern' };
                }
            }

            return null;
        }

        function findProductLinkByEanInHref() {
            for (const link of document.querySelectorAll('a[href]')) {
                const href = link.href || '';
                if (!href.includes(ean)) continue;
                if (isExcludedProductLink(href)) continue;

                return { url: href, reason: 'ean-in-href' };
            }

            return null;
        }

        function toAbsoluteUrl(path) {
            const trimmed = String(path || '').trim();
            if (!trimmed) return '';
            if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
            if (trimmed.startsWith('/')) return location.origin + trimmed;
            return location.origin + '/' + trimmed;
        }

        function collectProductLinks() {
            const attrRegex = nav.linkAttributeRegex
                ? new RegExp(nav.linkAttributeRegex)
                : null;

            const elementInfos = [];
            const elSeen = new Set();

            function addEl(el, url) {
                if (!el || !url || elSeen.has(el)) return;
                elSeen.add(el);
                elementInfos.push({ el, url });
            }

            for (const sel of nav.productLinkSelectors || []) {
                let nodes = [];
                try { nodes = document.querySelectorAll(sel); } catch (_) { continue; }
                for (const el of nodes) {
                    const href = el.href || '';
                    if (href && !isExcludedProductLink(href)) addEl(el, href);
                }
            }

            if (attrRegex) {
                for (const sel of nav.linkAttributeSelectors || []) {
                    let nodes = [];
                    try { nodes = document.querySelectorAll(sel); } catch (_) { continue; }
                    for (const el of nodes) {
                        const match = (el.outerHTML || '').match(attrRegex);
                        if (!match) continue;
                        const url = toAbsoluteUrl(match[0]);
                        if (url && !isExcludedProductLink(url)) addEl(el, url);
                    }
                }
            }

            elementInfos.sort((a, b) => {
                const pos = a.el.compareDocumentPosition(b.el);
                if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
                if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
                return 0;
            });

            const links = [];
            const urlSeen = new Set();
            for (const info of elementInfos) {
                if (!urlSeen.has(info.url)) {
                    urlSeen.add(info.url);
                    links.push(info.url);
                }
            }
            return links;
        }

        function cardHasEan(html) {
            const barcodeRe = new RegExp(`"barcode"\\s*:\\s*"${ean}"`, 'i');
            const skuRe = new RegExp(`"sku"\\s*:\\s*"${ean}"`, 'i');
            return barcodeRe.test(html) || skuRe.test(html);
        }

        function findProductLinkByBarcodeInCard() {
            const attrRegex = nav.linkAttributeRegex
                ? new RegExp(nav.linkAttributeRegex)
                : null;

            for (const sel of nav.linkAttributeSelectors || []) {
                for (const el of document.querySelectorAll(sel)) {
                    const card = el.closest('[class*="product"]')
                        || el.closest('li')
                        || el.closest('article')
                        || el.parentElement;
                    const html = (card?.innerHTML || '') + (el.outerHTML || '');
                    if (!cardHasEan(html)) continue;

                    if (attrRegex) {
                        const match = (el.outerHTML || '').match(attrRegex);
                        if (match) {
                            const url = toAbsoluteUrl(match[0]);
                            if (!isExcludedProductLink(url)) {
                                return { url, reason: 'barcode-in-card' };
                            }
                        }
                    }
                }
            }

            const selector = (nav.productLinkSelectors || []).join(', ') || "a[href*='/products/']";
            for (const link of document.querySelectorAll(selector)) {
                const card = link.closest('[class*="product"]')
                    || link.closest('li')
                    || link.closest('article')
                    || link.parentElement;
                if (!card || !cardHasEan(card.innerHTML || '')) continue;

                const href = link.href || '';
                if (!isExcludedProductLink(href)) {
                    return { url: href, reason: 'barcode-in-card' };
                }
            }

            return null;
        }

        function findProductLink() {
            const patternMatch = findProductLinkByPatterns();
            if (patternMatch) return patternMatch;

            const barcodeMatch = findProductLinkByBarcodeInCard();
            if (barcodeMatch) return barcodeMatch;

            const hrefMatch = findProductLinkByEanInHref();
            if (hrefMatch) return hrefMatch;

            for (const cardSel of nav.cardSelectors || []) {
                for (const card of document.querySelectorAll(cardSel)) {
                    if (!(card.innerHTML || '').includes(ean)) continue;

                    for (const link of card.querySelectorAll('a[href]')) {
                        const href = link.href || '';
                        if (isExcludedProductLink(href)) continue;
                        if (href.includes(ean)) {
                            return { url: href, reason: 'ean-in-card' };
                        }
                    }
                }
            }

            for (const img of document.querySelectorAll(`img[src*="${ean}"]`)) {
                const link = img.closest('a') || img.closest('[class*="product"]')?.querySelector('a[href]');
                if (link?.href && !isExcludedProductLink(link.href)) {
                    return { url: link.href, reason: 'ean-in-image' };
                }
            }

            if (nav.singleResultFallback !== false) {
                const productLinks = collectProductLinks();
                if (productLinks.length === 1) {
                    return { url: productLinks[0], reason: 'single-search-result' };
                }
            }

            return null;
        }

        const onSearch = isSearchPage();
        const onProduct = isProductPage();
        const productMatch = onSearch ? findProductLink() : null;
        const priceResult = onProduct ? extractPrice() : { price: null, text: null, selector: null };

        return {
            currentUrl: location.href,
            onSearch,
            onProduct,
            productLink: productMatch?.url || null,
            productLinkReason: productMatch?.reason || null,
            searchResultCount: onSearch ? collectProductLinks().length : 0,
            ...priceResult
        };
    }, ean, scrapeConfig);
}

async function preparePage(page, scrapeConfig) {
    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    if (scrapeConfig.extraHeaders && Object.keys(scrapeConfig.extraHeaders).length) {
        await page.setExtraHTTPHeaders(scrapeConfig.extraHeaders);
    }

    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'languages', { get: () => ['he-IL', 'he', 'en-US', 'en'] });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        window.chrome = window.chrome || { runtime: {} };
    });

    const blockResources = scrapeConfig.blockResources || [];
    if (blockResources.length) {
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (blockResources.includes(req.resourceType())) req.abort();
            else req.continue();
        });
    }
}

async function initCluster() {
    if (clusterInstance) return clusterInstance;
    if (clusterInitPromise) return clusterInitPromise;

    clusterInitPromise = (async () => {
        const cluster = await Cluster.launch({
            concurrency: Cluster.CONCURRENCY_PAGE,
            maxConcurrency: MAX_CONCURRENCY,
            puppeteer,
            puppeteerOptions: {
                executablePath: CHROME_PATH,
                headless: DEFAULT_SCRAPE.headless,
                args: DEFAULT_SCRAPE.launchArgs
            },
            timeout: CLUSTER_TASK_TIMEOUT_MS,
            retryLimit: 0,
            monitor: process.env.SCRAPER_CLUSTER_MONITOR === '1'
        });

        await cluster.task(async ({ page, data }) => {
            const { targetSite, ean, siteSettings, sourceProductName } = data;
            const scrapeConfig = resolveScrapeConfig(siteSettings);
            await preparePage(page, scrapeConfig);
            return scrapeWithPage(page, targetSite, ean, siteSettings, sourceProductName, scrapeConfig);
        });

        clusterInstance = cluster;
        log('INFO', 'Puppeteer cluster ready', { maxConcurrency: MAX_CONCURRENCY });
        return cluster;
    })();

    try {
        return await clusterInitPromise;
    } catch (err) {
        clusterInitPromise = null;
        throw err;
    }
}

async function scrapeWithPage(page, targetSite, ean, siteSettings, sourceProductName, scrapeConfig) {
    const siteLabel = siteSettings.displayName || siteSettings.name || targetSite;

    const searchUrl = siteSettings.searchUrlPattern.replace('{{ean}}', encodeURIComponent(ean));
        log('INFO', 'Navigate search URL', { searchUrl });

        const searchResponse = await page.goto(searchUrl, {
            waitUntil: scrapeConfig.waitUntil,
            timeout: 45000
        });
        const searchStatus = searchResponse ? searchResponse.status() : null;
        log('INFO', 'Search page response', { searchUrl, status: searchStatus });

        // Wait for product links to actually render (client-side rendered sites)
        // before relying on the fixed render delay.
        if (scrapeConfig.searchWaitForSelector) {
            try {
                await page.waitForSelector(scrapeConfig.searchWaitForSelector, {
                    timeout: scrapeConfig.searchWaitTimeout
                });
                log('INFO', 'Search selector appeared', {
                    selector: scrapeConfig.searchWaitForSelector
                });
            } catch (_) {
                log('WARN', 'Search selector did not appear within timeout', {
                    selector: scrapeConfig.searchWaitForSelector,
                    timeout: scrapeConfig.searchWaitTimeout,
                    status: searchStatus
                });
            }
        }
        await sleep(scrapeConfig.renderDelay);

        let state = await extractFromPage(page, ean, scrapeConfig);

        log('INFO', 'After search page', {
            site: targetSite,
            siteLabel,
            ean,
            currentUrl: state.currentUrl,
            onSearch: state.onSearch,
            onProduct: state.onProduct,
            productLink: state.productLink,
            price: state.price,
            matchedSelector: state.selector,
            matchedText: state.text
        });

        if (state.onSearch) {
            if (state.productLink && !state.productLink.toLowerCase().startsWith('javascript:')) {
                log('INFO', 'Follow product link', {
                    siteLabel,
                    productLink: state.productLink,
                    reason: state.productLinkReason,
                    searchResultCount: state.searchResultCount
                });
                await page.goto(state.productLink, { waitUntil: 'domcontentloaded', timeout: 45000 });
                await sleep(scrapeConfig.renderDelay);
                state = await extractFromPage(page, ean, scrapeConfig);
            } else if (scrapeConfig.navigation.tryProductLinks && state.searchResultCount > 0) {
                const searchLinks = await collectProductLinks(page, scrapeConfig);

                const verified = await tryProductLinksByEan(
                    page, ean, scrapeConfig, siteSettings, siteLabel, searchLinks, sourceProductName
                );

                if (verified) {
                    state = verified;
                } else if (shouldUseFirstResultFallback(scrapeConfig.navigation, searchLinks.length)) {
                    const firstResult = searchLinks[0];
                    log('INFO', 'First-result fallback: following first product link', {
                        siteLabel,
                        ean,
                        productUrl: firstResult,
                        searchResultCount: state.searchResultCount
                    });
                    await page.goto(firstResult, { waitUntil: 'domcontentloaded', timeout: 45000 });
                    await sleep(scrapeConfig.renderDelay);
                    state = await extractFromPage(page, ean, scrapeConfig);

                    const confirmedEan = await verifyEanOnPage(page, ean);
                    const confirmedName = await verifyProductNameOnPage(
                        page, sourceProductName, scrapeConfig.productNameVerification
                    );
                    if (!confirmedEan || !confirmedName.pass) {
                        log('WARN', 'First-result rejected: verification failed', {
                            siteLabel,
                            ean,
                            productUrl: firstResult,
                            eanOk: confirmedEan,
                            nameOk: confirmedName.pass,
                            nameScore: confirmedName.score
                        });
                        state = {
                            ...state,
                            onSearch: true,
                            onProduct: false,
                            price: null,
                            productUrl: null
                        };
                    }
                } else {
                    log('WARN', 'No product match on search page', {
                        site: targetSite,
                        siteLabel,
                        ean,
                        searchResultCount: state.searchResultCount
                    });
                }
            } else {
                log('WARN', 'No product match on search page', {
                    site: targetSite,
                    siteLabel,
                    ean,
                    searchResultCount: state.searchResultCount
                });
            }
        }

        if (!state.onSearch) {
            if (scrapeConfig.waitForSelector) {
                try {
                    await page.waitForSelector(scrapeConfig.waitForSelector, { timeout: 8000 });
                } catch (_) {
                    // continue
                }
            }
            await sleep(1500);
            state = await extractFromPage(page, ean, scrapeConfig);
        }

        log('INFO', 'After product resolution', {
            site: targetSite,
            siteLabel,
            ean,
            currentUrl: state.currentUrl,
            onSearch: state.onSearch,
            onProduct: state.onProduct,
            price: state.price,
            matchedSelector: state.selector,
            matchedText: state.text
        });

        const productUrl = page.url();
        const stillOnSearch = (scrapeConfig.searchPageHints || []).some(h =>
            productUrl.toLowerCase().includes(h.toLowerCase())
        );
        let onProductPage = state.onProduct && !stillOnSearch;

        if (onProductPage && scrapeConfig.navigation.verifyEanOnProductPage) {
            const confirmed = await verifyEanOnPage(page, ean);
            if (!confirmed) {
                log('WARN', 'Product page rejected: EAN/barcode not found in page HTML', {
                    siteLabel,
                    ean,
                    productUrl
                });
                onProductPage = false;
            }
        }

        if (onProductPage && scrapeConfig.productNameVerification?.enabled
            && !scrapeConfig.productNameVerification.trustEanMatch) {
            const nameCheck = await verifyProductNameOnPage(
                page, sourceProductName, scrapeConfig.productNameVerification
            );
            if (!nameCheck.pass) {
                log('WARN', 'Product page rejected: name similarity too low', {
                    siteLabel,
                    ean,
                    productUrl,
                    score: nameCheck.score,
                    matchingTokens: nameCheck.matchingTokens,
                    sourceName: nameCheck.sourceName,
                    targetName: nameCheck.targetName
                });
                onProductPage = false;
            }
        }

        const hasPrice = onProductPage && state.price > 0;

        log(hasPrice ? 'INFO' : 'WARN', 'Scrape complete', {
            site: targetSite,
            siteLabel,
            ean,
            onProductPage,
            hasPrice,
            price: state.price,
            productUrl: onProductPage ? productUrl : null,
            stillOnSearch,
            matchedSelector: state.selector,
            matchedText: state.text
        });

    return {
        exists: onProductPage,
        price: hasPrice ? state.price : null,
        productUrl: onProductPage ? productUrl : null,
        error: null
    };
}

async function executeScrape(targetSite, ean, siteSettings, sourceProductName = null) {
    const scrapeConfig = resolveScrapeConfig(siteSettings);
    const siteLabel = siteSettings.displayName || siteSettings.name || targetSite;

    log('INFO', 'Start scrape', {
        site: targetSite,
        siteLabel,
        ean,
        sourceProductName: sourceProductName || null,
        nameVerification: scrapeConfig.productNameVerification?.enabled || false,
        strategies: scrapeConfig.priceExtraction.map(s => s.type)
    });

    try {
        const cluster = await initCluster();
        return await cluster.execute({
            targetSite,
            ean,
            siteSettings,
            sourceProductName
        });
    } catch (err) {
        log('ERROR', 'Scrape failed', {
            site: targetSite,
            siteLabel,
            ean,
            error: err.message,
            code: err.code || 'SCRAPE_ERROR'
        });
        return {
            exists: false,
            price: null,
            productUrl: null,
            error: err.message || 'Scrape failed',
            code: err.code || 'SCRAPE_ERROR'
        };
    }
}

app.get('/health', (_req, res) => {
    res.json({
        ok: true,
        service: 'scraper',
        port: PORT,
        chromePath: CHROME_PATH,
        cluster: {
            ready: Boolean(clusterInstance),
            maxConcurrency: MAX_CONCURRENCY
        }
    });
});

async function shutdownCluster() {
    if (!clusterInstance) return;
    try {
        await clusterInstance.idle();
        await clusterInstance.close();
        log('INFO', 'Puppeteer cluster closed');
    } catch (err) {
        log('ERROR', 'Cluster shutdown failed', { error: err.message });
    } finally {
        clusterInstance = null;
        clusterInitPromise = null;
    }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
        await shutdownCluster();
        process.exit(0);
    });
}

app.post('/scrape', async (req, res) => {
    const { targetSite, searchQuery, siteSettings, sourceProductName } = req.body;

    if (!targetSite || !searchQuery) {
        return res.status(400).json({
            exists: false,
            error: 'targetSite and searchQuery are required',
            code: 'BAD_REQUEST'
        });
    }

    if (!siteSettings?.searchUrlPattern) {
        return res.status(400).json({
            exists: false,
            error: 'siteSettings.searchUrlPattern is required',
            code: 'BAD_REQUEST'
        });
    }

    try {
        const result = await executeScrape(targetSite, searchQuery, siteSettings, sourceProductName);
        res.json(result);
    } catch (err) {
        log('ERROR', 'Unhandled scrape route error', {
            targetSite,
            searchQuery,
            error: err.message,
            code: err.code
        });
        res.status(500).json({
            exists: false,
            price: null,
            productUrl: null,
            error: err.message || 'Internal scraper error',
            code: err.code || 'INTERNAL_ERROR'
        });
    }
});

app.use((err, _req, res, _next) => {
    log('ERROR', 'Express error handler', { error: err.message, code: err.code });
    res.status(500).json({
        exists: false,
        error: err.message || 'Internal server error',
        code: err.code || 'INTERNAL_ERROR'
    });
});

process.on('unhandledRejection', (reason) => {
    log('ERROR', 'Unhandled promise rejection', {
        error: reason?.message || String(reason),
        code: reason?.code
    });
});

process.on('uncaughtException', (err) => {
    log('ERROR', 'Uncaught exception — scraper may be unstable', {
        error: err.message,
        code: err.code
    });
});

app.listen(PORT, () => {
    log('INFO', `Scraper microservice ready on port ${PORT}`);
});
