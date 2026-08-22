# AGENTS.md

> **Dành cho AI coding assistant:** Đây là bản đồ kiến thức đầy đủ của repo `mvppq-script`.
> Đọc kỹ file này trước khi sửa code — nó chứa toàn bộ ngữ cảnh kiến trúc, quy ước,
> các lỗi đã fix và những cái bẫy kỹ thuật của dự án. Không cần dò lại codebase từ đầu.

---

## 1. Tổng quan repo

Bộ sưu tập script nội bộ phục vụ công việc IT Admin / IT Support, viết bởi team vận hành.
Ngôn ngữ chính: **JavaScript (Tampermonkey userscript)** và **Python CLI**.
Toàn bộ text UI và comment trong code là **tiếng Việt** — giữ nguyên quy ước này khi sửa.

Chủ đề xuyên suốt: phân tích & báo cáo dung lượng **SharePoint Online** qua **Microsoft Graph API**,
kèm một số tool automation khác (Pinpoint, PCIDSS).

## 2. Cấu trúc thư mục

| Thư mục / File | Loại | Mô tả |
|---|---|---|
| `sharepoint-usage-analyzer/sp-usage-analyzer.js` | Tampermonkey v6.0 | **File chính của repo.** Userscript biến Graph Explorer thành công cụ phân tích dung lượng SharePoint |
| `sharepoint-usage-analyzer/windirstat_style.py` | Python CLI | Quét đệ quy toàn bộ thư mục SharePoint, hiển thị cây kiểu WinDirStat, xuất CSV/JSON |
| `sharepoint-usage-analyzer/sp-storagever2dot4.zip` | Release artifact | Bản đóng gói cũ (v2.4) — KHÔNG sửa file zip |
| `extension/` | Chrome Extension MV3 | Phiên bản cũ (v3.1) của analyzer dưới dạng Chrome Extension (`content.js` + `inject.js`, GA4 tracking). Chỉ có README + zip đóng gói, không có source trong repo |
| `pinpoint-batch-edit/main.py` | Python + Playwright | Automation hàng loạt thiết bị trên Pinpoint (zerorisk.io) qua auth HCP, thông báo Discord webhook |
| `recyclebin-report-sharepoint/recyclebin-report-sharepoint.py` | Python one-shot | Lấy Recycle Bin site qua Graph beta endpoint → xuất Excel (openpyxl) nhóm theo phòng ban |
| `script-random-pcidss/random-pcidss.py` | Python + pywin32 | Randomize timestamp (created/modified) của file Windows bằng `win32file.SetFileTime` — chuẩn bị image máy theo PCIDSS |

## 3. File chính: `sharepoint-usage-analyzer/sp-usage-analyzer.js` (v6.0)

### 3.1. Bản chất

- **Tampermonkey userscript**, `@run-at document-start`, chỉ chạy trên:
  `https://developer.microsoft.com[/en-us]/graph/graph-explorer*`
- Biến Graph Explorer thành panel phân tích dung lượng: thêm nút **"Tính Dung Lượng SP"**
  cạnh nút "Access token" gốc của trang.
- Không có build system — file JS chạy trực tiếp, verify syntax bằng `node --check`.
- Dependency duy nhất: **SheetJS XLSX 0.20.3** nạp qua `@require`.

### 3.2. Kiến trúc — IIFE gồm 8 module đánh số bằng comment banner

1. **CONFIG** — `DEFAULT_SITE_URL` (site mặc định `accor.sharepoint.com/sites/HB4V5_SPOF`).
2. **TokenManager** — Monkey-patch `window.fetch` ngay từ `document-start` để chặn mọi request
   ra `graph.microsoft.com`, **ăn cắp Bearer token** từ header Authorization rồi khôi phục fetch gốc.
   API: `getToken()`, `hasToken()`, `invalidate()` (đặt token = null khi gặp 401),
   `ensureToken()` (gọi `/me` để kích hoạt Graph Explorer sinh token).
3. **ConfigStore** — wrapper `localStorage.getItem/setItem`.
4. **Utils** — hàm tiện ích thuần: `formatDateTime` (`HH:mm dd/MM`), `bytesToGB`,
   `isSystemItem` (lọc item hệ thống regex `^_\$`), `formatBytes`, `escapeHtml`,
   `formatIsoToVN` (ISO → `dd/MM/yyyy HH:mm`).
