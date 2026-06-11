// ==UserScript==
// @name         SharePoint Storage Analyzer via Graph API
// @namespace    http://tampermonkey.net/
// @version      2.1
// @description  Tính toán dung lượng các Drive trong Site SharePoint trực tiếp trên giao diện hoàn toàn tự động
// @match        https://developer.microsoft.com/en-us/graph/graph-explorer*
// @match        https://developer.microsoft.com/graph/graph-explorer*
// @grant        none
// @run-at       document-start
// ==/UserScript==

// CHẠY BẰNG TAMPERMONKEY

(function () {
    'use strict';

    // Cấu hình mã Site ID SharePoint của bạn
    const SITE_ID = "accor.sharepoint.com,a492f6be-ff59-436a-a787-c1b229777590,3e279574-1667-4526-aec6-9302a7b09340";

    let globalToken = null;

    // ==========================================
    // 1. HOOK FETCH ĐỂ TỰ ĐỘNG BẮT TOKEN NỀN
    // ==========================================
    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
        const url = args[0];
        const options = args[1] || {};
        let headers = options.headers;
        let auth = null;

        if (headers instanceof Headers) {
            auth = headers.get("authorization") || headers.get("Authorization");
        } else if (headers && typeof headers === "object") {
            auth = headers.authorization || headers.Authorization;
        }

        if (auth && url.includes("graph.microsoft.com")) {
            globalToken = auth.replace(/^Bearer\s+/i, '');
        }

        return originalFetch.apply(this, args);
    };

    // ==========================================
    // 2. LOGIC TÍNH TOÁN DUNG LƯỢNG SHAREPOINT
    // ==========================================
    async function startAnalyzing(logElement, resultElement) {
        // Ép hệ thống gọi thử một request nhẹ để bắt Token nếu chưa có
        if (!globalToken) {
            try {
                logElement.innerHTML = "🔑 Đang kích hoạt lấy Token từ Microsoft Graph...";
                await originalFetch("https://graph.microsoft.com/v1.0/me");
            } catch(e) {}
        }

        // Kiểm tra lại sau khi đã kích hoạt
        if (!globalToken) {
            logElement.innerHTML = "<span style='color: #ff4d4d; font-weight: bold;'>❌ Lỗi: Không lấy được Token!</span><br><span style='font-size:11px; color:#666;'>Bạn đã Đăng nhập (Sign in) vào trang Graph Explorer này chưa? Hãy đăng nhập trước nhé.</span>";
            return;
        }

        const headers = { "Authorization": `Bearer ${globalToken}` };

        try {
            logElement.innerHTML = "🔄 Đang kết nối API và lấy danh sách drives...";

            const drivesUrl = `https://graph.microsoft.com/v1.0/sites/${SITE_ID}/drives?$select=name,id`;
            const drivesResponse = await originalFetch(drivesUrl, { headers });

            if (!drivesResponse.ok) {
                throw new Error("Token hết hạn hoặc không có quyền truy cập Site ID này.");
            }

            const drivesData = await drivesResponse.json();
            console.log(drivesData)
            const drives = drivesData.value || [];
            console.log(drives)
            logElement.innerHTML = `📦 Tổng số drives tìm thấy: ${drives.length}<br>----------------------------------<br>`;

            let driveSizes = [];
            let totalBytes = 0;

            for (let i = 0; i < drives.length; i++) {
                const d = drives[i];

                // Chèn log real-time trực tiếp vào bảng trên giao diện
                logElement.innerHTML += `⏳ [${i + 1}/${drives.length}] Quét: <b>${d.name}</b>...<br>`;
                logElement.scrollTop = logElement.scrollHeight; // Tự cuộn màn hình log xuống dưới

                try {
                    const url = `https://graph.microsoft.com/v1.0/drives/${d.id}/root?$select=size`;
                    const rRes = await originalFetch(url, { headers });
                    const r = await rRes.json();
                    const used = r.size || 0;

                    if (used > 0) {
                        const gb = used / Math.pow(1024, 3);
                        driveSizes.push({ name: d.name, gb: gb });
                        totalBytes += used;
                    }
                } catch (err) {
                    console.error(err);
                }
            }

            // Sắp xếp dữ liệu từ cao đến thấp
            driveSizes.sort((a, b) => b.gb - a.gb);

            logElement.innerHTML += "<br><span style='color: #107c41; font-weight: bold;'>✔ Đã quét xong toàn bộ!</span>";
            logElement.scrollTop = logElement.scrollHeight;

            const totalGb = totalBytes / Math.pow(1024, 3);

            // Vẽ bảng kết quả trực quan
            let tableHTML = `
                <h3 style="margin-top:0; color:#0078d4; font-size:15px;">📊 KẾT QUẢ DUNG LƯỢNG (CAO → THẤP)</h3>
                <div style="max-height: 220px; overflow-y: auto; border: 1px solid #edebe9; border-radius: 4px;">
                    <table style="width:100%; border-collapse: collapse; text-align: left; font-size: 13px;">
                        <thead>
                            <tr style="background-color: #f3f2f1; position: sticky; top: 0; box-shadow: 0 1px 0 #edebe9;">
                                <th style="padding: 8px;">Tên Ổ Đĩa (Drive)</th>
                                <th style="padding: 8px; width: 100px;">Dung lượng</th>
                            </tr>
                        </thead>
                        <tbody>
            `;

            driveSizes.forEach(item => {
                tableHTML += `
                    <tr style="border-bottom: 1px solid #edebe9;">
                        <td style="padding: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 250px;" title="${item.name}">${item.name}</td>
                        <td style="padding: 8px; font-weight: bold; color: #333;">${item.gb.toFixed(2)} GB</td>
                    </tr>
                `;
            });

            tableHTML += `
                        </tbody>
                    </table>
                </div>
                <div style="margin-top: 12px; padding-top: 8px; border-top: 2px dashed #107c41; font-size: 15px; font-weight: bold; color: #107c41; text-align: right;">
                    🧮 TỔNG CỘNG: ${totalGb.toFixed(2)} GB
                </div>
            `;

            resultElement.innerHTML = tableHTML;

        } catch (error) {
            logElement.innerHTML += `<br><span style='color: #ff4d4d;'>❌ Lỗi: ${error.message}</span>`;
        }
    }

    // ==========================================
    // 3. GIAO DIỆN KHUNG ĐIỀU KHIỂN TỰ ĐỘNG
    // ==========================================
    function createCustomUI() {
        if (document.getElementById("custom-sharepoint-btn")) return;

        const allButtons = document.querySelectorAll("button");
        let runQueryBtn = null;
        for (let btn of allButtons) {
            if (btn.textContent && btn.textContent.includes("Run query")) {
                runQueryBtn = btn;
                break;
            }
        }

        if (runQueryBtn && runQueryBtn.parentNode) {
            // Nút bấm chính
            const customBtn = document.createElement("button");
            customBtn.id = "custom-sharepoint-btn";
            customBtn.innerText = "📊 Tính Dung Lượng SP";

            customBtn.style.cssText = "padding: 0 16px; margin-right: 8px; height: " + (runQueryBtn.offsetHeight ? runQueryBtn.offsetHeight + "px" : "32px") + "; background-color: #107c41; color: white; border: none; border-radius: 2px; cursor: pointer; font-weight: 600; font-size: 14px;";

            customBtn.addEventListener("click", function (e) {
                e.preventDefault();

                // Hiển thị panel ngay lập tức
                const panel = document.getElementById("sp-analyzer-panel");
                panel.style.display = "block";

                const logBox = document.getElementById("sp-analyzer-log");
                const resultBox = document.getElementById("sp-analyzer-result");

                logBox.innerHTML = "🔄 Đang chuẩn bị...";
                resultBox.innerHTML = "";

                // Chạy ngầm phân tích luôn
                startAnalyzing(logBox, resultBox);
            });

            runQueryBtn.parentNode.insertBefore(customBtn, runQueryBtn);

            // Tạo Panel hiển thị Log và Bảng kết quả (thay thế hoàn toàn việc mở console thủ công)
            const panel = document.createElement("div");
            panel.id = "sp-analyzer-panel";
            panel.style.cssText = "display:none; position:fixed; bottom:20px; right:20px; width:450px; max-height:520px; background:white; box-shadow:0 0 20px rgba(0,0,0,0.25); z-index:99999; border-radius:6px; padding:15px; font-family:'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; border: 1px solid #ccc;";

            panel.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #edebe9; padding-bottom:8px; margin-bottom:10px;">
                    <b style="color:#107c41; font-size:15px;">📊 Tiến Trình Quét SharePoint</b>
                    <span id="close-sp-panel" style="cursor:pointer; font-weight:bold; color:#999; font-size:20px; padding: 0 5px;">×</span>
                </div>
                <div id="sp-analyzer-log" style="background:#252526; color:#ddd; padding:10px; border-radius:4px; font-family:'Consolas', monospace; font-size:11px; max-height:120px; overflow-y:auto; margin-bottom:12px; white-space: pre-wrap; line-height: 1.5;"></div>
                <div id="sp-analyzer-result"></div>
            `;
            document.body.appendChild(panel);

            document.getElementById("close-sp-panel").onclick = () => {
                panel.style.display = "none";
            };
        }
    }

    const observer = new MutationObserver(() => createCustomUI());
    document.addEventListener("DOMContentLoaded", () => {
        observer.observe(document.body, { childList: true, subtree: true });
    });
})();
