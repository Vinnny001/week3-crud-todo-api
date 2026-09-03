require("dotenv").config();
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");

const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
});

async function ensureDefaultCategoriesAndSettings(client, userId) {
    const existingDefault = await client.query(
        `SELECT id FROM categories WHERE user_id = $1 AND kind = 'default'`,
        [userId]
    );

    if (existingDefault.rows.length === 0) {
        await client.query(
            `INSERT INTO categories (name, color, locked, kind, user_id) VALUES ('My Tasks', '#6366f1', TRUE, 'default', $1)`,
            [userId]
        );
        await client.query(
            `INSERT INTO categories (name, color, locked, kind, user_id) VALUES ('Favourite', '#f59e0b', TRUE, 'favourite', $1)`,
            [userId]
        );
    }

    const existingSettings = await client.query(
        `SELECT id FROM app_settings WHERE user_id = $1`,
        [userId]
    );

    if (existingSettings.rows.length === 0) {
        const template = await client.query(
            `SELECT notify_due_today_enabled, default_reminder_message FROM app_settings WHERE id = 1`
        );
        const t = template.rows[0];
        await client.query(
            `INSERT INTO app_settings (notify_due_today_enabled, default_reminder_message, user_id) VALUES ($1, $2, $3)`,
            [t.notify_due_today_enabled, t.default_reminder_message, userId]
        );
    }
}

(async () => {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const passwordHash = await bcrypt.hash("TestPass123", 10);

        // clean slate for repeatable runs
        await client.query(`DELETE FROM users WHERE email IN ('test-a@example.com','test-b@example.com')`);

        const userA = (await client.query(
            `INSERT INTO users (email, password_hash, name, email_verified) VALUES ($1,$2,'Test A',TRUE) RETURNING id, email`,
            ["test-a@example.com", passwordHash]
        )).rows[0];

        // Simulate the first-ever-verified-user backfill that /auth/verify-email performs
        const verifiedCount = (await client.query(`SELECT COUNT(*)::int AS count FROM users WHERE email_verified = TRUE`)).rows[0].count;
        console.log("verified count after creating A:", verifiedCount);

        if (verifiedCount === 1) {
            await client.query(`UPDATE todos SET user_id = $1 WHERE user_id IS NULL`, [userA.id]);
            await client.query(`ALTER TABLE categories DISABLE TRIGGER prevent_locked_category_update`);
            await client.query(`UPDATE categories SET user_id = $1 WHERE user_id IS NULL`, [userA.id]);
            await client.query(`ALTER TABLE categories ENABLE TRIGGER prevent_locked_category_update`);
        }
        await ensureDefaultCategoriesAndSettings(client, userA.id);

        const userB = (await client.query(
            `INSERT INTO users (email, password_hash, name, email_verified) VALUES ($1,$2,'Test B',TRUE) RETURNING id, email`,
            ["test-b@example.com", passwordHash]
        )).rows[0];
        await ensureDefaultCategoriesAndSettings(client, userB.id);

        await client.query("COMMIT");

        console.log("Seeded:", { userA, userB });
    } catch (e) {
        await client.query("ROLLBACK");
        console.error(e);
        process.exitCode = 1;
    } finally {
        client.release();
        await pool.end();
    }
})();
