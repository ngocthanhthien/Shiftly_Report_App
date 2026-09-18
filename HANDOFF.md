# HANDOFF — Shiftly Report App

Tài liệu bàn giao để tiếp tục làm việc ở phiên AI/công cụ khác. Cập nhật lần cuối: 2026-09-18.
**Chưa có commit code nào được thực hiện trong phiên vừa rồi** — toàn bộ mới ở giai đoạn đọc hiểu + phân tích. `git status` hiện chỉ có 1 file mới chưa track: `SHIFTLY REPORT PAPERLESS.xlsx` (file feedback gốc, để lại trong repo).

---

## 1. Tổng quan project

Ứng dụng ghi nhận báo cáo QC theo ca sản xuất cà phê (ILD Coffee Vietnam), single-file PWA offline-first, deploy trên Cloudflare Workers.

**Kiến trúc — 2 Cloudflare Workers trong 1 repo, deploy bằng `npm run deploy`:**

1. **Frontend Worker** (`shiftly-report-app`, [worker.js](worker.js)) — gateway Basic Auth (`APP_USERNAME`/`APP_PASSWORD` secrets) chắn trước khi phục vụ. `/api/*`, `/images/*` proxy qua service binding `SYNC` sang backend; còn lại serve static (`public/index.html`, build từ `index.html`).
2. **Backend Worker** (`shiftly-report-sync`, [cloudflare/worker.js](cloudflare/worker.js)) — API sync dùng D1 (`schema.sql`) + R2, bảo vệ bằng `SYNC_SECRET` riêng. Endpoint: `checkpoints` (CRUD, seq-based cursor để đồng bộ nhiều thiết bị không lệch theo giờ máy), `meta`, `logs`, `images`.

**App chính**: [index.html](index.html) (~4400 dòng, single file, HTML+CSS+JS inline, tiếng Việt). 13 tab: Nhập liệu, Dữ liệu, Truy xuất, Danh sách PO/Recipe/Client, Data Log, Báo cáo, Thống kê, Specs, Xuất nhập dữ liệu, Cài đặt, Hướng dẫn.

**Data model cốt lõi:**
- `SCHEMA` (dòng ~321 [index.html:321](index.html:321)) — mảng section: `ROA, EXT, EVA, FOAMING, FD, FP, REWORK, META`. Mỗi section có `fields[]` (type: number/boolean/text/textarea/select; có `hardMin/hardMax`, `recipeOverrides` theo Recipe, `trueLabel/falseLabel` cho boolean).
- **Checkpoint** = 1 lần nhập cho 1 section trong 1 ca, key = `date_shift_section_po` ([checkpointKey](index.html:416)). Lưu IndexedDB store `shifts`, đồng bộ Cloudflare qua outbox pattern (`queueOutbox`/`flushOutbox`).
- Danh mục phụ: `TECHNICIANS`, `RECIPES` (`RECIPE_OPTIONS`), `PO_LIST`, `CLIENT_LIST` — quản lý ở các tab list riêng.

**Các hàm/khu vực quan trọng để sửa (map nhanh, xem `Grep "^function |^async function "` để có index đầy đủ):**
- Nhập liệu: [renderInputForm](index.html:1312), [renderField](index.html:1757), [renderAutocomplete](index.html:1635)
- Xem/tra cứu: [renderTable](index.html:1831), [renderDetail](index.html:2009), [renderTrace](index.html:2509)
- Danh mục: [renderPOList](index.html:2138), [renderRecipeList](index.html:2262), [renderClientList](index.html:2331)
- Audit: [renderDataLog](index.html:2448), [logChange](index.html:498)
- Báo cáo (ảnh SVG để share/in): [renderReport](index.html:3169), [buildReportSVG](index.html:3071), [buildImagesLineForCheckpoint](index.html:3057), [renderLinesToSVG](index.html:2649)
- Báo cáo HTML (file .html đầy đủ để mở/share): [buildFullHtmlReport](index.html:2936), [fullHtmlReportCheckpointCard](index.html:2915)
- Thống kê: [renderStats](index.html:3336), [drawSPC](index.html:3499)
- Chỉnh schema: [renderSpecs](index.html:3571)
- Export/Import: [renderShare](index.html:3843), [buildCsv](index.html:623), [computeHeaderMap](index.html:330), [buildExcelXml](index.html:649)
- Cài đặt: [renderSettings](index.html:4101) (cloud sync config, mật khẩu)
- Sync layer: [cloudFetch](index.html:912), [pullFromCloud](index.html:1032), [flushOutbox](index.html:1079), [armSync/wakeSync](index.html:1209)

