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

        // A reminder is now either "N days before the due date" (days_before)
        // or an absolute "custom date & time" (remind_at) — exactly one of
        // the two, never both, never neither. The custom kind doesn't need
        // a due date at all, which is the whole point of adding it.
        await client.query(`ALTER TABLE task_reminders ALTER COLUMN days_before DROP NOT NULL`);
        await client.query(`ALTER TABLE task_reminders ALTER COLUMN days_before DROP DEFAULT`);
        await client.query(`ALTER TABLE task_reminders ADD COLUMN IF NOT EXISTS remind_at TIMESTAMP`);
        await client.query(`ALTER TABLE task_reminders DROP CONSTRAINT IF EXISTS task_reminders_exactly_one_kind`);
        await client.query(`
            ALTER TABLE task_reminders
            ADD CONSTRAINT task_reminders_exactly_one_kind
            CHECK (num_nonnulls(days_before, remind_at) = 1)
        `);

        // The old default template hardcoded "is due today" regardless of
        // how many days before the reminder actually fires. Re-point it at
        // a {when} placeholder the client fills in per-reminder (today /
        // tomorrow / in N days) — but only for rows still on the original
        // text, so anyone who already customized their message keeps it.
        await client.query(`
            UPDATE app_settings
            SET default_reminder_message = 'Task "{task}" is due {when}!'
            WHERE default_reminder_message = 'Task "{task}" is due today!'
        `);

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
