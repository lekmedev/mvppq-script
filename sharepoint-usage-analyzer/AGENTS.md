# AGENTS.md — sharepoint-usage-analyzer

> Ngữ cảnh chung của repo xem `../AGENTS.md` ở gốc. File này chỉ chứa chi tiết cục bộ
> khi làm việc trực tiếp trong thư mục này.

## Files

| File | Vai trò |
|---|---|
| `sp-usage-analyzer.js` | Tampermonkey userscript v6.0 chạy trên Graph Explorer — **file chính**, kiến trúc 8 module mô tả đầy đủ ở `../AGENTS.md` mục 3 |
| `windirstat_style.py` | Python CLI quét đệ quy sâu mọi Drive, UI rich, xuất CSV/JSON |
| `sp-storagever2dot4.zip` | Release artifact cũ — KHÔNG sửa |

## Verify sau khi sửa

```bash
node --check sp-usage-analyzer.js        # JS syntax
pip install requests rich                # deps cho windirstat_style.py
python windirstat_style.py               # lần đầu sẽ hiện device-code login
```

## localStorage keys của userscript

- `sp_site_url` — URL site SharePoint đang cấu hình
- `sp_tree_hidden_cols` — `{"date","size","bar"}` trạng thái ẩn/hiện cột tree view
- `sp_tree_sort` — `{"key":"size"|"date","dir":"desc"|"asc"}` chế độ sắp xếp

## Cái bẫy cục bộ

- Userscript nạp XLSX từ `cdn.sheetjs.com`, **không phải cdnjs** (cdnjs dừng ở 0.18.x).
  Khi nâng cấp SheetJS phải sửa cả chuỗi `@require` ở header.
- `$batch` max 20 sub-request; sub-response có thể trả `@odata.nextLink`
  → luôn đi qua `GraphAPI.followPaging()`.
- `AbortError` từ fetch được map thành `Error("TaskAborted")` trong GraphAPI —
  code phía trên check đúng chuỗi này, đừng đổi message.
- Sort ngày dùng `modifiedRaw` (ISO); field `modified` chỉ để hiển thị VN.
- Recycle bin scan gọi endpoint `/beta/...` — API chưa ổn định.
- Test userscript thật: dán vào Tampermonkey → mở Graph Explorer → đăng nhập →
  bấm "Access token" → "Tính Dung Lượng SP". Ưu tiên site ít dữ liệu trước.