Ghi chú bảo mật đã thấy: mật khẩu app hardcode `const APP_PASSWORD = '1234'` ở [index.html:488](index.html:488) — dùng cho `promptPasswordOK()` (gate 1 số thao tác nhạy cảm trong app, KHÁC với Basic Auth login của Worker và khác `SYNC_SECRET` backend).

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

## 3. Đối chiếu feedback ↔ code hiện tại (đã xác nhận bằng cách đọc code)

### 🔴 Bug nghiêm trọng đã xác nhận — khớp yêu cầu (3)

[renderInputForm](index.html:1312) chỉ ghi giá trị các ô chỉ tiêu (`fieldEls`) vào `cp.fields` **tại thời điểm bấm nút Lưu** (đoạn dòng [1577-1586](index.html:1577)). Trước đó, `cp` chỉ tồn tại tạm trong bộ nhớ (chưa `idbPut`).

Bất kỳ tương tác nào trigger `renderInputForm()` chạy lại trước khi Lưu đều làm mất dữ liệu đã gõ:
- Gõ xong mã PO rồi rời khỏi ô (`blur`) → [renderAutocomplete](index.html:1635) gọi `commit()` ở dòng [1642](index.html:1642) → set `renderInputForm._newPO` → gọi lại `renderInputForm()`.
- Đổi Recipe/Client select → listener gọi `renderInputForm()` ở dòng [1476](index.html:1476)/[1480](index.html:1480).
- Đổi Section select (khi thêm mới) → dòng [1445](index.html:1445).

Ở mỗi lần render lại, vì checkpoint chưa lưu nên [getOrInitCheckpoint](index.html:607) tạo **checkpoint trắng mới** ([blankCheckpoint](index.html:604)), xoá sạch mọi giá trị đã nhập vào các ô chỉ tiêu (vì các ô đó chỉ tồn tại trong DOM/`fieldEls`, không có nơi nào ghi ngược lại state trước khi render lại).

→ Đây gần như chắc chắn là nguyên nhân gốc của phàn nàn "mất dữ liệu khi nhập". **Hướng sửa**: khi bất kỳ input nào thay đổi (kể cả PO/Recipe/Client/Section), phải ghi giá trị hiện tại của tất cả field đang mở vào một object state tạm (ví dụ gắn vào `renderInputForm._draftFields`) TRƯỚC khi gọi lại `renderInputForm()`, rồi seed lại các input từ draft đó khi render — không được để mất trắng. Cách khác: tránh full re-render khi đổi các select phụ (chỉ update phần liên quan bằng DOM thay vì gọi lại toàn bộ `renderInputForm()`).

### 🟡 Yêu cầu (2) — Báo cáo ảnh (dùng để share qua Zalo/in) — cần sửa 3 điểm

[buildReportSVG](index.html:3071) (W cố định 760px):
- Hiện in **mọi field có giá trị** trong section (dòng [3096-3106](index.html:3096)) — không phân biệt "Parameters" (chi tiết) vs "QMS" (chỉ số cuối cùng cần báo cáo). Cần cơ chế đánh dấu field nào thuộc nhóm QMS để lọc.
- Dòng tiêu đề mỗi checkpoint (dòng [3094](index.html:3094)): `${sec.name} — PO ${cp.po} (QC: ${cp.technician})` — **KHÔNG có Recipe/Client**, trong khi bản HTML report ([fullHtmlReportCheckpointCard](index.html:2915) dòng [2916](index.html:2916)) đã có hiển thị Recipe/Client. Cần thêm Recipe vào bản SVG.
- Ảnh đính kèm ([buildImagesLineForCheckpoint](index.html:3057)) chỉ là thumbnail nhỏ (`thumbDataUrl(src, 220)` — 220px), không phải full-width. Cần đổi sang full width của report (W=760).

### 🟢 Yêu cầu (1) — Xuất dữ liệu

