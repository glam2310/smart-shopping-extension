const { PASSIVE_DWELL_TIME_SEC } = require('../config/cache');
const { ensureProduct } = require('./cacheService');
const { getLowestActivePriceForEan } = require('./priceDropService');
const { ensureUser } = require('./userService');

async function trackProduct(pool, payload) {
    const {
        installation_id,
        ean,
        source_site,
        tracking_type,
        dwell_seconds,
        source_url,
        product_name,
        brand,
        session_id,
        extension_version,
        locale,
        platform,
        timezone
    } = payload;

    if (!installation_id || !ean || !source_site || !tracking_type) {
        const err = new Error('Missing required fields: installation_id, ean, source_site, tracking_type');
        err.status = 400;
        throw err;
    }

    if (!/^\d{8,14}$/.test(ean)) {
        const err = new Error('Invalid EAN format');
        err.status = 400;
        throw err;
    }

    if (tracking_type === 'passive') {
        if (!dwell_seconds || dwell_seconds < PASSIVE_DWELL_TIME_SEC) {
            return {
                accepted: false,
                reason: `Passive tracking requires dwell >= ${PASSIVE_DWELL_TIME_SEC}s`
            };
        }
    }

    const userId = await ensureUser(pool, {
        installationId: installation_id,
        extensionVersion: extension_version,
        locale,
        platform,
        timezone
    });

    await ensureProduct(pool, ean, { productName: product_name, brand });

    let baselinePrice = null;
    let baselineSiteKey = null;
    if (tracking_type === 'active') {
        const lowest = await getLowestActivePriceForEan(pool, ean);
        if (lowest?.price) {
            baselinePrice = Number(lowest.price);
            baselineSiteKey = lowest.site_key;
        }
    }

    const { rows } = await pool.query(
        `INSERT INTO user_tracker
            (user_id, ean, source_site, tracking_type, dwell_seconds,
             source_url, product_name, brand, session_id,
             baseline_price, baseline_site_key, last_tracked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
         ON CONFLICT (user_id, ean, source_site) DO UPDATE SET
            tracking_type = CASE
                WHEN EXCLUDED.tracking_type = 'active' THEN 'active'::tracking_type
                WHEN user_tracker.tracking_type = 'active' THEN 'active'::tracking_type
                ELSE 'passive'::tracking_type
            END,
            dwell_seconds     = GREATEST(COALESCE(user_tracker.dwell_seconds, 0), COALESCE(EXCLUDED.dwell_seconds, 0)),
            source_url        = COALESCE(EXCLUDED.source_url, user_tracker.source_url),
            product_name      = COALESCE(EXCLUDED.product_name, user_tracker.product_name),
            brand             = COALESCE(EXCLUDED.brand, user_tracker.brand),
            session_id        = COALESCE(EXCLUDED.session_id, user_tracker.session_id),
            baseline_price    = CASE
                WHEN EXCLUDED.tracking_type = 'active' AND user_tracker.baseline_price IS NULL
                    THEN COALESCE(EXCLUDED.baseline_price, user_tracker.baseline_price)
                ELSE user_tracker.baseline_price
            END,
            baseline_site_key = CASE
                WHEN EXCLUDED.tracking_type = 'active' AND user_tracker.baseline_site_key IS NULL
                    THEN COALESCE(EXCLUDED.baseline_site_key, user_tracker.baseline_site_key)
                ELSE user_tracker.baseline_site_key
            END,
            last_tracked_at   = NOW(),
            is_active         = TRUE,
            unsubscribed_at   = NULL
         RETURNING id, tracking_type, baseline_price, last_tracked_at`,
        [
            userId,
            ean,
            source_site,
            tracking_type,
            dwell_seconds || null,
            source_url || null,
            product_name || null,
            brand || null,
            session_id || null,
            baselinePrice,
            baselineSiteKey
        ]
    );

    return { accepted: true, tracker: rows[0] };
}

async function getUserTracker(pool, installationId) {
    const { rows } = await pool.query(
        `SELECT ut.id, ut.ean, ut.source_site, ut.tracking_type,
                ut.dwell_seconds, ut.product_name, ut.brand,
                ut.source_url, ut.first_tracked_at, ut.last_tracked_at
         FROM user_tracker ut
         JOIN users u ON u.id = ut.user_id
         WHERE u.installation_id = $1 AND ut.is_active = TRUE
         ORDER BY ut.last_tracked_at DESC`,
        [installationId]
    );
    return rows;
}

async function isTracked(pool, installationId, ean, sourceSite) {
    const { rows } = await pool.query(
        `SELECT ut.tracking_type, ut.last_tracked_at
         FROM user_tracker ut
         JOIN users u ON u.id = ut.user_id
         WHERE u.installation_id = $1
           AND ut.ean = $2
           AND ut.source_site = $3
           AND ut.is_active = TRUE
         LIMIT 1`,
        [installationId, ean, sourceSite]
    );
    return rows[0] || null;
}

async function optOutTracking(pool, { installation_id, ean, source_site }) {
    if (!installation_id || !ean) {
        const err = new Error('installation_id and ean are required');
        err.status = 400;
        throw err;
    }

    const { rows } = await pool.query(
        `UPDATE user_tracker ut
         SET is_active = FALSE,
             unsubscribed_at = NOW()
         FROM users u
         WHERE ut.user_id = u.id
           AND u.installation_id = $1
           AND ut.ean = $2
           AND ut.is_active = TRUE
           AND ($3::text IS NULL OR ut.source_site = $3)
         RETURNING ut.id, ut.ean, ut.source_site, ut.tracking_type`,
        [installation_id, ean, source_site || null]
    );

    if (!rows.length) {
        return { optedOut: false, reason: 'No active tracking row found' };
    }

    return { optedOut: true, count: rows.length, items: rows };
}

module.exports = {
    trackProduct,
    getUserTracker,
    isTracked,
    optOutTracking,
    PASSIVE_DWELL_TIME_SEC
};
