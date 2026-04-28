const express = require('express');
require("dotenv").config();
const app = express();
app.use(express.json());
const cors = require("cors");
app.use(cors());

const FAVOURITE_ID = 2; // locked category

let categories = [
  { id: 1, name: 'My Tasks', color: '#6366f1', locked: false },
  { id: FAVOURITE_ID, name: 'Favourite', color: '#f59e0b', locked: true },
];

let todos = [
  { id: 1, task: 'Learn Node.js', completed: false, dueDate: null, categoryId: 1, subtasks: [], favourited: false },
  { id: 2, task: 'Build CRUD API', completed: false, dueDate: null, categoryId: 1, subtasks: [], favourited: false },
];

let nextTodoId = 3;
let nextCategoryId = 3;
let nextSubtaskId = 100;

// ─── CATEGORIES ────────────────────────────────────────────────

app.get('/categories', (req, res) => {
  res.status(200).json(categories);
});

app.post('/categories', (req, res) => {
  const { name, color } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Category name is required' });
  const newCategory = { id: nextCategoryId++, name: name.trim(), color: color || '#6366f1', locked: false };
  categories.push(newCategory);
  res.status(201).json(newCategory);
});

app.patch('/categories/:id', (req, res) => {
  const category = categories.find((c) => c.id === parseInt(req.params.id));
  if (!category) return res.status(404).json({ message: 'Category not found' });
  if (category.locked) return res.status(403).json({ error: 'Cannot modify a locked category' });
  Object.assign(category, req.body);
  res.status(200).json(category);
});

app.delete('/categories/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const category = categories.find((c) => c.id === id);
  if (!category) return res.status(404).json({ error: 'Not found' });
  if (category.locked) return res.status(403).json({ error: 'Cannot delete a locked category' });
  categories = categories.filter((c) => c.id !== id);
  todos.forEach((t) => { if (t.categoryId === id) t.categoryId = 1; });
  res.status(204).send();
});

// ─── TODOS ──────────────────────────────────────────────────────

app.get('/todos', (req, res) => {
  const { categoryId } = req.query;
  // "Favourite" view: return all favourited todos
  if (categoryId && parseInt(categoryId) === FAVOURITE_ID) {
    return res.status(200).json(todos.filter((t) => t.favourited));
  }
  if (categoryId) {
    return res.status(200).json(todos.filter((t) => t.categoryId === parseInt(categoryId)));
  }
  res.status(200).json(todos);
});

app.get('/todos/:id', (req, res) => {
  const todo = todos.find((t) => t.id === parseInt(req.params.id));
  if (!todo) return res.status(404).json({ message: 'Todo not found' });
  res.status(200).json(todo);
});

app.post('/todos', (req, res) => {
  const { task, dueDate, categoryId } = req.body;
  if (!task || !task.trim()) return res.status(400).json({ error: 'Task field is required' });
  // Cannot add directly to Favourite
  const catId = categoryId || 1;
  if (catId === FAVOURITE_ID) return res.status(403).json({ error: 'Cannot add tasks directly to Favourite' });
  const newTodo = { id: nextTodoId++, task: task.trim(), completed: false, dueDate: dueDate || null, categoryId: catId, subtasks: [], favourited: false };
  todos.push(newTodo);
  res.status(201).json(newTodo);
});

app.patch('/todos/:id', (req, res) => {
  const todo = todos.find((t) => t.id === parseInt(req.params.id));
  if (!todo) return res.status(404).json({ message: 'Todo not found' });
  const { subtasks, categoryId, ...rest } = req.body;
  // Cannot move a task to Favourite via categoryId
  if (categoryId !== undefined && categoryId !== FAVOURITE_ID) {
    todo.categoryId = categoryId;
  }
  Object.assign(todo, rest);
  if (subtasks !== undefined) todo.subtasks = subtasks;
  res.status(200).json(todo);
});

// PATCH toggle favourite
app.patch('/todos/:id/favourite', (req, res) => {
  const todo = todos.find((t) => t.id === parseInt(req.params.id));
  if (!todo) return res.status(404).json({ message: 'Todo not found' });
  todo.favourited = !todo.favourited;
  res.status(200).json(todo);
});

app.delete('/todos/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const initial = todos.length;
  todos = todos.filter((t) => t.id !== id);
  if (todos.length === initial) return res.status(404).json({ error: 'Not found' });
  res.status(204).send();
});

// ─── SUBTASKS ───────────────────────────────────────────────────

app.post('/todos/:id/subtasks', (req, res) => {
  const todo = todos.find((t) => t.id === parseInt(req.params.id));
  if (!todo) return res.status(404).json({ message: 'Todo not found' });
  const { task } = req.body;
  if (!task || !task.trim()) return res.status(400).json({ error: 'Task is required' });
  const subtask = { id: nextSubtaskId++, task: task.trim(), completed: false };
  todo.subtasks.push(subtask);
  res.status(201).json(todo);
});

app.patch('/todos/:id/subtasks/:subtaskId', (req, res) => {
  const todo = todos.find((t) => t.id === parseInt(req.params.id));
  if (!todo) return res.status(404).json({ message: 'Todo not found' });
  const subtask = todo.subtasks.find((s) => s.id === parseInt(req.params.subtaskId));
  if (!subtask) return res.status(404).json({ message: 'Subtask not found' });
  Object.assign(subtask, req.body);
  res.status(200).json(todo);
});

app.delete('/todos/:id/subtasks/:subtaskId', (req, res) => {
  const todo = todos.find((t) => t.id === parseInt(req.params.id));
  if (!todo) return res.status(404).json({ message: 'Todo not found' });
  const initial = todo.subtasks.length;
  todo.subtasks = todo.subtasks.filter((s) => s.id !== parseInt(req.params.subtaskId));
  if (todo.subtasks.length === initial) return res.status(404).json({ error: 'Not found' });
  res.status(200).json(todo);
});

// ─── FILTERS ────────────────────────────────────────────────────

app.get('/completed', (req, res) => res.json(todos.filter((t) => t.completed)));
app.get('/active', (req, res) => res.json(todos.filter((t) => !t.completed)));

app.use((err, req, res, next) => { res.status(500).json({ error: 'Server error!' }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server on port ${PORT}`));
