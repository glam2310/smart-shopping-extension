// content.js

// מאזין להודעות שמגיעות מה-Popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "GET_PRODUCT_DATA") {
        const hostname = window.location.hostname;
        
        // שליפת הקונפיגורציה של האתר הנוכחי מתוך האובייקט הגלובלי ב-config.js
        const config = SITES_CONFIG[hostname];
        
        if (!config) {
            console.log(`[Smart Shopping] Hostname ${hostname} is not supported in config.js`);
            sendResponse({ error: "Site not supported" });
            return true;
        }

        console.log(`[Smart Shopping] Extracting data for: ${config.name}...`);

        let sku = null;
        let brand = "not found";
        let productName = "not found";

        try {
            // --- 1. חילוץ המק"ט / ברקוד (SKU) מה-URL ---
            if (config.skuExtraction.type === "url") {
                const currentUrl = window.location.href;
                const match = currentUrl.match(config.skuExtraction.regex);
                if (match && match[1]) {
                    sku = match[1].toUpperCase();
                }
            } 
            else if (config.skuExtraction.type === "script") {
                const scripts = document.querySelectorAll('script');
                for (let script of scripts) {
                    const match = script.innerText.match(config.skuExtraction.regex);
                    if (match && match[1]) {
                        sku = match[1].toUpperCase();
                        break;
                    }
                }
            }

            // פולבק חכם בתוך ה-DOM ספציפית לאדידס/סופר-פארם אם ה-URL בעייתי
            if (!sku || sku === "unknown_sku") {
                console.log("[Smart Shopping] SKU not found in URL, scanning HTML elements...");
                const skuEl = document.querySelector('[data-sku], [meta-sku], .product-id_2O8x');
                if (skuEl) {
                    sku = (skuEl.getAttribute('data-sku') || skuEl.innerText).trim().toUpperCase();
                } else {
                    // ניסיון שליפה מתוך ה-Metadata של הדף
                    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
                    for (let script of scripts) {
                        const skuMatch = script.innerText.match(/"sku"\s*:\s*"([^"]+)"/);
                        if (skuMatch) {
                            sku = skuMatch[1].toUpperCase();
                            break;
                        }
                    }
                }
            }

            // אם כל החיפושים נכשלו, רק אז נגדיר כ-unknown_sku
            if (!sku) sku = "unknown_sku";

            // --- 2. חילוץ שם המותג (Brand) ---
            if (config.selectors.brand && 
                !config.selectors.brand.startsWith('.') && 
                !config.selectors.brand.startsWith('#') && 
                !config.selectors.brand.startsWith('[')) {
                brand = config.selectors.brand;
            } else {
                const brandEl = document.querySelector(config.selectors.brand);
                if (brandEl) {
                    brand = brandEl.innerText.trim();
                }
            }

            // --- 3. חילוץ שם המוצר (Product Name) ---
            const nameEl = document.querySelector(config.selectors.productName);
            if (nameEl) {
                productName = nameEl.innerText.trim();
            } else {
                productName = document.title.split('|')[0].trim();
            }

            // ניקוי שם המוצר
            productName = productName.replace(/[\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim();

        } catch (err) {
            console.error("[Smart Shopping] Error during DOM extraction:", err);
        }

        // החזרת חבילת המידע המלאה והנקייה אל ה-Popup
        const payload = { sku, brand, productName };
        console.log("[Smart Shopping] Sending payload to popup:", payload);
        
        sendResponse(payload);
    }
    return true; 
});