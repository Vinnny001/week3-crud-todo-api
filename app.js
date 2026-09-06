const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
require("dotenv").config();

const app = express();

// ============================================================
// CONFIGURATION
// ============================================================

const PORT = process.env.PORT || 3000;

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "1d";
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const MAIL_FROM = process.env.MAIL_FROM;
const CODE_TTL_MINUTES = 15;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TIME_OF_DAY_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(cors());
app.use(express.json());

// ============================================================
// POSTGRESQL CONNECTION
// ============================================================

const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
});

// Test database connection
pool.connect()
    .then((client) => {
        console.log("PostgreSQL connected successfully");
        client.release();
    })
    .catch((error) => {
        console.error("PostgreSQL connection failed:");
        console.error(error.message);
    });

// ============================================================
// DATABASE HELPER
// ============================================================

const TODO_SELECT = `
    SELECT
        t.id,
        t.task,
        t.completed,
        t.due_date AS "dueDate",
        t.category_id AS "categoryId",
        t.favourited,
        t.created_at AS "createdAt",
        t.updated_at AS "updatedAt",

        COALESCE((
            SELECT json_agg(
                json_build_object(
                    'id', s.id,
                    'task', s.task,
                    'completed', s.completed
                )
                ORDER BY s.id
            )
            FROM subtasks s
            WHERE s.todo_id = t.id
        ), '[]') AS subtasks,

        COALESCE((
            SELECT json_agg(
                json_build_object(
                    'id', r.id,
                    'daysBefore', r.days_before,
                    'remindAt', r.remind_at,
                    'timeOfDay', r.time_of_day,
                    'message', r.message,
                    'enabled', r.enabled
                )
                ORDER BY r.days_before NULLS LAST, r.remind_at
            )
            FROM task_reminders r
            WHERE r.todo_id = t.id
        ), '[]') AS reminders

    FROM todos t
`;

async function getTodoById(id, userId) {
    const result = await pool.query(
        `${TODO_SELECT} WHERE t.id = $1 AND t.user_id = $2`,
        [id, userId]
    );

    return result.rows[0];
}

// Auto-creates the default "due today" reminder for a todo, unless the
// caller's setting is off or the todo already has reminders (custom or
// previously auto-created) — keeps this idempotent to call after any
// insert/update that leaves the todo with a due date.
async function maybeCreateDefaultReminder(queryable, todoId, userId) {
    const settingsResult = await queryable.query(
        `SELECT notify_due_today_enabled FROM app_settings WHERE user_id = $1`,
        [userId]
    );

    if (!settingsResult.rows[0]?.notify_due_today_enabled) {
        return;
    }

    const existing = await queryable.query(
        `SELECT id FROM task_reminders WHERE todo_id = $1 LIMIT 1`,
        [todoId]
    );

    if (existing.rows.length > 0) {
        return;
    }

    await queryable.query(
        `
        INSERT INTO task_reminders
            (todo_id, days_before, message, enabled)
        VALUES
            ($1, 0, NULL, TRUE)
        `,
        [todoId]
    );
}

// ============================================================
// AUTH HELPERS
// ============================================================

