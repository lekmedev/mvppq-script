"""
SharePoint Storage Analyzer - Deep Scan (WinDirStat style)
============================================================
Yêu cầu: pip install requests rich

Cách dùng:
  python sharepoint_analyzer.py

Lần đầu chạy sẽ yêu cầu đăng nhập qua trình duyệt (Device Code Flow).
Token được lưu vào file token_cache.json để dùng lại lần sau.
"""

import json
import os
import csv
import time
import sys
from datetime import datetime, timedelta
from pathlib import Path

import requests
from rich.console import Console
from rich.tree import Tree
from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn, TaskProgressColumn
from rich.table import Table
from rich.panel import Panel
from rich.prompt import Prompt, Confirm
from rich import print as rprint
from rich.text import Text
from rich.live import Live
from rich.columns import Columns

# ============================================================
# CẤU HÌNH
# ============================================================
SITE_ID      = "accor.sharepoint.com,a492f6be-ff59-436a-a787-c1b229777590,3e279574-1667-4526-aec6-9302a7b09340"
CLIENT_ID    = "14d82eec-204b-4c2f-b7e8-296a70dab67e"   # Graph Explorer public client (không cần đăng ký app)
TENANT_ID    = "common"
SCOPE        = "Sites.Read.All Files.Read.All"
TOKEN_FILE   = "token_cache.json"
RESULT_FILE  = "sharepoint_scan_result.json"
CSV_FILE     = "sharepoint_scan_result.csv"

GRAPH_BASE   = "https://graph.microsoft.com/v1.0"

console = Console()


# ============================================================
# XÁC THỰC - DEVICE CODE FLOW
# ============================================================
def load_token():
    if not Path(TOKEN_FILE).exists():
        return None
    with open(TOKEN_FILE) as f:
        data = json.load(f)
    # Kiểm tra hết hạn (có buffer 60s)
    expires_at = data.get("expires_at", 0)
    if time.time() < expires_at - 60:
        return data.get("access_token")
    # Thử refresh
    refresh_token = data.get("refresh_token")
    if refresh_token:
        return refresh_access_token(refresh_token)
    return None


def refresh_access_token(refresh_token):
    url = f"https://login.microsoftonline.com/{TENANT_ID}/oauth2/v2.0/token"
    resp = requests.post(url, data={
        "grant_type":    "refresh_token",
        "client_id":     CLIENT_ID,
        "refresh_token": refresh_token,
        "scope":         SCOPE,
    })
    if resp.ok:
        return save_token(resp.json())
    return None


def save_token(token_data):
    token_data["expires_at"] = time.time() + token_data.get("expires_in", 3600)
    with open(TOKEN_FILE, "w") as f:
        json.dump(token_data, f, indent=2)
    return token_data["access_token"]


def authenticate():
    token = load_token()
    if token:
        console.print("[green]✔ Dùng token đã lưu (token_cache.json)[/green]")
        return token

    console.print(Panel("[bold cyan]Cần đăng nhập Microsoft[/bold cyan]\nSẽ dùng Device Code Flow — không cần nhập mật khẩu vào đây.", border_style="cyan"))

    url = f"https://login.microsoftonline.com/{TENANT_ID}/oauth2/v2.0/devicecode"
    resp = requests.post(url, data={"client_id": CLIENT_ID, "scope": SCOPE})
    resp.raise_for_status()
    device = resp.json()

    console.print(f"\n[bold yellow]👉 Truy cập:[/bold yellow] [underline]{device['verification_uri']}[/underline]")
    console.print(f"[bold yellow]🔑 Nhập mã:[/bold yellow]  [bold white on blue] {device['user_code']} [/bold white on blue]\n")

    token_url = f"https://login.microsoftonline.com/{TENANT_ID}/oauth2/v2.0/token"
    interval  = device.get("interval", 5)
    deadline  = time.time() + device.get("expires_in", 900)

    with console.status("[cyan]Đang chờ xác nhận đăng nhập...[/cyan]"):
        while time.time() < deadline:
            time.sleep(interval)
            r = requests.post(token_url, data={
                "grant_type":  "urn:ietf:params:oauth:grant-type:device_code",
                "client_id":   CLIENT_ID,
                "device_code": device["device_code"],
            })
            data = r.json()
            if "access_token" in data:
                access_token = save_token(data)
                console.print("[bold green]✔ Đăng nhập thành công![/bold green]")
                return access_token
            if data.get("error") not in ("authorization_pending", "slow_down"):
                console.print(f"[red]Lỗi xác thực: {data.get('error_description')}[/red]")
                sys.exit(1)

    console.print("[red]Hết thời gian chờ. Vui lòng chạy lại.[/red]")
    sys.exit(1)


