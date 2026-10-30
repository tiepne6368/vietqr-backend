/**
 * MODULE LƯU TRỮ DÀI HẠN & ĐỒNG BỘ 2 CHIỀU (storage.js)
 * Lưu trữ cả mã QR, ảnh PNG Base64 và giao dịch đã xác minh API
 */
const fs = require('fs');
const path = require('path');

const BACKUP_FILE = path.join(__dirname, 'vietqr_permanent_backup.json');

function readBackupFile() {
  try {
    if (fs.existsSync(BACKUP_FILE)) {
      const raw = fs.readFileSync(BACKUP_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        orders: Array.isArray(parsed.orders) ? parsed.orders : [],
        transactions: Array.isArray(parsed.transactions) ? parsed.transactions : []
      };
    }
  } catch (err) {
    console.error('Lỗi đọc file backup:', err.message);
  }
  return { orders: [], transactions: [] };
}

function writeBackupFile(data) {
  try {
    fs.writeFileSync(BACKUP_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Lỗi ghi file backup:', err.message);
  }
}

// Khởi tạo và khôi phục dữ liệu từ file JSON vào SQLite khi server bật lại
function initAndRestoreSqlite(db) {
  const backup = readBackupFile();
  db.serialize(() => {
    backup.orders.forEach(o => {
      db.run(
        `INSERT OR IGNORE INTO payment_orders (order_id, expected_amount, expected_content, status, actual_amount, bank_tx_id, paid_at, created_at, qr_image)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [o.order_id, o.expected_amount, o.expected_content, o.status, o.actual_amount, o.bank_tx_id, o.paid_at, o.created_at, o.qr_image || null]
      );
    });

    backup.transactions.forEach(t => {
      db.run(
        `INSERT OR IGNORE INTO verified_transactions (bank_tx_id, account_number, amount, content, transaction_time, matched_order_id, reconcile_status, raw_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [t.bank_tx_id, t.account_number, t.amount, t.content, t.transaction_time, t.matched_order_id, t.reconcile_status, t.raw_hash || 'restored']
      );
    });
  });
}

// Xuất dữ liệu từ SQLite ra file JSON mỗi khi có thay đổi
function snapshotSqliteToFile(db) {
  db.all('SELECT * FROM payment_orders ORDER BY created_at DESC LIMIT 500', [], (err, orders) => {
    if (err) return;
    db.all('SELECT * FROM verified_transactions ORDER BY transaction_time DESC LIMIT 500', [], (err2, transactions) => {
      if (err2) return;
      writeBackupFile({ orders: orders || [], transactions: transactions || [] });
    });
  });
}

module.exports = {
  initAndRestoreSqlite,
  snapshotSqliteToFile
};