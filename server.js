const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const createStore = require('./store');

const PORT = process.env.PORT || 3000;
const INDEX = path.join(__dirname, 'public', 'index.html');
const MAX_IMAGE_CHARS = 1_500_000; // ~1MB ảnh sau khi mã hóa base64
const IMAGE_RE = /^data:image\/(jpeg|png|webp);base64,/;

const store = createStore();
const rooms = new Map(); // roomId -> Set<ws> (người đang online)
const fails = new Map(); // roomId -> { n, until } chống dò mật khẩu

function makeCred(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(password, salt, 32).toString('hex') };
}
function checkPassword(password, cred) {
  const a = crypto.scryptSync(password, cred.salt, 32), b = Buffer.from(cred.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const server = http.createServer((req, res) => {
  fs.readFile(INDEX, (err, data) => {
    if (err) { res.writeHead(500); return res.end('Error'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 3 * 1024 * 1024 });

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function broadcast(room, obj) {
  for (const c of room) send(c, obj);
}

async function handleJoin(ws, msg) {
  const roomId = String(msg.room || '').trim().slice(0, 50);
  const name = String(msg.name || '').trim().slice(0, 30);
  const password = String(msg.password || '').slice(0, 100);
  if (!roomId || !name) return send(ws, { type: 'error', text: 'Thiếu tên hoặc mã phòng.' });
  if (password.length < 4) return send(ws, { type: 'error', text: 'Mật khẩu tối thiểu 4 ký tự.' });

  const cred = await store.getAuth(roomId);
  if (cred) { // phòng đã có mật khẩu -> phải nhập đúng mới được xem lịch sử
    const f = fails.get(roomId) || { n: 0, until: 0 };
    if (Date.now() < f.until) return send(ws, { type: 'error', text: 'Nhập sai quá nhiều lần, thử lại sau 1 phút.' });
    if (!checkPassword(password, cred)) {
      if (++f.n >= 5) { f.n = 0; f.until = Date.now() + 60_000; }
      fails.set(roomId, f);
      return send(ws, { type: 'error', text: 'Sai mật khẩu.' });
    }
    fails.delete(roomId);
  }

  const room = rooms.get(roomId) || new Set();
  if (room.size >= 2) return send(ws, { type: 'error', text: 'Phòng đã đủ 2 người.' });
  if (!cred) await store.setAuth(roomId, makeCred(password)); // người đầu tiên đặt mật khẩu

  ws.roomId = roomId; ws.name = name;
  room.add(ws); rooms.set(roomId, room);
  send(ws, { type: 'joined', room: roomId, count: room.size });
  send(ws, { type: 'history', messages: await store.getHistory(roomId) });
  const bg = await store.getBg(roomId);
  if (bg) send(ws, { type: 'bg', data: bg });
  broadcast(room, { type: 'system', text: `${name} đã vào phòng.`, count: room.size });
}

wss.on('connection', (ws) => {
  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    try {
      if (msg.type === 'join') {
        await handleJoin(ws, msg);
      } else if (msg.type === 'bg' && ws.roomId) {
        const data = msg.data;
        if (data !== null && !(typeof data === 'string' && data.length <= 2_500_000 && IMAGE_RE.test(data))) return;
        await store.setBg(ws.roomId, data);
        broadcast(rooms.get(ws.roomId), { type: 'bg', data });
      } else if (msg.type === 'signal' && ws.roomId) {
        for (const c of rooms.get(ws.roomId)) if (c !== ws) send(c, { type: 'signal', data: msg.data });
      } else if (msg.type === 'chat' && ws.roomId) {
        const text = String(msg.text || '').trim().slice(0, 2000);
        const image = typeof msg.image === 'string' && msg.image.length <= MAX_IMAGE_CHARS && IMAGE_RE.test(msg.image)
          ? msg.image : null;
        const isCallLog = !!msg.isCallLog;
        if (!text && !image && !isCallLog) return;
        const m = {
          type: 'chat',
          name: ws.name,
          text,
          image,
          time: Date.now(),
          isCallLog,
          callType: msg.callType || 'voice',
          duration: Number(msg.duration) || 0
        };
        broadcast(rooms.get(ws.roomId), m); // gửi ngay, lưu sau để không làm chậm chat
        store.addMessage(ws.roomId, m).catch(e => console.error('Không lưu được tin nhắn:', e.message));
      } else if (msg.type === 'typing' && ws.roomId) {
        for (const c of rooms.get(ws.roomId)) if (c !== ws) send(c, { type: 'typing', name: ws.name });
      }
    } catch (e) {
      console.error('Lỗi xử lý tin nhắn:', e.message);
      send(ws, { type: 'error', text: 'Lỗi máy chủ, thử lại sau.' });
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomId);
    if (!room) return;
    room.delete(ws);
    if (room.size === 0) rooms.delete(ws.roomId);
    else broadcast(room, { type: 'system', text: `${ws.name} đã rời phòng.`, count: room.size });
  });
});

store.init().then(() => {
  server.listen(PORT, () => console.log(`Chat chạy tại http://localhost:${PORT} | Lưu trữ: ${store.name}`));
}).catch(e => {
  console.error('Không kết nối được nơi lưu trữ:', e.message);
  process.exit(1);
});
