# Shiftly Report — Supabase backend

Không cần server riêng, không cần CLI/terminal để triển khai — chỉ 1 project
Supabase (miễn phí) + dán 1 file SQL vào SQL Editor trên trình duyệt.

## Thiết lập (1 lần)

1. Tạo tài khoản + project mới tại https://supabase.com (chọn gói Free là đủ).
2. Vào project vừa tạo → menu bên trái → **SQL Editor** → **New query**.
3. Mở file [`schema.sql`](./schema.sql) trong thư mục này, copy toàn bộ nội
   dung, dán vào SQL Editor → bấm **Run**. Xong — toàn bộ bảng và function
   cần thiết đã được tạo.
4. Đặt mật khẩu đồng bộ — vẫn trong SQL Editor, chạy dòng lệnh sau (đổi
   `mat-khau-cua-ban` thành mật khẩu bạn muốn dùng, càng dài càng khó đoán
   càng tốt):

   ```sql
   select set_sync_secret('mat-khau-cua-ban');
   ```

   Bấm Run. Ghi nhớ mật khẩu này — sẽ nhập lại vào app ở bước dưới. Có thể
   chạy lại lệnh này bất cứ lúc nào để đổi mật khẩu mới.

5. Lấy 2 thông tin cần cho app — vào **Project Settings** (biểu tượng bánh
   răng) → **API**:
   - **Project URL** (dạng `https://xxxxxxxxxxxx.supabase.co`)
   - **anon public** key (chuỗi dài ở mục "Project API keys")

## Cấu hình trong app

Mở `index.html` (bản đã publish qua GitHub Pages, hoặc mở trực tiếp file)
→ tab **Cài đặt** → mục "☁️ Đồng bộ Supabase" → nhập:
- **Supabase URL**: URL lấy ở bước 5.
- **Anon public key**: key lấy ở bước 5.
- **Mật khẩu đồng bộ**: đúng giá trị đã đặt ở bước 4.

Bấm "💾 Lưu & Kết nối". Từ đó app tự đẩy/kéo dữ liệu mỗi khi có mạng, không
cần thao tác gì thêm. Lặp lại đúng 3 giá trị này trên mọi thiết bị khác
muốn dùng chung dữ liệu.

## Vì sao an toàn dù mã nguồn public trên GitHub

`anon public key` được thiết kế để lộ ra công khai (Supabase dùng nó y hệt
cách này ở mọi ứng dụng client-side) — bản thân nó không cấp quyền đọc/ghi
gì cả. Mọi bảng dữ liệu thật (`checkpoints`, `meta`, `logs`) đều bật Row
Level Security và **không có policy nào** — nghĩa là không ai đọc/ghi trực
tiếp được kể cả khi biết `anon key`. Đường vào DUY NHẤT là qua các SQL
function (`sync_get_checkpoints`, `sync_put_checkpoints`, ...), và mỗi
function đó tự kiểm tra mật khẩu đồng bộ bạn đặt ở bước 4 trước khi làm bất
cứ điều gì — mật khẩu này KHÔNG nằm trong mã nguồn, chỉ nằm trong Cài đặt
của từng thiết bị (lưu trong IndexedDB, gửi kèm mỗi lần gọi function).

## Cập nhật schema sau này

Sửa `schema.sql` xong, copy đoạn mới/thay đổi (hoặc cả file — các câu lệnh
đều dùng `create or replace` / `create table if not exists` nên chạy lại
toàn bộ file cũng an toàn) rồi dán vào SQL Editor → Run lại.

## Giới hạn cần biết (gói Free)

- Database: 500MB dung lượng, ngủ (pause) sau 1 tuần không có traffic (tự
  đánh thức khi có request tới, chỉ chậm request đầu tiên) — dư dùng cho 1
  nhà máy, dữ liệu chữ + ảnh nén nhỏ.
- Không giới hạn số API request theo ngày ở gói Free (khác Cloudflare
  Workers free tier trước đây).
- Đồng bộ dùng Realtime Broadcast (gần như tức thời khi kết nối WebSocket
  thành công) + dự phòng bằng chu kỳ polling ~15-20s khi không kết nối
  được — không cần bật/cấu hình gì thêm trong Supabase Dashboard cho việc
  này (khác `postgres_changes`, Broadcast hoạt động ngay không cần thêm
  bảng vào publication).
- Ảnh đính kèm lưu thẳng trong cột `images` (dạng jsonb, chứa base64) của
  bảng `checkpoints` — không dùng Supabase Storage riêng. Nếu sau này khối
  lượng ảnh lớn hơn nhiều (hàng chục nghìn ảnh/tháng), cân nhắc chuyển ảnh
  sang Supabase Storage để nhẹ database hơn.
