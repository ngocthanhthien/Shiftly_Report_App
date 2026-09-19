# HANDOFF — Shiftly Report App

Tài liệu bàn giao để tiếp tục làm việc ở phiên AI/công cụ khác. Cập nhật lần cuối: 2026-09-18.

---

## 1. Tổng quan project

Ứng dụng ghi nhận báo cáo QC theo ca sản xuất cà phê (ILD Coffee Vietnam), single-file PWA offline-first.

**Kiến trúc hiện tại — GitHub Pages (hosting) + Supabase (dữ liệu + Auth) + 1 Edge Function (quản lý tài khoản). KHÔNG còn Cloudflare** (đã gỡ bỏ hoàn toàn trong phiên 2026-09-18 — trước đó có 2 Cloudflare Workers, `worker.js`/`wrangler.jsonc`/`cloudflare/` — các file này đã bị xoá, đừng tái tạo lại trừ khi người dùng yêu cầu quay lại):

1. **Frontend**: [index.html](index.html) — file tĩnh, publish qua GitHub Pages, không có build step. Bảo vệ dữ liệu dựa vào đăng nhập Supabase Auth thật (mục 2 dưới) khi có cấu hình đồng bộ — nếu KHÔNG cấu hình Đồng bộ Supabase, app chạy đúng như bản gốc, không cần đăng nhập gì cả (offline-only vẫn hoạt động y hệt trước).
2. **Backend**: Supabase (Postgres + Auth) — xem [`supabase/schema.sql`](supabase/schema.sql) + [`supabase/README.md`](supabase/README.md). App gọi thẳng PostgREST RPC endpoint của Supabase, xác thực bằng access token của phiên đăng nhập thật (KHÔNG còn dùng `anon` key làm Authorization — `anon` key giờ chỉ còn nằm ở header `apikey`). Mọi bảng thật (`checkpoints`, `meta`, `logs`, `members`, `member_audit`) bật RLS và **không có policy nào** → chặn hết truy cập REST trực tiếp kể cả khi đã đăng nhập. Đường vào duy nhất là các SQL function `sync_get_checkpoints`/`sync_put_checkpoints`/`sync_delete_checkpoints`/`sync_get_meta`/`sync_put_meta`/`sync_post_logs`/`sync_whoami` (SECURITY DEFINER), mỗi function (trừ `sync_whoami`) tự gọi `is_active_member()` để kiểm tra người gọi là 1 dòng còn hoạt động (`disabled=false`) trong bảng `members`, khớp với `auth.uid()` của phiên đăng nhập.
3. **Access control (thêm 2026-09-18, thay thế mô hình mật khẩu chung cũ)** — 2 loại tài khoản, đều là tài khoản Supabase Auth thật:
   - **Admin**: đăng nhập bằng email + mật khẩu thật.
   - **User (Nhân viên)**: đăng nhập bằng tên đăng nhập + mật khẩu — Supabase Auth chỉ biết email/phone nên tài khoản username được gán 1 email giả nội bộ `<username>@<project-ref>.users.internal` (người dùng không bao giờ thấy/gõ địa chỉ này) — logic ghép y hệt ở cả [index.html (`shadowAuthDomain`)](index.html) và [`supabase/functions/admin-users/index.ts`](supabase/functions/admin-users/index.ts), phải sửa đồng thời cả 2 nơi nếu đổi công thức này.
   - Tạo/đổi vai trò/vô hiệu hóa tài khoản CHỈ chạy qua Edge Function `admin-users` (cần `service_role` key — không bao giờ đặt trong `index.html`); Admin gọi từ mục "👥 Quản lý tài khoản" trong tab Cài đặt (chỉ Admin thấy mục này). Deploy function này cần Supabase CLI 1 lần — xem `supabase/README.md` mục 5. Tài khoản Admin **đầu tiên** phải tạo thủ công qua Supabase Dashboard + 1 câu SQL (mục 4 trong `supabase/README.md`), vì chưa có Admin nào thì Edge Function tự chặn (yêu cầu caller đã là Admin).
   - Toàn bộ app (kể cả nhập liệu offline-local) bị chặn sau màn hình đăng nhập MỘT KHI đã cấu hình Đồng bộ Supabase — xem module `ACCESS CONTROL` đầu `index.html` (`checkAccessGate`/`verifyAndEnter`/`onAccessRevoked`/`renderLoginGate`). Phiên đăng nhập persist qua `supabase-js` (`persistSession:true`, `storageKey:'shiftly-auth'`) nên không cần đăng nhập lại mỗi lần mở app — nhưng MỌI lần gọi sync đều tự re-verify qua `sync_whoami`/`is_active_member()`, nên nếu Admin vô hiệu hóa 1 tài khoản, thiết bị đó bị đá về màn hình đăng nhập ngay ở lần gọi kế tiếp, kể cả đang mở sẵn.
