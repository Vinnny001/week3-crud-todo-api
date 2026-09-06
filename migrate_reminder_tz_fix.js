require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
});

(async () => {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // remind_at was created as TIMESTAMP (no time zone) — Postgres
        // stored the UTC instant's clock digits but dropped the "this is
        // UTC" marker, so reading it back re-parsed those digits as local
        // time on the client, shifting displayed times by the user's UTC
        // offset. The stored digits are already correct UTC clock values
        // (the app always writes .toISOString() strings), so converting
        // with "AT TIME ZONE 'UTC'" just tags them correctly instead of
        // changing them.
        const colInfo = await client.query(`
            SELECT data_type FROM information_schema.columns
            WHERE table_name = 'task_reminders' AND column_name = 'remind_at'
        `);

        if (colInfo.rows[0]?.data_type !== "timestamp with time zone") {
            await client.query(`
                ALTER TABLE task_reminders
                ALTER COLUMN remind_at TYPE TIMESTAMPTZ
                USING remind_at AT TIME ZONE 'UTC'
            `);
        }

        await client.query("COMMIT");
        console.log("Migration complete");
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Migration failed:", error);
        process.exitCode = 1;
    } finally {
        client.release();
        await pool.end();
    }
})();
