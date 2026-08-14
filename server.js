const express = require('express');
const { Resend } = require('resend');
const path = require('path');
const cors = require('cors');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const fs = require("fs");
dotenv.config();
const resend = new Resend(process.env.RESEND_API_KEY);
const app = express();
const port = process.env.PORT || 5000;

const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'it-support.db');
const dbDir = path.dirname(dbPath);

if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);
app.disable('x-powered-by');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'User'
  );

  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    name TEXT NOT NULL,
    department TEXT NOT NULL,
    problem TEXT NOT NULL,
    priority TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Open',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME
  );
`);

const ticketColumns = db.prepare("PRAGMA table_info(tickets)").all().map(c => c.name);
if (!ticketColumns.includes('user_id')) {
  db.exec('ALTER TABLE tickets ADD COLUMN user_id INTEGER');
}

const adminEmail = process.env.ADMIN_EMAIL;
const adminPassword = process.env.ADMIN_PASSWORD;
const existingAdmin = (adminEmail && adminPassword)
  ? db.prepare('SELECT id, password FROM users WHERE email = ?').get(adminEmail)
  : null;
if (adminEmail && adminPassword) {
  if (!existingAdmin) {
    const hashedPassword = bcrypt.hashSync(adminPassword, 10);
    db.prepare('INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)')
      .run('System Administrator', adminEmail, hashedPassword, 'Admin');
  } else if (!bcrypt.compareSync(adminPassword, existingAdmin.password)) {
    const hashedPassword = bcrypt.hashSync(adminPassword, 10);
    db.prepare('UPDATE users SET password = ?, role = ? WHERE email = ?').run(hashedPassword, 'Admin', adminEmail);
  }
}

console.log(
  adminEmail
    ? `Admin account configured: ${adminEmail}`
    : 'ADMIN_EMAIL is not configured'
);
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

function getJwtSecret() {
  return process.env.JWT_SECRET || 'it_support_system_secret_2026';
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: 'Authentication token is required' });
  }

  try {
    req.user = jwt.verify(token, getJwtSecret());
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
}

function serializeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role
  };
}

function serializeTicket(ticket) {
  if (!ticket) return null;

  return {
    ...ticket,
    id: String(ticket.id),
    date: ticket.created_at ? new Date(ticket.created_at).toLocaleString() : '',
    createdAt: ticket.created_at ? new Date(ticket.created_at).getTime() : null,
    resolvedAt: ticket.resolved_at ? new Date(ticket.resolved_at).getTime() : null
  };
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const token = jwt.sign({ id: user.id, name: user.name, email: user.email, role: user.role }, getJwtSecret(), { expiresIn: '1d' });

    res.json({
      message: 'Login successful',
      token,
      user: serializeUser(user)
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Server error during login' });
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Name, email and password are required' });
    }

    const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existingUser) {
      return res.status(400).json({ message: 'Email is already registered' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    // Public registration can only create standard user accounts.
    const normalizedRole = 'User';
    const result = db.prepare('INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)')
      .run(name, email, hashedPassword, normalizedRole);

    const user = serializeUser({ id: result.lastInsertRowid, name, email, role: normalizedRole });
    const token = jwt.sign({ id: user.id, name: user.name, email: user.email, role: user.role }, getJwtSecret(), { expiresIn: '1d' });

    res.status(201).json({ message: 'Registration successful', token, user });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ message: 'Server error during registration' });
  }
});

app.get('/api/tickets', authMiddleware, (req, res) => {
  try {
    const query = req.user.role === 'Admin'
      ? 'SELECT * FROM tickets ORDER BY created_at DESC'
      : 'SELECT * FROM tickets WHERE user_id = ? ORDER BY created_at DESC';
    const rows = req.user.role === 'Admin'
      ? db.prepare(query).all()
      : db.prepare(query).all(req.user.id);
    const tickets = rows.map(serializeTicket);
    res.json(tickets);
  } catch (error) {
    console.error('Get tickets error:', error);
    res.status(500).json({ message: 'Failed to retrieve tickets' });
  }
});
app.post('/api/tickets', authMiddleware, async (req, res) => {
  try {
    const { name, department, problem, priority } = req.body;

    if (!name || !department || !problem || !priority) {
      return res.status(400).json({ message: 'All ticket fields are required' });
    }

    const validPriorities = ['Low', 'Medium', 'High'];
    if (!validPriorities.includes(priority)) {
      return res.status(400).json({ message: 'Invalid priority' });
    }

    const result = db.prepare(`
  INSERT INTO tickets
  (user_id, name, department, problem, priority, status)
  VALUES (?, ?, ?, ?, ?, 'Open')
`).run(
  req.user.id,
  req.user.name,
  department,
  problem,
  priority
);
const ticketId = result.lastInsertRowid;
    try {
      await resend.emails.send({
        from: 'Systems Support <onboarding@resend.dev>',
        to: process.env.ADMIN_EMAIL,
        subject: `🚨 New IT Support Ticket #${ticketId} - ${priority} Priority`,
        html: `
          <h2>🚨 New IT Support Ticket</h2>

          <p><strong>Ticket:</strong> #${ticketId}</p>
          <p><strong>Employee:</strong> ${req.user.name}</p>
          <p><strong>Department:</strong> ${department}</p>
          <p><strong>Priority:</strong> ${priority}</p>
          <p><strong>Status:</strong> Open</p>

          <h3>Problem Reported</h3>
          <p>${problem}</p>

          <hr>

          <p>
            Please log in to the Systems Support dashboard
            to review and manage this ticket.
          </p>
        `
      });

      console.log(`Email alert sent for ticket #${ticketId}`);
    } catch (emailError) {
      console.error('Email notification failed:', emailError);
    }
    const ticket = serializeTicket(db.prepare('SELECT * FROM tickets WHERE id = ?').get(result.lastInsertRowid));
    res.status(201).json(ticket);
  } catch (error) {
    console.error('Create ticket error:', error);
    res.status(500).json({ message: 'Failed to create ticket' });
  }
});

app.put('/api/tickets/:id/status', authMiddleware, (req, res) => {
  try {
    if (req.user.role !== 'Admin') {
      return res.status(403).json({ message: 'Administrator access is required' });
    }
    const { id } = req.params;
    const { status } = req.body;
    const validStatuses = ['Open', 'In Progress', 'Resolved'];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    let result;
    if (status === 'Resolved') {
      result = db.prepare('UPDATE tickets SET status = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, id);
    } else {
      result = db.prepare('UPDATE tickets SET status = ?, resolved_at = NULL WHERE id = ?').run(status, id);
    }

    if (result.changes === 0) {
      return res.status(404).json({ message: 'Ticket not found' });
    }

    const ticket = serializeTicket(db.prepare('SELECT * FROM tickets WHERE id = ?').get(id));
    res.json(ticket);
  } catch (error) {
    console.error('Update status error:', error);
    res.status(500).json({ message: 'Failed to update ticket' });
  }
});

app.delete('/api/tickets/:id', authMiddleware, (req, res) => {
  try {
    if (req.user.role !== 'Admin') {
      return res.status(403).json({ message: 'Administrator access is required' });
    }
    const { id } = req.params;
    const result = db.prepare('DELETE FROM tickets WHERE id = ?').run(id);

    if (result.changes === 0) {
      return res.status(404).json({ message: 'Ticket not found' });
    }

    res.json({ message: 'Ticket deleted successfully' });
  } catch (error) {
    console.error('Delete ticket error:', error);
    res.status(500).json({ message: 'Failed to delete ticket' });
  }
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
