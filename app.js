const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();

// ============================================================
// CONFIGURATION
// ============================================================

const PORT = process.env.PORT || 3000;

const FAVOURITE_ID = 2;

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
                    'message', r.message,
                    'enabled', r.enabled
                )
                ORDER BY r.days_before
            )
            FROM task_reminders r
            WHERE r.todo_id = t.id
        ), '[]') AS reminders

    FROM todos t
`;

async function getTodoById(id) {
    const result = await pool.query(
        `${TODO_SELECT} WHERE t.id = $1`,
        [id]
    );

    return result.rows[0];
}

// Auto-creates the default "due today" reminder for a todo, unless the
// global setting is off or the todo already has reminders (custom or
// previously auto-created) — keeps this idempotent to call after any
// insert/update that leaves the todo with a due date.
async function maybeCreateDefaultReminder(queryable, todoId) {
    const settingsResult = await queryable.query(
        `SELECT notify_due_today_enabled FROM app_settings WHERE id = 1`
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
// ROOT ROUTE
// ============================================================

app.get("/", (req, res) => {
    res.json({
        message: "RCP Todo API is running",
        status: "OK",
    });
});

// ============================================================
// CATEGORIES
// ============================================================

// GET /categories
app.get("/categories", async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                id,
                name,
                color,
                locked,
                updated_at AS "updatedAt"
            FROM categories
            ORDER BY id
        `);

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
                (name, color, locked)

            VALUES
                ($1, $2, FALSE)

            RETURNING
                id,
                name,
                color,
                locked,
                updated_at AS "updatedAt"
            `,
            [
                name.trim(),
                color || "#6366f1",
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
            WHERE id = $1
            `,
            [id]
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

        const { name, color, expectedUpdatedAt } = req.body;

        if (
            expectedUpdatedAt &&
            new Date(category.updated_at).getTime() !==
                new Date(expectedUpdatedAt).getTime()
        ) {
            return res.status(409).json({
                error: "conflict",
                server: {
                    id: category.id,
                    name: category.name,
                    color: category.color,
                    locked: category.locked,
                    updatedAt: category.updated_at,
                },
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

            WHERE id = $3

            RETURNING
                id,
                name,
                color,
                locked,
                updated_at AS "updatedAt"
            `,
            [
                updatedName,
                updatedColor,
                id,
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
            WHERE id = $1
            `,
            [id]
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

        // Move tasks to My Tasks
        await client.query(
            `
            UPDATE todos
            SET category_id = 1
            WHERE category_id = $1
            `,
            [id]
        );

        await client.query(
            `
            DELETE FROM categories
            WHERE id = $1
            `,
            [id]
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

        const values = [];

        // Favourite view
        if (
            categoryId &&
            parseInt(categoryId) === FAVOURITE_ID
        ) {
            query += `
                WHERE t.favourited = TRUE
            `;
        }

        // Normal category
        else if (categoryId) {
            query += `
                WHERE t.category_id = $1
            `;

            values.push(parseInt(categoryId));
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

        const todo = await getTodoById(id);

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
        } = req.body;

        if (!task || !task.trim()) {
            return res.status(400).json({
                error: "Task field is required",
            });
        }

        const catId = categoryId || 1;

        // Cannot add directly to Favourite
        if (parseInt(catId) === FAVOURITE_ID) {
            return res.status(403).json({
                error: "Cannot add tasks directly to Favourite",
            });
        }

        // Check category exists
        const categoryResult = await pool.query(
            `
            SELECT id
            FROM categories
            WHERE id = $1
            `,
            [catId]
        );

        if (categoryResult.rows.length === 0) {
            return res.status(400).json({
                error: "Category not found",
            });
        }

        const result = await pool.query(
            `
            INSERT INTO todos
                (
                    task,
                    completed,
                    due_date,
                    category_id,
                    favourited
                )

            VALUES
                ($1, FALSE, $2, $3, FALSE)

            RETURNING id
            `,
            [
                task.trim(),
                dueDate || null,
                catId,
            ]
        );

        const newTodoId = result.rows[0].id;

        if (dueDate) {
            await maybeCreateDefaultReminder(pool, newTodoId);
        }

        const newTodo = await getTodoById(newTodoId);

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
            WHERE id = $1
            `,
            [id]
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
            expectedUpdatedAt,
        } = req.body;

        if (
            expectedUpdatedAt &&
            new Date(todo.updated_at).getTime() !==
                new Date(expectedUpdatedAt).getTime()
        ) {
            const currentTodo = await getTodoById(id);

            return res.status(409).json({
                error: "conflict",
                server: currentTodo,
            });
        }

        let newCategoryId = todo.category_id;

        // Category update
        if (categoryId !== undefined) {

            if (parseInt(categoryId) === FAVOURITE_ID) {
                return res.status(403).json({
                    error: "Cannot move a task to Favourite via categoryId",
                });
            }

            const categoryResult = await pool.query(
                `
                SELECT id
                FROM categories
                WHERE id = $1
                `,
                [categoryId]
            );

            if (categoryResult.rows.length === 0) {
                return res.status(400).json({
                    error: "Category not found",
                });
            }

            newCategoryId = categoryId;
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

            WHERE id = $6

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
            ]
        );

        const finalDueDate =
            dueDate !== undefined ? dueDate : todo.due_date;

        if (finalDueDate) {
            await maybeCreateDefaultReminder(pool, result.rows[0].id);
        }

        const updatedTodo = await getTodoById(
            result.rows[0].id
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

            WHERE id = $1

            RETURNING id
            `,
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                message: "Todo not found",
            });
        }

        const updatedTodo = await getTodoById(id);

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
            WHERE id = $1
            RETURNING id
            `,
            [id]
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
            WHERE id = $1
            `,
            [todoId]
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

        const updatedTodo = await getTodoById(todoId);

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
                UPDATE subtasks

                SET
                    task = COALESCE($1, task),
                    completed = COALESCE($2, completed)

                WHERE id = $3
                AND todo_id = $4

                RETURNING id
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
                ]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({
                    message: "Subtask not found",
                });
            }

            const updatedTodo = await getTodoById(todoId);

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
                DELETE FROM subtasks

                WHERE id = $1
                AND todo_id = $2

                RETURNING id
                `,
                [
                    subtaskId,
                    todoId,
                ]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({
                    error: "Subtask not found",
                });
            }

            const updatedTodo = await getTodoById(todoId);

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
        const result = await pool.query(`
            ${TODO_SELECT}
            WHERE t.completed = TRUE
            ORDER BY t.id
        `);

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
        const result = await pool.query(`
            ${TODO_SELECT}
            WHERE t.completed = FALSE
            ORDER BY t.id
        `);

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
            WHERE id = $1
            `,
            [id]
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
                SELECT id FROM todos WHERE category_id = $1
            )
            `,
            [id]
        );

        // Delete the todos themselves
        await client.query(
            `
            DELETE FROM todos
            WHERE category_id = $1
            `,
            [id]
        );

        // Delete the category
        await client.query(
            `
            DELETE FROM categories
            WHERE id = $1
            `,
            [id]
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
        const { daysBefore, message } = req.body;

        const todoResult = await pool.query(
            `SELECT id, due_date FROM todos WHERE id = $1`,
            [todoId]
        );

        if (todoResult.rows.length === 0) {
            return res.status(404).json({
                message: "Todo not found",
            });
        }

        if (!todoResult.rows[0].due_date) {
            return res.status(400).json({
                error: "Task must have a due date to add a reminder",
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
                (todo_id, days_before, message, enabled)
            VALUES
                ($1, $2, $3, TRUE)
            `,
            [todoId, days, message?.trim() || null]
        );

        const updatedTodo = await getTodoById(todoId);

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
        const { daysBefore, message, enabled } = req.body;

        const result = await pool.query(
            `
            UPDATE task_reminders

            SET
                days_before = COALESCE($1, days_before),
                message = CASE WHEN $2 IS NOT NULL THEN $2 ELSE message END,
                enabled = COALESCE($3, enabled)

            WHERE id = $4
            AND todo_id = $5

            RETURNING id
            `,
            [
                daysBefore !== undefined ? parseInt(daysBefore) : null,
                message !== undefined ? (message.trim() || null) : null,
                enabled !== undefined ? enabled : null,
                reminderId,
                todoId,
            ]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                message: "Reminder not found",
            });
        }

        const updatedTodo = await getTodoById(todoId);

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
            DELETE FROM task_reminders
            WHERE id = $1
            AND todo_id = $2
            RETURNING id
            `,
            [reminderId, todoId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                error: "Reminder not found",
            });
        }

        const updatedTodo = await getTodoById(todoId);

        res.status(200).json(updatedTodo);

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
        const result = await pool.query(`
            SELECT
                notify_due_today_enabled AS "notifyDueTodayEnabled",
                default_reminder_message AS "defaultReminderMessage",
                updated_at AS "updatedAt"
            FROM app_settings
            WHERE id = 1
        `);

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

            WHERE id = 1

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