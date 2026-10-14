# Vợ chồng nghèo

Web chat realtime cho 2 người: nhắn tin, gửi ảnh, đồng bộ hình nền, gọi thoại và video (WebRTC).
Mỗi phòng có mật khẩu (người đầu tiên vào đặt), lịch sử được lưu lại.

## Chạy local
```
npm install
npm start
```
Mở http://localhost:3000, hai người nhập cùng mã phòng và mật khẩu.
Không đặt `MONGODB_URI` thì dữ liệu lưu ở `data/history.json`.

## Lưu dữ liệu bền với MongoDB Atlas
Đặt biến môi trường `MONGODB_URI` (chuỗi kết nối Atlas). Tùy chọn: `MONGODB_DB` (mặc định `vochongngheo`).

## Deploy (Render)
- Build command: `npm install`
- Start command: `npm start`
- Environment: `MONGODB_URI`
