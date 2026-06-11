# 📊 SharePoint Online Recycle Bin Report Generator

Công cụ script Python tự động kết nối với **Microsoft Graph API (Beta)** để quét toàn bộ dữ liệu trong Thùng rác (Recycle Bin) của một Site SharePoint được chỉ định. Script tiến hành phân tích, gom nhóm theo phòng ban và xuất ra báo cáo Excel (`.xlsx`) trực quan gồm hai cấu phần: Danh sách chi tiết và Bảng điều khiển (Dashboard) tổng hợp.

---

## ✨ Tính năng chính

* **Tích hợp Microsoft Graph API v2 (Beta):** Hỗ trợ phân trang tự động (`@odata.nextLink`) để tải mượt mà tập dữ liệu lớn với cơ chế tối ưu dung lượng tải (`$select`, `$top=15000`).
* **Trích xuất phòng ban thông minh (Dept Extraction):** Tự động bóc tách tên Phòng ban dựa trên cấu trúc đường dẫn gốc (`deletedFromLocation`).
* **Chuẩn hóa thời gian:** Tự động chuyển đổi mốc thời gian hệ thống của Microsoft từ giờ UTC sang giờ Việt Nam (**ICT - UTC+7**) để tiện theo dõi.
* **Tự động định dạng:** Tự động tính toán và hiển thị dung lượng file theo các đơn vị dễ đọc như `KB`, `MB`, `GB` thay vì chỉ hiển thị chuỗi byte khô khan.
* **Xuất báo cáo Excel chuyên nghiệp (`openpyxl`):**
* Tách biệt 2 Sheet rõ ràng: Dữ liệu chi tiết (`RECYCLE_BIN`) và Bảng tổng hợp (`DASHBOARD`).
* Tự động căn chỉnh độ rộng cột hạn chế tình trạng tràn chữ hoặc lỗi hiển thị `###`.
* Sắp xếp dữ liệu thông minh (Thời gian xóa mới nhất xếp lên đầu, phòng ban tốn dung lượng nhất xếp lên trước).



---

## 📂 Cấu trúc file báo cáo Excel đầu ra

File `recyclebin_report.xlsx` được tạo ra bao gồm 2 sheet:

### 1. Sheet `DASHBOARD`

Tổng hợp số liệu trực quan theo từng phòng ban (Department) được sắp xếp giảm dần theo dung lượng chiếm dụng:

* **Dept:** Tên phòng ban bóc tách từ đường dẫn.
* **Files:** Tổng số lượng file đã bị xóa của phòng ban đó.
* **Total Size:** Tổng dung lượng đã chiếm dụng trong thùng rác (đã định dạng dạng `GB/MB/KB`).
* *Dòng cuối:* Tổng cộng (`TOTAL`) toàn bộ site.

### 2. Sheet `RECYCLE_BIN`

Danh sách chi tiết của từng tệp tin/thư mục bị xóa, sắp xếp theo thứ tự **mới bị xóa gần đây nhất**:

* `deletedFromLocation`: Đường dẫn gốc trước khi bị xóa.
* `Dept`: Phòng ban quản lý file.
* `name`: Tên file hoặc thư mục.
* `size_bytes`: Dung lượng file tính bằng đơn vị bytes (tiện cho việc lọc/tính toán thủ công sau này).
* `deletedDateTime_VN`: Ngày giờ xóa (đã chuyển sang múi giờ Việt Nam).
* `deletedBy`: Tên hiển thị (`displayName`) của người thực hiện hành động xóa.

---

## 🚀 Hướng dẫn thiết lập và Sử dụng

### 1. Yêu cầu hệ thống

* Môi trường chạy: **Python 3.7+**
* Các thư viện cần cài đặt: `requests`, `openpyxl`

Cài đặt nhanh các thư viện phụ thuộc bằng lệnh pip:

```bash
pip install requests openpyxl

```

### 2. Cấu hình các tham số (Cần thiết trước khi chạy)

Mở file script bằng trình chỉnh sửa code (VS Code, PyCharm, Notepad++, v.v.) và cập nhật các thông tin cấu hình tại mục `= CONFIG =`:

* **`TOKEN`**: Điền Access Token (Bearer token) hợp lệ có quyền đọc dữ liệu thùng rác của bạn (ví dụ lấy từ *Graph Explorer*).
* **`SITE_ID`**: Điền mã định danh định dạng chuẩn 3 thành phần của SharePoint Site cần quét: `[domain.sharepoint.com],[site-id],[web-id]`.

> ⚠️ **Lưu ý an toàn bảo mật:** Đoạn mã chứa một token mẫu. Mã Token này có thời gian hết hạn ngắn. Khi đưa vào vận hành thực tế, hãy đảm bảo bạn thay thế bằng cơ chế lấy token tự động qua OAuth2 để tránh lỗi `401 Unauthorized`.

### 3. Khởi chạy

Chạy trực tiếp script thông qua Terminal hoặc Command Prompt:

```bash
python <ten_file_cua_ban>.py

```

Màn hình console sẽ hiển thị tiến trình quét theo từng trang (Page 1, Page 2...) và trả ra thông báo thành công cùng tổng số file quét được sau khi hoàn tất.

---

## 🛠️ Tùy biến nâng cao (Advanced Options)

* **Chế độ kiểm thử (Test Mode):** Nếu số lượng file trong thùng rác quá lớn (>100,000 files) và bạn muốn chạy thử nghiệm cấu trúc file, hãy bỏ dấu comment `#` ở dòng `# MAX_PAGES = 1` và thêm điều kiện dừng vào vòng lặp `while NEXT_URL` để giới hạn số trang tải về.
* **Thay đổi logic bóc tách phòng ban:** Hàm `get_dept()` hiện đang cắt chuỗi tại vị trí index số 2 dựa trên dấu gạch chéo `/`. Nếu cấu trúc thư mục SharePoint của tổ chức bạn khác đi (Ví dụ: Tên phòng ban nằm ngay ở thư mục gốc cấp 1), hãy chỉnh sửa lại logic tại `parts[2]` sang `parts[1]`.
