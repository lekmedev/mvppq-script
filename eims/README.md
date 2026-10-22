# Auto Total Cost & VAT

Userscript (Violentmonkey/Tampermonkey) tự tính tiền trên form e-sign `eofficeform/formedit`.

## Tính năng

- Thành tiền mỗi dòng = số lượng × đơn giá, tính ngay khi nhập.
- **Total Cost** = tổng cột thứ 7 của bảng, tự cập nhật khi bấm **Update**, thêm hoặc xóa dòng.
- **VAT Amount** và **Total Including VAT** tự tính theo **Tax Rate**.
- Cộng theo cent nên không lệch 0.01.
- Tự bật/tắt khi chuyển trang (web là SPA Blazor), chỉ chạy ở `/eofficeform/formedit`.

## Cài đặt

1. Cài [Violentmonkey](https://violentmonkey.github.io/) (hoặc Tampermonkey).
2. Mở file `auto-total-cost-vat.user.js` ở dạng Raw trên GitHub, extension sẽ hiện trang cài đặt, bấm **Confirm**.
3. Mở trang form và tải lại (F5).

## Lệnh trong Console

```js
__autoTotalVM.updateAllTotals(); // tính lại toàn bộ
__autoTotalVM.stop();            // dừng hẳn
```

## Cấu hình

Sửa object `config` đầu file:

| Khóa | Ý nghĩa |
|---|---|
| `quantity`, `price`, `rowTotal` | Selector ô số lượng, đơn giá, thành tiền của dòng (`#b`, `#c`, `#a`) |
| `totalCostXPath`, `taxRateXPath`, `vatAmountXPath`, `totalIncludingVatXPath` | XPath các ô tổng |
| `tbodySelector`, `tbodyIndex`, `totalColumn` | Bảng chứa dòng (tbody thứ 4) và cột thành tiền (cột 7) |

Đặt `DEBUG = true` để xem log trong Console.

## Lưu ý

- XPath tuyệt đối và `tbodyIndex` sẽ hỏng nếu giao diện đổi layout, cần cập nhật lại trong `config`.
- `parseNumber` coi `2.500` hoặc `1,500` là dấu phân tách hàng nghìn (2500, 1500). Nếu số lượng có 3 chữ số thập phân thì cần sửa hàm này.
- Khi đang sửa dòng, script không tự tính lại tổng để tránh làm form render lại; tổng cập nhật sau khi lưu dòng.

## Lịch sử phiên bản

- **1.2.1** Sửa tính dòng khi nhập; không tính tổng lúc đang sửa dòng.
- **1.2.0** Hỗ trợ điều hướng SPA từ `/eofficeform/`.
- **1.1.0** Tách cleanup/timer, throttle observer, theo dõi tbody, tính theo cent.
- **1.0.0** Bản đầu.
