import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();
function createPool() {
    const rawUrl = process.env.MYSQL_URL;
    if (!rawUrl)
        throw new Error('MYSQL_URL environment variable is not set');
    // Aiven URLs often contain ?ssl-mode=REQUIRED which mysql2 doesn't support as a param.
    // Strip it and apply SSL explicitly instead.
    const cleanUrl = rawUrl.replace(/[?&]ssl-mode=[^&]*/i, '').replace(/\?$/, '');
    return mysql.createPool({
        uri: cleanUrl,
        ssl: { rejectUnauthorized: false }, // Aiven TLS with self-signed cert
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        connectTimeout: 20000,
        timezone: '+00:00',
    });
}
export const pool = createPool();
/**
 * Execute a parameterized query against Aiven MySQL.
 * Uses ? placeholders (mysql2), NOT $1/$2 (pg).
 */
export async function query(sql, params) {
    const start = Date.now();
    try {
        const [rows] = await pool.execute(sql, params);
        const dur = Date.now() - start;
        if (dur > 1000)
            console.warn(`[DB] Slow query (${dur}ms): ${sql.substring(0, 80)}`);
        return rows;
    }
    catch (err) {
        console.error('[DB] Query error:', sql.substring(0, 120), '\n', err);
        throw err;
    }
}
export default pool;
//# sourceMappingURL=index.js.map