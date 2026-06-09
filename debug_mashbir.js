const puppeteer = require('puppeteer-core');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EAN = '3614274000597';

(async () => {
    const browser = await puppeteer.launch({
        executablePath: CHROME_PATH,
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    const searchUrl = `https://365mashbir.co.il/search?q=${EAN}`;
    console.log('--- SEARCH:', searchUrl);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await new Promise(r => setTimeout(r, 3500));

    const links = await page.evaluate(() => {
        return [...document.querySelectorAll("a[href*='/products/']")].map(a => a.href);
    });
    const uniqueLinks = [...new Set(links)];
    console.log('product links count:', uniqueLinks.length);
    console.log(uniqueLinks.slice(0, 12).join('\n'));

    const searchHtml = await page.content();
    console.log('EAN in search HTML?', searchHtml.includes(EAN));
    const barcodeMatch = searchHtml.match(/"barcode"\s*:\s*"([\d]{8,14})"/gi);
    console.log('barcode JSON occurrences in search HTML:', barcodeMatch ? barcodeMatch.slice(0, 5) : null);

    // Visit first product link and inspect
    if (uniqueLinks.length) {
        const target = uniqueLinks[0];
        console.log('\n--- VISIT FIRST PRODUCT:', target);
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await new Promise(r => setTimeout(r, 3500));
        const html = await page.content();
        console.log('EAN in product HTML?', html.includes(EAN));
        const bm = html.match(/"barcode"\s*:\s*"([\d]{8,14})"/gi);
        console.log('barcode JSON in product HTML:', bm ? bm.slice(0, 5) : null);

        // Try Shopify product.json
        const handle = target.split('/products/')[1].split('?')[0];
        const jsonUrl = `https://365mashbir.co.il/products/${handle}.json`;
        console.log('\n--- SHOPIFY JSON:', jsonUrl);
        try {
            const resp = await page.goto(jsonUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            const txt = await resp.text();
            const data = JSON.parse(txt);
            const variants = data?.product?.variants || [];
            console.log('variants:', variants.map(v => ({ barcode: v.barcode, price: v.price, sku: v.sku })));
        } catch (e) {
            console.log('json error:', e.message);
        }
    }

    // Test Shopify search products.json for EAN matching
    console.log('\n--- SEARCH products.json approach');
    try {
        const sUrl = `https://365mashbir.co.il/search/suggest.json?q=${EAN}&resources[type]=product&resources[limit]=10`;
        const resp = await page.goto(sUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const txt = await resp.text();
        console.log('suggest.json length:', txt.length, 'EAN present?', txt.includes(EAN));
        const data = JSON.parse(txt);
        const prods = data?.resources?.results?.products || [];
        console.log('suggest products:', prods.map(p => ({ title: p.title, url: p.url })));
    } catch (e) {
        console.log('suggest error:', e.message);
    }

    await browser.close();
})();