5. **GraphAPI** — tầng mạng, chứa toàn bộ logic retry/throttle:
   - `MAX_RETRIES = 3`; `TOKEN_EXPIRED_MSG` — thông báo hướng dẫn bấm lại nút "Access token".
   - `request(url, options, attempt)` — GET kèm **auto-retry 429/503 theo header `Retry-After`**
     (fallback exponential backoff `2^attempt * 2`s); gặp **401** thì `TokenManager.invalidate()`
     + throw thông báo thân thiện; chuyển `AbortError` từ fetch thành `Error("TaskAborted")`
     để các tầng trên nhận diện lệnh hủy.
   - `batchRequest(requests, options)` — POST `$batch` (tối đa **20 sub-request/batch**), xử lý 401 như trên.
   - `resolveSiteId(siteUrl)`, `getDrives(siteId)` (lọc drive hệ thống `^_\$`),
   - `followPaging(firstBody)` — **bắt buộc**: response con bên trong batch có thể trả
     `@odata.nextLink` khi item gốc >200 → hàm này đi hết các trang.
   - `getFolderChildren(driveId, itemId, abortSignal)` — `$select` gồm
     `id,name,size,folder,file,webUrl,lastModifiedDateTime`, `$top=200`, tự đi pagination.
6. **StyleManager** — inject CSS một lần vào `#gx-toolkit-styles` (base + style từng feature).
7. **PanelHost** — khung UI chung: split-button cạnh nút Access token, dropdown
   "🗑️ Quét kèm Thùng rác", panel resize được (handle top/left), minimize thành minibar,
   nút ⚙ cấu hình URL site.
8. **StorageAnalyzerFeature** — class tính năng chính, chi tiết ở mục 3.3–3.5.

### 3.3. Luồng quét dung lượng (`startAnalyzing`)

```
resolveSiteId → getDrives → chia chunk 20 drive/batch → POST $batch
   ├─ sub-response 200 → cộng size item gốc (lọc system item);
   │    nếu body có @odata.nextLink → followPaging() lấy nốt (fix drive >200 item gốc)
   ├─ sub-response 429/503 → gom lại, chờ 3s, gửi batch lại (tối đa MAX_RETRIES pass)
   └─ lỗi khác → log console, bỏ qua drive đó
→ (tuỳ chọn) quét Recycle Bin qua endpoint beta, có pagination
→ render list card drive (sort GB giảm dần) + tổng cộng footer
```

Lỗi 401 giữa chừng sẽ nổ lên UI với hướng dẫn bấm lại "Access token" rồi quét lại.

### 3.4. Tree view (cấu trúc thư mục)

- Lazy-load từng cấp thư mục bằng `getFolderChildren`; cache trong `this.driveTrees[driveId]`
  → đổi sort/ẩn-hiện không gọi lại API.
- Mỗi node: `id, name, type(folder|file), size, modified (chuỗi VN hiển thị),
  modifiedRaw (ISO gốc để sort ngày chính xác), webUrl, loaded, expanded, children[]`.
- **Ẩn/hiện cột:** chip `📅 Ngày | 💾 Dung lượng | 📊 Bar` trong tree header.
  State `hiddenCols {date,size,bar}` lưu localStorage key `sp_tree_hidden_cols`;
  áp bằng class `col-hidden-*` lên `.sp-view-tree` (không re-render).
- **Sắp xếp:** segmented control 2 chip `⇅ Dung lượng` / `⇅ Ngày`.
  State `{key:"size"|"date", dir:"desc"|"asc"}` lưu localStorage key `sp_tree_sort`.
  Bấm chip đang bật → đảo chiều ↑↓; bấm chip kia → chuyển cột (mặc định desc).
  `sortNodes()`: sort theo `Date.parse(modifiedRaw)`, **item không có ngày luôn nằm cuối**;
  tie-break theo size. Thanh bar % tính `maxSize` bằng `Math.max(...)` độc lập với thứ tự sort
  (tránh bar sai khi sort theo ngày).