// Sends a transactional email via Brevo's REST API. Throws on failure so
// callers decide whether an email failure should also fail the request.
async function sendBrevoEmail(to, subject, htmlContent) {
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "api-key": BREVO_API_KEY,
        },
        body: JSON.stringify({
            sender: { email: MAIL_FROM },
            to: [{ email: to }],
            subject,
            htmlContent,
        }),
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Brevo send failed (${response.status}): ${body}`);
    }
}

function generateCode() {
    return crypto.randomInt(100000, 1000000).toString();
}

// Invalidates any outstanding unused code for this user+purpose, creates a
// fresh one, and emails it. Shared by signup, resend, and forgot-password.
async function createAndSendCode(queryable, userId, email, purpose) {
    const code = generateCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000);

    await queryable.query(
        `
        UPDATE verification_codes
        SET used = TRUE
        WHERE user_id = $1 AND purpose = $2 AND used = FALSE
        `,
        [userId, purpose]
    );

    await queryable.query(
        `
        INSERT INTO verification_codes
            (user_id, code, purpose, expires_at)
        VALUES
            ($1, $2, $3, $4)
        `,
        [userId, code, purpose, expiresAt]
    );

    const subject =
        purpose === "signup" ? "Verify your email" : "Reset your password";

    const html = `
        <p>Your verification code is:</p>
        <h2 style="letter-spacing:4px;">${code}</h2>
        <p>This code expires in ${CODE_TTL_MINUTES} minutes. If you didn't request this, you can ignore this email.</p>
    `;

    await sendBrevoEmail(email, subject, html);
}

function issueToken(user) {
    return jwt.sign(
        { id: user.id, email: user.email },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN }
    );
}

function publicUser(user) {
    return {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatar_url,
        createdAt: user.created_at,
    };
}

function authenticateToken(req, res, next) {
    const header = req.headers.authorization;
    const token =
        header && header.startsWith("Bearer ") ? header.slice(7) : null;

    if (!token) {
        return res.status(401).json({
            error: "Authentication required",
        });
    }

    try {
        const payload = jwt.verify(token, JWT_SECRET);
        req.user = { id: payload.id, email: payload.email };
        next();
    } catch {
        return res.status(401).json({
            error: "Invalid or expired token",
        });
    }
}

// Every user needs their own "My Tasks" / "Favourite" categories and a
// settings row — these aren't fixed IDs 1/2 anymore now that categories are
// per-user. The very first account to ever verify instead *inherits* the
// pre-accounts legacy rows (see the backfill in /auth/verify-email), so this
// only creates fresh ones when that inheritance didn't already cover it.
async function ensureDefaultCategoriesAndSettings(client, userId) {
    const existingDefault = await client.query(
        `SELECT id FROM categories WHERE user_id = $1 AND kind = 'default'`,
        [userId]
    );

    if (existingDefault.rows.length === 0) {
        await client.query(
            `
            INSERT INTO categories (name, color, locked, kind, user_id)
            VALUES ('My Tasks', '#6366f1', TRUE, 'default', $1)
            `,
            [userId]
        );

        await client.query(
            `
            INSERT INTO categories (name, color, locked, kind, user_id)
            VALUES ('Favourite', '#f59e0b', TRUE, 'favourite', $1)
            `,
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

        const t = template.rows[0] || {
            notify_due_today_enabled: true,
            default_reminder_message: 'Task "{task}" is due {when}!',
        };

        await client.query(
            `
            INSERT INTO app_settings
                (notify_due_today_enabled, default_reminder_message, user_id)
            VALUES
                ($1, $2, $3)
            `,
            [t.notify_due_today_enabled, t.default_reminder_message, userId]
        );
    }
}

// ============================================================
// ROOT ROUTE
// ============================================================

app.get("/", (req, res) => {
    res.json({
        message: "RCP Todo API is running",
        status: "OK",
    });
});

// ============================================================
// AUTH
// ============================================================

// POST /auth/signup
app.post("/auth/signup", async (req, res) => {
    try {
        const email = (req.body.email || "").trim().toLowerCase();
        const password = req.body.password || "";
        const name = req.body.name;

        if (!email || !EMAIL_RE.test(email) || !password) {
            return res.status(400).json({
                error: "A valid email and password are required",
            });
        }

        if (password.length < 8) {
            return res.status(400).json({
                error: "Password must be at least 8 characters",
            });
        }

        const passwordHash = await bcrypt.hash(password, 10);

        const client = await pool.connect();

        try {
            await client.query("BEGIN");

            const result = await client.query(
                `
                INSERT INTO users
                    (email, password_hash, name)
                VALUES
                    ($1, $2, $3)
                RETURNING id, email
                `,
                [email, passwordHash, name?.trim() || null]
            );

            const user = result.rows[0];

            // Sending the email is part of this transaction on purpose: if
            // it fails (e.g. the email provider rejects the send), the user
            // row is rolled back too, so the caller can just retry signup
            // instead of being permanently stuck on a "duplicate email"
            // account that can never receive a code.
            await createAndSendCode(client, user.id, user.email, "signup");

            await client.query("COMMIT");

            res.status(201).json({
                message: "Account created. Check your email for a verification code.",
            });
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }

    } catch (error) {
        console.error(error);

        if (error.code === "23505") {
            return res.status(409).json({
                error: "An account with this email already exists",
            });
        }

        res.status(500).json({
            error: "Failed to create account",
        });
    }
});


// POST /auth/verify-email
app.post("/auth/verify-email", async (req, res) => {
    const email = (req.body.email || "").trim().toLowerCase();
    const code = req.body.code;

    if (!email || !code) {
        return res.status(400).json({
            error: "Email and code are required",
        });
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const userResult = await client.query(
            `SELECT * FROM users WHERE email = $1`,
            [email]
        );

        if (userResult.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({
                error: "Account not found",
            });
        }

        const user = userResult.rows[0];

        const codeResult = await client.query(
            `
            SELECT id FROM verification_codes
            WHERE user_id = $1 AND purpose = 'signup' AND code = $2
                AND used = FALSE AND expires_at > NOW()
            ORDER BY id DESC
            LIMIT 1
            `,
            [user.id, code]
        );

        if (codeResult.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(400).json({
                error: "Invalid or expired code",
            });
        }

        await client.query(
            `UPDATE verification_codes SET used = TRUE WHERE id = $1`,
            [codeResult.rows[0].id]
        );

        await client.query(
            `UPDATE users SET email_verified = TRUE WHERE id = $1`,
            [user.id]
        );

        const verifiedCountResult = await client.query(
            `SELECT COUNT(*)::int AS count FROM users WHERE email_verified = TRUE`
        );

        // The very first account ever verified inherits all pre-accounts
        // data instead of starting empty.
        if (verifiedCountResult.rows[0].count === 1) {
            await client.query(
                `UPDATE todos SET user_id = $1 WHERE user_id IS NULL`,
                [user.id]
            );

            // The legacy My Tasks/Favourite categories are locked=true, and
            // a BEFORE UPDATE trigger unconditionally rejects updates to
            // locked rows — bypass it just for this one-time backfill.
            await client.query(`ALTER TABLE categories DISABLE TRIGGER prevent_locked_category_update`);
            await client.query(
                `UPDATE categories SET user_id = $1 WHERE user_id IS NULL`,
                [user.id]
            );
            await client.query(`ALTER TABLE categories ENABLE TRIGGER prevent_locked_category_update`);
        }

        await ensureDefaultCategoriesAndSettings(client, user.id);

        await client.query("COMMIT");

        const token = issueToken(user);

        res.status(200).json({
            token,
            user: publicUser({ ...user, email_verified: true }),
        });

    } catch (error) {
        await client.query("ROLLBACK");
        console.error(error);
        res.status(500).json({
            error: "Failed to verify email",
        });
    } finally {
        client.release();
    }
});


// POST /auth/resend-code
app.post("/auth/resend-code", async (req, res) => {
    try {
        const email = (req.body.email || "").trim().toLowerCase();
        const purpose = req.body.purpose;

        if (!email || !["signup", "password_reset"].includes(purpose)) {
            return res.status(400).json({
                error: "Email and a valid purpose are required",
            });
        }

        const genericResponse = {
            message: "If that account exists, a new code has been sent.",
        };

        const result = await pool.query(
            `SELECT id, email, email_verified FROM users WHERE email = $1`,
            [email]
        );

        // Same generic response whether or not the account exists / is
        // already verified, so this can't be used to enumerate accounts.
        if (result.rows.length === 0) {
            return res.status(200).json(genericResponse);
        }

        const user = result.rows[0];

        if (purpose === "signup" && user.email_verified) {
            return res.status(200).json(genericResponse);
        }

        const client = await pool.connect();

        try {
            await client.query("BEGIN");
            await createAndSendCode(client, user.id, user.email, purpose);
            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }

        res.status(200).json(genericResponse);

    } catch (error) {
        console.error(error);
        res.status(500).json({
            error: "Failed to resend code",
        });
    }
});


// POST /auth/login
app.post("/auth/login", async (req, res) => {
    try {
        const email = (req.body.email || "").trim().toLowerCase();
        const password = req.body.password || "";

        if (!email || !password) {
            return res.status(400).json({
                error: "Email and password are required",
            });
        }

        const result = await pool.query(
            `SELECT * FROM users WHERE email = $1`,
            [email]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({
                error: "Invalid email or password",
            });
        }

        const user = result.rows[0];

        const passwordMatches = await bcrypt.compare(password, user.password_hash);

        if (!passwordMatches) {
            return res.status(401).json({
                error: "Invalid email or password",
            });
        }

        if (!user.email_verified) {
            return res.status(403).json({
                error: "Please verify your email before logging in",
            });
        }

        const token = issueToken(user);

        res.status(200).json({
            token,
            user: publicUser(user),
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({
            error: "Failed to log in",
        });
    }
});


// POST /auth/forgot-password
app.post("/auth/forgot-password", async (req, res) => {
    try {
        const email = (req.body.email || "").trim().toLowerCase();

        if (!email) {
            return res.status(400).json({
                error: "Email is required",
            });
        }

        const genericResponse = {
            message: "If that account exists, a reset code has been sent.",
        };

        const result = await pool.query(
            `SELECT id, email FROM users WHERE email = $1`,
            [email]
        );

        if (result.rows.length > 0) {
            const client = await pool.connect();

            try {
                await client.query("BEGIN");
                await createAndSendCode(
                    client,
                    result.rows[0].id,
                    result.rows[0].email,
                    "password_reset"
                );
                await client.query("COMMIT");
            } catch (error) {
                await client.query("ROLLBACK");
                throw error;
            } finally {
                client.release();
            }
        }

        res.status(200).json(genericResponse);

    } catch (error) {
        console.error(error);
        res.status(500).json({
            error: "Failed to process request",
        });
    }
});


// POST /auth/reset-password
app.post("/auth/reset-password", async (req, res) => {
    try {
        const email = (req.body.email || "").trim().toLowerCase();
        const code = req.body.code;
        const newPassword = req.body.newPassword || "";

        if (!email || !code || !newPassword) {
            return res.status(400).json({
                error: "Email, code, and new password are required",
            });
        }

        if (newPassword.length < 8) {
            return res.status(400).json({
                error: "Password must be at least 8 characters",
            });
        }

        const userResult = await pool.query(
            `SELECT id FROM users WHERE email = $1`,
            [email]
        );

        if (userResult.rows.length === 0) {
            return res.status(400).json({
                error: "Invalid or expired code",
            });
        }

        const userId = userResult.rows[0].id;

        const codeResult = await pool.query(
            `
            SELECT id FROM verification_codes
            WHERE user_id = $1 AND purpose = 'password_reset' AND code = $2
                AND used = FALSE AND expires_at > NOW()
            ORDER BY id DESC
            LIMIT 1
            `,
            [userId, code]
        );

        if (codeResult.rows.length === 0) {
            return res.status(400).json({
                error: "Invalid or expired code",
            });
        }

        const passwordHash = await bcrypt.hash(newPassword, 10);

        await pool.query(
            `UPDATE users SET password_hash = $1 WHERE id = $2`,
            [passwordHash, userId]
        );

        await pool.query(
            `
            UPDATE verification_codes
            SET used = TRUE
            WHERE user_id = $1 AND purpose = 'password_reset' AND used = FALSE
            `,
            [userId]
        );

        res.status(200).json({
            message: "Password updated. You can now log in.",
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({
            error: "Failed to reset password",
        });
    }
});


// GET /auth/me
app.get("/auth/me", authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM users WHERE id = $1`,
            [req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                error: "Account not found",
            });
        }

        res.status(200).json(publicUser(result.rows[0]));

    } catch (error) {
        console.error(error);
        res.status(500).json({
            error: "Failed to fetch profile",
        });
    }
});


