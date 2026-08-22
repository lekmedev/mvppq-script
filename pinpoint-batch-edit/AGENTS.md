# AGENTS.md — pinpoint-batch-edit

> Ngữ cảnh chung repo xem `../AGENTS.md`. Chi tiết cục bộ của tool Pinpoint audit.

## Mô tả

`main.py` — Python thuần (`requests` + `python-dotenv`, **KHÔNG dùng Playwright/browser**)
chạy **quick audit hàng loạt** thiết bị trên Pinpoint (zerorisk.io),
lấy auth gián tiếp qua trang quản trị HCP (Moodle).

## Cơ chế xác thực (đã reverse-engineer & verify 2026-08)

Access Token do **server Pinpoint cấp**, không phải JS client sinh. Chuỗi 4 request:

1. `GET {HCP_URL}/accor/login/index.php` → parse `logintoken` (CSRF) từ HTML form.
2. `POST` form login (username/password/logintoken/anchor) → session HCP
   (check thành công bằng `"home.php" in url`).
3. `GET {HCP_URL}/accor/hcp/ntt/nttcreatetest.php` với `allow_redirects=False`
   → **302 Location**: `{PINPOINT_BASE_URL}/auth/login-url/{uuid}`
   → `{uuid}` là vé one-time, mỗi lần login chỉ dùng được đúng 1 lần.
4. `GET {PINPOINT_BASE_URL}/api/v2/users/sign_in?token={uuid}` với header
   `x-requested-with: XMLHttpRequest` + `referer: .../auth/login-url/{uuid}`
   → body `result.token` (fallback: header `X-Auth-Token`).

Sau đó mọi API call chỉ cần header `x-auth-token`, **không cần cookie zerorisk.io**
(đã test dashboard 200 OK không cookie). Cookie HCP giữ trong `self.session`.

## Luồng hoạt động

1. `PinpointClient.login()` — chuỗi SSO 4 bước ở trên, lưu token vào `self.token`.
2. `run()` — lặp qua `DEVICE_IDS` (env), **random delay giữa các device** để tránh rate limit,
   log tiến trình từng thiết bị.
3. `quick_audit(device_id)` — POST thẳng `{PINPOINT_BASE_URL}/api/v1/pinpoint/quickaudit`
   với header `x-auth-token`.
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
pip install -r requirements.txt   # requests + python-dotenv
python main.py
```

README.md trong thư mục này có sẵn hướng dẫn deploy systemd service
(`/etc/systemd/system/pinpoint-audit.service`) để chạy nền trên Linux.

## Lưu ý khi sửa

- Vé one-time `{uuid}` **chỉ dùng được 1 lần** — đừng cache/retry bước 4 với cùng vé.
- Path `ntt/nttcreatetest.php` và field form Moodle nằm trong `login()` —
  HCP đổi UI/path là phải cập nhật lại.
- Random delay giữa devices là chủ đích (tránh bị Pinpoint block), đừng bỏ.
- Token sống theo session HCP; nếu audit loạt fail liên tục thì nghi ngờ hết phiên.