# ============================================================
# GRAPH API HELPERS
# ============================================================
def graph_get(url, headers, params=None):
    """GET với retry khi bị throttle (429)."""
    while True:
        resp = requests.get(url, headers=headers, params=params)
        if resp.status_code == 429:
            wait = int(resp.headers.get("Retry-After", 10))
            console.print(f"[yellow]⏳ Bị throttle, chờ {wait}s...[/yellow]")
            time.sleep(wait)
            continue
        resp.raise_for_status()
        return resp.json()


def get_all_pages(url, headers):
    """Lấy tất cả trang (pagination) từ Graph API."""
    items = []
    while url:
        data = graph_get(url, headers)
        items.extend(data.get("value", []))
        url = data.get("@odata.nextLink")
    return items


# ============================================================
# QUÉT ĐỆ QUY THƯ MỤC
# ============================================================
scan_stats = {"files": 0, "folders": 0, "api_calls": 0}


def scan_folder(drive_id, item_id, headers, progress, task, depth=0, path="/"):
    """
    Quét đệ quy một thư mục, trả về dict dạng cây:
    {
        "name": "...",
        "path": "...",
        "size": <bytes>,
        "type": "folder"|"file",
        "children": [...]
    }
    """
    url = f"{GRAPH_BASE}/drives/{drive_id}/items/{item_id}/children"
    url += "?$select=name,id,size,folder,file,lastModifiedDateTime&$top=200"

    scan_stats["api_calls"] += 1
    children_raw = get_all_pages(url, headers)
    progress.update(task, description=f"[cyan]Quét:[/cyan] {path[:60]}")

    node_children = []
    node_size = 0

    for item in children_raw:
        child_path = f"{path}{item['name']}/"
        if "folder" in item:
            scan_stats["folders"] += 1
            progress.advance(task)
            child_node = scan_folder(drive_id, item["id"], headers, progress, task, depth + 1, child_path)
            node_children.append(child_node)
            node_size += child_node["size"]
        else:
            scan_stats["files"] += 1
            file_size = item.get("size", 0)
            node_size += file_size
            node_children.append({
                "name": item["name"],
                "path": child_path.rstrip("/"),
                "size": file_size,
                "type": "file",
                "modified": item.get("lastModifiedDateTime", ""),
                "children": []
            })

    # Sắp xếp con theo dung lượng giảm dần
    node_children.sort(key=lambda x: x["size"], reverse=True)

    return {
        "name": path.rstrip("/").split("/")[-1] or "/",
        "path": path,
        "size": node_size,
        "type": "folder",
        "children": node_children
    }


# ============================================================
# FORMAT DỮ LIỆU
# ============================================================
def fmt_size(b):
    """Định dạng bytes thành dạng dễ đọc."""
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if b < 1024:
            return f"{b:.1f} {unit}"
        b /= 1024
    return f"{b:.1f} PB"


def size_color(b, total):
    """Màu theo tỉ lệ dung lượng."""
    ratio = b / total if total else 0
    if ratio > 0.3:   return "bold red"
    if ratio > 0.1:   return "bold yellow"
    if ratio > 0.01:  return "green"
    return "dim white"


# ============================================================
# HIỂN THỊ CÂY THƯ MỤC (RICH TREE)
# ============================================================
def build_rich_tree(node, rich_node, total_size, max_depth=3, depth=0):
    if depth >= max_depth:
        if node["children"]:
            rich_node.add(Text(f"... ({len(node['children'])} mục)", style="dim"))
        return

    for child in node["children"]:
        size_str = fmt_size(child["size"])
        color    = size_color(child["size"], total_size)
        pct      = (child["size"] / total_size * 100) if total_size else 0

        if child["type"] == "folder":
            icon  = "📁"
            label = Text()
            label.append(f"{icon} {child['name']}", style=color)
            label.append(f"  {size_str}", style=color)
            label.append(f"  ({pct:.1f}%)", style="dim")
            branch = rich_node.add(label)
            build_rich_tree(child, branch, total_size, max_depth, depth + 1)
        else:
            icon  = "📄"
            label = Text()
            label.append(f"{icon} {child['name']}", style=color)
            label.append(f"  {size_str}", style="dim")
            rich_node.add(label)


def show_tree(drive_tree, drive_name, total_size, max_depth=3):
    root_label = Text()
    root_label.append(f"🗄️  {drive_name}", style="bold blue")
    root_label.append(f"  —  {fmt_size(total_size)}", style="bold white")

    tree = Tree(root_label)
    build_rich_tree(drive_tree, tree, total_size, max_depth)
    console.print(tree)