// PATCH /auth/me
app.patch("/auth/me", authenticateToken, async (req, res) => {
    try {
        const { name, avatarUrl } = req.body;

        const result = await pool.query(
            `
            UPDATE users

            SET
                name = COALESCE($1, name),
                avatar_url = COALESCE($2, avatar_url)

            WHERE id = $3

            RETURNING *
            `,
            [
                name !== undefined ? name.trim() : null,
                avatarUrl !== undefined ? avatarUrl.trim() : null,
                req.user.id,
            ]
        );

        res.status(200).json(publicUser(result.rows[0]));

    } catch (error) {
        console.error(error);
        res.status(500).json({
            error: "Failed to update profile",
        });
    }
});


// PATCH /auth/change-password
app.patch("/auth/change-password", authenticateToken, async (req, res) => {
    try {
        const currentPassword = req.body.currentPassword || "";
        const newPassword = req.body.newPassword || "";

        if (!currentPassword || !newPassword) {
            return res.status(400).json({
                error: "Current and new password are required",
            });
        }

        if (newPassword.length < 8) {
            return res.status(400).json({
                error: "Password must be at least 8 characters",
            });
        }

        const result = await pool.query(
            `SELECT password_hash FROM users WHERE id = $1`,
            [req.user.id]
        );

        const matches = await bcrypt.compare(
            currentPassword,
            result.rows[0].password_hash
        );

        if (!matches) {
            return res.status(401).json({
                error: "Current password is incorrect",
            });
        }

        const passwordHash = await bcrypt.hash(newPassword, 10);

        await pool.query(
            `UPDATE users SET password_hash = $1 WHERE id = $2`,
            [passwordHash, req.user.id]
        );

        res.status(200).json({
            message: "Password updated",
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({
            error: "Failed to change password",
        });
    }
});

// Everything below this line belongs to the caller's own account.
app.use(
    ["/categories", "/todos", "/completed", "/active", "/settings", "/routines"],
    authenticateToken
);

// ============================================================
// CATEGORIES
// ============================================================

// GET /categories
app.get("/categories", async (req, res) => {
    try {
        const result = await pool.query(
            `
            SELECT
                id,
                name,
                color,
                locked,
                kind,
                updated_at AS "updatedAt"
            FROM categories
            WHERE user_id = $1
            ORDER BY id
            `,
            [req.user.id]
        );

        res.status(200).json(result.rows);

    } catch (error) {
        console.error(error);
        res.status(500).json({
            error: "Failed to fetch categories",
        });
    }
});


// POST /categories
app.post("/categories", async (req, res) => {
    try {
        const { name, color } = req.body;

        if (!name || !name.trim()) {
            return res.status(400).json({
                error: "Category name is required",
            });
        }

        const result = await pool.query(
            `
            INSERT INTO categories
                (name, color, locked, user_id)

            VALUES
                ($1, $2, FALSE, $3)

            RETURNING
                id,
                name,
                color,
                locked,
                kind,
                updated_at AS "updatedAt"
            `,
            [
                name.trim(),
                color || "#6366f1",
                req.user.id,
            ]
        );

        res.status(201).json(result.rows[0]);

    } catch (error) {
        console.error(error);

        if (error.code === "23505") {
            return res.status(409).json({
                error: "A category with this name already exists",
            });
        }

        res.status(500).json({
            error: "Failed to create category",
        });
    }
});


// PATCH /categories/:id
app.patch("/categories/:id", async (req, res) => {
    try {
        const id = parseInt(req.params.id);

        if (Number.isNaN(id)) {
            return res.status(400).json({
                error: "Invalid category ID",
            });
        }

        const categoryResult = await pool.query(
            `
            SELECT *
            FROM categories
            WHERE id = $1 AND user_id = $2
            `,
            [id, req.user.id]
        );

        if (categoryResult.rows.length === 0) {
            return res.status(404).json({
                message: "Category not found",
            });
        }

        const category = categoryResult.rows[0];

        if (category.locked) {
            return res.status(403).json({
                error: "Cannot modify a locked category",
            });
        }

        const { name, color, clientEditedAt } = req.body;

        // Last-write-wins by real event time: if this edit was made (on the
        // client) before the server's last recorded change, something newer
        // already won — silently keep the server's version instead of
        // overwriting it. No user-facing conflict; the client just adopts
        // whatever comes back.
        if (
            clientEditedAt &&
            new Date(clientEditedAt).getTime() <=
                new Date(category.updated_at).getTime()
        ) {
            return res.status(200).json({
                id: category.id,
                name: category.name,
                color: category.color,
                locked: category.locked,
                kind: category.kind,
                updatedAt: category.updated_at,
            });
        }

        const updatedName =
            name !== undefined
                ? name.trim()
                : category.name;

        const updatedColor =
            color !== undefined
                ? color
                : category.color;

        if (!updatedName) {
            return res.status(400).json({
                error: "Category name cannot be empty",
            });
        }

        const result = await pool.query(
            `
            UPDATE categories

            SET
                name = $1,
                color = $2

            WHERE id = $3 AND user_id = $4

            RETURNING
                id,
                name,
                color,
                locked,
                kind,
                updated_at AS "updatedAt"
            `,
            [
                updatedName,
                updatedColor,
                id,
                req.user.id,
            ]
        );

        res.status(200).json(result.rows[0]);

    } catch (error) {
        console.error(error);

        if (error.code === "23505") {
            return res.status(409).json({
                error: "A category with this name already exists",
            });
        }

        res.status(500).json({
            error: "Failed to update category",
        });
    }
});


// DELETE /categories/:id
app.delete("/categories/:id", async (req, res) => {
    const client = await pool.connect();

    try {
        const id = parseInt(req.params.id);

        if (Number.isNaN(id)) {
            return res.status(400).json({
                error: "Invalid category ID",
            });
        }

        await client.query("BEGIN");

        const categoryResult = await client.query(
            `
            SELECT *
            FROM categories
            WHERE id = $1 AND user_id = $2
            `,
            [id, req.user.id]
        );

        if (categoryResult.rows.length === 0) {
            await client.query("ROLLBACK");

            return res.status(404).json({
                error: "Category not found",
            });
        }

        const category = categoryResult.rows[0];

        if (category.locked) {
            await client.query("ROLLBACK");

            return res.status(403).json({
                error: "Cannot delete a locked category",
            });
        }

        const defaultCatResult = await client.query(
            `SELECT id FROM categories WHERE user_id = $1 AND kind = 'default'`,
            [req.user.id]
        );

        // Move tasks to My Tasks
        await client.query(
            `
            UPDATE todos
            SET category_id = $1
            WHERE category_id = $2 AND user_id = $3
            `,
            [defaultCatResult.rows[0].id, id, req.user.id]
        );

        await client.query(
            `
            DELETE FROM categories
            WHERE id = $1 AND user_id = $2
            `,
            [id, req.user.id]
        );

        await client.query("COMMIT");

        res.status(204).send();

    } catch (error) {
        await client.query("ROLLBACK");

        console.error(error);

        res.status(500).json({
            error: "Failed to delete category",
        });

    } finally {
        client.release();
    }
});

// ============================================================
// TODOS
// ============================================================

// GET /todos
app.get("/todos", async (req, res) => {
    try {
        const { categoryId } = req.query;

        let query = TODO_SELECT;

        const values = [req.user.id];

        query += `
            WHERE t.user_id = $1
        `;

        if (categoryId) {
            const catId = parseInt(categoryId);

            const catResult = await pool.query(
                `SELECT kind FROM categories WHERE id = $1 AND user_id = $2`,
                [catId, req.user.id]
            );

            // Favourite view
            if (catResult.rows[0]?.kind === "favourite") {
                query += `
                    AND t.favourited = TRUE
                `;
            }

            // Normal category
            else {
                query += `
                    AND t.category_id = $2
                `;

                values.push(catId);
            }
        }

        query += `
            ORDER BY t.id
        `;

        const result = await pool.query(query, values);

        res.status(200).json(result.rows);

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Failed to fetch todos",
        });
    }
});


