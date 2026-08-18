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
    category TEXT NOT NULL DEFAULT 'General Support',
    problem TEXT NOT NULL,
    priority TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Open',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME
  );
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS ticket_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    description TEXT NOT NULL,
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  );
`);
const ticketColumns = db.prepare("PRAGMA table_info(tickets)").all().map(c => c.name);

if (!ticketColumns.includes('user_id')) {
  db.exec('ALTER TABLE tickets ADD COLUMN user_id INTEGER');
}

if (!ticketColumns.includes('assigned_to')) {
  db.exec('ALTER TABLE tickets ADD COLUMN assigned_to INTEGER');
}

if (!ticketColumns.includes('category')) {
  db.exec("ALTER TABLE tickets ADD COLUMN category TEXT NOT NULL DEFAULT 'General Support'");
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

let developmentSecretWarningShown = false;

function getJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be configured in production');
  }
  if (!developmentSecretWarningShown) {
    console.warn('Using a development-only JWT secret. Set JWT_SECRET before deployment.');
    developmentSecretWarningShown = true;
  }
  // Keep the existing local-development secret so current local sessions continue working.
  return 'it_support_system_secret_2026';
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
    const { email, password, portalRole } = req.body;

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

    if (portalRole && user.role !== portalRole) {
      return res.status(403).json({ message: `Please use the ${user.role === 'Admin' ? 'Administrator' : 'User'} Portal for this account` });
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
    const { name, email, password, role, adminRegistrationKey } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Name, email and password are required' });
    }

    if (name.trim().length < 2 || name.trim().length > 80 || password.length < 8) {
      return res.status(400).json({ message: 'Use a name between 2 and 80 characters and a password of at least 8 characters' });
    }

    const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existingUser) {
      return res.status(400).json({ message: 'Email is already registered' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const isAdminRegistration = role === 'Admin';
    if (isAdminRegistration && (!process.env.ADMIN_REGISTRATION_KEY || adminRegistrationKey !== process.env.ADMIN_REGISTRATION_KEY)) {
      return res.status(403).json({ message: 'A valid administrator registration key is required' });
    }

    const normalizedRole = isAdminRegistration ? 'Admin' : 'User';
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

app.get('/api/users/support', authMiddleware, (req, res) => {
  try {
    if (req.user.role !== 'Admin') {
      return res.status(403).json({
        message: 'Administrator access is required'
      });
    }

    const users = db.prepare(`
      SELECT id, name, email, role
      FROM users
      WHERE role IN ('User', 'Support')
      ORDER BY name ASC
    `).all();

    res.json(users);
  } catch (error) {
    console.error('Get support users error:', error);
    res.status(500).json({
      message: 'Failed to retrieve support users'
    });
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
    const { name, department, category, problem, priority } = req.body;

    if (!name || !department || !category || !problem || !priority) {
      return res.status(400).json({ message: 'All ticket fields are required' });
    }

    if (problem.trim().length < 10 || problem.trim().length > 2000) {
      return res.status(400).json({ message: 'Describe the issue using between 10 and 2,000 characters' });
    }

    const validPriorities = ['Low', 'Medium', 'High'];
    if (!validPriorities.includes(priority)) {
      return res.status(400).json({ message: 'Invalid priority' });
    }

    const validCategories = ['Hardware', 'Software', 'Network', 'Access & Account', 'Email & Collaboration', 'General Support'];
    if (!validCategories.includes(category)) {
      return res.status(400).json({ message: 'Invalid ticket category' });
    }

    const result = db.prepare(`
  INSERT INTO tickets
  (user_id, name, department, category, problem, priority, status)
  VALUES (?, ?, ?, ?, ?, ?, 'Open')
`).run(
  req.user.id,
  req.user.name,
  department,
  category,
  problem,
  priority
);
const ticketId = result.lastInsertRowid;
db.prepare(`
  INSERT INTO ticket_events
  (ticket_id, event_type, description, created_by)
  VALUES (?, ?, ?, ?)
`).run(
  ticketId,
  'Ticket Created',
  `Ticket submitted by ${req.user.name}`,
  req.user.id
);
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
          <p><strong>Category:</strong> ${category}</p>
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
db.prepare(`
  INSERT INTO ticket_events
  (ticket_id, event_type, description, created_by)
  VALUES (?, ?, ?, ?)
