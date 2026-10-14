// Lớp lưu trữ: dùng MongoDB Atlas nếu có biến MONGODB_URI, ngược lại lưu ra file JSON (chạy local).
// Cả hai cùng một giao diện nên server.js không cần biết đang dùng loại nào.
const fs = require('fs');
const path = require('path');

const MAX_HISTORY = 100; // số tin nhắn giữ lại mỗi phòng

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

  return {
    name: 'file (' + file + ')',
    async init() {},
    async getAuth(id) { return auth.get(id) || null; },
    async setAuth(id, cred) { auth.set(id, cred); save(); },
    async getBg(id) { return bg.get(id) || null; },
    async setBg(id, data) { if (data) bg.set(id, data); else bg.delete(id); save(); },
    async getHistory(id) { return history.get(id) || []; },
    async addMessage(id, m) {
      const list = history.get(id) || [];
      list.push(m);
      if (list.length > MAX_HISTORY) list.splice(0, list.length - MAX_HISTORY);
      history.set(id, list);
      save();
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
      const docs = await messages.find({ room: id }).sort({ time: -1 }).limit(MAX_HISTORY).toArray();
      return docs.reverse().map(({ _id, room, ...m }) => m);
    },
    async addMessage(id, m) {
      await messages.insertOne({ room: id, ...m });
      const old = await messages.find({ room: id }).sort({ time: -1 }).skip(MAX_HISTORY).project({ _id: 1 }).toArray();
      if (old.length) await messages.deleteMany({ _id: { $in: old.map(d => d._id) } });
    },
  };
}

module.exports = function createStore() {
  if (process.env.MONGODB_URI) return mongoStore(process.env.MONGODB_URI);
  return fileStore(process.env.HISTORY_FILE || path.join(__dirname, 'data', 'history.json'));
};
