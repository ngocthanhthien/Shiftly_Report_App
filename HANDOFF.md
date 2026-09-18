# HANDOFF — Shiftly Report App

Tài liệu bàn giao để tiếp tục làm việc ở phiên AI/công cụ khác. Cập nhật lần cuối: 2026-09-18.

---

## 1. Tổng quan project

Ứng dụng ghi nhận báo cáo QC theo ca sản xuất cà phê (ILD Coffee Vietnam), single-file PWA offline-first.

**Kiến trúc hiện tại — GitHub Pages (hosting) + Supabase (dữ liệu). KHÔNG còn Cloudflare** (đã gỡ bỏ hoàn toàn trong phiên 2026-09-18 — trước đó có 2 Cloudflare Workers, `worker.js`/`wrangler.jsonc`/`cloudflare/` — các file này đã bị xoá, đừng tái tạo lại trừ khi người dùng yêu cầu quay lại):

1. **Frontend**: [index.html](index.html) — file tĩnh, publish qua GitHub Pages, không có build step, không có gateway đăng nhập server-side (GitHub Pages không hỗ trợ). Bảo vệ dữ liệu hoàn toàn dựa vào mật khẩu đồng bộ (mục 2 dưới), không phải vào việc giấu app.
2. **Backend**: Supabase (Postgres) — xem [`supabase/schema.sql`](supabase/schema.sql) + [`supabase/README.md`](supabase/README.md). Không có server tuỳ biến nào — app gọi thẳng PostgREST RPC endpoint của Supabase bằng `anon` key public. Mọi bảng thật (`checkpoints`, `meta`, `logs`, `app_secret`) bật RLS và **không có policy nào** → chặn hết truy cập REST trực tiếp. Đường vào duy nhất là các SQL function `sync_get_checkpoints`/`sync_put_checkpoints`/`sync_delete_checkpoints`/`sync_get_meta`/`sync_put_meta`/`sync_post_logs` (SECURITY DEFINER), mỗi function tự kiểm tra 1 mật khẩu chung truyền vào làm tham số đầu tiên. Mật khẩu đặt 1 lần bằng `select set_sync_secret('...')` trong Supabase SQL Editor, không nằm trong mã nguồn.
3. Ảnh đính kèm đi thẳng trong cột `images` (jsonb, base64 `dataUrl`) của mỗi checkpoint — **không** có bảng/endpoint ảnh riêng (đã đơn giản hoá so với bản Cloudflare cũ dùng R2 + URL riêng).
4. Con trỏ đồng bộ (`seq`) là 1 Postgres SEQUENCE, gán theo thứ tự ghi ở server (KHÔNG dùng đồng hồ client) — quan trọng: đừng bao giờ đổi cursor sang dùng timestamp lại, xem comment trong `supabase/schema.sql` và mục `CLOUD SYNC` đầu `index.html` để hiểu lý do (bug lệch đồng hồ đã từng xảy ra thật với bản Cloudflare).
5. **Realtime (thêm 2026-09-18)** — sau khi đối chiếu với skill `supabase-sync-auth-patterns`, đã thêm lớp Realtime Broadcast "rẻ": mỗi lần đẩy dữ liệu thành công, app phát 1 tín hiệu "vừa có thay đổi" qua kênh Broadcast public tên `shiftly-changes`; máy khác nhận tín hiệu → gọi lại đúng `pullFromCloud()` đã có (debounce 400ms), y hệt cách polling gọi — không thêm logic hợp nhất riêng. **Cố tình dùng Broadcast, không dùng `postgres_changes`**: `postgres_changes` chỉ gửi được sự kiện cho client có quyền SELECT theo RLS, mà 2 bảng chính không có policy nào cho `anon` (xem mục 2) — muốn dùng `postgres_changes` sẽ phải nới RLS cho `anon`, tức là bất kỳ ai có `anon key` public (nằm sẵn trong repo) cũng đọc thẳng được dữ liệu qua REST, phá vỡ đúng mô hình bảo mật "phải biết mật khẩu mới vào được qua RPC" đã chọn. Broadcast không có ràng buộc RLS này nên an toàn để dùng nguyên trạng. Cần load `@supabase/supabase-js` qua CDN (`<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2">` — dòng đầu tiên trong `index.html` có `<script src>`, TRƯỚC thẻ `<script>` chính) — nếu load lỗi (CDN chặn, offline), `ensureSupabaseClient()` trả `null`, mọi hàm Realtime tự no-op, app vẫn chạy đúng bằng vòng polling ~15-20s như trước, không crash. **Chưa test được kết nối Realtime thật** (không có project Supabase sống trong sandbox) — đã test kỹ nhánh "SDK không load được" (an toàn), người dùng nên tự kiểm tra bằng cách mở 2 tab/2 máy, lưu ở 1 bên, xem bên kia cập nhật trong ~1 giây thay vì ~20 giây.