// GET /todos/:id
app.get("/todos/:id", async (req, res) => {
    try {
        const id = parseInt(req.params.id);

        if (Number.isNaN(id)) {
            return res.status(400).json({
                error: "Invalid todo ID",
            });
        }

        const todo = await getTodoById(id, req.user.id);

        if (!todo) {
            return res.status(404).json({
                message: "Todo not found",
            });
        }

        res.status(200).json(todo);

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Failed to fetch todo",
        });
    }
});


// POST /todos
app.post("/todos", async (req, res) => {
    try {
        const {
            task,
            dueDate,
            categoryId,
            reminderDaysBefore,
            reminderRemindAt,
            reminderMessage,
        } = req.body;

        if (!task || !task.trim()) {
            return res.status(400).json({
                error: "Task field is required",
            });
        }

        let catId = categoryId ? parseInt(categoryId) : null;

        if (catId) {
            const categoryResult = await pool.query(
                `SELECT kind FROM categories WHERE id = $1 AND user_id = $2`,
                [catId, req.user.id]
            );

            if (categoryResult.rows.length === 0) {
                return res.status(400).json({
                    error: "Category not found",
                });
            }

            // Cannot add directly to Favourite
            if (categoryResult.rows[0].kind === "favourite") {
                return res.status(403).json({
                    error: "Cannot add tasks directly to Favourite",
                });
            }
        } else {
            const defaultCatResult = await pool.query(
                `SELECT id FROM categories WHERE user_id = $1 AND kind = 'default'`,
                [req.user.id]
            );

            catId = defaultCatResult.rows[0].id;
        }

        const result = await pool.query(
            `
            INSERT INTO todos
                (
                    task,
                    completed,
                    due_date,
                    category_id,
                    favourited,
                    user_id
                )

            VALUES
                ($1, FALSE, $2, $3, FALSE, $4)

            RETURNING id
            `,
            [
                task.trim(),
                dueDate || null,
                catId,
                req.user.id,
            ]
        );

        const newTodoId = result.rows[0].id;

        // Custom date & time reminders don't need a due date at all — the
        // "days before" method (below) is the only one that does.
        if (reminderRemindAt) {
            const when = new Date(reminderRemindAt);

            if (!Number.isNaN(when.getTime())) {
                await pool.query(
                    `
                    INSERT INTO task_reminders
                        (todo_id, remind_at, message, enabled)
                    VALUES
                        ($1, $2, $3, TRUE)
                    `,
                    [newTodoId, when.toISOString(), reminderMessage?.trim() || null]
                );
            }
        } else if (dueDate) {
            const days = parseInt(reminderDaysBefore);

            if (!Number.isNaN(days) && days >= 0) {
                await pool.query(
                    `
                    INSERT INTO task_reminders
                        (todo_id, days_before, message, enabled)
                    VALUES
                        ($1, $2, $3, TRUE)
                    `,
                    [newTodoId, days, reminderMessage?.trim() || null]
                );
            }
        }

        if (dueDate) {
            // no-ops if a reminder already exists (e.g. one just added above)
            await maybeCreateDefaultReminder(pool, newTodoId, req.user.id);
        }

        const newTodo = await getTodoById(newTodoId, req.user.id);

        res.status(201).json(newTodo);

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Failed to create todo",
        });
    }
});