### 3.5. Xuất Excel (`exportToExcelWorkflow`) — SheetJS XLSX 0.20.3

- Sheet **"Tổng Quan"**: cột `DPT | SIZE(GB)` + dòng TOTAL.
- Sheet mỗi Drive: `Path | Name | Type | Size (Bytes) | Size (GB) | Modified`
  — dữ liệu từ cache tree nếu đã load đủ, ngược lại chạy
  `scanDriveRecursively()` (BFS queue) **truyền AbortSignal vào fetch** để nút Hủy
  kill được cả request đang bay (abort → `"TaskAborted"`).
- Sheet **"Thùng rác"** (nếu đã quét recycle bin): kèm `deletedDateTime_VN` format giờ VN.
- `appendSheetUnique()`: đặt tên sheet an toàn — strip ký tự cấm Excel, giới hạn 31 ký tự,
  tự đánh số `~2, ~3...` nếu trùng tên (tránh crash SheetJS).
- Freeze dòng đầu (`!freeze`), auto-fit cột, format số `#,##0`.
- Progress modal có nút Hủy → `AbortController.abort()`.
- Nút Copy TSV: copy clipboard sort tên A-Z locale `"vi"`, paste thẳng vào Excel được.

### 3.6. Mounting UI

`MutationObserver` quan sát DOM đến khi tìm thấy nút "Access token" (SPA render muộn),
inject xong sẽ chèn marker `#gx-toolkit-mounted` rồi **`observer.disconnect()` ngay**
— đừng bỏ disconnect này, Graph Explorer là SPA rất nặng.

### 3.7. localStorage keys

| Key | Nội dung |
|---|---|
| `sp_site_url` | URL site SharePoint cần quét (cấu hình qua ⚙) |
| `sp_tree_hidden_cols` | `{"date":bool,"size":bool,"bar":bool}` |
| `sp_tree_sort` | `{"key":"size"\|"date","dir":"desc"\|"asc"}` |

### 3.8. Cái bẫy kỹ thuật — PHẢI NHỚ khi sửa

- **cdnjs KHÔNG có XLSX >0.18.x** (SheetJS rút khỏi npm/cdnjs). Phải dùng
  `https://cdn.sheetjs.com/xlsx-<ver>/package/dist/xlsx.full.min.js`. Đừng đổi về cdnjs!
- `$batch` giới hạn **20 sub-request** — đừng tăng `BATCH_SIZE`.
- `folder.size` từ Graph cập nhật **trễ/lệch nhẹ** so với Storage Metrics thật của SharePoint.
- Recycle Bin endpoint đang dùng **beta** (`/beta/sites/{id}/recycleBin/items`).
- Token chỉ tồn tại sau khi user đăng nhập Graph Explorer; tuổi thọ ~1h.
  Luôn xử lý 401 bằng `TOKEN_EXPIRED_MSG`, đừng để lỗi generic.
- Item hệ thống SharePoint (form `_\$...`) phải lọc bằng `Utils.isSystemItem`.
- Khi truyền signal vào fetch qua `GraphAPI.request`: `AbortError` đã được map thành
  `Error("TaskAborted")` — code phía trên check đúng chuỗi này.

## 4. `windirstat_style.py`

Python CLI quét SÂU mọi Drive trong site (đối lập bản JS chỉ tính cấp gốc):

- **Auth:** Device Code Flow, dùng CLIENT_ID public của Graph Explorer
  (`14d82eec-204b-4c2f-b7e8-296a70dab67e`), scope `Sites.Read.All Files.Read.All`,
  token lưu `token_cache.json` (có refresh_token flow). Không cần đăng ký Azure app.
- `SITE_ID` hardcode trong đầu file (site accor) — cần sửa tay khi đổi site.
- `scan_folder()` đệ quy lấy children, **retry 429 theo `Retry-After`**,
  build cây dict `{name,path,size,type,children}`.
- UI bằng thư viện **rich**: bảng tóm tắt có bar `%`, cây thư mục màu theo tỉ lệ dung lượng,
  Top 20 item lớn nhất, progress spinner.
- Export CSV `sharepoint_scan_result.csv` (`utf-8-sig` cho Excel đọc đúng tiếng Việt),
  cache JSON `sharepoint_scan_result.json` (chạy lại có thể dùng kết quả cũ).
