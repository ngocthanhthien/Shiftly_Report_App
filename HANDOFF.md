# HANDOFF — Shiftly Report App

Tài liệu bàn giao cho phiên AI/công cụ khác. Cập nhật lần cuối: **2026-10-06**. Lịch sử chi tiết các tính năng đến 2026-09-25 (thời Supabase) nằm ở [`docs/HANDOFF_2026-09-25_supabase-era.md`](docs/HANDOFF_2026-09-25_supabase-era.md) — chỉ tham khảo, phần backend trong đó đã lỗi thời.

---

## 1. Dự án là gì

Ứng dụng ghi nhận báo cáo QC theo ca sản xuất cà phê (ILD Coffee Vietnam): **một file `index.html` duy nhất** (HTML+CSS+JS inline, tiếng Việt, không có bước build), PWA offline-first. Dữ liệu luôn lưu trước trong IndexedDB của máy, rồi đồng bộ lên backend khi có mạng.

- **Frontend**: [`index.html`](index.html) — publish bằng GitHub Pages tại `https://ngocthanhthien.github.io/Shiftly_Report_App/` (đẩy lên `main` là tự cập nhật sau ~1 phút).
- **Backend (từ 2026-09-25)**: **Cloudflare** — thư mục [`cloudflare/`](cloudflare/README.md). **Không còn dùng Supabase** (xem mục 6).

## 2. Kiến trúc backend Cloudflare

Worker `shiftly-report-api` tại `https://shiftly-report-api.dangthanhbinh53.workers.dev` (mã: [`cloudflare/src/worker.js`](cloudflare/src/worker.js); cấu hình: [`cloudflare/wrangler.toml`](cloudflare/wrangler.toml); schema: [`cloudflare/schema.sql`](cloudflare/schema.sql)). Gói **Free**.

| Thành phần | Dùng để |
|---|---|
| **D1** `shiftly` | users, sessions, checkpoints (cột `seq`), meta, logs, member_audit, counters, login_attempts |
| **R2** `shiftly-images` | nội dung ảnh (khóa `cp/<key>/<ts>`); D1 chỉ giữ metadata ảnh vì giới hạn **2 MB/dòng** |
| **Durable Object `Hasher`** | kiểm/băm mật khẩu (Worker Free chỉ có 10 ms CPU; bcrypt không đủ) |
| **Durable Object `Hub`** | Realtime: phát chữ `changed` tới các WebSocket đang mở (`/realtime?token=`) |

**Giao diện HTTP** (giữ cùng tên/định dạng như hàm Postgres của bản Supabase để `cloudFetch()` ít đổi):
- `POST /rpc/<fn>` với `sync_whoami, sync_get_checkpoints, sync_get_checkpoint_images, sync_put_checkpoints, sync_delete_checkpoints, sync_get_meta, sync_put_meta, sync_post_logs, sync_get_logs`. Lỗi quyền trả **HTTP 200 + `{error:'unauthorized'|'forbidden_role'}`** (cloudFetch xử lý một chỗ).
- `POST /auth/login | /auth/refresh | /auth/logout` — JWT HS256 ~1 giờ + refresh token (băm SHA-256 trong D1, xoay vòng mỗi lần làm mới).
- `POST /admin/users` (chỉ Admin): `list-users, create-user, change-role, disable-user, enable-user`.
- `POST /auth/bootstrap` (header `X-Bootstrap-Token`): nhập tài khoản hàng loạt / tạo Admin đầu tiên. Chạy lại an toàn.
- CORS chỉ cho origin trong biến `ALLOWED_ORIGINS` (hiện chỉ `https://ngocthanhthien.github.io`).