`).run(
  id,
  'Status Changed',
  `Ticket status changed to ${status}`,
  req.user.id
);
    const ticket = serializeTicket(db.prepare('SELECT * FROM tickets WHERE id = ?').get(id));
    res.json(ticket);
  } catch (error) {
    console.error('Update status error:', error);
    res.status(500).json({ message: 'Failed to update ticket' });
  }
});
app.get('/api/tickets/:id/events', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;

    const ticket = db.prepare(
      'SELECT * FROM tickets WHERE id = ?'
    ).get(id);

    if (!ticket) {
      return res.status(404).json({
        message: 'Ticket not found'
      });
    }

    if (
      req.user.role !== 'Admin' &&
      ticket.user_id !== req.user.id
    ) {
      return res.status(403).json({
        message: 'You are not authorized to view this ticket'
      });
    }

    const events = db.prepare(`
      SELECT
        ticket_events.id,
        ticket_events.ticket_id,
        ticket_events.event_type,
        ticket_events.description,
        ticket_events.created_at,
        users.name AS created_by_name
      FROM ticket_events
      LEFT JOIN users
        ON ticket_events.created_by = users.id
      WHERE ticket_events.ticket_id = ?
      ORDER BY ticket_events.created_at ASC
    `).all(id);

    res.json(events);

  } catch (error) {
    console.error('Get ticket events error:', error);

    res.status(500).json({
      message: 'Failed to retrieve ticket events'
    });
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
// =====================================================
// DOWNLOAD TICKET AS PDF
// =====================================================

app.get('/api/tickets/:id/pdf', authMiddleware, (req, res) => {
  try {
    const PDFDocument = require('pdfkit');

    const ticket = db.prepare(`
      SELECT tickets.*, users.name AS requester_name
      FROM tickets
      LEFT JOIN users ON tickets.user_id = users.id
      WHERE tickets.id = ?
    `).get(req.params.id);

    if (!ticket) {
      return res.status(404).json({
        message: 'Ticket not found'
      });
    }

    // Users can only download their own tickets.
    // Admins can download any ticket.
    if (
      req.user.role !== 'Admin' &&
      ticket.user_id !== req.user.id
    ) {
      return res.status(403).json({
        message: 'You are not authorized to download this ticket'
      });
    }

    const doc = new PDFDocument({
      size: 'A4',
      margin: 50
    });

    const filename = `Systems-Support-Ticket-${ticket.id}.pdf`;

    res.setHeader(
      'Content-Type',
      'application/pdf'
    );

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"`
    );

    doc.pipe(res);

    const pageWidth = 595;
    const contentWidth = 495;
    const priorityColors = { High: '#dc2626', Medium: '#d97706', Low: '#16a34a' };
    const statusColors = { Resolved: '#16a34a', 'In Progress': '#d97706', Open: '#2563eb' };
    const formatDate = (value) => value ? new Date(value).toLocaleString() : 'Not yet resolved';
    const drawInfoCard = (x, y, label, value) => {
      doc.roundedRect(x, y, 238, 58, 8).fill('#f8fafc');
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#64748b').text(label.toUpperCase(), x + 14, y + 12);
      doc.font('Helvetica').fontSize(11).fillColor('#0f172a').text(String(value || 'Not available'), x + 14, y + 27, { width: 208, ellipsis: true });
    };
    const drawPill = (text, x, y, color) => {
      const width = Math.max(74, doc.font('Helvetica-Bold').fontSize(8).widthOfString(text) + 24);
      doc.roundedRect(x, y, width, 23, 11).fill(color);
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#ffffff').text(text.toUpperCase(), x, y + 8, { width, align: 'center' });
      return width;
    };

    // Branded document header
    doc.rect(0, 0, pageWidth, 146).fill('#0b1f3a');
    doc.circle(540, 22, 78).fill('#173b69');
    doc.circle(575, 105, 54).fill('#2563eb');
    doc.roundedRect(50, 38, 42, 42, 10).fill('#38bdf8');
    doc.font('Helvetica-Bold').fontSize(20).fillColor('#ffffff').text('S', 50, 51, { width: 42, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(22).fillColor('#ffffff').text('SYSTEMS SUPPORT', 106, 39);
    doc.font('Helvetica').fontSize(10).fillColor('#bfdbfe').text('PROFESSIONAL IT SERVICE DESK', 107, 67);
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#93c5fd').text('SERVICE REQUEST', 50, 108);
    doc.font('Helvetica-Bold').fontSize(22).fillColor('#ffffff').text(`#TKT-${String(ticket.id).padStart(4, '0')}`, 50, 120);

    doc.font('Helvetica-Bold').fontSize(9).fillColor('#64748b').text('TICKET SUMMARY', 50, 177);
    doc.font('Helvetica-Bold').fontSize(19).fillColor('#0f172a').text(ticket.problem, 50, 194, { width: contentWidth, height: 50, ellipsis: true });
    const statusWidth = drawPill(ticket.status, 50, 255, statusColors[ticket.status] || '#2563eb');
    drawPill(`${ticket.priority} priority`, 62 + statusWidth, 255, priorityColors[ticket.priority] || '#64748b');

    drawInfoCard(50, 301, 'Requester', ticket.requester_name || ticket.name);
    drawInfoCard(307, 301, 'Department', ticket.department);
    drawInfoCard(50, 373, 'Created', formatDate(ticket.created_at));
    drawInfoCard(307, 373, 'Resolved', formatDate(ticket.resolved_at));
    drawInfoCard(50, 445, 'Category', ticket.category || 'General Support');

    doc.roundedRect(50, 537, contentWidth, 145, 10).fill('#ffffff').strokeColor('#dbe3ec').lineWidth(1).stroke();
    doc.roundedRect(50, 537, 5, 145, 3).fill('#2563eb');
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#2563eb').text('ISSUE DESCRIPTION', 75, 561);
    doc.font('Helvetica').fontSize(11).fillColor('#334155').text(ticket.problem, 75, 587, { width: 440, height: 68, lineGap: 5, ellipsis: true });

    doc.moveTo(50, 738).lineTo(545, 738).strokeColor('#dbe3ec').lineWidth(1).stroke();
    doc.font('Helvetica').fontSize(8).fillColor('#64748b').text('Systems Support Service Desk  •  Confidential support record', 50, 752);
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#2563eb').text(`Generated ${new Date().toLocaleDateString()}`, 50, 752, { width: contentWidth, align: 'right' });

    doc.end();

  } catch (error) {
    console.error('Generate ticket PDF error:', error);

    if (!res.headersSent) {
      res.status(500).json({
        message: 'Failed to generate ticket PDF'
      });
    }
  }
});
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
