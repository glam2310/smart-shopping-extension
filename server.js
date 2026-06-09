// server.js

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();
const port = 3000;

// הגדרת חיבור ל-PostgreSQL
const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'smart_shopping_db',
  password: 'morgreenberg',
  port: 5432,
});

app.use(cors());
app.use(express.json());

function log(level, message, meta = null) {
    const ts = new Date().toISOString();
    const tag = `[${ts}] [Server] [${level}]`;
    if (meta) console.log(`${tag} ${message}`, meta);
    else console.log(`${tag} ${message}`);
}

// נתיב לבדיקה מהירה ב-DB (Cache)
app.post('/api/check-availability', async (req, res) => {
    const { ean, compareWith } = req.body;
    log('INFO', 'Cache check started', { ean, sites: compareWith });
    
    const responseData = {};

    for (let targetSite of compareWith) {
        try {
            const result = await pool.query(
                'SELECT cached_price, target_url FROM ean_mappings WHERE ean = $1 AND target_site = $2',
                [ean, targetSite]
            );

            if (result.rows.length > 0) {
                const cachedPrice = Number(result.rows[0].cached_price);
                const productUrl = result.rows[0].target_url || '';
                const validCache = cachedPrice > 0
                    && cachedPrice < 10000
                    && productUrl
                    && !productUrl.toLowerCase().includes('/search');

                if (validCache) {
                    responseData[targetSite] = {
                        exists: true,
                        cachedPrice,
                        productUrl
                    };
                } else {
                    responseData[targetSite] = { exists: false, cachedPrice: null, productUrl: null };
                }
            } else {
                // המוצר לא נמצא ב-DB, נחזיר exists: false כדי שהפופאפ ידע להפעיל סקראפר
                responseData[targetSite] = { exists: false, cachedPrice: null, productUrl: null };
            }
        } catch (err) {
            log('ERROR', 'DB cache check failed', { ean, targetSite, error: err.message });
            responseData[targetSite] = { exists: false, cachedPrice: null, productUrl: null };
        }
    }
    
    log('INFO', 'Cache check complete', { ean, results: responseData });
    res.json(responseData);
});

// נתיב לביצוע סריקה בלייב (Scraping)
app.post('/api/live-compare', async (req, res) => {
    const { ean, targetSite, siteSettings } = req.body;
    
    log('INFO', 'Live scrape requested', { ean, targetSite });

    try {
        // קריאה לשירות הסקרפר שרץ בפורט 3001
        const scraperResponse = await axios.post('http://localhost:3001/scrape', {
            targetSite, 
            searchQuery: ean, 
            siteSettings 
        });

        log('INFO', 'Scraper response received', {
            ean,
            targetSite,
            exists: scraperResponse.data.exists,
            price: scraperResponse.data.price,
            productUrl: scraperResponse.data.productUrl
        });

        // אם מצאנו מוצר, נשמור אותו ב-DB לעתיד
        if (scraperResponse.data.exists && scraperResponse.data.price) {
            await pool.query(
                `INSERT INTO ean_mappings (ean, target_site, target_url, cached_price, updated_at)
                 VALUES ($1, $2, $3, $4, NOW())
                 ON CONFLICT (ean, target_site) 
                 DO UPDATE SET cached_price = EXCLUDED.cached_price, target_url = EXCLUDED.target_url, updated_at = NOW()`,
                [ean, targetSite, scraperResponse.data.productUrl, scraperResponse.data.price]
            );
            log('INFO', 'Price saved to cache', { ean, targetSite, price: scraperResponse.data.price });
        } else if (!scraperResponse.data.exists) {
            await pool.query(
                'DELETE FROM ean_mappings WHERE ean = $1 AND target_site = $2',
                [ean, targetSite]
            );
            log('INFO', 'Stale cache removed', { ean, targetSite });
        }

        res.json(scraperResponse.data);
    } catch (err) {
        log('ERROR', 'Live scrape failed', { ean, targetSite, error: err.message });
        res.status(500).json({ exists: false, error: "Scraping failed" });
    }
});

app.listen(port, () => {
    console.log(`🚀 Server Running: http://localhost:${port}`);
    console.log("Ready to accept requests from Extension...");
});