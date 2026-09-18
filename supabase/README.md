# Shiftly Report — Supabase backend

Data lives in 1 Supabase project (free tier is enough). Access is real
per-person login (Admin / Nhân viên), not a single shared password — this
needs the Supabase CLI once to deploy the account-management Edge Function
(step 5 below); everything else is still just pasting SQL into the
dashboard.

## 1. Tạo project

Tạo tài khoản + project mới tại https://supabase.com (gói Free là đủ).

## 2. Chạy schema.sql

Vào project → **SQL Editor** → **New query** → dán toàn bộ nội dung
[`schema.sql`](./schema.sql) → **Run**. Tạo xong bảng `checkpoints`, `meta`,
`logs`, `members`, `member_audit` và toàn bộ các hàm `sync_*` / `is_active_member`
/ `sync_whoami`. An toàn chạy lại file này bất cứ lúc nào sau này khi cập
nhật schema (mọi câu lệnh đều `create or replace` / `create table if not
exists`).

## 3. Bật đăng nhập bằng Email/Password

Vào **Authentication → Providers** → đảm bảo **Email** đang bật. Vào
**Authentication → Settings** → tắt "Confirm email" (app tự tạo tài khoản đã
xác thực sẵn qua Edge Function ở bước 5, không cần người dùng bấm link xác
nhận qua email — nhất là vì tài khoản Nhân viên dùng địa chỉ email giả nội
bộ, không nhận được email nào cả).

## 4. Tạo tài khoản Admin đầu tiên

Chưa có Admin nào thì không ai tạo được tài khoản khác — tạo thủ công 1 lần:

1. **Authentication → Users → Add user** → nhập email + mật khẩu thật của
   bạn → **Create user**.
2. Quay lại **SQL Editor**, chạy (đổi email cho đúng):

   ```sql
   insert into members (user_id, display_name, role)
   select id, 'Admin', 'admin' from auth.users where email = 'ban@congty.com'
   on conflict (user_id) do update set role = 'admin';
   ```

Từ giờ tài khoản này đăng nhập được vào app (chọn tab "🛡️ Admin" ở màn hình
đăng nhập) và thấy mục "👥 Quản lý tài khoản" trong tab Cài đặt để tạo các
tài khoản Nhân viên khác — không cần chạm SQL Editor nữa cho việc này.

## 5. Deploy Edge Function quản lý tài khoản (cần CLI, làm 1 lần)

Việc tạo/vô hiệu hóa tài khoản cần `service_role` key — key này **không bao
giờ** được đặt trong `index.html` (mã nguồn public trên GitHub Pages), nên
việc đó chạy trên 1 Edge Function riêng, do Supabase host.

1. Cài Supabase CLI (1 lần trên máy bạn):
   ```bash
   npm install -g supabase
   ```
2. Đăng nhập + liên kết project (thay `<project-ref>` bằng ID project, lấy ở
   Project Settings → General):
   ```bash
   supabase login
   supabase link --project-ref <project-ref>
   ```
3. Deploy function (đã có sẵn trong `supabase/functions/admin-users/`):
   ```bash
   supabase functions deploy admin-users
   ```
4. Function tự đọc `SUPABASE_URL` và `SUPABASE_SERVICE_ROLE_KEY` từ biến môi
   trường Supabase tự cấp sẵn cho mọi Edge Function — không cần tự khai báo
   gì thêm.

Deploy lại bằng đúng lệnh ở bước 3 mỗi khi sửa
`supabase/functions/admin-users/index.ts`.

## 6. Cấu hình trong app

Supabase URL và Anon public key của project đang dùng đã được đặt cứng sẵn
trong `index.html` (hằng số `DEFAULT_SUPABASE_URL`/`DEFAULT_SUPABASE_ANON_KEY`
ở đầu khối `CLOUD SYNC`) — an toàn vì anon key vốn được thiết kế để công
khai (xem phần bên dưới). Nhờ vậy mở app lên là vào thẳng màn hình đăng
nhập, không cần vào tab Cài đặt gõ tay 2 giá trị này nữa. Chỉ cần đăng nhập
bằng tài khoản Admin vừa tạo ở bước 4 (hoặc 1 tài khoản Nhân viên do Admin
tạo trong tab Cài đặt) — trên mọi thiết bị.

