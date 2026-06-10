/**
 * Isolated price-drop test — no scraper, no cache TTL concerns.
 *
 * Usage:
 *   node scripts/test-price-drop.js <installation_id> <ean> <site_key> <old_price> <new_price>
 *
 * Example:
 *   node scripts/test-price-drop.js 11111111-1111-1111-1111-111111111111 3614274000597 www.shufersal.co.il 479 399
 */
const pool = require('../db/pool');
const { processPriceDropAlerts } = require('../services/priceDropService');

const [,, installationId, ean, siteKey, oldPrice, newPrice] = process.argv;

if (!installationId || !ean || !siteKey || !oldPrice || !newPrice) {
    console.error('Usage: node scripts/test-price-drop.js <installation_id> <ean> <site_key> <old_price> <new_price>');
    process.exit(1);
}

(async () => {
    await pool.query(
        `INSERT INTO products (ean, product_name) VALUES ($1, 'Test Product')
         ON CONFLICT (ean) DO NOTHING`,
        [ean]
    );

    await pool.query(
        `INSERT INTO product_site_offers (ean, site_key, product_url, price, exists_on_site, collected_at, updated_at)
         VALUES ($1, $2, 'https://example.com/p', $3, TRUE, NOW(), NOW())
         ON CONFLICT (ean, site_key) DO UPDATE SET
            price = EXCLUDED.price,
            exists_on_site = TRUE,
            collected_at = NOW()`,
        [ean, siteKey, oldPrice]
    );

    const user = await pool.query(
        `INSERT INTO users (installation_id) VALUES ($1)
         ON CONFLICT (installation_id) DO UPDATE SET last_seen_at = NOW()
         RETURNING id`,
        [installationId]
    );
    const userId = user.rows[0].id;

    await pool.query(
        `INSERT INTO user_tracker
            (user_id, ean, source_site, tracking_type, baseline_price, baseline_site_key, is_active)
         VALUES ($1, $2, $3, 'active', $4, $5, TRUE)
         ON CONFLICT (user_id, ean, source_site) DO UPDATE SET
            tracking_type = 'active',
            baseline_price = EXCLUDED.baseline_price,
            is_active = TRUE,
            unsubscribed_at = NULL`,
        [userId, ean, siteKey, oldPrice, siteKey]
    );

    const result = await processPriceDropAlerts(pool, {
        ean,
        siteKey,
        newPrice: Number(newPrice),
        productUrl: `https://example.com/p/${ean}`,
        productName: 'Test Product',
        previousPrice: Number(oldPrice)
    });

    const alerts = await pool.query(
        `SELECT * FROM price_drop_alerts a
         JOIN users u ON u.id = a.user_id
         WHERE u.installation_id = $1 AND a.ean = $2
         ORDER BY a.created_at DESC LIMIT 5`,
        [installationId, ean]
    );

    console.log('Price drop result:', result);
    console.log('Alerts:', alerts.rows);
    await pool.end();
})().catch(err => {
    console.error(err.message);
    process.exit(1);
});
