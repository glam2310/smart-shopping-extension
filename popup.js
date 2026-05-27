// popup.js

document.addEventListener("DOMContentLoaded", async () => {
    const container = document.getElementById("dynamicButtonsContainer");

    // 1. שליפת הטאב הנוכחי כדי לדעת איפה המשתמש גולש
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) {
        container.innerHTML = "<div class='error-text'>Cannot access active tab.</div>";
        return;
    }

    const url = new URL(tab.url);
    const currentHostname = url.hostname;

    // שליפת רשימת אתרי היעד להשוואה מתוך קובץ הקונפיגורציה
    const siteConfig = SITES_CONFIG[currentHostname];
    const targetsToCompare = siteConfig ? siteConfig.compareWith : [];

    if (targetsToCompare.length === 0) {
        container.innerHTML = "<div class='info-text'>No comparison sites configured for this store.</div>";
        return;
    }

    console.log(`[Smart Shopping] Connected to hostname: ${currentHostname}`);

    // 2. בקשת חבילת המידע המלאה מה-Content Script של הדף
    chrome.tabs.sendMessage(tab.id, { action: "GET_PRODUCT_DATA" }, async (productPayload) => {
        
        // אם ה-Content script החזיר אובייקט ריק לחלוטין, רק אז בונים גיבוי בסיסי
        if (!productPayload || productPayload.error) {
            console.log("[Smart Shopping] Core connection failed, building browser fallback...");
            productPayload = {
                sku: "unknown_sku",
                brand: siteConfig.name || "Unknown",
                productName: document.title.split('|')[0].trim()
            };
        }

        const { sku, brand, productName } = productPayload;

        // עדכון הלייבלים הקיימים שלך בתחתית ובמרכז ה-Popup
        updatePopupUIStrings(currentHostname, brand, productName, sku);

        try {
            // 3. שליחת בקשת וולידציה לשרת המרכזי בפורט 3000
            const response = await fetch("http://localhost:3000/api/check-availability", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    sku: sku,
                    brand: brand,
                    productName: productName,
                    compareWith: targetsToCompare
                })
            });

            const availabilityResult = await response.json();
            
            // מנקים את הודעת הטעינה מהקונטיינר
            container.innerHTML = "";
            let generatedButtonsCount = 0;

            // 4. לולאה על אתרי היעד ורינדור כפתורים דינמי
            targetsToCompare.forEach(targetHostname => {
                const targetData = availabilityResult[targetHostname];
                
                if (!targetData || !targetData.exists) {
                    return; 
                }

                generatedButtonsCount++;
                const targetName = SITES_CONFIG[targetHostname]?.name || targetHostname;

                const btn = document.createElement("button");
                btn.className = "btn-primary"; 

                if (targetData.cachedPrice) {
                    btn.innerText = `View on ${targetName} - ₪${targetData.cachedPrice}`;
                } else {
                    btn.innerText = `Check Price on ${targetName}`;
                }

                // העברת ה-productPayload וה-skuType בצורה מפורשת ומאובטחת
                btn.addEventListener("click", () => {
                    const skuType = siteConfig.skuExtraction?.type || "unknown";
                    handleCompareClick(productPayload, skuType, targetHostname, targetData.productUrl, currentHostname);
                });

                container.appendChild(btn);
            });

            if (generatedButtonsCount === 0) {
                container.innerHTML = "<div class='info-text'>This product was not found on competitor sites.</div>";
            }

        } catch (error) {
            console.error("[Smart Shopping] Error checking availability:", error);
            container.innerHTML = "<div class='error-text'>Server error. Please try again later.</div>";
        }
    });
});

