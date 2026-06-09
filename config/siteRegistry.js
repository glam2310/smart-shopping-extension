/**
 * Site Registry — קונפיג מובנה לכל אתר קניות.
 *
 * מבנה:
 *   meta          — שם תצוגה
 *   roles         — asSource (extension) / asTarget (scraper)
 *   source        — חילוץ מזהים מעמוד המוצר (content.js)
 *   target        — חיפוש, matching ומחיר (scraper / BaseAdapter)
 *   enrichment    — השלמת EAN כשהמקור לא מספק (אופציונלי)
 *
 * שדות עם TODO — להשלמה ידנית לפני הפעלת אתר חדש.
 * config.js בונה מכאן את SITES_CONFIG השטוח לתאימות לאחור.
 */

const COMPARISON_MATRIX = {
    'www.adidas.co.il': {
        'www.terminalx.com': true,
        'shop.super-pharm.co.il': true
    },
    'www.terminalx.com': {
        'www.adidas.co.il': true
    },
    'shop.super-pharm.co.il': {
        // שלב 1: ללא יציאה מסופר-פארם לאתרים אחרים
    }
};

const SITE_REGISTRY = {
    'www.adidas.co.il': {
        meta: {
            name: 'Adidas'
        },
        roles: {
            asSource: true,
            asTarget: true
        },

        // ─── SOURCE: Extension (content.js) ───────────────────────────────
        source: {
            skuExtraction: {
                type: 'url',
                regex: /\/([A-Z0-9]{5,6})\.html/i
            },
            eanExtraction: {
                type: 'api',
                endpoint:
                    'https://apps.bazaarvoice.com/api/data/products.json' +
                    '?passkey=caJo6jPrbeNgnirJIgc116AoUTbGo2LVHawofYQqslZ7s' +
                    '&locale=he_IL&apiVersion=5.4&filter=id:{{CURRENT_SKU}}',
                jsonPath: 'Results[0].EANs'
            },
            selectors: {
                brand: 'Adidas',
                productName:
                    "h1[class*='product-name'], h1.product-name, " +
                    "[data-string-id='pdp.productName'], h1",
                skuFallback: "[data-sku], [meta-sku], .product-id_2O8x"
            },
            productPageDetection: {
                // TODO: להעביר ל-content.js מקונפיג (כיום hardcoded)
                type: 'url-pattern',
                pattern: /\/[A-Z0-9]{5,6}\.html/i
            }
        },

        // ─── TARGET: Scraper (scraper.js / BaseAdapter) ───────────────────
        target: {
            capabilities: {
                isOfficialBrandSite: true,
                supportsEanSearch: false,
                acceptsExternalSku: true
            },
            searchStrategy: {
                priority: ['sku', 'text']
            },
            skuNormalization: 'adidas',
            navigation: {
                searchUrlPattern: 'https://{{domain}}/he/search?q={{query}}',
                skuInUrlPattern: '/{{query}}.html'
                // productUrlPattern: null  // TODO: אם חיפוש SKU צריך URL ישיר לעמוד מוצר
            },
            match: {
                noResultsIndicator: '.search-no-results-wrapper',
                refinementEnabled: true,
                listingRefinement: {
                    cardSelector:
                        "div[class*='product-card'], .glass-product-card, .product-card_1X8y",
                    linkSelector: 'a',
                    skuPattern: '([A-Z0-9]{5,6})'
                }
                // spuriousUrlMarkers: []     // TODO: URLים לסינון false positives
                // requireIdentifierInCard: false
            },
            selectors: {
                productPageIndicator:
                    "button[data-bluecore-id='addToBag-button'], .product-id_2O8y, " +
                    "h1[class*='product-name']",
                firstResultAnchor:
                    "div[class*='product-card'] a, .glass-product-card__assets a, " +
                    ".product-card_1X8y a, a[href*='.html']",
                priceSelectors: [
                    '.gl-price-item--sale',
                    '.gl-price-item',
                    '[data-string-id="pdp.price"]',
                    '.price-wrapper span',
                    'span[class*="price"]'
                ]
            },
            scraper: {
                renderDelay: 4000,
                waitTimeout: 15000,
                waitUntil: 'networkidle2',
                requiresStyles: true
                // viewport: null
            }
        },

        // ─── ENRICHMENT: השלמת EAN כשהיעד דורש ואין במקור ───────────────
        enrichment: {
            strategy: 'bazaarvoice-api',
            dependsOn: 'sku',
            endpoint:
                'https://apps.bazaarvoice.com/api/data/products.json' +
                '?passkey=caJo6jPrbeNgnirJIgc116AoUTbGo2LVHawofYQqslZ7s' +
                '&locale=he_IL&apiVersion=5.4&filter=id:{{SKU}}',
            // browserIntercept: true   // TODO: נדרש לשרת — intercept בעמוד אדידס
            maxEanAttempts: 10
        }
    },

    'www.terminalx.com': {
        meta: {
            name: 'Terminal X'
        },
        roles: {
            asSource: true,
            asTarget: true
        },

        source: {
            skuExtraction: {
                type: 'script',
                regex: /"supplier_style"\s*:\s*"([^"]+)"/
            },
            eanExtraction: {
                type: 'page-scan',
                patterns: [
                    /"(?:gtin13|gtin|ean|barcode)"\s*:\s*"(\d{13})"/gi,
                    /\/(\d{13})\.jpg/gi
                ]
            },
            selectors: {
                brand: "[data-testid='product-brand']",
                productName: 'h1',
                skuFallback: null // TODO: fallback selector אם supplier_style חסר
            },
            productPageDetection: {
                // TODO: להעביר ל-content.js מקונפיג (כיום hardcoded)
                type: 'script-or-h1',
                skuRegex: /"supplier_style"\s*:\s*"([^"]+)"/,
                excludeUrlPatterns: [/\/catalogsearch\//, /\/search\?/, /terminalx\.com\/?$/]
            }
        },

        target: {
            capabilities: {
                isOfficialBrandSite: false,
                supportsEanSearch: true,
                acceptsExternalSku: true
            },
            searchStrategy: {
                priority: ['ean', 'sku', 'text']
            },
            navigation: {
                searchUrlPattern: 'https://{{domain}}/catalogsearch/result?q={{query}}'
            },
            match: {
                noResultsIndicator: '.message.notice, .search-empty',
                refinementEnabled: true,
                listingRefinement: {
                    cardSelector: '.product-item-info, li.product-item',
                    linkSelector: 'a.product-item-link, a',
                    skuPattern: 'supplier_style["\'\\s:]*["\']([A-Z0-9-]+)["\']',
                    eanPattern: '(?:gtin13|gtin|ean)["\'\\s:]*["\'](\\d{13})["\']'
                }
            },
            selectors: {
                productPageIndicator: '.product-info-main',
                firstResultAnchor: '.product-item-info a, .product-item-link',
                priceSelectors: [
                    '.final-price_8CiX',
                    '.price-final_price .price',
                    '[data-testid="product-price"]'
                ]
            },
            scraper: {
                renderDelay: 2500,
                waitTimeout: 10000,
                waitUntil: 'domcontentloaded',
                requiresStyles: false
            }
        },

        enrichment: null
    },

    'shop.super-pharm.co.il': {
        meta: {
            name: 'Super-Pharm'
        },
        roles: {
            asSource: true,
            asTarget: true
        },

        source: {
            skuExtraction: {
                type: 'url',
                regex: /\/p\/(\d+)/
            },
            eanExtraction: {
                type: 'page-scan',
                patterns: [
                    /\/(\d{13})\.jpg/gi,
                    /"(?:gtin13|gtin|ean|barcode)"\s*:\s*"(\d{13})"/gi,
                    /itemprop="gtin13"\s+content="(\d{13})"/gi
                ]
            },
            selectors: {
                brand: ".product-brand, .brand-name, [itemprop='brand']",
                productName:
                    'h1.product-name, h1[itemprop="name"], .product-title h1, h1',
                skuFallback: null // TODO: fallback אם /p/ID לא ב-URL
            },
            productPageDetection: {
                // TODO: להעביר ל-content.js מקונפיג (כיום hardcoded)
                type: 'url-pattern',
                pattern: /\/p\/\d+/i
            }
        },

        target: {
            capabilities: {
                isOfficialBrandSite: false,
                supportsEanSearch: true,
                acceptsExternalSku: false
            },
            searchStrategy: {
                priority: ['ean'],
                fallback: ['text']
            },
            navigation: {
                searchUrlPattern: 'https://{{domain}}/search?text={{query}}',
                searchUrlVariants: [
                    'https://{{domain}}/search?text={{query}}',
                    'https://{{domain}}/search?q={{query}}'
                ]
            },
            match: {
                noResultsIndicator: '.no-results, .search-empty',
                refinementEnabled: true,
                listingRefinement: {
                    cardSelector:
                        ".product-item, .product-box, li.item, [class*='product-item']",
                    linkSelector: 'a',
                    eanPattern: '(\\d{13})'
                },
                spuriousUrlMarkers: [
                    'wet-wipes',
                    'diapering',
                    'infants-and-toddlers',
                    'מגבונים',
                    'חיתול'
                ],
                requireIdentifierInCard: true,
                noResultsText: [
                    'לא מצאנו תוצאות',
                    'לא נמצאו תוצאות',
                    'לא נמצאו'
                ]
            },
            selectors: {
                productPageIndicator:
                    'h1.product-name, h1[itemprop="name"], .product-details, .product-info',
                firstResultAnchor:
                    ".product-item a, .product-box a, .search-result-item a, " +
                    "[class*='product'] a[href*='/p/']",
                priceSelectors: [
                    '.price-value',
                    '.product-price',
                    '[data-testid="price"]',
                    '.sale-price',
                    '.regular-price',
                    '.special-price .price',
                    'span.price'
                ]
            },
            scraper: {
                renderDelay: 4000,
                waitTimeout: 15000,
                waitUntil: 'networkidle2',
                viewport: { width: 1280, height: 900 },
                requiresStyles: true
            }
        },

        enrichment: null
    }

    // ─── תבנית לאתר חדש (העתק והשלם) ─────────────────────────────────────
    //
    // 'www.new-shop.co.il': {
    //     meta: { name: 'New Shop' },
    //     roles: { asSource: true, asTarget: false },
    //
    //     source: {
    //         skuExtraction: { type: 'url' | 'script', regex: /.../ },
    //         eanExtraction: {
    //             type: 'page-scan' | 'api' | 'json-ld',
    //             patterns: [/.../gi],           // page-scan
    //             endpoint: '...{{CURRENT_SKU}}' // api
    //         },
    //         selectors: {
    //             brand: '...',
    //             productName: 'h1',
    //             skuFallback: '...'             // TODO
    //         },
    //         productPageDetection: {           // TODO
    //             type: 'url-pattern',
    //             pattern: /.../
    //         }
    //     },
    //
    //     target: {
    //         capabilities: {
    //             isOfficialBrandSite: false,
    //             supportsEanSearch: true,
    //             acceptsExternalSku: true
    //         },
    //         searchStrategy: { priority: ['ean', 'sku'], fallback: ['text'] },
    //         navigation: {
    //             searchUrlPattern: 'https://{{domain}}/search?q={{query}}'
    //         },
    //         match: {
    //             noResultsIndicator: '...',
    //             listingRefinement: { cardSelector: '...', linkSelector: 'a' }
    //         },
    //         selectors: {
    //             productPageIndicator: '...',
    //             firstResultAnchor: '...',
    //             priceSelectors: ['...']
    //         },
    //         scraper: {
    //             renderDelay: 2500,
    //             waitTimeout: 10000,
    //             waitUntil: 'domcontentloaded'
    //         }
    //     },
    //
    //     enrichment: null
    // }
};

function getAllowedTargets(sourceHostname) {
    const row = COMPARISON_MATRIX[sourceHostname];
    if (!row) return [];
    return Object.keys(row).filter(target => row[target] === true);
}

function isComparisonAllowed(sourceHostname, targetHostname) {
    return COMPARISON_MATRIX[sourceHostname]?.[targetHostname] === true;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        SITE_REGISTRY,
        COMPARISON_MATRIX,
        getAllowedTargets,
        isComparisonAllowed
    };
}

if (typeof window !== 'undefined') {
    window.SITE_REGISTRY = SITE_REGISTRY;
    window.COMPARISON_MATRIX = COMPARISON_MATRIX;
    window.getAllowedTargets = getAllowedTargets;
    window.isComparisonAllowed = isComparisonAllowed;
}
