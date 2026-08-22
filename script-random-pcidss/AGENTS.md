# AGENTS.md — script-random-pcidss

> Ngữ cảnh chung repo xem `../AGENTS.md`. Chi tiết cục bộ của tool random timestamp PCIDSS.

## Mô tả

`random-pcidss.py` — script **Windows-only**: duyệt cây thư mục `ROOT_PATH` và randomize
timestamp Created/Modified của từng file bằng Win32 API native (qua pywin32),
phục vụ chuẩn bị image máy/inventory theo yêu cầu PCIDSS.

## Cách hoạt động

- Đường dẫn gốc đặt trong biến `ROOT_PATH` ở đầu file (hiện đang rỗng — phải điền trước khi chạy).
- `change_file_times_native()` mở file bằng `win32file.CreateFile` với share-mode đầy đủ
  rồi gọi `win32file.SetFileTime` — chính xác hơn cách dùng `os.utime` (chỉ sửa được modified).
- Ngày random sinh trong một khoảng thời gian hợp lý (xem logic `timedelta` trong main),
  created ≤ modified luôn được đảm bảo.
- Console output màu ANSI (GREEN/RED/YELLOW) — cần terminal hiện đại
  (Windows Terminal / VS Code terminal); cmd cũ sẽ hiện mã escape thô.

## Chạy

```bash
pip install pywin32
python random-pcidss.py    # sau khi điền ROOT_PATH
```

## Lưu ý

- **Chỉ chạy trên Windows** (pywin32). Không có dry-run — script đổi timestamp thật,
  hãy test trên thư mục mẫu trước khi chạy trên dữ liệu chính thức.
- File đang bị khóa bởi tiến trình khác sẽ fail mở handle — script bỏ qua và báo đỏ,
  không làm đứt cả lượt quét.
- Nếu thêm tính năng: giữ nguyên dùng Win32 API cho created date, `os.utime` không thay thế được.
