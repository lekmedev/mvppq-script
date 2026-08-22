# AGENTS.md — pinpoint-batch-edit

> Ngữ cảnh chung repo xem `../AGENTS.md`. Chi tiết cục bộ của tool Pinpoint audit.

## Mô tả

`main.py` — Playwright (sync API) automation chạy **quick audit hàng loạt** thiết bị trên
Pinpoint (zerorisk.io), lấy auth gián tiếp qua trang quản trị HCP.

## Luồng hoạt động

1. `PinpointClient.login()` — mở Chromium headless, điền form đăng nhập HCP
   (`HCP_URL`), chờ popup SSO, đánh cắp **token + cookies + user-agent** từ phiên trình duyệt.
2. `run()` — lặp qua `DEVICE_IDS` (env), **random delay giữa các device** để tránh rate limit,
   log tiến trình từng thiết bị.
3. `quick_audit(device_id)` — POST thẳng `{PINPOINT_BASE_URL}/api/v1/pinpoint/quickaudit`
   bằng requests + cookies đã lấy.
4. Báo cáo tổng kết qua **Discord webhook**: embed xanh nếu tất cả OK,
   embed đỏ kèm danh sách link device fail nếu có lỗi.

## Cấu hình — hoàn toàn qua `.env` (KHÔNG commit .env)

| Biến | Ý nghĩa |
|---|---|
| `HCP_URL` | Trang đăng nhập HCP (mặc định `https://hcp.vigitrust.com`) |
| `HCP_USERNAME` / `HCP_PASSWORD` | Credentials HCP |
| `PINPOINT_BASE_URL` | Mặc định `https://pinpoint.zerorisk.io` |
| `DEVICE_URL_TEMPLATE` | Template link device cho Discord (mặc định `{base}/devices/{id}`) |
| `DEVICE_IDS` | Chuỗi ID cách nhau bởi dấu phẩy,VD `"101,102,103"` |
| `DISCORD_WEBHOOK` | Webhook nhận báo cáo (bỏ trống = không gửi) |

## Chạy & deploy

```bash
pip install playwright requests python-dotenv
playwright install chromium      # bắt buộc trước lần chạy đầu
python main.py
```

README.md trong thư mục này có sẵn hướng dẫn deploy systemd service
(`/etc/systemd/system/pinpoint-audit.service`) để chạy nền trên Linux.

## Lưu ý khi sửa

- Selector form login HCP nằm trong `login()` — site đổi UI là phải cập nhật lại.
- Random delay giữa devices là chủ đích (tránh bị Pinpoint block), đừng bỏ.
- Token/cookies sống theo session HCP; nếu audit loạt fail liên tục thì nghi ngờ hết phiên.
