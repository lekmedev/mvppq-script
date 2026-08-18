import os
import random
import time
from dotenv import load_dotenv
from playwright.sync_api import sync_playwright
import requests

# Load các biến từ file .env
load_dotenv()

HCP_URL = os.getenv("HCP_URL", "https://hcp.vigitrust.com")
USERNAME = os.getenv("HCP_USERNAME")
PASSWORD = os.getenv("HCP_PASSWORD")

PINPOINT_BASE_URL = os.getenv(
    "PINPOINT_BASE_URL",
    "https://pinpoint.zerorisk.io"
)

DISCORD_WEBHOOK = os.getenv("DISCORD_WEBHOOK")

# URL để mở trực tiếp device trên Pinpoint
# Ví dụ:
# DEVICE_URL_TEMPLATE=https://pinpoint.zerorisk.io/devices/{id}
DEVICE_URL_TEMPLATE = os.getenv(
    "DEVICE_URL_TEMPLATE",
    f"{PINPOINT_BASE_URL}/devices/{{id}}"
)

# Chuyển chuỗi DEVICE_IDS từ .env thành danh sách int
raw_device_ids = os.getenv("DEVICE_IDS", "")
DEVICE_IDS = [
    int(x.strip())
    for x in raw_device_ids.split(",")
    if x.strip()
]


def device_url(device_id):
    """
    Tạo URL clickable tới device.
    """
    return DEVICE_URL_TEMPLATE.format(id=device_id)


def discord(msg):
    if not DISCORD_WEBHOOK:
        return

    try:
        requests.post(
            DISCORD_WEBHOOK,
            json={"content": msg},
            timeout=10
        )
    except Exception as e:
        print("Discord notification error:", e)


def discord_summary(total, success, failed, runtime, failed_devices):
    if not DISCORD_WEBHOOK:
        return

    # Có device failed
    if failed > 0:
        color = 0xE74C3C

        failed_list = []

        for device_id in failed_devices:
            url = device_url(device_id)

            # Discord Markdown clickable link
            failed_list.append(
                f"❌ [{device_id}]({url})"
            )

        failed_text = "\n".join(failed_list)

        embed = {
            "title": "🚨 Pinpoint Batch Quick Audit - FAILED",
            "color": color,
            "fields": [
                {
                    "name": "Tổng thiết bị",
                    "value": str(total),
                    "inline": True
                },
                {
                    "name": "Thành công",
                    "value": str(success),
                    "inline": True
                },
                {
                    "name": "Thất bại",
                    "value": str(failed),
                    "inline": True
                },
                {
                    "name": "⚠️ Device bị lỗi",
                    "value": failed_text[:1024],
                    "inline": False
                },
                {
                    "name": "Thời gian",
                    "value": runtime,
                    "inline": False
                },
            ],
            "footer": {
                "text": "Python Batch Audit"
            }
        }

    # Tất cả thành công
    else:
        embed = {
            "title": "✅ Pinpoint Batch Quick Audit",
            "color": 0x2ECC71,
            "fields": [
                {
                    "name": "Tổng thiết bị",
                    "value": str(total),
                    "inline": True
                },
                {
                    "name": "Thành công",
                    "value": str(success),
                    "inline": True
                },
                {
                    "name": "Thất bại",
                    "value": str(failed),
                    "inline": True
                },
                {
                    "name": "Thời gian",
                    "value": runtime,
                    "inline": False
                },
            ],
            "footer": {
                "text": "Python Batch Audit"
            }
        }

    try:
        requests.post(
            DISCORD_WEBHOOK,
            json={"embeds": [embed]},
            timeout=10
        )
    except Exception as e:
        print("Discord Summary error:", e)


