// Cafe backend: Express + SQLite.
// Public:  GET /api/menu, POST /api/orders, GET /api/track/:token
// Admin:   /admin (page) and /api/admin/* (needs login)
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const OWNER_WHATSAPP = (process.env.OWNER_WHATSAPP || '918108128277').replace(/\D/g, '');
const DEFAULT_PREP_MINUTES = Number(process.env.DEFAULT_PREP_MINUTES) || 20;
const DEFAULT_PASSWORD = 'change-this-password';
const ORDER_STATUSES = ['new', 'preparing', 'ready', 'done', 'cancelled'];

const adminEnabled = ADMIN_PASSWORD.length >= 8 && ADMIN_PASSWORD !== DEFAULT_PASSWORD;
if (!adminEnabled) {
  console.warn('\n[!] Admin login is OFF. Set ADMIN_PASSWORD (8+ characters) in .env and restart.\n');
}

// ---------- small helpers ----------
class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const clean = (v, max) => String(v ?? '').trim().slice(0, max);

// All times are stored as UTC text like 2026-09-19T10:20:00Z
const toIso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const nowIso = () => toIso(Date.now());
const addMinutes = (iso, minutes) => toIso(Date.parse(iso) + minutes * 60000);

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Tiny in-memory rate limiter (per IP). Good enough for one server.
function rateLimit({ windowMs, max, message }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt < now) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now();
    let h = hits.get(req.ip);
    if (!h || h.resetAt < now) h = { count: 0, resetAt: now + windowMs };
    h.count++;
    hits.set(req.ip, h);
    if (h.count > max) return res.status(429).json({ error: message });
    next();
  };
}

// ---------- app ----------
const app = express();
app.disable('x-powered-by');
// On a host/proxy (Render, Railway, Nginx) set TRUST_PROXY=1 so each customer is counted separately.
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);
app.use(express.json({ limit: '50kb' }));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});

// ---------- public API ----------
app.get('/api/menu', (req, res) => {
  const items = db
    .prepare(
      'SELECT id, name, description, price, image_url FROM menu_items WHERE available = 1 ORDER BY sort_order, id'
    )
    .all();
  res.json(items);
});

const getItem = db.prepare('SELECT id, name, price FROM menu_items WHERE id = ? AND available = 1');
const insertOrder = db.prepare(
  'INSERT INTO orders (customer_name, phone, address, note, total, order_type, track_token) VALUES (?, ?, ?, ?, ?, ?, ?)'
);
const insertLine = db.prepare(
  'INSERT INTO order_items (order_id, menu_item_id, name, price, qty) VALUES (?, ?, ?, ?, ?)'
);
const itemsOfOrder = db.prepare('SELECT name, price, qty FROM order_items WHERE order_id = ?');

// Prices always come from the database, never from the browser.
const placeOrder = db.transaction((customer, qtyById) => {
  const lines = [];
  let total = 0;
  for (const [id, qty] of qtyById) {
    const item = getItem.get(id);
    if (!item) {
      throw new HttpError(400, 'Some items are no longer available. Please check your order.', 'ITEMS_CHANGED');
    }
    lines.push({ id: item.id, name: item.name, price: item.price, qty });
    total += item.price * qty;
  }
  const trackToken = crypto.randomBytes(12).toString('hex'); // secret link for this customer
  const info = insertOrder.run(
    customer.name, customer.phone, customer.address, customer.note, total, customer.orderType, trackToken
  );
  const orderId = Number(info.lastInsertRowid);
  for (const l of lines) insertLine.run(orderId, l.id, l.name, l.price, l.qty);
  return { orderId, total, lines, trackToken };
});

const orderLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  message: 'Too many orders from this device. Please call us to order.',
});