4. Ảnh đính kèm đi thẳng trong cột `images` (jsonb, base64 `dataUrl`) của mỗi checkpoint — **không** có bảng/endpoint ảnh riêng.
5. Con trỏ đồng bộ (`seq`) là 1 Postgres SEQUENCE, gán theo thứ tự ghi ở server (KHÔNG dùng đồng hồ client) — quan trọng: đừng bao giờ đổi cursor sang dùng timestamp lại, xem comment trong `supabase/schema.sql` và mục `CLOUD SYNC` đầu `index.html` để hiểu lý do (bug lệch đồng hồ đã từng xảy ra thật với bản Cloudflare).
6. **Realtime** — mỗi lần đẩy dữ liệu thành công, app phát 1 tín hiệu "vừa có thay đổi" qua kênh Broadcast public tên `shiftly-changes`; máy khác nhận tín hiệu → gọi lại đúng `pullFromCloud()` đã có (debounce 400ms). **Cố tình dùng Broadcast, không dùng `postgres_changes`**: `postgres_changes` chỉ gửi được sự kiện cho client có quyền SELECT theo RLS, mà các bảng chính không có policy nào (xem mục 2) — dùng `postgres_changes` sẽ phải nới RLS, để lộ dữ liệu cho bất kỳ ai đã đăng nhập (kể cả người chưa được cấp `members`), phá vỡ mô hình bảo mật đã chọn. Cần load `@supabase/supabase-js` qua CDN trước thẻ `<script>` chính — nếu load lỗi (CDN chặn, offline), `ensureSupabaseClient()` trả `null`, Realtime tự no-op, app rơi về polling ~15-20s, không crash; nhưng lưu ý: nếu SDK không load được thì màn hình đăng nhập cũng không hoạt động được (`checkAccessGate` cũng "fail open" — cho vào thẳng app luôn thay vì khoá cứng, xem comment trong hàm) vì không có cách nào xác thực — đây là đánh đổi có chủ đích để tránh khoá chết người dùng khi CDN bị chặn, KHÔNG phải lỗi. **Chưa test được kết nối Realtime thật với 1 project Supabase sống** (không có sandbox mạng ngoài) — đã test kỹ nhánh "SDK không load được" và toàn bộ luồng auth+sync qua PGlite/jsdom (xem mục Test).