// PATCH /todos/:id
app.patch("/todos/:id", async (req, res) => {
    try {
        const id = parseInt(req.params.id);

        if (Number.isNaN(id)) {
            return res.status(400).json({
                error: "Invalid todo ID",
            });
        }

        const existingTodo = await pool.query(
            `
            SELECT *
            FROM todos
            WHERE id = $1 AND user_id = $2
            `,
            [id, req.user.id]
        );

        if (existingTodo.rows.length === 0) {
            return res.status(404).json({
                message: "Todo not found",
            });
        }

        const todo = existingTodo.rows[0];

        const {
            task,
            completed,
            dueDate,
            categoryId,
            favourited,
            clientEditedAt,
        } = req.body;

        // Last-write-wins by real event time (see the matching comment in
        // PATCH /categories/:id) — stale edits are dropped silently and the
        // caller just receives (and adopts) the current server state.
        if (
            clientEditedAt &&
            new Date(clientEditedAt).getTime() <=
                new Date(todo.updated_at).getTime()
        ) {
            const currentTodo = await getTodoById(id, req.user.id);
            return res.status(200).json(currentTodo);
        }

        let newCategoryId = todo.category_id;

        // Category update
        if (categoryId !== undefined) {
            const catId = parseInt(categoryId);

            const categoryResult = await pool.query(
                `
                SELECT kind
                FROM categories
                WHERE id = $1 AND user_id = $2
                `,
                [catId, req.user.id]
            );

            if (categoryResult.rows.length === 0) {
                return res.status(400).json({
                    error: "Category not found",
                });
            }

            if (categoryResult.rows[0].kind === "favourite") {
                return res.status(403).json({
                    error: "Cannot move a task to Favourite via categoryId",
                });
            }

            newCategoryId = catId;
        }

        const result = await pool.query(
            `
            UPDATE todos

            SET
                task = $1,
                completed = $2,
                due_date = $3,
                category_id = $4,
                favourited = $5

            WHERE id = $6 AND user_id = $7

            RETURNING id
            `,
            [
                task !== undefined
                    ? task.trim()
                    : todo.task,

                completed !== undefined
                    ? completed
                    : todo.completed,

                dueDate !== undefined
                    ? dueDate
                    : todo.due_date,

                newCategoryId,

                favourited !== undefined
                    ? favourited
                    : todo.favourited,

                id,
                req.user.id,
            ]
        );

        const finalDueDate =
            dueDate !== undefined ? dueDate : todo.due_date;

        if (finalDueDate) {
            await maybeCreateDefaultReminder(pool, result.rows[0].id, req.user.id);
        }

        const updatedTodo = await getTodoById(
            result.rows[0].id,
            req.user.id
        );

        res.status(200).json(updatedTodo);

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Failed to update todo",
        });
    }
});


// PATCH /todos/:id/favourite
app.patch("/todos/:id/favourite", async (req, res) => {
    try {
        const id = parseInt(req.params.id);

        const result = await pool.query(
            `
            UPDATE todos

            SET favourited = NOT favourited

            WHERE id = $1 AND user_id = $2

            RETURNING id
            `,
            [id, req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                message: "Todo not found",
            });
        }

        const updatedTodo = await getTodoById(id, req.user.id);

        res.status(200).json(updatedTodo);

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Failed to toggle favourite",
        });
    }
});


// DELETE /todos/:id
app.delete("/todos/:id", async (req, res) => {
    try {
        const id = parseInt(req.params.id);

        const result = await pool.query(
            `
            DELETE FROM todos
            WHERE id = $1 AND user_id = $2
            RETURNING id
            `,
            [id, req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                error: "Todo not found",
            });
        }

        // Subtasks are automatically deleted because
        // the database relationship uses ON DELETE CASCADE.

        res.status(204).send();

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Failed to delete todo",
        });
    }
});

// ============================================================
// SUBTASKS
// ============================================================

// POST /todos/:id/subtasks
app.post("/todos/:id/subtasks", async (req, res) => {
    try {
        const todoId = parseInt(req.params.id);
        const { task } = req.body;

        if (!task || !task.trim()) {
            return res.status(400).json({
                error: "Task is required",
            });
        }

        const todoResult = await pool.query(
            `
            SELECT id
            FROM todos
            WHERE id = $1 AND user_id = $2
            `,
            [todoId, req.user.id]
        );

        if (todoResult.rows.length === 0) {
            return res.status(404).json({
                message: "Todo not found",
            });
        }

        await pool.query(
            `
            INSERT INTO subtasks
                (
                    todo_id,
                    task,
                    completed
                )

            VALUES
                ($1, $2, FALSE)
            `,
            [
                todoId,
                task.trim(),
            ]
        );

        const updatedTodo = await getTodoById(todoId, req.user.id);

        res.status(201).json(updatedTodo);

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Failed to create subtask",
        });
    }
});


// PATCH /todos/:id/subtasks/:subtaskId
app.patch(
    "/todos/:id/subtasks/:subtaskId",
    async (req, res) => {
        try {
            const todoId = parseInt(req.params.id);
            const subtaskId = parseInt(req.params.subtaskId);

            const { task, completed } = req.body;

            const result = await pool.query(
                `
                UPDATE subtasks s

                SET
                    task = COALESCE($1, s.task),
                    completed = COALESCE($2, s.completed)

                FROM todos t

                WHERE s.id = $3
                AND s.todo_id = $4
                AND t.id = s.todo_id
                AND t.user_id = $5

                RETURNING s.id
                `,
                [
                    task !== undefined
                        ? task.trim()
                        : null,

                    completed !== undefined
                        ? completed
                        : null,

                    subtaskId,
                    todoId,
                    req.user.id,
                ]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({
                    message: "Subtask not found",
                });
            }

            const updatedTodo = await getTodoById(todoId, req.user.id);

            res.status(200).json(updatedTodo);

        } catch (error) {
            console.error(error);

            res.status(500).json({
                error: "Failed to update subtask",
            });
        }
    }
);


// DELETE /todos/:id/subtasks/:subtaskId
app.delete(
    "/todos/:id/subtasks/:subtaskId",
    async (req, res) => {
        try {
            const todoId = parseInt(req.params.id);
            const subtaskId = parseInt(req.params.subtaskId);

            const result = await pool.query(
                `
                DELETE FROM subtasks s

                USING todos t

                WHERE s.id = $1
                AND s.todo_id = $2
                AND t.id = s.todo_id
                AND t.user_id = $3

                RETURNING s.id
                `,
                [
                    subtaskId,
                    todoId,
                    req.user.id,
                ]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({
                    error: "Subtask not found",
                });
            }

            const updatedTodo = await getTodoById(todoId, req.user.id);

            res.status(200).json(updatedTodo);

        } catch (error) {
            console.error(error);

            res.status(500).json({
                error: "Failed to delete subtask",
            });
        }
    }
);

// ============================================================
// FILTERS
// ============================================================

// GET /completed
app.get("/completed", async (req, res) => {
    try {
        const result = await pool.query(
            `
            ${TODO_SELECT}
            WHERE t.completed = TRUE AND t.user_id = $1
            ORDER BY t.id
            `,
            [req.user.id]
        );

        res.status(200).json(result.rows);

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Failed to fetch completed todos",
        });
    }
});


// GET /active
app.get("/active", async (req, res) => {
    try {
        const result = await pool.query(
            `
            ${TODO_SELECT}
            WHERE t.completed = FALSE AND t.user_id = $1
            ORDER BY t.id
            `,
            [req.user.id]
        );

        res.status(200).json(result.rows);

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Failed to fetch active todos",
        });
    }
});



