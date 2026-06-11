# 🛠️ Windows File Timestamp Modifier (Bulk/Group Processing)

Công cụ script Python hỗ trợ thay đổi hàng loạt thuộc tính thời gian (**Created Date** và **Modified Date**) của các tệp tin hình ảnh (`.jpg`, `.jpeg`) trực tiếp trên File System của Windows dựa trên cấu trúc thư mục chứa chúng.

## ✨ Tính năng nổi bật

* **Tự động nhận diện thời gian qua cấu trúc thư mục:** Quét ngược từ vị trí file lên thư mục cha gần nhất có định dạng `Tháng X` (hoặc `tháng X`) để xác định mốc thời gian gốc.
* **Thuật toán dịch chuyển tháng thông minh:** * Tự động tính toán tháng mục tiêu dựa trên công thức dịch chuyển: $TargetMonth = (CurrentMonth \pmod{12}) + 1$.
* Tự động lũy tiến năm ($2026$) nếu tháng vượt quá 12.


* **Gom nhóm tệp thông minh (Smart Grouping):** Gom nhóm các file có cùng phần tên gốc (ví dụ: `HinhAnh .1`, `HinhAnh .2` thuộc cùng một nhóm) và đảm bảo các file trùng tên ở các thư mục `Tháng` khác nhau **không** bị trộn lẫn thuộc tính.
* **Ngẫu nhiên hóa (Randomization):** Tạo ngày giờ ngẫu nhiên (từ ngày 1 đến ngày 10) để thông tin ngày tháng trông tự nhiên, không bị trùng lặp cơ học.
* **Hiệu năng cao bằng Native API:** Sử dụng thư viện `pywin32` tương tác trực tiếp với Windows Kernel (`win32file.SetFileTime`), đảm bảo tốc độ xử lý cực nhanh và chính xác.

---

## 📂 Nguyên lý hoạt động dựa trên cấu trúc thư mục

Script hoạt động hoàn hảo với cấu trúc thư mục có dạng như sau:

```text
INVENTORY 2026 IMAGE/
│
├── Thư mục cha/
│   ├── Tháng 1/
│   │   ├── SanPhamA .1.jpg      --> Sẽ được đổi sang Tháng 2/2026
│   │   └── SanPhamA .2.jpg      --> Sẽ được đổi sang Tháng 2/2026
│   │
│   └── Tháng 12/
│       └── SanPhamA .1.jpg      --> Sẽ được đổi sang Tháng 1/2027 (Tự động tăng năm)

```

---

## 🚀 Hướng dẫn cài đặt và sử dụng

### 1. Yêu cầu hệ thống

* Hệ điều hành: **Windows** (Do sử dụng API native của Windows).
* Phiên bản Python: **Python 3.x**.

### 2. Cài đặt thư viện phụ thuộc

Script yêu cầu thư viện `pywin32` để tương tác với hệ thống tệp Windows. Mở Terminal / Command Prompt và chạy lệnh sau:

```bash
pip install pywin32

```

### 3. Cấu hình đường dẫn

Mở file script bằng một trình soạn thảo văn bản bất kỳ (VS Code, Notepad, v.v.) và cập nhật đường dẫn thư mục gốc của bạn tại biến `ROOT_PATH`:

```python
# Cấu hình đường dẫn tới thư mục chứa ảnh cần xử lý
ROOT_PATH = r"C:\Users\HNGUYENTRONG\Desktop\Thường Dùng\INVENTORY 2026 IMAGE"

```

### 4. Khởi chạy script

Chạy script bằng lệnh:

```bash
python <tên_file_của_bạn>.py

```

---

## 📊 Logic xử lý thời gian chi tiết

Khi một nhóm tệp được xác định thuộc về `Tháng X`:

1. **Tháng mục tiêu:** Được tính là Tháng $X + 1$. Nếu $X = 12$, tháng tiếp theo sẽ là Tháng 1 năm sau.
2. **Thời gian Khởi tạo (Created Date):**
* **Ngày:** Ngẫu nhiên từ ngày 1 đến ngày 10 của tháng mục tiêu.
* **Giờ/Phút/Giây:** Ngẫu nhiên hoàn toàn.
* *Lưu ý:* Các file trong cùng một nhóm (Group) sẽ được cộng thêm một khoảng delay ngẫu nhiên từ `0 - 600` giây để tránh trùng khít thời gian tạo.


3. **Thời gian Chỉnh sửa (Modified Date):** * Được tính bằng `Created Date` + một khoảng thời gian ngẫu nhiên từ `0 - 24` giờ (`86400` giây), đảm bảo logic hệ thống: *Ngày chỉnh sửa luôn sau hoặc bằng ngày khởi tạo*.

---

## ⚠️ Lưu ý quan trọng

> 🛑 **Khuyến cáo:** Script này thay đổi trực tiếp siêu dữ liệu (metadata) của file trên ổ cứng và **không thể hoàn tác (Undo)**. Hãy sao lưu (Backup) thư mục dữ liệu của bạn trước khi chạy script lần đầu tiên để tránh các rủi ro ngoài ý muốn.
