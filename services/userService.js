async function ensureUser(pool, { installationId, extensionVersion, locale, platform, timezone }) {
    const { rows } = await pool.query(
        `INSERT INTO users (installation_id, extension_version, locale, platform, timezone, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (installation_id) DO UPDATE SET
            last_seen_at      = NOW(),
            extension_version = COALESCE(EXCLUDED.extension_version, users.extension_version),
            locale            = COALESCE(EXCLUDED.locale, users.locale),
            platform          = COALESCE(EXCLUDED.platform, users.platform),
            timezone          = COALESCE(EXCLUDED.timezone, users.timezone)
         RETURNING id`,
        [
            installationId,
            extensionVersion || null,
            locale || 'he-IL',
            platform || null,
            timezone || null
        ]
    );
    return rows[0].id;
}

module.exports = { ensureUser };