- CSV/Excel export hiện dùng [fmtDateVN](index.html:397) → `DD/MM/YYYY`, khác định dạng mẫu `dd-mmm-yyy` (`10-Jan-2026`). Cần hàm format mới hoặc field lựa chọn định dạng.
- Không xuất hình ảnh: [buildCsv](index.html:623)/[buildExcelXml](index.html:649) hiện đã KHÔNG xuất ảnh (chỉ xuất field data) — điểm này **có vẻ đã đáp ứng sẵn**, cần xác nhận lại với người dùng xem họ đang phàn nàn về đâu (có thể về bản HTML report có gallery ảnh, không phải CSV).
- "Tự động xuất về 1 vị trí sau khi share": hiện dùng [robustShareOrDownload](index.html:4310) (share sheet / tải file thủ công qua trình duyệt) — **không có cơ chế tự ghi vào 1 thư mục cố định**. Trên mobile browser gần như không khả thi (sandbox). Trên desktop Chrome/Edge có thể dùng File System Access API để nhớ 1 thư mục và tự ghi file report vào đó mỗi lần share — cần xác nhận thiết bị sử dụng chính trước khi chọn hướng.
- **"Item Code" chưa tồn tại field nào tương ứng** trong app hiện tại (Recipe dạng "300"/"302C"..., PO là mã khác — cả hai đều không khớp format số 7 và 9 chữ số trong mẫu `1100011` / `612600011`). Cần hỏi người dùng ý nghĩa thật của Item Code trước khi thêm field.
- **"ACTION"** — cột hoàn toàn mới, hiện app chỉ có field `..._ISSUE` (textarea Issue/Abnormal) mỗi section, chưa có field Action (hành động khắc phục) riêng.

---

## 4. Câu hỏi CẦN xác nhận với người dùng trước khi code (chưa có câu trả lời)

Đã cố hỏi qua `AskUserQuestion` nhưng bị huỷ (user muốn đổi hướng làm việc), nên các câu hỏi dưới đây **vẫn còn treo**, người tiếp quản cần hỏi lại:

1. **Ý nghĩa "Item Code"**: là field mới độc lập? là đổi tên hiển thị của Recipe? hay tự động suy ra theo Client đã chọn? (ví dụ số trong mẫu không khớp định dạng Recipe/PO hiện có).
2. **Field "ACTION" đặt ở đâu**: thêm cho mọi section (cạnh Issue/Abnormal)? chỉ hiện khi Issue có giá trị? hay dùng cơ chế `fieldNotes` sẵn có thay vì thêm field mới?
3. **Cách đánh dấu field nào thuộc nhóm "QMS"** để lọc báo cáo: thêm cờ `isQMS` chỉnh được trong tab Specs (linh hoạt, tự người dùng chọn), hay hard-code cứng đúng danh sách trong file mẫu cho ROA/EXT/EVA/FD/FP (và hỏi thêm cho FOAMING/REWORK vì mẫu không đề cập)?
4. **Thiết bị sử dụng chính** (điện thoại hay máy tính) — quyết định hướng làm cho yêu cầu "tự động xuất về 1 vị trí" (ưu tiên đồng bộ Cloudflare sẵn có làm "vị trí tập trung" thay vì auto-save file cục bộ, vốn không khả thi trên mobile).
5. Xác nhận lại: định dạng ngày `dd-mmm-yyy` áp dụng cho **xuất CSV/Excel**, cho **báo cáo hiển thị**, hay cả hai? (Hiện toàn bộ app dùng `DD/MM/YYYY` xuyên suốt các tab.)
6. Thứ tự "Chọn Recipe, chọn Technician" trong yêu cầu (3) — trong code hiện tại, ô Technician (QC) hiển thị TRƯỚC ô Recipe/Client (dòng [1462](index.html:1462) rồi mới tới [1472](index.html:1472)). Có cần đổi thứ tự UI cho khớp đúng luồng nêu trong feedback không, hay chỉ là liệt kê không theo thứ tự?

---

## 5. Việc CHƯA làm (để làm tiếp)

- [ ] Fix bug mất dữ liệu khi nhập (mục 3, ưu tiên cao nhất — ảnh hưởng trực tiếp thao tác hàng ngày).
- [ ] Thêm cơ chế lọc "QMS-only" cho báo cáo ảnh + hiển thị Recipe + ảnh full-width trong `buildReportSVG`.
- [ ] Làm rõ & implement "Item Code" và "ACTION" sau khi có câu trả lời từ người dùng (mục 4.1, 4.2).
- [ ] Định dạng ngày `dd-mmm-yyy` cho export (và/hoặc report) sau khi xác nhận phạm vi áp dụng (mục 4.5).
- [ ] Giải pháp "xuất về 1 vị trí" tuỳ theo thiết bị (mục 4.4).
- [ ] File `SHIFTLY REPORT PAPERLESS.xlsx` đang nằm untracked ở root repo — cân nhắc thêm vào `.gitignore` hoặc di chuyển ra khỏi repo nếu không muốn commit (hiện chưa add/commit).