**Đã đối chiếu có chủ đích, KHÔNG áp dụng** từ skill `supabase-sync-auth-patterns`: mô hình 2 tầng tài khoản (Anonymous Sign-in + Admin `signInWithPassword`) mà skill khuyến nghị — app này vẫn dùng 1 mật khẩu đồng bộ chung (không phải tài khoản thật) vì đây là công cụ nội bộ dùng chung 1 mật khẩu, không cần phân quyền nhiều người; đổi sang mô hình của skill sẽ cần nới RLS theo `auth.uid()`, hạ thấp mức bảo vệ hiện tại. Nếu sau này cần phân quyền thật (VD chỉ Admin được sửa Specs, mỗi QC có tài khoản riêng), xem `references/access-management.md` trong skill để làm theo — lúc đó mới cần đánh đổi bảo mật này.

**App chính**: [index.html](index.html) (~4300 dòng, single file, HTML+CSS+JS inline, tiếng Việt). 13 tab: Nhập liệu, Dữ liệu, Truy xuất, Danh sách PO/Recipe/Client, Data Log, Báo cáo, Thống kê, Specs, Xuất nhập dữ liệu, Cài đặt, Hướng dẫn.

**Data model cốt lõi:**
- `SCHEMA` (dòng ~321) — mảng section: `ROA, EXT, EVA, FOAMING, FD, FP, REWORK, META`. Mỗi section có `fields[]` (type: number/boolean/text/textarea/select; có `hardMin/hardMax`, `recipeOverrides` theo Recipe, `trueLabel/falseLabel` cho boolean).
- **Checkpoint** = 1 lần nhập cho 1 section trong 1 ca, key = `date_shift_section_po` ([checkpointKey](index.html:416)). Lưu IndexedDB store `shifts`, đồng bộ Supabase qua outbox pattern (`queueOutbox`/`flushOutbox`).
- Danh mục phụ: `TECHNICIANS`, `RECIPES` (`RECIPE_OPTIONS`), `PO_LIST`, `CLIENT_LIST` — quản lý ở các tab list riêng.

**Các hàm/khu vực quan trọng để sửa** (đúng tại thời điểm 2026-09-18 — chạy lại `grep -n "^function \|^async function "` nếu nghi ngờ đã lệch do sửa code sau này):
- Nhập liệu: [renderInputForm](index.html:1307), [renderField](index.html:1783), [renderAutocomplete](index.html:1662)
- Xem/tra cứu: [renderTable](index.html:1857), [renderDetail](index.html:2035), [renderTrace](index.html:2535)
- Danh mục: [renderPOList](index.html:2164), [renderRecipeList](index.html:2288), [renderClientList](index.html:2357)
- Audit: [renderDataLog](index.html:2474), [logChange](index.html:498)
- Báo cáo (ảnh SVG để share/in): [renderReport](index.html:3191), [buildReportSVG](index.html:3093), [buildImagesLineForCheckpoint](index.html:3079), [renderLinesToSVG](index.html:2675)
- Báo cáo HTML (file .html đầy đủ để mở/share): [buildFullHtmlReport](index.html:2962), [fullHtmlReportCheckpointCard](index.html:2941)
- Thống kê: [renderStats](index.html:3358), [drawSPC](index.html:3521)
- Chỉnh schema: [renderSpecs](index.html:3593)
- Export/Import: [renderShare](index.html:3865), [buildCsv](index.html:623), [computeHeaderMap](index.html:330), [buildExcelXml](index.html:649)
- Cài đặt: [renderSettings](index.html:4119) (cloud sync config: Supabase URL/anon key/mật khẩu)
- Sync layer: [cloudFetch](index.html:920) (gọi PostgREST RPC), [pullFromCloud](index.html:1043), [flushOutbox](index.html:1090), [armSync/wakeSync](index.html:1204), [startRealtime/pingRealtimeChanged](index.html:1264) (Broadcast, optional best-effort — mục 5 dưới)

Ghi chú bảo mật: mật khẩu app hardcode `const APP_PASSWORD = '1234'` ở [index.html:488](index.html:488) — dùng cho `promptPasswordOK()` (gate 1 số thao tác nhạy cảm trong app, VD xoá dữ liệu, sửa PO đã đóng), KHÁC HẲN với mật khẩu đồng bộ Supabase.

**Test**: `npm ci && npm test` — chạy schema.sql THẬT qua Postgres nhúng (`@electric-sql/pglite`, không phải giả lập) + boot toàn bộ app qua jsdom rồi đồng bộ thật qua đúng luồng RPC. Xem `tests/supabase.test.mjs` và `tests/input-draft.test.mjs`.

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

### 🟢 Yêu cầu (1) — Xuất dữ liệu — CHƯA SỬA

