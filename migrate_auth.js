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
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                name TEXT,
                avatar_url TEXT,
                email_verified BOOLEAN NOT NULL DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await client.query(`
            DROP TRIGGER IF EXISTS update_users_updated_at ON users
        `);
        await client.query(`
            CREATE TRIGGER update_users_updated_at
            BEFORE UPDATE ON users
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column()
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS verification_codes (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                code TEXT NOT NULL,
                purpose TEXT NOT NULL CHECK (purpose IN ('signup', 'password_reset')),
                expires_at TIMESTAMP NOT NULL,
                used BOOLEAN NOT NULL DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_verification_codes_lookup
            ON verification_codes(user_id, purpose, used)
        `);

        // Existing rows predate accounts entirely, so this column starts
        // nullable — the first user to ever verify their email inherits
        // them (see the /auth/verify-email backfill in app.js) rather than
        // this migration guessing who owns them.
        await client.query(`
            ALTER TABLE todos
            ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_todos_user_id ON todos(user_id)
        `);

        await client.query(`
            ALTER TABLE categories
            ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_categories_user_id ON categories(user_id)
        `);

        // 'kind' identifies the two built-in categories (My Tasks /
        // Favourite) without relying on a fixed numeric id — each user gets
        // their own rows for these once categories are per-user, so id 1/2
        // can no longer mean "My Tasks"/"Favourite" globally.
        await client.query(`
            ALTER TABLE categories
            ADD COLUMN IF NOT EXISTS kind TEXT CHECK (kind IN ('default', 'favourite'))
        `);
        // My Tasks/Favourite are locked=true, and a BEFORE UPDATE trigger
        // (prevent_locked_category_update) unconditionally rejects any
        // update to a locked row — bypass it just for this backfill.
        await client.query(`ALTER TABLE categories DISABLE TRIGGER prevent_locked_category_update`);
        await client.query(`UPDATE categories SET kind = 'default' WHERE id = 1 AND kind IS NULL`);
        await client.query(`UPDATE categories SET kind = 'favourite' WHERE id = 2 AND kind IS NULL`);
        await client.query(`ALTER TABLE categories ENABLE TRIGGER prevent_locked_category_update`);

        // Category names were globally unique (case-insensitively, via
        // idx_categories_name_unique on lower(name)); now they only need to
        // be unique per user (two users can each have a "Work" category).
        await client.query(`DROP INDEX IF EXISTS idx_categories_name_unique`);
        await client.query(`DROP INDEX IF EXISTS idx_categories_user_name`);
        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_user_name_unique
            ON categories(user_id, lower(name))
        `);

        // app_settings moves from a single global row (id=1) to one row per
        // user. The id=1 row is left in place as the legacy defaults
        // template that every newly-verified user's row is seeded from.
        await client.query(`
            ALTER TABLE app_settings DROP CONSTRAINT IF EXISTS single_row
        `);
        await client.query(`
            ALTER TABLE app_settings
            ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE
        `);
        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_app_settings_user_id
            ON app_settings(user_id)
        `);
        await client.query(`
            ALTER TABLE app_settings ALTER COLUMN id DROP DEFAULT
        `);
        await client.query(`
            CREATE SEQUENCE IF NOT EXISTS app_settings_id_seq OWNED BY app_settings.id
        `);
        await client.query(`
            SELECT setval('app_settings_id_seq', GREATEST((SELECT MAX(id) FROM app_settings), 1))
        `);
        await client.query(`
            ALTER TABLE app_settings ALTER COLUMN id SET DEFAULT nextval('app_settings_id_seq')
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
