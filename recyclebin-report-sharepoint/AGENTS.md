# AGENTS.md — recyclebin-report-sharepoint

> Ngữ cảnh chung repo xem `../AGENTS.md`. Chi tiết cục bộ của tool báo cáo Recycle Bin.

## Mô tả

`recyclebin-report-sharepoint.py` — script one-shot: kéo **toàn bộ** item trong Recycle Bin
của một SharePoint site qua Graph API, xuất file Excel 2 sheet (chi tiết + dashboard).

## Luồng hoạt động

1. Gọi `GET /beta/sites/{SITE_ID}/recycleBin/items` với `$top=15000`,
   `orderby=deletedDateTime desc`, đi hết pagination qua `NEXT_URL` (vòng `while`).
2. Với mỗi item: parse **phòng ban** từ path (`get_dept()` — lấy phần tử thứ 3 của
   `deletedFromLocation`, không parse được → `"UNKNOWN"`), convert giờ UTC sang giờ VN
   (`to_vn_time()`), format size đọc được.
3. Xuất Excel bằng **openpyxl**:
   - Sheet chi tiết: header đậm (Font bold) + từng dòng item.
   - Sheet dashboard: nhóm theo Dept — số file + tổng dung lượng, cộng dòng TOTAL.
4. `wb.save(output_file)` — tên file output đặt trong source.

## Cấu hình trong source

- `TOKEN` — **dán Bearer token thủ công vào biến** ở đầu file. Token lấy nhanh bằng cách
  mở Graph Explorer, đăng nhập, bấm "Access token", copy chuỗi sau chữ `Bearer`.
  ⚠️ Đừng bao giờ commit token thật lên repo.
- `SITE_ID` — hardcode dạng `tenant,guid-site,guid-web` (hiện là site accor).
- Test Mode: khi recycle bin quá lớn (>100k items), giới hạn số trang bằng
  `MAX_PAGES` (xem README.md trong thư mục này).

## Chạy

```bash
pip install requests openpyxl
python recyclebin-report-sharepoint.py
```

## Lưu ý

- Endpoint `/beta/recycleBin` chưa ổn định — nếu Graph trả lỗi schema, kiểm tra changelog beta trước.
- `$top=15000` là giá trị lớn có chủ đích để giảm số round-trip; nếu Graph từ chối thì hạ xuống.
- Script chạy một lần rồi thoát, không retry 429 như các tool khác — cần chạy lại tay nếu bị throttle.
