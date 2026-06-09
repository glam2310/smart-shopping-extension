// popup.js

document.addEventListener('DOMContentLoaded', async () => {
    const container = document.getElementById('dynamicButtonsContainer');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.id) {
        container.innerText = 'לא ניתן לגשת לטאב';
        return;
    }

    let currentHostname = '';
    try {
        currentHostname = new URL(tab.url).hostname;
    } catch (_) {
        container.innerText = 'כתובת לא תקינה';
        return;
    }

    const siteConfig = typeof getSiteConfig === 'function'
        ? getSiteConfig(currentHostname)
        : SITES_CONFIG[currentHostname];

    chrome.tabs.sendMessage(tab.id, { action: 'GET_PRODUCT_DATA' }, async (response) => {
        if (chrome.runtime.lastError || !response) {
            container.innerText = 'לא ניתן לקרוא נתונים מהדף';
            return;
        }

        if (!response.ean || response.ean === 'unknown_sku') {
            const noEanMsg = siteConfig?.noEanMessage || 'לא נמצא ברקוד במוצר';
            container.innerText = noEanMsg;
            updateProductInfo(response, currentHostname);
            return;
        }

        updateProductInfo(response, currentHostname);

        const currentKeys = new Set([
            currentHostname,
            currentHostname.replace(/^www\./, ''),
            currentHostname.startsWith('www.') ? currentHostname : `www.${currentHostname}`
        ]);

        const targetSites = Object.keys(SITES_CONFIG).filter(site => {
            const cfg = SITES_CONFIG[site];
            return !currentKeys.has(site) && cfg.siteType === 'retail';
        });

        if (targetSites.length === 0) {
            container.innerText = 'אין אתרים נוספים להשוואה';
            return;
        }

        container.innerHTML = '<div class="loading-text">בודק זמינות באתרים אחרים...</div>';
        await buildComparisonButtons(response.ean, targetSites, container);
    });
});

function updateProductInfo(data, hostname) {
    const set = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val || '-';
    };
    set('productName', data.productName);
    set('brandName', data.brand);
    set('skuValue', data.ean);
    set('debugHostname', hostname);
    set('debugBrand', data.brand);
    set('debugProduct', data.productName);
    set('debugSku', data.ean);
}

function createPriceButton(site, price, productUrl) {
    const btn = document.createElement('button');
    btn.className = 'btn-primary';
    btn.innerText = `${SITES_CONFIG[site].displayName}: ₪${price}`;
    btn.addEventListener('click', () => {
        chrome.tabs.create({ url: productUrl });
    });
    return btn;
}

function createFallbackButton(site, productUrl) {
    const btn = document.createElement('button');
    btn.className = 'btn-outline';
    btn.innerText = `צפה ב-${SITES_CONFIG[site].displayName}`;
    btn.addEventListener('click', () => {
        chrome.tabs.create({ url: productUrl });
    });
    return btn;
}

async function resolveSiteAvailability(ean, site, cached) {
    try {
        const live = await fetch('http://localhost:3000/api/live-compare', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ean,
                targetSite: site,
                siteSettings: SITES_CONFIG[site]
            })
        }).then(r => r.json());

        if (live.exists && live.productUrl && !live.productUrl.toLowerCase().includes('/search')) {
            if (live.price > 0) {
                return { site, price: live.price, productUrl: live.productUrl };
            }
            return { site, price: null, productUrl: live.productUrl };
        }
    } catch (_) {
        // שרת לא זמין — ננסה cache
    }

    if (cached?.exists && cached.productUrl && !cached.productUrl.toLowerCase().includes('/search')) {
        if (cached.cachedPrice > 0) {
            return { site, price: cached.cachedPrice, productUrl: cached.productUrl };
        }
        return { site, price: null, productUrl: cached.productUrl };
    }

    return null;
}

async function buildComparisonButtons(ean, targetSites, container) {
    let availability = {};

    try {
        const res = await fetch('http://localhost:3000/api/check-availability', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ean, compareWith: targetSites })
        });
        availability = await res.json();
    } catch (_) {
        // ממשיכים בלי cache
    }

    const results = await Promise.all(
        targetSites.map(site => resolveSiteAvailability(ean, site, availability[site]))
    );

    const found = results.filter(Boolean);
    const withPrice = found.filter(r => r.price > 0);
    const withoutPrice = found.filter(r => !r.price || r.price <= 0);

    container.innerHTML = '';

    if (withPrice.length === 0 && withoutPrice.length === 0) {
        container.innerHTML = '<div class="info-text">לא נמצא במותגים אחרים</div>';
        return;
    }

    withPrice
        .sort((a, b) => a.price - b.price)
        .forEach(({ site, price, productUrl }) => {
            container.appendChild(createPriceButton(site, price, productUrl));
        });

    withoutPrice.forEach(({ site, productUrl }) => {
        container.appendChild(createFallbackButton(site, productUrl));
    });
}
