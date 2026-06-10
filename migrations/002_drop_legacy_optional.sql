-- Drop legacy tables after schema v2 is verified.
-- KEEP: users, products, product_site_offers, user_tracker
-- (product_site_offers is the global price cache — required for compare flow)

BEGIN;

DROP TABLE IF EXISTS stock_alerts CASCADE;
DROP TABLE IF EXISTS user_events CASCADE;
DROP TABLE IF EXISTS product_mappings CASCADE;
DROP TABLE IF EXISTS event_weights CASCADE;
DROP TABLE IF EXISTS brands CASCADE;
DROP TABLE IF EXISTS ean_mappings CASCADE;
DROP TABLE IF EXISTS products_legacy CASCADE;

COMMIT;

-- Verify remaining tables:
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'public' ORDER BY table_name;
-- Expected: product_site_offers, products, user_tracker, users
