import os
import re
import random
from datetime import datetime, timedelta
from collections import defaultdict
import win32file
import win32con
import pywintypes


# ==========================================
# CẤU HÌNH ĐƯỜNG DẪN
# ==========================================
#ROOT_PATH = r"C:\Users\HNGUYENTRONG\Desktop\Thường Dùng\INVENTORY 2026 IMAGE"
ROOT_PATH = r""

GREEN  = "\033[92m"
RED    = "\033[91m"
YELLOW = "\033[93m"
RESET  = "\033[0m"


def to_win32_time(dt: datetime):
    return pywintypes.Time(dt)


def change_file_times_native(file_path: str, create_date: datetime, modify_date: datetime) -> bool:
    handle = None
    try:
        handle = win32file.CreateFile(
            file_path,
            win32con.GENERIC_WRITE,
            win32con.FILE_SHARE_READ | win32con.FILE_SHARE_WRITE | win32con.FILE_SHARE_DELETE,
            None,
            win32con.OPEN_EXISTING,
            win32con.FILE_ATTRIBUTE_NORMAL,
            None,
        )
        win32file.SetFileTime(
            handle,
            to_win32_time(create_date),
            to_win32_time(modify_date),
            to_win32_time(modify_date),
        )
        return True
    except Exception as e:
        print(f"{RED}Lỗi: {os.path.basename(file_path)} | {e}{RESET}")
        return False
    finally:
        if handle:
            handle.close()


def get_month_by_walking_up(file_path: str):
    """Walk up from the file to find the nearest 'Tháng X' parent folder."""
    current_dir = os.path.dirname(file_path)
    while current_dir and current_dir != os.path.dirname(current_dir):
        folder_name = os.path.basename(current_dir)
        m = re.search(r"[Tt]háng\s*(\d+)", folder_name)
        if m:
            return int(m.group(1))
        current_dir = os.path.dirname(current_dir)
    return None


def get_group_key(file_path: str) -> str:
    """
    Group key = (parent folder, base name without numeric suffix).
    FIX: Including the parent folder prevents files with the same name
    from different 'Tháng' folders being merged into one group,
    which caused the wrong (or missing) month to be used for the whole group.
    """
    parent_dir = os.path.dirname(file_path)
    base_name  = os.path.splitext(os.path.basename(file_path))[0]
    match      = re.match(r"^(.+?)\s*\.\d+$", base_name)
    stem       = match.group(1).strip() if match else base_name.strip()
    return (parent_dir, stem)   # tuple key — unique per folder


def main():
    if not os.path.exists(ROOT_PATH):
        print(f"{RED}Đường dẫn ROOT_PATH không tồn tại!{RESET}")
        return

    # 1. Scan & group files — each group stays within its own folder
    grouped_files: defaultdict[tuple, list[str]] = defaultdict(list)
    for root, _, files in os.walk(ROOT_PATH):
        for file in files:
            if file.lower().endswith((".jpg", ".jpeg")):
                file_path = os.path.join(root, file)
                grouped_files[get_group_key(file_path)].append(file_path)

    print(f"{YELLOW}Đang xử lý thuộc tính thời gian trên File System...{RESET}\n")

    # 2. Apply timestamps per group
    for (parent_dir, stem), files in grouped_files.items():
        # Every file in the group shares the same parent_dir, so any one of
        # them correctly resolves the month — no more cross-folder mixing.
        month = get_month_by_walking_up(files[0])

        if month is None:
            print(f"{YELLOW}Bỏ qua (không tìm thấy thư mục Tháng): "
                  f"{os.path.relpath(files[0], ROOT_PATH)}{RESET}")
            continue

        target_month = (month % 12) + 1
        year         = 2026 + (month // 12)

        base_date = datetime(
            year, target_month,
            random.randint(1, 10),
            random.randint(0, 23),
            random.randint(0, 59),
            random.randint(0, 59),
        )

        for file_path in files:
            create_date = base_date + timedelta(seconds=random.randint(0, 600))
            modify_date = create_date + timedelta(seconds=random.randint(0, 86400))

            if change_file_times_native(file_path, create_date, modify_date):
                print(
                    f"{GREEN}Tháng {month} → Tháng {target_month} "
                    f"| {os.path.basename(file_path)} "
                    f"| Created: {create_date.strftime('%Y-%m-%d %H:%M:%S')} "
                    f"| Modified: {modify_date.strftime('%Y-%m-%d %H:%M:%S')}{RESET}"
                )

    print(f"\n{GREEN}=== HOÀN THÀNH ĐỔI TIME FILE SYSTEM ==={RESET}")


if __name__ == "__main__":
    main()