**Quy tắc phải giữ nguyên:**
1. **Cursor đồng bộ là `seq` do server gán** (bảng `counters` tăng nguyên tử trong cùng `db.batch` với lần ghi). KHÔNG bao giờ đổi sang timestamp/đồng hồ máy khách (bản Cloudflare đời đầu từng lệch đồng hồ làm mất dữ liệu).
2. **Last-write-wins theo `updatedAt`** (so chuỗi ISO), ở cả client lẫn server. Ngoại lệ có chủ đích: cùng `updatedAt` nhưng lần này **kèm ảnh khác** thì vẫn nhận (đường thử lại ảnh bị hoãn).
3. **Giới hạn gói Free: 50 thao tác D1+R2 mỗi request.** Vì vậy: ghi tối đa **20 dòng/lần** (dòng dư trả `reason:'batch_too_large'`), chi phí mỗi dòng = 2 + số ảnh, `PUSH_MAX_COST=40` ở client; `sync_get_checkpoint_images` trả phần chưa phục vụ trong `pending`; trang tải checkpoint = 200 dòng. Đừng nâng các con số này mà không đổi gói.
4. **Quyền ở SERVER mỗi request** (bảng `users`: còn hoạt động, đúng vai trò): supervisor không ghi; khóa meta `egressControl` chỉ Admin ghi. Client chỉ ẩn nút cho tiện.
5. Nhật ký (`logs`) chỉ giữ **10 dòng mới nhất** (server tự xoá phần cũ sau mỗi lần ghi).
6. Xoá/đổi ảnh: chỉ xoá đối tượng R2 của dòng **thật sự được ghi** (tránh xoá nhầm khi thua cuộc đua).

**Secrets đã đặt trên Worker** (giá trị không nằm trong repo): `JWT_SECRET`, `BOOTSTRAP_TOKEN`. Sau khi mọi người đăng nhập ổn định nên xoá `BOOTSTRAP_TOKEN`: `cd cloudflare && npx wrangler secret delete BOOTSTRAP_TOKEN`.

**Triển khai lại Worker** (sau khi sửa `worker.js`): `cd cloudflare && npx wrangler deploy` (đã `npx wrangler login` trên máy chủ phát triển). Sửa schema: thêm câu `ALTER`/`CREATE ... IF NOT EXISTS` vào `schema.sql` rồi `npx wrangler d1 execute shiftly --remote --file=schema.sql`. Xem dữ liệu: `npx wrangler d1 execute shiftly --remote --command "SELECT ..."`.

## 3. Tài khoản & đăng nhập

- 3 vai trò: `admin` (toàn quyền), `user` (Nhân viên, nhập liệu), `supervisor` (Giám sát, chỉ xem).
- Admin đăng nhập bằng **email**, Nhân viên/Giám sát bằng **tên đăng nhập** + mật khẩu — **giữ nguyên tài khoản/mật khẩu cũ**: hash bcrypt được nhập từ Supabase (`/auth/bootstrap`), tự nâng cấp sang PBKDF2 ở lần đăng nhập đầu của mỗi người. Hiện có **5 tài khoản** (2 Admin, 3 Nhân viên).
- Client lưu phiên ở `localStorage['shiftly-cf-auth']`. Mất mạng vẫn vào app bằng phiên đã lưu (offline-first); lần đồng bộ có mạng kế tiếp mới kiểm lại quyền thật. Làm mới phiên hỏng chỉ vì mạng KHÔNG đá người dùng ra; chỉ khi server từ chối.
- Giới hạn đoán mật khẩu: 8 lần sai / 15 phút theo (IP, tên) → HTTP 429.
- Chỉ Admin thấy mục "👥 Quản lý tài khoản" ở tab Cài đặt (gọi `/admin/users`).
- Còn một mật khẩu cứng `APP_PASSWORD = '1234'` trong `index.html` — chỉ để chặn một số thao tác nhạy cảm trong app (xoá hàng loạt Specs, sửa PO đã đóng…). **Độc lập** với đăng nhập ở trên, đừng nhầm.

## 4. Frontend — những điều cần biết

**Thứ tự tab mặc định:** Nhập liệu, Báo cáo, Dữ liệu, Danh sách Items Code, Danh sách Client, Specs, Data Log, Danh sách PO, Cài đặt, Hướng dẫn (10 tab; đã bỏ tab Thống kê, tab Xuất nhập dữ liệu gộp vào **Cài đặt**).
**Nhân viên mặc định chỉ thấy:** Nhập liệu, Báo cáo, Dữ liệu, Items Code, Hướng dẫn. Admin luôn thấy đủ và chỉnh được ở Cài đặt → "Sắp xếp & Ẩn/hiện Tab". Cấu hình lưu có số phiên bản (`TAB_CONFIG_VERSION`, hiện 4): đổi bố cục mặc định thì tăng số này để mọi máy nhận mặc định mới.

