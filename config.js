// config.js
const SITES_CONFIG = {
"www.adidas.co.il": {
        "name": "Adidas",
        "compareWith": ["www.terminalx.com"],
        "isOfficialBrandSite": true,
        "supportsEanSearch": false,
        "skuExtraction": {
            "type": "url",
            "regex": /\/([A-Z0-9]{5,6})\.html/i
        },
        // תבנית החיפוש הרשמית והיציבה - אדידס כבר יקח אותנו לעמוד המוצר המושלם!
        "searchUrlPattern": "https://{{domain}}/he/search?q={{query}}", 
        "selectors": {
            "brand": "Adidas", 
            "productName": "h1[class*='product-name'], h1.product-name, [data-string-id='pdp.productName'], h1",
            "productPageIndicator": "button[data-bluecore-id='addToBag-button'], .product-id_2O8x, h1[class*='product-name']",
            "firstResultAnchor": "div[class*='product-card'] a, .glass-product-card__assets a, .product-card_1X8y a",
            "priceSelectors": ['.gl-price-item--sale', '.gl-price-item', '[data-string-id="pdp.price"]', '.price-wrapper span']
        }
    },
    
    "www.terminalx.com": {
        "name": "Terminal X",
        "compareWith": ["www.adidas.co.il", "shop.super-pharm.co.il"],
        "isOfficialBrandSite": false,
        "supportsEanSearch": false,
        "skuExtraction": {
            "type": "script",
            "regex": /"supplier_style"\s*:\s*"([^"]+)"/
        },
        "searchUrlPattern": "https://{{domain}}/catalogsearch/result?q={{query}}",
        "selectors": {
            "brand": "[data-testid='product-brand']", 
            "productName": "h1",
            "productPageIndicator": ".product-info-main",
            "firstResultAnchor": ".product-item-info a",
            "priceSelectors": ['.final-price_8CiX', '.price-final_price .price']
        }
    },

    "shop.super-pharm.co.il": {
        "name": "Super-Pharm",
        "compareWith": ["www.terminalx.com"],
        "isOfficialBrandSite": false,
        "supportsEanSearch": true,
        "skuExtraction": {
            "type": "url",
            "regex": /\/p\/(\d+)/ // מחלץ את רצף הספרות שאחרי /p/
        },
        "selectors": {
            "brand": ".product-brand", // סלקטור למותג בסופר-פארם
            "productName": "h1.product-name" // סלקטור לשם המוצר
        }
    }
};