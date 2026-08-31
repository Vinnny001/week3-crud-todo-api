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

        await client.query(`
            ALTER TABLE categories
            ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        `);
        await client.query(`UPDATE categories SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL`);
        await client.query(`
            DROP TRIGGER IF EXISTS update_categories_updated_at ON categories
        `);
        await client.query(`
            CREATE TRIGGER update_categories_updated_at
            BEFORE UPDATE ON categories
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column()
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS app_settings (
                id INTEGER PRIMARY KEY DEFAULT 1,
                notify_due_today_enabled BOOLEAN NOT NULL DEFAULT TRUE,
                default_reminder_message TEXT NOT NULL DEFAULT 'Task "{task}" is due today!',
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT single_row CHECK (id = 1)
            )
        `);
        await client.query(`
            INSERT INTO app_settings (id) VALUES (1)
            ON CONFLICT (id) DO NOTHING
        `);
        await client.query(`
            DROP TRIGGER IF EXISTS update_app_settings_updated_at ON app_settings
        `);
        await client.query(`
            CREATE TRIGGER update_app_settings_updated_at
            BEFORE UPDATE ON app_settings
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column()
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS task_reminders (
                id SERIAL PRIMARY KEY,
                todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
                days_before INTEGER NOT NULL DEFAULT 0,
                message TEXT,
                enabled BOOLEAN NOT NULL DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await client.query(`
            DROP TRIGGER IF EXISTS update_task_reminders_updated_at ON task_reminders
        `);
        await client.query(`
            CREATE TRIGGER update_task_reminders_updated_at
            BEFORE UPDATE ON task_reminders
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column()
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_task_reminders_todo_id ON task_reminders(todo_id)
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
