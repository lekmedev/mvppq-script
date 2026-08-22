import os
import re
import random
import time
from dotenv import load_dotenv
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

# User-Agent dùng cho toàn bộ request (HCP + Pinpoint)
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0.0.0 Safari/537.36"
)

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
        self.base_url = PINPOINT_BASE_URL

        # Session requests dùng chung cho luồng đăng nhập
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": USER_AGENT})

        self.success = 0
        self.failed = 0

        # Lưu các device bị fail
        self.failed_devices = []

    def login(self):
        """
        Đăng nhập thuần requests (không cần Playwright):

        1. GET trang login HCP (Moodle) -> lấy logintoken CSRF
        2. POST username/password -> session HCP
        3. GET nttcreatetest.php -> 302 chứa vé one-time UUID
           dạng /auth/login-url/{uuid}
        4. GET /api/v2/users/sign_in?token={uuid}
           -> server trả access token trong body (result.token)
              và header X-Auth-Token
        """

        print("[*] Đăng nhập HCP...")

        r = self.session.get(
            f"{HCP_URL}/accor/login/index.php",
            timeout=30,
        )

        m = re.search(
            r'name="logintoken"\s+value="([^"]+)"',
            r.text,
        )

        logintoken = m.group(1) if m else ""

        r = self.session.post(
            f"{HCP_URL}/accor/login/index.php",
            data={
                "username": USERNAME,
                "password": PASSWORD,
                "logintoken": logintoken,
                "anchor": "",
            },
            timeout=30,
            allow_redirects=True,
        )

        if "home.php" not in str(r.url):
            print("[-] Đăng nhập HCP thất bại:", r.url)
            return

        print("[+] Đăng nhập HCP: OK")

        print("[*] Lấy vé SSO sang Pinpoint...")

        r = self.session.get(
            f"{HCP_URL}/accor/hcp/ntt/nttcreatetest.php",
            timeout=30,
            allow_redirects=False,
        )

        loc = r.headers.get("Location", "")

        uuid = None

        if "/auth/login-url/" in loc:
            uuid = loc.rstrip("/").split("/")[-1]
        elif "token=" in loc:
            uuid = loc.split("token=")[-1].split("&")[0]

        if not uuid:
            print("[-] Không lấy được vé SSO (Location:", loc[:80], ")")
            return

        print("[*] Đổi vé lấy Access Token...")

        r = self.session.get(
            f"{self.base_url}/api/v2/users/sign_in",
            params={"token": uuid},
            headers={
                "accept": "application/json",
                "x-requested-with": "XMLHttpRequest",
                "referer": f"{self.base_url}/auth/login-url/{uuid}",
            },
            timeout=30,
        )

        if not r.ok:
            print("[-] sign_in thất bại:", r.status_code)
            return

        try:
            self.token = r.json()["result"]["token"]
        except Exception:
            # Fallback: token nằm ở response header
            self.token = r.headers.get("X-Auth-Token")

        if self.token:
            print("[+] Access Token: OK")
        else:
            print("[-] Không lấy được Access Token")

    def quick_audit(self, device_id):

        headers = {
            "accept": "application/json",
            "content-type": "application/json",
            "locale": "en",
            "user-agent": USER_AGENT,
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

    #start_delay = random.randint(300, 1500)
    start_delay = random.randint(0,1)

    print(
        f"[*] Script sẽ chạy sau "
        f"{start_delay} giây..."
    )

    time.sleep(start_delay)

    client = PinpointClient()

    client.run()
