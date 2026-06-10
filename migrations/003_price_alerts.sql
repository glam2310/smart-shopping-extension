-- Price drop alerts + tracker baseline / opt-out support

BEGIN;

ALTER TABLE user_tracker
    ADD COLUMN IF NOT EXISTS baseline_price   NUMERIC(10,2),
    ADD COLUMN IF NOT EXISTS baseline_site_key VARCHAR(128),
    ADD COLUMN IF NOT EXISTS unsubscribed_at  TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS price_drop_alerts (
    id           BIGSERIAL PRIMARY KEY,
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ean          VARCHAR(14) NOT NULL REFERENCES products(ean) ON DELETE CASCADE,
    site_key     VARCHAR(128) NOT NULL,
    old_price    NUMERIC(10,2) NOT NULL,
    new_price    NUMERIC(10,2) NOT NULL,
    drop_amount  NUMERIC(10,2) NOT NULL,
    product_url  TEXT,
    product_name TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    notified_at  TIMESTAMPTZ,
    is_read      BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_price_alerts_user_unread
    ON price_drop_alerts (user_id, is_read, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_tracker_active_ean
    ON user_tracker (ean, tracking_type)
    WHERE is_active = TRUE;

COMMIT;