Nếu sau này đổi sang project Supabase khác: sửa 2 hằng số đó trong
`index.html`, hoặc tạm thời trỏ 1 thiết bị sang project khác qua tab Cài đặt
→ mục "☁️ Đồng bộ Supabase" (vẫn nhập/sửa được thủ công ở đó).

## Vì sao an toàn dù mã nguồn public trên GitHub

`anon public key` được thiết kế để lộ ra công khai (Supabase dùng nó y hệt
cách này ở mọi ứng dụng client-side) — bản thân nó không cấp quyền đọc/ghi
gì cả. Mọi bảng dữ liệu thật (`checkpoints`, `meta`, `logs`, `members`,
`member_audit`) đều bật Row Level Security và **không có policy nào** —
nghĩa là không ai đọc/ghi trực tiếp được kể cả khi biết `anon key`. Đường
vào DUY NHẤT là qua các SQL function (`sync_get_checkpoints`, ...), và mỗi
function đó tự kiểm tra người gọi là 1 tài khoản Supabase Auth **đã đăng
nhập thật** và có mặt (chưa bị vô hiệu hóa) trong bảng `members` — không có
tài khoản hợp lệ thì không làm gì cả. Việc tạo/vô hiệu hóa tài khoản chỉ
chạy được qua Edge Function `admin-users` (bước 5), nơi duy nhất giữ
`service_role` key, và function đó tự kiểm tra người gọi phải là Admin trước
khi làm bất cứ điều gì.

## Cập nhật schema sau này

Sửa `schema.sql` xong, dán lại toàn bộ file vào SQL Editor → Run lại (an
toàn, mọi câu lệnh đều idempotent). Sửa
`supabase/functions/admin-users/index.ts` thì deploy lại bằng lệnh ở bước 5.

## Giới hạn cần biết (gói Free)

- Database: 500MB dung lượng, ngủ (pause) sau 1 tuần không có traffic (tự
  đánh thức khi có request tới, chỉ chậm request đầu tiên) — dư dùng cho 1
  nhà máy, dữ liệu chữ + ảnh nén nhỏ.
- Không giới hạn số API request theo ngày ở gói Free (khác Cloudflare
  Workers free tier trước đây).
- Auth: 50.000 người dùng hoạt động hàng tháng (MAU) miễn phí — dư thừa cho
  quy mô 1 nhà máy.
- Edge Functions: 500.000 lượt gọi/tháng miễn phí — mục quản lý tài khoản
  dùng rất ít trong số này (chỉ gọi khi Admin tạo/sửa tài khoản).
- Đồng bộ dùng Realtime Broadcast (gần như tức thời khi kết nối WebSocket
  thành công) + dự phòng bằng chu kỳ polling ~15-20s khi không kết nối
  được — không cần bật/cấu hình gì thêm trong Supabase Dashboard cho việc
  này (khác `postgres_changes`, Broadcast hoạt động ngay không cần thêm
  bảng vào publication).
- Ảnh đính kèm lưu thẳng trong cột `images` (dạng jsonb, chứa base64) của
  bảng `checkpoints` — không dùng Supabase Storage riêng. Nếu sau này khối
  lượng ảnh lớn hơn nhiều (hàng chục nghìn ảnh/tháng), cân nhắc chuyển ảnh
  sang Supabase Storage để nhẹ database hơn.

## Đang dùng bản cũ (mật khẩu chung)?

Nếu project của bạn từng chạy phiên bản `schema.sql` dùng 1 mật khẩu chung
(`set_sync_secret`), chạy lại toàn bộ `schema.sql` mới sẽ tự xóa cơ chế đó
(bảng `app_secret`, hàm `set_sync_secret`/`check_secret`) và chuyển hẳn sang
mô hình tài khoản thật ở trên — làm tiếp từ bước 3.
