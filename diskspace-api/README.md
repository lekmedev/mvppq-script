# DiskSpaceApi

A lightweight .NET 8 Worker Service for Windows that reports this workstation's
`10.139.x.x` IP address and free disk space over HTTP on TCP **9988**.

It replaces the PowerShell TCP listener script that previously performed the same
job. No PowerShell runtime, no console window, no interactive session.

```
GET http://<workstation-ip>:9988/disk
```

```json
{
  "ip": "10.139.20.88",
  "C_free_gb": 120,
  "D_free_gb": 450
}
```

---

## 1. What it does

| Route | Method | Response |
|---|---|---|
| `/disk` | GET / HEAD | `200` + JSON payload |
| `/` | GET / HEAD | `200` + JSON payload (alias) |
| anything else | GET / HEAD | `404` Not Found |
| any route | POST / PUT / DELETE / OPTIONS / … | `405` Method Not Allowed |

`GET` returns the body; `HEAD` returns only the headers, with the correct
`Content-Length` and no body, as RFC 9110 requires.

**IP selection** — deterministic, and biased toward the address the monitoring
system actually expects:

1. Only `IPv4` addresses whose address family is `InterNetwork`.
2. Only addresses inside the configured subnet (`10.139.0.0/16` by default).
3. Loopback (`127.0.0.0/8`) and APIPA (`169.254.0.0/16`) are always ignored.
4. Of the remaining candidates, the one on the interface with the highest
   operational status (`Up` before `Testing`/`Unknown` before `Dormant`) and the
   fastest link speed wins; ties break on the lowest numeric IPv4 value.
5. If nothing matches, `"ip"` is `"Unknown"`.

Because step 4 breaks ties numerically rather than by "whichever interface
Windows enumerates first," two machines with identical NIC layouts always pick
the same address.

**Free space** — queried **only when a request arrives**. There is no timer, no
background poll, no cached value that could go stale. A drive that is missing or
unreadable returns `null` rather than an error.

---

## 2. Requirements

- Windows x64 (Windows 10 / Server 2016 or newer).
- The service account needs `LocalSystem` by default (see §6 for the
  least-privilege option).
- Port `9988` must be free — the previous PowerShell script must be stopped
  before installing, or the new service will fail to bind.
- No PowerShell, Node.js, Python, Docker, or database is required.

---

## 3. Build

From the project root:

```powershell
.\publish.ps1
```

That produces `publish\win-x64\DiskSpaceApi.exe` — a self-contained, single-file
executable. It bundles the .NET 8 runtime, so the target machine needs no
separate runtime install.

To build from another machine (or from Linux/macOS) for Windows:

```powershell
.\publish.ps1 -Cross
```

Manual equivalent:

```powershell
dotnet publish -c Release -f net8.0-windows -r win-x64 --self-contained true `
  -p:PublishSingleFile=true -p:EnableWindowsTargeting=true `
  -o .\publish\win-x64
```

The project multi-targets `net8.0` and `net8.0-windows` on purpose. The extra
`net8.0` target exists so the code compiles, and the logic tests run, on any OS;
only `net8.0-windows` is published.

---

## 4. Install

Run PowerShell **as Administrator**:

```powershell
.\install.ps1
```

The installer will:

1. Stop and remove any pre-existing `DiskSpaceApi` service (idempotent — safe to
   re-run, it never leaves a duplicate).
2. Copy `publish\win-x64\` to `C:\ProgramData\DiskSpaceApi\app`.
3. Create `C:\ProgramData\DiskSpaceApi\logs`.
4. Register the service: name `DiskSpaceApi`, display name `Disk Space API`,
   start type Automatic, running as `LocalSystem`.
5. Add the HTTP.sys URL reservation for `http://+:9988/`.
6. Create the firewall rule `DiskSpaceApi TCP 9988` (inbound, TCP, port 9988,
   remote address `10.139.0.0/16`, allow, Domain + Private profiles).
7. Start the service.

Custom install paths:

```powershell
.\install.ps1 -ExePath D:\Deploy\DiskSpaceApi.exe -InstallPath D:\DiskSpaceApi
```

---

## 5. Verify

```powershell
.\test-api.ps1
```

