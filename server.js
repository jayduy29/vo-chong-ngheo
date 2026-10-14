const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const INDEX = path.join(__dirname, 'public', 'index.html');

const server = http.createServer((req, res) => {
  fs.readFile(INDEX, (err, data) => {
    if (err) { res.writeHead(500); return res.end('Error'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 3 * 1024 * 1024 });
const rooms = new Map(); // roomId -> Set<ws>
const roomBg = new Map(); // roomId -> dataURL của hình nền

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function broadcast(room, obj) {
  for (const c of room) send(c, obj);
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      const roomId = String(msg.room || '').trim().slice(0, 50);
      const name = String(msg.name || '').trim().slice(0, 30);
      if (!roomId || !name) return send(ws, { type: 'error', text: 'Thiếu tên hoặc mã phòng.' });
      const room = rooms.get(roomId) || new Set();
      if (room.size >= 2) return send(ws, { type: 'error', text: 'Phòng đã đủ 2 người.' });
      ws.roomId = roomId; ws.name = name;
      room.add(ws); rooms.set(roomId, room);
      send(ws, { type: 'joined', room: roomId, count: room.size });
      if (roomBg.has(roomId)) send(ws, { type: 'bg', data: roomBg.get(roomId) });
      broadcast(room, { type: 'system', text: `${name} đã vào phòng.`, count: room.size });
    } else if (msg.type === 'bg' && ws.roomId) {
      const data = msg.data;
      if (data !== null && !(typeof data === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(data))) return;
      if (data) roomBg.set(ws.roomId, data); else roomBg.delete(ws.roomId);
      broadcast(rooms.get(ws.roomId), { type: 'bg', data });
    } else if (msg.type === 'signal' && ws.roomId) {
      for (const c of rooms.get(ws.roomId)) if (c !== ws) send(c, { type: 'signal', data: msg.data });
    } else if (msg.type === 'chat' && ws.roomId) {
      const text = String(msg.text || '').trim().slice(0, 2000);
      if (!text) return;
      broadcast(rooms.get(ws.roomId), { type: 'chat', name: ws.name, text, time: Date.now() });
    } else if (msg.type === 'typing' && ws.roomId) {
      for (const c of rooms.get(ws.roomId)) if (c !== ws) send(c, { type: 'typing', name: ws.name });
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomId);
    if (!room) return;
    room.delete(ws);
    if (room.size === 0) { rooms.delete(ws.roomId); roomBg.delete(ws.roomId); }
    else broadcast(room, { type: 'system', text: `${ws.name} đã rời phòng.`, count: room.size });
  });
});

server.listen(PORT, () => console.log(`Chat chạy tại http://localhost:${PORT}`));
