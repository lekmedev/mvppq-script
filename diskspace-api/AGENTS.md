# AGENTS.md — diskspace-api

> Ngữ cảnh chung repo xem `../AGENTS.md`. Chi tiết cục bộ của tool DiskSpaceApi.

## Mô tả

Windows service `DiskSpaceApi` (.NET 8, C#) chạy dưới `LocalSystem`, lắng nghe TCP **9988**
qua HTTP.sys (`http://+:9988/`). `GET /disk` và `GET /` trả JSON dung lượng trống ổ C:/D:
kèm IP 10.139.x.x của máy. Thay thế PowerShell TCP listener cũ từng dùng port 8080.
Mỗi request chỉ query disk **theo từng request** — không polling nền.

Ví dụ response: `{"ip":"10.139.20.88","C_free_gb":120.5,"D_free_gb":450.2}`
(ổ không tồn tại serialize thành `null`).

## Cấu trúc

| File | Mô tả |
|---|---|
| `Program.cs` | Entry point, HTTP.sys listener, controller, logging (namespace `DiskSpaceApiService`) |
| `WorkstationLogic.cs` | Logic thuần IP/subnet/disk (namespace `DiskSpaceApi.Logic`) — **không** phụ thuộc DI/host |
| `appsettings.json` | Config production (port 9988, subnet `10.139.0.0/16`, drives C/D, log rotation 5 MiB × 5) |
| `publish.ps1` | Build + publish self-contained single-file win-x64 |
| `install.ps1` / `uninstall.ps1` | Đăng ký/gỡ Windows service, firewall `DiskSpaceApi TCP 9988` |
| `test-api.ps1` | Smoke test sau deploy |
| `tests/LogicTests/` | Unit test logic IP/subnet/disk (chạy trên Linux, 31 test) |

## Quy ước kỹ thuật (bẫy đã gặp — đừng tái phạm)

- Multi-target `net8.0;net8.0-windows`: build/test trên Linux, publish artifact Windows.
  Cross-publish từ Linux **bắt buộc** `-p:EnableWindowsTargeting=true`.
- Code Windows-only (`AddWindowsService`, `TimeoutManager.RequestQueue`) bọc `#if WINDOWS` —
  lỗi type (vd `RequestQueue` là `TimeSpan`, không phải `int`) **chỉ hiện** ở TFM
  `net8.0-windows`, build `net8.0` không lộ ra.
- `ConfigurationBinder` **append** vào `List<T>` có sẵn thay vì replace → property
  `Prefixes`/`Drives` trong options phải khởi tạo rỗng, fallback nằm ở
  `ResolvePrefixes()`/`ResolveDrives()`. Nếu để default inline, service bind trùng
  cả `http://+:9988/` lẫn prefix trong config.
- Content root phải là `AppContext.BaseDirectory` (+ `AddJsonFile` explicit):
  Windows service chạy với cwd = `C:\Windows\System32`, builder mặc định đọc config
  sai chỗ.
- Logging UTF-8 **không BOM** (`new UTF8Encoding(false)`).
- Build artifact (`bin/`, `obj/`, `*.log`) không commit — xem `.gitignore`.
  File `.exe` (~70 MB) nằm sẵn ở `publish/win-x64/DiskSpaceApi.exe` trong repo
  (force-add, bypass `.gitignore`) để lấy về chạy ngay không cần build.
  (`sp-usage-analyzer.js` có zip release cũ là ngoại lệ lịch sử, không áp dụng ở đây.)
- Commit message: ngắn, tiếng Anh.

## Verify & test

```powershell
# Trên Windows (triển khai)
.\publish.ps1
.\install.ps1
.\test-api.ps1
```

```bash
# Trên Linux (logic + HTTP runtime, port test 9991, xem README §9)
(cd tests/LogicTests && dotnet run -c Release)   # expect 31/31 PASS
dotnet build -c Release -f net8.0 --nologo        # expect 0 warning
dotnet build -c Release -f net8.0-windows --nologo  # expect 0 warning
```
