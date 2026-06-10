const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
    user: process.env.PGUSER || 'postgres',
    host: process.env.PGHOST || 'localhost',
    database: process.env.PGDATABASE || 'smart_shopping_db',
    password: process.env.PGPASSWORD || 'morgreenberg',
    port: Number(process.env.PGPORT || 5432)
});

async function main() {
    const migrationsDir = path.join(__dirname, '..', 'migrations');
    const files = fs.readdirSync(migrationsDir)
        .filter(f => f.endsWith('.sql'))
        .sort();

    for (const file of files) {
        const sqlPath = path.join(migrationsDir, file);
        const sql = fs.readFileSync(sqlPath, 'utf8');
        console.log('Running migration:', sqlPath);
        await pool.query(sql);
    }
    console.log('All migrations complete.');

    const tables = await pool.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name
    `);
    console.log('Tables:', tables.rows.map(r => r.table_name).join(', '));

    await pool.end();
}

main().catch(err => {
    console.error('Migration failed:', err.message);
    process.exit(1);
});