// פונקציית עזר שמחליפה את הסטרינגים הסטטיים וה-Loading במידע האמיתי על המסך
function updatePopupUIStrings(host, brand, product, sku) {
    console.log(`[UI Update] Host: ${host}, Brand: ${brand}, Product: ${product}, SKU: ${sku}`);
    
    const productNameEl = document.getElementById("productName");
    const brandNameEl = document.getElementById("brandName");
    const skuValueEl = document.getElementById("skuValue");

    if (productNameEl) productNameEl.textContent = product;
    if (brandNameEl) brandNameEl.textContent = brand;
    if (skuValueEl) skuValueEl.textContent = sku;

    const debugHostnameEl = document.getElementById("debugHostname");
    const debugBrandEl = document.getElementById("debugBrand");
    const debugProductEl = document.getElementById("debugProduct");
    const debugSkuEl = document.getElementById("debugSku");

    if (debugHostnameEl) debugHostnameEl.textContent = host;
    if (debugBrandEl) debugBrandEl.textContent = brand;
    if (debugProductEl) debugProductEl.textContent = product;
    if (debugSkuEl) debugSkuEl.textContent = sku;
}

// פונקציה שמטפלת בלחיצה על כפתור השוואה בזמן אמת - מעודכנת עם פתרון הביניים ודגל רמת אמינות המק"ט
async function handleCompareClick(productPayload, skuType, targetSite, directUrl, currentHostname) {
    if (directUrl) {
        chrome.tabs.create({ url: directUrl });
        return;
    }

    const container = document.getElementById("dynamicButtonsContainer");
    
    container.innerHTML = `
        <div class="loading-container" style="text-align: center; padding: 10px;">
            <div style="color: #007bff; font-weight: bold; margin-bottom: 5px;">Searching on ${SITES_CONFIG[targetSite]?.name || targetSite}...</div>
            <div style="font-size: 11px; color: #666;">Running Live Scraper Sync</div>
        </div>
    `;
    
    try {
        // שליפת קונפיגורציית החנות הנוכחית (ממנה הגענו) ואתר היעד מתוך הדפדפן
        const currentSiteConfig = SITES_CONFIG[currentHostname];
        const targetSiteConfig = SITES_CONFIG[targetSite];

        const response = await fetch("http://localhost:3000/api/live-compare", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                sku: productPayload.sku,
                skuType: skuType, 
                brand: productPayload.brand,
                productName: productPayload.productName,
                targetSite: targetSite,
                
                // הזרקת נתוני האמינות המבניים של אתר המקור לטובת חוק ה-Fallback בשרת
                sourceIsOfficialBrand: currentSiteConfig?.isOfficialBrandSite || false,

                // הזרקת המידע המבני של היעד ישירות לתוך ה-request
                targetSelectors: targetSiteConfig?.selectors || {},
                targetProductPattern: targetSiteConfig?.productUrlPattern || "",
                targetSearchPattern: targetSiteConfig?.searchUrlPattern || ""
            })
        });

        const scrapeResult = await response.json();

        if (scrapeResult && scrapeResult.exists) {
            const targetName = SITES_CONFIG[targetSite]?.name || targetSite;
            
            // בדיקה דינמית: האם חזר מחיר מהסקרפר או שהופעל פולבק החיפוש המסונן של השרת
            const buttonText = scrapeResult.price && !scrapeResult.isSearchLinkOnly
                ? `Open on ${targetName} - ₪${scrapeResult.price}`
                : `Search directly on ${targetName} 🔍`;

            container.innerHTML = `
                <div class="success-box" style="text-align: center; padding: 10px; background: #eef9f0; border-radius: 6px;">
                    <span style="color: #2e7d32; font-weight: bold; display: block; margin-bottom: 5px;">Link Generated!</span>
                    <button id="goToProductBtn" class="btn-primary" style="margin-top: 5px; width: 100%;">
                        ${buttonText}
                    </button>
                </div>
            `;

            document.getElementById("goToProductBtn").addEventListener("click", () => {
                chrome.tabs.create({ url: scrapeResult.productUrl });
            });

        } else {
            container.innerHTML = "<div class='info-text'>Product could not be found on competitor site.</div>";
        }

    } catch (error) {
        console.error("[Smart Shopping] Error during live compare:", error);
        container.innerHTML = "<div class='error-text'>Failed to scan competitor site.</div>";
    }
}