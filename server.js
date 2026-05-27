const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
const crypto = require('crypto');
const { Pool } = require('pg');
const puppeteer = require('puppeteer-core');

const app = express();
const port = 3000;

// --- חיבור למסד נתונים ---
const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'smart_shopping_db',
  password: 'morgreenberg',
  port: 5432,
});

// --- אתחול מסודר של הטבלה והאינדקס בדאטהבייס (פותר את שגיאות ה-Relation) ---
const initDatabase = async () => {
  try {
    // 1. יצירת הטבלה אם אינה קיימת
    await pool.query(`
      CREATE TABLE IF NOT EXISTS product_mappings (
          id SERIAL PRIMARY KEY,
          source_sku VARCHAR(255) NOT NULL,
          target_site VARCHAR(255) NOT NULL,
          target_sku VARCHAR(255),
          target_url TEXT,
          cached_price NUMERIC,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    // 2. יצירת אינדקס ייחודי בנפרד כדי למנוע קריסות סינטקס
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_src_target ON product_mappings(source_sku, target_site);
    `);
    
    console.log('🚀 DB Connected & Setup Successfully (product_mappings table verified)');
  } catch (err) {
    console.error('❌ DB Setup/Connection Error:', err.message);
  }
};

// הפעלת אתחול הדאטהבייס מיד עם עילת השרת
initDatabase();

// --- Middlewares ---
app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Private-Network", "true");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

// --- Routes: General ---
app.get('/', (req, res) => {
  res.send("Price Matcher & Smart Shopping Server is LIVE");
});

