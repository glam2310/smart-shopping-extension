const { CACHE_TTL_HOURS } = require('../config/cache');

const CACHE_TTL_MS = CACHE_TTL_HOURS * 60 * 60 * 1000;

function isOfferFresh(collectedAt) {
    if (!collectedAt) return false;
    const age = Date.now() - new Date(collectedAt).getTime();
    return age < CACHE_TTL_MS;
}

function isValidOffer(row) {
    return row.exists_on_site
        && row.price > 0
        && row.price < 10000
        && row.product_url
        && !row.product_url.toLowerCase().includes('/search');
}

function isPartialOffer(row) {
    return row.exists_on_site
        && row.product_url
        && !row.product_url.toLowerCase().includes('/search')
        && !(row.price > 0);
}

function isNegativeCache(row) {
    return row && row.exists_on_site === false;
}

async function getCachedOffers(pool, ean, siteKeys) {
    const { rows } = await pool.query(
        `SELECT site_key, product_url, price, exists_on_site, collected_at
         FROM product_site_offers
         WHERE ean = $1 AND site_key = ANY($2::text[])`,
        [ean, siteKeys]
    );

    const bySite = Object.fromEntries(rows.map(r => [r.site_key, r]));
    const fresh = {};
    const staleOrMissing = [];

    for (const site of siteKeys) {
        const row = bySite[site];
        if (!row || !isOfferFresh(row.collected_at)) {
            staleOrMissing.push(site);
            continue;
        }

        if (isValidOffer(row)) {
            fresh[site] = {
                exists: true,
                cachedPrice: Number(row.price),
                productUrl: row.product_url,
                collectedAt: row.collected_at,
                fromCache: true
            };
            continue;
        }

        if (isPartialOffer(row)) {
            fresh[site] = {
                exists: true,
                cachedPrice: null,
                productUrl: row.product_url,
                collectedAt: row.collected_at,
                fromCache: true,
                partial: true
            };
            continue;
        }

        if (isNegativeCache(row)) {
            fresh[site] = {
                exists: false,
                cachedPrice: null,
                productUrl: null,
                collectedAt: row.collected_at,
                fromCache: true,
                negativeCache: true
            };
            continue;
        }

        staleOrMissing.push(site);
    }

    return { fresh, staleOrMissing };
}

async function ensureProduct(pool, ean, meta = {}) {
    await pool.query(
        `INSERT INTO products (ean, product_name, brand)
         VALUES ($1, $2, $3)
         ON CONFLICT (ean) DO UPDATE SET
            product_name = COALESCE(EXCLUDED.product_name, products.product_name),
            brand        = COALESCE(EXCLUDED.brand, products.brand),
            updated_at   = NOW()`,
        [ean, meta.productName || null, meta.brand || null]
    );
}

async function getOfferPrice(pool, ean, siteKey) {
    const { rows } = await pool.query(
        `SELECT price, product_url, exists_on_site
         FROM product_site_offers
         WHERE ean = $1 AND site_key = $2`,
        [ean, siteKey]
    );
    return rows[0] || null;
}

async function upsertOffer(pool, {
    ean,
    siteKey,
    productUrl,
    price,
    outcome,
    productName,
    brand
}) {
    const previousOffer = await getOfferPrice(pool, ean, siteKey);
    await ensureProduct(pool, ean, { productName, brand });

    if (outcome === 'found') {
        await pool.query(
            `INSERT INTO product_site_offers
                (ean, site_key, product_url, price, exists_on_site, collected_at, updated_at)
             VALUES ($1, $2, $3, $4, TRUE, NOW(), NOW())
             ON CONFLICT (ean, site_key) DO UPDATE SET
                product_url    = EXCLUDED.product_url,
                price          = EXCLUDED.price,
                exists_on_site = TRUE,
                collected_at   = NOW(),
                updated_at     = NOW()`,
            [ean, siteKey, productUrl, price]
        );
        return { previousOffer, updated: true, outcome: 'found', price };
    }

    if (outcome === 'partial') {
        await pool.query(
            `INSERT INTO product_site_offers
                (ean, site_key, product_url, price, exists_on_site, collected_at, updated_at)
             VALUES ($1, $2, $3, NULL, TRUE, NOW(), NOW())
             ON CONFLICT (ean, site_key) DO UPDATE SET
                product_url    = EXCLUDED.product_url,
                price          = COALESCE(EXCLUDED.price, product_site_offers.price),
                exists_on_site = TRUE,
                collected_at   = NOW(),
                updated_at     = NOW()`,
            [ean, siteKey, productUrl]
        );
        return { previousOffer, updated: true, outcome: 'partial', price: null };
    }

    if (outcome === 'not_found') {
        await pool.query(
            `INSERT INTO product_site_offers
                (ean, site_key, product_url, price, exists_on_site, collected_at, updated_at)
             VALUES ($1, $2, NULL, NULL, FALSE, NOW(), NOW())
             ON CONFLICT (ean, site_key) DO UPDATE SET
                exists_on_site = FALSE,
                product_url    = NULL,
                price          = NULL,
                collected_at   = NOW(),
                updated_at     = NOW()`,
            [ean, siteKey]
        );
        return { previousOffer, updated: false, outcome: 'not_found', price: null };
    }

    return { previousOffer, updated: false, outcome: 'skipped', price: null };
}

module.exports = {
    CACHE_TTL_HOURS,
    isOfferFresh,
    isValidOffer,
    isPartialOffer,
    isNegativeCache,
    getCachedOffers,
    ensureProduct,
    getOfferPrice,
    upsertOffer
};
