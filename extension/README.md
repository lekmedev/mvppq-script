# 📊 SharePoint Storage Analyzer via Graph API (Chrome Extension)

[![Chrome Web Store](https://img.shields.io/badge/Chrome__Web__Store-v3.1-blue.svg?logo=google-chrome&logoColor=white)](https://chrome.google.com/webstore)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-orange.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

**SharePoint Storage Analyzer** là một Chrome Extension mạnh mẽ được thiết kế dành riêng cho các Chuyên viên Quản trị Hệ thống (IT Administrators) và Đội ngũ Hỗ trợ Kỹ thuật (IT Support). Tiện ích này biến trang **Microsoft Graph Explorer** thành một trung tâm phân tích dữ liệu lưu trữ chuyên nghiệp, giúp tính toán chính xác và trích xuất báo cáo dung lượng của tất cả các ổ đĩa (Drive) trong một Site SharePoint chỉ với **1-Click**.

---

## 🔥 Các Tính Năng Vượt Trội

- **Tích Hợp Native UI:** Tự động nhúng bộ đôi nút chức năng "Tính Dung Lượng SP" và nút Cấu hình `⚙️` trực quan ngay cạnh nút "Access token" trên giao diện gốc của Graph Explorer.
- **Hook Token Ngầm An Toàn:** Tự động bắt mã xác thực (`Bearer Authorization Token`) từ phiên đăng nhập hiện tại của người dùng một cách bảo mật, không yêu cầu nhập thông tin tài khoản hay mật khẩu.
- **Tùy Biến URL Linh Hoạt (`New`):** Dễ dàng thay đổi URL của bất kỳ Site SharePoint nào cần quét thông qua giao diện cấu hình `⚙️`. Hệ thống sẽ lưu trữ cục bộ cấu hình này cho các lần sử dụng tiếp theo.
- **Quét Đa Luồng Real-time:** Tự động phân tích toàn bộ danh sách các Drive, bóc tách dung lượng từ các nút con và hiển thị tiến trình bóc tách theo thời gian thực (`Real-time logs`).
- **Giao Diện Master-Detail & MiniBar:** Kết quả hiển thị được sắp xếp từ cao đến thấp trực quan, tích hợp thanh trạng thái thu nhỏ (`MiniBar`) giúp tối ưu không gian làm việc trong lúc hệ thống chạy ngầm.
- **Xuất Báo Cáo Chuẩn Excel:** Hỗ trợ tính năng Sao chép (`Copy Data`) đã được tự động chuẩn hóa thứ tự tên Drive từ A-Z theo bảng chữ cái Tiếng Việt. Định dạng dạng `Tab-Separated` cho phép bạn **Paste thẳng vào Microsoft Excel** tạo thành một cấu trúc Master-Detail hoàn chỉnh không lỗi font.

---

## 🛠 Kiến Trúc Hệ Thống (Technical Stack)

Tiện ích được phát triển dựa trên các tiêu chuẩn bảo mật và tối ưu mới nhất:
- **Chrome Extension Manifest V3:** Tuân thủ cấu trúc bảo mật nghiêm ngặt của Google.
- **Hybrid Content & Inject Scripts:** Tách biệt môi trường xử lý DOM (`content.js`) và môi trường mạng của trang web (`inject.js`) nhằm bypass chính sách bảo mật CSP cao của Microsoft một cách hợp lệ.
- **Chrome Local Storage API:** Sử dụng `chrome.storage.local` để lưu trữ cấu hình ngoại tuyến ngay trên thiết bị của người dùng, không đồng bộ lên đám mây hay bên thứ ba.
- **Google Analytics 4 (GA4) Measurement Protocol:** Tích hợp bộ đo lường ẩn danh hiệu năng và tần suất sử dụng thông qua API Endpoint bảo mật, giúp nhà phát triển theo dõi tổng số lượt tương tác realtime mà không thu thập dữ liệu nhạy cảm cá nhân.

---

## 📌 Hướng Dẫn Cài Đặt (Dành cho Nhà phát triển / Cài thủ công)

Do tiện ích sử dụng kiến trúc mã nguồn mở, bạn có thể dễ dàng nạp vào trình duyệt theo các bước sau:

1. **Tải mã nguồn:** Tải bản phân phối này về máy máy tính của bạn và giải nén (ví dụ thư mục `sp-storage-analyzer`).
2. **Mở trình quản lý tiện ích:** Truy cập vào đường dẫn `chrome://extensions/` trên Chrome (hoặc `edge://extensions/` trên Microsoft Edge).
3. **Bật chế độ nhà phát triển:** Kích hoạt công tắc **Developer mode** (Chế độ nhà phát triển) ở góc trên bên phải màn hình.
4. **Nạp Extension:** Nhấn vào nút **Load unpacked** (Tải tiện ích đã giải nén) ở góc trên bên trái và chọn thư mục `sp-storage-analyzer` chứa các tệp tin `manifest.json`, `content.js`, `inject.js`, `styles.css`.

---

## 🚀 Hướng Dẫn Sử Dụng

1. Truy cập và đăng nhập tài khoản Microsoft 365 của bạn tại [Microsoft Graph Explorer](https://developer.microsoft.com/graph/graph-explorer).
2. Click vào nút **`⚙️`** trên thanh công cụ để nhập URL đầy đủ của trang SharePoint doanh nghiệp cần quét (Hệ thống có sẵn URL mẫu của tập đoàn Accor).
3. Bấm nút **📊 Tính Dung Lượng SP** và theo dõi bảng tiến trình.
4. Sau khi hệ thống hiển thị trạng thái "Đã quét xong!", nhấn **📋 Copy Dữ Liệu**.
5. Mở phần mềm **Microsoft Excel** trên máy tính, chọn một ô trống và nhấn `Ctrl + V` để nhận ngay báo cáo dữ liệu sạch sẽ, chuẩn hóa.

---

## 🔒 Cam Kết Bảo Mật (Privacy & Security)

- Tiện ích **KHÔNG** thu thập, ghi lại hoặc gửi bất kỳ thông tin xác thực, cookie, mật khẩu hay dữ liệu nội bộ SharePoint nào của bạn ra bên ngoài.
- Quyền `"storage"` chỉ dùng để lưu trữ URL cấu hình cá nhân của bạn và một chuỗi mã Client ID ngẫu nhiên phục vụ riêng cho biểu đồ đếm lượt bấm của Google Analytics 4.
- Mọi truy vấn API đều được thực hiện trực tiếp từ trình duyệt của người dùng đến máy chủ an toàn của Microsoft (`graph.microsoft.com`).

---

## 📄 Giấy Phép (License)

Phát hành dưới bản quyền **MIT License**. Bạn hoàn toàn có thể tự do đóng góp ý kiến (Pull Request) hoặc tùy biến mã nguồn phục vụ riêng cho doanh nghiệp của mình.