class PinpointClient:

    def __init__(self):
        self.token = None
        self.cookies = None
        self.user_agent = None
        self.base_url = PINPOINT_BASE_URL

        self.success = 0
        self.failed = 0

        # Lưu các device bị fail
        self.failed_devices = []

    def login(self):

        with sync_playwright() as p:

            browser = p.chromium.launch(headless=True)

            context = browser.new_context()
            page = context.new_page()

            print("[*] Đăng nhập HCP...")

            page.goto(HCP_URL)

            page.fill(
                'input[name="username"]',
                USERNAME
            )

            page.fill(
                'input[name="password"]',
                PASSWORD
            )

            page.click(
                'button[type="submit"]'
            )

            page.wait_for_load_state("networkidle")

            print("[*] Mở Pinpoint...")

            with page.expect_popup() as popup:
                page.click(
                    "text=Click here to access the terminal inventory"
                )

            pinpoint = popup.value

            pinpoint.wait_for_load_state("networkidle")

            print("[+] URL:", pinpoint.url)

            self.token = pinpoint.evaluate("""
                () => {
                    const s = localStorage.getItem("storage:auth-session");

                    if (!s) {
                        return null;
                    }

                    return JSON.parse(s).token;
                }
            """)

            if self.token:
                print("[+] Access Token: OK")
            else:
                print("[-] Không lấy được Access Token")

            self.user_agent = page.evaluate(
                "navigator.userAgent"
            )

            cookies = context.cookies()

            self.cookies = {
                c["name"]: c["value"]
                for c in cookies
                if "zerorisk.io" in c["domain"]
            }

            browser.close()

    def quick_audit(self, device_id):

        headers = {
            "accept": "application/json",
            "content-type": "application/json",
            "locale": "en",
            "user-agent": self.user_agent,
            "x-requested-with": "XMLHttpRequest",
            "x-auth-token": self.token,
        }

        body = {
            "quickAudit": {
                "device": str(device_id),
                "isSecure": True
            }
        }

        try:

            r = requests.post(
                f"{self.base_url}/api/v1/pinpoint/quickaudit",
                headers=headers,
                cookies=self.cookies,
                json=body,
                timeout=60,
            )

            print(
                f"Device {device_id} -> "
                f"Status Code: {r.status_code}"
            )

            if r.ok:
                return True

            print(
                f"Lỗi API Device {device_id}: "
                f"{r.text}"
            )

            return False

        except Exception as e:

            print(
                f"Lỗi kết nối thiết bị "
                f"{device_id}: {e}"
            )

            return False

    def run(self):

        self.login()

        if not self.token:

            print(
                "[-] Đăng nhập thất bại "
                "hoặc không lấy được Token. "
                "Dừng script."
            )

            discord(
                "🚨 **Pinpoint Audit FAILED**\n"
                "Không thể đăng nhập hoặc không lấy được Access Token."
            )

            return

        print(
            f"\n[*] Bắt đầu Audit "
            f"{len(DEVICE_IDS)} thiết bị..."
        )

        start_time = time.time()

        for device in DEVICE_IDS:

            delay = random.randint(10, 100)

            print(
                f"[*] Chờ {delay} giây trước khi "
                f"audit thiết bị {device}..."
            )

            time.sleep(delay)

            ok = self.quick_audit(device)

            if ok:

                self.success += 1

            else:

                self.failed += 1

                # Lưu device bị fail
                self.failed_devices.append(device)

            time.sleep(0.5)

        elapsed_time = time.time() - start_time

        runtime_str = (
            f"{int(elapsed_time // 60)} phút "
            f"{int(elapsed_time % 60)} giây"
            if elapsed_time > 60
            else f"{elapsed_time:.2f} giây"
        )

        print(
            "\nHoàn thành. "
            "Đang gửi báo cáo lên Discord..."
        )

        discord_summary(
            total=len(DEVICE_IDS),
            success=self.success,
            failed=self.failed,
            runtime=runtime_str,
            failed_devices=self.failed_devices,
        )


if __name__ == "__main__":

    start_delay = random.randint(300, 1500)

    print(
        f"[*] Script sẽ chạy sau "
        f"{start_delay} giây..."
    )

    time.sleep(start_delay)

    client = PinpointClient()

    client.run()
