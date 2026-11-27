/**
 * 猪齿鱼面板的 Client 半区：左侧图标 + 主面板（模型接入 / 任务看板）。
 * 网络与密钥处理都在 Host（index.js），这里只做展示与按钮。
 */
window.__ModuleLoader__.load({
  id: 'dsh-choerodon',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /*
     * 配色自己给全：深浅两套值都写死，靠 body[data-ds-dark-theme] 切换。
     *
     * 早先直接引用 --dsw-alias-* 宿主令牌，踩过两个坑：
     *   1. 其中 --dsw-alias-bg-primary 根本不存在（只有 bg-base / bg-layer-1..3 / bg-overlay），
     *      而 CSS 变量未定义时整条声明失效，兜底值也不会生效 —— 深色下按钮就成了透明块；
     *   2. 壁纸类插件会用 !important 把宿主令牌改写成半透明，卡片跟着一起透。
     * 自己持有颜色就不受这两件事影响，也不会与宿主主题互相干扰。
     */
    const TOKEN = {
      text: 'var(--c7n-text)',
      muted: 'var(--c7n-muted)',
      line: 'var(--c7n-line)',
      lineStrong: 'var(--c7n-line-strong)',
      surface: 'var(--c7n-surface)',
      surface2: 'var(--c7n-surface-2)',
      base: 'var(--c7n-base)',
      overlay: 'var(--c7n-overlay)',
      accent: 'var(--c7n-accent)',
      danger: 'var(--c7n-danger)',
      success: 'var(--c7n-success)',
      warn: 'var(--c7n-warn)',
      idle: 'var(--c7n-idle)',
    }

    /**
     * 样式表。内联 style 表达不了 :hover / :active / :focus-visible 与过渡，
     * 插件原来因此所有按钮都是一张死板的平面图；这里换成类名 + 一张表。
     * 变量前缀统一 c7n-，避免和宿主或别的插件撞车。
     */
    const STYLE_TEXT = `
      /* ---------- 主题变量：浅色默认，深色跟随 body[data-ds-dark-theme] ---------- */
      .c7n-root, .c7n-modal, .c7n-popover {
        --c7n-text: #1f2329;
        --c7n-muted: #646a73;
        --c7n-line: rgba(31, 35, 41, .12);
        --c7n-line-strong: rgba(31, 35, 41, .24);
        --c7n-surface: #ffffff;
        --c7n-surface-2: #f7f8fa;
        --c7n-base: #f5f6f7;
        --c7n-overlay: #ffffff;
        --c7n-accent: #2f6fed;
        --c7n-danger: #d92d20;
        --c7n-success: #12a150;
        --c7n-warn: #d97917;
        --c7n-idle: #8a919f;
        --c7n-shadow: 0 12px 34px rgba(15, 23, 42, .14), 0 2px 6px rgba(15, 23, 42, .06);
        color-scheme: light;
      }
      body[data-ds-dark-theme] .c7n-root,
      body[data-ds-dark-theme] .c7n-modal,
      body[data-ds-dark-theme] .c7n-popover {
        --c7n-text: #e8ebf0;
        --c7n-muted: #9aa3b2;
        --c7n-line: rgba(255, 255, 255, .14);
        --c7n-line-strong: rgba(255, 255, 255, .26);
        --c7n-surface: #24272e;
        --c7n-surface-2: #1b1e24;
        --c7n-base: #14161a;
        --c7n-overlay: #24272e;
        --c7n-accent: #5b9bff;
        --c7n-danger: #ff7a70;
        --c7n-success: #4ec98a;
        --c7n-warn: #f0b45f;
        --c7n-idle: #7d8694;
        --c7n-shadow: 0 12px 34px rgba(0, 0, 0, .55), 0 2px 6px rgba(0, 0, 0, .35);
        color-scheme: dark;
      }

      .c7n-root, .c7n-root * { box-sizing: border-box; }
      .c7n-root {
        --c7n-r-sm: 6px; --c7n-r-md: 8px; --c7n-r-lg: 12px;
        --c7n-hover: color-mix(in srgb, var(--c7n-text) 7%, transparent);
        --c7n-active: color-mix(in srgb, var(--c7n-text) 12%, transparent);
        color: var(--c7n-text);
        font-size: 13px;
        -webkit-font-smoothing: antialiased;
      }

      /* ---------- 按钮 ---------- */
      .c7n-btn {
        display: inline-flex; align-items: center; justify-content: center; gap: 6px;
        height: 30px; padding: 0 12px;
        border: 1px solid var(--c7n-line);
        border-radius: var(--c7n-r-md);
        background: var(--c7n-surface);
        color: var(--c7n-text);
        font: inherit; font-size: 13px; line-height: 1;
        cursor: pointer; white-space: nowrap;
        transition: background 120ms ease, border-color 120ms ease, box-shadow 120ms ease, transform 60ms ease;
      }
      .c7n-btn:hover:not(:disabled) {
        background: color-mix(in srgb, var(--c7n-text) 5%, var(--c7n-surface));
        border-color: var(--c7n-line-strong);
      }
      .c7n-btn:active:not(:disabled) { transform: translateY(.5px); background: var(--c7n-active); }
      .c7n-btn:focus-visible {
        outline: none;
        border-color: var(--c7n-accent);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--c7n-accent) 22%, transparent);
      }
      .c7n-btn:disabled { opacity: .45; cursor: not-allowed; }
      label.c7n-btn {
        display: inline-flex; align-items: center; justify-content: center; gap: 5px;
        border-radius: var(--c7n-r-sm); border: 1px solid var(--c7n-line);
        background: var(--c7n-surface); color: var(--c7n-text);
        font-weight: 500; white-space: nowrap; user-select: none;
        transition: background 120ms ease, border-color 120ms ease;
      }
      label.c7n-btn:hover { border-color: var(--c7n-line-strong); background: var(--c7n-surface-2); }
      .c7n-btn--off { opacity: .55; pointer-events: none; }
      .c7n-btn--sm { height: 26px; padding: 0 9px; font-size: 12px; border-radius: var(--c7n-r-sm); }
      .c7n-btn--primary {
        background: var(--c7n-accent);
        border-color: transparent; color: #fff; font-weight: 500;
      }
      .c7n-btn--primary:hover:not(:disabled) {
        background: color-mix(in srgb, var(--c7n-accent) 88%, #000);
        border-color: transparent;
      }
      .c7n-btn--primary:active:not(:disabled) {
        background: color-mix(in srgb, var(--c7n-accent) 78%, #000);
      }
      .c7n-btn--ghost { background: transparent; border-color: transparent; }
      .c7n-btn--ghost:hover:not(:disabled) { background: var(--c7n-hover); border-color: transparent; }
      .c7n-btn--danger { color: var(--c7n-danger); }
      .c7n-btn--danger:hover:not(:disabled) {
        background: color-mix(in srgb, var(--c7n-danger) 10%, transparent);
        border-color: color-mix(in srgb, var(--c7n-danger) 40%, transparent);
      }
      .c7n-btn--icon { width: 30px; padding: 0; }

      /* ---------- 表单控件 ---------- */
      .c7n-input, .c7n-select, .c7n-textarea {
        width: 100%; height: 30px; padding: 0 10px;
        border: 1px solid var(--c7n-line);
        border-radius: var(--c7n-r-md);
        background: var(--c7n-surface);
        color: var(--c7n-text);
        font: inherit; font-size: 13px;
        transition: border-color 120ms ease, box-shadow 120ms ease;
        outline: none;
      }
      .c7n-textarea { height: auto; padding: 8px 10px; line-height: 1.65; resize: vertical; }
      .c7n-input::placeholder, .c7n-textarea::placeholder { color: var(--c7n-muted); }
      .c7n-input:hover, .c7n-select:hover, .c7n-textarea:hover {
        border-color: var(--c7n-line-strong);
      }
      .c7n-input:focus, .c7n-select:focus, .c7n-textarea:focus {
        border-color: var(--c7n-accent);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--c7n-accent) 18%, transparent);
      }
      .c7n-select { appearance: none; padding-right: 26px; cursor: pointer; }
      .c7n-select-wrap { position: relative; }
      .c7n-select-wrap::after {
        content: ''; position: absolute; right: 10px; top: 50%;
        width: 6px; height: 6px; margin-top: -4px;
        border-right: 1.5px solid var(--c7n-muted);
        border-bottom: 1.5px solid var(--c7n-muted);
        transform: rotate(45deg); pointer-events: none;
      }

      /* ---------- 分段控件 / 标签 ---------- */
      .c7n-seg {
        display: inline-flex; padding: 2px; gap: 2px;
        background: var(--c7n-hover); border-radius: var(--c7n-r-md);
      }
      .c7n-seg-item {
        height: 26px; padding: 0 12px; border: none; border-radius: 6px;
        background: transparent; color: var(--c7n-muted);
        font: inherit; font-size: 12px; cursor: pointer;
        transition: background 120ms ease, color 120ms ease;
      }
      .c7n-seg-item:hover { color: var(--c7n-text); }
      .c7n-seg-item--on {
        background: var(--c7n-surface);
        color: var(--c7n-text);
        font-weight: 500;
        box-shadow: 0 1px 2px rgba(31,35,41,.10);
      }
      .c7n-chip {
        display: inline-flex; align-items: center; gap: 5px;
        height: 22px; padding: 0 9px; border-radius: 999px;
        border: 1px solid var(--c7n-line);
        background: transparent; color: var(--c7n-muted);
        font: inherit; font-size: 12px; cursor: pointer;
        transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
      }
      .c7n-chip:hover {
        background: var(--c7n-hover);
        border-color: var(--c7n-line-strong);
        color: var(--c7n-text);
      }
      .c7n-chip--on {
        border-color: var(--c7n-accent);
        background: color-mix(in srgb, var(--c7n-accent) 12%, transparent);
        color: var(--c7n-accent); font-weight: 500;
      }
      .c7n-chip:disabled { opacity: .5; cursor: not-allowed; }

      /* ---------- 卡片 ---------- */
      .c7n-card {
        display: block; width: 100%; text-align: left;
        padding: 10px 11px; margin-bottom: 7px;
        border: 1px solid var(--c7n-line);
        border-radius: var(--c7n-r-lg);
        background: var(--c7n-surface);
        color: inherit; font: inherit; cursor: pointer;
        transition: border-color 130ms ease, box-shadow 130ms ease, transform 130ms ease;
      }
      .c7n-card:hover {
        border-color: color-mix(in srgb, var(--c7n-accent) 45%, var(--c7n-line));
        box-shadow: 0 4px 14px rgba(31,35,41,.10);
        transform: translateY(-1px);
      }
      .c7n-card:focus-visible {
        outline: none;
        border-color: var(--c7n-accent);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--c7n-accent) 20%, transparent);
      }
      @media (prefers-reduced-motion: reduce) {
        .c7n-card, .c7n-btn, .c7n-chip { transition: none; }
        .c7n-card:hover, .c7n-btn:active { transform: none; }
      }

      /* ---------- 泳道 ---------- */
      .c7n-lane {
        width: 264px; flex: 0 0 264px; display: flex; flex-direction: column;
        min-height: 0; padding: 8px; border-radius: var(--c7n-r-lg);
        background: color-mix(in srgb, var(--c7n-text) 4%, transparent);
      }
      .c7n-lane-head {
        display: flex; align-items: center; gap: 7px;
        padding: 2px 4px 9px; font-size: 12px; font-weight: 600;
      }
      .c7n-dot { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; }
      .c7n-count {
        margin-left: auto; min-width: 20px; height: 18px; padding: 0 6px;
        display: inline-flex; align-items: center; justify-content: center;
        border-radius: 999px; background: var(--c7n-hover);
        color: var(--c7n-muted);
        font-size: 11px; font-weight: 500;
      }

      /* ---------- 抽屉 ---------- */
      .c7n-drawer {
        display: flex; flex-direction: column; min-height: 0;
        width: 460px; flex: 0 0 460px;
        margin-left: 12px;
        border: 1px solid var(--c7n-line);
        border-radius: var(--c7n-r-lg);
        background: var(--c7n-surface);
        overflow: hidden;
      }
      .c7n-drawer-head {
        padding: 12px 16px 0;
        border-bottom: 1px solid var(--c7n-line);
      }
      .c7n-drawer-body { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 16px 18px; }
      .c7n-drawer-body::-webkit-scrollbar { width: 8px; }
      .c7n-drawer-body::-webkit-scrollbar-thumb {
        background: color-mix(in srgb, var(--c7n-text) 18%, transparent);
        border-radius: 4px;
      }

      /* ---------- 页签 ---------- */
      .c7n-tabs { display: flex; gap: 2px; position: relative; }
      .c7n-tab {
        position: relative; height: 34px; padding: 0 11px;
        border: none; background: transparent;
        color: var(--c7n-muted);
        font: inherit; font-size: 13px; cursor: pointer;
        transition: color 120ms ease;
      }
      .c7n-tab:hover { color: var(--c7n-text); }
      .c7n-tab--on { color: var(--c7n-text); font-weight: 600; }
      .c7n-tab--on::after {
        content: ''; position: absolute; left: 8px; right: 8px; bottom: -1px;
        height: 2px; border-radius: 2px;
        background: var(--c7n-accent);
      }
      .c7n-tab-badge {
        margin-left: 5px; padding: 0 5px; height: 15px; line-height: 15px;
        border-radius: 999px; font-size: 10px; font-weight: 600;
        background: var(--c7n-hover); color: var(--c7n-muted);
      }

      /* ---------- 结构辅助 ---------- */
      .c7n-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .c7n-field-label {
        display: block; margin-bottom: 5px;
        color: var(--c7n-muted); font-size: 12px;
      }
      .c7n-meta { color: var(--c7n-muted); font-size: 12px; }
      .c7n-kv {
        display: grid; grid-template-columns: 76px 1fr; gap: 6px 10px;
        font-size: 12px; line-height: 1.6;
      }
      .c7n-kv > dt { color: var(--c7n-muted); margin: 0; }
      .c7n-kv > dd { margin: 0; word-break: break-word; }
      .c7n-section {
        margin-top: 18px; padding-top: 14px;
        border-top: 1px solid var(--c7n-line);
      }
      .c7n-section-title {
        display: flex; align-items: center; gap: 8px; margin-bottom: 10px;
        font-size: 12px; font-weight: 600;
        color: var(--c7n-muted);
        letter-spacing: .02em;
      }
      .c7n-panel-box {
        padding: 12px; border-radius: var(--c7n-r-md);
        border: 1px solid var(--c7n-line);
        background: var(--c7n-surface-2);
      }
      .c7n-empty {
        padding: 22px 12px; text-align: center;
        color: var(--c7n-muted); font-size: 12px;
      }
      .c7n-skeleton {
        height: 44px; margin-bottom: 7px; border-radius: var(--c7n-r-lg);
        background: linear-gradient(90deg,
          color-mix(in srgb, var(--c7n-text) 5%, transparent) 25%,
          color-mix(in srgb, var(--c7n-text) 9%, transparent) 37%,
          color-mix(in srgb, var(--c7n-text) 5%, transparent) 63%);
        background-size: 400% 100%;
        animation: c7n-shimmer 1.4s ease infinite;
      }
      @keyframes c7n-shimmer { 0% { background-position: 100% 50% } 100% { background-position: 0 50% } }
      @media (prefers-reduced-motion: reduce) { .c7n-skeleton { animation: none; } }

      /* ---------- 操作记录时间线 ---------- */
      .c7n-timeline { position: relative; padding-left: 22px; }
      .c7n-timeline::before {
        content: ''; position: absolute; left: 6px; top: 6px; bottom: 6px;
        width: 1px; background: var(--c7n-line);
      }
      .c7n-event { position: relative; padding-bottom: 14px; }
      .c7n-event::before {
        content: ''; position: absolute; left: -19px; top: 4px;
        width: 7px; height: 7px; border-radius: 50%;
        background: var(--c7n-surface);
        border: 1.5px solid var(--c7n-line-strong);
      }
      .c7n-event--hot::before {
        background: var(--c7n-accent);
        border-color: var(--c7n-accent);
      }
      .c7n-event-head {
        display: flex; align-items: baseline; gap: 7px; flex-wrap: wrap;
        margin-bottom: 4px; font-size: 12px;
      }
      .c7n-event-who { font-weight: 600; color: var(--c7n-text); }
      .c7n-event-time { color: var(--c7n-muted); font-size: 11px; }
      .c7n-change {
        display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap;
        padding: 2px 0; font-size: 12px; line-height: 1.6;
      }
      .c7n-change-field {
        flex: 0 0 auto; color: var(--c7n-muted);
      }
      .c7n-change-val {
        padding: 0 6px; border-radius: 5px;
        background: color-mix(in srgb, var(--c7n-text) 6%, transparent);
        max-width: 100%; overflow-wrap: anywhere;
      }
      .c7n-change-val--new {
        background: color-mix(in srgb, var(--c7n-success) 14%, transparent);
        color: color-mix(in srgb, var(--c7n-success) 70%, var(--c7n-text));
      }
      .c7n-arrow { color: var(--c7n-muted); flex: 0 0 auto; }

      /* ---------- 浮层 ---------- */
      .c7n-popover {
        position: absolute; top: calc(100% + 6px); left: 0; z-index: 31;
        padding: 10px; font-size: 12px;
        border-radius: var(--c7n-r-lg);
        border: 1px solid var(--c7n-line);
        background: var(--c7n-overlay);
        box-shadow: var(--c7n-shadow);
        animation: c7n-pop 120ms ease;
      }
      @keyframes c7n-pop {
        from { opacity: 0; transform: translateY(-4px) scale(.985); }
        to { opacity: 1; transform: none; }
      }
      @media (prefers-reduced-motion: reduce) { .c7n-popover { animation: none; } }

      .c7n-modal {
        max-width: 94vw; max-height: 88vh; overflow-y: auto; padding: 20px;
        border-radius: 14px;
        border: 1px solid var(--c7n-line);
        background: var(--c7n-overlay);
        box-shadow: var(--c7n-shadow);
        animation: c7n-modal-in 140ms ease;
      }
      @keyframes c7n-modal-in {
        from { opacity: 0; transform: translateY(8px) scale(.99); }
        to { opacity: 1; transform: none; }
      }
      @media (prefers-reduced-motion: reduce) { .c7n-modal { animation: none; } }

      .c7n-modal-head {
        display: flex; align-items: center; justify-content: space-between;
        gap: 12px; margin-bottom: 16px;
      }
      .c7n-modal-title { font-size: 15px; font-weight: 600; margin: 0; }

      /* ---------- 提示条 / 空态 ---------- */
      .c7n-banner {
        display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
        padding: 9px 12px; margin-bottom: 10px;
        border-radius: var(--c7n-r-md);
        border: 1px solid color-mix(in srgb, var(--c7n-accent) 35%, transparent);
        background: color-mix(in srgb, var(--c7n-accent) 8%, transparent);
        font-size: 13px;
      }
      .c7n-banner--error {
        border-color: color-mix(in srgb, var(--c7n-danger) 35%, transparent);
        background: color-mix(in srgb, var(--c7n-danger) 8%, transparent);
        color: var(--c7n-danger);
      }
      .c7n-banner--ok {
        border-color: color-mix(in srgb, var(--c7n-success) 30%, transparent);
        background: color-mix(in srgb, var(--c7n-success) 8%, transparent);
      }

      .c7n-notice-item {
        display: inline-flex; align-items: baseline; gap: 6px;
        max-width: 100%; padding: 3px 9px;
        border: 1px solid var(--c7n-line); border-radius: 999px;
        background: var(--c7n-surface); color: var(--c7n-text);
        font: inherit; font-size: 12px; line-height: 1.5;
        cursor: pointer; text-align: left;
        transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
      }
      .c7n-notice-item:hover {
        background: var(--c7n-accent); border-color: var(--c7n-accent); color: #fff;
      }
      .c7n-notice-item:focus-visible {
        outline: none; border-color: var(--c7n-accent);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--c7n-accent) 22%, transparent);
      }
      .c7n-notice-summary {
        color: var(--c7n-muted); max-width: 260px;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .c7n-notice-item:hover .c7n-notice-summary { color: rgba(255,255,255,.9); }
      .c7n-rel-group {
        font-size: 11.5px; font-weight: 650; color: var(--c7n-muted);
        margin-bottom: 5px; letter-spacing: .01em;
      }
      .c7n-rel-row {
        display: flex; align-items: center; gap: 8px;
        padding: 6px 10px; border-radius: var(--c7n-r-sm);
        border: 1px solid var(--c7n-line); background: var(--c7n-surface);
        font-size: 12px; line-height: 1.5; color: var(--c7n-text);
      }
      button.c7n-rel-row {
        width: 100%; font: inherit; font-size: 12px; cursor: pointer; text-align: left;
        transition: background 120ms ease, border-color 120ms ease;
      }
      button.c7n-rel-row:hover {
        background: color-mix(in srgb, var(--c7n-accent) 8%, var(--c7n-surface));
        border-color: var(--c7n-accent);
      }
      .c7n-rel-link {
        display: flex; align-items: center; gap: 8px;
        flex: 1; min-width: 0; padding: 0; border: 0; background: none;
        font: inherit; font-size: 12px; color: inherit; cursor: pointer; text-align: left;
      }
      .c7n-rel-link:hover { color: var(--c7n-accent); }
      .c7n-rel-num {
        flex: 0 0 auto; font-weight: 650;
        color: var(--c7n-accent); text-decoration: none;
      }
      .c7n-rel-status {
        flex: 0 0 auto; font-size: 10.5px; padding: 1px 7px;
        border-radius: 999px; background: var(--c7n-surface-2);
        color: var(--c7n-muted); border: 1px solid var(--c7n-line);
      }
      .c7n-rel-type {
        flex: 0 0 auto; max-width: 104px; overflow: hidden;
        font-size: 10.5px; color: var(--c7n-muted);
        text-overflow: ellipsis; white-space: nowrap;
      }
      .c7n-file-row {
        display: flex; align-items: center; gap: 8px;
        padding: 6px 10px; border-radius: var(--c7n-r-sm);
        border: 1px solid var(--c7n-line); background: var(--c7n-surface);
        font-size: 12px;
      }
      .c7n-file-name {
        flex: 1; min-width: 0; overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap;
      }
      .c7n-file-name a { text-decoration: none; }
      .c7n-file-name a:hover { color: var(--c7n-accent); text-decoration: underline; }
      /* 附件名是按钮而不是链接：附件在私有桶里，直链会 403，点它只复制文件名。 */
      .c7n-linkbtn {
        padding: 0; border: 0; background: none; color: inherit;
        font: inherit; cursor: pointer; text-align: left;
        text-decoration: underline; text-decoration-color: transparent;
        transition: color 120ms ease, text-decoration-color 120ms ease;
      }
      .c7n-linkbtn:hover { color: var(--c7n-accent); text-decoration-color: currentColor; }
      .c7n-linkbtn:focus-visible { outline: none; color: var(--c7n-accent); text-decoration-color: currentColor; }
      .c7n-notice-row {
        display: flex; align-items: center; gap: 9px;
        width: 100%; padding: 8px 11px;
        border: 1px solid var(--c7n-line); border-radius: var(--c7n-r-md);
        background: var(--c7n-surface); color: var(--c7n-text);
        font: inherit; font-size: 12.5px; line-height: 1.5;
        cursor: pointer; text-align: left;
        transition: background 120ms ease, border-color 120ms ease;
      }
      .c7n-notice-row:hover {
        background: color-mix(in srgb, var(--c7n-accent) 10%, var(--c7n-surface));
        border-color: var(--c7n-accent);
      }
      .c7n-notice-row:focus-visible {
        outline: none; border-color: var(--c7n-accent);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--c7n-accent) 22%, transparent);
      }
      .c7n-page-title { font-size: 19px; font-weight: 650; margin: 0 0 3px; letter-spacing: -.01em; }
      .c7n-page-sub { margin: 0 0 16px; color: var(--c7n-muted); font-size: 13px; }
      .c7n-toolbar {
        display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
        padding-bottom: 12px; margin-bottom: 12px;
        border-bottom: 1px solid var(--c7n-line);
      }
      /* ---------- 会话头右上角的「本次工作项」入口 ---------- */
      .c7n-brief-chip {
        display: inline-flex; align-items: center; gap: 6px;
        height: 26px; padding: 0 9px; margin: 0;
        border: 1px solid var(--c7n-line); border-radius: 7px;
        background: var(--c7n-surface); color: var(--c7n-text);
        font: inherit; font-size: 11.5px; font-weight: 600;
        cursor: pointer; white-space: nowrap;
        transition: border-color 120ms ease, color 120ms ease, background 120ms ease;
      }
      .c7n-brief-chip:hover { border-color: var(--c7n-accent); color: var(--c7n-accent); }
      .c7n-brief-chip:focus-visible { outline: none; border-color: var(--c7n-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--c7n-accent) 20%, transparent); }
      .c7n-brief-dot {
        width: 5px; height: 5px; border-radius: 50%;
        background: var(--c7n-accent); flex: 0 0 auto;
      }
      .c7n-brief-chip-num { overflow: hidden; text-overflow: ellipsis; max-width: 130px; }
      .c7n-brief-backdrop { position: fixed; inset: 0; z-index: 60; }
      .c7n-brief-pop {
        position: fixed; top: 56px; right: 18px; z-index: 61;
        display: flex; flex-direction: column;
        width: min(560px, calc(100vw - 36px));
        max-height: min(62vh, 540px);
        border: 1px solid var(--c7n-line-strong); border-radius: 10px;
        background: var(--c7n-surface); color: var(--c7n-text);
        box-shadow: var(--c7n-shadow); overflow: hidden;
      }
      .c7n-brief-pop-head {
        display: flex; align-items: center; gap: 8px;
        padding: 10px 12px; border-bottom: 1px solid var(--c7n-line);
        background: var(--c7n-surface-2);
      }
      .c7n-brief-pop-title {
        flex: 1 1 auto; min-width: 0; font-size: 12.5px; font-weight: 650;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .c7n-brief-action {
        flex: 0 0 auto;
        border: 1px solid var(--c7n-line); border-radius: 6px;
        background: var(--c7n-surface); color: var(--c7n-muted);
        font: inherit; font-size: 11.5px; padding: 2px 8px;
        cursor: pointer; transition: color 120ms ease, border-color 120ms ease;
      }
      .c7n-brief-action:hover { color: var(--c7n-accent); border-color: var(--c7n-accent); }
      .c7n-brief-action:focus-visible { outline: none; border-color: var(--c7n-accent); }
      .c7n-brief-pop-body {
        flex: 1 1 auto; min-height: 0;
        margin: 0; padding: 12px 14px; overflow: auto;
        color: var(--c7n-text);
        font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
        font-size: 11.5px; line-height: 1.65;
        white-space: pre-wrap; word-break: break-word;
      }
    `

    /** 把手写规则塞进 document.head；apply 卸载时一起收回。 */
    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      const element = document.createElement('style')
      element.setAttribute('data-plugin', 'dsh-choerodon')
      element.textContent = STYLE_TEXT
      document.head.appendChild(element)
      return () => element.remove()
    }


    // 由 apply(ctx) 注入，用于创建完直接跳到会话。
    let clientCtx = null

    /**
     * 侧栏角标的状态源：轮询在 apply 里起，组件只订阅。
     * 放模块级是因为角标挂在 sidebar 行的 slot 上，和面板不在同一棵 React 树里。
     */
    const badgeStore = {
      value: { count: 0, items: [], unread: 0, at: 0, error: '' },
      listeners: new Set(),
      get() {
        return this.value
      },
      set(next) {
        this.value = next
        for (const listener of this.listeners) listener(next)
      },
      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
    }

    /** 轮询一次角标：新任务数 + 站内消息未读数。登录前会静默失败，不打扰。 */
    let polling = false
    async function pollBadge() {
      // 基线重建要扫好几页，别让上一轮还没回来就叠一轮新的。
      if (polling) return
      polling = true
      try {
        const data = await api('/notifications')
        badgeStore.set({
          count: Number(data?.newTasks?.count ?? 0),
          items: Array.isArray(data?.newTasks?.items) ? data.newTasks.items : [],
          unread: Number(data?.unread ?? 0),
          at: Date.now(),
          error: data?.taskError ? String(data.taskError) : '',
          // 状态机刚补全：看板要重拉一次，泳道才齐。
          statusCompleted: data?.statusCompleted === true,
        })
      } catch (failure) {
        badgeStore.set({ ...badgeStore.get(), error: failure.message, at: Date.now() })
      } finally {
        polling = false
      }
    }

    /** 角标：有新任务时在侧栏「猪齿鱼」行尾显示 (n)，收起态显示成小圆点。 */
    function TaskBadge({ wide }) {
      const [state, setState] = useState(badgeStore.get())
      useEffect(() => badgeStore.subscribe(setState), [])
      if (!state.count) return null
      // 行尾内容会成为整行的可访问描述，所以数字之外补一句完整话给读屏。
      const spoken = `有新任务（${state.count}）`
      if (!wide) {
        return h(
          'span',
          { 'aria-hidden': true },
          h('span', {
            style: {
              display: 'block',
              width: 8,
              height: 8,
              borderRadius: 4,
              background: '#f5222d',
              boxShadow: '0 0 0 2px var(--c7n-base)',
            },
          }),
        )
      }
      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 6 } },
        h(
          'span',
          {
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              minWidth: 18,
              height: 17,
              padding: '0 5px',
              borderRadius: 999,
              background: '#f5222d',
              color: '#fff',
              fontSize: 11,
              fontWeight: 600,
              lineHeight: '17px',
            },
          },
          state.count > 99 ? '99+' : String(state.count),
        ),
        h('span', { style: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' } }, spoken),
      )
    }

    // 会话由 Host 建好后已经挂进仓库工作区，选中它就等于同时切到该工作区。
    // 侧栏列表由工作区增量帧自己更新，这里不需要再主动刷新。
    async function jumpToSession(sessionId, workspaceId) {
      if (!sessionId) return false
      const service = clientCtx?.get?.('uiWorkspace') ?? clientCtx?.uiWorkspace
      if (!service?.openSession) return false
      try {
        // SessionTarget 就是 SessionId 本身（branded string），不要包成对象。
        service.openSession(sessionId)
        return true
      } catch {}
      if (!workspaceId) return false
      try {
        await service.openWorkspace?.(workspaceId)
        service.openSession(sessionId)
        return true
      } catch {
        return false
      }
    }

    /**
     * 试着把一段文本填进某个会话的草稿，返回 'applied' | 'preserved' | 'blocked' | 'failed'。
     *
     * 三个入口依次尝试，因为不同 DSH 版本/挂载阶段能用的不一样：
     * 1. `conversation.input.requestDraftInitialization(binding, opts)`：工作区新建会话用的那条；
     * 2. 会话作用域里的输入门面 `input.requestDraftInitialization(opts)`；
     * 3. 直接 `input.setDraft(text)`（只在草稿本来就空时用，避免盖掉别人正在写的字）。
     * @param {any} ctx - client 上下文。
     * @param {string} sessionId - 会话 id。
     * @param {string} text - 要填的全文。
     * @returns {{ result: string, error?: unknown }} 结果与最后一次异常。
     */
    function fillDraftOnce(ctx, sessionId, text) {
      let error = undefined
      const sessions = ctx.get?.('sessions') ?? ctx.sessions
      const conversation = ctx.get?.('conversation') ?? ctx.conversation
      const binding = typeof sessions?.binding === 'function' ? sessions.binding(sessionId) : undefined
      const hub = conversation?.input
      if (binding && typeof hub?.requestDraftInitialization === 'function') {
        try {
          return { result: hub.requestDraftInitialization(binding, { prompt: text }) }
        } catch (thrown) {
          error = thrown
        }
      }
      let scoped = undefined
      try {
        scoped = typeof sessions?.scope === 'function' ? sessions.scope(sessionId) : undefined
      } catch (thrown) {
        error = error ?? thrown
      }
      const scopedConversation = scoped?.get?.('conversation') ?? conversation
      let input = undefined
      try {
        input = typeof scopedConversation?.input?.for === 'function' ? scopedConversation.input.for(scoped) : scopedConversation?.input
      } catch (thrown) {
        error = error ?? thrown
      }
      if (typeof input?.requestDraftInitialization === 'function') {
        try {
          return { result: input.requestDraftInitialization({ prompt: text }) }
        } catch (thrown) {
          error = thrown
        }
      }
      if (typeof input?.setDraft === 'function') {
        try {
          const current = input.snapshot?.draft ?? ''
          if (current !== '') return { result: 'preserved' }
          input.setDraft(text)
          return { result: 'applied' }
        } catch (thrown) {
          error = thrown
        }
      }
      return { result: 'failed', error }
    }

    /**
     * 把工作项全文填进新会话的输入框草稿。
     *
     * 由建会话那一步直接调用，而不是挂到会话头组件上：空白会话首页根本不渲染会话头，
     * 等它挂上时人已经把第一条消息发出去了——那正是「开进去是空的、发完才冒出来」的原因。
     *
     * 走会话自己的输入门面，和「点推荐提示词开新会话」同一条路；草稿里已有内容时保留不动。
     * 输入门面还没就绪就每 200ms 再试，最多约 10 秒；期间一旦这个会话不再是空白
     * （人自己动手发了消息）就立刻放弃，绝不在对话开始后再补一条。
     * @param {string} sessionId - 会话 id。
     * @returns {Promise<boolean>} 是否真的填进去了。
     */
    async function seedDraft(sessionId) {
      const ctx = clientCtx
      if (!ctx || !sessionId) return false
      const sessions = ctx.get?.('sessions') ?? ctx.sessions
      let brief = null
      try {
        const data = await api(`/session-brief?sessionId=${encodeURIComponent(String(sessionId))}`)
        // 宿主还是旧版本（没有 prefill 标记）时它自己会 inject，这里就别再填一遍。
        if (data?.prefill !== true) return false
        brief = data?.brief ?? null
      } catch {
        return false
      }
      if (!brief?.kickoff) return false

      const stillBlank = () => {
        const list = sessions?.list?.getSnapshot?.()
        const entry = list?.byId?.[sessionId]
        return entry === undefined || entry.blank !== false
      }
      let lastError = undefined
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (!stillBlank()) return false
        const { result, error } = fillDraftOnce(ctx, sessionId, String(brief.kickoff))
        if (result === 'applied' || result === 'preserved') return true
        lastError = error ?? lastError
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      // 实在填不进去：让 Host 把全文补进待处理输入，至少别让模型凭空开工。
      // 顺手把原因留在控制台，下次要看「为什么没填上」不用再猜。
      if (lastError) console.warn('[choerodon] 工作项没能填进输入框：', lastError)
      if (stillBlank()) api('/session-context', { body: { sessionId: String(sessionId) } }).catch(() => {})
      return false
    }

    /**
     * 调 Host 半区。
     *
     * <p>401 是没登录；404 多半是「界面已更新、宿主还是旧代码」——插件是 link 安装时，
     * 浏览器每次刷新都从磁盘重读 client.js，而 index.js 只在进程启动时加载一次。
     * 遇到 404 直接把这件事说清楚，别让人对着一句「未知接口（HTTP 404）」猜。</p>
     */
    async function api(path, init) {
      const url = new URL(`choerodon${path}`, document.baseURI).href
      const response = await fetch(url, {
        method: init?.body ? 'POST' : 'GET',
        headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
        body: init?.body ? JSON.stringify(init.body) : undefined,
        credentials: 'same-origin',
      })
      const raw = await response.text()
      let data
      try {
        data = raw ? JSON.parse(raw) : {}
      } catch {
        throw new Error(`接口返回异常（HTTP ${response.status} ${new URL(url).pathname}）${raw.replace(/\s+/g, ' ').slice(0, 80)}`)
      }
      if (!response.ok) {
        /*
         * 只有「未知接口」才是宿主没这条路由（进程还没重启）。
         * 其它 404/500 都是业务失败，比如工作项已被删除、没权限 —— 不能也劝人重启。
         */
        if (data?.message === '未知接口') {
          throw new Error(
            `宿主没有这条接口（${path.split('?')[0]}）：界面已更新，但运行中的 DSH 还在用旧插件代码。` +
              '重启一次 DSH 就好；重启前登记工时、操作记录这些新功能都会走不通。',
          )
        }
        throw new Error(`${data.message || '请求失败'}（HTTP ${response.status}）`)
      }
      return data
    }

    function Mark({ size = 20, active = false }) {
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true, style: { display: 'block', opacity: active ? 1 : 0.78 } },
        h('path', {
          d: 'M3 13c3.2 0 4.6-1.6 5.4-3.6C9.2 7.1 10.6 6 13 6c3.9 0 6.6 2.3 6.6 5.6 0 3.2-2.4 5.4-5.6 5.4h-2.4c-1 0-1.9.3-2.7.9L6 20v-2.6C4.4 16.7 3 15.1 3 13Z',
          fill: active ? TOKEN.accent : 'currentColor',
        }),
        h('circle', { cx: 15.4, cy: 11.2, r: 1.1, fill: 'var(--c7n-surface)' }),
      )
    }

    // 弹窗遮罩。
    const BACKDROP = 'color-mix(in srgb, #0b1220 46%, transparent)'


    function Button({ children, onClick, disabled, primary, small, ghost, danger, icon, title, type = 'button' }) {
      const className = [
        'c7n-btn',
        small ? 'c7n-btn--sm' : '',
        primary ? 'c7n-btn--primary' : '',
        ghost ? 'c7n-btn--ghost' : '',
        danger ? 'c7n-btn--danger' : '',
        icon ? 'c7n-btn--icon' : '',
      ]
        .filter(Boolean)
        .join(' ')
      return h('button', { type, className, onClick, disabled, title, 'aria-label': icon ? title : undefined }, children)
    }

    function Row({ label, children }) {
      return h(
        'div',
        { style: { display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 12 } },
        h('span', { style: { flex: '0 0 76px', paddingTop: 7, color: TOKEN.muted, fontSize: 12 } }, label),
        h('div', { style: { flex: 1, minWidth: 0 } }, children),
      )
    }

    function Select({ value, onChange, options, placeholder }) {
      return h(
        'div',
        { className: 'c7n-select-wrap' },
        h(
          'select',
          {
            className: 'c7n-select',
            value: value ?? '',
            onChange: (event) => onChange(event.target.value),
          },
          h('option', { value: '' }, placeholder),
          options.map((option) => h('option', { key: option.id, value: option.id }, option.name)),
        ),
      )
    }

    function Toggle({ active, onClick, children }) {
      return h(
        'button',
        {
          type: 'button',
          onClick,
          className: `c7n-chip${active ? ' c7n-chip--on' : ''}`,
          'aria-pressed': active === true,
        },
        children,
      )
    }

    const TYPE_COLOR = { todo: '#9aa4b2', doing: '#247bbf', done: '#2f9e6f' }

    // ---------- 模型接入 ----------

    function AccessTab({ state, refresh, setError, setNotice, busy, setBusy }) {
      const [username, setUsername] = useState('')
      const [password, setPassword] = useState('')
      const [token, setToken] = useState('')
      const pollRef = useRef(null)

      useEffect(() => () => pollRef.current && clearInterval(pollRef.current), [])

      const run = useCallback(
        async (fn) => {
          setBusy(true)
          setError('')
          setNotice('')
          try {
            await fn()
          } catch (failure) {
            setError(failure.message)
          } finally {
            setBusy(false)
          }
        },
        [setBusy, setError, setNotice],
      )

      const login = () =>
        run(async () => {
          const started = await api('/login', { body: {} })
          if (started?.url) window.open(started.url, '_blank', 'noopener,noreferrer')
          setNotice('已打开浏览器，请在网页中完成猪齿鱼授权')
          pollRef.current = setInterval(async () => {
            const status = await api('/login/status').catch(() => ({ status: 'pending' }))
            if (status.status === 'done') {
              clearInterval(pollRef.current)
              setNotice('登录成功')
              await refresh()
            } else if (['error', 'expired', 'cancelled'].includes(status.status)) {
              clearInterval(pollRef.current)
              setError(status.message || '登录未完成，请重试')
            }
          }, 1500)
        })

      const submitPassword = () =>
        run(async () => {
          await api('/password', { body: { username, password } })
          setPassword('')
          setNotice(`已登录：${username}`)
          await refresh()
        })

      const submitToken = () =>
        run(async () => {
          await api('/token', { body: { token } })
          setToken('')
          setNotice('已使用 access_token 登录')
          await refresh()
        })

      const select = (tenantId, projectId) =>
        run(async () => {
          const next = await api('/select', { body: { tenantId, projectId } })
          await refresh()
          if (next.proxyError) setError(next.proxyError)
          else if (next.routeError) setError(next.routeError)
          else setNotice(next.models?.length ? `已接入 ${next.models.length} 个模型` : '当前项目没有可用模型')
        })

      const logout = () =>
        run(async () => {
          await api('/logout', { body: {} })
          setNotice('已退出')
          await refresh()
        })

      if (!state) return null
      const organizations = state.organizations ?? []
      const projects = state.projects ?? []
      const models = state.models ?? []
      const loggedIn = Boolean(state.loggedIn)

      return h(
        'div',
        { style: { display: 'grid', gap: 16 } },
        h(
          'section',
          { className: 'c7n-panel-box', style: { padding: 16 } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12, flexWrap: 'wrap' } },
            h(
              'div',
              { style: { minWidth: 0 } },
              h('div', { style: { fontWeight: 600, display: 'flex', alignItems: 'center', gap: 7 } },
                h('span', {
                  className: 'c7n-dot',
                  style: { background: loggedIn ? TOKEN.success : TOKEN.idle, width: 8, height: 8 },
                }),
                loggedIn ? `已登录：${state.user?.realName ?? ''}` : '未登录',
              ),
              h('div', { className: 'c7n-meta', style: { marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis' } }, state.apiOrigin ?? ''),
            ),
            loggedIn
              ? h(Button, { onClick: logout, disabled: busy, small: true }, '退出登录')
              : h(Button, { onClick: login, disabled: busy, primary: true }, busy ? '处理中…' : '浏览器授权登录'),
          ),
          !loggedIn &&
            h(
              'div',
              { style: { display: 'grid', gap: 10 } },
              h(
                'div',
                { style: { display: 'grid', gap: 8 } },
                h('input', { value: username, onChange: (e) => setUsername(e.target.value), placeholder: '猪齿鱼登录名', autoComplete: 'username', className: 'c7n-input' }),
                h('input', { value: password, type: 'password', onChange: (e) => setPassword(e.target.value), placeholder: '密码', autoComplete: 'current-password', className: 'c7n-input' }),
                h(
                  'div',
                  { className: 'c7n-row' },
                  h(Button, { onClick: submitPassword, disabled: busy || !username.trim() || !password, primary: true }, '账号密码登录'),
                  h('span', { className: 'c7n-meta' }, '密码只用于本次换取 token，不会保存'),
                ),
              ),
              h(
                'div',
                { className: 'c7n-row', style: { flexWrap: 'nowrap' } },
                h('input', { value: token, onChange: (e) => setToken(e.target.value), placeholder: '或粘贴 access_token', className: 'c7n-input' }),
                h(Button, { onClick: submitToken, disabled: busy || !token.trim() }, '使用'),
              ),
            ),
        ),

        loggedIn
          ? h(
              'section',
              { className: 'c7n-panel-box', style: { padding: 16 } },
              h(Row, { label: '组织' }, h(Select, { value: state.tenantId, options: organizations, placeholder: organizations.length ? '选择组织' : '没有可用组织', onChange: (v) => select(v, '') })),
              h(Row, { label: '项目' }, h(Select, { value: state.projectId, options: projects, placeholder: projects.length ? '选择项目' : '没有可用项目', onChange: (v) => select(state.tenantId, v) })),
              state.projectError ? h('div', { className: 'c7n-meta', style: { marginBottom: 8 } }, state.projectError) : null,
              h(
                'div',
                { className: 'c7n-row', style: { marginTop: 14 } },
                h(Button, { onClick: () => select(state.tenantId, state.projectId), disabled: busy || !state.projectId, primary: true }, '刷新并接入模型'),
                h(Button, { onClick: refresh, disabled: busy }, '刷新状态'),
              ),
            )
          : null,

        models.length
          ? h(
              'section',
              null,
              h('div', { className: 'c7n-section-title', style: { marginBottom: 8 } }, `已接入模型（${models.length}）`),
              h(
                'div',
                { style: { display: 'grid', gap: 6 } },
                models.map((model) =>
                  h(
                    'div',
                    {
                      key: model.id,
                      style: {
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: 12,
                        padding: '9px 12px',
                        borderRadius: 8,
                        border: `1px solid ${TOKEN.line}`,
                        background: TOKEN.surface,
                        fontSize: 12.5,
                      },
                    },
                    h('span', { style: { fontFamily: 'ui-monospace, monospace', overflow: 'hidden', textOverflow: 'ellipsis' } }, model.name),
                    h('span', { className: 'c7n-meta', style: { whiteSpace: 'nowrap' } }, `${Math.round(model.contextWindow / 1024)}K${model.imageInput ? ' · 图片' : ''}`),
                  ),
                ),
              ),
            )
          : null,
      )
    }

    // ---------- 任务看板 ----------

    /** color-mix 的简写，免得每处都拼一长串 var()。 */
    function colorMix(color, percent, base = 'transparent') {
      return `color-mix(in srgb, ${color} ${percent}%, ${base})`
    }

    function BoardCard({ item, onOpen }) {
      return h(
        'button',
        {
          type: 'button',
          className: 'c7n-card',
          onClick: () => onOpen(item),
          title: item.summary,
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginBottom: 5 } },
          h('span', { style: { fontSize: 11, fontWeight: 600, color: TOKEN.muted, letterSpacing: '.01em' } }, item.num),
          item.typeName
            ? h(
                'span',
                {
                  style: {
                    fontSize: 10.5,
                    padding: '1px 6px',
                    borderRadius: 999,
                    background: colorMix(TOKEN.muted, 10),
                    color: TOKEN.muted,
                  },
                },
                item.typeName,
              )
            : null,
        ),
        h(
          'div',
          { style: { fontSize: 12.5, lineHeight: 1.55, marginBottom: 7, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } },
          item.summary,
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, fontSize: 11, color: TOKEN.muted } },
          h(
            'span',
            { style: { display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 } },
            h('span', { className: 'c7n-dot', style: { background: TOKEN.idle, opacity: item.assigneeName ? 0 : 0.5 } }),
            h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.assigneeName || '未分配'),
          ),
          item.priority ? h('span', { style: { flex: '0 0 auto' } }, item.priority) : null,
        ),
      )
    }

    function Lane({ lane, onOpen }) {
      const color = TYPE_COLOR[lane.type] ?? TYPE_COLOR.todo
      return h(
        'div',
        { className: 'c7n-lane' },
        h(
          'div',
          { className: 'c7n-lane-head' },
          h('span', { className: 'c7n-dot', style: { background: color } }),
          h('span', null, lane.name),
          h('span', { className: 'c7n-count' }, String(lane.total ?? 0)),
        ),
        h(
          'div',
          { style: { flex: 1, overflowY: 'auto', minHeight: 80, paddingRight: 2 } },
          lane.error
            ? h('div', { style: { color: TOKEN.danger, fontSize: 11, padding: '4px 2px' } }, lane.error)
            : lane.items.length
              ? lane.items.map((item) => h(BoardCard, { key: item.id, item, onOpen }))
              : h('div', { className: 'c7n-empty', style: { padding: '14px 4px' } }, '暂无'),
        ),
      )
    }

    /** 看板的多选下拉（史诗/经办人共用）：勾选即按所选 id 重查看板。 */
    function MultiPicker({ list, selected, query, setQuery, onToggle, onClear, onClose, loading, searchPlaceholder, meta, sort, width = 320 }) {
      const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase()
        const rows = needle
          ? list.filter((row) => String(row.name).toLowerCase().includes(needle))
          : list
        return sort ? sort(rows) : rows
      }, [list, query, sort])
      return h(
        'div',
        null,
        h('div', { onClick: onClose, style: { position: 'fixed', inset: 0, zIndex: 30 } }),
        h(
          'div',
          {
            className: 'c7n-popover',
            onKeyDown: (event) => {
              if (event.key === 'Escape') onClose()
            },
            style: { width },
          },
          h(
            'div',
            { style: { display: 'flex', gap: 8, marginBottom: 8 } },
            h('input', {
              value: query,
              onChange: (e) => setQuery(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Escape') onClose()
              },
              placeholder: searchPlaceholder,
              autoFocus: true,
              className: 'c7n-input', style: { flex: 1 },
            }),
            h(Button, { onClick: onClear, disabled: !selected.length, small: true }, '清空'),
          ),
          loading
            ? h('div', { style: { color: TOKEN.muted, padding: '6px 2px' } }, '列表加载中…')
            : filtered.length
              ? h(
                  'div',
                  { style: { maxHeight: 300, overflowY: 'auto' } },
                  filtered.map((row) =>
                    h(
                      'label',
                      {
                        key: row.id,
                        title: row.name,
                        style: { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 4px', borderRadius: 6, cursor: 'pointer' },
                      },
                      h('input', {
                        type: 'checkbox',
                        checked: selected.includes(row.id),
                        onChange: () => onToggle(row.id),
                        style: { accentColor: TOKEN.accent, margin: 0 },
                      }),
                      h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.name),
                      meta ? h('span', { style: { color: TOKEN.muted, fontSize: 11 } }, meta(row)) : null,
                    ),
                  ),
                )
              : h('div', { style: { color: TOKEN.muted, padding: '6px 2px' } }, '没有匹配的选项'),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 } },
            h('span', { style: { flex: 1, color: TOKEN.muted, fontSize: 11 } }, `已选 ${selected.length} 项`),
            h(Button, { onClick: onClose, primary: true, small: true }, '完成'),
          ),
        ),
      )
    }

    /**
     * 单选浮层：和看板「经办人」多选同一个样子——顶部搜索框、列表限高滚动，
     * 没输入时只列前 10 条，其余靠姓名/工号筛。项目成员动辄几百人，
     * 原生长下拉一次铺开根本没法找。
     *
     * 位置用 fixed 按触发按钮的实际矩形算，再夹进视口。工作项抽屉和建单弹窗都是可滚动容器，
     * 绝对定位的浮层会被 overflow 裁掉，靠 fixed 才不会。
     */
    function SinglePicker({ list, value, query, setQuery, onPick, onClear, onClose, loading, anchor, width = 320, limit = 10, placeholder = '搜索姓名或工号' }) {
      const filtered = useMemo(() => {
        const needle = String(query ?? '').trim().toLowerCase()
        if (!needle) return list
        return list.filter((row) => `${row.name ?? ''} ${row.loginName ?? ''}`.toLowerCase().includes(needle))
      }, [list, query])
      const shown = filtered.slice(0, limit)
      const more = filtered.length - shown.length
      const style = useMemo(() => {
        const base = { position: 'fixed', zIndex: 40, width, margin: 0 }
        if (!anchor) return { ...base, top: 0, left: 0 }
        const gap = 6
        const margin = 8
        const below = anchor.bottom + gap
        // 下面放不下就翻到按钮上方，两侧各留一点边距，别顶出视口。
        const openUp = below + 360 > window.innerHeight && anchor.top > 360
        const left = Math.max(margin, Math.min(anchor.left, window.innerWidth - width - margin))
        return openUp
          ? { ...base, top: 'auto', bottom: Math.max(margin, window.innerHeight - anchor.top + gap), left }
          : { ...base, top: below, left }
      }, [anchor, width])
      return h(
        'div',
        null,
        h('div', { onClick: onClose, style: { position: 'fixed', inset: 0, zIndex: 39 } }),
        h(
          'div',
          {
            className: 'c7n-popover',
            onKeyDown: (event) => {
              if (event.key === 'Escape') onClose()
            },
            style,
          },
          h(
            'div',
            { style: { display: 'flex', gap: 8, marginBottom: 8 } },
            h('input', {
              value: query,
              onChange: (e) => setQuery(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Escape') onClose()
              },
              placeholder,
              autoFocus: true,
              className: 'c7n-input',
              style: { flex: 1 },
            }),
            h(Button, { onClick: onClear, disabled: !value, small: true }, '清空'),
          ),
          loading
            ? h('div', { style: { color: TOKEN.muted, padding: '6px 2px' } }, '成员加载中…')
            : shown.length
              ? h(
                  'div',
                  { style: { maxHeight: 300, overflowY: 'auto' } },
                  shown.map((row) =>
                    h(
                      'button',
                      {
                        key: row.id,
                        type: 'button',
                        title: row.name,
                        onClick: () => {
                          onPick(row.id)
                          onClose()
                        },
                        style: {
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          width: '100%',
                          padding: '5px 4px',
                          borderRadius: 6,
                          border: 'none',
                          background: row.id === value ? `color-mix(in srgb, ${TOKEN.accent} 12%, transparent)` : 'transparent',
                          color: TOKEN.text,
                          font: 'inherit',
                          fontSize: 12,
                          textAlign: 'left',
                          cursor: 'pointer',
                        },
                      },
                      h('span', {
                        'aria-hidden': true,
                        style: {
                          flex: '0 0 auto',
                          width: 12,
                          height: 12,
                          borderRadius: '50%',
                          border: `1.5px solid ${row.id === value ? TOKEN.accent : TOKEN.lineStrong}`,
                          background: row.id === value ? TOKEN.accent : 'transparent',
                          boxShadow: row.id === value ? `inset 0 0 0 2px ${TOKEN.surface}` : 'none',
                        },
                      }),
                      h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.name),
                    ),
                  ),
                )
              : h('div', { style: { color: TOKEN.muted, padding: '6px 2px' } }, list.length ? '没有匹配的成员' : '没有可用的项目成员'),
          h(
            'div',
            { style: { color: TOKEN.muted, fontSize: 11, marginTop: 8 } },
            query.trim()
              ? more > 0
                ? `共 ${filtered.length} 人，还有 ${more} 人未列出，继续输入缩小范围`
                : `共 ${filtered.length} 人`
              : `共 ${list.length} 人，默认只列前 ${limit} 条，输入姓名或工号筛选`,
          ),
        ),
      )
    }

    /** 成员选择触发器：按钮显示当前选中的人，点开就是上面的单选浮层。 */
    function MemberPicker({ value, people, loading, onChange, placeholder = '选择成员', disabled }) {
      const [open, setOpen] = useState(false)
      const [query, setQuery] = useState('')
      const [anchor, setAnchor] = useState(null)
      const triggerRef = useRef(null)
      const current = useMemo(() => people.find((row) => row.id === value), [people, value])
      useEffect(() => {
        if (!open) setQuery('')
      }, [open])
      useEffect(() => {
        if (!open) return undefined
        // 浮层按按钮的实际位置定位；滚动或改窗口大小时跟着走，免得漂到别处。
        const measure = () => {
          const rect = triggerRef.current?.getBoundingClientRect()
          if (rect) setAnchor({ top: rect.top, bottom: rect.bottom, left: rect.left })
        }
        measure()
        window.addEventListener('resize', measure)
        window.addEventListener('scroll', measure, true)
        return () => {
          window.removeEventListener('resize', measure)
          window.removeEventListener('scroll', measure, true)
        }
      }, [open])
      return h(
        'div',
        { ref: triggerRef, style: { position: 'relative' } },
        h(
          Button,
          { small: true, onClick: () => setOpen((v) => !v), disabled, title: '选择项目成员' },
          current ? current.name : loading ? '成员加载中…' : placeholder,
          h('span', { style: { color: TOKEN.muted, fontSize: 10, marginLeft: 6 } }, '▾'),
        ),
        open
          ? h(SinglePicker, {
              list: people,
              value,
              query,
              setQuery,
              onPick: (id) => onChange(id),
              onClear: () => onChange(''),
              onClose: () => setOpen(false),
              loading,
              anchor,
            })
          : null,
      )
    }

    /** 表单里的单选行：一组按钮，选中项高亮。 */
    function Choice({ value, options, onChange }) {
      return h(
        'div',
        { className: 'c7n-row', style: { gap: 6 } },
        options.map(([key, label]) =>
          h(
            'button',
            {
              key,
              type: 'button',
              className: `c7n-chip${value === key ? ' c7n-chip--on' : ''}`,
              'aria-pressed': value === key,
              onClick: () => onChange(key),
            },
            label,
          ),
        ),
      )
    }

    function BranchForm({ issue, repos, onClose, onCreate, creating, result, error, onRepos }) {
      const [repo, setRepo] = useState(repos[0]?.path ?? '')
      const [kind, setKind] = useState('feature')
      const [mode, setMode] = useState('develop')
      const [customBase, setCustomBase] = useState('')
      const [branches, setBranches] = useState(null)
      const [docEnabled, setDocEnabled] = useState(false)
      const [docMode, setDocMode] = useState('new')
      const [docTopics, setDocTopics] = useState([])
      const [docNext, setDocNext] = useState('')
      const [docTopicPick, setDocTopicPick] = useState('')
      const [docNameInput, setDocNameInput] = useState('')
      const [fixed, setFixed] = useState(false)
      const [fixedBranch, setFixedBranch] = useState('')
      const [currentBranch, setCurrentBranch] = useState('')
      const [repoBusy, setRepoBusy] = useState(false)
      const [repoError, setRepoError] = useState('')
      // 建会话时怎么处理经办人：keep 保持原样（默认，不动人家）、me 改成我、target 指定的人。
      const [assigneeMode, setAssigneeMode] = useState('keep')
      const [assigneePick, setAssigneePick] = useState('')
      const [people, setPeople] = useState([])
      const [peopleLoading, setPeopleLoading] = useState(false)
      const [advanceStatus, setAdvanceStatus] = useState(true)

      useEffect(() => {
        if (assigneeMode !== 'target' || people.length) return
        setPeopleLoading(true)
        api('/users')
          .then((data) => setPeople(Array.isArray(data?.users) ? data.users : []))
          .catch(() => setPeople([]))
          .finally(() => setPeopleLoading(false))
      }, [assigneeMode, people.length])

      useEffect(() => {
        if (!repos.length) return
        if (!repos.some((item) => item.path === repo)) setRepo(repos[0].path)
      }, [repos, repo])

      // 手动选的目录可能还没进候选列表，先补一条，别让下拉框显示成空。
      const repoOptions = useMemo(() => {
        const list = repos.map((item) => ({ id: item.path, name: `${item.title}　${item.path}` }))
        if (repo && !repos.some((item) => item.path === repo)) list.unshift({ id: repo, name: repo })
        return list
      }, [repos, repo])

      // 选一个本地目录当仓库：插件会把它登记成 DSH 工作区，侧栏就能认它。
      const chooseRepo = useCallback(async () => {
        setRepoError('')
        const service = clientCtx?.get?.('uiWorkspace') ?? clientCtx?.uiWorkspace
        if (!service?.pickDirectory) {
          setRepoError('当前界面不支持目录选择，直接在「任务看板」顶部输入路径再点「设为仓库」')
          return
        }
        setRepoBusy(true)
        try {
          const picked = await service.pickDirectory()
          if (!picked) return
          const data = await api('/repo', { body: { path: picked } })
          if (data.repos) onRepos?.(data.repos)
          setRepo(data.repoPath ?? picked)
        } catch (failure) {
          setRepoError(failure.message)
        } finally {
          setRepoBusy(false)
        }
      }, [onRepos])

      const reloadRepos = useCallback(async () => {
        setRepoError('')
        setRepoBusy(true)
        try {
          const data = await api('/repos')
          onRepos?.(data.repos ?? [])
        } catch (failure) {
          setRepoError(failure.message)
        } finally {
          setRepoBusy(false)
        }
      }, [onRepos])

      useEffect(() => {
        if (!repo) return
        api(`/docs?repo=${encodeURIComponent(repo)}`)
          .then((data) => {
            setDocTopics(data.topics ?? [])
            setDocNext(data.next ?? '')
          })
          .catch(() => {
            setDocTopics([])
            setDocNext('')
          })
      }, [repo])

      // 弹窗打开时把分支列表拉好：「自定义来源」与「固定分支」都用它。
      useEffect(() => {
        if (!repo) return
        api(`/branches?repo=${encodeURIComponent(repo)}`)
          .then((data) => {
            setBranches(data)
            const current = data.current ?? ''
            setCurrentBranch(current)
            setFixedBranch((previous) => previous || current)
          })
          .catch(() => setBranches(null))
      }, [repo])

      const autoDocName = useMemo(() => {
        const raw = String(issue?.summary ?? '')
          .replace(/^[【\[][^】\]]{1,20}[】\]]/, '')
          .replace(/[\\/:*?"<>|]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
        return (raw || '其他').slice(0, 20).trim() || '其他'
      }, [issue?.summary])

      const branchName = fixed ? fixedBranch : `${kind}-${issue?.num ?? ''}`
      const docPreview = docNext ? `docs/${docNext}-${(docNameInput || autoDocName).trim() || autoDocName}` : 'docs/NN-主题'
      const docsValue = docMode === 'existing' ? docTopicPick : docMode === 'manual' ? docPreview : docPreview

      const modes = [
        ['develop', 'develop'],
        ['uat', 'uat'],
        ['prod', 'prod'],
        ['custom', '自定义'],
      ]

      return h(
        'div',
        {
          style: {
            position: 'fixed',
            inset: 0,
            background: BACKDROP,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 900,
          },
          onClick: (event) => {
            if (event.target === event.currentTarget) onClose()
          },
        },
        h(
          'div',
          { className: 'c7n-modal', style: { width: 600 } },
          h(
            'div',
            { className: 'c7n-modal-head' },
            h('h2', { className: 'c7n-modal-title' }, fixed ? '基于固定分支开启会话' : '创建工作分支'),
            h(Button, { small: true, ghost: true, icon: true, title: '关闭', onClick: onClose }, '✕'),
          ),
          h(
            'div',
            { className: 'c7n-panel-box', style: { marginBottom: 14, fontSize: 12, lineHeight: 1.85 } },
            h('div', null, `问题：${issue?.num ?? ''}　${issue?.summary ?? ''}`.slice(0, 170)),
            h('div', { style: { color: TOKEN.muted } }, `类型：${issue?.typeName || '-'}　经办人：${issue?.assigneeName || '-'}`),
            h('div', { style: { color: TOKEN.muted } },
              fixed
                ? `分支：${fixedBranch || currentBranch || '（未选）'}　就地开发，不动 Git`
                : `分支：${branchName}　来源：${mode === 'custom' ? customBase || '（未选）' : mode}`),
            h('div', { style: { color: TOKEN.muted } },
              fixed ? '目录：该分支已检出的工作目录' : `目录：.worktrees/${branchName}`),
          ),
          h(
            Row,
            { label: '仓库' },
            h(
              'div',
              null,
              h(
                'div',
                { style: { display: 'flex', gap: 8 } },
                h(
                  'div',
                  { style: { flex: 1, minWidth: 0 } },
                  h(Select, {
                    value: repo,
                    options: repoOptions,
                    placeholder: repoOptions.length ? '选择仓库' : '还没有仓库，点右侧「选择目录…」',
                    onChange: setRepo,
                  }),
                ),
                h(Button, { onClick: chooseRepo, disabled: repoBusy, small: true }, repoBusy ? '处理中…' : '选择目录…'),
                h(Button, { onClick: reloadRepos, disabled: repoBusy, small: true }, '刷新'),
              ),
              h('div', { style: { color: TOKEN.muted, fontSize: 11, marginTop: 6 } },
                '选中的目录会登记成 DSH 工作区，会话直接挂在这个工作区下面；也可以选到 worktree，插件会收敛到仓库根。'),
              repoError ? h('div', { style: { color: TOKEN.danger, fontSize: 12, marginTop: 6 } }, repoError) : null,
            ),
          ),
          h(
            'div',
            { style: { marginBottom: 12, padding: 12, borderRadius: 10, border: `1px solid ${TOKEN.line}` } },
            h('div', { style: { color: TOKEN.muted, fontSize: 12, marginBottom: 6 } },
              `建会话时的经办人（现在是「${issue?.assigneeName || '未分配'}」）`),
            h(Choice, {
              value: assigneeMode,
              onChange: setAssigneeMode,
              options: [
                ['keep', '保持原经办人'],
                ['me', '改为我'],
                ['target', '指定的人'],
              ],
            }),
            assigneeMode === 'target'
              ? h(
                  'div',
                  { style: { marginTop: 8 } },
                  h(MemberPicker, {
                    value: assigneePick,
                    people,
                    loading: peopleLoading,
                    placeholder: '指定经办人',
                    onChange: setAssigneePick,
                  }),
                )
              : null,
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 } },
              h('input', {
                type: 'checkbox',
                checked: advanceStatus,
                onChange: (event) => setAdvanceStatus(event.target.checked),
                style: { width: 15, height: 15, accentColor: TOKEN.accent, cursor: 'pointer' },
              }),
              h('span', { style: { color: TOKEN.muted, fontSize: 12 } }, '同时把状态推进到「开发中」'),
            ),
          ),
          h(
            'div',
            { style: { marginBottom: 12 } },
            h('div', { style: { color: TOKEN.muted, fontSize: 12, marginBottom: 6 } }, '开发方式'),
            h(
              'div',
              { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
              [['new', '新建分支'], ['fixed', '固定分支（就地开发）']].map(([key, label]) =>
                h(Toggle, {
                  key,
                  active: (key === 'fixed') === fixed,
                  onClick: () => setFixed(key === 'fixed'),
                }, label),
              ),
            ),
            fixed
              ? h(
                  'div',
                  { style: { marginTop: 8 } },
                  h(Select, {
                    value: fixedBranch,
                    options: (branches?.local ?? []).map((name) => ({ id: name, name })),
                    placeholder: currentBranch ? `当前分支 ${currentBranch}` : '选择分支',
                    onChange: setFixedBranch,
                  }),
                  h('div', { style: { color: TOKEN.muted, fontSize: 11, marginTop: 6 } },
                    '直接在该分支已检出的工作目录开发：不新建分支、不建 worktree、不动任何 Git 引用'),
                )
              : null,
          ),
          fixed ? null : h(
            'div',
            { style: { marginBottom: 12 } },
            h('div', { style: { color: TOKEN.muted, fontSize: 12, marginBottom: 6 } }, '分支类型'),
            h(
              'div',
              { style: { display: 'flex', gap: 6 } },
              [['feature', 'feature-（新功能）'], ['bugfix', 'bugfix-（缺陷修复）']].map(([key, label]) =>
                h(Toggle, {
                  key,
                  active: kind === key,
                  onClick: () => setKind(key),
                }, label),
              ),
            ),
          ),
          fixed ? null : h(
            'div',
            { style: { marginBottom: 12 } },
            h('div', { style: { color: TOKEN.muted, fontSize: 12, marginBottom: 6 } },
              '来源分支（新分支从这里创建；已存在的分支直接复用，插件不合并）'),
            h(
              'div',
              { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
              modes.map(([key, label]) =>
                h(Toggle, {
                  key,
                  active: mode === key,
                  onClick: () => setMode(key),
                }, label),
              ),
            ),
            mode === 'custom'
              ? h(
                  'div',
                  { style: { display: 'flex', gap: 8, marginTop: 8 } },
                  h('input', {
                    value: customBase,
                    onChange: (event) => setCustomBase(event.target.value),
                    placeholder: '输入来源分支名',
                    className: 'c7n-input',
                  }),
                  h(
                    'div',
                    { style: { flex: '0 0 150px' } },
                    h(Select, {
                      value: '',
                      options: [...(branches?.local ?? []), ...(branches?.remote ?? [])].map((name) => ({ id: name, name })),
                      placeholder: '从列表选',
                      onChange: setCustomBase,
                    }),
                  ),
                )
              : null,
          ),
          h(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 12px',
                borderRadius: 10,
                border: `1px solid ${TOKEN.line}`,
                marginBottom: 12,
              },
            },
            h('input', {
              type: 'checkbox',
              checked: docEnabled,
              onChange: (event) => setDocEnabled(event.target.checked),
              style: { width: 15, height: 15, accentColor: TOKEN.accent, cursor: 'pointer' },
            }),
            h('div', { style: { flex: 1 } },
              h('div', { style: { fontSize: 13 } }, '创建 docs 目录'),
              h('div', { style: { color: TOKEN.muted, fontSize: 12 } },
                docEnabled ? `将在 ${docPreview} 下存放文档` : '不创建，按需自行放置'),
            ),
          ),
          docEnabled
            ? h(
                'div',
                { style: { marginBottom: 12, paddingLeft: 2 } },
                h(
                  'div',
                  { style: { display: 'flex', gap: 6, marginBottom: 8 } },
                  [['new', '自动编号新建'], ['existing', '使用已有目录'], ['manual', '手动输入']].map(([key, label]) =>
                    h(
                      'button',
                      {
                        key,
                        type: 'button',
                        onClick: () => setDocMode(key),
                        style: {
                          padding: '4px 10px',
                          borderRadius: 7,
                          border: `1px solid ${docMode === key ? TOKEN.accent : TOKEN.line}`,
                          background: docMode === key ? TOKEN.accent : TOKEN.surface,
                          color: docMode === key ? '#fff' : TOKEN.muted,
                          cursor: 'pointer',
                          fontSize: 12,
                        },
                      },
                      label,
                    ),
                  ),
                ),
                docMode === 'new'
                  ? h(
                      'div',
                      { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                      h('span', { style: { color: TOKEN.muted, fontSize: 12, whiteSpace: 'nowrap' } }, `docs/${docNext || 'NN'}-`),
                      h('input', {
                        value: docNameInput,
                        onChange: (event) => setDocNameInput(event.target.value),
                        placeholder: autoDocName,
                        className: 'c7n-input',
                      }),
                    )
                  : docMode === 'existing'
                    ? h(Select, {
                        value: docTopicPick,
                        options: docTopics.map((item) => ({ id: item, name: item })),
                        placeholder: docTopics.length ? '选择已有目录' : '还没有 docs 目录',
                        onChange: setDocTopicPick,
                      })
                    : h('input', {
                        value: docTopicPick,
                        onChange: (event) => setDocTopicPick(event.target.value),
                        placeholder: 'docs/25-新主题',
                        className: 'c7n-input',
                      }),
              )
            : null,
          h(
            'div',
            { className: 'c7n-row', style: { marginTop: 10 } },
            h(
              Button,
              {
                primary: true,
                disabled: creating || !repo || (fixed ? !fixedBranch.trim() : (mode === 'custom' && !customBase.trim())) ||
                  (docEnabled && docMode === 'existing' && !docTopicPick) ||
                  (docEnabled && docMode === 'manual' && !docTopicPick.trim()) ||
                  (assigneeMode === 'target' && !assigneePick),
                onClick: () =>
                  onCreate({
                    repoPath: repo,
                    kind,
                    baseMode: mode,
                    customBase,
                    fixedBranch: fixed ? fixedBranch.trim() : '',
                    docEnabled,
                    docTopic: docEnabled && docMode !== 'new' ? docsValue : '',
                    docName: docEnabled && docMode === 'new' ? (docNameInput || autoDocName) : '',
                    assigneeMode,
                    assignee: assigneeMode === 'target' ? assigneePick : '',
                    advanceStatus,
                  }),
              },
              creating ? '正在处理…' : fixed ? '开启会话' : '创建分支、上下文与会话',
            ),
            h(Button, { onClick: onClose }, '取消'),
            h('span', { className: 'c7n-meta' }, '只做本地操作，不会 push'),
          ),
          error ? h('div', { className: 'c7n-banner c7n-banner--error', style: { marginTop: 10 } }, error) : null,
          result
            ? h(
                'div',
                { className: 'c7n-panel-box', style: { marginTop: 14, fontSize: 12, lineHeight: 1.85 } },
                h('div', null, `分支：${result.branch}${result.fixed ? '（固定分支，就地开发）' : result.reused ? '（复用已有分支）' : ''}`),
                result.fixed
                  ? h('div', { style: { wordBreak: 'break-all' } }, `目录：${result.path}`)
                  : h('div', null, `来源：${result.base}（${result.baseCommit || '-'}）${result.reused && result.behind !== null ? `　落后 ${result.behind} 个提交` : ''}`),
                result.fixed ? null : h('div', { style: { wordBreak: 'break-all' } }, `目录：${result.path}`),
                h('div', { style: { color: TOKEN.muted } }, `问题：${result.issueNum}　${result.summary}`),
                h('div', { style: { color: TOKEN.muted } }, `状态：${result.status || '-'}　经办人：${result.assignee || '-'}`),
                result.docEnabled && result.docTarget ? h('div', null, `文档目录：${result.docTarget}`) : null,
                result.contextRelative ? h('div', { style: { color: TOKEN.muted } }, `上下文：${result.contextRelative}`) : null,
                result.sessionTitle ? h('div', { style: { color: TOKEN.muted } }, `会话：${result.sessionTitle}`) : null,
                result.workspaceId && !result.workspaceError
                  ? h('div', { style: { color: TOKEN.muted } }, '工作区：已挂到该仓库名下并自动选中')
                  : null,
                result.sessionError ? h('div', { style: { color: TOKEN.danger } }, `会话未自动创建：${result.sessionError}`) : null,
                result.directoryError ? h('div', { style: { color: TOKEN.danger } }, `工作目录没切到 worktree：${result.directoryError}`) : null,
                result.presetError ? h('div', { style: { color: TOKEN.danger } }, result.presetError) : null,
                result.promptError ? h('div', { style: { color: TOKEN.danger } }, `工作项没写进会话：${result.promptError}`) : null,
                result.workspaceError ? h('div', { style: { color: TOKEN.danger } }, `工作区未自动选中：${result.workspaceError}`) : null,
                (result.warnings ?? []).map((warning) => h('div', { key: warning, style: { color: TOKEN.muted } }, warning)),
                h('div', { style: { color: TOKEN.muted, marginTop: 4 } }, '侧栏里会出现这个会话，直接点进去就能开工。'),
              )
            : null,
        ),
      )
    }

    // 描述里的图片走外链，加载失败（离线、CSP、图片已过期）时只留一个可点的链接。
    /** 把用户选的文件读成 base64：面板在浏览器里跑，没有 Buffer，只能走 FileReader。 */
    function readFileAsBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const result = String(reader.result ?? '')
          const comma = result.indexOf(',')
          resolve(comma >= 0 ? result.slice(comma + 1) : result)
        }
        reader.onerror = () => reject(new Error('文件读不出来'))
        reader.readAsDataURL(file)
      })
    }

    /**
     * 平台用「2026-11-26 00:00:00」，datetime-local 用「2026-11-26T00:00」。
     * 两边互转，界面上就能直接用浏览器自带的日期时间选择器。
     */
    function toLocalInput(value) {
      const raw = String(value ?? '').trim()
      if (!raw) return ''
      const m = raw.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/)
      return m ? `${m[1]}T${m[2]}` : ''
    }

    function fromLocalInput(value) {
      const raw = String(value ?? '').trim()
      if (!raw) return ''
      // datetime-local 给的是 2026-11-26T09:53，补成秒
      return raw.length === 16 ? `${raw.replace('T', ' ')}:00` : raw.replace('T', ' ')
    }
    /** 单个附件上限，与宿主 MAX_ATTACHMENT 一致：走平台分块上传，实测 50MB 没问题。 */
    const ATTACHMENT_LIMIT = 100 * 1024 * 1024

    /** 文件大小给人看的写法。 */
    function fileSize(bytes) {
      const n = Number(bytes ?? 0)
      if (!Number.isFinite(n) || n <= 0) return ''
      if (n < 1024) return `${n} B`
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
      return `${(n / 1024 / 1024).toFixed(1)} MB`
    }

    /** 相对时间，通知列表用。 */
    function relativeTime(value) {
      if (!value) return ''
      const then = new Date(String(value).replace(' ', 'T')).getTime()
      if (!Number.isFinite(then)) return String(value)
      const diff = Date.now() - then
      if (diff < 60_000) return '刚刚'
      if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
      if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)} 小时前`
      if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
      return String(value).slice(0, 10)
    }
    function DescriptionImage({ url, index }) {      const [broken, setBroken] = useState(false)
      return h(
        'div',
        { style: { marginTop: 8 } },
        h(
          'button',
          {
            type: 'button',
            onClick: () => window.open(url, '_blank', 'noopener,noreferrer'),
            style: {
              padding: 0,
              border: 'none',
              background: 'transparent',
              color: TOKEN.accent,
              fontSize: 12,
              cursor: 'pointer',
              fontFamily: 'inherit',
            },
          },
          `描述图片 ${index + 1} ↗`,
        ),
        broken
          ? null
          : h('img', {
              src: url,
              alt: `描述图片 ${index + 1}`,
              onError: () => setBroken(true),
              style: {
                display: 'block',
                marginTop: 6,
                maxWidth: '100%',
                maxHeight: 180,
                borderRadius: 8,
                border: `1px solid ${TOKEN.line}`,
                cursor: 'zoom-in',
              },
            }),
      )
    }

    /**
     * 子任务类型的默认值与记忆：按名称记着上次选的，前端连续建几条同类子任务不用重复选。
     * 记名称而不是 id，换项目后 id 会变，名称对得上就还能用。
     */
    function pickSubType(types) {
      if (!types.length) return ''
      let last = ''
      try {
        last = window.localStorage.getItem('c7n.subIssueType') ?? ''
      } catch {}
      return (types.find((row) => row.name === last) ?? types[0]).id
    }

    function rememberSubType(types, id) {
      const hit = types.find((row) => row.id === id)
      if (!hit) return
      try {
        window.localStorage.setItem('c7n.subIssueType', hit.name)
      } catch {}
    }

    function DetailDrawer({
      issue,
      loading,
      error,
      onClose,
      onCreateBranch,
      creating,
      creatingError,
      result,
      onTransition,
      onAssign,
      acting,
      onOpenSession,
      onCopy,
      onComment,
      onEstimate,
      onLogged,
      onOpenIssue,
      me,
    }) {
      const [formOpen, setFormOpen] = useState(false)
      const [repos, setRepos] = useState([])
      const [people, setPeople] = useState([])
      const [assigneeOpen, setAssigneeOpen] = useState(false)
      const [comments, setComments] = useState(null)
      const [commentText, setCommentText] = useState('')
      const [commentBusy, setCommentBusy] = useState(false)
      const [commentError, setCommentError] = useState('')
      const [estimateOpen, setEstimateOpen] = useState(false)
      const [estimateInput, setEstimateInput] = useState('')
      const [remainInput, setRemainInput] = useState('')
      const [logOpen, setLogOpen] = useState(false)
      const [logs, setLogs] = useState(null)
      const [logBusy, setLogBusy] = useState(false)
      const [logError, setLogError] = useState('')
      const [logWorkTime, setLogWorkTime] = useState('')
      const [logStartDate, setLogStartDate] = useState('')
      const [logDescription, setLogDescription] = useState('')
      const [logResidual, setLogResidual] = useState('self_adjustment')
      const [logPrediction, setLogPrediction] = useState('')
      const [pane, setPane] = useState('detail')
      const [activity, setActivity] = useState(null)
      const [activityBusy, setActivityBusy] = useState(false)
      const [activityError, setActivityError] = useState('')
      /** 「依赖与关联」页的子任务快捷创建。 */
      const [subDraft, setSubDraft] = useState('')
      const [subBusy, setSubBusy] = useState(false)
      const [subError, setSubError] = useState('')
      /**
       * 子任务类型。项目会把 sub_task 拆成「前端开发任务 / 后端开发任务 / 测试子任务」等
       * 多个变体，只按编码取第一个就永远是「非开发子任务」。
       */
      const [subTypes, setSubTypes] = useState([])
      const [subType, setSubType] = useState('')
      const [subTypeError, setSubTypeError] = useState('')
      /** 附件上传。 */
      const [attachBusy, setAttachBusy] = useState(false)
      const [attachError, setAttachError] = useState('')
      /** 详情数据本地覆盖：建完子任务/传完附件就地刷新，不必整页重载。 */
      const [extra, setExtra] = useState(null)

      const detail = extra ?? issue
      const attachments = detail?.attachments ?? []
      const subIssues = detail?.subIssues ?? []
      const links = detail?.links ?? []

      /** 把新数据合并进本地副本，保持其它字段不动。 */
      const patchExtra = useCallback(
        (patch) => {
          setExtra((current) => {
            const base = current ?? issue
            if (!base) return current
            return { ...base, ...patch }
          })
        },
        [issue],
      )

      useEffect(() => {
        setExtra(null)
        setSubDraft('')
        setSubError('')
        setAttachError('')
      }, [issue?.detail?.id])

      const [attachInputKey, setAttachInputKey] = useState(0)

      const uploadAttachment = useCallback(
        async (file) => {
          if (!file || !issue?.detail?.id) return
          setAttachBusy(true)
          setAttachError('')
          try {
            const contentBase64 = await readFileAsBase64(file)
            const added = await api('/attachment', {
              body: {
                issueId: issue.detail.id,
                fileName: file.name,
                contentType: file.type,
                contentBase64,
              },
            })
            patchExtra({ attachments: [...attachments, added] })
          } catch (failure) {
            setAttachError(failure.message)
          } finally {
            setAttachBusy(false)
            setAttachInputKey((key) => key + 1)
          }
        },
        [issue?.detail?.id, attachments, patchExtra],
      )

      const dropAttachment = useCallback(
        async (attachmentId) => {
          setAttachBusy(true)
          setAttachError('')
          try {
            await api('/attachment/delete', { body: { attachmentId } })
            patchExtra({ attachments: attachments.filter((row) => row.id !== attachmentId) })
          } catch (failure) {
            setAttachError(failure.message)
          } finally {
            setAttachBusy(false)
          }
        },
        [attachments, patchExtra],
      )

      // 切到「依赖与关联」才拉类型清单：其它页签用不到，少一次请求。
      useEffect(() => {
        if (pane !== 'relation' || subTypes.length) return
        let alive = true
        api('/meta')
          .then((meta) => {
            if (!alive) return
            const list = (meta?.types ?? []).filter((row) => row.typeCode === 'sub_task')
            setSubTypes(list)
            setSubType((current) => current || pickSubType(list))
          })
          .catch((failure) => {
            if (alive) setSubTypeError(failure.message)
          })
        return () => {
          alive = false
        }
      }, [pane, subTypes.length])

      const addSubIssue = useCallback(async () => {
        const summary = subDraft.trim()
        if (!summary || !issue?.detail?.id) return
        setSubBusy(true)
        setSubError('')
        try {
          const picked = subTypes.find((row) => row.id === subType) ?? null
          const created = await api('/sub-issue', {
            body: {
              parentId: issue.detail.id,
              summary,
              issueTypeId: picked?.id,
              typeCode: picked?.typeCode,
            },
          })
          patchExtra({
            subIssues: [...subIssues, {
              id: created.id,
              num: created.num,
              summary: created.summary,
              statusName: created.statusName,
              typeName: created.typeName || picked?.name || '子任务',
            }],
          })
          setSubDraft('')
        } catch (failure) {
          setSubError(failure.message)
        } finally {
          setSubBusy(false)
        }
      }, [subDraft, issue?.detail?.id, subIssues, patchExtra, subType, subTypes])

      const dropIssueLink = useCallback(
        async (linkId) => {
          try {
            await api('/links/delete', { body: { linkId } })
            patchExtra({ links: links.filter((row) => row.linkId !== linkId) })
          } catch {}
        },
        [links, patchExtra],
      )

      const loadActivity = useCallback(async () => {
        if (!issue?.detail?.id) return
        setActivityBusy(true)
        setActivityError('')
        try {
          const data = await api(`/activity?issueId=${encodeURIComponent(issue.detail.id)}`)
          setActivity(data)
          if (data?.error) setActivityError(data.error)
        } catch (failure) {
          setActivityError(failure.message)
        } finally {
          setActivityBusy(false)
        }
      }, [issue?.detail?.id])

      useEffect(() => {
        if (!formOpen) return
        api('/repos')
          .then((data) => setRepos(data.repos ?? []))
          .catch(() => setRepos([]))
      }, [formOpen])

      useEffect(() => {
        if (!assigneeOpen || people.length) return
        api('/users')
          .then((data) => setPeople(Array.isArray(data?.users) ? data.users : []))
          .catch(() => setPeople([]))
      }, [assigneeOpen, people.length])

      const issueId = issue?.detail?.id
      const loadComments = useCallback(async () => {
        if (!issueId) return
        try {
          setComments(await api(`/comments?id=${encodeURIComponent(issueId)}`))
        } catch (failure) {
          setComments({ items: [], total: 0, error: failure.message })
        }
      }, [issueId])

      useEffect(() => {
        setComments(null)
        setCommentText('')
        setCommentError('')
        setEstimateOpen(false)
        loadComments()
      }, [loadComments])

      // 换一张单就把抽屉切回「详情」，别把上一张单的工时、评论、操作记录留在屏幕上。
      useEffect(() => {
        setPane('detail')
        setActivity(null)
        setActivityError('')
      }, [issueId])

      // 四个标签页各自按需加载，切到哪个才拉哪个，不一次性打四个接口。
      // loadLogs 在下面才定义，这里不能直接引用它 —— 用 ref 兜住，避免「初始化前访问」。
      const loadLogsRef = useRef(null)
      useEffect(() => {
        if (!issueId) return
        if (pane === 'worklog' && !logs) loadLogsRef.current?.()
        else if (pane === 'comment' && !comments) loadComments()
        else if (pane === 'activity' && !activity) loadActivity()
      }, [pane, issueId, logs, comments, activity, loadComments, loadActivity])

      const submitComment = useCallback(async () => {
        if (!commentText.trim() || !issueId) return
        setCommentBusy(true)
        setCommentError('')
        try {
          await onComment({ issueId, body: commentText })
          setCommentText('')
          await loadComments()
        } catch (failure) {
          setCommentError(failure.message)
        } finally {
          setCommentBusy(false)
        }
      }, [commentText, issueId, onComment, loadComments])

      const submitEstimate = useCallback(async () => {
        setCommentError('')
        try {
          await onEstimate({
            issueId,
            estimateTime: estimateInput === '' ? undefined : Number(estimateInput),
            remainingTime: remainInput === '' ? undefined : Number(remainInput),
          })
          setEstimateOpen(false)
          setEstimateInput('')
          setRemainInput('')
        } catch (failure) {
          setCommentError(failure.message)
        }
      }, [issueId, estimateInput, remainInput, onEstimate])

      const loadLogs = useCallback(async () => {
        if (!issueId) return
        setLogBusy(true)
        setLogError('')
        try {
          setLogs(await api(`/worklogs?issueId=${encodeURIComponent(issueId)}`))
        } catch (failure) {
          setLogs({ items: [], total: 0 })
          setLogError(failure.message)
        } finally {
          setLogBusy(false)
        }
      }, [issueId])

      useEffect(() => {
        setLogs(null)
        setLogOpen(false)
        setLogError('')
      }, [issueId])

      // 打开抽屉就把工时日志读出来，页签上直接显示条数，别等点了才知道。
      useEffect(() => {
        if (issueId && issue) loadLogs()
      }, [issueId, Boolean(issue), loadLogs])

      /** 工时表单的展开/收起；展开时顺带刷新一次，免得看到过期合计。 */
      const toggleLogForm = useCallback(() => {
        setLogOpen((open) => {
          if (!open) loadLogs()
          return !open
        })
      }, [loadLogs])

      // 把 loadLogs 挂到 ref 上，供上面那个按需加载的 effect 调用。
      loadLogsRef.current = loadLogs

      const submitLog = useCallback(async () => {
        setLogError('')
        const hours = Number(logWorkTime)
        if (!Number.isFinite(hours) || hours <= 0) {
          setLogError('耗费时间要给个大于 0 的小时数')
          return
        }
        if ((logResidual === 'set_to' || logResidual === 'reduce') && logPrediction === '') {
          setLogError('选「设置为 / 缩减」时要填剩余预估')
          return
        }
        setLogBusy(true)
        try {
          await api('/worklog', {
            body: {
              issueId,
              workTime: hours,
              startDate: logStartDate,
              description: logDescription,
              residualPrediction: logResidual,
              predictionTime: logPrediction === '' ? undefined : Number(logPrediction),
            },
          })
          setLogWorkTime('')
          setLogDescription('')
          setLogPrediction('')
          await loadLogs()
          onLogged?.()
        } catch (failure) {
          setLogError(failure.message)
        } finally {
          setLogBusy(false)
        }
      }, [issueId, logWorkTime, logStartDate, logDescription, logResidual, logPrediction, loadLogs, onLogged])

      const removeLog = useCallback(
        async (logId) => {
          setLogError('')
          setLogBusy(true)
          try {
            await api('/worklog/delete', { body: { logId } })
            await loadLogs()
            onLogged?.()
          } catch (failure) {
            setLogError(failure.message)
          } finally {
            setLogBusy(false)
          }
        },
        [loadLogs, onLogged],
      )

      return h(
        'aside',
        { className: 'c7n-drawer c7n-root', 'data-pane': pane },
        h(
          'div',
          { className: 'c7n-drawer-head' },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, marginBottom: 8 } },
            h(
              'div',
              { style: { minWidth: 0 } },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3 } },
                h('span', { style: { fontSize: 11.5, fontWeight: 650, color: TOKEN.muted, letterSpacing: '.01em' } }, issue?.detail?.num ?? '工作项'),
                issue?.detail?.typeName
                  ? h('span', { className: 'c7n-chip', style: { height: 18, fontSize: 10.5, padding: '0 7px', cursor: 'default' } }, issue.detail.typeName)
                  : null,
              ),
              h('div', { style: { fontSize: 13.5, lineHeight: 1.5, fontWeight: 550, wordBreak: 'break-word' } }, issue?.detail?.summary ?? '加载中…'),
            ),
            h(Button, { small: true, ghost: true, icon: true, title: '关闭', onClick: onClose }, '✕'),
          ),
          h(
            'div',
            { className: 'c7n-tabs' },
            [
              ['detail', '详情'],
              ['relation', `依赖与关联${subIssues.length + links.length ? ` ${subIssues.length + links.length}` : ''}`],
              ['worklog', logs ? `工时 ${logs.items?.length ?? 0}` : '工时'],
              ['comment', comments ? `评论 ${comments.total ?? 0}` : '评论'],
              ['activity', activity ? `操作记录 ${activity.total ?? 0}` : '操作记录'],
            ].map(([key, label]) =>
              h(
                'button',
                {
                  key,
                  type: 'button',
                  className: `c7n-tab${pane === key ? ' c7n-tab--on' : ''}`,
                  onClick: () => setPane(key),
                },
                label,
              ),
            ),
          ),
        ),
        h(
          'div',
          { className: 'c7n-drawer-body' },
          loading ? h('div', { className: 'c7n-skeleton' }, null) : null,
          error ? h('div', { className: 'c7n-banner c7n-banner--error' }, error) : null,

          // ---------- 操作记录 ----------
          pane === 'activity'
            ? h(
                'div',
                null,
                h(
                  'div',
                  { className: 'c7n-row', style: { marginBottom: 12 } },
                  h('span', { className: 'c7n-meta' },
                    activityBusy ? '加载中…' : activity ? `共 ${activity.total} 条操作` : '还没加载'),
                  h('span', { style: { flex: 1 } }),
                  h(Button, { small: true, ghost: true, disabled: activityBusy, onClick: loadActivity }, '刷新'),
                ),
                activityError ? h('div', { className: 'c7n-banner c7n-banner--error' }, activityError) : null,
                // 经办人变更单独置顶：改完分回给谁，一眼就能看出来
                activity?.assignees?.length
                  ? h(
                      'div',
                      { className: 'c7n-panel-box', style: { marginBottom: 14 } },
                      h('div', { className: 'c7n-section-title', style: { marginBottom: 8 } }, '经办人变更'),
                      activity.assignees.map((row, index) =>
                        h(
                          'div',
                          { key: `${row.at}-${index}`, style: { fontSize: 12, lineHeight: 1.85, display: 'flex', gap: 6, flexWrap: 'wrap' } },
                          h('span', { style: { color: TOKEN.muted } }, row.at),
                          h('span', null, `${row.by || '?'} 把经办人从`),
                          h('span', { className: 'c7n-change-val' }, row.from || '空'),
                          h('span', { className: 'c7n-arrow' }, '→'),
                          h('span', { className: 'c7n-change-val c7n-change-val--new' }, row.to || '空'),
                        ),
                      ),
                    )
                  : null,
                activity?.events?.length
                  ? h(
                      'div',
                      { className: 'c7n-timeline' },
                      activity.events.map((event, index) =>
                        h(
                          'div',
                          { key: `${event.at}-${index}`, className: `c7n-event${index === 0 ? ' c7n-event--hot' : ''}` },
                          h(
                            'div',
                            { className: 'c7n-event-head' },
                            h('span', { className: 'c7n-event-who' }, event.by || '未知'),
                            h('span', { className: 'c7n-event-time' }, event.at || ''),
                          ),
                          event.changes.map((change, changeIndex) =>
                            h(
                              'div',
                              { key: `${change.field}-${changeIndex}`, className: 'c7n-change' },
                              h('span', { className: 'c7n-change-field' }, change.fieldName),
                              h('span', { className: 'c7n-change-val' }, change.from || '空'),
                              h('span', { className: 'c7n-arrow' }, '→'),
                              h('span', { className: 'c7n-change-val c7n-change-val--new' }, change.to || '空'),
                            ),
                          ),
                        ),
                      ),
                    )
                  : !activityBusy && activity && !activityError
                    ? h('div', { className: 'c7n-empty' }, '这张单还没有操作记录')
                    : null,
              )
            : pane === 'relation'
            ? h(
                'div',
                null,
                // ---------- 子任务 ----------
                h(
                  'div',
                  { className: 'c7n-section' },
                  h(
                    'div',
                    { className: 'c7n-section-title' },
                    h('span', null, `子任务${subIssues.length ? `（${subIssues.length}）` : ''}`),
                    h('span', { style: { flex: 1 } }),
                  ),
                  subTypes.length > 1
                    ? h(
                        'div',
                        { className: 'c7n-row', style: { marginBottom: 8, flexWrap: 'nowrap' } },
                        h('span', { className: 'c7n-meta', style: { flex: '0 0 auto' } }, '子任务类型'),
                        h(
                          'div',
                          { style: { width: 168 } },
                          h(Select, {
                            value: subType,
                            options: subTypes.map((row) => ({ id: row.id, name: row.name })),
                            placeholder: '选择类型',
                            onChange: (value) => {
                              setSubType(value)
                              rememberSubType(subTypes, value)
                            },
                          }),
                        ),
                      )
                    : null,
                  subTypeError
                    ? h('div', { className: 'c7n-meta', style: { marginBottom: 8 } },
                        `类型清单没取到，将按项目默认子任务类型建：${subTypeError}`)
                    : null,
                  // 快速创建：图3 那种一行输入 + 字数 + 确定/取消
                  h(
                    'div',
                    { className: 'c7n-row', style: { marginBottom: subIssues.length ? 10 : 0, flexWrap: 'nowrap' } },
                    h('input', {
                      value: subDraft,
                      onChange: (event) => setSubDraft(event.target.value.slice(0, 400)),
                      onKeyDown: (event) => {
                        if (event.key === 'Enter' && !event.shiftKey) addSubIssue()
                        if (event.key === 'Escape') setSubDraft('')
                      },
                      placeholder: '快速创建子任务：一句话说清要做什么，回车确定',
                      className: 'c7n-input',
                      disabled: subBusy,
                    }),
                    h('span', { className: 'c7n-meta', style: { flex: '0 0 auto', minWidth: 46, textAlign: 'right' } },
                      `${subDraft.length}/400`),
                    subDraft
                      ? h(Button, { small: true, primary: true, disabled: subBusy || !subDraft.trim(), onClick: addSubIssue },
                          subBusy ? '建中…' : '确定')
                      : null,
                    subDraft ? h(Button, { small: true, disabled: subBusy, onClick: () => setSubDraft('') }, '取消') : null,
                  ),
                  subError ? h('div', { className: 'c7n-banner c7n-banner--error', style: { marginBottom: 8 } }, subError) : null,
                  subIssues.length
                    ? h(
                        'div',
                        { style: { display: 'grid', gap: 5 } },
                        subIssues.map((row) =>
                          h(
                            'button',
                            {
                              key: row.id,
                              type: 'button',
                              className: 'c7n-rel-row',
                              onClick: () => onOpenIssue?.({ id: row.id, num: row.num }),
                              title: row.summary || row.num,
                            },
                            h('span', { className: 'c7n-rel-num' }, row.num || '子任务'),
                            h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                              row.summary || '（无概要）'),
                            row.typeName
                              ? h('span', { className: 'c7n-rel-type', title: row.typeName }, row.typeName)
                              : null,
                            row.statusName
                              ? h('span', { className: 'c7n-rel-status' }, row.statusName)
                              : null,
                          ),
                        ),
                      )
                    : h('div', { className: 'c7n-meta', style: { padding: '4px 0' } }, '还没有子任务'),
                ),

                // ---------- 关联工作项 ----------
                h(
                  'div',
                  { className: 'c7n-section' },
                  h(
                    'div',
                    { className: 'c7n-section-title' },
                    h('span', null, `关联工作项${links.length ? `（${links.length}）` : ''}`),
                    h('span', { style: { flex: 1 } }),
                  ),
                  links.length
                    ? (() => {
                        // 按 ward 分组：ward 是「相对当前单」的方向词，不能假设只有一个方向
                        const groups = new Map()
                        for (const row of links) {
                          const key = row.linkTypeName
                            ? `${row.linkTypeName} · ${row.ward || '关联'}`
                            : row.ward || '关联'
                          if (!groups.has(key)) groups.set(key, [])
                          groups.get(key).push(row)
                        }
                        return [...groups.entries()].map(([label, rows]) =>
                          h(
                            'div',
                            { key: label, style: { marginBottom: 10 } },
                            h('div', { className: 'c7n-rel-group' }, `${label}（${rows.length}）`),
                            h(
                              'div',
                              { style: { display: 'grid', gap: 5 } },
                              rows.map((row) =>
                                h(
                                  'div',
                                  { key: row.linkId || row.id, className: 'c7n-rel-row' },
                                  h(
                                    'button',
                                    {
                                      type: 'button',
                                      className: 'c7n-rel-link',
                                      onClick: () => onOpenIssue?.({ id: row.id, num: row.num }),
                                      title: row.summary || row.num,
                                    },
                                    h('span', { className: 'c7n-rel-num' }, row.num || '工作项'),
                                    h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                                      row.summary || '（无概要）'),
                                  ),
                                  row.statusName ? h('span', { className: 'c7n-rel-status' }, row.statusName) : null,
                                  row.assigneeName
                                    ? h('span', { className: 'c7n-meta', style: { flex: '0 0 auto' } }, row.assigneeName)
                                    : null,
                                  h(Button, {
                                    small: true,
                                    ghost: true,
                                    danger: true,
                                    title: '删掉这条关联',
                                    onClick: () => dropIssueLink(row.linkId),
                                  }, '删'),
                                ),
                              ),
                            ),
                          ),
                        )
                      })()
                    : h('div', { className: 'c7n-meta', style: { padding: '4px 0' } }, '没有关联工作项'),
                ),

                // ---------- 模块与版本 ----------
                (detail?.components?.length || detail?.versions?.length)
                  ? h(
                      'div',
                      { className: 'c7n-section' },
                      h('div', { className: 'c7n-section-title' }, '模块与版本'),
                      detail?.components?.length
                        ? h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 } },
                            h('span', { className: 'c7n-meta', style: { marginRight: 4 } }, '模块'),
                            detail.components.map((row) =>
                              h('span', { key: row.id, className: 'c7n-chip', style: { cursor: 'default' } }, row.name),
                            ),
                          )
                        : null,
                      detail?.versions?.length
                        ? h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                            h('span', { className: 'c7n-meta', style: { marginRight: 4 } }, '版本'),
                            detail.versions.map((row) =>
                              h('span', { key: row.id, className: 'c7n-chip', style: { cursor: 'default' } }, row.name),
                            ),
                          )
                        : null,
                    )
                  : null,
              )
            : pane === 'worklog'
            ? h(
                'div',
                null,
                h(
                  'div',
                  { className: 'c7n-row', style: { marginBottom: 12 } },
                  h('span', { className: 'c7n-meta' },
                    logBusy ? '加载中…'
                      : logs ? `共 ${logs.items?.length ?? 0} 条 · 合计 ${logs.total ?? 0} 小时`
                      : '还没加载'),
                  h('span', { style: { flex: 1 } }),
                  h(Button, { small: true, ghost: true, disabled: logBusy, onClick: loadLogs }, '刷新'),
                  h(Button, { small: true, primary: !logOpen, onClick: toggleLogForm }, logOpen ? '收起表单' : '登记工时'),
                ),
                logOpen
                  ? h(
                      'div',
                      { className: 'c7n-panel-box', style: { display: 'grid', gap: 10, marginBottom: 12 } },
                      h(
                        'div',
                        { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                        h('div', { style: { flex: '1 1 110px' } },
                          h('span', { className: 'c7n-field-label' }, '耗费时间 *'),
                          h('input', {
                            value: logWorkTime,
                            onChange: (event) => setLogWorkTime(event.target.value),
                            placeholder: '0.5',
                            inputMode: 'decimal',
                            className: 'c7n-input',
                          }),
                        ),
                        h('div', { style: { flex: '0 0 74px' } },
                          h('span', { className: 'c7n-field-label' }, '单位'),
                          h('div', { className: 'c7n-input', style: { display: 'flex', alignItems: 'center', color: TOKEN.muted, cursor: 'default' } }, '小时'),
                        ),
                        h('div', { style: { flex: '1 1 190px' } },
                          h('span', { className: 'c7n-field-label' }, '工作日期 *'),
                          h('input', {
                            value: logStartDate,
                            onChange: (event) => setLogStartDate(event.target.value),
                            placeholder: '留空取当前时间',
                            className: 'c7n-input',
                          }),
                        ),
                      ),
                      h('div', null,
                        h('span', { className: 'c7n-field-label' }, '剩余预估'),
                        h(Choice, {
                          value: logResidual,
                          options: [
                            ['self_adjustment', '自动调整'],
                            ['no_set_prediction_time', '不调整'],
                            ['set_to', '设置为'],
                            ['reduce', '缩减'],
                          ],
                          onChange: setLogResidual,
                        }),
                        logResidual === 'set_to' || logResidual === 'reduce'
                          ? h('input', {
                              value: logPrediction,
                              onChange: (event) => setLogPrediction(event.target.value),
                              placeholder: logResidual === 'reduce' ? '要缩减多少小时' : '设置为多少小时',
                              inputMode: 'decimal',
                              className: 'c7n-input',
                              style: { marginTop: 8 },
                            })
                          : null,
                      ),
                      h('div', null,
                        h('span', { className: 'c7n-field-label' }, '描述'),
                        h('textarea', {
                          value: logDescription,
                          onChange: (event) => setLogDescription(event.target.value),
                          rows: 3,
                          placeholder: '这段工作做了什么',
                          className: 'c7n-textarea',
                        }),
                      ),
                      logError ? h('div', { style: { color: TOKEN.danger, fontSize: 11 } }, logError) : null,
                      h('div', { className: 'c7n-row' },
                        h(Button, { small: true, primary: true, disabled: logBusy, onClick: submitLog }, logBusy ? '提交中…' : '登记'),
                        h(Button, { small: true, onClick: () => setLogOpen(false) }, '取消'),
                      ),
                    )
                  : null,
                h(
                  'div',
                  { style: { display: 'grid', gap: 5 } },
                  logs
                    ? (logs.items?.length
                        ? logs.items.map((row) =>
                            h(
                              'div',
                              {
                                key: row.logId,
                                style: {
                                  display: 'flex',
                                  gap: 8,
                                  alignItems: 'baseline',
                                  padding: '7px 10px',
                                  borderRadius: 8,
                                  border: `1px solid ${TOKEN.line}`,
                                  background: TOKEN.surface,
                                  fontSize: 11.5,
                                  color: TOKEN.muted,
                                  flexWrap: 'wrap',
                                },
                              },
                              h('span', { style: { fontWeight: 600, color: TOKEN.text } }, `${row.workTime ?? '-'}h`),
                              h('span', null, row.startDate || '-'),
                              h('span', { style: { flex: 1, minWidth: 0, color: TOKEN.text, overflowWrap: 'anywhere' } }, row.description || '（无描述）'),
                              h('span', null, row.userName || ''),
                              h(Button, { small: true, ghost: true, danger: true, disabled: logBusy, onClick: () => removeLog(row.logId) }, '删'),
                            ),
                          )
                        : h('div', { className: 'c7n-empty' }, '还没有登记过工时'))
                    : h('div', { className: 'c7n-empty' }, logBusy ? '加载中…' : '工时日志未加载'),
                ),
              )
            : pane === 'comment'
            ? h(
                'div',
                null,
                h(
                  'div',
                  { className: 'c7n-row', style: { marginBottom: 12 } },
                  h('span', { className: 'c7n-meta' },
                    comments ? `共 ${comments.total ?? 0} 条评论` : '还没加载'),
                  h('span', { style: { flex: 1 } }),
                  h(Button, { small: true, ghost: true, onClick: loadComments }, '刷新'),
                ),
                comments?.error ? h('div', { style: { color: TOKEN.danger, fontSize: 11, marginBottom: 6 } }, comments.error) : null,
                h(
                  'div',
                  { style: { maxHeight: 260, overflowY: 'auto', display: 'grid', gap: 7 } },
                  comments?.items?.length
                    ? comments.items.map((row) =>
                        h(
                          'div',
                          { key: row.id, style: { padding: '8px 10px', borderRadius: 8, border: `1px solid ${TOKEN.line}`, background: TOKEN.surface } },
                          h('div', { className: 'c7n-meta', style: { fontSize: 11, marginBottom: 3 } },
                            `${row.author || '未知'}　${row.createdAt || ''}`),
                          h('div', { style: { fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.7 } }, row.text),
                          (row.replies ?? []).map((reply, index) =>
                            h('div', { key: `${row.id}-${index}`, style: { marginTop: 6, paddingLeft: 9, borderLeft: `2px solid ${TOKEN.line}`, color: TOKEN.muted, fontSize: 11, lineHeight: 1.7 } },
                              `${reply.author || ''}：${reply.text}`),
                          ),
                        ),
                      )
                    : h('div', { className: 'c7n-empty', style: { padding: '10px 4px' } }, comments ? '还没有评论' : '评论加载中…'),
                ),
                h(
                  'div',
                  { className: 'c7n-row', style: { marginTop: 8, flexWrap: 'nowrap' } },
                  h('input', {
                    value: commentText,
                    onChange: (event) => setCommentText(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter' && !event.shiftKey) submitComment()
                    },
                    placeholder: '写条评论，回车发送（@姓名 会转成提及）',
                    className: 'c7n-input',
                  }),
                  h(Button, { small: true, primary: true, disabled: commentBusy || !commentText.trim(), onClick: submitComment },
                    commentBusy ? '发送中…' : '发表'),
                ),
                commentError ? h('div', { style: { color: TOKEN.danger, fontSize: 11, marginTop: 4 } }, commentError) : null,
              )
            : issue
            ? h(
              'div',
              { style: { fontSize: 13, lineHeight: 1.7 } },
              h(
                'dl',
                { className: 'c7n-kv', style: { marginBottom: 4 } },
                h('dt', null, '状态'),
                h('dd', null,
                  h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5 } },
                    h('span', { className: 'c7n-dot', style: { background: TYPE_COLOR[issue.detail.statusType] ?? TOKEN.idle } }),
                    issue.detail.statusName,
                  ),
                ),
                h('dt', null, '经办人'),
                h('dd', null,
                  h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                    h('span', { style: { fontWeight: 550 } }, issue.detail.assigneeName || '未分配'),
                    h(Button, { small: true, ghost: true, disabled: Boolean(acting), onClick: () => setAssigneeOpen((open) => !open) },
                      assigneeOpen ? '收起' : '改'),
                    me?.id && issue.detail.assigneeId !== me.id
                      ? h(Button, { small: true, ghost: true, disabled: acting === 'assignee', onClick: () => onAssign(issue.detail) },
                          acting === 'assignee' ? '设置中…' : '改为我')
                      : null,
                  ),
                ),
                issue.detail.priority ? h('dt', null, '优先级') : null,
                issue.detail.priority ? h('dd', null, issue.detail.priority) : null,
                issue.detail.epicName ? h('dt', null, '史诗') : null,
                issue.detail.epicName ? h('dd', null, issue.detail.epicName) : null,
                issue.detail.estimatedStart ? h('dt', null, '计划') : null,
                issue.detail.estimatedStart
                  ? h('dd', null, `${issue.detail.estimatedStart} ~ ${issue.detail.estimatedEnd}`)
                  : null,
                h('dt', null, '工时'),
                h('dd', null,
                  h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                    h('span', null, `预估 ${issue.detail.estimateTime ?? '-'} / 剩余 ${issue.detail.remainingTime ?? '-'} 小时`),
                    h(Button, { small: true, ghost: true, onClick: () => setEstimateOpen((open) => !open) }, estimateOpen ? '收起' : '改'),
                  ),
                ),
              ),

              assigneeOpen
                ? h(
                    'div',
                    { className: 'c7n-panel-box', style: { marginTop: 10, display: 'grid', gap: 8 } },
                    h(MemberPicker, {
                      value: '',
                      people,
                      loading: !people.length,
                      placeholder: '选一个项目成员（立即改过去）',
                      onChange: (value) => {
                        if (!value) return
                        setAssigneeOpen(false)
                        onAssign(issue.detail, value)
                      },
                    }),
                    h('div', { className: 'c7n-row' },
                      h(Button, { small: true, onClick: () => { setAssigneeOpen(false); onAssign(issue.detail, 'me') } }, '改为我'),
                      h(Button, { small: true, danger: true, onClick: () => { setAssigneeOpen(false); onAssign(issue.detail, '', true) } }, '清空经办人'),
                    ),
                  )
                : null,

              estimateOpen
                ? h(
                    'div',
                    { className: 'c7n-panel-box', style: { marginTop: 10, display: 'grid', gap: 8 } },
                    h('input', {
                      value: estimateInput,
                      onChange: (event) => setEstimateInput(event.target.value),
                      placeholder: `原始预估（当前 ${issue.detail.estimateTime ?? '-'} 小时）`,
                      className: 'c7n-input',
                    }),
                    h('input', {
                      value: remainInput,
                      onChange: (event) => setRemainInput(event.target.value),
                      placeholder: `剩余预估（当前 ${issue.detail.remainingTime ?? '-'} 小时）`,
                      className: 'c7n-input',
                    }),
                    h('div', { className: 'c7n-row' },
                      h(Button, { small: true, primary: true, disabled: estimateInput === '' && remainInput === '', onClick: submitEstimate }, '保存'),
                      h(Button, { small: true, onClick: () => setEstimateOpen(false) }, '取消'),
                    ),
                    h('div', { className: 'c7n-meta', style: { fontSize: 11 } }, '汇总字段；逐条流水请用下面的「工时日志」'),
                  )
                : null,

              // ---------- 可流转状态 ----------
              issue.transitions.length
                ? h(
                    'div',
                    { className: 'c7n-section' },
                    h('div', { className: 'c7n-section-title' }, `可流转状态（${issue.transitions.length}）`),
                    h(
                      'div',
                      { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
                      issue.transitions.map((t) => {
                        const current = t.statusId === issue.detail.statusId
                        const busy = acting === `status:${t.transformId || t.statusId}`
                        return h(
                          'button',
                          {
                            key: t.statusId,
                            type: 'button',
                            className: `c7n-chip${current ? ' c7n-chip--on' : ''}`,
                            disabled: current || Boolean(acting),
                            onClick: () => onTransition(issue.detail, t),
                            title: current ? '当前状态' : `切到「${t.name}」`,
                            style: current ? {} : { color: TYPE_COLOR[t.type] ?? TOKEN.muted },
                          },
                          busy ? '切换中…' : t.name,
                        )
                      }),
                    ),
                  )
                : null,

              // ---------- 附件 ----------
              h(
                'div',
                { className: 'c7n-section' },
                h(
                  'div',
                  { className: 'c7n-section-title' },
                  h('span', null, `附件${attachments.length ? `（${attachments.length}）` : ''}`),
                  h('span', { style: { flex: 1 } }),
                  h('label', { className: `c7n-btn c7n-btn--sm${attachBusy ? ' c7n-btn--off' : ''}`, style: { cursor: attachBusy ? 'default' : 'pointer' } },
                    attachBusy ? '上传中…' : '上传',
                    h('input', {
                      key: attachInputKey,
                      type: 'file',
                      style: { display: 'none' },
                      disabled: attachBusy,
                      onChange: (event) => {
                        const file = event.target.files?.[0]
                        if (file) uploadAttachment(file)
                      },
                    }),
                  ),
                ),
                attachError ? h('div', { className: 'c7n-banner c7n-banner--error', style: { marginBottom: 8 } }, attachError) : null,
                attachments.length
                  ? h(
                      'div',
                      { style: { display: 'grid', gap: 5 } },
                      attachments.map((row) =>
                        h(
                          'div',
                          { key: row.id, className: 'c7n-file-row' },
                          h('span', { className: 'c7n-file-name', title: `${row.fileName}${row.size ? `（${fileSize(row.size)}）` : ''}` },
                            h('button', {
                              type: 'button',
                              className: 'c7n-linkbtn',
                              onClick: () => openAttachment(row, setAttachError),
                            }, row.fileName)),
                          row.size ? h('span', { className: 'c7n-meta' }, fileSize(row.size)) : null,
                          h(Button, { small: true, ghost: true, disabled: attachBusy, onClick: () => openAttachment(row, setAttachError) }, '下载'),
                          h(Button, { small: true, ghost: true, danger: true, disabled: attachBusy, onClick: () => dropAttachment(row.id) }, '删'),
                        ),
                      ),
                    )
                  : h('div', { className: 'c7n-meta', style: { padding: '4px 0' } }, '还没有附件'),
              ),

              // ---------- 描述 ----------
              h(
                'div',
                { className: 'c7n-section' },
                h('div', { className: 'c7n-section-title' }, '描述'),
                issue.detail.descriptionText
                  ? h(
                      'div',
                      {
                        style: {
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                          fontSize: 12,
                          lineHeight: 1.8,
                          maxHeight: 260,
                          overflowY: 'auto',
                          padding: '10px 12px',
                          borderRadius: 8,
                          border: `1px solid ${TOKEN.line}`,
                          background: TOKEN.surface,
                        },
                      },
                      issue.detail.descriptionText,
                    )
                  : h('div', { className: 'c7n-meta' }, '（没有描述正文）'),
                (issue.detail.descriptionImages ?? []).map((url, index) =>
                  h(DescriptionImage, { key: url, url, index }),
                ),
              ),

              // ---------- 底部动作 ----------
              h(
                'div',
                { className: 'c7n-row', style: { marginTop: 18 } },
                h(Button, { primary: true, onClick: () => setFormOpen(true) }, '创建工作分支 / worktree'),
                h(Button, { onClick: () => onCopy(issue.detail) }, '复制为一条新任务'),
                issue.boundSession?.sessionId
                  ? h(Button, { onClick: () => onOpenSession(issue.boundSession) }, '打开会话')
                  : null,
              ),
              issue.boundSession?.sessionId
                ? h('div', { className: 'c7n-meta', style: { marginTop: 6, fontSize: 11 } },
                    `已绑会话：${issue.boundSession.branch || issue.boundSession.sessionTitle || ''}`)
                : null,

              formOpen
                ? h(BranchForm, {
                    issue: issue.detail,
                    repos,
                    onRepos: setRepos,
                    onClose: () => setFormOpen(false),
                    onCreate: (payload) => onCreateBranch(issue.detail, payload),
                    creating,
                    result,
                    error: creatingError,
                  })
                : null,
              result && !formOpen
                ? h(
                    'div',
                    { className: 'c7n-panel-box', style: { marginTop: 12, fontSize: 12, lineHeight: 1.8 } },
                    h('div', null, `分支：${result.branch}`),
                    h('div', null, `来源：${result.base}`),
                    h('div', { style: { wordBreak: 'break-all' } }, `目录：${result.path}`),
                  )
                : null,
            )
          : null,
        ),
      )
    }

    /** 新建 / 复制工作项：字段来自 /draft（复制时预填来源单），提交走 /issue。 */
    function CreateIssueDialog({ draft, busy, error, users, onClose, onSubmit }) {
      const [summary, setSummary] = useState(draft?.summary ?? '')
      const [description, setDescription] = useState(draft?.description ?? '')
      // 复制时描述正文在宿主侧用来源单的 HTML；只有人改过才覆盖。
      const [descriptionDirty, setDescriptionDirty] = useState(false)
      const [typePick, setTypePick] = useState(draft?.typeId ?? '')
      const [priorityPick, setPriorityPick] = useState(draft?.priorityId ?? '')
      const [assigneePick, setAssigneePick] = useState(draft?.assigneeId ?? '')
      const [estimate, setEstimate] = useState(draft?.estimateTime ?? '')
      const [remaining, setRemaining] = useState(draft?.remainingTime ?? '')
      const [start, setStart] = useState(draft?.estimatedStart ?? '')
      const [end, setEnd] = useState(draft?.estimatedEnd ?? '')
      const [noAssignee, setNoAssignee] = useState(false)
      /** 建单前先传的附件：先传到工作项再挂（实际是先建单再补传，见 submit 注释）。 */
      const [files, setFiles] = useState([])
      const [fileError, setFileError] = useState('')
      /* 模块 / 冲刺 / 报告人：数据来自 /dict，取不到就留空，不挡建单。 */
      const [dict, setDict] = useState(null)
      const [componentPick, setComponentPick] = useState('')
      const [sprintPick, setSprintPick] = useState('')
      const [reporterPick, setReporterPick] = useState('')
      useEffect(() => {
        let alive = true
        api('/dict')
          .then((result) => { if (alive) setDict(result) })
          .catch(() => { if (alive) setDict({ components: [], labels: [], sprints: [], errors: ['字典接口不可用'] }) })
        return () => { alive = false }
      }, [])

      const types = (draft?.types ?? []).map((row) => ({ id: row.id, name: row.name }))
      const priorities = (draft?.priorities ?? []).map((row) => ({ id: row.id, name: row.name }))
      const componentOptions = (dict?.components ?? []).map((row) => ({ id: row.id, name: row.name }))
      const sprintOptions = (dict?.sprints ?? []).map((row) => ({ id: row.id, name: row.name }))

      // 复制来源单时，它的经办人可能不在当前项目成员里：补一条进列表，
      // 否则选择器找不到人会显示成「没选」。选择器按 name 搜，补的这条也一起能搜到。
      const memberOptions = useMemo(() => {
        const list = (users ?? []).map((row) => ({ id: row.id, name: row.name, loginName: row.loginName ?? '' }))
        if (draft?.assigneeId && !list.some((row) => row.id === draft.assigneeId)) {
          list.unshift({ id: draft.assigneeId, name: draft.assigneeName || draft.assigneeId, loginName: '' })
        }
        return list
      }, [users, draft?.assigneeId, draft?.assigneeName])

      const submit = (andOpen) =>
        onSubmit(
          {
            summary: summary.trim(),
            // 复制且没改描述时交给宿主沿用来源单的 HTML，别用纯文本把它盖掉。
            description: draft?.mode === 'copy' && !descriptionDirty ? undefined : description,
            issueTypeId: typePick,
            priorityId: priorityPick,
            assignee: noAssignee ? '' : assigneePick,
            noAssignee,
            estimateTime: estimate === '' ? undefined : Number(estimate),
            remainingTime: remaining === '' ? undefined : Number(remaining),
              estimatedStart: start,
              estimatedEnd: end,
            componentIds: componentPick ? [componentPick] : [],
            sprintId: sprintPick || undefined,
            reporter: reporterPick || undefined,
              copyFrom: draft?.copiedFrom ?? '',
          },
          // 第二个按钮：建完直接打开新单的详情，不用再去看板里找。
          andOpen === true,
          files,
        )

      return h(
        'div',
        {
          style: { position: 'fixed', inset: 0, background: BACKDROP, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 900 },
          onClick: (event) => {
            if (event.target === event.currentTarget) onClose()
          },
        },
        h(
          'div',
          { className: 'c7n-modal', style: { width: 620 } },
          h(
            'div',
            { className: 'c7n-modal-head' },
            h('h2', { className: 'c7n-modal-title' }, draft?.mode === 'copy' ? `按 ${draft.copiedFrom} 复制一条新任务` : '新建任务'),
            h(Button, { onClick: onClose, small: true, ghost: true, icon: true, title: '关闭' }, '✕'),
          ),
          h(Row, { label: '概要' }, h('input', {
            value: summary,
            onChange: (event) => setSummary(event.target.value),
            placeholder: '一句话说清要做什么',
            className: 'c7n-input',
          })),
          h(Row, { label: '类型' }, h(Select, { value: typePick, options: types, placeholder: '选择类型', onChange: setTypePick })),
          h(Row, { label: '优先级' }, h(Select, { value: priorityPick, options: priorities, placeholder: '选择优先级', onChange: setPriorityPick })),
          h(
            Row,
            { label: '经办人' },
            h('div', null,
              h(MemberPicker, {
                value: noAssignee ? '' : assigneePick,
                people: memberOptions,
                loading: !memberOptions.length,
                placeholder: noAssignee ? '不分配' : '选择经办人',
                onChange: (value) => {
                  setNoAssignee(false)
                  setAssigneePick(value)
                },
              }),
              h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 12, color: TOKEN.muted } },
                h('input', {
                  type: 'checkbox',
                  checked: noAssignee,
                  onChange: (event) => setNoAssignee(event.target.checked),
                  style: { accentColor: TOKEN.accent },
                }),
                '不分配经办人',
              ),
            ),
          ),
          h(Row, { label: '模块' },
            h(Select, {
              value: componentPick,
              options: componentOptions,
              placeholder: componentOptions.length ? '不挂模块' : '这个项目没有可用模块',
              onChange: setComponentPick,
            }),
          ),
          h(Row, { label: '冲刺' },
            h(Select, {
              value: sprintPick,
              options: sprintOptions,
              placeholder: sprintOptions.length ? '不挂冲刺' : '没取到可用冲刺',
              onChange: setSprintPick,
            }),
          ),
          h(Row, { label: '报告人' },
            h(MemberPicker, {
              value: reporterPick,
              people: memberOptions,
              loading: !memberOptions.length,
              placeholder: '默认是当前登录人',
              onChange: setReporterPick,
            }),
          ),
          h(Row, { label: '预估工时' }, h('div', { style: { display: 'flex', gap: 8 } },
            h('input', {
              value: estimate,
              onChange: (event) => setEstimate(event.target.value),
              placeholder: '原始预估（小时）',
              className: 'c7n-input',
            }),
            h('input', {
              value: remaining,
              onChange: (event) => setRemaining(event.target.value),
              placeholder: '剩余预估（小时）',
              className: 'c7n-input',
            }),
          )),
          // 计划时间用原生 datetime-local：点一下就是日期时间选择器，不用手敲格式
          h(Row, { label: '计划' }, h('div', { style: { display: 'flex', gap: 8 } },
            h('input', {
              type: 'datetime-local',
              value: toLocalInput(start),
              onChange: (event) => setStart(fromLocalInput(event.target.value)),
              className: 'c7n-input',
              title: '计划开始时间',
            }),
            h('input', {
              type: 'datetime-local',
              value: toLocalInput(end),
              onChange: (event) => setEnd(fromLocalInput(event.target.value)),
              className: 'c7n-input',
              title: '计划结束时间',
            }),
          )),
          // 附件：建单前先选好，提交时随建单一起挂上去
          h(
            'div',
            { style: { marginBottom: 12 } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
              h('span', { style: { color: TOKEN.muted, fontSize: 12 } }, `附件${files.length ? `（${files.length}）` : ''}`),
              h('span', { style: { flex: 1 } }),
              h('label', { className: 'c7n-btn c7n-btn--sm', style: { cursor: 'pointer' } },
                '选择文件',
                h('input', {
                  type: 'file',
                  multiple: true,
                  style: { display: 'none' },
                  onChange: (event) => {
                    const picked = [...(event.target.files ?? [])]
                    if (!picked.length) return
                    // 上限与宿主一致，超了当场说清楚别等提交才报错
                    const tooBig = picked.filter((f) => f.size > ATTACHMENT_LIMIT)
                    if (tooBig.length) {
                      setFileError(`超过 ${fileSize(ATTACHMENT_LIMIT)} 传不了：${tooBig.map((f) => f.name).join('、')}`)
                    } else {
                      setFileError('')
                    }
                    setFiles((current) => [...current, ...picked.filter((f) => f.size <= ATTACHMENT_LIMIT)])
                    event.target.value = ''
                  },
                }),
              ),
            ),
            fileError ? h('div', { style: { color: TOKEN.danger, fontSize: 11, marginBottom: 6 } }, fileError) : null,
            files.length
              ? h('div', { style: { display: 'grid', gap: 4 } },
                  files.map((file, index) =>
                    h('div', { key: `${file.name}-${index}`, className: 'c7n-file-row' },
                      h('span', { className: 'c7n-file-name', title: file.name }, file.name),
                      h('span', { className: 'c7n-meta' }, fileSize(file.size)),
                      h(Button, { small: true, ghost: true, danger: true, onClick: () => setFiles((c) => c.filter((_, i) => i !== index)) }, '移除'),
                    ),
                  ),
                )
              : null,
          ),
          h(
            'div',
            { style: { marginBottom: 12 } },
            h('div', { style: { color: TOKEN.muted, fontSize: 12, marginBottom: 6 } }, '描述'),
            h('textarea', {
              value: description,
              onChange: (event) => {
                setDescriptionDirty(true)
                setDescription(event.target.value)
              },
              rows: 6,
              placeholder: draft?.mode === 'copy' ? '沿用来源单的描述，可以改' : '补充背景、复现步骤或验收口径',
              className: 'c7n-textarea',
            }),
          ),
          error ? h('div', { className: 'c7n-banner c7n-banner--error' }, error) : null,
          h(
            'div',
            { className: 'c7n-row', style: { marginTop: 4 } },
            h(Button, { primary: true, disabled: busy || !summary.trim() || !typePick, onClick: () => submit(false) },
              busy ? '提交中…' : draft?.mode === 'copy' ? '复制这条任务' : '创建任务'),
            // 第二个动作：建完立刻打开新单详情，省掉「回看板再找一遍」。
            h(Button, { disabled: busy || !summary.trim() || !typePick, onClick: () => submit(true) },
              busy ? '提交中…' : draft?.mode === 'copy' ? '复制并打开' : '创建并打开'),
            h(Button, { onClick: onClose }, '取消'),
            h('span', { className: 'c7n-meta' },
              draft?.mode === 'copy' ? '描述里会注明来源单' : '建完直接出现在看板里'),
          ),
        ),
      )
    }

    function searchLabel(hit) {
      const more = hit?.hasMore ? '（已显示前 100 条）' : ''
      return `搜索「${hit?.keyword ?? ''}」命中 ${hit?.total ?? 0} 条${more}`
    }

    /**
     * 打开附件：附件在私有桶里，原始地址会 403，先请宿主换出带签名的临时地址。
     * 预签名地址有时效，所以每次都现换，不缓存。
     */
    async function openAttachment(row, reportError) {
      if (!row?.url) return
      try {
        const query = `/attachment/url?url=${encodeURIComponent(row.url)}&fileName=${encodeURIComponent(row.fileName ?? '')}`
        const got = await api(query)
        if (!got?.url) throw new Error('平台没有返回下载地址')
        window.open?.(got.url, '_blank', 'noopener')
      } catch (failure) {
        if (typeof reportError === 'function') reportError(`下载失败：${failure.message}`)
      }
    }

    /** 猪齿鱼网页端工作项页地址：附件下载、类型变更这类平台才有的操作，从这里过去。 */
    function openIssuePage(num) {
      const value = String(num ?? '').trim()
      if (!value) return
      const origin = String(window?.__CHOERODON_PORTAL__ || 'https://choerodon.com.cn')
      window.open?.(`${origin}/#/agile/work-list/issue?issueNum=${encodeURIComponent(value)}`, '_blank', 'noopener')
    }

    function BoardTab({ state, setError, setNotice, pendingIssue, onPendingHandled }) {
      const [mine, setMine] = useState(true)
      const [board, setBoard] = useState(null)
      const [loading, setLoading] = useState(false)
      const [openId, setOpenId] = useState(null)
      const [issue, setIssue] = useState(null)
      const [issueLoading, setIssueLoading] = useState(false)
      const [issueError, setIssueError] = useState('')
      /** 从通知点进来、但这张单已经不在了：抽屉不开，改为一条明确提示。 */
      const [issueGone, setIssueGone] = useState(false)
      /** 从通知点进来、单已被改派给别人：能正常看，但离开后不在「我的」看板里。 */
      const [issueMoved, setIssueMoved] = useState(null)
      const [worktree, setWorktree] = useState(null)
      const [creating, setCreating] = useState(false)
      const [creatingError, setCreatingError] = useState('')
      const [repoInput, setRepoInput] = useState('')
      const [acting, setActing] = useState('')
      const [epicList, setEpicList] = useState([])
      const [epicSel, setEpicSel] = useState([])
      const [epicOpen, setEpicOpen] = useState(false)
      const [epicQuery, setEpicQuery] = useState('')
      const [epicLoading, setEpicLoading] = useState(false)
      const [userList, setUserList] = useState([])
      const [userSel, setUserSel] = useState([])
      const [userOpen, setUserOpen] = useState(false)
      const [userQuery, setUserQuery] = useState('')
      const [userLoading, setUserLoading] = useState(false)
      const [createDialog, setCreateDialog] = useState(null)
      const [newBusy, setNewBusy] = useState(false)
      const [newError, setNewError] = useState('')
      const [repoOpen, setRepoOpen] = useState(false)
      /* 搜索：关键字非空时走 /search，结果单独一块列出来，不改看板状态。 */
      const [keyword, setKeyword] = useState('')
      const [searching, setSearching] = useState(false)
      const [searchHit, setSearchHit] = useState(null)

      const load = useCallback(
        async (onlyMine, selectedEpicIds, selectedUserIds) => {
          setLoading(true)
          setError('')
          try {
            const epicIds = Array.isArray(selectedEpicIds) ? selectedEpicIds : []
            const userIds = Array.isArray(selectedUserIds) ? selectedUserIds : []
            const query =
              (epicIds.length ? `&epicIds=${encodeURIComponent(epicIds.join(','))}` : '') +
              (userIds.length ? `&assigneeIds=${encodeURIComponent(userIds.join(','))}` : '')
            const next = await api(`/board?mine=${onlyMine ? '1' : '0'}${query}`)
            setBoard(next)
            setRepoInput(next.repoPath ?? '')
          } catch (failure) {
            setError(failure.message)
          } finally {
            setLoading(false)
          }
        },
        [setError],
      )

      useEffect(() => {
        if (state?.loggedIn && state?.projectId) load(mine, epicSel, userSel)
      }, [mine, epicSel, userSel, load, state?.loggedIn, state?.projectId])

      /**
       * 状态机在后台补全后自动重拉看板。
       *
       * 首次打开走快路径（少量采样），可能少几条低频状态的泳道；后台补全完成后
       * /notifications 会带 statusCompleted=true，这里接住它重拉一次。
       */
      useEffect(() => {
        const unsubscribe = badgeStore.subscribe((next) => {
          if (!next?.statusCompleted) return
          if (!state?.loggedIn || !state?.projectId) return
          load(mine, epicSel, userSel)
        })
        return unsubscribe
      }, [load, mine, epicSel, userSel, state?.loggedIn, state?.projectId])

      /* 有关键字就看搜索结果，清空回看板，不覆盖 board 状态。 */
      const runSearch = useCallback(async (value) => {
        const needle = String(value ?? '').trim()
        if (!needle) { setSearchHit(null); return }
        setSearching(true)
        setError('')
        try {
          const result = await api(`/search?keyword=${encodeURIComponent(needle)}&size=100`)
          setSearchHit(result)
        } catch (failure) {
          setError(failure.message)
          setSearchHit(null)
        } finally {
          setSearching(false)
        }
      }, [setError])

      // 史诗与成员目录：登录且选定项目后拉一次；换项目把多选与搜索一并清掉。
      useEffect(() => {
        if (!state?.loggedIn || !state?.projectId) return
        setEpicSel([])
        setEpicQuery('')
        setEpicOpen(false)
        setUserSel([])
        setUserQuery('')
        setUserOpen(false)
        let alive = true
        setEpicLoading(true)
        setUserLoading(true)
        api('/epics')
          .then((result) => {
            if (alive) setEpicList(Array.isArray(result?.epics) ? result.epics : [])
          })
          .catch(() => {})
          .finally(() => {
            if (alive) setEpicLoading(false)
          })
        api('/users')
          .then((result) => {
            if (alive) setUserList(Array.isArray(result?.users) ? result.users : [])
          })
          .catch(() => {})
          .finally(() => {
            if (alive) setUserLoading(false)
          })
        return () => {
          alive = false
        }
      }, [state?.loggedIn, state?.projectId])

      const toggleEpic = useCallback((id) => {
        setEpicSel((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))
      }, [])
      const toggleUser = useCallback((id) => {
        setUserSel((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))
      }, [])
      const sortByCount = useCallback((rows) => [...rows].sort((a, b) => (b.issueCount ?? 0) - (a.issueCount ?? 0)), [])
      const sortByName = useCallback(
        (rows) => [...rows].sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN')),
        [],
      )

      const reloadIssue = useCallback(async (issueId) => {
        if (!issueId) return
        try {
          setIssue(await api(`/issue?id=${encodeURIComponent(issueId)}`))
        } catch (failure) {
          setIssueError(failure.message)
        }
      }, [])

      const openCreate = useCallback(async (copyFrom) => {
        setNewError('')
        setNewBusy(true)
        try {
          const draft = await api(`/draft${copyFrom ? `?copyFrom=${encodeURIComponent(copyFrom)}` : ''}`)
          setCreateDialog({ draft, copyFrom: copyFrom || '' })
        } catch (failure) {
          setError(failure.message)
        } finally {
          setNewBusy(false)
        }
      }, [setError])

      const submitCreate = useCallback(
        async (payload, andOpen = false, attachments = []) => {
          setNewBusy(true)
          setNewError('')
          try {
            const created = await api('/issue', { body: payload })
            // 附件只能在单建好之后挂，所以先建单再逐个补传；传失败不回滚已建的单，
            // 只在提示里说清楚哪几个没上去，人可以到详情里补。
            let attachFailed = []
            if (attachments.length && created?.issueId) {
              for (const file of attachments) {
                try {
                  const contentBase64 = await readFileAsBase64(file)
                  await api('/attachment', {
                    body: {
                      issueId: String(created.issueId),
                      fileName: file.name,
                      contentType: file.type,
                      contentBase64,
                    },
                  })
                } catch {
                  attachFailed.push(file.name)
                }
              }
            }
            setNotice(
              attachFailed.length
                ? `已创建 ${created.num}：${created.summary}，但附件没传上去：${attachFailed.join('、')}`
                : `已创建 ${created.num}：${created.summary}${attachments.length ? `（含 ${attachments.length} 个附件）` : ''}`,
            )
            setCreateDialog(null)
            setOpenId(null)
            load(mine, epicSel, userSel)
            // 「复制并打开」：建完直接把新单的详情拉出来，不用再看板里翻。
            if (andOpen && (created?.issueId || created?.id)) {
              const newId = String(created.issueId || created.id)
              setOpenId(newId)
              setIssue(null)
              setIssueError('')
              setIssueGone(false)
              setIssueLoading(true)
              try {
                setIssue(await api(`/issue?id=${encodeURIComponent(newId)}`))
              } catch (failure) {
                setIssueError(failure.message)
              } finally {
                setIssueLoading(false)
              }
            }
            return created
          } catch (failure) {
            setNewError(failure.message)
            return null
          } finally {
            setNewBusy(false)
          }
        },
        [load, mine, epicSel, userSel, setNotice],
      )

      const addComment = useCallback(
        async (payload) => {
          const result = await api('/comment', { body: payload })
          setNotice(result.mentions?.length ? `评论已发表，并提及 ${result.mentions.join('、')}` : '评论已发表')
          return result
        },
        [setNotice],
      )

      const saveEstimate = useCallback(
        async (payload) => {
          const result = await api('/estimate', { body: payload })
          setNotice(`工时已更新：预估 ${result.estimateTime ?? '-'}／剩余 ${result.remainingTime ?? '-'} 小时`)
          await reloadIssue(payload.issueId)
          load(mine, epicSel, userSel)
          return result
        },
        [load, mine, epicSel, userSel, reloadIssue, setNotice],
      )

      /**
       * 打开一张卡的详情。
       *
       * <p>从「新任务」通知点进来的单可能已经变样：
       * 被别人收回去、改派给别人、或者已经被删掉。所以打开时不仅要拿详情，
       * 还要看它现在是不是还归我 —— 不归我就把「已不在我的看板里」这件事说清楚，
       * 而不是悄悄开一个抽屉、关掉之后又找不到。</p>
       */
      const openIssue = useCallback(
        async (card, options = {}) => {
          setOpenId(card.id)
          setIssue(null)
          setIssueError('')
          setIssueGone(false)
          setWorktree(null)
          setIssueLoading(true)
          try {
            const detail = await api(`/issue?id=${encodeURIComponent(card.id)}`)
            setIssue(detail)
            // 只有从通知进来时才提示改派，平时点自己看板上的卡不必多嘴。
            if (options.fromNotice) {
              const mineId = String(state?.user?.id ?? '')
              const nowAssignee = String(detail?.detail?.assigneeId ?? '')
              if (mineId && nowAssignee && nowAssignee !== mineId) {
                setIssueMoved({
                  name: detail?.detail?.assigneeName || '别人',
                })
              }
            }
          } catch (failure) {
            const message = String(failure?.message ?? '')
            // 平台对「已删除」没有专用错误码，只能从文案认。
            if (/不存在|已被删除|not\s*found|does not exist|error\.issue\.get/i.test(message)) {
              setIssueGone(true)
              setOpenId(null)
            } else {
              setIssueError(message)
            }
          } finally {
            setIssueLoading(false)
          }
        },
        [state?.user?.id],
      )

      /**
       * 从「新任务」通知点了某个编号：打开它的详情。
       * 走的是 openIssue 的 fromNotice 分支，单没了 / 被改派都会各自给出提示。
       */
      useEffect(() => {
        if (!pendingIssue?.id) return
        openIssue({ id: pendingIssue.id, num: pendingIssue.num }, { fromNotice: true })
        onPendingHandled?.()
      }, [pendingIssue, openIssue, onPendingHandled])

      const createBranch = useCallback(
        async (detail, payload) => {
          setCreating(true)
          setCreatingError('')
          setError('')
          try {
            const result = await api('/worktree', {
              body: {
                issueId: detail.id,
                repoPath: payload.repoPath,
                kind: payload.kind,
                baseMode: payload.baseMode,
                customBase: payload.customBase,
                fixedBranch: payload.fixedBranch || '',
                docEnabled: payload.docEnabled,
                docTopic: payload.docTopic || '',
                docName: payload.docName || '',
                assigneeMode: payload.assigneeMode || 'keep',
                assignee: payload.assignee || '',
                advanceStatus: payload.advanceStatus !== false,
              },
            })
            setWorktree(result)
            // 新会话把工作项全文填进输入框，人和模型都从同一份可编辑的文本开始；
            // 复用旧会话不动草稿，免得把正在写的东西冲掉。填草稿要在跳转前就交给
            // seedDraft：空白会话首页不渲染会话头，等它挂上人早把第一条发出去了。
            if (result.sessionId && !result.sessionReused) void seedDraft(String(result.sessionId))
            const jump = result.sessionId ? await jumpToSession(result.sessionId, result.workspaceId) : false
            const parts = [
              result.fixed
                ? `固定分支 ${result.branch}（就地开发）`
                : result.reused ? `已复用分支 ${result.branch}` : `已创建分支 ${result.branch}`,
              result.sessionTitle ? `${result.sessionReused ? '打开已有会话' : '已建会话'}「${result.sessionTitle}」` : null,
              !result.sessionId ? `会话未创建：${result.sessionError || '未知原因'}` : null,
              result.sessionError && result.sessionId ? `会话标题没设上：${result.sessionError}` : null,
              result.directoryError ? `工作目录没切到 worktree：${result.directoryError}` : null,
              result.presetError ? result.presetError : null,
              result.promptError ? `工作项没写进会话：${result.promptError}` : null,
              result.workspaceError ? `工作区未选中：${result.workspaceError}` : null,
              result.sessionId && !jump ? '未能自动跳转，请在侧栏点开它' : null,
              result.binding?.statusNote ? `状态：${result.binding.statusNote}` : null,
              result.binding?.assigneeNote ? result.binding.assigneeNote : null,
              result.binding?.assigneeName ? `经办人：${result.binding.assigneeName}` : null,
              ...(result.warnings ?? []),
            ].filter(Boolean)
            setNotice(parts.join('　'))
            setOpenId(null)
            load(mine, epicSel, userSel)
          } catch (failure) {
            setCreatingError(failure.message)
          } finally {
            setCreating(false)
          }
        },
        [setError, setNotice, load, mine, epicSel, userSel],
      )

      const transition = useCallback(
        async (detail, target) => {
          setActing(`status:${target.transformId || target.statusId}`)
          setIssueError('')
          try {
            const result = await api('/transition', { body: { issueId: detail.id, status: target.name } })
            setIssue(await api(`/issue?id=${encodeURIComponent(detail.id)}`))
            setNotice(result.unchanged ? `状态已经是「${result.status}」` : `状态已切换：${result.from} → ${result.to}`)
            load(mine, epicSel, userSel)
          } catch (failure) {
            setIssueError(failure.message)
          } finally {
            setActing('')
          }
        },
        [load, mine, epicSel, userSel, setNotice],
      )

      const assign = useCallback(
        async (detail, assignee, clear) => {
          setActing('assignee')
          setIssueError('')
          try {
            const result = await api('/assignee', {
              body: { issueId: detail.id, assignee: assignee ?? 'me', clear: clear === true },
            })
            setIssue(await api(`/issue?id=${encodeURIComponent(detail.id)}`))
            setNotice(result.unchanged ? `经办人已经是 ${result.assigneeName}` : `经办人已改为 ${result.assigneeName}`)
            load(mine, epicSel, userSel)
          } catch (failure) {
            setIssueError(failure.message)
          } finally {
            setActing('')
          }
        },
        [load, mine, epicSel, userSel, setNotice],
      )

      const saveRepo = useCallback(async () => {
        setError('')
        try {
          const result = await api('/repo', { body: { path: repoInput } })
          setRepoInput(result.repoPath ?? '')
          setNotice(`仓库已设为 ${result.repoPath}`)
        } catch (failure) {
          setError(failure.message)
        }
      }, [repoInput, setError, setNotice])

      if (!state?.loggedIn) {
        return h('p', { style: { color: TOKEN.muted, fontSize: 13 } }, '请先在「模型接入」里登录猪齿鱼。')
      }

      const lanes = board?.lanes ?? []
      const totalCards = lanes.reduce((sum, lane) => sum + lane.total, 0)

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' } },
        // 从通知点进来的单已经不在了：说清楚，别让人以为是自己点错。
        issueGone
          ? h(
              'div',
              { className: 'c7n-banner c7n-banner--error', style: { marginBottom: 10 } },
              h('strong', null, '这张工作项已经没了'),
              h('span', { style: { flex: 1, minWidth: 0 } },
                '它可能已被删除，或者你对它已经没有查看权限。看板已刷新，可以从列表里另找一条。'),
              h(Button, { small: true, onClick: () => { setIssueGone(false); load(mine, epicSel, userSel) } }, '刷新看板'),
              h(Button, { small: true, ghost: true, onClick: () => setIssueGone(false) }, '知道了'),
            )
          : null,
        // 单被改派给别人：详情照常能看，但提醒一句「关掉之后我的看板里就没有它了」。
        issueMoved
          ? h(
              'div',
              { className: 'c7n-banner', style: { marginBottom: 10 } },
              h('strong', { style: { color: TOKEN.warn } }, '这张单已经不在你名下了'),
              h('span', { style: { flex: 1, minWidth: 0 } },
                `现在经办人是 ${issueMoved.name}。详情可以正常查看，但关掉之后要切到「全部」或该经办人的筛选里才能再找到它。`),
              h(Button, { small: true, onClick: () => { setIssueMoved(null); setMine(false) } }, '改为看全部'),
              h(Button, { small: true, ghost: true, onClick: () => setIssueMoved(null) }, '知道了'),
            )
          : null,
        h(
          'div',
          { className: 'c7n-toolbar' },
          h(
            'div',
            { className: 'c7n-seg' },
            ['我的', '全部'].map((label, index) =>
              h(
                'button',
                {
                  key: label,
                  type: 'button',
                  className: `c7n-seg-item${(index === 0) === mine ? ' c7n-seg-item--on' : ''}`,
                  onClick: () => setMine(index === 0),
                  title: index === 0 ? '只看我经办的（默认）' : '看所有人的，包括别人的',
                },
                label,
              ),
            ),
          ),
          h(
            'div',
            { style: { position: 'relative' } },
            h(
              Button,
              { onClick: () => setEpicOpen((open) => !open), small: true },
              epicSel.length ? `史诗 · ${epicSel.length}` : '史诗',
              h('span', { style: { color: TOKEN.muted, fontSize: 10 } }, '▾'),
            ),
            epicOpen
              ? h(MultiPicker, {
                  list: epicList,
                  selected: epicSel,
                  query: epicQuery,
                  setQuery: setEpicQuery,
                  onToggle: toggleEpic,
                  onClear: () => setEpicSel([]),
                  onClose: () => setEpicOpen(false),
                  loading: epicLoading,
                  searchPlaceholder: '搜索史诗名称',
                  meta: (row) => `${row.issueCount ?? 0}`,
                  sort: sortByCount,
                })
              : null,
          ),
          h(
            'div',
            { style: { position: 'relative' } },
            h(
              Button,
              { onClick: () => setUserOpen((open) => !open), small: true },
              userSel.length ? `经办人 · ${userSel.length}` : '经办人',
              h('span', { style: { color: TOKEN.muted, fontSize: 10 } }, '▾'),
            ),
            userOpen
              ? h(MultiPicker, {
                  list: userList,
                  selected: userSel,
                  query: userQuery,
                  setQuery: setUserQuery,
                  onToggle: toggleUser,
                  onClear: () => setUserSel([]),
                  onClose: () => setUserOpen(false),
                  loading: userLoading,
                  searchPlaceholder: '搜索姓名或工号',
                  sort: sortByName,
                  width: 320,
                })
              : null,
          ),
          board
            ? h('span', { className: 'c7n-meta' }, `${lanes.length} 泳道 · ${totalCards} 项${board.mine ? '' : '（全部）'}`)
            : null,
          h('span', { style: { flex: 1 } }),
          h('input', {
            value: keyword,
            onChange: (e) => {
              setKeyword(e.target.value)
              if (!e.target.value.trim()) setSearchHit(null)
            },
            onKeyDown: (e) => {
              if (e.key === 'Enter') runSearch(keyword)
              if (e.key === 'Escape') { setKeyword(''); setSearchHit(null) }
            },
            placeholder: '搜工作项（回车）',
            className: 'c7n-input',
            style: { width: 190, flex: '0 1 190px' },
            title: '按概要/描述正文搜索；回车执行，Esc 清空',
          }),
          keyword.trim()
            ? h(Button, { onClick: () => runSearch(keyword), disabled: searching, small: true }, searching ? '…' : '搜索')
            : null,
          // 仓库路径折叠成图标按钮，点开才显示输入框，省得常驻占一行
          repoOpen
            ? h('div', { className: 'c7n-row', style: { flexWrap: 'nowrap' } },
                h('input', {
                  value: repoInput,
                  onChange: (e) => setRepoInput(e.target.value),
                  placeholder: '用于建分支的 Git 仓库路径',
                  className: 'c7n-input',
                  style: { flex: '0 1 300px', width: 'auto' },
                }),
                h(Button, { onClick: saveRepo, small: true }, '保存'),
                h(Button, { small: true, ghost: true, icon: true, title: '收起', onClick: () => setRepoOpen(false) }, '✕'),
              )
            : h(Button, { key: 'repo', small: true, ghost: true, onClick: () => setRepoOpen(true), title: '设置建分支用的仓库' }, '仓库'),
          h(Button, { onClick: () => load(mine, epicSel, userSel), disabled: loading, small: true, ghost: true, icon: true, title: '刷新' }, loading ? '…' : '⟳'),
          h(Button, { onClick: () => openCreate(''), disabled: newBusy, small: true, primary: true }, '新建任务'),
        ),
        h(
          'div',
          { style: { display: 'flex', flex: 1, minHeight: 0, gap: 0 } },
          h(
            'div',
            { style: { flex: 1, display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 10, minHeight: 0 } },
            searchHit
              ? (searchHit.items.length
                  ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 320, width: '100%' } },
                      h('div', { className: 'c7n-meta' }, searchLabel(searchHit)),
                      searchHit.items.map((card) =>
                        h('button', {
                          key: card.id,
                          type: 'button',
                          className: 'c7n-notice-row',
                          onClick: () => openIssue(card),
                        },
                          h('span', { className: 'c7n-chip' }, card.num),
                          h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, card.summary),
                          h('span', { style: { color: TOKEN.muted, fontSize: 11 } }, card.statusName || ''),
                        )),
                    )
                  : h('div', { className: 'c7n-empty' }, '没有命中，换个关键字试试'))
              : lanes.length
                ? lanes.map((lane) => h(Lane, { key: lane.id, lane, onOpen: openIssue }))
              : loading
                ? [0, 1, 2, 3].map((key) => h('div', { key, style: { width: 264, flex: '0 0 264px' } }, h('div', { className: 'c7n-skeleton' }), h('div', { className: 'c7n-skeleton' })))
                : h('div', { className: 'c7n-empty' }, '没有可显示的工作项'),
          ),
          openId
            ? h(DetailDrawer, {
                issue,
                loading: issueLoading,
                error: issueError,
                onClose: () => {
                  setOpenId(null)
                  setIssue(null)
                  setWorktree(null)
                  setCreatingError('')
                },
                onCreateBranch: createBranch,
                creating,
                creatingError,
                result: worktree,
                onTransition: transition,
                onAssign: assign,
                acting,
                me: { id: String(state?.user?.id ?? ''), name: state?.user?.realName ?? '' },
                onOpenSession: (bound) => jumpToSession(bound.sessionId, bound.workspaceId),
                onCopy: (detail) => openCreate(detail.num),
                onComment: addComment,
                onEstimate: saveEstimate,
                onLogged: () => load(mine, epicSel, userSel),
                onOpenIssue: (card) => openIssue(card),
              })
            : null,
        ),
        createDialog
          ? h(CreateIssueDialog, {
              draft: createDialog.draft,
              busy: newBusy,
              error: newError,
              users: userList,
              onClose: () => {
                setCreateDialog(null)
                setNewError('')
              },
              onSubmit: submitCreate,
            })
          : null,
      )
    }

    // ---------- 主面板 ----------

    function ChoerodonPanel() {
      const [tab, setTab] = useState('access')
      const [state, setState] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')

      const refresh = useCallback(async () => {
        try {
          setState(await api('/state'))
        } catch (failure) {
          setError(failure.message)
        }
      }, [])

      useEffect(() => {
        refresh()
      }, [refresh])

      // 面板里的「新任务」提示条：跟侧栏角标用同一份轮询结果，不重复打接口。
      const [badge, setBadge] = useState(badgeStore.get())
      useEffect(() => badgeStore.subscribe(setBadge), [])
      const [ackBusy, setAckBusy] = useState(false)
      /** 从通知里点某条工作项后，交给看板去打开它的详情。 */
      const [pendingIssue, setPendingIssue] = useState(null)
      /**
       * 新任务弹窗：横幅只显示条数和前几条，完整列表在弹窗里滚。
       * 分了 100 条也不会把面板撑长。
       */
      const [noticeOpen, setNoticeOpen] = useState(false)
      const [noticeList, setNoticeList] = useState(null)
      const [noticeBusy, setNoticeBusy] = useState(false)
      const [noticeError, setNoticeError] = useState('')
      const [noticeQuery, setNoticeQuery] = useState('')

      const openNotice = useCallback(async () => {
        setNoticeOpen(true)
        setNoticeBusy(true)
        setNoticeError('')
        setNoticeQuery('')
        try {
          // all=1 取全量（宿主上限 500），弹窗里滚动查看
          setNoticeList(await api('/new-tasks?all=1'))
        } catch (failure) {
          setNoticeError(failure.message)
        } finally {
          setNoticeBusy(false)
        }
      }, [])

      /** 从弹窗点一条：关掉弹窗 → 切到看板 → 打开这条的详情。 */
      const openNoticeIssue = useCallback((row) => {
        setNoticeOpen(false)
        setTab('board')
        setPendingIssue({ id: row.id, num: row.num })
      }, [])

      const acknowledge = useCallback(async () => {
        setAckBusy(true)
        try {
          await api('/new-tasks?ack=1')
          await pollBadge()
          setNoticeOpen(false)
          setNoticeList(null)
        } catch (failure) {
          setError(failure.message)
        } finally {
          setAckBusy(false)
        }
      }, [])

      const tabs = useMemo(
        () => [
          ['access', '模型接入'],
          ['board', '任务看板'],
        ],
        [],
      )

      return h(
        'div',
        {
          className: 'c7n-root',
          style: { height: '100%', display: 'flex', flexDirection: 'column', padding: '18px 22px 0', minHeight: 0 },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' } },
          h(
            'div',
            { style: { minWidth: 0 } },
            h('h1', { className: 'c7n-page-title' }, '猪齿鱼'),
            h('p', { className: 'c7n-page-sub' },
              '接入项目模型、按看板收任务；点开卡片能查操作记录、登工时、建分支开会话。'),
          ),
          h(
            'div',
            { className: 'c7n-row', style: { flexWrap: 'nowrap', paddingTop: 4 } },
            h(Button, { small: true, ghost: true, onClick: refresh, title: '刷新状态' }, '刷新'),
          ),
        ),
        h(
          'div',
          { className: 'c7n-tabs', style: { borderBottom: `1px solid ${TOKEN.line}`, marginBottom: 14 } },
          tabs.map(([key, label, count]) =>
            h(
              'button',
              {
                key,
                type: 'button',
                className: `c7n-tab${tab === key ? ' c7n-tab--on' : ''}`,
                onClick: () => setTab(key),
              },
              label,
              count ? h('span', { className: 'c7n-tab-badge' }, String(count)) : null,
            ),
          ),
        ),
        error ? h('div', { className: 'c7n-banner c7n-banner--error' }, error) : null,
        // 宿主是旧进程时，新功能必然全挂；与其让人一条条撞 404，不如一次说清。
        state && state.host && !(state.host.features ?? []).includes('attachment')
          ? h(
              'div',
              { className: 'c7n-banner c7n-banner--error', style: { alignItems: 'flex-start' } },
              h('strong', null, '插件版本不匹配'),
              h(
                'span',
                { style: { flex: 1, minWidth: 0 } },
                `界面是新的，但运行中的 DSH 还加载着旧插件（宿主 ${state.host.version ?? '未知'}）。` +
                  '登记工时、操作记录、新任务角标都要重启 DSH 才会工作。',
              ),
              h(Button, { small: true, onClick: refresh }, '我再刷一下'),
            )
          : null,
        notice ? h('div', { className: 'c7n-banner c7n-banner--ok' }, notice) : null,
        badge.count
          ? h(
              'div',
              { className: 'c7n-banner' },
              // 横幅只报数，完整列表在弹窗里：分 100 条也不会把面板撑长。
              h('strong', { style: { color: TOKEN.accent, flex: '0 0 auto' } }, `有新任务（${badge.count}）`),
              h(
                'span',
                { style: { flex: 1, minWidth: 0, color: TOKEN.muted, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                (badge.items ?? []).slice(0, 3).map((row) => row.num).join('、') +
                  (badge.count > 3 ? ` 等 ${badge.count} 条` : ''),
              ),
              h(Button, { small: true, onClick: openNotice }, '查看列表'),
              h(Button, { small: true, onClick: () => setTab('board') }, '去看板'),
              h(Button, { small: true, primary: true, disabled: ackBusy, onClick: acknowledge }, ackBusy ? '处理中…' : '全部已知'),
            )
          : null,
        h(
          'div',
          { style: { flex: 1, minHeight: 0, overflowY: tab === 'board' ? 'hidden' : 'auto', display: 'flex', flexDirection: 'column', paddingBottom: 16 } },
          tab === 'access'
            ? h(AccessTab, { state, refresh, setError, setNotice, busy, setBusy })
            : h(BoardTab, { state, setError, setNotice, pendingIssue, onPendingHandled: () => setPendingIssue(null) }),
        ),
        // 新任务弹窗：完整列表在这里滚，点一条就关弹窗、开详情。
        noticeOpen
          ? h(
              'div',
              {
                style: { position: 'fixed', inset: 0, background: BACKDROP, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 900 },
                onClick: (event) => {
                  if (event.target === event.currentTarget) setNoticeOpen(false)
                },
              },
              h(
                'div',
                { className: 'c7n-modal', style: { width: 680, display: 'flex', flexDirection: 'column', maxHeight: '78vh' } },
                h(
                  'div',
                  { className: 'c7n-modal-head', style: { marginBottom: 10 } },
                  h('h2', { className: 'c7n-modal-title' },
                    `新任务${noticeList ? `（${noticeList.count ?? 0}）` : badge.count ? `（${badge.count}）` : ''}`),
                  h(Button, { small: true, ghost: true, icon: true, title: '关闭', onClick: () => setNoticeOpen(false) }, '✕'),
                ),
                h(
                  'div',
                  { className: 'c7n-row', style: { marginBottom: 10, flexWrap: 'nowrap' } },
                  h('input', {
                    value: noticeQuery,
                    onChange: (event) => setNoticeQuery(event.target.value),
                    placeholder: '搜编号或概要',
                    className: 'c7n-input',
                  }),
                  h(Button, { small: true, primary: true, disabled: ackBusy || !badge.count, onClick: acknowledge },
                    ackBusy ? '处理中…' : '全部已知'),
                ),
                noticeError ? h('div', { className: 'c7n-banner c7n-banner--error' }, noticeError) : null,
                h(
                  'div',
                  { style: { flex: 1, minHeight: 0, overflowY: 'auto', display: 'grid', gap: 6, paddingRight: 2 } },
                  noticeBusy
                    ? [0, 1, 2, 3].map((key) => h('div', { key, className: 'c7n-skeleton', style: { height: 40 } }))
                    : (() => {
                        const needle = noticeQuery.trim().toLowerCase()
                        const rows = (noticeList?.items ?? []).filter(
                          (row) =>
                            !needle ||
                            String(row.num ?? '').toLowerCase().includes(needle) ||
                            String(row.summary ?? '').toLowerCase().includes(needle),
                        )
                        if (!rows.length) {
                          return h('div', { className: 'c7n-empty' },
                            noticeList?.items?.length ? '没有匹配的任务' : '没有新任务了')
                        }
                        return rows.map((row) =>
                          h(
                            'button',
                            {
                              key: row.id ?? row.num,
                              type: 'button',
                              className: 'c7n-notice-row',
                              title: row.summary || row.num,
                              onClick: () => openNoticeIssue(row),
                            },
                            h('span', { style: { fontWeight: 650, flex: '0 0 auto' } }, row.num),
                            h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                              row.summary || '（无概要）'),
                            row.status
                              ? h('span', { className: 'c7n-chip', style: { height: 18, fontSize: 10.5, padding: '0 7px', cursor: 'default', flex: '0 0 auto' } }, row.status)
                              : null,
                            h('span', { style: { color: TOKEN.accent, fontSize: 12, flex: '0 0 auto' } }, '打开 ›'),
                          ),
                        )
                      })(),
                ),
                noticeList?.truncated
                  ? h('div', { className: 'c7n-meta', style: { marginTop: 8 } }, `还有 ${noticeList.truncated} 条没列出，先去「全部已知」再看）`)
                  : null,
              ),
            )
          : null,
      )
    }

    /**
     * 会话头右上角的「本次工作项」入口。
     *
     * 从猪齿鱼开的会话，在用户发出第一条消息之前日志里没有任何可展示的节点 ——
     * Host 把工作项全文先放进 inbox（模型看得到、界面看不到），所以打开会话是白的。
     * 摘要走 Host 另存的那份，入口放在会话工具的右上角，点开是浮层全文；
     * 不再在输入框上方压一条卡片。
     */
    function SessionBriefChip({ sessionId }) {
      const [brief, setBrief] = useState(null)
      const [open, setOpen] = useState(false)
      useEffect(() => {
        if (!sessionId) {
          setBrief(null)
          setOpen(false)
          return undefined
        }
        let alive = true
        api(`/session-brief?sessionId=${encodeURIComponent(String(sessionId))}`)
          .then((data) => {
            // 这里只负责显示摘要；填草稿是建会话那一步的事（seedDraft），
            // 会话头在空白首页根本不渲染，挂在这里会晚一步。
            if (alive) setBrief(data?.brief ?? null)
          })
          .catch(() => {
            // 没登录或宿主还是旧代码时安静降级：这块只是补充说明，不该挡住会话本身。
            if (alive) setBrief(null)
          })
        return () => {
          alive = false
        }
      }, [sessionId])
      useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open])
      if (!brief) return null
      const heading = [brief.num, brief.summary].filter(Boolean).join(' ')
      const copy = () => {
        void navigator.clipboard?.writeText(brief.kickoff)
      }
      return h(
        React.Fragment,
        null,
        h(
          'button',
          {
            type: 'button',
            className: 'c7n-brief-chip',
            title: heading || '本次工作项',
            'aria-expanded': open,
            onClick: () => setOpen((value) => !value),
          },
          h('span', { className: 'c7n-brief-dot' }),
          h('span', { className: 'c7n-brief-chip-num' }, brief.num || '工作项'),
        ),
        open
          ? h(
            React.Fragment,
            null,
            h('div', { className: 'c7n-brief-backdrop', onClick: () => setOpen(false) }),
            h(
              'div',
              { className: 'c7n-brief-pop', role: 'dialog', 'aria-label': heading || '本次工作项' },
              h(
                'div',
                { className: 'c7n-brief-pop-head' },
                h('span', { className: 'c7n-brief-pop-title', title: heading }, heading || '（无概要）'),
                h('button', { type: 'button', className: 'c7n-brief-action', onClick: copy }, '复制'),
                h('button', { type: 'button', className: 'c7n-brief-action', onClick: () => setOpen(false) }, '关闭'),
              ),
              h('pre', { className: 'c7n-brief-pop-body' }, brief.kickoff),
            ),
          )
          : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        clientCtx = ctx
        // 样式表必须先挂：下面所有组件都靠 c7n- 类名，取消注册时一起收回。
        ctx.effect(() => installStyles())
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: 'choerodon', order: 40, label: '猪齿鱼' }, Mark),
        )
        // 行尾角标：有新任务时显示 (n)，收起态显示小红点。
        ctx.slots.inject('sidebar.panellist.trailing', () =>
          ctx.slots.register({ name: 'sidebar.panellist.trailing', id: 'choerodon', order: 0 }, TaskBadge),
        )
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'choerodon' }, ChoerodonPanel))
        // 会话头右上角的工作项入口：从猪齿鱼建的会话一打开就能点开看任务本身。
        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            { name: 'conversation.session.header.utilities', id: 'choerodon-brief', order: 20, label: '本次工作项' },
            SessionBriefChip,
          ),
        )

        // 轮询：60 秒一次，页面隐藏时跳过，卸载时清掉。
        let timer = null
        ctx.effect(() => {
          const tick = () => {
            if (typeof document !== 'undefined' && document.hidden) return
            pollBadge()
          }
          pollBadge()
          timer = setInterval(tick, 60_000)
          const onVisible = () => {
            if (typeof document !== 'undefined' && !document.hidden) pollBadge()
          }
          document.addEventListener('visibilitychange', onVisible)
          return () => {
            if (timer) clearInterval(timer)
            document.removeEventListener('visibilitychange', onVisible)
          }
        })
      },
    }
  },
})
