// Database setup: creates cafe.db (SQLite) and the tables on first run.
// Set DB_PATH in .env / hosting settings to keep the file on a persistent disk.
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(process.env.DB_PATH || path.join(__dirname, 'cafe.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const ordersTable = (name) => `
  CREATE TABLE ${name} (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name TEXT    NOT NULL,
    phone         TEXT    NOT NULL,
    address       TEXT    NOT NULL,
    note          TEXT    NOT NULL DEFAULT '',
    total         INTEGER NOT NULL,
    order_type    TEXT    NOT NULL DEFAULT 'delivery' CHECK (order_type IN ('pickup','delivery')),
    status        TEXT    NOT NULL DEFAULT 'new',
    created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    accepted_at   TEXT,
    ready_at      TEXT,
    done_at       TEXT,
    eta_at        TEXT,
    track_token   TEXT    NOT NULL UNIQUE
  )`;

// --- upgrade an older database (orders without tracking) without losing data ---
const existing = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'orders'").get();
if (existing && !existing.sql.includes('track_token')) {
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(ordersTable('orders_new'));
    db.exec(`
      INSERT INTO orders_new (id, customer_name, phone, address, note, total, order_type, status, created_at, track_token)
      SELECT id, customer_name, phone, address, note, total,
             CASE WHEN lower(trim(address)) = 'pickup' THEN 'pickup' ELSE 'delivery' END,
             status, created_at, lower(hex(randomblob(12)))
      FROM orders
    `);
    db.exec('DROP TABLE orders');
    db.exec('ALTER TABLE orders_new RENAME TO orders');
  })();
  db.pragma('foreign_keys = ON');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS menu_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    description TEXT    NOT NULL DEFAULT '',
    price       INTEGER NOT NULL CHECK (price >= 0),
    image_url   TEXT    NOT NULL DEFAULT '',
    available   INTEGER NOT NULL DEFAULT 1,
    sort_order  INTEGER NOT NULL DEFAULT 0
  );
`);
db.exec(ordersTable('IF NOT EXISTS orders'));

db.exec(`
  -- name and price are copied at order time, so old orders stay correct
  -- even if you later edit or delete the menu item.
  CREATE TABLE IF NOT EXISTS order_items (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id     INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    menu_item_id INTEGER,
    name         TEXT    NOT NULL,
    price        INTEGER NOT NULL,
    qty          INTEGER NOT NULL CHECK (qty > 0)
  );

  CREATE INDEX IF NOT EXISTS idx_orders_status     ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
`);

// Starter menu (only inserted when the table is empty).
const count = db.prepare('SELECT COUNT(*) AS n FROM menu_items').get().n;
if (count === 0) {
  const insert = db.prepare(
    'INSERT INTO menu_items (name, description, price, image_url, sort_order) VALUES (?, ?, ?, ?, ?)'
  );
  const seed = [
    ['Signature Coffee', 'Rich espresso, cappuccino, latte and house specials.', 149,
      'https://images.unsplash.com/photo-1509042239860-f550ce710b93?auto=format&fit=crop&w=900&q=85'],
    ['Cold Coffee', 'Refreshing cold coffee with a smooth creamy finish.', 169,
      'https://images.unsplash.com/photo-1461023058943-07fcbe16d735?auto=format&fit=crop&w=900&q=85'],
    ['Chocolate Cake', 'Soft chocolate cake finished with rich chocolate cream.', 199,
      'https://images.unsplash.com/photo-1578985545062-69928b1d9587?auto=format&fit=crop&w=900&q=85'],
    ['Cheesecake', 'Creamy cheesecake served with a delicate sweet topping.', 229,
      'https://images.unsplash.com/photo-1571115177098-24ec42ed204d?auto=format&fit=crop&w=900&q=85'],
  ];
  db.transaction(() => seed.forEach((row, i) => insert.run(...row, i + 1)))();
}

module.exports = db;