The test script calls the API and checks the JSON shape, the `10.139.` IP
prefix, the `Content-Type` header, and the `404` / `405` behaviour.

By hand, from any machine in `10.139.0.0/16`:

```powershell
curl.exe -s http://10.139.20.88:9988/disk
curl.exe -s -o NUL -w "%{http_code}\n" http://10.139.20.88:9988/nope       # 404
curl.exe -s -o NUL -w "%{http_code}\n" -X POST http://10.139.20.88:9988/disk # 405
```

Service and listener status:

```powershell
Get-Service DiskSpaceApi
sc.exe query DiskSpaceApi
sc.exe qc DiskSpaceApi

netstat -ano | findstr :9988
Get-NetTCPConnection -LocalPort 9988 -State Listen
```

Firewall rule:

```powershell
Get-NetFirewallRule -DisplayName "DiskSpaceApi TCP 9988" |
  Get-NetFirewallPortFilter
Get-NetFirewallRule -DisplayName "DiskSpaceApi TCP 9988" |
  Get-NetFirewallAddressFilter
```

Effective service process:

```powershell
Get-Process -Name DiskSpaceApi
```

Logs:

```powershell
Get-Content C:\ProgramData\DiskSpaceApi\logs\service.log -Tail 40 -Wait
```

---

## 6. Permissions

| Action | Who | Why |
|---|---|---|
| Stop / unbind port 9988 | Service account | releasing the socket on shutdown |
| Read `C:\` and `D:\` capacity | Service account | free-space query |
| Write `C:\ProgramData\DiskSpaceApi\logs` | Service account | log file |
| `URL reservation` for `http://+:9988/` | Administrator (install only) | HTTP.sys prefix ACL |
| Firewall rule | Administrator (install only) | inbound TCP rule |
| Service registration | Administrator (install only) | Service Control Manager |

The default account is `LocalSystem`, which satisfies all of the above with no
extra setup. `LocalSystem` only has the rights it needs here because the service
does nothing but read two drive capacities and append to its own log folder.

To run under a dedicated least-privilege account instead:

```powershell
# Create the account, grant it write access to the log folder, then register
# the service with those credentials.
$svc = Get-CimInstance Win32_SystemAccount -Filter "Name='Svc_DiskSpaceApi'"
```

If you do switch accounts, grant that account `Modify` on
`C:\ProgramData\DiskSpaceApi\logs\` and re-reserve the URL prefix for it:

```powershell
netsh http add urlacl url=http://+:9988/ user=DOMAIN\Svc_DiskSpaceApi
```

Removing the old PowerShell listener is part of uninstalling, not installing —
see §8.

---

## 7. Measuring real memory and CPU use

No RAM figure is claimed here, because it depends on the build, the machine, and
the request rate. Measure it on your own hardware:

```powershell
# Snapshot now
Get-Process -Name DiskSpaceApi |
  Select-Object Name, Id,
    @{n='WorkingSetMB';e={[math]::Round($_.WorkingSet64/1MB,1)}},
    @{n='PrivateMB';   e={[math]::Round($_.PrivateMemorySize64/1MB,1)}},
    @{n='CPUSec';      e={[math]::Round($_.CPU,1)}}

# Sample every 2s, 30 samples
Get-Counter -Counter "\Process(DiskSpaceApi)\Working Set - Private" -SampleInterval 2 -MaxSamples 30

# Sustained load test: 500 sequential requests, measure elapsed + RAM delta
Measure-Command {
  1..500 | ForEach-Object {
    Invoke-WebRequest -Uri http://localhost:9988/disk -UseBasicParsing | Out-Null
  }
}
Get-Process -Name DiskSpaceApi |
  Select-Object @{n='WorkingSetMB';e={[math]::Round($_.WorkingSet64/1MB,1)}}
