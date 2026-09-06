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
            CREATE TABLE IF NOT EXISTS routines (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
                task TEXT NOT NULL,
                recurrence_type TEXT NOT NULL CHECK (recurrence_type IN ('weekly', 'monthly')),
                days_of_week INTEGER[],
                days_of_month INTEGER[],
                favourited BOOLEAN NOT NULL DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT routines_task_not_empty CHECK (length(trim(task)) > 0),
                CONSTRAINT routines_recurrence_matches_type CHECK (
                    (recurrence_type = 'weekly' AND days_of_week IS NOT NULL AND days_of_month IS NULL)
                    OR
                    (recurrence_type = 'monthly' AND days_of_month IS NOT NULL AND days_of_week IS NULL)
                )
            )
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_routines_user_id ON routines(user_id)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_routines_category_id ON routines(category_id)`);
        await client.query(`DROP TRIGGER IF EXISTS update_routines_updated_at ON routines`);
        await client.query(`
            CREATE TRIGGER update_routines_updated_at
            BEFORE UPDATE ON routines
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column()
        `);

        // Habit-tracker completion history: one row per occurrence completed.
        // The "current" occurrence is computed client-side from today's date
        // and the recurrence rule — this table just remembers which specific
        // dates were marked done, so completing one occurrence doesn't
        // affect any other.
        await client.query(`
            CREATE TABLE IF NOT EXISTS routine_completions (
                id SERIAL PRIMARY KEY,
                routine_id INTEGER NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
                occurrence_date DATE NOT NULL,
                completed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (routine_id, occurrence_date)
            )
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_routine_completions_routine_id ON routine_completions(routine_id)`);

        // Mirrors task_reminders (same days_before/remind_at XOR pattern),
        // plus time_of_day for picking a specific time on a "days before"
        // reminder instead of the fixed default.
        await client.query(`
            CREATE TABLE IF NOT EXISTS routine_reminders (
                id SERIAL PRIMARY KEY,
                routine_id INTEGER NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
                days_before INTEGER,
                remind_at TIMESTAMPTZ,
                time_of_day TIME,
                message TEXT,
                enabled BOOLEAN NOT NULL DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT routine_reminders_exactly_one_kind CHECK (num_nonnulls(days_before, remind_at) = 1)
            )
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_routine_reminders_routine_id ON routine_reminders(routine_id)`);
        await client.query(`DROP TRIGGER IF EXISTS update_routine_reminders_updated_at ON routine_reminders`);
        await client.query(`
            CREATE TRIGGER update_routine_reminders_updated_at
            BEFORE UPDATE ON routine_reminders
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column()
        `);

        // Same optional-time enhancement applied to ordinary task reminders —
        // purely additive, existing rows keep the fixed 9:00 AM default when
        // this stays null.
        await client.query(`ALTER TABLE task_reminders ADD COLUMN IF NOT EXISTS time_of_day TIME`);

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