# ============================================================
# EXPORT CSV (FLAT)
# ============================================================
def flatten_to_csv(node, rows, drive_name):
    rows.append({
        "drive":    drive_name,
        "path":     node["path"],
        "name":     node["name"],
        "type":     node["type"],
        "size_b":   node["size"],
        "size_str": fmt_size(node["size"]),
    })
    for child in node["children"]:
        flatten_to_csv(child, rows, drive_name)


def export_csv(all_drives_data):
    rows = []
    for d in all_drives_data:
        flatten_to_csv(d["tree"], rows, d["name"])

    with open(CSV_FILE, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=["drive", "path", "name", "type", "size_b", "size_str"])
        writer.writeheader()
        writer.writerows(rows)
    console.print(f"[green]✔ Đã xuất CSV:[/green] {CSV_FILE}  ({len(rows):,} dòng)")


# ============================================================
# MENU TƯƠNG TÁC SAU KHI QUÉT
# ============================================================
def interactive_menu(all_drives_data):
    total_all = sum(d["total_size"] for d in all_drives_data)

    while True:
        console.print("\n" + "─" * 60)
        console.print("[bold cyan]📋 MENU[/bold cyan]")
        console.print("  [1] Xem bảng tóm tắt tất cả Drive")
        console.print("  [2] Xem cây thư mục một Drive cụ thể")
        console.print("  [3] Xem cây TẤT CẢ Drive (depth 2)")
        console.print("  [4] Tìm thư mục/file lớn nhất (Top 20)")
        console.print("  [5] Xuất kết quả ra CSV")
        console.print("  [6] Lưu kết quả JSON (để dùng lại)")
        console.print("  [0] Thoát")

        choice = Prompt.ask("\n[bold]Chọn[/bold]", choices=["0","1","2","3","4","5","6"], default="1")

        if choice == "0":
            break

        elif choice == "1":
            table = Table(title="📊 Tóm Tắt Dung Lượng Các Drive", show_lines=True)
            table.add_column("#",          style="dim", width=4)
            table.add_column("Tên Drive",  style="bold white", min_width=30)
            table.add_column("Dung Lượng", style="bold green", justify="right")
            table.add_column("Tỉ Lệ",      justify="right")
            table.add_column("Files",      justify="right", style="dim")
            table.add_column("Thư Mục",    justify="right", style="dim")

            for i, d in enumerate(all_drives_data, 1):
                pct = d["total_size"] / total_all * 100 if total_all else 0
                bar = "█" * int(pct / 5) + "░" * (20 - int(pct / 5))
                table.add_row(
                    str(i),
                    d["name"],
                    fmt_size(d["total_size"]),
                    f"{bar}  {pct:.1f}%",
                    str(d.get("file_count", "?")),
                    str(d.get("folder_count", "?")),
                )

            table.add_section()
            table.add_row("", "[bold]TỔNG[/bold]", f"[bold]{fmt_size(total_all)}[/bold]", "100%", "", "")
            console.print(table)

        elif choice == "2":
            for i, d in enumerate(all_drives_data, 1):
                console.print(f"  [{i}] {d['name']}  ({fmt_size(d['total_size'])})")
            idx = Prompt.ask("Chọn Drive (số)", default="1")
            depth = Prompt.ask("Hiển thị sâu mấy cấp", default="3")
            try:
                d = all_drives_data[int(idx) - 1]
                show_tree(d["tree"], d["name"], d["total_size"], int(depth))
            except (IndexError, ValueError):
                console.print("[red]Lựa chọn không hợp lệ[/red]")

        elif choice == "3":
            for d in all_drives_data:
                show_tree(d["tree"], d["name"], d["total_size"], max_depth=2)

        elif choice == "4":
            all_items = []
            for d in all_drives_data:
                collect_all(d["tree"], all_items, d["name"])
            all_items.sort(key=lambda x: x["size"], reverse=True)
            top = all_items[:20]

            table = Table(title="🏆 Top 20 Mục Lớn Nhất", show_lines=True)
            table.add_column("#",    width=4, style="dim")
            table.add_column("Drive", style="bold blue", width=20)
            table.add_column("Đường Dẫn", min_width=35)
            table.add_column("Loại", width=8)
            table.add_column("Dung Lượng", justify="right", style="bold green")

            for i, item in enumerate(top, 1):
                icon = "📁" if item["type"] == "folder" else "📄"
                table.add_row(str(i), item["drive"], item["path"], f"{icon} {item['type']}", fmt_size(item["size"]))
            console.print(table)

        elif choice == "5":
            export_csv(all_drives_data)

        elif choice == "6":
            with open(RESULT_FILE, "w", encoding="utf-8") as f:
                json.dump(all_drives_data, f, ensure_ascii=False, indent=2)
            console.print(f"[green]✔ Đã lưu:[/green] {RESULT_FILE}")