```

`Working Set - Private` is the reliable number for a single-file
self-contained process. Compare it before and after the load test to confirm the
service does not leak under request traffic.

Expected characteristics: the accept loop is genuinely idle between requests
(the listener blocks in the kernel, no spin), disk is only read per request, and
each request is handled by a bounded `Task` from the thread pool rather than an
unbounded new thread, so a slow client cannot exhaust the pool.

---

## 8. Uninstall / rollback

Run PowerShell as Administrator:

```powershell
.\uninstall.ps1
```

This stops the service, deletes it, removes the firewall rule, and removes the
`http://+:9988/` URL reservation. The app binaries under
`C:\ProgramData\DiskSpaceApi` are **left in place** so you can inspect them or
reinstall; delete the folder manually if you want a clean removal.

To return to the PowerShell listener, run the old script again after
uninstalling — port `9988` is released by the uninstaller.

---

## 9. Troubleshooting

**Service will not start**

```powershell
Get-WinEvent -LogName System -FilterXPath "*[System[Provider[@Name='Service Control Manager'] and (EventID=7000 or EventID=7009 or EventID=7031)]]" -MaxEvents 10
```

Common cause: port 9988 still held by the old PowerShell script. Find and stop
it:

```powershell
Get-NetTCPConnection -LocalPort 9988 -State Listen |
  Select-Object OwningProcess
Get-Process -Id (Get-NetTCPConnection -LocalPort 9988 -State Listen).OwningProcess
```

**Connection works locally but not from another machine**

The firewall rule is restricted to `10.139.0.0/16` on purpose. Confirm the
calling host is really in that subnet, then check the rule:

```powershell
Get-NetFirewallRule -DisplayName "DiskSpaceApi TCP 9988" | Format-List *
Test-NetConnection -ComputerName 10.139.20.88 -Port 9988
```

If the rule is missing, re-run `install.ps1`. Do **not** disable Windows
Firewall to get around this.

**`ip` returns `"Unknown"`**

No active interface has an address in `10.139.0.0/16`. Check what the OS actually
sees:

```powershell
Get-NetIPAddress -AddressFamily IPv4 | Where-Object AddressState -eq 'Preferred'
```

**Log shows `Address already in use`**

Something else owns 9988, or a previous instance has not yet released it. Wait
~30 seconds and restart; if it persists, the port is genuinely taken.

**Client gets 411 on POST**

`HttpListener` rejects a bodyless POST before the application runs — that is the
handler behaving per spec, not a bug in the service.

---

## 10. Project layout

```
DiskSpaceApi/
├── DiskSpaceApi.csproj        net8.0;net8.0-windows multi-target
├── Program.cs                 host, HTTP listener, request handling, logging
├── WorkstationLogic.cs        pure IP-selection + free-space logic (unit tested)
├── appsettings.json           port, prefixes, drives, subnet, log settings
├── publish.ps1                self-contained win-x64 single-file publish
├── install.ps1                service + URL reservation + firewall rule
├── uninstall.ps1              remove service + rule + reservation
├── test-api.ps1               end-to-end API validation
├── README.md                  this file
└── tests/
    └── LogicTests/           pure-logic unit tests (run on any OS)
```

---

## 11. Configuration

All settings live in `appsettings.json`, next to the executable. No rebuild is
needed to change them.

```json
{
  "DiskSpaceApi": {
    "Port": 9988,
    "Prefixes": [ "http://+:9988/" ],
    "Drives": [ "C", "D" ],
    "Subnet": "10.139.0.0",
    "SubnetPrefixLength": 16,
    "LogDirectory": "C:\\ProgramData\\DiskSpaceApi\\logs",
    "MaxLogFileBytes": 5242880,
    "MaxLogFiles": 5,
    "RequestTimeoutMs": 10000,
    "ClientReadDelayEnabled": true
  }
}
```

- `Port` is informational — the real bind comes from `Prefixes`.
- `Prefixes` are HTTP.sys reservations. Change the port in both places.
- `Subnet` / `SubnetPrefixLength` define which IPv4 addresses are considered
  "this workstation."
- `MaxLogFileBytes` × `MaxLogFiles` bounds the log at ~25 MiB; rotation keeps
  the most recent files and writes UTF-8 **without** a BOM so the first line
  stays parsable.
- `RequestTimeoutMs` bounds how long a single request may hold a slot, so a
  stalled client cannot block the listener.

Environment variables override any of these if you need per-machine values
without editing the file, e.g. `DiskSpaceApi__Port=9999`.