- CSV/Excel export hiện dùng [fmtDateVN](index.html:397) → `DD/MM/YYYY`, khác định dạng mẫu `dd-mmm-yyy` (`10-Jan-2026`). Cần hàm format mới hoặc field lựa chọn định dạng.
- Không xuất hình ảnh: [buildCsv](index.html:623)/[buildExcelXml](index.html:649) hiện đã KHÔNG xuất ảnh (chỉ xuất field data) — điểm này **có vẻ đã đáp ứng sẵn**, cần xác nhận lại với người dùng xem họ đang phàn nàn về đâu (có thể về bản HTML report có gallery ảnh, không phải CSV).
- "Tự động xuất về 1 vị trí sau khi share": hiện dùng [robustShareOrDownload](index.html:4330) (share sheet / tải file thủ công qua trình duyệt) — không tự ghi vào 1 thư mục cố định. **Cập nhật quan trọng**: giờ đã có Đồng bộ Supabase — nếu user coi "đồng bộ tự động lên cloud" là đáp ứng đủ yêu cầu này thì coi như đã xong (mọi thiết bị đã cấu hình đều tự thấy dữ liệu mới, không cần thao tác "xuất" gì thêm); cần hỏi lại xem có thực sự cần auto-save ra 1 thư mục cục bộ (File System Access API, chỉ khả thi trên desktop Chrome/Edge) hay đồng bộ cloud là đủ.
- **"Item Code" chưa tồn tại field nào tương ứng** trong app hiện tại (Recipe dạng "300"/"302C"..., PO là mã khác — cả hai đều không khớp format số 7 và 9 chữ số trong mẫu `1100011` / `612600011`). Cần hỏi người dùng ý nghĩa thật của Item Code trước khi thêm field.
- **"ACTION"** — cột hoàn toàn mới, hiện app chỉ có field `..._ISSUE` (textarea Issue/Abnormal) mỗi section, chưa có field Action (hành động khắc phục) riêng.

---

## 4. Câu hỏi CẦN xác nhận với người dùng trước khi code tiếp (chưa có câu trả lời)

1. **Ý nghĩa "Item Code"**: là field mới độc lập? là đổi tên hiển thị của Recipe? hay tự động suy ra theo Client đã chọn?
2. **Field "ACTION" đặt ở đâu**: thêm cho mọi section (cạnh Issue/Abnormal)? chỉ hiện khi Issue có giá trị? hay dùng cơ chế `fieldNotes` sẵn có thay vì thêm field mới?
3. **Cách đánh dấu field nào thuộc nhóm "QMS"** để lọc báo cáo: thêm cờ `isQMS` chỉnh được trong tab Specs (linh hoạt), hay hard-code cứng đúng danh sách trong file mẫu cho ROA/EXT/EVA/FD/FP (và hỏi thêm cho FOAMING/REWORK vì mẫu không đề cập)?
4. **"Tự động xuất về 1 vị trí"** — Đồng bộ Supabase đã có sẵn có được coi là đáp ứng đủ chưa, hay vẫn cần auto-save ra thư mục cục bộ trên 1 thiết bị cụ thể?
5. Định dạng ngày `dd-mmm-yyy` áp dụng cho **xuất CSV/Excel**, cho **báo cáo hiển thị**, hay cả hai? (Hiện toàn bộ app dùng `DD/MM/YYYY` xuyên suốt các tab.)
6. Thứ tự "Chọn Recipe, chọn Technician" trong yêu cầu (3) — trong code hiện tại, ô Technician (QC) hiển thị TRƯỚC ô Recipe/Client. Có cần đổi thứ tự UI cho khớp đúng luồng nêu trong feedback không, hay chỉ là liệt kê không theo thứ tự?

---

## 5. Việc CHƯA làm (để làm tiếp)

- [x] Fix bug mất dữ liệu khi nhập (mục 3) — xong 2026-09-18.
- [x] Gỡ bỏ Cloudflare, chuyển sang GitHub Pages + Supabase — xong 2026-09-18.
- [ ] Thêm cơ chế lọc "QMS-only" cho báo cáo ảnh + hiển thị Recipe + ảnh full-width trong `buildReportSVG`.
- [ ] Làm rõ & implement "Item Code" và "ACTION" sau khi có câu trả lời từ người dùng (mục 4.1, 4.2).
- [ ] Định dạng ngày `dd-mmm-yyy` cho export (và/hoặc report) sau khi xác nhận phạm vi áp dụng (mục 4.5).
- [ ] Xác nhận Đồng bộ Supabase có đáp ứng đủ yêu cầu "xuất về 1 vị trí" hay còn cần thêm gì (mục 4.4).
- [ ] Người dùng cần tự chạy `supabase/schema.sql` trên project Supabase thật của họ (chưa từng chạy — đây là project/kiến trúc hoàn toàn mới, không có dữ liệu cũ cần migrate) và cấu hình lại tab Cài đặt trên mọi thiết bị.