app.post('/api/orders', orderLimiter, (req, res) => {
  const b = req.body || {};
  const orderType = b.orderType === 'pickup' ? 'pickup' : 'delivery';
  const customer = {
    name: clean(b.name, 80),
    phone: clean(b.phone, 20),
    address: orderType === 'pickup' ? 'Pickup' : clean(b.address, 300),
    note: clean(b.note, 300),
    orderType,
  };
  if (!customer.name) throw new HttpError(400, 'Please enter your name.');
  if (!/^\+?[0-9][0-9\s-]{7,14}$/.test(customer.phone)) {
    throw new HttpError(400, 'Please enter a valid phone number.');
  }
  if (!customer.address) throw new HttpError(400, 'Please enter your delivery address.');

  const raw = Array.isArray(b.items) ? b.items : [];
  if (raw.length === 0 || raw.length > 30) throw new HttpError(400, 'Please add at least one item.');

  const qtyById = new Map();
  for (const it of raw) {
    const id = Number(it && it.id);
    const qty = Number(it && it.qty);
    if (!Number.isInteger(id) || !Number.isInteger(qty) || qty < 1 || qty > 20) {
      throw new HttpError(400, 'Invalid item or quantity.');
    }
    qtyById.set(id, Math.min(20, (qtyById.get(id) || 0) + qty));
  }

  const { orderId, total, lines, trackToken } = placeOrder(customer, qtyById);

  const message =
    `*NEW CAFE ORDER #${orderId}*\n\n` +
    `*Type:* ${orderType === 'pickup' ? 'Pickup' : 'Delivery'}\n` +
    `*Customer:* ${customer.name}\n*Phone:* ${customer.phone}\n` +
    (orderType === 'delivery' ? `*Address:* ${customer.address}\n` : '') +
    `\n*Items:*\n` +
    lines.map((l) => `• ${l.name} x ${l.qty} = ₹${l.price * l.qty}`).join('\n') +
    `\n\n*TOTAL: ₹${total}*\n*Note:* ${customer.note || 'None'}`;

  res.status(201).json({
    orderId,
    total,
    trackToken,
    whatsappUrl: `https://wa.me/${OWNER_WHATSAPP}?text=${encodeURIComponent(message)}`,
  });
});

// Customer order tracking. The long random token is the "password" for one order,
// so customers can only see their own order (order numbers alone are not enough).
const trackLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 400,
  message: 'Too many requests. Please wait a moment.',
});

app.get('/api/track/:token', trackLimiter, (req, res) => {
  const token = String(req.params.token || '');
  if (!/^[0-9a-f]{24}$/.test(token)) throw new HttpError(404, 'Order not found.');
  const o = db
    .prepare(
      'SELECT id, total, order_type, status, created_at, accepted_at, ready_at, done_at, eta_at FROM orders WHERE track_token = ?'
    )
    .get(token);
  if (!o) throw new HttpError(404, 'Order not found.');
  res.set('Cache-Control', 'no-store');
  res.json({
    orderId: o.id,
    orderType: o.order_type,
    status: o.status,
    total: o.total,
    createdAt: o.created_at,
    acceptedAt: o.accepted_at,
    readyAt: o.ready_at,
    doneAt: o.done_at,
    etaAt: o.eta_at,
    items: itemsOfOrder.all(o.id),
    serverNow: nowIso(), // lets the page correct for a wrong clock on the customer's phone
  });
});

// ---------- admin auth ----------
const sessions = new Map(); // token -> expiry time
const SESSION_MS = 12 * 60 * 60 * 1000;

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many login attempts. Try again in 15 minutes.',
});

app.post('/api/admin/login', loginLimiter, (req, res) => {
  if (!adminEnabled) {
    throw new HttpError(503, 'Admin is disabled. Set ADMIN_PASSWORD in .env and restart the server.');
  }
  const password = String((req.body || {}).password ?? '');
  if (!safeEqual(password, ADMIN_PASSWORD)) throw new HttpError(401, 'Wrong password.');
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_MS);
  res.json({ token });
});

function requireAdmin(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const expires = sessions.get(token);
  if (!expires || expires < Date.now()) {
    sessions.delete(token);
    return res.status(401).json({ error: 'Please log in again.' });
  }
  next();
}

// ---------- admin: orders ----------
app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 200').all();
  const orders = rows.map(({ track_token, ...o }) => ({ ...o, items: itemsOfOrder.all(o.id) }));
  res.json({ now: nowIso(), orders });
});