**Các module chính trong `index.html`** (dùng `grep -n "^function \|^async function "` để lấy số dòng hiện tại, đừng tin số dòng cũ):
- Đồng bộ: `cloudFetch` (cửa duy nhất gọi server, tự làm mới phiên và thử lại 1 lần), `pullFromCloud`, `flushOutbox` (đẩy + kéo, chia lô theo dung lượng và `PUSH_MAX_COST`), `persistAll`, `queueMetaSync`, `applyRemoteMeta`, `stripLocalMarkers`, `startRealtime/stopRealtime` (WebSocket, tự kết nối lại, rơi về polling), `baseSyncDelay`.
- Đăng nhập: `checkAccessGate`, `verifyAndEnter`, `loginRequest`, `currentAccessToken`, `onAccessRevoked`, `renderLoginGate`, `adminUsersCall`.
- Thiết bị cũ còn lưu địa chỉ Supabase → `loadCloudState()` tự đổi sang Worker mặc định (`DEFAULT_API_URL`), đặt lại cursor một lần (khóa `meta.backend='cloudflare-v1'`), **giữ outbox chưa gửi**.
- Sao lưu JSON **v2**: `buildBackupJson()` = `{version:2, checkpoints (kèm ảnh), meta:{schema,poList,clientList,itemCodeList,technicians,poClosures,tabConfig,egressControl}}`. Phục hồi dùng `forUpload()` (bỏ `_syncedAt/_imagesSyncedFp` để bản ghi tự lên server) rồi `scheduleFlush()` — **không** dùng `persistAll()` cho nạp hàng loạt (O(n²)). File JSON cũ (mảng trần) vẫn đọc được.
- Data Log: `logChange` ghi User/Máy (ID `PC-XXXXXXXX` + tên gợi nhớ)/Hành động; `LOG_MAX = 10`; tab đọc từ server qua `sync_get_logs` khi mở/làm mới.
- **Data & Egress Control** (Cài đặt): trần MB/ngày Soft/Hard do Admin đặt (mặc định 100/200), 3 trạng thái 🟢 Normal / 🟠 Data Saving / 🔴 Protection, đếm traffic ước tính **cục bộ** trong `cloudFetch` (không gọi mạng để đo). Protection: hoãn đẩy ảnh mới (ảnh vẫn nằm trong IndexedDB, dòng giữ "dirty" để tự gửi lại), chặn "Đồng bộ lại từ đầu", giãn polling; **không bao giờ chặn nhập/lưu QC**. Extra MB/Unlock Today hết hiệu lực khi sang ngày (so ngày lưu với `todayStr()`).
- Banner cảnh báo đồng bộ ở tab Nhập liệu cập nhật live (`updateInputSyncBanner`), không còn là ảnh chụp lúc vẽ form.
- Section FOAMING và REWORK đã **xoá vĩnh viễn** khỏi Specs (`REMOVED_SECTION_IDS`/`stripRemovedSections`); checkpoint cũ của chúng giữ nguyên trong dữ liệu nhưng không hiển thị/được chọn.
- Báo cáo "Theo PO" là biểu đồ Gantt Process×Date×Shift (có sửa Issue/Action ngay trên ô, nút xoá), xuất PDF khổ ngang, Excel/PDF theo mẫu đều có Gantt.

## 5. Kiểm thử

`npm ci && npm test` — **145 test, đều qua** (Node `node:test`, `jsdom`, `fake-indexeddb`):
- `tests/cloudflare.test.mjs`: Worker THẬT (esbuild đóng gói, chạy trong workerd qua **Miniflare 4**: D1/R2/Durable Object thật) — auth, vai trò, last-write-wins, cursor `seq`, ảnh/R2, meta, nhật ký, admin API, WebSocket, giới hạn gói Free.
- `tests/cloudflare-frontend.test.mjs`: app thật (jsdom) ↔ Worker thật — đăng nhập bằng tài khoản bcrypt, đồng bộ 2 máy kèm ảnh, vô hiệu hóa giữa phiên, sao lưu JSON v2, tự chuyển cấu hình từ Supabase, nạp hàng loạt. Helper: `tests/helpers/cf-backend.mjs`.
- Các file còn lại: UI/logic từng tab (Nhập liệu, Items Code, Specs, Báo cáo/Gantt, Data Log, tab config, Egress…). Mỗi lần boot jsdom, test **gài sẵn phiên đăng nhập** vào `localStorage` và tắt `WebSocket` để app vào thẳng giao diện, không gọi mạng.
- `tests/supabase.test.mjs` và các test PGlite ở nửa cuối `tests/egress-control.test.mjs` kiểm **bản SQL Supabase cũ** (`supabase/schema.sql`) — chỉ còn là bản chụp lịch sử; có thể xoá cùng thư mục `supabase/` khi chắc chắn không quay lại.
- Cạm bẫy khi viết test: `document.body.textContent` của jsdom **chứa cả mã nguồn trong thẻ `<script>`** → luôn giới hạn vào `#view-...`; JSON không mang được `Infinity`; `window.confirm/print` cần stub; `location.reload` không ghi đè được; hàng đợi gửi chạy nền nên dùng vòng chờ "đã đồng bộ hết" thay cho `setTimeout` cố định.

