const axios = require('axios');

const SCRAPER_BASE = process.env.SCRAPER_BASE || 'http://localhost:3001';
const SCRAPER_URL = process.env.SCRAPER_URL || `${SCRAPER_BASE}/scrape`;
const SCRAPER_HEALTH_URL = process.env.SCRAPER_HEALTH_URL || `${SCRAPER_BASE}/health`;
const SCRAPER_TIMEOUT_MS = Number(process.env.SCRAPER_TIMEOUT_MS || 120000);

function formatScraperError(err) {
    if (!err) {
        return { message: 'Unknown scraper error', code: 'UNKNOWN' };
    }

    if (err.response) {
        const body = err.response.data;
        return {
            message: body?.error || body?.message || err.message || 'Scraper HTTP error',
            code: err.code || 'HTTP_ERROR',
            status: err.response.status,
            scraperError: body?.error || null,
            scraperCode: body?.code || null
        };
    }

    if (err.code === 'ECONNREFUSED') {
        return {
            message: 'Scraper service is not running. Start it with: node services/scraper.js',
            code: 'ECONNREFUSED',
            hint: SCRAPER_BASE
        };
    }

    if (err.code === 'ECONNRESET') {
        return {
            message: 'Scraper connection was reset — the scraper process likely crashed or is not running',
            code: 'ECONNRESET',
            hint: 'Check the scraper terminal for errors (Chrome path, port 3001, Puppeteer crash)'
        };
    }

    if (err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED') {
        return {
            message: `Scraper request timed out after ${SCRAPER_TIMEOUT_MS}ms`,
            code: err.code
        };
    }

    return {
        message: err.message || err.code || 'Scraper request failed',
        code: err.code || 'UNKNOWN',
        errno: err.errno,
        syscall: err.syscall
    };
}

async function checkScraperHealth() {
    try {
        const res = await axios.get(SCRAPER_HEALTH_URL, { timeout: 5000 });
        return { ok: true, ...res.data };
    } catch (err) {
        return { ok: false, ...formatScraperError(err) };
    }
}

async function requestLiveScrape({ targetSite, ean, siteSettings, sourceProductName }) {
    const response = await axios.post(
        SCRAPER_URL,
        { targetSite, searchQuery: ean, siteSettings, sourceProductName },
        {
            timeout: SCRAPER_TIMEOUT_MS,
            headers: { 'Content-Type': 'application/json' },
            validateStatus: (status) => status < 500
        }
    );

    if (response.status >= 400) {
        const err = new Error(response.data?.error || `Scraper returned HTTP ${response.status}`);
        err.code = response.data?.code || 'SCRAPER_HTTP_ERROR';
        err.response = response;
        throw err;
    }

    return response.data;
}

module.exports = {
    SCRAPER_BASE,
    SCRAPER_URL,
    SCRAPER_TIMEOUT_MS,
    formatScraperError,
    checkScraperHealth,
    requestLiveScrape
};