// DELETE /categories/:id/with-tasks
app.delete("/categories/:id/with-tasks", async (req, res) => {
    const client = await pool.connect();

    try {
        const id = parseInt(req.params.id);

        if (Number.isNaN(id)) {
            return res.status(400).json({
                error: "Invalid category ID",
            });
        }

        await client.query("BEGIN");

        const categoryResult = await client.query(
            `
            SELECT *
            FROM categories
            WHERE id = $1 AND user_id = $2
            `,
            [id, req.user.id]
        );

        if (categoryResult.rows.length === 0) {
            await client.query("ROLLBACK");

            return res.status(404).json({
                error: "Category not found",
            });
        }

        const category = categoryResult.rows[0];

        if (category.locked) {
            await client.query("ROLLBACK");

            return res.status(403).json({
                error: "Cannot delete a locked category",
            });
        }

        // Delete subtasks belonging to todos in this category
        await client.query(
            `
            DELETE FROM subtasks
            WHERE todo_id IN (
                SELECT id FROM todos WHERE category_id = $1 AND user_id = $2
            )
            `,
            [id, req.user.id]
        );

        // Delete the todos themselves
        await client.query(
            `
            DELETE FROM todos
            WHERE category_id = $1 AND user_id = $2
            `,
            [id, req.user.id]
        );

        // Delete the category
        await client.query(
            `
            DELETE FROM categories
            WHERE id = $1 AND user_id = $2
            `,
            [id, req.user.id]
        );

        await client.query("COMMIT");

        res.status(204).send();

    } catch (error) {
        await client.query("ROLLBACK");

        console.error(error);

        res.status(500).json({
            error: "Failed to delete category and its tasks",
        });

    } finally {
        client.release();
    }
});


// ============================================================
// REMINDERS
// ============================================================

// POST /todos/:id/reminders
app.post("/todos/:id/reminders", async (req, res) => {
    try {
        const todoId = parseInt(req.params.id);
        const { daysBefore, remindAt, timeOfDay, message } = req.body;

        if (timeOfDay !== undefined && timeOfDay !== null && !TIME_OF_DAY_RE.test(timeOfDay)) {
            return res.status(400).json({
                error: "timeOfDay must be in HH:MM format",
            });
        }

        const todoResult = await pool.query(
            `SELECT id, due_date FROM todos WHERE id = $1 AND user_id = $2`,
            [todoId, req.user.id]
        );

        if (todoResult.rows.length === 0) {
            return res.status(404).json({
                message: "Todo not found",
            });
        }

        // Custom date & time reminders work with or without a due date.
        if (remindAt) {
            const when = new Date(remindAt);

            if (Number.isNaN(when.getTime())) {
                return res.status(400).json({
                    error: "remindAt must be a valid date/time",
                });
            }

            await pool.query(
                `
                INSERT INTO task_reminders
                    (todo_id, remind_at, message, enabled)
                VALUES
                    ($1, $2, $3, TRUE)
                `,
                [todoId, when.toISOString(), message?.trim() || null]
            );
        } else {
            // The "days before" method only makes sense relative to a due date.
            if (!todoResult.rows[0].due_date) {
                return res.status(400).json({
                    error:
                        "This task has no due date — set a custom date & time reminder instead",
                });
            }

            const days = parseInt(daysBefore);

            if (Number.isNaN(days) || days < 0) {
                return res.status(400).json({
                    error: "daysBefore must be a non-negative number",
                });
            }

            await pool.query(
                `
                INSERT INTO task_reminders
                    (todo_id, days_before, time_of_day, message, enabled)
                VALUES
                    ($1, $2, $3, $4, TRUE)
                `,
                [todoId, days, timeOfDay || null, message?.trim() || null]
            );
        }

        const updatedTodo = await getTodoById(todoId, req.user.id);

        res.status(201).json(updatedTodo);

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Failed to create reminder",
        });
    }
});


// PATCH /todos/:id/reminders/:reminderId
app.patch("/todos/:id/reminders/:reminderId", async (req, res) => {
    try {
        const todoId = parseInt(req.params.id);
        const reminderId = parseInt(req.params.reminderId);
        const { daysBefore, remindAt, timeOfDay, message, enabled } = req.body;

        if (timeOfDay !== undefined && timeOfDay !== null && !TIME_OF_DAY_RE.test(timeOfDay)) {
            return res.status(400).json({
                error: "timeOfDay must be in HH:MM format",
            });
        }

        const result = await pool.query(
            `
            UPDATE task_reminders r

            SET
                days_before = COALESCE($1, r.days_before),
                remind_at = COALESCE($2, r.remind_at),
                time_of_day = COALESCE($3, r.time_of_day),
                message = CASE WHEN $4 IS NOT NULL THEN $4 ELSE r.message END,
                enabled = COALESCE($5, r.enabled)

            FROM todos t

            WHERE r.id = $6
            AND r.todo_id = $7
            AND t.id = r.todo_id
            AND t.user_id = $8

            RETURNING r.id
            `,
            [
                daysBefore !== undefined ? parseInt(daysBefore) : null,
                remindAt ? new Date(remindAt).toISOString() : null,
                timeOfDay || null,
                message !== undefined ? (message.trim() || null) : null,
                enabled !== undefined ? enabled : null,
                reminderId,
                todoId,
                req.user.id,
            ]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                message: "Reminder not found",
            });
        }

        const updatedTodo = await getTodoById(todoId, req.user.id);

        res.status(200).json(updatedTodo);

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Failed to update reminder",
        });
    }
});


// DELETE /todos/:id/reminders/:reminderId
app.delete("/todos/:id/reminders/:reminderId", async (req, res) => {
    try {
        const todoId = parseInt(req.params.id);
        const reminderId = parseInt(req.params.reminderId);

        const result = await pool.query(
            `
            DELETE FROM task_reminders r
            USING todos t
            WHERE r.id = $1
            AND r.todo_id = $2
            AND t.id = r.todo_id
            AND t.user_id = $3
            RETURNING r.id
            `,
            [reminderId, todoId, req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                error: "Reminder not found",
            });
        }

        const updatedTodo = await getTodoById(todoId, req.user.id);

        res.status(200).json(updatedTodo);

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Failed to delete reminder",
        });
    }
});

// ============================================================
// ROUTINES
// ============================================================
//
// A routine has no fixed due date — its deadline is whichever matching date
// ("occurrence") is soonest, computed client-side from today's date and the
// recurrence rule (days_of_week or days_of_month), then automatically
// rolling forward once that date passes. The server just stores the rule,
// the reminders, and which specific occurrence dates were completed
// (routine_completions) — it never computes "today" itself, since that has
// to be evaluated in the caller's own timezone, exactly like due-date-based
// reminders already are.

const ROUTINE_SELECT = `
    SELECT
        rt.id,
        rt.task,
        rt.category_id AS "categoryId",
        rt.recurrence_type AS "recurrenceType",
        rt.days_of_week AS "daysOfWeek",
        rt.days_of_month AS "daysOfMonth",
        rt.favourited,
        rt.created_at AS "createdAt",
        rt.updated_at AS "updatedAt",

        COALESCE((
            SELECT json_agg(
                json_build_object(
                    'id', r.id,
                    'daysBefore', r.days_before,
                    'remindAt', r.remind_at,
                    'timeOfDay', r.time_of_day,
                    'message', r.message,
                    'enabled', r.enabled
                )
                ORDER BY r.days_before NULLS LAST, r.remind_at
            )
            FROM routine_reminders r
            WHERE r.routine_id = rt.id
        ), '[]') AS reminders,

        COALESCE((
            SELECT json_agg(to_char(c.occurrence_date, 'YYYY-MM-DD') ORDER BY c.occurrence_date)
            FROM routine_completions c
            WHERE c.routine_id = rt.id
        ), '[]') AS "completedDates"

    FROM routines rt
`;

