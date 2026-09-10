/**
 * dsh-tool-vision — browser half.
 *
 * A "视觉模型" section inside the Web UI settings page: edits the
 * `tool-vision` settings namespace (API endpoint, key, model, bridge
 * options) through the settings scope transport. Changes hot-apply via the
 * host settings provider — no restart needed.
 *
 * Bridge image preview (v0.4.0, contributed by xing666173 from
 * dsh-bridge-preview, MIT © 2026 xing666173): scans user bubbles for bridge
 * hint text blocks stamped with the invisible `BRIDGE_MARKER` (`\u200b[bridge]`)
 * and renders an inline thumbnail (click to zoom, lightbox). Pure display
 * layer — persisted messages, the transcript and the model-facing text are
 * untouched. Robustness: per-block dedup, MutationObserver + configurable
 * fallback interval, silent degradation on load failure, and optional
 * hint-text hiding once the image has loaded (P2).
 *
 * Hand-written ModuleLoader bundle — no build step required.
 */
window.__ModuleLoader__.load({
  id: "dsh-tool-vision",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var h = react.createElement;

    // ── CSS (theme tokens) ────────────────────────────────────────────────
    var CSS = ".__tv_root{max-width:640px;display:flex;flex-direction:column;gap:10px}" +
      ".__tv_field{display:flex;flex-direction:column;gap:4px}" +
      ".__tv_label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:6px}" +
      ".__tv_override{font-size:10px;color:var(--dsw-alias-state-business-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:4px;padding:0 4px}" +
      ".__tv_hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}" +
      ".__tv_input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 10px;font-size:13px;box-sizing:border-box;width:100%}" +
      ".__tv_row{display:flex;align-items:center;gap:8px}" +
      ".__tv_check{accent-color:var(--dsw-alias-state-business-primary)}" +
      ".__tv_actions{display:flex;gap:8px;align-items:center;margin-top:4px}" +
      ".__tv_btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 14px;font:inherit;font-size:13px;cursor:pointer}" +
      ".__tv_btn:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}" +
      ".__tv_btn:disabled{opacity:.5;cursor:default}" +
      ".__tv_btnPrimary{border-color:var(--dsw-alias-state-business-primary, #3964fe);background:var(--dsw-alias-state-business-primary, #3964fe);color:#fff}" +
      ".__tv_btnDanger{border-color:var(--dsw-alias-state-error-primary, #e5484d);color:var(--dsw-alias-state-error-primary, #e5484d)}" +
      ".__tv_btnDanger:hover:not(:disabled){background:var(--dsw-alias-state-error-primary, #e5484d);color:#fff}" +
      ".__tv_master{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;margin:2px 0 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}" +
      ".__tv_masterLabel{font-size:13px;color:var(--dsw-alias-label-primary)}" +
      ".__tv_status{font-size:12px;color:var(--dsw-alias-label-tertiary)}" +
      ".__tv_error{font-size:12px;color:var(--dsw-alias-state-error-primary)}" +
      ".__tv_unavailable{font-size:13px;color:var(--dsw-alias-label-tertiary)}";
    var tagId = "dsh-tool-vision/main.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-tool-vision";
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // ── locale ────────────────────────────────────────────────────────────
    var NS = "toolVision";
    var inject = ["slots", "locale", "settingsScope"];
    var zh = {
      nav: "视觉模型",
      intro: "外置视觉模型配置：Agent 通过 inspect_image 工具把图片发给该端点分析。修改后即时生效（settings.yaml 热重载）。",
      apiKeyHint: "留空保持当前密钥。密钥只写不读，不会回显。",
      maxTokens: "最大输出 Tokens",
      timeoutMs: "请求超时（毫秒）",
      maxImageBytes: "本地图片大小上限（字节）",
      bridgeTextOnly: "图片桥接（文本模型贴图自动转 inspect_image 指引）",
      bridgeExportDir: "桥接图片导出目录（空 = 系统临时目录）",
      multimodalModels: "多模态白名单（逗号分隔，这些模型直收图片块）",
      fieldBaseUrl: "API Base URL",
      fieldApiKey: "API Key",
      fieldApiKeyEnv: "API Key 环境变量（apiKey 为空时读取）",
      fieldModel: "视觉模型",
      fieldMaxTokens: "最大输出 Tokens",
      fieldTimeoutMs: "请求超时（毫秒）",
      fieldMaxImageBytes: "图片大小上限（字节）",
      fieldBridgeTextOnly: "图片桥接开关",
      fieldBridgeExportDir: "桥接导出目录",
      fieldMultimodalModels: "多模态白名单（逗号分隔）",
      fieldBridgePreview: "桥接图片内联预览（气泡内缩略图，点击放大）",
      fieldBridgePreviewScanIntervalMs: "预览兜底扫描间隔（毫秒，0 = 关闭兜底）",
      fieldBridgePreviewHideHint: "图片加载成功后隐藏桥接提示文本",
      fieldBridgeAutoImage: "自动声明图片能力（纯文本模型也能粘贴图片）",
      fieldDesktopScreenshot: "桌面截屏工具（vision_screenshot，默认关闭）",
      fieldSendSessionHeader: "发送会话标识头（x-opencode-session）",
      fieldSessionHeaderName: "会话标识头名称",
      fieldSessionId: "固定会话 ID（留空 = 自动）",
      hintSendSessionHeader: "OpenCode Go 等网关要求每个请求带稳定的会话标识（一个对话一个 ID）；请求不带可能报错。默认发送：优先用当前 dsh 会话 ID，无会话上下文时用下方固定 ID，再否则用进程级随机 ID。",
      hintSessionId: "后台/无会话调用时使用的固定会话标识（如 dsh-vision-<hostname>）；留空则每进程自动生成一个稳定 ID。",
      hintBridgePreview: "纯展示层：不影响模型侧文本与 inspect_image 调用。",
      hintBridgePreviewScanIntervalMs: "默认 2000ms；越小响应越快，越大越省资源。",
      hintBridgePreviewHideHint: "加载失败时保留文本（安全降级，绝不出现既无图又无字）。",
      hintBridgeAutoImage: "桥接开启时向宿主报告所有模型支持图片，绕过“模型不支持图片”的发送拦截；实际仍走桥接转文本。",
      hintDesktopScreenshot: "隐私敏感能力：仅在开启后注册 vision_screenshot 桌面截屏工具，模型才可截取用户屏幕。",
      save: "保存",
      reset: "恢复默认",
      saved: "已保存",
      saving: "保存中…",
      error: "保存失败",
      unavailable: "设置命名空间不可用（服务端未注册 tool-vision 命名空间？）",
      overridden: "已覆盖",
      loading: "加载中…",
      fieldEnabled: "启用插件（关闭后所有视觉工具下线）",
      masterSwitch: "总开关",
      turnOff: "一键关闭",
      turnOn: "重新启用",
      enabledNotice: "已启用：视觉工具已上线",
      disabledNotice: "已关闭：所有视觉工具已下线",
      notApplied: "写入未生效"
    };
    var en = {
      nav: "Vision Model",
      intro: "External vision model config: the agent sends images to this endpoint via the inspect_image tool. Changes apply immediately (settings.yaml hot-reload).",
      apiKeyHint: "Leave blank to keep the current key. The key is write-only and never echoed.",
      maxTokens: "Max output tokens",
      timeoutMs: "Request timeout (ms)",
      maxImageBytes: "Max local image size (bytes)",
      bridgeTextOnly: "Image bridge (pasted images on text-only models become inspect_image hints)",
      bridgeExportDir: "Bridge export dir (empty = system temp)",
      multimodalModels: "Multimodal whitelist (comma-separated; these models receive image blocks directly)",
      fieldBaseUrl: "API Base URL",
      fieldApiKey: "API Key",
      fieldApiKeyEnv: "API key env var (read when apiKey is empty)",
      fieldModel: "Vision model",
      fieldMaxTokens: "Max output tokens",
      fieldTimeoutMs: "Request timeout (ms)",
      fieldMaxImageBytes: "Max image size (bytes)",
      fieldBridgeTextOnly: "Image bridge",
      fieldBridgeExportDir: "Bridge export dir",
      fieldMultimodalModels: "Multimodal whitelist (comma-separated)",
      fieldBridgePreview: "Bridge image preview (inline thumbnail in the bubble, click to zoom)",
      fieldBridgePreviewScanIntervalMs: "Preview fallback scan interval (ms, 0 = disable)",
      fieldBridgePreviewHideHint: "Hide the bridged hint text once the image has loaded",
      fieldBridgeAutoImage: "Auto-declare image capability (paste images on text-only models)",
      fieldDesktopScreenshot: "Desktop screenshot tool (vision_screenshot, off by default)",
      fieldSendSessionHeader: "Send session-id header (x-opencode-session)",
      fieldSessionHeaderName: "Session-id header name",
      fieldSessionId: "Fixed session id (empty = auto)",
      hintSendSessionHeader: "OpenCode Go and similar gateways require a stable per-conversation id on every request; requests without it may error. When on: prefer the current dsh session id, else the fixed id below, else a per-process random id.",
      hintSessionId: "Fixed session id used for background calls without a dsh session; leave empty for a per-process stable random id.",
      hintBridgePreview: "Pure display layer: the model-facing text and the inspect_image chain are untouched.",
      hintBridgePreviewScanIntervalMs: "Default 2000ms; lower is snappier, higher is cheaper.",
      hintBridgePreviewHideHint: "Text is kept on load failure (safe degradation, never no image AND no text).",
      hintBridgeAutoImage: "While the bridge is on, report image support for every model to bypass the host image-send gate; images still travel as bridged text hints.",
      hintDesktopScreenshot: "Privacy-sensitive: the vision_screenshot desktop-capture tool is only registered (and visible to the model) when enabled.",
      save: "Save",
      reset: "Reset",
      saved: "Saved",
      saving: "Saving…",
      error: "Save failed",
      unavailable: "Settings namespace unavailable (tool-vision namespace not registered server-side?)",
      overridden: "overridden",
      loading: "Loading…",
      fieldEnabled: "Enable plugin (off takes every vision tool offline)",
      masterSwitch: "Master switch",
      turnOff: "Disable all",
      turnOn: "Re-enable",
      enabledNotice: "Enabled: vision tools are live",
      disabledNotice: "Disabled: every vision tool is offline",
      notApplied: "Write did not take effect"
    };

    // ── field spec ────────────────────────────────────────────────────────
    var FIELDS = [
      { key: "enabled", label: "fieldEnabled", type: "checkbox" },
      { key: "baseURL", label: "fieldBaseUrl", type: "text", placeholder: "https://api.openai.com/v1" },
      { key: "apiKey", label: "fieldApiKey", type: "password", secret: true },
      { key: "apiKeyEnv", label: "fieldApiKeyEnv", type: "text" },
      { key: "model", label: "fieldModel", type: "text", placeholder: "gpt-4o-mini" },
      { key: "maxTokens", label: "fieldMaxTokens", type: "number" },
      { key: "timeoutMs", label: "fieldTimeoutMs", type: "number" },
      { key: "maxImageBytes", label: "fieldMaxImageBytes", type: "number" },
      { key: "bridgeTextOnly", label: "fieldBridgeTextOnly", type: "checkbox" },
      { key: "bridgeExportDir", label: "fieldBridgeExportDir", type: "text" },
      { key: "multimodalModels", label: "fieldMultimodalModels", type: "csv" },
      { key: "bridgePreview", label: "fieldBridgePreview", type: "checkbox" },
      { key: "bridgePreviewScanIntervalMs", label: "fieldBridgePreviewScanIntervalMs", type: "number" },
      { key: "bridgePreviewHideHint", label: "fieldBridgePreviewHideHint", type: "checkbox" },
      { key: "bridgeAutoImage", label: "fieldBridgeAutoImage", type: "checkbox" },
      { key: "desktopScreenshot", label: "fieldDesktopScreenshot", type: "checkbox" },
      { key: "sendSessionHeader", label: "fieldSendSessionHeader", type: "checkbox" },
      { key: "sessionHeaderName", label: "fieldSessionHeaderName", type: "text" },
      { key: "sessionId", label: "fieldSessionId", type: "text" }
    ];
    var ZH_HINTS = {
      apiKey: "apiKeyHint",
      maxTokens: "maxTokens",
      timeoutMs: "timeoutMs",
      maxImageBytes: "maxImageBytes",
      bridgeTextOnly: "bridgeTextOnly",
      bridgeExportDir: "bridgeExportDir",
      multimodalModels: "multimodalModels",
      bridgePreview: "hintBridgePreview",
      bridgePreviewScanIntervalMs: "hintBridgePreviewScanIntervalMs",
      bridgePreviewHideHint: "hintBridgePreviewHideHint",
      bridgeAutoImage: "hintBridgeAutoImage",
      desktopScreenshot: "hintDesktopScreenshot"
    };

    function labelOf(f, t) {
      return t(f.label);
    }

    // ── component ─────────────────────────────────────────────────────────
    function VisionSection(props) {
      var t = props.t;
      var scope = props.scope;
      var [snapshot, setSnapshot] = react.useState(function () { return scope.getSnapshot(); });
      var ready = snapshot.status === "ready" && snapshot.value !== void 0;
      var [draft, setDraft] = react.useState({});
      var [busy, setBusy] = react.useState(false);
      var [notice, setNotice] = react.useState(null);
      var [error, setError] = react.useState(null);

      react.useEffect(function () {
        if (typeof scope.load === "function") scope.load();
        var alive = true;
        var sync = function () { if (alive) setSnapshot(scope.getSnapshot()); };
        var un = typeof scope.subscribe === "function" ? scope.subscribe(sync) : null;
        // The settings scope is bound once for this plugin (apply) and shared
        // across every mount of this section. Unmounting the section must only
        // unsubscribe — never dispose the scope, or a later remount would find
        // a `disposed` scope whose write queue no-ops, silently dropping saves
        // (the value then reverts on the next describe).
        return function () { alive = false; if (un) un(); };
      }, [scope]);
      // Seed the draft ONLY when the snapshot becomes ready — never on value
      // churn. settingsScope.getSnapshot() returns a fresh object per call,
      // so depending on snapshot.value would reset user input on every render
      // (typing appears dead).
      react.useEffect(function () {
        if (ready) setDraft(function (prev) { return Object.assign({}, prev, valueToDraft(snapshot.value)); });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [ready]);

      if (snapshot.status === "unavailable") {
        return h("p", { className: "__tv_unavailable" }, t("unavailable"));
      }
      if (!ready) return h("p", { className: "__tv_status" }, t("loading"));

      var value = snapshot.value;
      var user = snapshot.user || {};

      function fieldDraft(f) {
        if (f.type === "csv") return draft[f.key] !== void 0 ? draft[f.key] : draftToCsv(value[f.key]);
        if (f.type === "checkbox") return draft[f.key] !== void 0 ? draft[f.key] : Boolean(value[f.key]);
        return draft[f.key] !== void 0 ? draft[f.key] : String(value[f.key] ?? "");
      }
      function setField(f, v) {
        setDraft(function (prev) {
          var next = Object.assign({}, prev);
          next[f.key] = v;
          return next;
        });
        setNotice(null);
        setError(null);
      }

      // One atomic mutation carrying ONE revision fence.
      //
      // The fields used to be issued as parallel scope.set()/unset() calls. Every
      // write is queued and re-reads the namespace revision, but a write whose
      // fence is behind the Host document is REFUSED with settings/conflict — and
      // a refused write still resolves (the scope's contract is "settle after any
      // recovery read", not "throw on refusal"). The section therefore reported
      // "Saved" while the edits silently reverted. Batching every change into a
      // single mutate() gives it one fence and one persistence decision.
      function buildOps() {
        var ops = [];
        FIELDS.forEach(function (f) {
          var d = fieldDraft(f);
          if (f.type === "csv") {
            var arr = String(d).split(",").map(function (s) { return s.trim(); }).filter(Boolean);
            var cur = value[f.key] || [];
            if (arr.length === cur.length && arr.every(function (x, i) { return x === cur[i]; })) return;
            ops.push({ op: "set", path: [f.key], value: arr });
            return;
          }
          if (f.type === "checkbox") {
            if (Boolean(d) === Boolean(value[f.key])) return;
            ops.push(Boolean(d) ? { op: "set", path: [f.key], value: true }
                                : { op: "unset", path: [f.key] });
            return;
          }
          if (f.type === "password") {
            if (!d) return; // blank keeps the current key
            if (d === String(value[f.key] ?? "")) return;
            ops.push({ op: "set", path: [f.key], value: d });
            return;
          }
          if (String(d) === String(value[f.key] ?? "")) return;
          if (String(d).trim() === "" && !(f.key in user)) return;
          ops.push(String(d).trim() === ""
            ? { op: "unset", path: [f.key] }
            : { op: "set", path: [f.key], value: f.type === "number" ? Number(d) : d });
        });
        return ops;
      }

      /** Whether the namespace section now reflects every queued operation. */
      function opsApplied(ops, snap) {
        if (snap.status !== "ready" || snap.value === void 0) return false;
        return ops.every(function (op) {
          var key = op.path[0];
          if (op.op === "unset") return !(snap.user && key in snap.user);
          return JSON.stringify(snap.value[key]) === JSON.stringify(op.value);
        });
      }

      /**
       * Settle one namespace change and report what actually happened.
       *
       * Reads settle after the write and any recovery read, so the section is
       * inspected afterwards instead of trusting the promise: that check is the
       * only way to tell a committed change from a refused one. Hosts without
       * mutate() apply the same ops in order — each waits for its predecessor, so
       * the revision chain still holds.
       */
      function commit(ops) {
        var run;
        if (typeof scope.mutate === "function") {
          run = scope.mutate(ops, scope.getSnapshot().revision);
        } else {
          run = ops.reduce(function (chain, op) {
            return chain.then(function () {
              return op.op === "unset" ? scope.unset(op.path[0]) : scope.set(op.path[0], op.value);
            });
          }, Promise.resolve());
        }
        return Promise.resolve(run).then(function () {
          return opsApplied(ops, scope.getSnapshot());
        });
      }

      function reportOutcome(ok, okMessage) {
        setBusy(false);
        if (ok) {
          setNotice(okMessage || t("saved"));
          return;
        }
        setError(t("error") + "：" + t("notApplied"));
        reseedDraft();
      }

      function onSave() {
        setBusy(true); setNotice(null); setError(null);
        var ops = buildOps();
        if (ops.length === 0) { setBusy(false); setNotice(t("saved")); return; }
        commit(ops).then(function (ok) {
          reportOutcome(ok);
        }).catch(function (e) {
          setBusy(false); setError(t("error") + "：" + String(e && e.message || e));
        });
      }

      // One-click master switch: the same field the checkbox edits, written on its
      // own so taking the plugin offline never depends on the rest of the form.
      function onToggleEnabled() {
        setBusy(true); setNotice(null); setError(null);
        var next = value.enabled === false;
        commit([{ op: "set", path: ["enabled"], value: next }]).then(function (ok) {
          reportOutcome(ok, next ? t("enabledNotice") : t("disabledNotice"));
        }).catch(function (e) {
          setBusy(false); setError(t("error") + "：" + String(e && e.message || e));
        });
      }

      function reseedDraft() {
        if (typeof scope.load === "function") {
          var p = scope.load();
          if (p && typeof p.then === "function") {
            p.then(function () {
              var fresh = scope.getSnapshot();
              if (fresh.status === "ready" && fresh.value !== void 0) setDraft(Object.assign({}, valueToDraft(fresh.value)));
            }).catch(function () {});
            return;
          }
        }
        setTimeout(function () {
          var fresh = scope.getSnapshot();
          if (fresh.status === "ready" && fresh.value !== void 0) setDraft(Object.assign({}, valueToDraft(fresh.value)));
        }, 120);
      }

      function onReset() {
        setBusy(true); setNotice(null); setError(null);
        var ops = FIELDS
          .filter(function (f) { return f.key in user; })
          .map(function (f) { return { op: "unset", path: [f.key] }; });
        if (ops.length === 0) { setBusy(false); setNotice(t("saved")); return; }
        commit(ops).then(function (ok) {
          reportOutcome(ok);
        }).catch(function (e) {
          setBusy(false); setError(t("error") + "：" + String(e && e.message || e));
        });
      }

      return h("div", { className: "__tv_root" },
        h("p", { className: "__tv_hint", style: { margin: "0 0 4px" } }, t("intro")),
        h("div", { className: "__tv_master" },
          h("span", { className: "__tv_masterLabel" },
            t("masterSwitch") + (value.enabled === false ? "：" + t("disabledNotice") : "")),
          h("button", {
            type: "button",
            className: "__tv_btn " + (value.enabled === false ? "__tv_btnPrimary" : "__tv_btnDanger"),
            onClick: onToggleEnabled,
            disabled: busy || !snapshot.writable
          }, value.enabled === false ? t("turnOn") : t("turnOff"))),
        FIELDS.map(function (f) {
          var overridden = f.key in user;
          if (f.type === "checkbox") {
            return h("label", { key: f.key, className: "__tv_field" },
              h("span", { className: "__tv_row" },
                h("input", { className: "__tv_check", type: "checkbox", checked: Boolean(fieldDraft(f)), onChange: function (e) { setField(f, e.target.checked); } }),
                h("span", { className: "__tv_label" }, labelOf(f, t)),
                overridden ? h("span", { className: "__tv_override" }, t("overridden")) : null
              ),
              f.key in ZH_HINTS ? h("span", { className: "__tv_hint" }, t(ZH_HINTS[f.key])) : null
            );
          }
          return h("label", { key: f.key, className: "__tv_field" },
            h("span", { className: "__tv_label" },
              labelOf(f, t),
              overridden ? h("span", { className: "__tv_override" }, t("overridden")) : null
            ),
            h("input", {
              className: "__tv_input",
              type: f.type === "password" ? "password" : f.type === "number" ? "number" : "text",
              value: fieldDraft(f),
              placeholder: f.type === "password" ? (overridden ? "••••••••" : t("apiKeyHint")) : (f.placeholder || ""),
              onChange: function (e) { setField(f, e.target.value); }
            }),
            f.key in ZH_HINTS ? h("span", { className: "__tv_hint" }, t(ZH_HINTS[f.key])) : null
          );
        }),
        h("div", { className: "__tv_actions" },
          h("button", { type: "button", className: "__tv_btn __tv_btnPrimary", onClick: onSave, disabled: busy || !snapshot.writable }, t("save")),
          h("button", { type: "button", className: "__tv_btn", onClick: onReset, disabled: busy || !snapshot.writable }, t("reset")),
          notice ? h("span", { className: "__tv_status" }, notice) : null,
          busy ? h("span", { className: "__tv_status" }, t("saving")) : null,
          error ? h("span", { className: "__tv_error" }, error) : null
        )
      );
    }

    function valueToDraft(value) {
      var out = {};
      for (var i = 0; i < FIELDS.length; i += 1) {
        var f = FIELDS[i];
        out[f.key] = f.type === "csv" ? draftToCsv(value[f.key]) : f.type === "checkbox" ? Boolean(value[f.key]) : String(value[f.key] ?? "");
      }
      return out;
    }
    function draftToCsv(arr) {
      return Array.isArray(arr) ? arr.join(", ") : String(arr ?? "");
    }

    // ── bridge image preview (v0.4.0, xing666173 / dsh-bridge-preview) ────
    var PREVIEW_MARK = "\u200b[bridge]";
    var PREVIEW_ATTR = "data-tv-preview";
    var PREVIEW_ROUTE = "/plugins/dsh-tool-vision/image";
    var PREVIEW_PATH_RE = /exported to:\s*("[^"]+"|'[^']+'|[A-Za-z]:[\\/][^\s\]]+?\.(?:png|jpe?g|webp|gif|avif|bmp))/gi;
    // 完整桥接提示段(从 \u200b[bridge] 到 see its content.]),用于精准剔除桥接文本、
    // 保留用户自己的文字(dsh 会把用户消息的多段文本合并渲染到同一容器)。
    var PREVIEW_TEXT_RE = /\u200b\[bridge\]\[User sent an image[\s\S]*?see its content\.\]/g;

    function previewConfigOf(scope) {
      var cfg = { enabled: true, intervalMs: 2000, hideHint: true };
      try {
        var snap = scope.getSnapshot();
        if (snap.status === "ready" && snap.value) {
          cfg.enabled = snap.value.bridgePreview !== false;
          var iv = Number(snap.value.bridgePreviewScanIntervalMs);
          cfg.intervalMs = Number.isFinite(iv) && iv > 0 ? iv : 0;
          cfg.hideHint = snap.value.bridgePreviewHideHint !== false;
        }
      } catch (e) { /* keep defaults */ }
      return cfg;
    }

    function previewPathOf(data) {
      var m;
      PREVIEW_PATH_RE.lastIndex = 0;
      while ((m = PREVIEW_PATH_RE.exec(data)) !== null) {
        var s = m[1];
        if (s.length >= 2) {
          var first = s[0];
          var last = s[s.length - 1];
          if ((first === '"' && last === '"') || (first === "'" && last === "'")) s = s.slice(1, -1);
        }
        return s;
      }
      return null;
    }

    function openLightbox(src, alt) {
      var overlay = document.createElement("div");
      overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.82);display:flex;align-items:center;justify-content:center;z-index:2147483000;cursor:zoom-out;";
      var big = document.createElement("img");
      big.src = src;
      big.alt = alt || "图片预览";
      big.style.cssText = "max-width:92vw;max-height:92vh;object-fit:contain;border-radius:4px;box-shadow:0 8px 40px rgba(0,0,0,0.5);";
      var close = function () {
        overlay.remove();
        document.removeEventListener("keydown", onKey, true);
      };
      var onKey = function (e) {
        if (e.key === "Escape") close();
      };
      big.addEventListener("error", close);
      overlay.addEventListener("click", close);
      overlay.appendChild(big);
      document.body.appendChild(overlay);
      document.addEventListener("keydown", onKey, true);
    }

    function attachBridgePreview(ctx, scope) {
      var cfg = previewConfigOf(scope);
      var pendingTimer = null;
      var intervalTimer = null;
      var observer = null;

      function processTextNode(node) {
        var data = node.data;
        if (typeof data !== "string" || data.indexOf(PREVIEW_MARK) === -1) return;
        var block = node.parentElement;
        if (!block || block.hasAttribute(PREVIEW_ATTR)) return;
        var path = previewPathOf(data);
        if (!path) return;
        // 只插到消息行内的文本容器;绝不插进列表/body(拖图消息形态的防御)
        var container = block.parentElement;
        if (!container || container === document.body || container.childElementCount > 3) return;
        block.setAttribute(PREVIEW_ATTR, "1");
        var img = document.createElement("img");
        img.setAttribute(PREVIEW_ATTR, "1");
        img.src = PREVIEW_ROUTE + "?p=" + encodeURIComponent(path);
        img.alt = "图片预览";
        img.style.cssText = "display:block;margin-left:auto;margin-right:0;max-width:min(360px,100%);max-height:420px;border-radius:8px;margin-top:4px;margin-bottom:6px;object-fit:contain;cursor:zoom-in;";
        img.addEventListener("click", function () { openLightbox(img.src, img.alt); });
        img.addEventListener("load", function () {
          // P2:图片加载成功后隐藏桥接提示文本;失败时保留(安全降级)。
          // 不能直接隐藏整块:dsh 把用户消息的多段文本 join 后渲染到同一容器,
          // 隐藏整块会把用户自己打的字(如"测试")一起藏掉。这里先精准剔除
          // 桥接文本段,仅当容器已无其他内容时才隐藏整个容器。
          if (cfg.hideHint) {
            var cleaned = node.data ? node.data.replace(PREVIEW_TEXT_RE, "") : "";
            if (cleaned !== node.data) node.data = cleaned;
            if ((block.textContent || "").replace(/\s/g, "") === "") block.style.display = "none";
          }
        });
        img.addEventListener("error", function () {
          img.remove(); // 静默降级;块标记保留,避免无限重试
        });
        container.insertBefore(img, block);
      }

      function scan() {
        if (!cfg.enabled) return;
        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
          acceptNode: function (node) {
            if (!node.data || node.data.indexOf(PREVIEW_MARK) === -1) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          }
        });
        var nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        for (var i = 0; i < nodes.length; i++) processTextNode(nodes[i]);
      }

      function armInterval() {
        if (intervalTimer !== null) { clearInterval(intervalTimer); intervalTimer = null; }
        if (cfg.intervalMs > 0) intervalTimer = setInterval(scan, cfg.intervalMs);
      }

      ctx.effect(function () {
        scan();
        observer = new MutationObserver(function (records) {
          // 忽略本插件自己插入的图片节点,避免自我触发
          for (var i = 0; i < records.length; i++) {
            var t = records[i].target;
            if (t && t.nodeType === 1 && t.hasAttribute && t.hasAttribute(PREVIEW_ATTR)) continue;
            if (pendingTimer !== null) return;
            pendingTimer = setTimeout(function () {
              pendingTimer = null;
              scan();
            }, 300);
            break;
          }
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        armInterval();
        var un = typeof scope.subscribe === "function" ? scope.subscribe(function () {
          cfg = previewConfigOf(scope);
          armInterval();
        }) : null;
        return function () {
          if (observer) observer.disconnect();
          if (pendingTimer !== null) { clearTimeout(pendingTimer); pendingTimer = null; }
          if (intervalTimer !== null) { clearInterval(intervalTimer); intervalTimer = null; }
          if (un) un();
        };
      }, "dsh-tool-vision: bridge preview scanner");
    }

    // ── plugin ────────────────────────────────────────────────────────────
    function apply(ctx) {
      var t = ctx.locale.bind(NS);
      ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "dsh-tool-vision: dictionaries");
      var scope = ctx.settingsScope.bind({ namespace: "tool-vision" });
      if (typeof scope.load === "function") scope.load();
      attachBridgePreview(ctx, scope);
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section",
          id: "tool-vision",
          order: 25,
          label: function () { return t("nav"); },
          locale: NS
        }, function (props) {
          return h(VisionSection, Object.assign({}, props, { scope: scope }));
        });
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});

