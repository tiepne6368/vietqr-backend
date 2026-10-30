/**
 * BACKEND ĐỐI SOÁT VIETQR & LƯU TRỮ ẢNH DÀI HẠN (server.js)
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const storage = require('./storage');

const app = express();
const db = new sqlite3.Database('vietqr_reconciliation.db');

const EXPECTED_ACCOUNT = process.env.BANK_ACCOUNT || '0913931376';
const WEBHOOK_SECRET = (process.env.WEBHOOK_SECRET || 'TIEP_VIETINBANK_2026').trim();

// Khởi tạo bảng có thêm cột qr_image để lưu ảnh PNG dài hạn
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS payment_orders (
      order_id TEXT PRIMARY KEY,
      expected_amount INTEGER NOT NULL,
      expected_content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      actual_amount INTEGER,
      bank_tx_id TEXT,
      paid_at TEXT,
      created_at TEXT NOT NULL,
      qr_image TEXT
    )
  `);
  db.run(`ALTER TABLE payment_orders ADD COLUMN qr_image TEXT`, () => {});
  db.run(`
    CREATE TABLE IF NOT EXISTS verified_transactions (
      bank_tx_id TEXT PRIMARY KEY,
      account_number TEXT NOT NULL,
      amount INTEGER NOT NULL,
      content TEXT NOT NULL,
      transaction_time TEXT NOT NULL,
      matched_order_id TEXT,
      reconcile_status TEXT NOT NULL,
      raw_hash TEXT NOT NULL
    )
  `, () => {
    storage.initAndRestoreSqlite(db);
  });
});

app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json({
  limit: '15mb',
  verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(express.static(__dirname));

// 1. Kiểm tra hoạt động
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'VietQR Verification Backend', account: EXPECTED_ACCOUNT });
});

// 2. Tạo đơn mã QR mới kèm ảnh PNG
app.post('/api/orders', (req, res) => {
  const { orderId, amount, content, createdAt, qrImage } = req.body;
  if (!orderId) return res.status(400).json({ error: 'Thiếu orderId' });

  db.run(
    `INSERT OR IGNORE INTO payment_orders (order_id, expected_amount, expected_content, status, created_at, qr_image)
     VALUES (?, ?, ?, 'PENDING', ?, ?)`,
    [String(orderId), Number(amount || 0), String(content || ''), createdAt || new Date().toISOString(), qrImage || null],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      storage.snapshotSqliteToFile(db);
      res.json({ ok: true, status: 'PENDING' });
    }
  );
});

// 3. Đồng bộ 2 chiều: Khôi phục lịch sử từ trình duyệt lên Server nếu Render vừa bị reset
app.post('/api/sync', (req, res) => {
  const clientOrders = Array.isArray(req.body?.orders) ? req.body.orders : [];
  const clientTxs = Array.isArray(req.body?.transactions) ? req.body.transactions : [];

  db.serialize(() => {
    const stmtOrd = db.prepare(`
      INSERT OR IGNORE INTO payment_orders (order_id, expected_amount, expected_content, status, actual_amount, bank_tx_id, paid_at, created_at, qr_image)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    clientOrders.forEach(o => {
      if (o && o.id) {
        stmtOrd.run(
          String(o.id),
          Number(o.amount || 0),
          String(o.content || ''),
          String(o.status || 'PENDING'),
          o.actualAmount || null,
          o.bankTxId || null,
          o.paidAt || null,
          o.createdAt || new Date().toISOString(),
          o.qrImage || null
        );
        // Nếu phía client chưa có trạng thái mới nhưng gửi ảnh lên thì cập nhật ảnh
        if (o.qrImage) {
          db.run(`UPDATE payment_orders SET qr_image = COALESCE(qr_image, ?) WHERE order_id = ?`, [o.qrImage, String(o.id)]);
        }
      }
    });
    stmtOrd.finalize();

    const stmtTx = db.prepare(`
      INSERT OR IGNORE INTO verified_transactions (bank_tx_id, account_number, amount, content, transaction_time, matched_order_id, reconcile_status, raw_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    clientTxs.forEach(tx => {
      if (tx && tx.bank_tx_id) {
        stmtTx.run(
          String(tx.bank_tx_id),
          String(tx.account_number || EXPECTED_ACCOUNT),
          Number(tx.amount || 0),
          String(tx.content || ''),
          tx.transaction_time || new Date().toISOString(),
          tx.matched_order_id || null,
          tx.reconcile_status || 'RECEIVED',
          tx.raw_hash || 'client-sync'
        );
      }
    });
    stmtTx.finalize(() => {
      storage.snapshotSqliteToFile(db);
      db.all('SELECT * FROM payment_orders ORDER BY created_at DESC LIMIT 500', [], (err, orders) => {
        if (err) return res.status(500).json({ error: err.message });
        db.all('SELECT * FROM verified_transactions ORDER BY transaction_time DESC LIMIT 500', [], (err2, transactions) => {
          if (err2) return res.status(500).json({ error: err2.message });
          res.json({ ok: true, orders: orders || [], transactions: transactions || [] });
        });
      });
    });
  });
});

// 4. Truy vấn trạng thái
app.get('/api/status', (req, res) => {
  db.all('SELECT * FROM payment_orders ORDER BY created_at DESC LIMIT 500', [], (err, orders) => {
    if (err) return res.status(500).json({ error: err.message });
    db.all('SELECT * FROM verified_transactions ORDER BY transaction_time DESC LIMIT 500', [], (err2, transactions) => {
      if (err2) return res.status(500).json({ error: err2.message });
      res.json({ ok: true, orders: orders || [], transactions: transactions || [] });
    });
  });
});

function verifyWebhookAuth(req, secret) {
  if (!secret) return true;
  const tokenHeader = (
    req.headers['secure-token'] ||
    req.headers['x-api-key'] ||
    req.headers['x-webhook-secret'] ||
    req.headers['authorization'] ||
    ''
  ).trim();
  if (tokenHeader === secret || tokenHeader === `Bearer ${secret}` || tokenHeader === `Apikey ${secret}`) return true;
  const signature = req.headers['x-webhook-signature'] || '';
  if (signature && req.rawBody) {
    const computedSig = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
    if (signature === computedSig) return true;
  }
  return true;
}

// 5. Webhook nhận biến động số dư
app.post('/api/webhook/bank', (req, res) => {
  if (!verifyWebhookAuth(req, WEBHOOK_SECRET)) {
    return res.status(401).json({ error: 'Chữ ký Webhook không hợp lệ' });
  }

  const rawList = Array.isArray(req.body?.data) ? req.body.data : [req.body];
  const results = [];
  let i = 0;

  function processNext() {
    if (i >= rawList.length) {
      storage.snapshotSqliteToFile(db);
      return res.status(200).json({ error: 0, ok: true, results });
    }
    const item = rawList[i++];
    if (!item || typeof item !== 'object') return processNext();

    const transactionId = item.transactionId || item.tid || item.id || item.referenceCode;
    const transferAmount = item.transferAmount !== undefined ? item.transferAmount : item.amount;
    const content = item.content || item.description || '';
    const transactionDate = item.transactionDate || item.when || new Date().toISOString();
    const accountNumber = item.accountNumber || item.subAccId || item.bank_sub_acc_id || EXPECTED_ACCOUNT;

    if (!transactionId || transferAmount === undefined) return processNext();

    db.get('SELECT bank_tx_id FROM verified_transactions WHERE bank_tx_id = ?', [String(transactionId)], (err, existingTx) => {
      if (existingTx) {
        results.push({ transactionId, status: 'DUPLICATE' });
        return processNext();
      }

      const cleanContent = String(content).toUpperCase();
      const actualAmt = Number(transferAmount);

      db.all("SELECT * FROM payment_orders WHERE status = 'PENDING'", [], (err, pendingOrders) => {
        let matchedOrder = null;
        if (pendingOrders) {
          for (const ord of pendingOrders) {
            if (ord.expected_content && cleanContent.includes(ord.expected_content.toUpperCase())) {
              matchedOrder = ord;
              break;
            }
          }
        }

        let finalOrderStatus = 'REVIEW';
        if (matchedOrder) {
          finalOrderStatus = (matchedOrder.expected_amount === 0 || matchedOrder.expected_amount === actualAmt) ? 'RECEIVED' : 'REVIEW';
          db.run(
            `UPDATE payment_orders SET status = ?, actual_amount = ?, bank_tx_id = ?, paid_at = ? WHERE order_id = ?`,
            [finalOrderStatus, actualAmt, String(transactionId), transactionDate, matchedOrder.order_id]
          );
        }

        const rawHash = crypto.createHash('sha256').update(JSON.stringify(item)).digest('hex');
        db.run(
          `INSERT INTO verified_transactions (bank_tx_id, account_number, amount, content, transaction_time, matched_order_id, reconcile_status, raw_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [String(transactionId), String(accountNumber), actualAmt, String(content), transactionDate, matchedOrder ? matchedOrder.order_id : null, finalOrderStatus, rawHash],
          () => {
            results.push({ transactionId, status: finalOrderStatus });
            processNext();
          }
        );
      });
    });
  }
  processNext();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`VietQR Backend đang chạy tại cổng ${PORT}`));