## 6. Việc đã xong / còn lại

**Đã xong (2026-09-25):** chuyển hoàn toàn backend sang Cloudflare; nhánh đã gộp vào `main`, GitHub Pages chạy bản mới; dữ liệu nạp từ máy Admin bằng JSON (69 điểm kiểm tra, 9 ảnh); tài khoản Admin và Nhân viên đã đăng nhập thử thật. Thẻ git **`pre-cloudflare`** = bản Supabase cuối cùng (để lùi nếu cần).

**Còn lại / cần người quyết định:**
1. **Danh mục tuỳ chỉnh có thể chưa lên server.** Lần kiểm tra cuối, D1 chỉ có 3 khóa meta (`itemCodeList`, `schema`, `technicians` = đúng 5 tên mặc định). Chưa có `poList`, `clientList`, `poClosures`, `tabConfig`, `egressControl`. Nếu máy Admin có Danh sách PO/Client/đóng PO tuỳ chỉnh thì cần nạp lại: tải lại **JSON v2** (dòng đầu file phải là `{` và có `"version": 2`) rồi "Phục hồi từ JSON"; hoặc thêm nút "Đẩy danh mục lên máy chủ" trong Cài đặt (chưa làm).
2. **Chưa thử** đăng nhập các tài khoản Nhân viên còn lại (`cam.do`, `dung.tran`, `qaline@ild-coffee.com`).
3. **Project Supabase vẫn còn tồn tại** — người dùng định xoá. Việc này **không hoàn tác được**; chỉ nên làm sau khi mục 1–2 xong và chạy ổn vài ngày. Sau đó: xoá `BOOTSTRAP_TOKEN` (mục 2) và xoá thư mục `supabase/` cùng 2 nhóm test cũ ở mục 5 (hoặc giữ làm lưu trữ).
4. Theo dõi tuần đầu trên dashboard Cloudflare: request/ngày (trần Free 100.000), D1 (500 MB, đọc 5 triệu/ghi 100.000 dòng/ngày), R2 (10 GB).
5. Chưa thử Realtime với nhiều máy thật cùng lúc (mới thử trong test tự động và 1 trình duyệt); nếu lỗi, app vẫn tự đồng bộ bằng polling.
6. Tối ưu băng thông (nếu cần): ảnh là phần nặng nhất; có thể nén mạnh hơn/giới hạn số ảnh, giãn polling.

## 7. Lưu ý làm việc

- Máy phát triển là Windows + Git Bash. **Heredoc dài chứa dấu nháy trong Bash hay lỗi** — ghi file bằng công cụ ghi file rồi chạy, thay vì nhét script dài vào lệnh.
- Không commit dữ liệu nhạy cảm: file xuất tài khoản (`cloudflare/users*.json`, chứa hash mật khẩu) đã nằm trong `.gitignore`; xoá ngay sau khi dùng.
- Xem trước giao diện: `.claude/launch.json` có cấu hình `static` (python http.server cổng 8934); thêm `http://localhost:8934` vào `ALLOWED_ORIGINS` TẠM THỜI nếu muốn gọi Worker thật từ localhost, rồi gỡ ra và deploy lại.
- Ngôn ngữ giao diện, thông báo, comment: tiếng Việt, giữ phong cách hiện có. Yêu cầu của người dùng luôn kèm "không đổi ngoài phạm vi" — sửa tối thiểu, không refactor lớn.
