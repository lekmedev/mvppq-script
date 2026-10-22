// ==UserScript==
// @name         Auto Total Cost & VAT
// @namespace    https://violentmonkey.github.io/
// @version      1.3.1
// @description  Tự tính thành tiền từng dòng, Total Cost, VAT và Total Including VAT
// @author       You
// @match        https://adminmovenpickphuquoc.e-sign.vn/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=e-sign.vn
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(() => {
    "use strict";

    const DEBUG = false;
    const log = (...args) => DEBUG && console.log(...args);

    // Tránh khởi tạo nhiều lần
    if (window.__autoTotalVM?.stop) window.__autoTotalVM.stop();

    // Chỉ chạy ở trang formedit (trang là SPA nên phải tự theo dõi đổi route)
    const isTarget = () => /\/eofficeform\/formedit(\/|$)/i.test(location.pathname);

    const config = {
        quantity: "#b",
        price: "#c",
        rowTotal: "#a",

        totalCostXPath:
            "/html/body/app/div[3]/div[4]/div[2]/div/div[3]/div[2]/div/div/form/div[2]/div[9]/div/div/div/div[8]/div/input",
        taxRateXPath:
            "/html/body/app/div[3]/div[4]/div[2]/div/div[3]/div[2]/div/div/form/div[2]/div[9]/div/div/div/div[10]/div/input",
        vatAmountXPath:
            "/html/body/app/div[3]/div[4]/div[2]/div/div[3]/div[2]/div/div/form/div[2]/div[9]/div/div/div/div[12]/div/input",
        totalIncludingVatXPath:
            "/html/body/app/div[3]/div[4]/div[2]/div/div[3]/div[2]/div/div/form/div[2]/div[9]/div/div/div/div[14]/div/input",

        tbodySelector: "form table tbody",
        tbodyIndex: 3,   // tbody thứ 4
        totalColumn: 7   // cột thứ 7
    };

    let stopped = true;     // true khi không ở trang formedit
    let destroyed = false;

    // Timer tách riêng để không hủy lẫn nhau
    let rowTimer, taxTimer, updateTimer, tbodyTimer, rafId;

    let activeInputs = [];
    let activeTaxInput = null;
    let activeTbody = null;

    const editorCleanups = [];
    const taxCleanups = [];
    const buttonCleanups = [];
    const hookedButtons = new WeakSet();

    // ---------- Helpers ----------

    function parseNumber(value) {
        let s = String(value ?? "").trim().replace(/[^\d,.-]/g, "");
        if (!s) return 0;

        // "1.234" / "1,234,567" => dấu phân tách hàng nghìn
        // Lưu ý: "2.500" cũng bị hiểu là 2500. Đổi nếu số lượng có 3 chữ số thập phân.
        if (/^-?\d{1,3}([.,]\d{3})+$/.test(s)) {
            s = s.replace(/[.,]/g, "");
        } else if (s.includes(",") && s.includes(".")) {
            s = s.lastIndexOf(",") > s.lastIndexOf(".")
                ? s.replace(/\./g, "").replace(",", ".")
                : s.replace(/,/g, "");
        } else if (s.includes(",")) {
            s = s.replace(",", ".");
        }

        return Number(s) || 0;
    }

    const toCents = n => Math.round((n + Number.EPSILON) * 100);
    const fromCents = c => (c / 100).toFixed(2);

    // Định dạng phân tách hàng nghìn (1,234,567.89). Ô type=number thì giữ nguyên số thô.
    function group(n, minFrac, maxFrac, el) {
        if (el && el.type === "number") return String(Number(n.toFixed(maxFrac)));
        return n.toLocaleString("en-US", {
            minimumFractionDigits: minFrac,
            maximumFractionDigits: maxFrac
        });
    }
    // Số tiền: bỏ .00 khi là số nguyên, giữ tối đa 2 số lẻ nếu có
    const fmtCents = (c, el) => group(c / 100, 0, 2, el);

    function getValue(el) {
        if (!el) return "";
        return "value" in el ? el.value : el.textContent.trim();
    }

    function getByXPath(xpath) {
        return document.evaluate(
            xpath, document, null,
            XPathResult.FIRST_ORDERED_NODE_TYPE, null
        ).singleNodeValue;
    }

    function setValue(el, value, force = false) {
        if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) {
            console.warn("[Auto Total] Input không hợp lệ:", el);
            return false;
        }

        const next = String(value);
        if (!force && el.value === next) return true;

        const setter = Object.getOwnPropertyDescriptor(
            Object.getPrototypeOf(el), "value"
        )?.set;

        if (setter) setter.call(el, next);
        else el.value = next;

        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
    }

    function runCleanups(list) {
        while (list.length) list.pop()();
    }

    const isEditing = () => !!document.querySelector(config.rowTotal);

    // ---------- Tính toán ----------

    // 1. Thành tiền = số lượng × đơn giá
    function calculateRow() {
        if (stopped) return false;

        const total = document.querySelector(config.rowTotal);
        const quantity = document.querySelector(config.quantity);
        const price = document.querySelector(config.price);
        if (!total || !quantity || !price) return false;

        const qText = getValue(quantity).trim();
        const pText = getValue(price).trim();

        if (qText === "" || pText === "") {
            return setValue(total, "0.00", true);
        }

        const q = parseNumber(qText);
        const p = parseNumber(pText);
        const cents = toCents(q * p);

        log(`[Auto Row] ${q} × ${p} = ${fromCents(cents)}`);
        return setValue(total, fromCents(cents), true);
    }

    // 2. Total Cost = tổng cột thứ 7 của tbody thứ 4 (cộng theo cent)
    function calculateTotalCost() {
        if (stopped) return null;

        const tbody = document.querySelectorAll(config.tbodySelector)[config.tbodyIndex];
        if (!tbody) {
            log("[Auto Total] Không tìm thấy tbody.");
            return null;
        }

        const rows = [...tbody.querySelectorAll(":scope > tr")];
        const cents = rows.reduce((sum, row) => {
            const text = row.querySelector(`td:nth-child(${config.totalColumn})`)?.innerText ?? "";
            return sum + toCents(parseNumber(text));
        }, 0);

        const input = getByXPath(config.totalCostXPath);
        if (!input) {
            console.warn("[Auto Total] Không tìm thấy ô Total Cost.");
            return null;
        }

        if (!setValue(input, fmtCents(cents, input))) return null;

        log(`[Auto Total] Total Cost = ${fromCents(cents)} | Rows = ${rows.length}`);
        return cents;
    }

    // 3. VAT Amount và Total Including VAT
    function calculateTax() {
        if (stopped) return;

        const totalCostInput = getByXPath(config.totalCostXPath);
        const taxRateInput = getByXPath(config.taxRateXPath);
        const vatAmountInput = getByXPath(config.vatAmountXPath);
        const totalInclInput = getByXPath(config.totalIncludingVatXPath);

        if (!totalCostInput || !taxRateInput || !vatAmountInput || !totalInclInput) {
            log("[Auto VAT] Chưa tìm thấy đủ các trường thuế.");
            return;
        }

        const totalCostText = getValue(totalCostInput).trim();
        if (totalCostText === "") return;

        // Tax Rate trống => coi như 0%
        const taxRate = parseNumber(getValue(taxRateInput));
        const costCents = toCents(parseNumber(totalCostText));
        const vatCents = Math.round(costCents * taxRate / 100);

        setValue(vatAmountInput, fmtCents(vatCents, vatAmountInput));
        setValue(totalInclInput, fmtCents(costCents + vatCents, totalInclInput));

        log(`[Auto VAT] VAT = ${fromCents(vatCents)} | Total = ${fromCents(costCents + vatCents)}`);
    }

    // 4. Cập nhật toàn bộ
    function updateAllTotals() {
        if (stopped) return;
        if (calculateTotalCost() !== null) calculateTax();
    }

    // ---------- Gắn listener ----------

    // 5. Số lượng / đơn giá
    function bindEditors() {
        if (stopped) return;

        const total = document.querySelector(config.rowTotal);
        const quantity = document.querySelector(config.quantity);
        const price = document.querySelector(config.price);
        if (!total || !quantity || !price) return;

        const current = [total, quantity, price];
        if (current.every((el, i) => el === activeInputs[i])) return;

        runCleanups(editorCleanups);
        activeInputs = current;

        const onInput = () => {
            clearTimeout(rowTimer);
            rowTimer = setTimeout(calculateRow, 100);
        };

        [quantity, price].forEach(el => {
            el.addEventListener("input", onInput);
            el.addEventListener("change", onInput);
        });

        editorCleanups.push(() => {
            [quantity, price].forEach(el => {
                el.removeEventListener("input", onInput);
                el.removeEventListener("change", onInput);
            });
        });

        setTimeout(() => { if (!stopped) calculateRow(); }, 150);
    }

    // 6. Tax Rate
    function bindTaxRate() {
        if (stopped) return;

        const input = getByXPath(config.taxRateXPath);
        if (!input || input === activeTaxInput) return;

        runCleanups(taxCleanups);

        const onTaxRateChange = () => {
            clearTimeout(taxTimer);
            taxTimer = setTimeout(calculateTax, 150);
        };

        // Định dạng dấu phẩy khi rời ô (không format lúc đang gõ để khỏi nhảy con trỏ)
        const onTaxRateBlur = () => {
            const t = getValue(input).trim();
            if (t === "") return;
            setValue(input, group(parseNumber(t), 0, 2, input));
        };

        input.addEventListener("input", onTaxRateChange);
        input.addEventListener("change", onTaxRateChange);
        input.addEventListener("focusout", onTaxRateBlur);

        taxCleanups.push(() => {
            input.removeEventListener("input", onTaxRateChange);
            input.removeEventListener("change", onTaxRateChange);
            input.removeEventListener("focusout", onTaxRateBlur);
        });

        activeTaxInput = input;
        log("[Auto VAT] Đã gắn listener cho Tax Rate.");
    }

    // 7. Nút Update
    function bindUpdateButtons() {
        if (stopped) return;

        document.querySelectorAll("button").forEach(button => {
            if (button.innerText.trim() !== "Update") return;
            if (hookedButtons.has(button)) return;

            hookedButtons.add(button);

            const onClick = () => {
                clearTimeout(updateTimer);
                updateTimer = setTimeout(updateAllTotals, 500);
            };

            button.addEventListener("click", onClick, true);
            buttonCleanups.push(() => button.removeEventListener("click", onClick, true));
        });
    }

    // 8. Theo dõi tbody: thêm/xóa/sửa dòng thì tự tính lại
    const scheduleTbodyUpdate = () => {
        clearTimeout(tbodyTimer);
        tbodyTimer = setTimeout(() => {
            if (!isEditing()) updateAllTotals(); // đang sửa dòng thì bỏ qua
        }, 300);
    };

    const tbodyObserver = new MutationObserver(scheduleTbodyUpdate);

    function bindTbody() {
        if (stopped) return;

        const tbody = document.querySelectorAll(config.tbodySelector)[config.tbodyIndex];
        if (!tbody || tbody === activeTbody) return;

        tbodyObserver.disconnect();
        tbodyObserver.observe(tbody, {
            childList: true,
            subtree: true,
            characterData: true
        });
        activeTbody = tbody;

        scheduleTbodyUpdate();
    }

    // 9. Theo dõi DOM khi Blazor/Syncfusion render lại (throttle bằng rAF)
    function bindAll() {
        bindEditors();
        bindUpdateButtons();
        bindTaxRate();
        bindTbody();
    }

    const observer = new MutationObserver(() => {
        cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(bindAll);
    });

    function activate() {
        if (!stopped || destroyed || !document.body) return;
        stopped = false;

        bindAll();
        observer.observe(document.body, { childList: true, subtree: true });
        log("[Auto Total] Đã bật (formedit).");
    }

    function deactivate() {
        if (stopped) return;
        stopped = true;

        observer.disconnect();
        tbodyObserver.disconnect();

        clearTimeout(rowTimer);
        clearTimeout(taxTimer);
        clearTimeout(updateTimer);
        clearTimeout(tbodyTimer);
        cancelAnimationFrame(rafId);

        runCleanups(editorCleanups);
        runCleanups(taxCleanups);
        runCleanups(buttonCleanups);

        activeInputs = [];
        activeTaxInput = null;
        activeTbody = null;
        log("[Auto Total] Đã tạm dừng (rời formedit).");
    }

    // ---------- Theo dõi đổi route (Blazor SPA) ----------

    let lastUrl = "";

    function checkRoute() {
        if (destroyed || location.href === lastUrl) return;
        lastUrl = location.href;
        if (isTarget()) activate();
        else deactivate();
    }

    const origPush = history.pushState;
    const origReplace = history.replaceState;

    const patchedPush = function (...args) {
        const r = origPush.apply(this, args);
        queueMicrotask(checkRoute);
        return r;
    };
    const patchedReplace = function (...args) {
        const r = origReplace.apply(this, args);
        queueMicrotask(checkRoute);
        return r;
    };

    history.pushState = patchedPush;
    history.replaceState = patchedReplace;
    window.addEventListener("popstate", checkRoute);
    window.addEventListener("hashchange", checkRoute);
    const routeTimer = setInterval(checkRoute, 1000); // dự phòng

    function destroy() {
        if (destroyed) return;
        destroyed = true;

        deactivate();
        clearInterval(routeTimer);
        window.removeEventListener("popstate", checkRoute);
        window.removeEventListener("hashchange", checkRoute);
        if (history.pushState === patchedPush) history.pushState = origPush;
        if (history.replaceState === patchedReplace) history.replaceState = origReplace;

        delete window.__autoTotalVM;
        console.log("[Auto Total] Đã dừng.");
    }

    window.__autoTotalVM = {
        updateTotalCost: calculateTotalCost,
        updateTax: calculateTax,
        updateAllTotals,
        stop: destroy
    };

    checkRoute();

    console.log(
        "[Auto Total] Đã nạp. __autoTotalVM.updateAllTotals() để tính lại; __autoTotalVM.stop() để dừng hẳn."
    );
})();