- Menu tương tác sau quét: `[0-6]`. Deps: `pip install requests rich`.

## 5. Các thư mục còn lại (tóm tắt)

- **`extension/`** — Chrome Extension Manifest V3 phiên bản cũ của analyzer (v3.1):
  kiến trúc content.js/inject.js tách lớp để qua CSP, `chrome.storage.local`, GA4 Measurement
  Protocol. Repo chỉ chứa README + zip release, **không có source** — đừng tìm file .js trong này.
- **`pinpoint-batch-edit/main.py`** — Playwright sync: đăng nhập HCP (`hcp.vigitrust.com`)
  bằng credentials từ `.env`, thao tác hàng loạt device trên Pinpoint (`DEVICE_IDS` trong `.env`),
  báo cáo ra **Discord webhook**. Config hoàn toàn qua env vars.
- **`recyclebin-report-sharepoint/recyclebin-report-sharepoint.py`** — one-shot: dán Bearer TOKEN
  trực tiếp vào biến `TOKEN` trong source, gọi Graph beta recycleBin (`$top=15000`,
  order by deletedDateTime desc), nhóm theo phòng ban (parse path phần tử thứ 3),
  xuất Excel bằng openpyxl.
- **`script-random-pcidss/random-pcidss.py`** — Windows-only: đi cây `ROOT_PATH`, randomize
  Created/Modified timestamp bằng `win32file.SetFileTime` (pywin32), console ANSI màu.
  Mục đích: làm image inventory theo yêu cầu PCIDSS.

## 6. Quy ước code

- Text UI + comment: **tiếng Việt**. Tên biến/hàm: tiếng Anh.
- Userscript là single-file monolith theo module đánh dấu banner comment
  `// ===== N. TÊN MODULE =====` — thêm tính năng mới vào đúng module hoặc tạo module mới đánh số tiếp.
- Không build step, không linter config trong repo. Giữ phong cách ES2017+ (async/await, optional chaining OK — Tampermonkey hiện đại chạy được).
- Commit message: ngắn, tiếng Anh, liệt kê tính năng chính, ví dụ:
  `v6.0: auto-retry 429/401, modified date column, sort & hide columns, fix batch pagination`.
- File `.zip` trong repo là release artifact — không bao giờ edit trực tiếp, cũng không commit zip mới trừ khi chủ repo yêu cầu.

## 7. Verify & test

Không có unit test tự động. Kiểm tra tối thiểu:

```bash
# Syntax userscript sau khi sửa
node --check sharepoint-usage-analyzer/sp-usage-analyzer.js

# Test runtime thật: dán nội dung userscript vào một script Tampermonkey mới,
# mở https://developer.microsoft.com/graph/graph-explorer, đăng nhập,
# bấm nút "Access token", rồi bấm "Tính Dung Lượng SP".

# Python tools
pip install requests rich        # windirstat_style.py
python windirstat_style.py       # sẽ hiện device-code login lần đầu
```

Khi sửa logic Graph API, ưu tiên test với site ít dữ liệu trước (quét nhanh),
rồi bật "Quét kèm Thùng rác" để phủ luồng beta endpoint.

## 8. Nhật ký thay đổi gần nhất (v6.0 — commit `360c33e`)

1. Fix crash nút ⚙ Settings (`minibarEl` chưa định nghĩa).
2. Fix thiếu dung lượng drive >200 item gốc (pagination `@odata.nextLink` trong batch).
3. Fix crash export Excel khi trùng tên sheet (`appendSheetUnique`).
4. Auto-retry 429/503 theo `Retry-After` + phát hiện 401 hết hạn token.
5. Truyền AbortSignal vào fetch (hủy export giữa chừng thật sự).
6. MutationObserver tự disconnect sau mount.
7. XLSX 0.18.5 → 0.20.3 (CVE-2023-30533, CVE-2024-22363).
8. Thêm cột Ngày chỉnh sửa (tree view + Excel) và chip ẩn/hiện cột.
9. Sắp xếp tree view theo Dung lượng/Ngày ↑↓ (segmented control, lưu localStorage).
