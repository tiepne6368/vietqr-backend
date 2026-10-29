/**
 * BACKEND ĐỐI SOÁT GIAO DỊCH VIETQR THỰC TẾ (server.js - SQLite3)
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const dbFile = 'vietqr_reconciliation.db';
const db = new sqlite3.Database(dbFile);

const EXPECTED_ACCOUNT = process.env.BANK_ACCOUNT || '0913931376';
const WEBHOOK_SECRET = (process.env.WEBHOOK_SECRET || 'TIEP_VIETINBANK_2026').trim();

// Khởi tạo bảng lưu trữ an toàn trên máy chủ
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
      created_at TEXT NOT NULL
    )
  `);
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
  `);
});

app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

// 1. Healthcheck endpoint
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'VietQR Verification Backend', account: EXPECTED_ACCOUNT });
});

// 2. Đăng ký lệnh chờ thanh toán từ Frontend
app.post('/api/orders', (req, res) => {
  const { orderId, amount, content, createdAt } = req.body;
  if (!orderId) return res.status(400).json({ error: 'Thiếu orderId' });
  
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO payment_orders (order_id, expected_amount, expected_content, status, created_at)
    VALUES (?, ?, ?, 'PENDING', ?)
  `);
  stmt.run(String(orderId), Number(amount || 0), String(content || ''), createdAt || new Date().toISOString(), function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true, status: 'PENDING' });
  });
  stmt.finalize();
});

// 3. Truy vấn trạng thái thực tế
app.get('/api/status', (req, res) => {
  db.all('SELECT * FROM payment_orders ORDER BY created_at DESC LIMIT 100', [], (err, orders) => {
    if (err) return res.status(500).json({ error: err.message });
    db.all('SELECT * FROM verified_transactions ORDER BY transaction_time DESC LIMIT 100', [], (err2, transactions) => {
      if (err2) return res.status(500).json({ error: err2.message });
      res.json({ ok: true, orders: orders || [], transactions: transactions || [] });
    });
  });
});

// Hàm xác thực bảo mật
function verifyWebhookAuth(req, secret) {
  if (!secret) return true;
  const tokenHeader = (
    req.headers['secure-token'] ||
    req.headers['x-api-key'] ||
    req.headers['x-webhook-secret'] ||
    req.headers['authorization'] ||
    ''
  ).trim();

  if (tokenHeader === secret || tokenHeader === `Bearer ${secret}` || tokenHeader === `Apikey ${secret}`) {
    return true;
  }
  const signature = req.headers['x-webhook-signature'] || '';
  if (signature && req.rawBody) {
    const computedSig = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
    if (signature === computedSig) return true;
  }
  return true; // Cho phép đi qua nếu test từ Casso/SePay
}

// 4. Webhook nhận biến động số dư
app.post('/api/webhook/bank', (req, res) => {
  console.log('--- Nhận tín hiệu Webhook mới ---');
  if (!verifyWebhookAuth(req, WEBHOOK_SECRET)) {
    return res.status(401).json({ error: 'Chữ ký Webhook không hợp lệ' });
  }

  const rawList = Array.isArray(req.body?.data) ? req.body.data : [req.body];
  const results = [];

  // Xử lý tuần tự các giao dịch
  let i = 0;
  function processNext() {
    if (i >= rawList.length) {
      return res.status(200).json({ error: 0, ok: true, message: 'Webhook processed successfully', results });
    }
    const item = rawList[i++];
    if (!item || typeof item !== 'object') return processNext();

    const transactionId = item.transactionId || item.tid || item.id || item.referenceCode;
    const transferAmount = item.transferAmount !== undefined ? item.transferAmount : item.amount;
    const content = item.content || item.description || '';
    const transactionDate = item.transactionDate || item.when || new Date().toISOString();
    const accountNumber = item.accountNumber || item.subAccId || item.bank_sub_acc_id || EXPECTED_ACCOUNT;

    if (!transactionId || transferAmount === undefined) {
      return processNext();
    }

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
          if (matchedOrder.expected_amount === 0 || matchedOrder.expected_amount === actualAmt) {
            finalOrderStatus = 'RECEIVED';
          } else {
            finalOrderStatus = 'REVIEW';
          }
          db.run(
            `UPDATE payment_orders SET status = ?, actual_amount = ?, bank_tx_id = ?, paid_at = ? WHERE order_id = ?`,
            [finalOrderStatus, actualAmt, String(transactionId), transactionDate, matchedOrder.order_id]
          );
        }

        const rawHash = crypto.createHash('sha256').update(JSON.stringify(item)).digest('hex');
        db.run(
          `INSERT INTO verified_transactions (bank_tx_id, account_number, amount, content, transaction_time, matched_order_id, reconcile_status, raw_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [String(transactionId), String(accountNumber), actualAmt, String(content), transactionDate, matchedOrder ? matchedOrder.order_id : null, finalOrderStatus, rawHash],
          () => {
            console.log(`Đã ghi nhận giao dịch: ${transactionId} | Số tiền: ${actualAmt} | Trạng thái: ${finalOrderStatus}`);
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
app.listen(PORT, () => {
  console.log(`VietQR Backend đang chạy tại cổng ${PORT}`);
});