// Moves an order to a new status and keeps the time stamps (accepted / ready / done / ETA) in step.
const updateOrder = db.transaction((id, status, etaMinutes, etaAdd) => {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!o) throw new HttpError(404, 'Order not found.');

  const now = nowIso();
  let { status: st, accepted_at, ready_at, done_at, eta_at } = o;

  if (status) {
    st = status;
    if (st === 'new') {
      accepted_at = ready_at = done_at = eta_at = null;
    } else if (st === 'preparing') {
      accepted_at = accepted_at || now;
      ready_at = done_at = null;
      if (etaMinutes || !eta_at) eta_at = addMinutes(now, etaMinutes || DEFAULT_PREP_MINUTES);
    } else if (st === 'ready') {
      accepted_at = accepted_at || now;
      ready_at = ready_at || now;
      done_at = null;
    } else if (st === 'done') {
      accepted_at = accepted_at || now;
      ready_at = ready_at || now;
      done_at = done_at || now;
    }
    // 'cancelled' keeps whatever was recorded so far
  } else if (etaMinutes) {
    eta_at = addMinutes(now, etaMinutes); // reset the ETA to "N minutes from now"
  }

  if (etaAdd && eta_at) {
    // "+5 min" on an ETA that is already overdue means 5 minutes from now
    const base = etaAdd > 0 && Date.parse(eta_at) < Date.parse(now) ? now : eta_at;
    eta_at = addMinutes(base, etaAdd);
  }

  db.prepare(
    'UPDATE orders SET status = ?, accepted_at = ?, ready_at = ?, done_at = ?, eta_at = ? WHERE id = ?'
  ).run(st, accepted_at, ready_at, done_at, eta_at, id);
});

app.patch('/api/admin/orders/:id', requireAdmin, (req, res) => {
  const b = req.body || {};
  const status = b.status === undefined ? null : String(b.status);
  const etaMinutes = b.eta_minutes === undefined ? null : Number(b.eta_minutes);
  const etaAdd = b.eta_add_minutes === undefined ? null : Number(b.eta_add_minutes);

  if (status !== null && !ORDER_STATUSES.includes(status)) throw new HttpError(400, 'Invalid status.');
  if (etaMinutes !== null && (!Number.isInteger(etaMinutes) || etaMinutes < 1 || etaMinutes > 240)) {
    throw new HttpError(400, 'ETA must be between 1 and 240 minutes.');
  }
  if (etaAdd !== null && (!Number.isInteger(etaAdd) || etaAdd < -60 || etaAdd > 120)) {
    throw new HttpError(400, 'ETA change must be between -60 and 120 minutes.');
  }
  if (status === null && etaMinutes === null && etaAdd === null) throw new HttpError(400, 'Nothing to update.');

  updateOrder(Number(req.params.id), status, etaMinutes, etaAdd);
  res.json({ ok: true });
});

// ---------- admin: menu ----------
function parseMenuBody(b = {}) {
  const name = clean(b.name, 80);
  const description = clean(b.description, 200);
  const image_url = clean(b.image_url, 500);
  const price = Number(b.price);
  const sortRaw = Number(b.sort_order);
  const sort_order = Number.isInteger(sortRaw) ? sortRaw : 0;
  const available = b.available === false || b.available === 0 || b.available === '0' ? 0 : 1;

  if (!name) throw new HttpError(400, 'Item name is required.');
  if (!Number.isInteger(price) || price < 0 || price > 100000) {
    throw new HttpError(400, 'Price must be a whole number in rupees.');
  }
  if (image_url && !/^(https?:\/\/|\/)/i.test(image_url)) {
    throw new HttpError(400, 'Image URL must start with http://, https:// or /');
  }
  return { name, description, price, image_url, available, sort_order };
}

app.get('/api/admin/menu', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM menu_items ORDER BY sort_order, id').all());
});

app.post('/api/admin/menu', requireAdmin, (req, res) => {
  const m = parseMenuBody(req.body);
  const info = db
    .prepare(
      'INSERT INTO menu_items (name, description, price, image_url, available, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(m.name, m.description, m.price, m.image_url, m.available, m.sort_order);
  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

app.put('/api/admin/menu/:id', requireAdmin, (req, res) => {
  const m = parseMenuBody(req.body);
  const info = db
    .prepare(
      'UPDATE menu_items SET name = ?, description = ?, price = ?, image_url = ?, available = ?, sort_order = ? WHERE id = ?'
    )
    .run(m.name, m.description, m.price, m.image_url, m.available, m.sort_order, Number(req.params.id));
  if (info.changes === 0) throw new HttpError(404, 'Item not found.');
  res.json({ ok: true });
});

app.delete('/api/admin/menu/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM menu_items WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ---------- pages ----------
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// ---------- errors ----------
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request.' });
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

app.listen(PORT, () => {
  console.log(`Cafe site running:  http://localhost:${PORT}`);
  console.log(`Admin panel:        http://localhost:${PORT}/admin`);
});