// --- פונקציית Scraping הישנה (מושארת לגיבוי זמני בפורט 3000) ---
async function scrapeTerminalXPrice(url) {
    let browser;
    try {
        browser = await puppeteer.launch({
            executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        
        const page = await browser.newPage();
        
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'font'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        console.log(`[Puppeteer] Navigating to: ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        const priceSelectors = [
            '.final-price_8CiX',
            '[data-testid="project-price"]',
            '.price_2W9j',
            '.row_2Ysc span'
        ];

        await new Promise(r => setTimeout(r, 2000));

        const price = await page.evaluate((selectors) => {
            for (const selector of selectors) {
                const el = document.querySelector(selector);
                if (el && el.innerText.trim().length > 0) {
                    return el.innerText.replace(/[^\d.]/g, '');
                }
            }
            return null;
        }, priceSelectors);

        await browser.close();
        return price;
    } catch (error) {
        console.error("[Puppeteer] Error:", error.message);
        if (browser) await browser.close();
        return null;
    }
}

// --- Route: הראוט הישן לחיפוש ישיר לפי SKU ---
app.post('/url_maker', async (req, res) => {
  const { sku } = req.body;

  console.log(`\n--- [${new Date().toLocaleTimeString()}] REQUEST RECEIVED ---`);
  console.log(`Searching for SKU: ${sku}`);

  if (!sku || sku === "null" || sku === "Searching..." || sku === "SKU Not Found") {
    return res.status(400).json({ error: "Invalid SKU provided" });
  }

  const terminalUrl = `https://www.terminalx.com/catalogsearch/result?q=${sku}`;

  try {
    const price = await scrapeTerminalXPrice(terminalUrl);
    console.log(`Result for ${sku}: ${price ? '₪' + price : 'Not Found'}`);

    res.json({
      success: true,
      sku: sku,
      terminalUrl: terminalUrl,
      price: price
    });
  } catch (error) {
    console.error(`Error processing ${sku}:`, error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- Routes: Database Operations ---

app.post('/products/find-or-create', async (req, res) => {
  const { brand, product_name, source_url } = req.body;
  try {
    let brandResult = await pool.query(`SELECT id FROM brands WHERE name = $1`, [brand]);
    let brandId;

    if (brandResult.rows.length === 0) {
      const insertBrand = await pool.query(
        `INSERT INTO brands (name, official_url) VALUES ($1, '') RETURNING id`, [brand]
      );
      brandId = insertBrand.rows[0].id;
    } else {
      brandId = brandResult.rows[0].id;
    }

    let productResult = await pool.query(
      `SELECT id FROM products WHERE name = $1 AND brand_id = $2`, [product_name, brandId]
    );

    if (productResult.rows.length > 0) {
      return res.json({ product_id: productResult.rows[0].id });
    }

    const newProductId = crypto.randomUUID();
    const newProduct = await pool.query(
      `INSERT INTO products (id, name, brand_id, source_url) VALUES ($1, $2, $3, $4) RETURNING id`,
      [newProductId, product_name, brandId, source_url]
    );

    res.json({ product_id: newProduct.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error finding/creating product');
  }
});

app.post('/products/:id/purchase', async (req, res) => {
  const productId = req.params.id;
  try {
    await pool.query(`UPDATE products SET purchased = TRUE, purchased_at = CURRENT_TIMESTAMP WHERE id = $1`, [productId]);
    await pool.query(`UPDATE stock_alerts SET is_active = FALSE WHERE product_id = $1`, [productId]);
    res.json({ ok: true, message: 'Product marked as purchased' });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Error marking product as purchased' });
  }
});

app.post('/event', async (req, res) => {
  const { user_id, product_id, event_type, duration_seconds, session_id } = req.body;
  try {
    if (duration_seconds < 10) return res.status(200).send('Ignored (too short)');

    await pool.query(`INSERT INTO users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`, [user_id]);
    await pool.query(
      `INSERT INTO user_events (user_id, product_id, event_type, duration_seconds, session_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (session_id) DO UPDATE SET duration_seconds = EXCLUDED.duration_seconds`,
      [user_id, product_id, event_type, duration_seconds, session_id]
    );
    res.send('Event saved');
  } catch (err) {
    res.status(500).send('Error saving event');
  }
});

app.get('/recommendations/:userId', async (req, res) => {
  const userId = req.params.userId;
  try {
    const result = await pool.query(`
      SELECT b.name AS brand, SUM(ew.weight) AS score
      FROM user_events ue
      JOIN products p ON ue.product_id = p.id
      JOIN brands b ON p.brand_id = b.id
      JOIN event_weights ew ON ue.event_type = ew.event_type
      WHERE ue.user_id = $1 AND ue.duration_seconds >= 10
      GROUP BY b.name ORDER BY score DESC LIMIT 3`, [userId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).send('Error getting recommendations');
  }
});

// --- Stock Alerts ---

app.post('/stock-alerts', async (req, res) => {
  const { user_id, product_id } = req.body;
  try {
    await pool.query(
      `INSERT INTO stock_alerts (user_id, product_id) VALUES ($1, $2)
       ON CONFLICT (user_id, product_id) DO UPDATE SET is_active = TRUE, requested_at = CURRENT_TIMESTAMP`,
      [user_id, product_id]
    );
    res.json({ ok: true, message: 'Stock alert saved' });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Error saving stock alert' });
  }
});

app.get('/stock-alerts/:userId/available', async (req, res) => {
  const userId = req.params.userId;
  try {
    const result = await pool.query(`
      SELECT sa.id AS alert_id, p.id AS product_id, p.name AS product_name, b.name AS brand, p.source_url
      FROM stock_alerts sa
      JOIN products p ON sa.product_id = p.id
      JOIN brands b ON p.brand_id = b.id
      WHERE sa.user_id = $1 Sa.is_active = TRUE AND p.in_stock = TRUE AND sa.notified_at IS NULL`, [userId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error checking stock alerts' });
  }
});

// --- הארכיטקטורה החדשה: ניהול זמינות ומיפויים מול ה-Scraper Service ---

// 1. Endpoint של הבדיקה המקדימה (הוולידציה) שה-Popup קורא לה
app.post('/api/check-availability', async (req, res) => {
    try {
        const { sku, brand, productName, compareWith } = req.body;
        const responseData = {};

        if (!compareWith || !Array.isArray(compareWith)) {
            return res.json({});
        }

        for (let targetSite of compareWith) {
            if (!sku || sku === "null" || sku === "unknown_sku" || sku === "Searching...") {
                responseData[targetSite] = {
                    exists: true, 
                    cachedPrice: null,
                    productUrl: null
                };
                continue;
            }

            try {
                const cachedResult = await pool.query(
                    'SELECT * FROM product_mappings WHERE source_sku = $1 AND target_site = $2',
                    [sku, targetSite]
                );

                if (cachedResult && cachedResult.rows && cachedResult.rows.length > 0) {
                    const row = cachedResult.rows[0];
                    responseData[targetSite] = {
                        exists: true,
                        cachedPrice: row.cached_price,
                        productUrl: row.target_url
                    };
                } else {
                    responseData[targetSite] = {
                        exists: true, 
                        cachedPrice: null,
                        productUrl: null
                    };
                }
            } catch (dbErr) {
                console.error(`[DB Error] Failed fetching cache for SKU ${sku}:`, dbErr.message);
                responseData[targetSite] = {
                    exists: true,
                    cachedPrice: null,
                    productUrl: null
                };
            }
        }

        res.json(responseData);

    } catch (globalErr) {
        console.error("Global error in check-availability:", globalErr.message);
        res.json({});
    }
});

// 2. Endpoint לביצוע הגירוד בזמן אמת - גרסה גנרית מבוססת מידע מהתוסף + פולבק חיפוש מסונן
app.post('/api/live-compare', async (req, res) => {
    const { 
        sku, 
        skuType, 
        brand, 
        productName, 
        targetSite, 
        sourceIsOfficialBrand, // הדגל המבני המציין את אמינות מקור המק"ט
        targetSelectors, 
        targetProductPattern, 
        targetSearchPattern 
    } = req.body;

    let searchQuery;

    try {
        // בדיקה האם קיים מזהה מק"ט כלשהו בבקשה
        const hasValidSku = sku && sku !== "unknown_sku" && sku !== "null" && sku.trim() !== "";

        if (hasValidSku) {
            // מק"ט URL נחשב חלש/פנימי אך ורק אם מקורו אינו מאתר מותג רשמי (כמו מק"ט מקומי של חנות כללית)
            const isWeakInternalSku = skuType === "url" && sourceIsOfficialBrand === false;

            if (isWeakInternalSku) {
                // מעבר לפולבק מילולי עבור מק"טים פנימיים שאינם רלוונטיים באתרי יעד
                searchQuery = `${brand} ${productName}`.trim();
                console.log(`[Main Server] Low-fidelity internal store SKU detected. Switching to text query fallback: "${searchQuery}"`);
            } else {
                // שימוש במק"ט יצרן רשמי (נשלף מ-script, או מ-url של חנות מותג כמו אדידס) עבור חיפוש מדויק ב-Scale
                searchQuery = sku.trim();
                console.log(`[Main Server] High-fidelity manufacturer SKU verified. Querying [${targetSite}] with exact SKU: "${searchQuery}"`);
            }
        } else {
            // פולבק מוחלט במצב של היעדר מזהה לחלוטין
            searchQuery = `${brand} ${productName}`.trim();
            console.log(`[Main Server] Missing identifier. Falling back to text query: "${searchQuery}"`);
        }

        // בניית הסטטינגס בצורה דינמית לחלוטין בלי תלות ב-SITES_CONFIG מקומי!
        const siteSettings = {
            searchUrlPattern: skuType === "script" && targetProductPattern
                ? targetProductPattern 
                : (targetSearchPattern || "https://{{domain}}/search?q={{query}}"),
            renderDelay: 2500, // תוספת חצי שנייה להבטחת רינדור מלא באתרי מותגים כבדים
            selectors: targetSelectors || {}
        };

        console.log(`[Main Server] Calling Scraper Service for target [${targetSite}] with query: "${searchQuery}"`);

        // פנייה פנימית למיקרו-סרביס הגירוד (פורט 3001)
        const scraperResponse = await axios.post('http://localhost:3001/scrape', {
            targetSite,
            searchQuery,
            siteSettings
        });

        let scrapeData = scraperResponse.data;

        // --- עדכון פתרון ביניים חכם וגנרי לסקייל ---
        // אם הסקרפר החזיר תשובה ריקה, מוצר לא קיים, או כשל בחילוץ המחיר (למשל עקב חסימה):
        if (!scrapeData || !scrapeData.exists || !scrapeData.price) {
            const urlPattern = siteSettings.searchUrlPattern || "https://{{domain}}/search?q={{query}}";
            const generatedSearchUrl = urlPattern
                .replace('{{domain}}', targetSite)
                .replace('{{query}}', encodeURIComponent(searchQuery));

            scrapeData = {
                exists: true,             // מסמנים כ-true כדי שהפופאפ יתרנדר וייצר כפתור לחיץ
                price: null,              // אין מחיר זמין
                productUrl: generatedSearchUrl,
                isSearchLinkOnly: true    // דגל מיוחד ל-UI שמציין קישור לעמוד חיפוש מסונן
            };
            console.log(`[Main Server] Scraper didn't extract a valid price. Providing structured search fallback URL: ${generatedSearchUrl}`);
        }

        // שמירה בארכיון ה-Cache (אך ורק אם קיבלנו מחיר אמיתי מהסקרפר כדי לא ללכלך את ה-Cache)
        if (scrapeData.price && sku && sku !== "unknown_sku" && sku !== "null") {
            try {
                await pool.query(
                    `INSERT INTO product_mappings (source_sku, target_site, target_sku, target_url, cached_price, updated_at)
                     VALUES ($1, $2, $3, $4, $5, NOW())
                     ON CONFLICT (source_sku, target_site) 
                     DO UPDATE SET cached_price = $5, target_url = $4, updated_at = NOW()`,
                    [sku, targetSite, scrapeData.targetSku || sku, scrapeData.productUrl, scrapeData.price]
                );
                console.log(`[Cache] Successfully updated database mapping for SKU: ${sku}`);
            } catch (dbErr) {
                console.error(`[Cache Error] Failed to save mapping in DB:`, dbErr.message);
            }
        }

        res.json(scrapeData);

    } catch (err) {
        console.error("Error communicating with scraper service, generating emergency fallback:", err.message);
        
        // פולבק חירום מוחלט: אם ה-Scraper Service קרס לגמרי או לא זמין, עדיין נבנה למשתמש לינק ישיר לחיפוש
        const urlPattern = targetSearchPattern || "https://{{domain}}/search?q={{query}}";
        const emergencyUrl = urlPattern
            .replace('{{domain}}', targetSite)
            .replace('{{query}}', encodeURIComponent(searchQuery || `${brand} ${productName}`));

        res.json({
            exists: true,
            price: null,
            productUrl: emergencyUrl,
            isSearchLinkOnly: true
        });
    }
});

// --- Start Server ---
app.listen(port, () => {
  console.log(`🚀 Server Running: http://localhost:${port}`);
});