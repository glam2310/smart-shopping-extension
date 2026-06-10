// config.js

const SITES_CONFIG = {
    "shop.super-pharm.co.il": {
        name: "Super-Pharm",
        displayName: "סופר-פארם",
        siteType: "retail",
        searchUrlPattern: "https://shop.super-pharm.co.il/search?q={{ean}}",
        eanExtraction: {
            type: "dom",
            selector: ".description-ean",
            regex: /(\d+)/
        },
        scrape: {
            waitForSelector: "script[type='application/ld+json'], .item-price, .price-container",
            renderDelay: 3500,
            priceExtraction: [
                {
                    type: "json-ld",
                    paths: ["offers.price", "offers.lowPrice"]
                },
                {
                    type: "data-attributes",
                    selector: ".item-price",
                    attributes: ["data-discountprice", "data-price"],
                    textSelector: ".shekels"
                },
                {
                    type: "dom",
                    selectors: [
                        ".item-price .shekels",
                        ".price-final_amount",
                        ".current-price",
                        ".sale-price"
                    ],
                    excludeClosest: [".cost-per-unit", ".old-price", "[class*='cost-per-unit']"]
                }
            ],
            navigation: {
                productPageHints: ["/p/"],
                productLinkSelectors: ["a[href*='/p/']"]
            }
        }
    },

    "365mashbir.co.il": {
        name: "Mashbir",
        displayName: "משביר",
        siteType: "retail",
        searchUrlPattern: "https://365mashbir.co.il/search?q={{ean}}",
        eanExtraction: {
            strategies: [
                { type: "script", regex: /"barcode"\s*:\s*"(\d{8,14})"/i },
                { type: "script", regex: /"sku"\s*:\s*"(\d{8,14})"/i },
                {
                    type: "page-scan",
                    patterns: [
                        /"barcode"\s*:\s*"(\d{8,14})"/i,
                        /"sku"\s*:\s*"(\d{8,14})"/i
                    ]
                }
            ]
        },
        scrape: {
            renderDelay: 3500,
            searchPageHints: ["/search", "?q="],
            productNameVerification: {
                enabled: true,
                trustEanMatch: true,
                minSimilarity: 0.2,
                minMatchingTokens: 2,
                productPageSelectors: [
                    "h1",
                    ".product-title",
                    ".product-name",
                    "meta[property='og:title']"
                ],
                searchCardTitleSelectors: [
                    "h2", "h3", ".product-title", ".card__heading", "[class*='product-title']"
                ]
            },
            priceExtraction: [
                {
                    type: "data-attributes",
                    selector: "meta[property='og:price:amount']",
                    attributes: ["content"]
                },
                {
                    type: "json-ld",
                    paths: ["offers.price", "offers.lowPrice"]
                },
                {
                    type: "dom",
                    selectors: [
                        ".price-item--regular .price-item__price",
                        ".product__info .price",
                        ".price-wrapper .price",
                        ".final-price",
                        ".product-price"
                    ],
                    excludeClosest: [
                        "input", "select", "textarea",
                        "[name='quantity']", "[id*='Quantity']",
                        "[class*='quantity']", ".quantity"
                    ]
                }
            ],
            navigation: {
                productPageHints: ["/products/"],
                productLinkSelectors: ["a[href*='/products/']"],
                linkAttributeSelectors: [
                    "button.button-label-btn-quickview",
                    "[onclick*='/products/']",
                    "[\\@click\\.prevent*='/products/']",
                    "button[class*='quickview']"
                ],
                linkAttributeRegex: "/products/[^'\"\\)\\s]+",
                productPageConfirmSelector: "h1, .product-title, .product-name",
                singleResultFallback: false,
                tryProductLinks: true,
                // Mashbir search is fuzzy — never blindly take first of many results
                firstResultFallback: false,
                firstResultFallbackOnlyWhenSingle: true,
                verifyEanOnProductPage: true,
                maxProductAttempts: 15
            }
        }
    },

    "ksp.co.il": {
        name: "KSP",
        displayName: "KSP",
        siteType: "retail",
        enabled: false, // dev only — set true before prod
        compareRole: "origin-only",
        requiresEan: true,
        noEanMessage: "מוצר זה לא נתמך בחיפוש באתרים אחרים (אין ברקוד)",
        searchUrlPattern: "https://ksp.co.il/web/cat/?search={{ean}}",
        eanExtraction: {
            strategies: [
                { type: "label", label: "ברקוד" },
                {
                    type: "page-scan",
                    patterns: [/ברקוד[\s\S]{0,120}?(\d{8,14})/i, /"barcode"\s*:\s*"(\d{8,14})"/i]
                },
                { type: "script", regex: /"barcode"\s*:\s*"(\d{8,14})"/i }
            ]
        },
        scrape: {
            // KSP is a client-rendered React app; wait for the product anchors to
            // hydrate (networkidle2 + waitForSelector) instead of a fixed delay.
            // NOTE: KSP sits behind Cloudflare bot-management that currently returns a
            // hard HTTP 403 "KSP Forbidden 403" page to automated browsers (verified:
            // headless+headed, stealth, persistent profile all blocked). These render
            // knobs only take effect once the 403 block is bypassed (cf_clearance cookie
            // injection, a Cloudflare-aware proxy/API, or curl-impersonate).
            renderDelay: 4500,
            waitUntil: "networkidle2",
            searchWaitForSelector: "a[href*='/web/item/'], a[href*='/web/item']",
            searchWaitTimeout: 12000,
            searchPageHints: ["/web/cat/", "?search="],
            priceExtraction: [
                {
                    type: "dom",
                    selectors: [".rtl-69i1ev", ".product-price", "[class*='price']"]
                }
            ],
            navigation: {
                productPageHints: ["/web/item"],
                productLinkSelectors: ["a[href*='/web/item/']", "a[href*='/web/item']"],
                singleResultFallback: false,
                tryProductLinks: true,
                firstResultFallback: true,
                maxProductAttempts: 10
            }
        }
    },

    "www.shufersal.co.il": {
        name: "Shufersal",
        displayName: "שופרסל",
        siteType: "retail",
        searchUrlPattern: "https://www.shufersal.co.il/online/he/search?text={{ean}}",
        eanExtraction: {
            type: "dom",
            selector: ".productCode .text",
            regex: /(\d+)/
        },
        scrape: {
            waitForSelector: ".productPrice, .actualPrice, .miglog-prod-price, script[type='application/ld+json']",
            renderDelay: 5000,
            priceExtraction: [
                {
                    type: "json-ld",
                    paths: ["offers.price", "offers.lowPrice"]
                },
                {
                    type: "dom",
                    selectors: [
                        ".productPrice",
                        ".actualPrice",
                        ".miglog-prod-price",
                        "[class*='productPrice']",
                        "[class*='actualPrice']"
                    ]
                }
            ],
            navigation: {
                productPageHints: ["/p/P_"],
                productLinkPatterns: ["/p/P_{{ean}}", "/p/{{ean}}"],
                productLinkSelectors: ["a[href*='/p/P_']"],
                productLinkExclude: [
                    "/promo/",
                    "/login",
                    "/register",
                    "/coupons",
                    "/wish-lists",
                    "/my-account",
                    "/online/he/s",
                    "/online/he/a",
                    "/online/he/b",
                    "/online/he/f",
                    "/online/he/g",
                    "/online/he/c/"
                ],
                cardSelectors: [".miglog-prod-wrapper", ".tile", "[data-product-code]"],
                singleResultFallback: false
            }
        }
    }
};

function isSiteEnabled(cfg) {
    return Boolean(cfg) && cfg.enabled !== false;
}

function resolveSiteEntry(hostname) {
    if (!hostname) return null;

    if (SITES_CONFIG[hostname]) return { key: hostname, cfg: SITES_CONFIG[hostname] };

    const withoutWww = hostname.replace(/^www\./, '');
    if (SITES_CONFIG[withoutWww]) return { key: withoutWww, cfg: SITES_CONFIG[withoutWww] };

    const withWww = hostname.startsWith('www.') ? hostname : `www.${hostname}`;
    if (SITES_CONFIG[withWww]) return { key: withWww, cfg: SITES_CONFIG[withWww] };

    return null;
}

function getSiteConfig(hostname) {
    const resolved = resolveSiteEntry(hostname);
    if (!resolved || !isSiteEnabled(resolved.cfg)) return null;
    return resolved.cfg;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { SITES_CONFIG, getSiteConfig, isSiteEnabled, resolveSiteEntry };
}

if (typeof window !== 'undefined') {
    window.getSiteConfig = getSiteConfig;
    window.isSiteEnabled = isSiteEnabled;
}