**Đã ÁP DỤNG (2026-09-18, đảo ngược quyết định trước đó cùng ngày)** mô hình 2 tầng tài khoản thật từ skill `supabase-sync-auth-patterns` (`references/access-management.md`), theo yêu cầu rõ ràng của người dùng để có "ngăn truy cập, quản lý tài khoản, đồng bộ realtime" giống hệt project song song [CloseCAPGMP](https://github.com/ngocthanhthien/CloseCAPGMP) (`C:\Users\BinhDang\Documents\GitHub\CloseCAPGMP`) — xem `HANDOFF_WEB.md`/`README.md` của project đó để đối chiếu chi tiết pattern gốc (bảng `gmp_members`, Edge Function `admin-users`, username→email nội bộ). Đánh đổi được người dùng xác nhận rõ: cần cài Supabase CLI 1 lần để deploy Edge Function (trước đó Shiftly cố tình giữ "không cần CLI, chỉ dán SQL"); đổi lại có tài khoản riêng từng người + Admin tự quản lý được, không còn 1 mật khẩu chung.

**App chính**: [index.html](index.html) (~4700+ dòng sau khi thêm access control, single file, HTML+CSS+JS inline, tiếng Việt). 13 tab: Nhập liệu, Dữ liệu, Truy xuất, Danh sách PO/Recipe/Client, Data Log, Báo cáo, Thống kê, Specs, Xuất nhập dữ liệu, Cài đặt, Hướng dẫn.

**Data model cốt lõi:**
- `SCHEMA` (khai báo `DEFAULT_SCHEMA`/`SCHEMA` gần đầu script) — mảng section: `ROA, EXT, EVA, FOAMING, FD, FP, REWORK, META`. Mỗi section có `fields[]` (type: number/boolean/text/textarea/select; có `hardMin/hardMax`, `recipeOverrides` theo Recipe, `trueLabel/falseLabel` cho boolean).
- **Checkpoint** = 1 lần nhập cho 1 section trong 1 ca, key = `date_shift_section_po` ([checkpointKey](index.html:424)). Lưu IndexedDB store `shifts`, đồng bộ Supabase qua outbox pattern (`queueOutbox`/`flushOutbox`).
- Danh mục phụ: `TECHNICIANS`, `RECIPES` (`RECIPE_OPTIONS`), `PO_LIST`, `CLIENT_LIST` — quản lý ở các tab list riêng.

**Các hàm/khu vực quan trọng để sửa** (đúng tại thời điểm 2026-09-18 — chạy lại `grep -n "^function \|^async function "` nếu nghi ngờ đã lệch do sửa code sau này):
- Nhập liệu: [renderInputForm](index.html:1531), [renderField](index.html:2007), [renderAutocomplete](index.html:1886)
- Xem/tra cứu: [renderTable](index.html:2081), [renderDetail](index.html:2259), [renderTrace](index.html:2759)
- Danh mục: [renderPOList](index.html:2388), [renderRecipeList](index.html:2512), [renderClientList](index.html:2581)
- Audit: [renderDataLog](index.html:2698), [logChange](index.html:506)
- Báo cáo (ảnh SVG để share/in): [renderReport](index.html:3415), [buildReportSVG](index.html:3317), [buildImagesLineForCheckpoint](index.html:3303), [renderLinesToSVG](index.html:2899)
- Báo cáo HTML (file .html đầy đủ để mở/share): [buildFullHtmlReport](index.html:3186), [fullHtmlReportCheckpointCard](index.html:3165)
- Thống kê: [renderStats](index.html:3582), [drawSPC](index.html:3745)
- Chỉnh schema: [renderSpecs](index.html:3817)
- Export/Import: [renderShare](index.html:4089), [buildCsv](index.html:631), [computeHeaderMap](index.html:338), [buildExcelXml](index.html:657)
- Cài đặt: [renderSettings](index.html:4437) (cloud sync config: Supabase URL/anon key), [renderMemberManagementCard](index.html) (Admin-only, ngay trước `renderSettings`)
- Sync layer: [cloudFetch](index.html:934) (gọi PostgREST RPC bằng access token của phiên đăng nhập), [pullFromCloud](index.html:1060), [flushOutbox](index.html:1107), [armSync/wakeSync](index.html:1221), [startRealtime/pingRealtimeChanged](index.html:1277) (Broadcast, optional best-effort)
- **Access control (mới)**: module `ACCESS CONTROL` ngay sau module Realtime trong `index.html` — `checkAccessGate`, `verifyAndEnter`, `onAccessRevoked`, `signInAdmin`/`signInUser`, `signOutCloud`, `renderLoginGate`. Login gate DOM: `#loginGate` (đầu `<body>`), toggle ẩn/hiện với `#appRoot`.

Ghi chú bảo mật: mật khẩu app hardcode `const APP_PASSWORD = '1234'` ở [index.html:496](index.html:496) — dùng cho `promptPasswordOK()` (gate 1 số thao tác nhạy cảm trong app, VD xoá dữ liệu, sửa PO đã đóng), KHÁC HẲN với đăng nhập Supabase Auth ở trên — 2 lớp độc lập, đừng nhầm lẫn khi sửa 1 trong 2.

**Test**: `npm ci && npm test` — chạy schema.sql THẬT qua Postgres nhúng (`@electric-sql/pglite`, không phải giả lập, có thêm stand-in `auth.users`/`auth.uid()` CHỈ trong test harness để mô phỏng Supabase Auth thật) + boot toàn bộ app qua jsdom rồi đăng nhập + đồng bộ thật qua đúng luồng RPC, kể cả case tài khoản bị vô hiệu hóa giữa phiên bị đá về màn hình đăng nhập, vai trò supervisor bị chặn ghi, và tính năng xuất Process/QMS (Item Code, cờ isQMS, định dạng ngày, không lộ ảnh). 28 test / 4 file, tất cả đang pass: `tests/supabase.test.mjs`, `tests/input-draft.test.mjs`, `tests/tab-config.test.mjs`, `tests/process-qms-export.test.mjs`. **Chưa/không thể test được**: Edge Function `admin-users` (chạy trên Deno, không có runtime Deno trong môi trường test này) — chỉ được review code thủ công, chưa chạy tự động; nếu sửa file này, test bằng tay qua Supabase Dashboard → Edge Functions → Invoke, hoặc deploy thật rồi thử qua UI "👥 Quản lý tài khoản".

---

## 2. Nội dung file feedback `SHIFTLY REPORT PAPERLESS.xlsx`

File có **1 sheet** (`Sheet1`, A1:R12), không phải nhiều tab. Gồm 2 phần:

### 2a. Bảng mẫu định dạng dữ liệu mong muốn (cột A–L)

Cột chung, nhóm merge **"MAIN INFORMATION"** (A1:G1): `Date | Shift | Process | Item Code | PO | ISSUES/Abnormal | ACTION`

Cột **"QMS"** (H1:L1, merge), khác nhau theo từng block Process (mỗi block là 1 mini-bảng lặp lại header):

| Process | Cột QMS trong mẫu |
|---|---|
| ROA | Moisture, Color |
| EXT | %TC, Cupping |
| EVA | TS, pH, Sediment set tank 2, Sediment Clarifier, Cupping |
| FD | (không có cột QMS nào) |
| FP | Moisture, Color, Density, Sediment, Cupping |

Dữ liệu mẫu ví dụ (dòng A4): Date=`2026-01-10`, Shift=`1`, Process=`ROA`, Item Code=`1100011`, PO=`612600011`. Cột A2 ghi chú format ngày mong muốn: **`dd-mmm-yyy`** (kiểu `10-Jan-2026`), khác định dạng `DD/MM/YYYY` app đang dùng ([fmtDateVN](index.html:397)).

### 2b. Ba khối ghi chú yêu cầu (cột O, dịch ý):

1. **Yêu cầu xuất dữ liệu**: xuất theo đúng Process/Format ở bảng trên, **không xuất hình ảnh**; đặc biệt lưu ý định dạng ngày và định dạng Item Code; dữ liệu tự động xuất về 1 vị trí sau khi share báo cáo.
2. **Yêu cầu báo cáo**: giữ format báo cáo theo ca; **bỏ "Parameters" chỉ giữ lại "QMS"** như bảng trên; ảnh phải kéo full chiều rộng báo cáo; phải hiển thị Recipe.
3. **Quy trình nhập liệu**: Chọn Processing → Nhập PO → Chọn Recipe, chọn Technician; **trong lúc nhập không được reset dữ liệu** đã nhập trước/sau; dữ liệu chỉ reset toàn bộ khi KHÔNG bấm Lưu.

---

## 3. Đối chiếu feedback ↔ code hiện tại

### ✅ Yêu cầu (3) — Bug mất dữ liệu khi nhập — ĐÃ SỬA (2026-09-18)

Nguyên nhân đã xác nhận: [renderInputForm](index.html:1307) trước đây chỉ ghi giá trị các ô chỉ tiêu vào `cp.fields` tại thời điểm bấm Lưu; đổi PO/Recipe/Client (hoặc Section khi thêm mới) trigger `renderInputForm()` chạy lại, tạo checkpoint trắng mới, xoá sạch giá trị đã gõ.

**Đã sửa bằng cơ chế draft**: `renderInputForm._draft` — mỗi lần đổi PO (autocomplete `onChange`)/Recipe/Client, gọi `captureDraft()` (đọc giá trị hiện tại từ `fieldEls`/`noteEls`) TRƯỚC khi gọi lại `renderInputForm()`; khi dựng lại form, draft được áp lại vào `cp.fields`/`cp.fieldNotes` nếu `draftScope` khớp (`edit:<key>` khi sửa, `new:<section>` khi thêm mới — đổi Section vẫn reset đúng như mong muốn, vì đó là 2 bộ field khác nhau). Draft bị xoá (`renderInputForm._draft = null`) ở mọi điểm mở lại form cho 1 checkpoint khác hoặc bấm Đóng/Thêm mới — khớp đúng yêu cầu "chỉ reset toàn bộ khi KHÔNG bấm Lưu". Có guard `fieldsRendered` tránh lỗi truy cập biến `const` chưa khởi tạo khi PO còn rỗng (render pass thoát sớm trước khi field UI được tạo). Test: [tests/input-draft.test.mjs](tests/input-draft.test.mjs) (2 test, mô phỏng đúng qua DOM thật — gõ số liệu → đổi Recipe/Client → assert giá trị còn nguyên).

### 🟡 Yêu cầu (2) — Báo cáo ảnh (dùng để share qua Zalo/in) — CHƯA SỬA, cần sửa 3 điểm

[buildReportSVG](index.html:3093) (W cố định 760px):
- Hiện in **mọi field có giá trị** trong section — không phân biệt "Parameters" (chi tiết) vs "QMS" (chỉ số cuối cùng cần báo cáo). Cần cơ chế đánh dấu field nào thuộc nhóm QMS để lọc.
- Dòng tiêu đề mỗi checkpoint: `${sec.name} — PO ${cp.po} (QC: ${cp.technician})` — **KHÔNG có Recipe/Client**, trong khi bản HTML report ([fullHtmlReportCheckpointCard](index.html:2941)) đã có hiển thị Recipe/Client. Cần thêm Recipe vào bản SVG.
- Ảnh đính kèm ([buildImagesLineForCheckpoint](index.html:3079)) chỉ là thumbnail nhỏ (`thumbDataUrl(src, 220)` — 220px), không phải full-width. Cần đổi sang full width của report (W=760).

### ✅ Yêu cầu (1) — Xuất dữ liệu — ĐÃ SỬA (2026-09-19), bằng 1 nút xuất RIÊNG, không đổi CSV/Excel tổng hiện có

Người dùng cung cấp 1 file mẫu thứ 2 (`Template Data export.xlsx`, cùng bố cục A1:R12 với PAPERLESS.xlsx trước đó) làm rõ chính xác layout mong muốn. Thay vì sửa CSV/Excel tổng (`buildCsv`/`buildExcelXml`, vẫn giữ nguyên `DD/MM/YYYY` + đầy đủ mọi field như trước — dùng cho backup/nhập lại), đã thêm 1 tính năng xuất RIÊNG, đúng bố cục mẫu:

- **Item Code**: xác nhận với người dùng là field MỚI, nhập tay (giống PO) — đã thêm `cp.itemCode` (top-level, như `cp.po`/`cp.recipe`), ô nhập cạnh Mã PO trong [renderInputForm](index.html:1636), cột "ItemCode" trong CSV/Excel tổng + JSON backup (ngay sau PO), cột `item_code` trong `checkpoints` table + `sync_get/put_checkpoints`. Dùng đúng cơ chế draft-safety (`captureDraft`) đã sửa cho bug mất dữ liệu.
- **QMS-only columns**: xác nhận chọn cách "cờ `isQMS` chỉnh được trong Specs" (không hard-code field nào ứng với cột nào — tên cột QMS trong mẫu, VD "%TC"/"Sediment set tank 2", khớp NHIỀU field ứng viên khác nhau tuỳ diễn giải, và 1 số cột QMS trong mẫu — Color/Sediment/Cupping cho FP — **chưa hề có field tương ứng nào tồn tại trong Specs hiện tại**, nên không thể đoán). Mỗi field trong Specs giờ có `isQMS:boolean` + `qmsLabel:string` (tên cột khi xuất, mặc định dùng tên chỉ tiêu) — sửa ở [renderSpecs](index.html) (checkbox "Xuất trong báo cáo QMS"). **Người dùng cần tự vào tab Specs đánh dấu đúng field của mình** trước khi dùng tính năng xuất — mặc định TẤT CẢ đang tắt (không tự đoán/tự bật sẵn field nào, kể cả các field khớp tên rõ ràng như "Moisture").
- **ACTION**: xử lý KHÔNG PHẢI bằng field mới per-checkpoint (khác Item Code) — thay vào đó, cột ACTION trong export tự tìm 1 field có sẵn (id kết thúc `_ACTION`, hoặc tên đúng "Action") trong Specs của công đoạn đó; để trống nếu chưa có. Người dùng tự thêm field này qua Specs (kiểu "Ghi chú") cho công đoạn nào cần — không cần sửa code thêm.
- **ISSUES/Abnormal**: tự động lấy từ field có sẵn kết thúc `_ISSUE` (đã tồn tại đồng nhất ở mọi section) — không cần cấu hình gì thêm.
- **Định dạng ngày**: `dd-mmm-yyyy` kiểu Anh-Mỹ (VD `19-Sep-2026`, ngày không có số 0 đứng đầu — khớp đúng numfmt thật trong file mẫu) — CHỈ áp dụng cho tính năng xuất mới này qua [fmtDateExport](index.html); CSV/Excel tổng và mọi chỗ khác trong app vẫn giữ `DD/MM/YYYY` như cũ, không đổi.
- **Không xuất ảnh**: đúng yêu cầu — [buildProcessQmsExcelXml](index.html)/[buildProcessQmsPrintHtml](index.html) không đụng tới `cp.images` (có test riêng khẳng định điều này).
- **"Tự động xuất về 1 vị trí"**: implement bằng File System Access API (`showDirectoryPicker`, chọn 1 lần ở tab Cài đặt, lưu `FileSystemDirectoryHandle` trong IndexedDB — clone được sẵn trên Chromium) — hàm [exportFileToPreferredLocation](index.html) thay thế `robustShareOrDownload` ở MỌI nút xuất file Blob trong app (Short CSV, Truy xuất Excel, Báo cáo HTML/PNG, Specs Excel, Xuất nhập dữ liệu, và tính năng mới này) — tự ghi thẳng vào thư mục đã chọn, rơi về hộp thoại tải/chia sẻ cũ nếu chưa chọn/mất quyền/trình duyệt không hỗ trợ. **Giới hạn quan trọng, đã báo người dùng**: chỉ Chrome/Edge trên máy tính — KHÔNG có trên điện thoại/tablet (kể cả Chrome Android) hoặc Safari/Firefox; và KHÔNG áp dụng được cho xuất PDF (qua `window.print()`, trình duyệt tự kiểm soát việc lưu).

**Vị trí (sửa lại 2026-09-19 theo phản hồi người dùng — LẦN ĐẦU đặt sai ở tab Dữ liệu, xuất theo tick-chọn/toàn bộ)**: 2 mục mới trong dropdown "Định dạng khác..." ở tab **Báo cáo**, chế độ "📋 Theo ca" — dùng lại đúng ô chọn Ngày+Ca có sẵn của tab này, cộng thêm 1 `<select>` Công đoạn mới (`processFilterSel`, mặc định "Tất cả công đoạn") ngay dưới đó. `currentQmsSubset()` luôn lấy từ `currentGen().checkpointList` (đúng theo Ngày+Ca/PO đang xem) rồi lọc thêm theo Công đoạn nếu có chọn — KHÔNG BAO GIỜ xuất toàn bộ `allCheckpoints`. Chế độ "🔎 Theo PO" cũng dùng được 2 mục này (xuất đúng các điểm kiểm tra khớp PO, không cần chọn Công đoạn). Có test riêng khẳng định phạm vi lọc đúng ([tests/process-qms-export.test.mjs](tests/process-qms-export.test.mjs), test "Báo cáo tab: template export is scoped...").

**Câu hỏi CŨ giờ đã có câu trả lời** (giữ lại mục 4 dưới đây để tham khảo lịch sử, KHÔNG cần hỏi lại): ý nghĩa Item Code, vị trí ACTION, cách đánh dấu QMS, và "tự động xuất về 1 vị trí" đều đã chốt như mô tả ở trên. Câu hỏi 6 (thứ tự Recipe/Technician trong UI) **vẫn chưa hỏi lại** — chưa đổi.

---

## 4. (Lịch sử) Câu hỏi từng cần xác nhận — xem mục 3 ở trên để biết câu trả lời đã chốt

1. ~~Ý nghĩa "Item Code"~~ → field mới, nhập tay (xem mục 3).
2. ~~Field "ACTION" đặt ở đâu~~ → field tuỳ chọn tự thêm qua Specs, export tự tìm theo id/tên (xem mục 3).
3. ~~Cách đánh dấu field nào thuộc nhóm "QMS"~~ → cờ `isQMS` chỉnh trong Specs (xem mục 3).
4. ~~"Tự động xuất về 1 vị trí"~~ → File System Access API, chọn thư mục 1 lần ở Cài đặt (xem mục 3).
5. Định dạng ngày `dd-mmm-yyy` áp dụng cho **xuất CSV/Excel**, cho **báo cáo hiển thị**, hay cả hai? — đã chốt: CHỈ áp dụng cho tính năng xuất mới (mục 3), không đổi phần còn lại của app.
6. Thứ tự "Chọn Recipe, chọn Technician" trong yêu cầu (3) — trong code hiện tại, ô Technician (QC) hiển thị TRƯỚC ô Recipe/Client. Có cần đổi thứ tự UI cho khớp đúng luồng nêu trong feedback không, hay chỉ là liệt kê không theo thứ tự? **VẪN CHƯA HỎI LẠI.**

---

## 5. Việc CHƯA làm (để làm tiếp)

- [x] Fix bug mất dữ liệu khi nhập (mục 3) — xong 2026-09-18.
- [x] Gỡ bỏ Cloudflare, chuyển sang GitHub Pages + Supabase — xong 2026-09-18.
- [x] Access control thật (Supabase Auth Admin/User + Edge Function quản lý tài khoản), thay thế mô hình mật khẩu chung — xong 2026-09-18.
- [x] Vai trò Supervisor (chỉ xem, chặn ghi ở server qua `is_writer_member()`) + Admin tự sắp xếp/ẩn-hiện Tab theo vai trò (`TAB_CONFIG`) — xong 2026-09-18.
- [x] Yêu cầu (1) Xuất dữ liệu — Item Code, cờ isQMS, xuất Excel/PDF theo mẫu Process/QMS, thư mục lưu tự động (File System Access API) — xong 2026-09-19 (chi tiết mục 3 ở trên).
- [ ] Thêm cơ chế lọc "QMS-only" cho **báo cáo ảnh** (`buildReportSVG`, tab Báo cáo — KHÁC với tính năng xuất Excel/PDF mới ở mục 3, vẫn chưa đụng tới `buildReportSVG`) + hiển thị Recipe + ảnh full-width.
- [ ] Hỏi lại câu 4.6: thứ tự UI Recipe/Client vs Technician trong form Nhập liệu có cần đổi không.
- [ ] Người dùng cần: (a) chạy lại `supabase/schema.sql` mới nhất (thêm `item_code`, `members.role` cho phép `supervisor`, `is_writer_member()`) trên project Supabase thật; (b) vào Specs đánh dấu `isQMS` cho các chỉ tiêu muốn xuất theo mẫu — mặc định TẤT CẢ đang tắt; (c) nếu chưa làm ở phiên trước: bật Email auth, tạo Admin đầu tiên bằng SQL, deploy lại Edge Function `admin-users` bằng Supabase CLI (đã sửa để nhận thêm role `supervisor`).
- [ ] Chưa test Edge Function `admin-users` với 1 project Supabase thật (không có runtime Deno trong sandbox) — người dùng cần tự thử luồng tạo/vô hiệu hóa tài khoản qua UI "👥 Quản lý tài khoản" sau khi deploy, và báo lại nếu có lỗi.
