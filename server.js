// server.js

const express = require('express');
const cors = require('cors');

const pool = require('./db/pool');
const { getCachedOffers, upsertOffer } = require('./services/cacheService');
const { trackProduct, getUserTracker, isTracked, optOutTracking } = require('./services/trackerService');
const { processPriceDropAlerts, getUnreadAlerts } = require('./services/priceDropService');
const { COMPARE_TARGET_SITES } = require('./config/cache');
const {
    formatScraperError,
    checkScraperHealth,
    requestLiveScrape,
    SCRAPER_BASE
} = require('./services/scraperClient');

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(cors());
app.use(express.json());

function log(level, message, meta = null) {
    const ts = new Date().toISOString();
    const tag = `[${ts}] [Server] [${level}]`;
    if (meta) console.log(`${tag} ${message}`, meta);
    else console.log(`${tag} ${message}`);
}

function formatSiteResult(offer) {
    if (!offer) {
        return { exists: false, cachedPrice: null, productUrl: null };
    }
    return {
        exists: Boolean(offer.exists),
        cachedPrice: offer.cachedPrice ?? null,
        productUrl: offer.productUrl ?? null,
        collectedAt: offer.collectedAt || null,
        fromCache: offer.fromCache ?? true
    };
}

function writeSSE(res, event, data) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function resolveCacheOutcome(data) {
    if (data.error) {
        return {
            outcome: 'skipped',
            onProductPage: false,
            hasPrice: false,
            reason: 'scrape_error'
        };
    }

    const onProductPage = Boolean(
        data.exists
        && data.productUrl
        && !data.productUrl.toLowerCase().includes('/search')
    );

    if (onProductPage && data.price > 0) {
        return { outcome: 'found', onProductPage, hasPrice: true };
    }

    if (onProductPage) {
        return { outcome: 'partial', onProductPage, hasPrice: false, reason: 'price_missing' };
    }

    if (data.exists === false) {
        return { outcome: 'not_found', onProductPage: false, hasPrice: false };
    }

    return { outcome: 'skipped', onProductPage: false, hasPrice: false, reason: 'ambiguous' };
}

async function processLiveCompare({ ean, targetSite, siteSettings, sourceProductName }) {
    const data = await requestLiveScrape({ targetSite, ean, siteSettings, sourceProductName });
    const resolved = resolveCacheOutcome(data);
    const { outcome, onProductPage, hasPrice } = resolved;

    if (outcome === 'skipped') {
        log('WARN', 'Cache write skipped — scrape inconclusive', {
            ean,
            targetSite,
            reason: resolved.reason,
            scraperError: data.error || null,
            exists: data.exists,
            price: data.price,
            productUrl: data.productUrl
        });
    } else {
        let priceDropAlerts = 0;
        let cacheOutcome = outcome;

        try {
            const cacheResult = await upsertOffer(pool, {
                ean,
                siteKey: targetSite,
                productUrl: data.productUrl,
                price: data.price,
                outcome,
                productName: sourceProductName
            });

            if (outcome === 'found') {
                const previousPrice = cacheResult.previousOffer?.price
                    ? Number(cacheResult.previousOffer.price)
                    : null;

                const priceDrop = await processPriceDropAlerts(pool, {
                    ean,
                    siteKey: targetSite,
                    newPrice: data.price,
                    productUrl: data.productUrl,
                    productName: sourceProductName,
                    previousPrice,
                    previousProductUrl: cacheResult.previousOffer?.product_url || null
                });
                priceDropAlerts = priceDrop.alertsCreated || 0;

                log('INFO', 'Price saved to cache', {
                    ean,
                    targetSite,
                    price: data.price,
                    alertsCreated: priceDropAlerts
                });
            } else if (outcome === 'partial') {
                log('INFO', 'Partial cache stored (URL without price)', { ean, targetSite });
            } else if (outcome === 'not_found') {
                log('INFO', 'Negative cache stored', { ean, targetSite });
            }
        } catch (cacheErr) {
            cacheOutcome = 'cache_error';
            log('ERROR', 'Cache write failed — returning live scrape result anyway', {
                ean,
                targetSite,
                error: cacheErr.message,
                code: cacheErr.code
            });
        }

        return {
            site: targetSite,
            exists: onProductPage,
            price: hasPrice ? data.price : null,
            productUrl: onProductPage ? data.productUrl : null,
            collectedAt: new Date().toISOString(),
            fromCache: false,
            priceDropAlerts,
            cacheOutcome
        };
    }

    if (data.error) {
        const err = new Error(data.error);
        err.code = data.code || 'SCRAPE_ERROR';
        throw err;
    }

    return {
        site: targetSite,
        exists: onProductPage,
        price: hasPrice ? data.price : null,
        productUrl: onProductPage ? data.productUrl : null,
        collectedAt: new Date().toISOString(),
        fromCache: false,
        priceDropAlerts: 0,
        cacheOutcome: 'skipped'
    };
}