async function getRoutineById(id, userId) {
    const result = await pool.query(
        `${ROUTINE_SELECT} WHERE rt.id = $1 AND rt.user_id = $2`,
        [id, userId]
    );

    return result.rows[0];
}

// GET /routines
app.get("/routines", async (req, res) => {
    try {
        const { categoryId } = req.query;

        let query = `${ROUTINE_SELECT} WHERE rt.user_id = $1`;
        const values = [req.user.id];

        if (categoryId) {
            query += ` AND rt.category_id = $2`;
            values.push(parseInt(categoryId));
        }

        query += ` ORDER BY rt.id`;

        const result = await pool.query(query, values);

        res.status(200).json(result.rows);

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Failed to fetch routines",
        });
    }
});


// POST /routines
app.post("/routines", async (req, res) => {
    try {
        const { task, categoryId, recurrenceType, daysOfWeek, daysOfMonth } = req.body;

        if (!task || !task.trim()) {
            return res.status(400).json({
                error: "Task field is required",
            });
        }

        if (!["weekly", "monthly"].includes(recurrenceType)) {
            return res.status(400).json({
                error: "recurrenceType must be 'weekly' or 'monthly'",
            });
        }

        let normalizedDaysOfWeek = null;
        let normalizedDaysOfMonth = null;

        if (recurrenceType === "weekly") {
            if (!Array.isArray(daysOfWeek) || daysOfWeek.length === 0) {
                return res.status(400).json({
                    error: "daysOfWeek must be a non-empty array (0=Sunday..6=Saturday)",
                });
            }

            normalizedDaysOfWeek = daysOfWeek.map((d) => parseInt(d));

            if (normalizedDaysOfWeek.some((d) => Number.isNaN(d) || d < 0 || d > 6)) {
                return res.status(400).json({
                    error: "daysOfWeek values must be between 0 and 6",
                });
            }
        } else {
            if (!Array.isArray(daysOfMonth) || daysOfMonth.length === 0) {
                return res.status(400).json({
                    error: "daysOfMonth must be a non-empty array (1-31)",
                });
            }

            normalizedDaysOfMonth = daysOfMonth.map((d) => parseInt(d));

            if (normalizedDaysOfMonth.some((d) => Number.isNaN(d) || d < 1 || d > 31)) {
                return res.status(400).json({
                    error: "daysOfMonth values must be between 1 and 31",
                });
            }
        }

        const catId = categoryId ? parseInt(categoryId) : null;

        if (!catId) {
            return res.status(400).json({
                error: "categoryId is required",
            });
        }

        const categoryResult = await pool.query(
            `SELECT kind FROM categories WHERE id = $1 AND user_id = $2`,
            [catId, req.user.id]
        );

        if (categoryResult.rows.length === 0) {
            return res.status(400).json({
                error: "Category not found",
            });
        }

        if (categoryResult.rows[0].kind === "favourite") {
            return res.status(403).json({
                error: "Cannot add routines directly to Favourite",
            });
        }

        const result = await pool.query(
            `
            INSERT INTO routines
                (task, category_id, recurrence_type, days_of_week, days_of_month, user_id)
            VALUES
                ($1, $2, $3, $4, $5, $6)
            RETURNING id
            `,
            [
                task.trim(),
                catId,
                recurrenceType,
                normalizedDaysOfWeek,
                normalizedDaysOfMonth,
                req.user.id,
            ]
        );

        const newRoutine = await getRoutineById(result.rows[0].id, req.user.id);

        res.status(201).json(newRoutine);

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Failed to create routine",
        });
    }
});


// PATCH /routines/:id
app.patch("/routines/:id", async (req, res) => {
    try {
        const id = parseInt(req.params.id);

        if (Number.isNaN(id)) {
            return res.status(400).json({
                error: "Invalid routine ID",
            });
        }

        const existing = await pool.query(
            `SELECT * FROM routines WHERE id = $1 AND user_id = $2`,
            [id, req.user.id]
        );

        if (existing.rows.length === 0) {
            return res.status(404).json({
                message: "Routine not found",
            });
        }

        const routine = existing.rows[0];
        const { task, categoryId, favourited } = req.body;

        let newCategoryId = routine.category_id;

        if (categoryId !== undefined) {
            const catId = parseInt(categoryId);

            const categoryResult = await pool.query(
                `SELECT kind FROM categories WHERE id = $1 AND user_id = $2`,
                [catId, req.user.id]
            );

            if (categoryResult.rows.length === 0) {
                return res.status(400).json({
                    error: "Category not found",
                });
            }

            if (categoryResult.rows[0].kind === "favourite") {
                return res.status(403).json({
                    error: "Cannot move a routine to Favourite via categoryId",
                });
            }

            newCategoryId = catId;
        }

        await pool.query(
            `
            UPDATE routines
            SET
                task = $1,
                category_id = $2,
                favourited = $3
            WHERE id = $4 AND user_id = $5
            `,
            [
                task !== undefined ? task.trim() : routine.task,
                newCategoryId,
                favourited !== undefined ? favourited : routine.favourited,
                id,
                req.user.id,
            ]
        );

        const updated = await getRoutineById(id, req.user.id);

        res.status(200).json(updated);

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Failed to update routine",
        });
    }
});


// DELETE /routines/:id
app.delete("/routines/:id", async (req, res) => {
    try {
        const id = parseInt(req.params.id);

        const result = await pool.query(
            `DELETE FROM routines WHERE id = $1 AND user_id = $2 RETURNING id`,
            [id, req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                error: "Routine not found",
            });
        }

        res.status(204).send();

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Failed to delete routine",
        });
    }
});


// POST /routines/:id/complete
app.post("/routines/:id/complete", async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { occurrenceDate } = req.body;

        if (!occurrenceDate || !/^\d{4}-\d{2}-\d{2}$/.test(occurrenceDate)) {
            return res.status(400).json({
                error: "occurrenceDate must be in YYYY-MM-DD format",
            });
        }

        const routineResult = await pool.query(
            `SELECT id FROM routines WHERE id = $1 AND user_id = $2`,
            [id, req.user.id]
        );

        if (routineResult.rows.length === 0) {
            return res.status(404).json({
                message: "Routine not found",
            });
        }

        await pool.query(
            `
            INSERT INTO routine_completions (routine_id, occurrence_date)
            VALUES ($1, $2)
            ON CONFLICT (routine_id, occurrence_date) DO NOTHING
            `,
            [id, occurrenceDate]
        );

        const updated = await getRoutineById(id, req.user.id);

        res.status(200).json(updated);

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Failed to mark routine complete",
        });
    }
});


