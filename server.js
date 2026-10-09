require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt  = require('bcryptjs');
const Database = require('better-sqlite3');
const path = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── DATABASE SETUP ────────────────────────────────────
const db = new Database(path.join(__dirname, 'theater.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS distributors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    distributor_id INTEGER NOT NULL,
    show_id INTEGER NOT NULL DEFAULT 1,
    type TEXT NOT NULL,
    row_num INTEGER NOT NULL,
    count INTEGER NOT NULL,
    price INTEGER NOT NULL,
    total INTEGER NOT NULL,
    sold_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (distributor_id) REFERENCES distributors(id)
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    distributor_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    note TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (distributor_id) REFERENCES distributors(id)
  );

  CREATE TABLE IF NOT EXISTS payment_tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payment_id INTEGER NOT NULL,
    ticket_id INTEGER NOT NULL,
    sold_count INTEGER NOT NULL,
    FOREIGN KEY (payment_id) REFERENCES payments(id),
    FOREIGN KEY (ticket_id) REFERENCES tickets(id)
  );
`);

// Add show_id column if upgrading from old DB (safe to run multiple times)
try { db.exec(`ALTER TABLE tickets ADD COLUMN show_id INTEGER NOT NULL DEFAULT 1`); } catch(e) {}

// Shows config (fixed, no DB table needed)
const SHOWS = {
  1: { id: 1, name: 'عرض الخميس',  date: '2026-04-02', label: 'الخميس 2 أبريل 2026' },
  2: { id: 2, name: 'عرض الجمعة', date: '2026-04-03', label: 'الجمعة 3 أبريل 2026' }
};

// ── MIDDLEWARE ────────────────────────────────────────
app.set('trust proxy', 1); // trust nginx reverse proxy
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'theater-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // HTTPS only in production
    httpOnly: true,
    maxAge: 8 * 60 * 60 * 1000 // 8 hours
  }
}));

// Serve public pages (no auth needed)
app.use(express.static(path.join(__dirname, 'public')));

// Serve admin pages (protected)
function requireAuth(req, res, next) {
  if (req.session && req.session.admin) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── PUBLIC ROUTES ─────────────────────────────────────

// Return list of shows
app.get('/api/shows', (req, res) => {
  res.json(Object.values(SHOWS));
});

// Public seat map data filtered by show_id
app.get('/api/seatmap', (req, res) => {
  const show_id = parseInt(req.query.show_id) || 1;
  const rows = [
    {row:1,seats:13},{row:2,seats:14},{row:3,seats:15},{row:4,seats:14},
    {row:5,seats:15},{row:6,seats:14},{row:7,seats:15},{row:8,seats:14},
    {row:9,seats:13},{row:10,seats:14},{row:11,seats:15},{row:12,seats:14},
    {row:13,seats:15},{row:14,seats:14},{row:15,seats:13},{row:16,seats:13},
    {row:17,seats:13},{row:18,seats:12},{row:19,seats:11},{row:20,seats:10}
  ];

  const soldByRow = db.prepare(`
    SELECT row_num, SUM(sold_count) as sold
    FROM tickets
    WHERE show_id = ?
    GROUP BY row_num
  `).all(show_id);

  const soldMap = {};
  soldByRow.forEach(r => soldMap[r.row_num] = r.sold);

  const result = rows.map(r => ({
    row: r.row,
    seats: r.seats,
    sold: soldMap[r.row] || 0,
    isGold: r.row <= 8
  }));

  res.json(result);
});

// ── AUTH ROUTES ───────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
  if (password === adminPass) {
    req.session.admin = true;
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'كلمة المرور غلط' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  res.json({ admin: !!req.session.admin });
});

// ── ADMIN API ROUTES ──────────────────────────────────

// Get all distributors with stats (optionally filter tickets by show_id)
app.get('/api/admin/distributors', requireAuth, (req, res) => {
  const show_id = req.query.show_id ? parseInt(req.query.show_id) : null;
  const dists = db.prepare('SELECT * FROM distributors ORDER BY created_at DESC').all();
  const result = dists.map(d => {
    // Always return ALL tickets so payment section can see tickets from both shows
    const tickets = show_id
      ? db.prepare('SELECT * FROM tickets WHERE distributor_id = ? AND show_id = ?').all(d.id, show_id)
      : db.prepare('SELECT * FROM tickets WHERE distributor_id = ?').all(d.id);

    const payments = db.prepare(`
      SELECT p.*, GROUP_CONCAT(pt.ticket_id||':'||pt.sold_count) as ticket_sales
      FROM payments p
      LEFT JOIN payment_tickets pt ON pt.payment_id = p.id
      WHERE p.distributor_id = ?
      GROUP BY p.id
      ORDER BY p.created_at DESC
    `).all(d.id);

    const paymentsFormatted = payments.map(p => ({
      ...p,
      ticketsSold: p.ticket_sales ? p.ticket_sales.split(',').map(ts => {
        const [tid, cnt] = ts.split(':');
        return { ticketId: parseInt(tid), count: parseInt(cnt) };
      }) : []
    }));

    return { ...d, tickets, payments: paymentsFormatted };
  });
  res.json(result);
});

// Add distributor
app.post('/api/admin/distributors', requireAuth, (req, res) => {
  const { name, phone } = req.body;
  if (!name) return res.status(400).json({ error: 'الاسم مطلوب' });
  const stmt = db.prepare('INSERT INTO distributors (name, phone) VALUES (?, ?)');
  const info = stmt.run(name, phone || '');
  res.json({ id: info.lastInsertRowid, name, phone });
});

// Delete distributor
app.delete('/api/admin/distributors/:id', requireAuth, (req, res) => {
  const id = req.params.id;
  db.prepare('DELETE FROM payment_tickets WHERE ticket_id IN (SELECT id FROM tickets WHERE distributor_id = ?)').run(id);
  db.prepare('DELETE FROM tickets WHERE distributor_id = ?').run(id);
  db.prepare('DELETE FROM payments WHERE distributor_id = ?').run(id);
  db.prepare('DELETE FROM distributors WHERE id = ?').run(id);
  res.json({ ok: true });
});

// Add tickets to distributor
app.post('/api/admin/tickets', requireAuth, (req, res) => {
  const { distributor_id, show_id, type, row_num, count } = req.body;
  if (!distributor_id || !type || !row_num || !count) return res.status(400).json({ error: 'بيانات ناقصة' });
  const sid = parseInt(show_id) || 1;
  const price = type === 'gold' ? 150 : 100;
  const total = price * count;
  const stmt = db.prepare('INSERT INTO tickets (distributor_id, show_id, type, row_num, count, price, total) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const info = stmt.run(distributor_id, sid, type, row_num, count, price, total);
  res.json({ id: info.lastInsertRowid });
});

// Edit ticket count (reduce or increase — cannot go below sold_count)
app.patch('/api/admin/tickets/:id', requireAuth, (req, res) => {
  const id = req.params.id;
  const { count } = req.body;
  if (!count || count < 1) return res.status(400).json({ error: 'عدد غير صحيح' });
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
  if (!ticket) return res.status(404).json({ error: 'التذكرة مش موجودة' });
  if (count < ticket.sold_count) return res.status(400).json({ error: `لا يمكن التعديل — تم بيع ${ticket.sold_count} تذكرة بالفعل` });
  const newTotal = ticket.price * count;
  db.prepare('UPDATE tickets SET count = ?, total = ? WHERE id = ?').run(count, newTotal, id);
  res.json({ ok: true });
});

// Delete a single ticket batch (only if 0 sold from it)
app.delete('/api/admin/tickets/:id', requireAuth, (req, res) => {
  const id = req.params.id;
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
  if (!ticket) return res.status(404).json({ error: 'التذكرة مش موجودة' });
  if (ticket.sold_count > 0) return res.status(400).json({ error: `لا يمكن الحذف — تم بيع ${ticket.sold_count} تذكرة منها` });
  db.prepare('DELETE FROM payment_tickets WHERE ticket_id = ?').run(id);
  db.prepare('DELETE FROM tickets WHERE id = ?').run(id);
  res.json({ ok: true });
});

// Add payment + update sold counts
app.post('/api/admin/payments', requireAuth, (req, res) => {
  const { distributor_id, amount, note, ticketsSold } = req.body;
  if (!distributor_id || !amount) return res.status(400).json({ error: 'بيانات ناقصة' });

  const addPayment = db.transaction(() => {
    const payInfo = db.prepare('INSERT INTO payments (distributor_id, amount, note) VALUES (?, ?, ?)').run(distributor_id, amount, note || '');
    const payId = payInfo.lastInsertRowid;

    if (ticketsSold && ticketsSold.length > 0) {
      const ptStmt = db.prepare('INSERT INTO payment_tickets (payment_id, ticket_id, sold_count) VALUES (?, ?, ?)');
      const updateStmt = db.prepare('UPDATE tickets SET sold_count = sold_count + ? WHERE id = ?');
      ticketsSold.forEach(ts => {
        if (ts.count > 0) {
          ptStmt.run(payId, ts.ticketId, ts.count);
          updateStmt.run(ts.count, ts.ticketId);
        }
      });
    }
    return payId;
  });

  const payId = addPayment();
  res.json({ id: payId });
});

// Export full detailed data
app.get('/api/admin/export', requireAuth, (req, res) => {
  const dists = db.prepare('SELECT * FROM distributors').all();
  const tickets = db.prepare('SELECT * FROM tickets').all();
  const payments = db.prepare('SELECT * FROM payments').all();
  const ptLinks = db.prepare('SELECT * FROM payment_tickets').all();

  // Build rich export: per distributor, per show breakdown
  const SHOWS_MAP = { 1: 'عرض الخميس 2 أبريل', 2: 'عرض الجمعة 3 أبريل' };
  const ticketMap = {};
  tickets.forEach(t => ticketMap[t.id] = t);
  const ptByPayment = {};
  ptLinks.forEach(pt => {
    if (!ptByPayment[pt.payment_id]) ptByPayment[pt.payment_id] = [];
    ptByPayment[pt.payment_id].push(pt);
  });

  const detailed = dists.map(d => {
    const dTickets = tickets.filter(t => t.distributor_id === d.id);
    const dPayments = payments.filter(p => p.distributor_id === d.id);
    const totalRequired = dTickets.reduce((a,t) => a + t.total, 0);
    const totalPaid = dPayments.reduce((a,p) => a + p.amount, 0);
    const totalSold = dTickets.reduce((a,t) => a + t.sold_count, 0);

    const byShow = {};
    dTickets.forEach(t => {
      const sn = SHOWS_MAP[t.show_id] || ('عرض ' + t.show_id);
      if (!byShow[sn]) byShow[sn] = { tickets: [], required: 0, sold: 0 };
      byShow[sn].tickets.push(t);
      byShow[sn].required += t.total;
      byShow[sn].sold += t.sold_count;
    });

    return {
      distributor: d,
      summary: { totalRequired, totalPaid, remaining: totalRequired - totalPaid, totalSold },
      byShow,
      tickets: dTickets,
      payments: dPayments.map(p => ({
        ...p,
        ticketsSold: (ptByPayment[p.id] || []).map(pt => {
          const t = ticketMap[pt.ticket_id];
          return { show: t ? SHOWS_MAP[t.show_id] : '', row: t?.row_num, count: pt.sold_count };
        })
      }))
    };
  });

  res.json({ distributors: dists, tickets, payments, payment_tickets: ptLinks, detailed, exported_at: new Date().toISOString() });
});

// ── ADMIN PAGE ────────────────────────────────────────
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

app.get('/admin/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

// ── START ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Theater server running on port ${PORT}`);
  console.log(`Public:  http://localhost:${PORT}`);
  console.log(`Admin:   http://localhost:${PORT}/admin`);
});