// Cache check — returns fresh hits + list of sites needing live scrape
app.post('/api/check-availability', async (req, res) => {
    const { ean, compareWith = COMPARE_TARGET_SITES } = req.body;

    if (!ean) {
        return res.status(400).json({ error: 'ean is required' });
    }

    log('INFO', 'Cache check started', { ean, sites: compareWith });

    try {
        const { fresh, staleOrMissing } = await getCachedOffers(pool, ean, compareWith);

        const results = {};
        for (const site of compareWith) {
            results[site] = fresh[site]
                ? formatSiteResult(fresh[site])
                : { exists: false, cachedPrice: null, productUrl: null, needsLiveScrape: true };
        }

        log('INFO', 'Cache check complete', {
            ean,
            freshCount: Object.keys(fresh).length,
            staleOrMissing
        });

        // Backward-compatible: flat site map at top level + metadata
        res.json({
            ean,
            results,
            staleOrMissing,
            ...results
        });
    } catch (err) {
        log('ERROR', 'Cache check failed', { ean, error: err.message });
        res.status(500).json({ error: 'Cache check failed' });
    }
});

// Live scrape with write-through cache
app.post('/api/live-compare', async (req, res) => {
    const { ean, targetSite, siteSettings, sourceProductName } = req.body;

    if (!ean || !targetSite) {
        return res.status(400).json({ error: 'ean and targetSite are required' });
    }

    log('INFO', 'Live scrape requested', {
        ean,
        targetSite,
        sourceProductName: sourceProductName || null,
        scraper: SCRAPER_BASE
    });

    try {
        const result = await processLiveCompare({
            ean,
            targetSite,
            siteSettings,
            sourceProductName
        });

        log('INFO', 'Scraper response received', {
            ean,
            targetSite,
            exists: result.exists,
            price: result.price,
            productUrl: result.productUrl
        });

        res.json({
            exists: result.exists,
            price: result.price,
            productUrl: result.productUrl,
            collectedAt: result.collectedAt,
            priceDropAlerts: result.priceDropAlerts || 0
        });
    } catch (err) {
        const details = formatScraperError(err);
        log('ERROR', 'Live scrape failed', { ean, targetSite, ...details });
        res.status(503).json({
            exists: false,
            error: details.message,
            code: details.code,
            scraper: SCRAPER_BASE
        });
    }
});

