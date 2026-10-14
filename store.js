// Lớp lưu trữ: dùng MongoDB Atlas nếu có biến MONGODB_URI, ngược lại lưu ra file JSON (chạy local).
// Cả hai cùng một giao diện nên server.js không cần biết đang dùng loại nào.
const fs = require('fs');
const path = require('path');

const MAX_HISTORY = 3000; // lưu tối đa 3000 tin nhắn mỗi phòng trong 30 ngày
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function fileStore(file) {
  const history = new Map(), auth = new Map(), bg = new Map();
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const h = saved.history || saved; // file cũ chỉ chứa lịch sử
    for (const [id, msgs] of Object.entries(h)) if (Array.isArray(msgs)) history.set(id, msgs);
    for (const [id, c] of Object.entries(saved.auth || {})) auth.set(id, c);
    for (const [id, d] of Object.entries(saved.bg || {})) bg.set(id, d);
  } catch { /* chưa có file */ }

  let timer;
  function save() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({
          history: Object.fromEntries(history), auth: Object.fromEntries(auth), bg: Object.fromEntries(bg),
        }));
      } catch (e) { console.error('Không lưu được dữ liệu:', e.message); }
    }, 1000);
  }

  function cleanExpired(list) {
    const cutoff = Date.now() - THIRTY_DAYS_MS;
    return list.filter(m => m.time && m.time >= cutoff);
  }

  return {
    name: 'file (' + file + ')',
    async init() {},
    async getAuth(id) { return auth.get(id) || null; },
    async setAuth(id, cred) { auth.set(id, cred); save(); },
    async getBg(id) { return bg.get(id) || null; },
    async setBg(id, data) { if (data) bg.set(id, data); else bg.delete(id); save(); },
    async getHistory(id) {
      let list = history.get(id) || [];
      list = cleanExpired(list);
      history.set(id, list);
      return list;
    },
    async addMessage(id, m) {
      let list = history.get(id) || [];
      list.push(m);
      list = cleanExpired(list);
      if (list.length > MAX_HISTORY) list.splice(0, list.length - MAX_HISTORY);
      history.set(id, list);
      save();
    },
    async deleteMessage(roomId, msgId, userName) {
      let list = history.get(roomId) || [];
      const idx = list.findIndex(m => m.id === msgId && m.name === userName);
      if (idx !== -1) {
        list.splice(idx, 1);
        history.set(roomId, list);
        save();
        return true;
      }
      return false;
    },
  };
}

function mongoStore(uri) {
  const { MongoClient } = require('mongodb');
  let rooms, messages;
  return {
    name: 'MongoDB Atlas',
    async init() {
      const client = new MongoClient(uri);
      await client.connect();
      const db = client.db(process.env.MONGODB_DB || 'vochongngheo');
      rooms = db.collection('rooms');       // { _id: roomId, auth: {salt, hash}, bg: dataURL }
      messages = db.collection('messages'); // { room, name, text, image, time }
      await messages.createIndex({ room: 1, time: 1 });
      // Tự động xóa tin nhắn sau 30 ngày (30 * 86400 = 2592000 giây)
      try {
        await messages.createIndex({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });
      } catch {}
    },
    async getAuth(id) {
      const d = await rooms.findOne({ _id: id }, { projection: { auth: 1 } });
      return (d && d.auth) || null;
    },
    async setAuth(id, cred) {
      await rooms.updateOne({ _id: id }, { $set: { auth: cred } }, { upsert: true });
    },
    async getBg(id) {
      const d = await rooms.findOne({ _id: id }, { projection: { bg: 1 } });
      return (d && d.bg) || null;
    },
    async setBg(id, data) {
      await rooms.updateOne({ _id: id }, data ? { $set: { bg: data } } : { $unset: { bg: '' } }, { upsert: true });
    },
    async getHistory(id) {
      const cutoff = Date.now() - THIRTY_DAYS_MS;
      const docs = await messages.find({ room: id, time: { $gte: cutoff } }).sort({ time: -1 }).limit(MAX_HISTORY).toArray();
      return docs.reverse().map(({ _id, room, createdAt, ...m }) => m);
    },
    async addMessage(id, m) {
      await messages.insertOne({ room: id, createdAt: new Date(m.time || Date.now()), ...m });
      const old = await messages.find({ room: id }).sort({ time: -1 }).skip(MAX_HISTORY).project({ _id: 1 }).toArray();
      if (old.length) await messages.deleteMany({ _id: { $in: old.map(d => d._id) } });
    },
    async deleteMessage(roomId, msgId, userName) {
      // Chỉ xóa nếu đúng room, đúng id và đúng chính chủ (name) đã gửi
      const res = await messages.deleteOne({ room: roomId, id: msgId, name: userName });
      return res.deletedCount > 0;
    },
  };
}

module.exports = function createStore() {
  if (process.env.MONGODB_URI) return mongoStore(process.env.MONGODB_URI);
  return fileStore(process.env.HISTORY_FILE || path.join(__dirname, 'data', 'history.json'));
};
