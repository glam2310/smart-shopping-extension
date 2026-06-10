-- Smart Shopping — Schema v2
-- Run once against smart_shopping_db

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------- Types ----------
DO $$ BEGIN
    CREATE TYPE tracking_type AS ENUM ('passive', 'active');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- ---------- Rename legacy tables (safe rollback window) ----------
DO $$ BEGIN
    ALTER TABLE products RENAME TO products_legacy;
EXCEPTION
    WHEN undefined_table THEN NULL;
    WHEN duplicate_table THEN NULL;
END $$;

-- ---------- Users ----------
CREATE TABLE IF NOT EXISTS users (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    installation_id   UUID NOT NULL UNIQUE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    extension_version VARCHAR(32),
    locale            VARCHAR(16) DEFAULT 'he-IL',
    platform          VARCHAR(64),
    timezone          VARCHAR(64),
    is_active         BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users (last_seen_at DESC);

-- ---------- Global products (EAN = identity) ----------
CREATE TABLE IF NOT EXISTS products (
    ean           VARCHAR(14) PRIMARY KEY,
    product_name  TEXT,
    brand         TEXT,
    image_url     TEXT,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT products_ean_format_chk CHECK (ean ~ '^\d{8,14}$')
);

-- ---------- Per-site price cache ----------
CREATE TABLE IF NOT EXISTS product_site_offers (
    ean            VARCHAR(14) NOT NULL REFERENCES products(ean) ON DELETE CASCADE,
    site_key       VARCHAR(128) NOT NULL,
    product_url    TEXT,
    price          NUMERIC(10,2),
    currency       CHAR(3) NOT NULL DEFAULT 'ILS',
    exists_on_site BOOLEAN NOT NULL DEFAULT FALSE,
    collected_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (ean, site_key),
    CONSTRAINT product_site_offers_price_sane_chk
        CHECK (price IS NULL OR (price > 0 AND price < 100000))
);

CREATE INDEX IF NOT EXISTS idx_offers_collected_at ON product_site_offers (collected_at);
CREATE INDEX IF NOT EXISTS idx_offers_site_fresh ON product_site_offers (site_key, collected_at DESC);

-- ---------- User tracker ----------
CREATE TABLE IF NOT EXISTS user_tracker (
    id               BIGSERIAL PRIMARY KEY,
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ean              VARCHAR(14) NOT NULL REFERENCES products(ean) ON DELETE CASCADE,
    source_site      VARCHAR(128) NOT NULL,
    tracking_type    tracking_type NOT NULL,
    dwell_seconds    INTEGER,
    source_url       TEXT,
    product_name     TEXT,
    brand            TEXT,
    session_id       UUID,
    first_tracked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_tracked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_active        BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT user_tracker_unique_interest UNIQUE (user_id, ean, source_site)
);

CREATE INDEX IF NOT EXISTS idx_user_tracker_user ON user_tracker (user_id, last_tracked_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_tracker_type ON user_tracker (user_id, tracking_type);

-- ---------- Migrate ean_mappings -> product_site_offers ----------
DO $$ BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'ean_mappings'
    ) THEN
        INSERT INTO products (ean, first_seen_at, updated_at)
        SELECT ean, MIN(COALESCE(updated_at, NOW())), MAX(COALESCE(updated_at, NOW()))
        FROM ean_mappings
        WHERE ean ~ '^\d{8,14}$'
        GROUP BY ean
        ON CONFLICT (ean) DO NOTHING;

        INSERT INTO product_site_offers (
            ean, site_key, product_url, price, exists_on_site, collected_at, updated_at
        )
        SELECT
            ean,
            target_site,
            target_url,
            CASE
                WHEN cached_price > 0 AND cached_price < 100000 THEN cached_price
                ELSE NULL
            END,
            (
                cached_price IS NOT NULL AND cached_price > 0 AND cached_price < 100000
                AND target_url IS NOT NULL
                AND target_url NOT ILIKE '%/search%'
            ),
            COALESCE(updated_at, NOW()),
            COALESCE(updated_at, NOW())
        FROM ean_mappings
        WHERE ean ~ '^\d{8,14}$'
        ON CONFLICT (ean, site_key) DO UPDATE SET
            product_url    = EXCLUDED.product_url,
            price          = EXCLUDED.price,
            exists_on_site = EXCLUDED.exists_on_site,
            collected_at   = EXCLUDED.collected_at,
            updated_at     = EXCLUDED.updated_at;
    END IF;
END $$;

-- ---------- Migrate legacy user_events users ----------
DO $$ BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'user_events'
    ) THEN
        INSERT INTO users (installation_id, created_at, last_seen_at)
        SELECT
            user_id,
            MIN(COALESCE(created_at, NOW())),
            MAX(COALESCE(created_at, NOW()))
        FROM user_events
        WHERE user_id IS NOT NULL
        GROUP BY user_id
        ON CONFLICT (installation_id) DO NOTHING;
    END IF;
END $$;

COMMIT;