// SSE stream — cache hits first, then parallel live scrapes as each completes
app.post('/api/compare-stream', async (req, res) => {
    const {
        ean,
        compareWith = COMPARE_TARGET_SITES,
        sourceProductName,
        sitesSettings = {}
    } = req.body;

    if (!ean) {
        return res.status(400).json({ error: 'ean is required' });
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
    }

    const send = (event, data) => {
        if (res.writableEnded) return;
        writeSSE(res, event, data);
    };

    log('INFO', 'Compare stream started', { ean, sites: compareWith });

    try {
        const { fresh, staleOrMissing } = await getCachedOffers(pool, ean, compareWith);

        for (const site of compareWith) {
            if (fresh[site]) {
                send('result', {
                    site,
                    ...formatSiteResult(fresh[site]),
                    fromCache: true
                });
            }
        }

        send('progress', {
            ean,
            cached: Object.keys(fresh).length,
            pending: staleOrMissing.length
        });

        if (staleOrMissing.length === 0) {
            send('done', { ean, total: compareWith.length });
            res.end();
            return;
        }

        await Promise.all(staleOrMissing.map(async (targetSite) => {
            const siteSettings = sitesSettings[targetSite];
            if (!siteSettings?.searchUrlPattern) {
                send('error', {
                    site: targetSite,
                    exists: false,
                    error: 'Missing siteSettings for site',
                    code: 'BAD_REQUEST'
                });
                return;
            }

            try {
                const result = await processLiveCompare({
                    ean,
                    targetSite,
                    siteSettings,
                    sourceProductName
                });
                send('result', result);
            } catch (err) {
                const details = formatScraperError(err);
                log('ERROR', 'Stream scrape failed', { ean, targetSite, ...details });
                send('error', {
                    site: targetSite,
                    exists: false,
                    error: details.message,
                    code: details.code
                });
            }
        }));

        send('done', { ean, total: compareWith.length });
        res.end();
    } catch (err) {
        log('ERROR', 'Compare stream failed', { ean, error: err.message });
        send('error', { error: err.message, code: 'STREAM_ERROR' });
        res.end();
    }
});

// Active / passive tracking
app.post('/api/track', async (req, res) => {
    try {
        const result = await trackProduct(pool, req.body);

        if (!result.accepted) {
            return res.status(202).json(result);
        }

        log('INFO', 'Product tracked', {
            ean: req.body.ean,
            source_site: req.body.source_site,
            tracking_type: req.body.tracking_type
        });

        res.json({ ok: true, ...result });
    } catch (err) {
        log('ERROR', 'Track failed', { error: err.message });
        res.status(err.status || 500).json({ error: err.message });
    }
});

// List tracked items for an installation
app.get('/api/track/:installationId', async (req, res) => {
    try {
        const items = await getUserTracker(pool, req.params.installationId);
        res.json({ items });
    } catch (err) {
        log('ERROR', 'Get tracker failed', { error: err.message });
        res.status(500).json({ error: 'Failed to load tracker' });
    }
});

// Opt out of active tracking (soft-delete — stops price-drop alerts)
app.put('/api/track/opt-out', async (req, res) => {
    try {
        const result = await optOutTracking(pool, req.body);

        if (!result.optedOut) {
            return res.status(404).json(result);
        }

        log('INFO', 'User opted out of tracking', {
            ean: req.body.ean,
            source_site: req.body.source_site || 'all',
            count: result.count
        });

        res.json({ ok: true, ...result });
    } catch (err) {
        log('ERROR', 'Opt-out failed', { error: err.message });
        res.status(err.status || 500).json({ error: err.message });
    }
});

// Unread price-drop alerts for an installation
app.get('/api/alerts/:installationId', async (req, res) => {
    try {
        const alerts = await getUnreadAlerts(pool, req.params.installationId);
        res.json({ alerts });
    } catch (err) {
        log('ERROR', 'Get alerts failed', { error: err.message });
        res.status(500).json({ error: 'Failed to load alerts' });
    }
});

// Check if a specific product is already tracked
app.get('/api/track/:installationId/:ean/:sourceSite', async (req, res) => {
    try {
        const row = await isTracked(
            pool,
            req.params.installationId,
            req.params.ean,
            req.params.sourceSite
        );
        res.json({ tracked: Boolean(row), ...row });
    } catch (err) {
        log('ERROR', 'Track status check failed', { error: err.message });
        res.status(500).json({ error: 'Failed to check track status' });
    }
});

// Health check (DB + scraper)
app.get('/api/health', async (_req, res) => {
    let dbOk = false;
    let dbError = null;

    try {
        await pool.query('SELECT 1');
        dbOk = true;
    } catch (err) {
        dbError = err.message;
    }

    const scraper = await checkScraperHealth();

    const ok = dbOk && scraper.ok;
    res.status(ok ? 200 : 503).json({
        ok,
        db: dbOk ? 'connected' : dbError,
        scraper
    });
});

app.listen(port, () => {
    console.log(`🚀 Server Running: http://localhost:${port}`);
    console.log('Ready to accept requests from Extension...');
});
