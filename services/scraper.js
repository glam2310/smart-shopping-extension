// services/scraper.js
const express = require('express');
const puppeteer = require('puppeteer-core');
const app = express();
app.use(express.json());

const PORT = process.env.SCRAPER_PORT || 3001;

// פונקציית סריקה אוניברסלית לחלוטין - מונעת קונפיגורציה בלבד
async function executeGenericScrape(targetSite, searchQuery, siteSettings) {
    let browser;
    try {
        browser = await puppeteer.launch({ 
            executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        
        const page = await browser.newPage();
        
        // אופטימיזציית מהירות אוניברסלית
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'font', 'stylesheet'].includes(req.resourceType()) && !siteSettings.requiresStyles) { 
                req.abort(); 
            } else { 
                req.continue(); 
            }
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // 1. בניית ה-URL בצורה דינמית לפי התבנית בקונפיגורציה
        // תומך גם בנתיב ישיר למוצר (לפי מק"ט) וגם בנתיב חיפוש גנרי
        const urlPattern = siteSettings.searchUrlPattern || "https://{{domain}}/search?q={{query}}";
        const targetUrl = urlPattern
            .replace('{{domain}}', targetSite)
            .replace('{{query}}', encodeURIComponent(searchQuery));

        console.log(`[Scraper Engine] Navigating to generated URL: ${targetUrl}`);
        
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
        await new Promise(r => setTimeout(r, siteSettings.renderDelay || 2000));

        let currentUrl = page.url();
        let price = null;

        // 2. בדיקה אילו סלקטורים להפעיל (האם נחתנו ישר בעמוד מוצר או בעמוד תוצאות)
        const selectors = siteSettings.selectors || {};
        const isProductPage = selectors.productPageIndicator ? await page.$(selectors.productPageIndicator) : true;

        if (isProductPage && !currentUrl.includes('/404')) {
            // שליפת מחיר מעמוד מוצר ישיר
            price = await page.evaluate((priceSelectors) => {
                for (let selector of priceSelectors) {
                    const el = document.querySelector(selector);
                    if (el && el.innerText.trim().length > 0) {
                        return parseFloat(el.innerText.replace(/[^\d.]/g, ''));
                    }
                }
                return null;
            }, selectors.priceSelectors || []);
        } 
        
        // 3. פולבק אוטומטי לעמוד תוצאות (אם מוגדר סלקטור למוצר ראשון ברשת)
        if (!price && selectors.firstResultAnchor) {
            console.log(`[Scraper Engine] Product page not hit directly. Trying listing-page extraction...`);
            const firstProduct = await page.$(selectors.firstResultAnchor);
            
            if (firstProduct) {
                currentUrl = await page.evaluate(el => el.href, firstProduct);
                await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await new Promise(r => setTimeout(r, siteSettings.renderDelay || 2000));
                
                price = await page.evaluate((priceSelectors) => {
                    for (let selector of priceSelectors) {
                        const el = document.querySelector(selector);
                        if (el && el.innerText.trim().length > 0) {
                            return parseFloat(el.innerText.replace(/[^\d.]/g, ''));
                        }
                    }
                    return null;
                }, selectors.priceSelectors || []);
            }
        }

        await browser.close();
        return { exists: !!price, price, productUrl: currentUrl, targetSku: searchQuery };

    } catch (err) {
        console.error(`[Scraper Engine] Scraping failed for ${targetSite}:`, err.message);
        if (browser) await browser.close();
        return { exists: false };
    }
}

// Endpoint יחיד, נקי ואוניברסלי
app.post('/scrape', async (req, res) => {
    const { targetSite, searchQuery, siteSettings } = req.body;

    console.log(`[Scraper] Request received for site: ${targetSite} | Query: "${searchQuery}"`);

    if (!siteSettings) {
        return res.status(400).json({ error: "Missing site structural settings for generic execution" });
    }

    const result = await executeGenericScrape(targetSite, searchQuery, siteSettings);
    return res.json(result);
});

app.listen(PORT, () => {
    console.log(`🚀 Architecture Ready: Generic Scraping Microservice running on port ${PORT}`);
});