def collect_all(node, result, drive_name):
    result.append({"drive": drive_name, "path": node["path"], "type": node["type"], "size": node["size"]})
    for c in node["children"]:
        collect_all(c, result, drive_name)


# ============================================================
# MAIN
# ============================================================
def main():
    console.print(Panel.fit(
        "[bold blue]SharePoint Deep Storage Analyzer[/bold blue]\n"
        "[dim]Quét sâu toàn bộ thư mục — WinDirStat style[/dim]",
        border_style="blue"
    ))

    # Kiểm tra có kết quả cũ không
    use_cache = False
    if Path(RESULT_FILE).exists():
        mtime = datetime.fromtimestamp(Path(RESULT_FILE).stat().st_mtime)
        age   = datetime.now() - mtime
        console.print(f"\n[yellow]⚠ Tìm thấy kết quả quét cũ từ {mtime.strftime('%d/%m/%Y %H:%M')} ({age.seconds//3600}h{(age.seconds%3600)//60}m trước)[/yellow]")
        use_cache = Confirm.ask("Dùng kết quả cũ thay vì quét lại?", default=True)

    if use_cache:
        with open(RESULT_FILE, encoding="utf-8") as f:
            all_drives_data = json.load(f)
        console.print(f"[green]✔ Đã tải {len(all_drives_data)} drive từ cache[/green]")
    else:
        # Xác thực
        token   = authenticate()
        headers = {"Authorization": f"Bearer {token}"}

        # Lấy danh sách Drive
        with console.status("[cyan]Đang lấy danh sách Drive...[/cyan]"):
            drives_url  = f"{GRAPH_BASE}/sites/{SITE_ID}/drives?$select=name,id"
            drives_data = graph_get(drives_url, headers)
            drives      = drives_data.get("value", [])

        console.print(f"[green]✔ Tìm thấy {len(drives)} drive[/green]\n")
        for d in drives:
            console.print(f"  • {d['name']}  [dim]{d['id']}[/dim]")

        # Hỏi quét tất cả hay chọn drive
        console.print()
        scan_choice = Prompt.ask(
            "Quét tất cả hay chọn drive cụ thể?",
            choices=["all"] + [str(i+1) for i in range(len(drives))],
            default="all"
        )

        if scan_choice != "all":
            drives = [drives[int(scan_choice) - 1]]

        all_drives_data = []
        grand_total     = 0

        for drive in drives:
            console.print(f"\n[bold cyan]━━━ Quét Drive: {drive['name']} ━━━[/bold cyan]")

            scan_stats["files"] = scan_stats["folders"] = scan_stats["api_calls"] = 0

            with Progress(
                SpinnerColumn(),
                TextColumn("[progress.description]{task.description}"),
                BarColumn(),
                TaskProgressColumn(),
                console=console,
                transient=True,
            ) as progress:
                task = progress.add_task("[cyan]Khởi động...[/cyan]", total=None)

                root_url  = f"{GRAPH_BASE}/drives/{drive['id']}/root?$select=id,size"
                root_info = graph_get(root_url, headers)
                root_id   = root_info["id"]

                tree = scan_folder(drive["id"], root_id, headers, progress, task, path="/")

            total_size = tree["size"]
            grand_total += total_size

            console.print(f"[green]✔ Xong:[/green] {fmt_size(total_size)}  |  "
                          f"{scan_stats['files']:,} files  |  "
                          f"{scan_stats['folders']:,} thư mục  |  "
                          f"{scan_stats['api_calls']:,} API calls")

            all_drives_data.append({
                "name":         drive["name"],
                "drive_id":     drive["id"],
                "total_size":   total_size,
                "file_count":   scan_stats["files"],
                "folder_count": scan_stats["folders"],
                "scanned_at":   datetime.now().isoformat(),
                "tree":         tree,
            })

        console.print(f"\n[bold green]✔ Tổng dung lượng tất cả: {fmt_size(grand_total)}[/bold green]")

        # Tự động lưu JSON
        with open(RESULT_FILE, "w", encoding="utf-8") as f:
            json.dump(all_drives_data, f, ensure_ascii=False, indent=2)
        console.print(f"[dim]Đã lưu cache vào {RESULT_FILE}[/dim]")

    # Menu tương tác
    interactive_menu(all_drives_data)


if __name__ == "__main__":
    main()
