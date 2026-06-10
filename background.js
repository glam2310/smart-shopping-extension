const API_BASE = 'http://localhost:3000';

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'TRACK_PRODUCT') {
        fetch(`${API_BASE}/api/track`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(message.payload)
        })
            .then(async (res) => {
                const data = await res.json();
                sendResponse({ ok: res.ok, status: res.status, data });
            })
            .catch(error => sendResponse({ ok: false, error: error.message }));

        return true;
    }

    if (message.type === 'GET_TRACKER') {
        const installationId = message.payload?.installation_id;
        if (!installationId) {
            sendResponse({ ok: false, error: 'installation_id required' });
            return true;
        }

        fetch(`${API_BASE}/api/track/${installationId}`)
            .then(res => res.json())
            .then(data => sendResponse({ ok: true, data }))
            .catch(error => sendResponse({ ok: false, error: error.message }));

        return true;
    }

    if (message.type === 'GET_TRACK_STATUS') {
        const { installation_id, ean, source_site } = message.payload || {};
        if (!installation_id || !ean || !source_site) {
            sendResponse({ ok: false, error: 'installation_id, ean, source_site required' });
            return true;
        }

        const encodedSite = encodeURIComponent(source_site);
        fetch(`${API_BASE}/api/track/${installation_id}/${ean}/${encodedSite}`)
            .then(res => res.json())
            .then(data => sendResponse({ ok: true, data }))
            .catch(error => sendResponse({ ok: false, error: error.message }));

        return true;
    }
});
