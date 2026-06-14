// ==UserScript==
// @name         Graph Explorer Toolkit (Modular - Fluent Storage with Advanced Link & Clean UI)
// @namespace    http://tampermonkey.net/
// @version      5.1
// @description  Bộ công cụ mở rộng cho Microsoft Graph Explorer - Hỗ trợ thay đổi kích thước Panel, nút bấm Fluent UI đồng bộ, tối ưu luồng hủy cài đặt.
// @match        https://developer.microsoft.com/en-us/graph/graph-explorer*
// @match        https://developer.microsoft.com/graph/graph-explorer*
// @grant        none
// @run-at       document-start
// @require      https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js
// ==/UserScript==

(function () {
    'use strict';

    // =====================================================================
    // 0. CẤU HÌNH CHUNG
    // =====================================================================
    const DEFAULT_SITE_URL = "https://accor.sharepoint.com/sites/HB4V5_SPOF";

    // =====================================================================
    // 1. TOKEN MANAGER
    // =====================================================================
    const TokenManager = (() => {
        let token = null;
        const originalFetch = window.fetch.bind(window);

        window.fetch = async function (...args) {
            const [url, options = {}] = args;
            const headers = options.headers;
            let auth = null;

            if (headers instanceof Headers) {
                auth = headers.get("authorization") || headers.get("Authorization");
            } else if (headers && typeof headers === "object") {
                auth = headers.authorization || headers.Authorization;
            }

            if (auth && typeof url === "string" && url.includes("graph.microsoft.com")) {
                token = auth.replace(/^Bearer\s+/i, "");
            }

            return originalFetch.apply(this, args);
        };

        return {
            originalFetch,
            getToken: () => token,
            hasToken: () => !!token,
            async ensureToken() {
                if (!token) {
                    try { await originalFetch("https://graph.microsoft.com/v1.0/me"); } catch (e) { /* ignore */ }
                }
                return token;
            }
        };
    })();

    // =====================================================================
    // 2. CONFIG STORE
    // =====================================================================
    const ConfigStore = {
        get(key, defaultValue) {
            const value = localStorage.getItem(key);
            return value === null || value === "" ? defaultValue : value;
        },
        set(key, value) {
            localStorage.setItem(key, value);
        }
    };

    // =====================================================================
    // 3. UTILS
    // =====================================================================
    const Utils = {
        formatDateTime() {
            const now = new Date();
            const pad = (num) => String(num).padStart(2, "0");
            return `${pad(now.getHours())}:${pad(now.getMinutes())} ${pad(now.getDate())}/${pad(now.getMonth() + 1)}`;
        },
        bytesToGB(bytes) {
            return bytes / Math.pow(1024, 3);
        },
        isSystemItem(name) {
            return /^_\$.*\$_$/.test(name) || /^_\$.*/.test(name);
        },
        formatBytes(bytes) {
            const value = Number(bytes) || 0;
            if (value <= 0) return "0 B";
            const units = ["B", "KB", "MB", "GB", "TB"];
            let i = 0;
            let v = value;
            while (v >= 1024 && i < units.length - 1) {
                v /= 1024;
                i++;
            }
            return `${v.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
        },
        escapeHtml(str) {
            return String(str)
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;");
        },
        formatIsoToVN(isoString) {
            if (!isoString) return "";
            try {
                const date = new Date(isoString);
                const pad = (n) => String(n).padStart(2, '0');
                return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
            } catch (e) {
                return isoString;
            }
        }
    };

    // =====================================================================
    // 4. GRAPH API
    // =====================================================================
    const GraphAPI = {
        async request(url) {
            const token = TokenManager.getToken();
            const headers = { Authorization: `Bearer ${token}` };
            return TokenManager.originalFetch(url, { headers });
        },

        async resolveSiteId(siteUrl) {
            const url = new URL(siteUrl);
            const hostname = url.hostname;
            const path = url.pathname.replace(/\/$/, "");
            const graphUrl = `https://graph.microsoft.com/v1.0/sites/${hostname}:${path}`;

            const res = await this.request(graphUrl);
            if (!res.ok) throw new Error("Không tìm thấy Site-ID.");
            return await res.json();
        },

        async getDrives(siteId) {
            const url = `https://graph.microsoft.com/v1.0/sites/${siteId}/drives?$select=name,id,webUrl`;
            const res = await this.request(url);
            if (!res.ok) throw new Error("Token hết hạn hoặc tài khoản không có quyền trên Site.");
            const data = await res.json();
            return (data.value || []).filter(d => !/^_\$.*/.test(d.name));
        },

        async getDriveUsedSize(driveId) {
            let used = 0;
            let url = `https://graph.microsoft.com/v1.0/drives/${driveId}/root/children?$select=name,size,folder&$top=200`;

            while (url) {
                const res = await this.request(url);
                if (!res.ok) break;
                const data = await res.json();
                const items = data.value || [];
                for (const item of items) {
                    if (Utils.isSystemItem(item.name)) continue;
                    used += item.size || 0;
                }
                url = data["@odata.nextLink"] || null;
            }
            return used;
        },

        async getFolderChildren(driveId, itemId) {
            let results = [];
            let url = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/children?$select=id,name,size,folder,file,webUrl&$top=200`;

            while (url) {
                const res = await this.request(url);
                if (!res.ok) throw new Error("Không thể tải dữ liệu thư mục.");
                const data = await res.json();
                results = results.concat(data.value || []);
                url = data["@odata.nextLink"] || null;
            }
            return results;
        }
    };

    // =====================================================================
    // 5. STYLE MANAGER
    // =====================================================================
    const StyleManager = {
        BASE_CSS: `
/* Trạng thái mặc định (Mũi tên hướng sang phải ▶) */
.sp-tree-toggle {
    cursor: pointer !important;
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    text-align: center;
    font-size: 11px;
    color: #6c757d;
    display: inline-flex;
    align-items: center;
    justify-content: center;

    /* Hiệu ứng chuyển động mượt mà thực tế */
    transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1), color 0.2s ease;
    transform-origin: center center;
    transform: rotate(0deg); /* Neo góc mặc định */
    padding: 0;
}

.sp-tree-toggle:hover {
    background: #eef2f7;
    border-radius: 4px;
    color: #0f6cbd;
}

/* Khi thư mục mở (Mũi tên hướng xuống dưới ▼) */
.sp-tree-toggle.sp-tree-toggle-expanded {
    color: #0f6cbd;
    transform: rotate(90deg); /* Trình duyệt sẽ bám vào đây để tạo hiệu ứng transition quay mượt */
}
            #gx-toolbar-anchor { display: inline-flex; }
            .gx-panel { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background:#f9fbfd; }
            .gx-panel * { box-sizing: border-box; }
.disabledbtn {
  opacity: 0.6;
  cursor: not-allowed;
}
            .gx-panel { display:none; position:fixed; bottom:20px; right:20px; width:650px; height:580px;
                background:#fff; z-index:99999; border-radius:8px; border:1px solid #eaeaea;
                box-shadow: 0 10px 25px rgba(0,0,0,0.15); flex-direction: column;
                min-width: 400px; min-height: 350px; max-width: 95vw; max-height: 92vh; }

            .gx-panel-header { display:flex; justify-content:space-between; align-items:center; padding:10px 16px;
                background-color:#0f6cbd; color:#fff; flex-shrink: 0; user-select: none; }
            .gx-panel-title { display:flex; align-items:center; gap:10px; font-size:14px; font-weight:600; }
            .gx-panel-actions { display:flex; align-items:center; gap:4px; }
            .gx-panel-btn-min { cursor:pointer; font-size:16px; opacity:0.8; width:28px; height:28px;
                display:flex; align-items:center; justify-content:center; border-radius:4px; transition: all 0.2s; }
            .gx-panel-btn-min:hover { opacity:1; background: rgba(255,255,255,0.2); }

            .gx-panel-body { padding:20px; flex-grow: 1; overflow-y: auto; position: relative; }

            .gx-minibar { position:fixed; bottom:20px; right:20px; height:40px; background:#0f6cbd; color:#fff;
                display:flex; align-items:center; gap:12px; padding:0 14px; border-radius:20px; z-index:99999;
                cursor:pointer; font-size:13px; font-weight:600; }
            .gx-mini-dot { width:8px; height:8px; background:#52c41a; border-radius:50%; box-shadow: 0 0 8px #52c41a; }
            .gx-mini-status { font-weight:400; opacity:0.9; max-width:150px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

            /* CSS ĐỒNG BỘ NỀN NÚT SPLIT BUTTON & BÁNH RĂNG THEO STYLE GỐC */
            .gx-split-btn-container { position: relative; display: inline-flex; vertical-align: middle; margin-left: 8px; }
            .gx-btn-main { border-top-right-radius: 0 !important; border-bottom-right-radius: 0 !important; border-right: none !important; background-color: var(--control-accent-color, #0f6cbd) !important; color: #fff !important; }
            .gx-btn-main:hover { background-color: var(--control-accent-color-hover, #106ebe) !important; }

            .gx-btn-dropdown-toggle { padding-left: 10px !important; padding-right: 10px !important; border-top-left-radius: 0 !important; border-bottom-left-radius: 0 !important; position: relative; display: flex; align-items: center; justify-content: center; background-color: var(--control-accent-color, #0f6cbd) !important; color: #fff !important; }
            .gx-btn-dropdown-toggle:hover { background-color: var(--control-accent-color-hover, #106ebe) !important; }
            .gx-btn-dropdown-toggle::before { content: ""; position: absolute; left: 0; top: 25%; height: 50%; width: 1px; background: rgba(255,255,255,0.3); }

            .gx-toolbar-btn { display:inline-flex; align-items:center; gap:6px; font-weight:600; color: #fff; }
            .gx-toolbar-setting { font-size:15px; cursor:pointer; margin-left:4px; display:inline-flex; align-items:center; justify-content:center; background-color: var(--control-accent-color, #0f6cbd) !important; color:#fff !important; border-radius: 4px !important; width: 32px; height: 32px; padding: 0 !important; }
            .gx-toolbar-setting:hover { background-color: var(--control-accent-color-hover, #106ebe) !important; }

            .gx-dropdown-menu { position: absolute; top: 100%; right: 0; z-index: 1000; display: none; min-width: 170px; padding: 4px 0; margin: 2px 0 0; font-size: 13px; text-align: left; list-style: none; background-color: #fff; background-clip: padding-box; border: 1px solid rgba(0,0,0,.15); border-radius: 4px; box-shadow: 0 6px 12px rgba(0,0,0,.175); }
            .gx-dropdown-menu.show { display: block; }
            .gx-dropdown-item { display: block; width: 100%; padding: 8px 14px; clear: both; font-weight: 400; color: #333; text-align: inherit; white-space: nowrap; background: none; border: none; cursor: pointer; }
            .gx-dropdown-item:hover { background-color: #f5f5f5; color: #0f6cbd; }

            .gx-loading { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:16px; padding:40px 0; color:#555; font-size:14px; }
            .gx-spinner { width:32px; height:32px; border:3px solid #e3f3eb; border-top-color:#0f6cbd; border-radius:50%; animation: gx-spin 0.8s linear infinite; }
            @keyframes gx-spin { to { transform: rotate(360deg); } }
            .gx-error { display:flex; gap:12px; align-items:flex-start; padding:16px; background:#fdf3f3; border:1px solid #fbd6d6; border-radius:8px; }
            .gx-error-title { font-weight:600; color:#c0392b; font-size:14px; }
            .gx-error-desc { font-size:12px; color:#6c757d; }

            .gx-progress-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.4); z-index: 100000; display: flex; align-items: center; justify-content: center; }
            .gx-progress-box { background: #fff; padding: 24px; border-radius: 8px; width: 420px; box-shadow: 0 4px 12px rgba(0,0,0,0.2); text-align: center; }
            .gx-progress-title { font-weight: 600; font-size: 15px; margin-bottom: 12px; color: #2b303a; white-space: pre-line; }
            .gx-progress-bar-bg { background: #eef2f7; height: 10px; border-radius: 5px; overflow: hidden; margin-bottom: 16px; }
            .gx-progress-bar-fill { height: 100%; background: #0f6cbd; width: 0%; transition: width 0.1s ease; }
            .gx-progress-btn-cancel { background: #fdf3f3; color: #c0392b; border: 1px solid #fbd6d6; padding: 6px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 600; }
            .gx-progress-btn-cancel:hover { background: #fbd6d6; }

            .gx-resizable-handle { position: absolute; background: transparent; z-index: 10000; }
            .gx-handle-top { top: -3px; left: 0; width: 100%; height: 6px; cursor: n-resize; }
            .gx-handle-left { top: 0; left: -3px; width: 6px; height: 100%; cursor: w-resize; }
            .gx-handle-topleft { top: -4px; left: -4px; width: 8px; height: 8px; cursor: nw-resize; }

            /* CSS ĐỊNH DẠNG CÂY THƯ MỤC VÀ TỆP TIN */
            .sp-tree-row-wrapper-link { display: inline-flex; align-items: center; gap: 6px; text-decoration: none; color: inherit; max-width: calc(100% - 180px); }
            .sp-tree-row-wrapper-link:hover .sp-tree-name { color: #0f6cbd; text-decoration: underline; }

            .sp-tree-folder-arrow-link { text-decoration: none; color: #0f6cbd; font-size: 11px; margin-left: 6px; display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 4px; opacity: 0.3; transition: all 0.15s; }
            .sp-tree-row:hover .sp-tree-folder-arrow-link { opacity: 1; background: #e0ebf7; }
            .sp-tree-folder-arrow-link:hover { color: #0058ff; transform: scale(1.1); }

            .sp-tree-toggle { cursor: pointer !important; width:16px; flex-shrink:0; text-align:center; font-size:11px; color:#6c757d; display:inline-flex; align-items:center; justify-content:center; transition: transform 0.15s ease; padding: 4px 0; }
            .sp-tree-toggle:hover { background: #eef2f7; border-radius: 4px; color: #0f6cbd; }
        `,

        inject(features) {
            if (document.getElementById("gx-toolkit-styles")) return;
            const extraCss = features.map(f => (typeof f.styles === "string" ? f.styles : "")).join("\n");
            const style = document.createElement("style");
            style.id = "gx-toolkit-styles";
            style.textContent = this.BASE_CSS + "\n" + extraCss;
            document.head.appendChild(style);
        }
    };

    // =====================================================================
    // 6. PANEL HOST
    // =====================================================================
    class PanelHost {
        constructor(feature) {
            this.feature = feature;
            this.panelEl = null;
            this.minibarEl = null;
            this.toolbarContainer = null;
        }

        mount(anchorBtn) {
            this._createToolbarSplitButton(anchorBtn);
            this._createPanel();
            this._injectResizeHandles();
            this._createMinibar();
            this._bindCommonEvents();
            this._initResizeLogic();

            if (typeof this.feature.bindEvents === "function") {
                this.feature.bindEvents(this.panelEl, this.minibarEl, this);
            }
        }

        _createToolbarSplitButton(anchorBtn) {
            const container = document.createElement("div");
            container.className = "gx-split-btn-container";

            const mainBtn = document.createElement("button");
            mainBtn.className = anchorBtn.className;
            mainBtn.classList.add("gx-btn-main");
            mainBtn.style.margin = "0";
            mainBtn.innerHTML = `
                <span class="gx-toolbar-btn" style="margin:0;">
                    ${this.feature.icon || ""}
                    <span>${this.feature.buttonLabel}</span>
                </span>
            `;

            const toggleBtn = document.createElement("button");
            toggleBtn.className = anchorBtn.className;
            toggleBtn.classList.add("gx-btn-dropdown-toggle");
            toggleBtn.style.margin = "0";
            toggleBtn.innerHTML = "▼";

            // SỬA ĐỔI: Chỉ giữ lại tính năng "Quét kèm Thùng rác" trong menu thả xuống
            const menu = document.createElement("div");
            menu.className = "gx-dropdown-menu";
            menu.innerHTML = `
                <button class="gx-dropdown-item" data-action="scan-recycle">🗑️ Quét kèm Thùng rác</button>
            `;

            container.appendChild(mainBtn);
            container.appendChild(toggleBtn);
            container.appendChild(menu);

            if (this.feature.hasSettings) {
                const settingsBtn = document.createElement("button");
                settingsBtn.className = anchorBtn.className;
                settingsBtn.classList.add("gx-toolbar-setting");
                settingsBtn.innerHTML = "⚙";
                settingsBtn.title = "Cấu hình liên kết Site";
                anchorBtn.insertAdjacentElement("afterend", settingsBtn);
                this.settingsBtn = settingsBtn;
            }

            anchorBtn.insertAdjacentElement("afterend", container);
            this.toolbarContainer = container;
            this.mainBtn = mainBtn;
            this.toggleBtn = toggleBtn;
            this.dropdownMenu = menu;
        }

        _createPanel() {
            const panel = document.createElement("div");
            panel.id = `gx-panel-${this.feature.id}`;
            panel.className = "gx-panel";
            panel.innerHTML = `
                <div class="gx-panel-header">
                    <div class="gx-panel-title">${this.feature.title}</div>
                    <div class="gx-panel-actions">
                        <span class="gx-panel-btn-min" data-action="minimize" title="Thu nhỏ">—</span>
                    </div>
                </div>
                <div class="gx-panel-body">
                    ${this.feature.renderBody()}
                </div>
            `;
            document.body.appendChild(panel);
            this.panelEl = panel;
        }

        _injectResizeHandles() {
            const hTop = document.createElement("div");
            hTop.className = "gx-resizable-handle gx-handle-top";
            const hLeft = document.createElement("div");
            hLeft.className = "gx-resizable-handle gx-handle-left";
            const hTopLeft = document.createElement("div");
            hTopLeft.className = "gx-resizable-handle gx-handle-topleft";

            this.panelEl.appendChild(hTop);
            this.panelEl.appendChild(hLeft);
            this.panelEl.appendChild(hTopLeft);
        }

        _createMinibar() {
            const minibar = document.createElement("div");
            minibar.id = `gx-minibar-${this.feature.id}`;
            minibar.className = "gx-minibar";
            minibar.style.display = "none";
            minibar.innerHTML = `
                <div class="gx-mini-dot"></div>
                <span>${this.feature.shortTitle || this.feature.title}:</span>
                <span class="gx-mini-status">${this.feature.currentStatus || ""}</span>
            `;
            document.body.appendChild(minibar);
            this.minibarEl = minibar;
        }

        _bindCommonEvents() {
            // Nút chính mặc định chạy quét tiêu chuẩn
            this.mainBtn.addEventListener("click", (e) => {
                e.preventDefault();
                this.show();
                if (typeof this.feature.onShow === "function") {
                    this.feature.onShow(this.panelEl, this.minibarEl, this, false);
                }
            });

            this.toggleBtn.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.dropdownMenu.classList.toggle("show");
            });

            this.dropdownMenu.addEventListener("click", (e) => {
                const actionBtn = e.target.closest(".gx-dropdown-item");
                if (!actionBtn) return;

                const action = actionBtn.dataset.action;
                this.dropdownMenu.classList.remove("show");
                this.show();

                if (action === "scan-recycle" && typeof this.feature.onShow === "function") {
                    this.feature.onShow(this.panelEl, this.minibarEl, this, true);
                }
            });

            document.addEventListener("click", () => {
                this.dropdownMenu.classList.remove("show");
            });

            this.panelEl.querySelector('[data-action="minimize"]').onclick = () => this.minimize();
            this.minibarEl.onclick = () => this.show();

            if (this.settingsBtn) {
                this.settingsBtn.addEventListener("click", (e) => {
                    e.preventDefault();
                    if (typeof this.feature.onSettings === "function") {
                        this.feature.onSettings(this.panelEl, this.minibarEl, this);
                    }
                });
            }
        }

        _initResizeLogic() {
            const panel = this.panelEl;
            let isResizing = false;
            let currentHandle = null;
            let startWidth, startHeight, startX, startY;

            panel.addEventListener("mousedown", (e) => {
                const handle = e.target.closest(".gx-resizable-handle");
                if (!handle) return;

                isResizing = true;
                currentHandle = handle;
                startWidth = panel.offsetWidth;
                startHeight = panel.offsetHeight;
                startX = e.clientX;
                startY = e.clientY;

                document.body.style.userSelect = "none";
                e.preventDefault();
            });

            document.addEventListener("mousemove", (e) => {
                if (!isResizing) return;
                const dx = e.clientX - startX;
                const dy = e.clientY - startY;

                if (currentHandle.classList.contains("gx-handle-left") || currentHandle.classList.contains("gx-handle-topleft")) {
                    panel.style.width = `${startWidth - dx}px`;
                }
                if (currentHandle.classList.contains("gx-handle-top") || currentHandle.classList.contains("gx-handle-topleft")) {
                    panel.style.height = `${startHeight - dy}px`;
                }
            });

            document.addEventListener("mouseup", () => {
                if (isResizing) {
                    isResizing = false;
                    currentHandle = null;
                    document.body.style.userSelect = "";
                }
            });
        }

        show() {
            this.panelEl.style.display = "flex";
            this.minibarEl.style.display = "none";
        }

        minimize() {
            this.panelEl.style.display = "none";
            this.minibarEl.style.display = "flex";
        }

        updateMiniStatus(text) {
            const el = this.minibarEl.querySelector(".gx-mini-status");
            if (el) el.textContent = text;
        }
    }

    // =====================================================================
    // 7. FEATURE: SharePoint Storage Analyzer
    // =====================================================================
    class StorageAnalyzerFeature {
        constructor() {
            this.id = "sp-storage-analyzer";
            this.title = "📊 Dung Lượng SharePoint";
            this.shortTitle = "Dung lượng SP";
            this.buttonLabel = "Tính Dung Lượng SP";
            this.icon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.21 15.89A10 10 0 1 1 8 2.83"></path><path d="M22 12A10 10 0 0 0 12 2v10z"></path></svg>`;
            this.hasSettings = true;

            this.lastDriveSizes = [];
            this.lastTotalGb = 0;
            this.scanTimestamp = "";
            this.currentStatus = "Chờ quét...";

            this.currentView = "list";
            this.activeDriveId = null;
            this.activeDriveName = "";
            this.driveTrees = {};

            this.recycleBinItems = null;
            this.recycleBinTotalBytes = 0;
            this.siteFullId = null;
            this.isRecycleBinScanned = false;
        }

        get styles() {
            return `
                .sp-view { display: flex; flex-direction: column; height: 100%; width: 100%; }
                .sp-list-container { flex-grow: 1; overflow-y:auto; display:flex; flex-direction:column; gap:8px; padding-right: 4px; }
                .sp-list-container::-webkit-scrollbar { width:5px; }
                .sp-list-container::-webkit-scrollbar-thumb { background:#ddd; border-radius:10px; }

                .sp-card-row { display:flex; align-items:center; justify-content:space-between; padding:11px 14px; background:#fff; border:1px solid #eaeaea; border-radius:8px; }
                .sp-card-row.sp-row-trash { background: #fffaf0; border: 1px dashed #ffa940; }
                .sp-card-info { display:flex; align-items:center; gap:10px; min-width:0; max-width: calc(100% - 140px); }
                .sp-drive-icon { flex-shrink:0; }
                .sp-drive-name { font-size:13px; font-weight:500; color:#2b303a; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; text-decoration:none; }

                .sp-drive-link-anchor { text-decoration: none; display: inline-flex; align-items: center; gap: 8px; color: inherit; min-width: 0; width: 100%; }
                .sp-drive-link-anchor:hover .sp-drive-name { color: #0f6cbd; text-decoration: underline; }

                .sp-badge-size { font-size:13px; font-weight:600; color:#0f6cbd; background:#e6f4ea; padding:4px 10px; border-radius:6px; }
                .sp-card-row.sp-row-trash .sp-badge-size { color: #d46b08; background: #ffe7ba; }

                .sp-footer { display:none; align-items:center; justify-content:space-between; margin-top:16px; padding-top:12px; border-top:1px solid #eee; flex-shrink: 0; }
                .sp-total-label { font-size:13px; color:#6c757d; }
                .sp-total-value { font-size:18px; font-weight:700; color:#0f6cbd; }

                .sp-footer-actions { display: inline-flex; position: relative; }
                .sp-copy-btn { display:inline-flex; align-items:center; gap:8px; padding:10px 18px; background:#0f6cbd; color:#fff; border:none; border-top-left-radius:8px; border-bottom-left-radius:8px; font-size:13px; font-weight:600; cursor:pointer; border-right: 1px solid rgba(255,255,255,0.2); }
                .sp-copy-btn.sp-copy-success { background:#1e9e54; }
                .sp-copy-dropdown-toggle { background:#0f6cbd; color:#fff; border:none; padding:0 10px; border-top-right-radius:8px; border-bottom-right-radius:8px; cursor:pointer; font-size:11px; display:flex; align-items:center; justify-content:center; }
                .sp-copy-dropdown-menu { position: absolute; bottom: 100%; right: 0; background: #fff; border: 1px solid #eaeaea; border-radius: 6px; box-shadow: 0 -4px 12px rgba(0,0,0,0.1); min-width: 190px; padding: 4px 0; display: none; z-index: 1001; margin-bottom: 4px; }
                .sp-copy-dropdown-menu.show { display: block; }
                .sp-copy-dropdown-item { width: 100%; text-align: left; padding: 8px 14px; background: none; border: none; cursor: pointer; font-size: 13px; color: #333; }
                .sp-copy-dropdown-item:hover { background: #f5f5f5; color: #0f6cbd; }

                .sp-card-actions { display:flex; align-items:center; gap:8px; flex-shrink:0; }
                .sp-tree-open-btn { border:none; background:#eef2f7; color:#0f6cbd; border-radius:6px; cursor:pointer; font-size:13px; padding:5px 8px; line-height:1; }
                .sp-tree-open-btn:hover { background:#e1e9f5; }

                .sp-view-tree { display:none; }
                .sp-tree-loading { display:none; }
                .sp-tree-header { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:12px; flex-shrink: 0; }
                .sp-back-btn { background:none; border:none; color:#0f6cbd; font-weight:600; cursor:pointer; font-size:13px; padding:4px 0; flex-shrink:0; }
                .sp-back-btn:hover { text-decoration:underline; }
                .sp-tree-drive-name { font-weight:600; font-size:13.5px; color:#2b303a; text-align:right; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width: 60%; }

                .sp-tree-container { flex-grow: 1; overflow-y:auto; overflow-x:auto; border: 1px solid #f0f0f0; border-radius: 6px; background: #fff; }
                .sp-tree-container::-webkit-scrollbar { width:5px; height:6px; }
                .sp-tree-container::-webkit-scrollbar-thumb { background:#ddd; border-radius:10px; }

                .sp-tree-wrapper-inner { display: inline-block; min-width: 100%; width: max-content; padding: 6px; }

                .sp-tree-row { display:flex; align-items:center; gap:6px; padding:6px 8px;
                    padding-left:calc(var(--sp-depth) * 18px + 6px); border-radius:4px; white-space: nowrap; width: 100%; }
                .sp-tree-row:hover { background:#f3f6fb; }

                .sp-tree-icon { flex-shrink:0; font-size:13px; }
                .sp-tree-name { font-size:13px; color:#2b303a; white-space: nowrap; }
                .sp-tree-size { margin-left: auto; font-size:12px; color:#0f6cbd; font-weight:600; width:90px; text-align:right; flex-shrink: 0; }
                .sp-tree-bar-wrap { width:60px; height:6px; background:#eef2f7; border-radius:3px; overflow:hidden; flex-shrink:0; margin-left: 10px; }
                .sp-tree-bar { height:100%; background:#0f6cbd; border-radius:3px; }
                .sp-tree-node-loading { display:flex; align-items:center; gap:8px; padding:6px 8px 6px calc(var(--sp-depth) * 18px + 26px); color:#6c757d; font-size:12px; }
                .sp-tree-node-loading .gx-spinner { width:16px; height:16px; border-width:2px; }
            `;
        }

        renderBody() {
            return `
                <div class="sp-view sp-view-list">
                    <div class="gx-loading sp-loading" style="display:none;">
                        <div class="gx-spinner"></div>
                        <span class="sp-loading-text">Đang chuẩn bị...</span>
                    </div>
                    <div class="sp-result" style="flex-grow: 1; display: flex; flex-direction: column; overflow: hidden;">
                        <div style="padding: 30px; text-align:center; color:#666; font-size:13px;">Bấm nút "Tính Dung Lượng SP" ở trên để bắt đầu lấy thông tin.</div>
                    </div>
                    <div class="sp-footer">
                        <div><span class="sp-total-label">Tổng cộng:</span> <span class="sp-total-value">0 GB</span></div>
                        <div class="sp-footer-actions">
                            <button class="sp-copy-btn">📋 Copy Dữ Liệu</button>
                            <button class="sp-copy-dropdown-toggle">▼</button>
                            <div class="sp-copy-dropdown-menu">
                                <!--<button class="sp-copy-dropdown-item" data-export="tsv">📋 Copy dạng bảng TSV</button>-->
                                <button class="sp-copy-dropdown-item disabledbtn" disabled data-export="excel" title="Thêm vào ver sau">📊 Xuất dữ liệu Excel (.xlsx)</button>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="sp-view sp-view-tree">
                    <div class="sp-tree-header">
                        <button class="sp-back-btn">← Quay lại danh sách Drive</button>
                        <div class="sp-tree-drive-name"></div>
                    </div>
                    <div class="gx-loading sp-tree-loading">
                        <div class="gx-spinner"></div>
                        <span>Đang tải cấu trúc thư mục...</span>
                    </div>
                    <div class="sp-tree-container">
                        <div class="sp-tree-wrapper-inner"></div>
                    </div>
                </div>
            `;
        }

        renderError(title, desc, icon) {
            return `
                <div class="gx-error">
                    <div class="gx-error-icon">${icon}</div>
                    <div>
                        <div class="gx-error-title">${title}</div>
                        <div class="gx-error-desc">${desc}</div>
                    </div>
                </div>`;
        }

        renderModernList(container) {
            const visualSorted = [...this.lastDriveSizes].sort((a, b) => b.gb - a.gb);
            let html = `<div class="sp-list-container">`;

            visualSorted.forEach(item => {
                const driveUrl = item.webUrl || "#";
                html += `
                    <div class="sp-card-row" data-drive-id="${Utils.escapeHtml(item.id)}" data-drive-name="${Utils.escapeHtml(item.name)}">
                        <div class="sp-card-info">
                            <a href="${driveUrl}" target="_blank" rel="noopener noreferrer" class="sp-drive-link-anchor" title="Mở Drive trên SharePoint (Tab mới)">
                                <div class="sp-drive-icon">📁</div>
                                <div class="sp-drive-name">${Utils.escapeHtml(item.name)}</div>
                            </a>
                        </div>
                        <div class="sp-card-actions">
                            <div class="sp-badge-size">${item.gb.toFixed(2)} GB</div>
                            <button class="sp-tree-open-btn" title="Xem cấu trúc thư mục">🌳</button>
                        </div>
                    </div>
                `;
            });

            if (this.isRecycleBinScanned) {
                const binGb = Utils.bytesToGB(this.recycleBinTotalBytes);
                html += `
                    <div class="sp-card-row sp-row-trash">
                        <div class="sp-card-info">
                            <div class="sp-drive-icon">🗑️</div>
                            <div class="sp-drive-name" style="font-weight:600;">Recycle Bin (Thùng rác hệ thống)</div>
                        </div>
                        <div class="sp-card-actions">
                            <div class="sp-badge-size">${binGb.toFixed(2)} GB</div>
                            <span style="font-size:12px;color:#d46b08;padding-right:6px;">(${this.recycleBinItems.length} items)</span>
                        </div>
                    </div>
                `;
            }

            html += `</div>`;
            container.innerHTML = html;
        }

        onShow(panelEl, minibarEl, host, includeRecycleBin = false) {
            this.startAnalyzing(panelEl, minibarEl, host, includeRecycleBin);
        }

        bindEvents(panelEl, minibarEl, host) {
            const copyBtn = panelEl.querySelector(".sp-copy-btn");
            const dropdownToggle = panelEl.querySelector(".sp-copy-dropdown-toggle");
            const dropdownMenu = panelEl.querySelector(".sp-copy-dropdown-menu");

            copyBtn.addEventListener("click", () => {
                this.copyResultsToClipboard(panelEl);
            });

            dropdownToggle.addEventListener("click", (e) => {
                e.stopPropagation();
                dropdownMenu.classList.toggle("show");
            });

            document.addEventListener("click", () => {
                dropdownMenu.classList.remove("show");
            });

            dropdownMenu.addEventListener("click", (e) => {
                const item = e.target.closest(".sp-copy-dropdown-item");
                if (!item) return;
                dropdownMenu.classList.remove("show");

                const type = item.dataset.export;
                if (type === "tsv") {
                    this.copyResultsToClipboard(panelEl);
                } else if (type === "excel") {
                    this.exportToExcelWorkflow();
                }
            });

            panelEl.querySelector(".sp-result").addEventListener("click", (e) => {
                const btn = e.target.closest(".sp-tree-open-btn");
                if (!btn) return;
                const row = btn.closest(".sp-card-row");
                this.openTreeView(panelEl, row.dataset.driveId, row.dataset.driveName);
            });

            panelEl.querySelector(".sp-back-btn").addEventListener("click", () => {
                this.showListView(panelEl);
            });

            panelEl.querySelector(".sp-tree-container").addEventListener("click", (e) => {
                const toggle = e.target.closest(".sp-tree-toggle");

                if (toggle) {
                    e.preventDefault();
                    e.stopPropagation();

                    const nodeEl = e.target.closest(".sp-tree-node");
                    if (nodeEl && nodeEl.classList.contains("sp-tree-folder")) {

                        // 1. Bật/Tắt class ngay lập tức để kích hoạt hiệu ứng CSS transition xoay tại chỗ
                        toggle.classList.toggle("sp-tree-toggle-expanded");

                        // 2. HOÃN lệnh render lại cây thư mục một chút để nhìn thấy hiệu ứng xoay mượt mà
                        setTimeout(() => {
                            this.toggleNode(panelEl, nodeEl.dataset.itemId);
                        }, 180); // 180ms là khoảng thời gian vừa đủ đẹp (nhỏ hơn 0.2s của transition một chút)
                    }
                    return;
                }

                if (e.target.closest("a")) return;
            });
        }

        // SỬA ĐỔI: Khi ấn hủy sẽ dừng luôn lập tức, không làm thay đổi trạng thái giao diện hiện tại
        onSettings(panelEl, minibarEl, host) {
            const current = ConfigStore.get("sp_site_url", DEFAULT_SITE_URL);
            const url = prompt("Nhập URL đầy đủ của Site SharePoint cần quét:", current);

            if (url === null) return; // Người dùng nhấn nút Hủy (Cancel) -> Dừng hẳn, không làm gì.
            if (!url.trim()) return;  // Người dùng xóa trống rồi nhấn OK -> Dừng hẳn.

            ConfigStore.set("sp_site_url", url.trim());

            // Chỉ khi nhập link hợp lệ mới mở Panel ra và kích hoạt quét mới
            host.show();
            this.startAnalyzing(panelEl, minibarEl, host, false);
        }

        async startAnalyzing(panelEl, minibarEl, host, includeRecycleBin = false) {
            const loadingEl = panelEl.querySelector(".sp-loading");
            const loadingText = panelEl.querySelector(".sp-loading-text");
            const resultEl = panelEl.querySelector(".sp-result");
            const footerEl = panelEl.querySelector(".sp-footer");

            loadingEl.style.display = "flex";
            resultEl.innerHTML = "";
            footerEl.style.display = "none";

            this.lastDriveSizes = [];
            this.scanTimestamp = "";
            this.recycleBinItems = [];
            this.recycleBinTotalBytes = 0;
            this.isRecycleBinScanned = includeRecycleBin;

            const updateStatus = (text) => {
                loadingText.textContent = text;
                this.currentStatus = text;
                host.updateMiniStatus(text);
            };

            if (!TokenManager.hasToken()) {
                updateStatus("Đang kết nối Microsoft Graph...");
                await TokenManager.ensureToken();
            }

            if (!TokenManager.hasToken()) {
                loadingEl.style.display = "none";
                resultEl.innerHTML = this.renderError(
                    "Yêu cầu đăng nhập",
                    'Vui lòng bấm nút "Access token" hoặc chạy thử 1 truy vấn bất kỳ trên Graph Explorer để kích hoạt.',
                    "⚠️"
                );
                updateStatus("Lỗi: Chưa có token");
                return;
            }

            try {
                const siteUrl = ConfigStore.get("sp_site_url", DEFAULT_SITE_URL);
                updateStatus(`Đang kết nối: ${siteUrl}...`);

                const site = await GraphAPI.resolveSiteId(siteUrl);
                this.siteFullId = site.id;

                const drives = await GraphAPI.getDrives(this.siteFullId);
                let driveSizes = [];
                let totalBytes = 0;

                for (let i = 0; i < drives.length; i++) {
                    const d = drives[i];
                    updateStatus(`Quét ổ đĩa (${i + 1}/${drives.length}): ${d.name}`);
                    try {
                        const used = await GraphAPI.getDriveUsedSize(d.id);
                        if (used > 0) {
                            driveSizes.push({ id: d.id, name: d.name, gb: Utils.bytesToGB(used), bytes: used, webUrl: d.webUrl });
                            totalBytes += used;
                        }
                    } catch (err) {
                        console.error("Bỏ qua ổ đĩa lỗi: " + d.name, err);
                    }
                }

                this.lastDriveSizes = driveSizes;
                this.scanTimestamp = Utils.formatDateTime();

                if (includeRecycleBin) {
                    updateStatus("Đang mở cổng kết nối dữ liệu rác (Beta)...");
                    let binUrl = `https://graph.microsoft.com/beta/sites/${this.siteFullId}/recycleBin/items?$select=size,deletedDateTime,name,deletedBy,deletedFromLocation&$top=1500`;

                    while (binUrl) {
                        const res = await GraphAPI.request(binUrl);
                        if (!res.ok) {
                            console.error("Không thể lấy trang dữ liệu rác kế tiếp.");
                            break;
                        }
                        const data = await res.json();
                        const items = data.value || [];

                        this.recycleBinItems = this.recycleBinItems.concat(items);

                        for (const item of items) {
                            this.recycleBinTotalBytes += item.size || 0;
                        }

                        updateStatus(`Đang quét Thùng rác:\nĐã tìm thấy ${this.recycleBinItems.length} mục (~ ${Utils.formatBytes(this.recycleBinTotalBytes)})`);
                        binUrl = data["@odata.nextLink"] || null;
                    }

                    totalBytes += this.recycleBinTotalBytes;
                }

                this.lastTotalGb = Utils.bytesToGB(totalBytes);

                loadingEl.style.display = "none";
                this.renderModernList(resultEl);
                footerEl.style.display = "flex";
                footerEl.querySelector(".sp-total-value").textContent = `${this.lastTotalGb.toFixed(2)} GB`;
                updateStatus(includeRecycleBin ? "Quét hoàn tất (Đã gộp Thùng rác)!" : "Đã quét xong!");

            } catch (error) {
                loadingEl.style.display = "none";
                resultEl.innerHTML = this.renderError("Xảy ra lỗi", error.message, "❌");
                updateStatus("Lỗi kết nối dữ liệu");
            }
        }

        copyResultsToClipboard(panelEl) {
            if (!this.lastDriveSizes.length) return;
            const excelSorted = [...this.lastDriveSizes].sort((a, b) => a.name.localeCompare(b.name, "vi"));
            let text = `Scanned At: ${this.scanTimestamp}\n`;
            text += "Tên Drive\tDung lượng (GB)\n";
            excelSorted.forEach(item => {
                text += `${item.name}\t${item.gb.toFixed(2)}\n`;
            });

            if (this.isRecycleBinScanned) {
                text += `Recycle Bin (Thùng rác)\t${Utils.bytesToGB(this.recycleBinTotalBytes).toFixed(2)}\n`;
            }

            text += `TỔNG CỘNG\t${this.lastTotalGb.toFixed(2)}\n`;

            const btn = panelEl.querySelector(".sp-copy-btn");
            const original = btn.innerHTML;

            navigator.clipboard.writeText(text).then(() => {
                btn.innerHTML = "✅ Đã copy bảng TSV!";
                btn.classList.add("sp-copy-success");
                setTimeout(() => {
                    btn.innerHTML = original;
                    btn.classList.remove("sp-copy-success");
                }, 2500);
            }).catch(err => {
                alert("Không thể copy.");
            });
        }

        showListView(panelEl) {
            panelEl.querySelector(".sp-view-list").style.display = "flex";
            panelEl.querySelector(".sp-view-tree").style.display = "none";
            this.currentView = "list";
        }

        async openTreeView(panelEl, driveId, driveName) {
            this.currentView = "tree";
            this.activeDriveId = driveId;
            this.activeDriveName = driveName;

            const listView = panelEl.querySelector(".sp-view-list");
            const treeView = panelEl.querySelector(".sp-view-tree");
            const treeContainerInner = treeView.querySelector(".sp-tree-wrapper-inner");
            const treeLoading = treeView.querySelector(".sp-tree-loading");

            listView.style.display = "none";
            treeView.style.display = "flex";
            treeView.querySelector(".sp-tree-drive-name").textContent = driveName;

            if (this.driveTrees[driveId]) {
                treeLoading.style.display = "none";
                this.renderTree(treeContainerInner, this.driveTrees[driveId].rootNodes);
                return;
            }

            treeContainerInner.innerHTML = "";
            treeLoading.style.display = "flex";

            try {
                const items = await GraphAPI.getFolderChildren(driveId, "root");
                const rootNodes = this.mapItemsToNodes(items);
                this.driveTrees[driveId] = { driveName, rootNodes };
                treeLoading.style.display = "none";
                this.renderTree(treeContainerInner, rootNodes);
            } catch (error) {
                treeLoading.style.display = "none";
                treeContainerInner.innerHTML = this.renderError("Xảy ra lỗi", error.message, "❌");
            }
        }

        mapItemsToNodes(items) {
            return items
                .filter(item => !Utils.isSystemItem(item.name))
                .map(item => ({
                    id: item.id,
                    name: item.name,
                    type: item.folder ? "folder" : "file",
                    size: item.size || 0,
                    webUrl: item.webUrl || "#",
                    loaded: false,
                    expanded: false,
                    children: null
                }));
        }

        findNodeById(nodes, id) {
            for (const node of nodes) {
                if (node.id === id) return node;
                if (node.children) {
                    const found = this.findNodeById(node.children, id);
                    if (found) return found;
                }
            }
            return null;
        }

        async toggleNode(panelEl, itemId) {
            const tree = this.driveTrees[this.activeDriveId];
            if (!tree) return;
            const node = this.findNodeById(tree.rootNodes, itemId);
            if (!node || node.type !== "folder") return;

            const treeContainerInner = panelEl.querySelector(".sp-tree-wrapper-inner");

            if (node.expanded) {
                node.expanded = false;
                this.renderTree(treeContainerInner, tree.rootNodes);
                return;
            }

            if (node.loaded) {
                node.expanded = true;
                this.renderTree(treeContainerInner, tree.rootNodes);
                return;
            }

            node.expanded = true;
            this.renderTree(treeContainerInner, tree.rootNodes);

            try {
                const items = await GraphAPI.getFolderChildren(this.activeDriveId, node.id);
                node.children = this.mapItemsToNodes(items);
                node.loaded = true;
            } catch (error) {
                node.expanded = false;
                alert("Không thể tải thư mục: " + error.message);
            }
            this.renderTree(treeContainerInner, tree.rootNodes);
        }

        renderTree(container, rootNodes) {
            container.innerHTML = this.renderNodes(rootNodes, 0);
        }

        renderNodes(nodes, depth) {
            if (!nodes || nodes.length === 0) return "";
            const sorted = [...nodes].sort((a, b) => b.size - a.size);
            const maxSize = sorted[0].size || 0;

            let html = "";
            sorted.forEach(node => {
                const isFolder = node.type === "folder";
                const percent = maxSize > 0 ? Math.min(100, (node.size / maxSize) * 100) : 0;
                const toggleClass = node.expanded ? "sp-tree-toggle-expanded" : "";
                const toggleIcon = isFolder ? "▶" : "";
                const escapedUrl = Utils.escapeHtml(node.webUrl);

                html += `
                    <div class="sp-tree-node ${isFolder ? "sp-tree-folder" : "sp-tree-file"}" data-item-id="${node.id}" style="--sp-depth:${depth}">
                        <div class="sp-tree-row">
                            <span class="sp-tree-toggle ${toggleClass}">${toggleIcon}</span>
                `;

                if (isFolder) {
                    html += `
                        <a href="${escapedUrl}" target="_blank" rel="noopener noreferrer" class="sp-tree-row-wrapper-link" title="Mở thư mục trên SharePoint (Tab mới)">
                            <span class="sp-tree-icon">📁</span>
                            <span class="sp-tree-name">${Utils.escapeHtml(node.name)}</span>
                        </a>
                        <!--<a href="${escapedUrl}" target="_blank" rel="noopener noreferrer" class="sp-tree-folder-arrow-link" title="Mở liên kết gốc">↗</a> -->
                    `;
                } else {
                    html += `
                        <a href="${escapedUrl}" target="_blank" rel="noopener noreferrer" class="sp-tree-row-wrapper-link" title="Mở file trên SharePoint (Tab mới)">
                            <span class="sp-tree-icon">📄</span>
                            <span class="sp-tree-name">${Utils.escapeHtml(node.name)}</span>
                        </a>
                    `;
                }

                html += `
                            <span class="sp-tree-size">${Utils.formatBytes(node.size)}</span>
                            <div class="sp-tree-bar-wrap"><div class="sp-tree-bar" style="width:${percent}%"></div></div>
                        </div>
                `;

                if (isFolder && node.expanded) {
                    if (node.loaded) {
                        html += this.renderNodes(node.children, depth + 1);
                    } else {
                        html += `
                            <div class="sp-tree-node-loading" style="--sp-depth:${depth}">
                                <div class="gx-spinner"></div>
                                <span>Đang tải...</span>
                            </div>
                        `;
                    }
                }
                html += `</div>`;
            });
            return html;
        }

        showProgressModal(title, cancelCallback) {
            const overlay = document.createElement("div");
            overlay.className = "gx-progress-overlay";
            overlay.innerHTML = `
                <div class="gx-progress-box">
                    <div class="gx-progress-title">${title}</div>
                    <div class="gx-progress-bar-bg"><div class="gx-progress-bar-fill"></div></div>
                    <div class="gx-progress-text" style="font-size:12px;color:#666;margin-bottom:16px;white-space:pre-line;">Khởi chạy tác vụ...</div>
                    <button class="gx-progress-btn-cancel">Hủy bỏ</button>
                </div>
            `;
            document.body.appendChild(overlay);

            overlay.querySelector(".gx-progress-btn-cancel").onclick = () => {
                cancelCallback();
                overlay.remove();
            };

            return {
                update(percent, text) {
                    overlay.querySelector(".gx-progress-bar-fill").style.width = `${percent}%`;
                    overlay.querySelector(".gx-progress-text").textContent = text;
                },
                close() { overlay.remove(); }
            };
        }

        async scanDriveRecursively(driveId, abortSignal, progressCallback) {
            const resultList = [];
            const queue = [{ id: "root", path: "/" }];

            while (queue.length > 0) {
                if (abortSignal.aborted) throw new Error("TaskAborted");

                const current = queue.shift();
                progressCallback(`Đang trích xuất cấu trúc: ${current.path}\n(Đã quét ${resultList.length} tài nguyên)`);

                try {
                    const children = await GraphAPI.getFolderChildren(driveId, current.id);

                    for (const item of children) {
                        if (Utils.isSystemItem(item.name)) continue;

                        const itemPath = current.path + (current.path === "/" ? "" : "/") + item.name;

                        resultList.push({
                            Path: current.path,
                            Name: item.name,
                            Type: item.folder ? "Folder" : "File",
                            SizeBytes: item.size || 0,
                            SizeGB: Utils.bytesToGB(item.size || 0)
                        });

                        if (item.folder) {
                            queue.push({ id: item.id, path: itemPath });
                        }
                    }
                } catch (e) {
                    console.error("Bỏ qua lỗi nhánh phân rã: ", e);
                }
            }
            return resultList;
        }

        async exportToExcelWorkflow() {
            if (!this.lastDriveSizes || this.lastDriveSizes.length === 0) {
                alert("Không có dữ liệu tổng quan để xuất!");
                return;
            }

            if (typeof XLSX === "undefined") {
                alert("Thư viện SheetJS chưa được tải thành công. Vui lòng thử lại!");
                return;
            }

            let includeTrashSheet = false;
            if (this.isRecycleBinScanned && this.recycleBinItems && this.recycleBinItems.length > 0) {
                includeTrashSheet = confirm(`Hệ thống ghi nhận cấu trúc Thùng rác gồm ${this.recycleBinItems.length} mục.\nBạn có muốn xuất thêm sheet "Thùng rác" vào file Excel không?`);
            }

            const abortController = new AbortController();
            const progress = this.showProgressModal("Đang xây dựng cây mô hình cấu trúc SharePoint...", () => {
                abortController.abort();
            });

            try {
                const workbook = XLSX.utils.book_new();

                progress.update(5, "Đang kiến tạo Trang Tổng Quan...");
                const overviewRows = [];

                this.lastDriveSizes.forEach(item => {
                    overviewRows.push({
                        "DPT": item.name,
                        "SIZE(GB)": Number(item.gb.toFixed(4))
                    });
                });

                if (this.isRecycleBinScanned) {
                    overviewRows.push({
                        "DPT": "Recycle Bin (Thùng rác hệ thống)",
                        "SIZE(GB)": Number(Utils.bytesToGB(this.recycleBinTotalBytes).toFixed(4))
                    });
                }

                const wsOverview = XLSX.utils.json_to_sheet(overviewRows, { header: ["DPT", "SIZE(GB)"] });

                const totalRowIdx = overviewRows.length + 2;
                XLSX.utils.sheet_add_aoa(wsOverview, [
                    ["TOTAL", Number(this.lastTotalGb.toFixed(4))]
                ], { origin: `A${totalRowIdx}` });

                wsOverview["!freeze"] = { xSplit: 0, ySplit: 1 };
                this.autoFitColumns(wsOverview);

                XLSX.utils.book_append_sheet(workbook, wsOverview, "Tổng Quan");

                for (let i = 0; i < this.lastDriveSizes.length; i++) {
                    const drive = this.lastDriveSizes[i];
                    const percent = 5 + Math.floor((i / this.lastDriveSizes.length) * 85);
                    progress.update(percent, `[${i + 1}/${this.lastDriveSizes.length}] Bóc tách: ${drive.name}`);

                    let flatItems = [];
                    if (this.driveTrees[drive.id] && this.driveTrees[drive.id].rootNodes && this.isFullyLoadedCache(this.driveTrees[drive.id].rootNodes)) {
                        flatItems = this.flattenCacheTree(this.driveTrees[drive.id].rootNodes, "/");
                    } else {
                        flatItems = await this.scanDriveRecursively(drive.id, abortController.signal, (msg) => {
                            progress.update(percent, `[${i + 1}/${this.lastDriveSizes.length}] ${drive.name}\n${msg}`);
                        });
                    }

                    const wsDrive = XLSX.utils.json_to_sheet(flatItems.map(f => ({
                        "Path": f.Path,
                        "Name": f.Name,
                        "Type": f.Type,
                        "Size (Bytes)": f.SizeBytes,
                        "Size (GB)": Number(f.SizeGB.toFixed(5))
                    })), { header: ["Path", "Name", "Type", "Size (Bytes)", "Size (GB)"] });

                    this.applyNumberFormatToColumn(wsDrive, "D", flatItems.length);
                    wsDrive["!freeze"] = { xSplit: 0, ySplit: 1 };
                    this.autoFitColumns(wsDrive);

                    const safeSheetName = drive.name.replace(/[\[\]\*\?\:\\\/]/g, "").substring(0, 31);
                    XLSX.utils.book_append_sheet(workbook, wsDrive, safeSheetName);
                }

                if (includeTrashSheet && this.recycleBinItems) {
                    progress.update(95, "Đang định dạng múi giờ Việt Nam cho Thùng rác...");

                    const trashRows = this.recycleBinItems.map(item => ({
                        "deletedFromLocation": item.deletedFromLocation || "",
                        "name": item.name || "",
                        "size": item.size || 0,
                        "deletedDateTime_VN": Utils.formatIsoToVN(item.deletedDateTime),
                        "deletedBy": item.deletedBy?.user?.displayName || ""
                    }));

                    const wsTrash = XLSX.utils.json_to_sheet(trashRows, {
                        header: ["deletedFromLocation", "name", "size", "deletedDateTime_VN", "deletedBy"]
                    });

                    this.applyNumberFormatToColumn(wsTrash, "C", trashRows.length);
                    wsTrash["!freeze"] = { xSplit: 0, ySplit: 1 };
                    this.autoFitColumns(wsTrash);

                    XLSX.utils.book_append_sheet(workbook, wsTrash, "Thùng rác");
                }

                progress.update(98, "Đang đóng gói file nhị phân Excel (.xlsx)...");
                const siteUrlStr = ConfigStore.get("sp_site_url", DEFAULT_SITE_URL);
                const siteName = siteUrlStr.split('/').pop() || "SharePoint";

                XLSX.writeFile(workbook, `SharePoint_Storage_Report_${siteName}_${Utils.formatDateTime().replace(/[:\s\/]/g, "-")}.xlsx`);
                progress.close();

            } catch (error) {
                progress.close();
                if (error.message === "TaskAborted") {
                    alert("Quy trình trích xuất file Excel đã dừng theo lệnh cấu hình.");
                } else {
                    console.error(error);
                    alert("Gặp lỗi khi xuất Excel: " + error.message);
                }
            }
        }

        isFullyLoadedCache(nodes) {
            if (!nodes || nodes.length === 0) return true;
            return nodes.every(n => n.type === "file" || (n.type === "folder" && n.loaded));
        }

        flattenCacheTree(nodes, currentPath) {
            let results = [];
            nodes.forEach(node => {
                results.push({
                    Path: currentPath,
                    Name: node.name,
                    Type: node.type === "folder" ? "Folder" : "File",
                    SizeBytes: node.size,
                    SizeGB: Utils.bytesToGB(node.size)
                });
                if (node.type === "folder" && node.children) {
                    const nextPath = currentPath + (currentPath === "/" ? "" : "/") + node.name;
                    results = results.concat(this.flattenCacheTree(node.children, nextPath));
                }
            });
            return results;
        }

        autoFitColumns(ws) {
            if (!ws || !ws['!ref']) return;
            const range = XLSX.utils.decode_range(ws['!ref']);
            const cols = [];
            for (let C = range.s.c; C <= range.e.c; ++C) {
                let maxLen = 11;
                for (let R = range.s.r; R <= range.e.r; ++R) {
                    const cell = ws[XLSX.utils.encode_cell({ r: R, c: C })];
                    if (cell && cell.v) {
                        const len = String(cell.v).length;
                        if (len > maxLen) maxLen = len;
                    }
                }
                cols.push({ wch: maxLen + 3 });
            }
            ws['!cols'] = cols;
        }

        applyNumberFormatToColumn(ws, colLetter, totalRows) {
            for (let r = 2; r <= totalRows + 1; r++) {
                const cellRef = colLetter + r;
                if (ws[cellRef]) {
                    ws[cellRef].z = '#,##0';
                }
            }
        }
    }

    // =====================================================================
    // 8. ĐĂNG KÝ VÀ KHỞI CHẠY TOOLKIT
    // =====================================================================
    const FEATURES = [
        new StorageAnalyzerFeature()
    ];

    function findAccessTokenButton() {
        return [...document.querySelectorAll("button")].find(btn => {
            const text = (btn.textContent || btn.innerText || "").trim();
            return text.toLowerCase().includes("access token");
        });
    }

    function createCustomUI() {
        if (document.getElementById("gx-toolkit-mounted")) return;
        const sourceBtn = findAccessTokenButton();
        if (!sourceBtn) return;

        StyleManager.inject(FEATURES);

        FEATURES.forEach(feature => {
            const host = new PanelHost(feature);
            host.mount(sourceBtn);
        });

        const marker = document.createElement("span");
        marker.id = "gx-toolkit-mounted";
        marker.style.display = "none";
        sourceBtn.insertAdjacentElement("afterend", marker);
    }

    const observer = new MutationObserver(() => createCustomUI());
    observer.observe(document.documentElement, { childList: true, subtree: true });
})();