// DELETE /routines/:id/complete
app.delete("/routines/:id/complete", async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { occurrenceDate } = req.body;

        if (!occurrenceDate || !/^\d{4}-\d{2}-\d{2}$/.test(occurrenceDate)) {
            return res.status(400).json({
                error: "occurrenceDate must be in YYYY-MM-DD format",
            });
        }

        const routineResult = await pool.query(
            `SELECT id FROM routines WHERE id = $1 AND user_id = $2`,
            [id, req.user.id]
        );

        if (routineResult.rows.length === 0) {
            return res.status(404).json({
                message: "Routine not found",
            });
        }

        await pool.query(
            `
            DELETE FROM routine_completions
            WHERE routine_id = $1 AND occurrence_date = $2
            `,
            [id, occurrenceDate]
        );

        const updated = await getRoutineById(id, req.user.id);

        res.status(200).json(updated);

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Failed to undo routine completion",
        });
    }
});


// POST /routines/:id/reminders
app.post("/routines/:id/reminders", async (req, res) => {
    try {
        const routineId = parseInt(req.params.id);
        const { daysBefore, remindAt, timeOfDay, message } = req.body;

        if (timeOfDay !== undefined && timeOfDay !== null && !TIME_OF_DAY_RE.test(timeOfDay)) {
            return res.status(400).json({
                error: "timeOfDay must be in HH:MM format",
            });
        }

        const routineResult = await pool.query(
            `SELECT id FROM routines WHERE id = $1 AND user_id = $2`,
            [routineId, req.user.id]
        );

        if (routineResult.rows.length === 0) {
            return res.status(404).json({
                message: "Routine not found",
            });
        }

        if (remindAt) {
            const when = new Date(remindAt);

            if (Number.isNaN(when.getTime())) {
                return res.status(400).json({
                    error: "remindAt must be a valid date/time",
                });
            }

            await pool.query(
                `
                INSERT INTO routine_reminders
                    (routine_id, remind_at, message, enabled)
                VALUES
                    ($1, $2, $3, TRUE)
                `,
                [routineId, when.toISOString(), message?.trim() || null]
            );
        } else {
            const days = parseInt(daysBefore);

            if (Number.isNaN(days) || days < 0) {
                return res.status(400).json({
                    error: "daysBefore must be a non-negative number",
                });
            }

            await pool.query(
                `
                INSERT INTO routine_reminders
                    (routine_id, days_before, time_of_day, message, enabled)
                VALUES
                    ($1, $2, $3, $4, TRUE)
                `,
                [routineId, days, timeOfDay || null, message?.trim() || null]
            );
        }

        const updated = await getRoutineById(routineId, req.user.id);

        res.status(201).json(updated);

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Failed to create reminder",
        });
    }
});


// PATCH /routines/:id/reminders/:reminderId
app.patch("/routines/:id/reminders/:reminderId", async (req, res) => {
    try {
        const routineId = parseInt(req.params.id);
        const reminderId = parseInt(req.params.reminderId);
        const { daysBefore, remindAt, timeOfDay, message, enabled } = req.body;

        if (timeOfDay !== undefined && timeOfDay !== null && !TIME_OF_DAY_RE.test(timeOfDay)) {
            return res.status(400).json({
                error: "timeOfDay must be in HH:MM format",
            });
        }

        const result = await pool.query(
            `
            UPDATE routine_reminders r

            SET
                days_before = COALESCE($1, r.days_before),
                remind_at = COALESCE($2, r.remind_at),
                time_of_day = COALESCE($3, r.time_of_day),
                message = CASE WHEN $4 IS NOT NULL THEN $4 ELSE r.message END,
                enabled = COALESCE($5, r.enabled)

            FROM routines rt

            WHERE r.id = $6
            AND r.routine_id = $7
            AND rt.id = r.routine_id
            AND rt.user_id = $8

            RETURNING r.id
            `,
            [
                daysBefore !== undefined ? parseInt(daysBefore) : null,
                remindAt ? new Date(remindAt).toISOString() : null,
                timeOfDay || null,
                message !== undefined ? (message.trim() || null) : null,
                enabled !== undefined ? enabled : null,
                reminderId,
                routineId,
                req.user.id,
            ]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                message: "Reminder not found",
            });
        }

        const updated = await getRoutineById(routineId, req.user.id);

        res.status(200).json(updated);

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Failed to update reminder",
        });
    }
});


// DELETE /routines/:id/reminders/:reminderId
app.delete("/routines/:id/reminders/:reminderId", async (req, res) => {
    try {
        const routineId = parseInt(req.params.id);
        const reminderId = parseInt(req.params.reminderId);

        const result = await pool.query(
            `
            DELETE FROM routine_reminders r
            USING routines rt
            WHERE r.id = $1
            AND r.routine_id = $2
            AND rt.id = r.routine_id
            AND rt.user_id = $3
            RETURNING r.id
            `,
            [reminderId, routineId, req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                error: "Reminder not found",
            });
        }

        const updated = await getRoutineById(routineId, req.user.id);

        res.status(200).json(updated);

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Failed to delete reminder",
        });
    }
});

// ============================================================
// SETTINGS
// ============================================================

// GET /settings
app.get("/settings", async (req, res) => {
    try {
        const result = await pool.query(
            `
            SELECT
                notify_due_today_enabled AS "notifyDueTodayEnabled",
                default_reminder_message AS "defaultReminderMessage",
                updated_at AS "updatedAt"
            FROM app_settings
            WHERE user_id = $1
            `,
            [req.user.id]
        );

        res.status(200).json(result.rows[0]);

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Failed to fetch settings",
        });
    }
});


// PATCH /settings
app.patch("/settings", async (req, res) => {
    try {
        const { notifyDueTodayEnabled, defaultReminderMessage } = req.body;

        const result = await pool.query(
            `
            UPDATE app_settings

            SET
                notify_due_today_enabled = COALESCE($1, notify_due_today_enabled),
                default_reminder_message = COALESCE($2, default_reminder_message)

            WHERE user_id = $3

            RETURNING
                notify_due_today_enabled AS "notifyDueTodayEnabled",
                default_reminder_message AS "defaultReminderMessage",
                updated_at AS "updatedAt"
            `,
            [
                notifyDueTodayEnabled !== undefined ? notifyDueTodayEnabled : null,
                defaultReminderMessage !== undefined
                    ? defaultReminderMessage.trim()
                    : null,
                req.user.id,
            ]
        );

        res.status(200).json(result.rows[0]);

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Failed to update settings",
        });
    }
});


// GET /health
app.get("/health", (req, res) => {
    res.status(200).json({
        status: "ok",
        message: "Server is alive",
        timestamp: new Date().toISOString()
    });
});



// ============================================================
// 404 HANDLER
// ============================================================

app.use((req, res) => {
    res.status(404).json({
        error: "Endpoint not found",
    });
});

// ============================================================
// GLOBAL ERROR HANDLER
// ============================================================

app.use((err, req, res, next) => {
    console.error(err);

    res.status(500).json({
        error: "Server error!",
    });
});

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, "0.0.0.0", () => {
    console.log(`TODO API running on port ${PORT}`);
});
