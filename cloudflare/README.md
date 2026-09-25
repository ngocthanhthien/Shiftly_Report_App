# Backend Cloudflare (Worker + D1 + R2 + Durable Objects)

Thay thế Supabase (Postgres + Auth + Edge Function + Realtime). **Chưa được frontend sử dụng** — bản web trên GitHub Pages
vẫn chạy bằng Supabase cho tới khi chỉnh `index.html` để chuyển hướng sang đây.

| Thành phần | Vai trò |
|---|---|
| `src/worker.js` | API: `/auth/*` (đăng nhập), `/rpc/sync_*` (cùng tên/định dạng như hàm Postgres cũ), `/admin/users`, `/realtime` (WebSocket) |
| D1 `shiftly` (`schema.sql`) | users, sessions, checkpoints, meta, logs, member_audit |
| R2 `shiftly-images` | nội dung ảnh (D1 chỉ giữ metadata vì giới hạn 2 MB/dòng) |
| Durable Object `Hasher` | kiểm tra/băm mật khẩu (bcrypt cũ → PBKDF2) — Worker gói Free chỉ có 10 ms CPU |
| Durable Object `Hub` | phát tín hiệu Realtime "changed" |

## Triển khai (làm 1 lần, trong thư mục `cloudflare/`)

```bash
npx wrangler login                              # đăng nhập qua trình duyệt
npx wrangler d1 create shiftly                  # chép database_id in ra vào wrangler.toml
npx wrangler r2 bucket create shiftly-images
npx wrangler d1 execute shiftly --remote --file=schema.sql
npx wrangler secret put JWT_SECRET              # nhập chuỗi ngẫu nhiên dài >= 32 ký tự
npx wrangler secret put BOOTSTRAP_TOKEN         # khóa dùng để nhập tài khoản ban đầu
npx wrangler deploy                             # in ra địa chỉ https://shiftly-report-api.<tài-khoản>.workers.dev
```

## Nhập tài khoản từ Supabase (giữ nguyên tên đăng nhập + mật khẩu)

1. Supabase → SQL Editor, chạy rồi lưu kết quả JSON vào `cloudflare/users.json` (file này bị `.gitignore`, chứa hash mật khẩu — XOÁ sau khi nhập):

```sql
select json_build_object('users', json_agg(json_build_object(
  'id', u.id, 'email', u.email, 'username', m.username, 'displayName', m.display_name,
  'role', m.role, 'disabled', m.disabled, 'passwordHash', u.encrypted_password))) as result
from auth.users u join members m on m.user_id = u.id;
```

2. Nhập (chạy lại nhiều lần vẫn an toàn — bỏ qua tài khoản đã có):

```bash
curl -X POST https://<worker-url>/auth/bootstrap -H "Content-Type: application/json" \
  -H "X-Bootstrap-Token: <BOOTSTRAP_TOKEN>" --data @users.json
```

Lần đăng nhập đầu của mỗi người, hash bcrypt tự nâng cấp lên PBKDF2. Xong việc: `npx wrangler secret delete BOOTSTRAP_TOKEN`.
(Chưa có tài khoản nào? Gửi `{"createAdmin":{"email":"...","password":"...","displayName":"..."}}` cùng token để tạo Admin đầu tiên.)

## Giới hạn gói Free đã tính đến

- 50 truy vấn D1 + thao tác R2 mỗi request → mỗi lệnh ghi tối đa 20 dòng; dòng vượt trả `reason:"batch_too_large"`;
  `sync_get_checkpoint_images` trả phần chưa phục vụ trong `pending` (client gọi lại với các key đó).
- 10 ms CPU/request → mật khẩu chạy trong Durable Object; ảnh lưu nguyên chuỗi dataUrl vào R2 (không giải mã base64).
- Trang tải checkpoint: 200 dòng/lần (`hasMore`).

## Kiểm thử

`npm test` — `tests/cloudflare.test.mjs` chạy Worker thật trong workerd cục bộ (Miniflare: D1 + R2 + Durable Object thật).
