// App-wide overlays: modal dialog, context menu, toasts. All in-app; no
// native alert/confirm, which would block the webview.

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useStore } from "../store";
import { IconClose } from "./Icons";

export function Dialog() {
  const dialog = useStore((s) => s.dialog);
  const closeDialog = useStore((s) => s.closeDialog);
  const [value, setValue] = useState("");
  const [checked, setChecked] = useState(false);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!dialog) return;
    if (dialog.kind === "prompt") {
      setValue(dialog.initial ?? "");
      setChecked(dialog.checkbox?.initial ?? false);
      setText("");
      setTimeout(() => inputRef.current?.select(), 0);
    } else {
      setTimeout(() => okRef.current?.focus(), 0);
    }
  }, [dialog]);

  if (!dialog) return null;

  const submit = () => {
    if (dialog.kind === "prompt") dialog.resolve({ value, checked, text });
    else dialog.resolve(true);
  };

  return (
    <div className="modal-backdrop" onMouseDown={closeDialog}>
      <form
        className="modal"
        role="dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            closeDialog();
          }
        }}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="modal-title">{dialog.title}</div>
        {dialog.kind === "confirm" ? (
          <p className="modal-message">{dialog.message}</p>
        ) : (
          <>
            {dialog.label && <label className="modal-label">{dialog.label}</label>}
            <input ref={inputRef} value={value} placeholder={dialog.placeholder} onChange={(e) => setValue(e.target.value)} />
            {dialog.textarea && (
              <>
                <label className="modal-label">{dialog.textarea.label}</label>
                <textarea rows={3} value={text} placeholder={dialog.textarea.placeholder} onChange={(e) => setText(e.target.value)} />
              </>
            )}
            {dialog.checkbox && (
              <label className="checkbox">
                <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
                {dialog.checkbox.label}
              </label>
            )}
          </>
        )}
        <div className="modal-actions">
          <button type="button" className="small-btn" onClick={closeDialog}>
            Cancel
          </button>
          <button
            ref={okRef}
            type="submit"
            className={`small-btn primary${dialog.kind === "confirm" && dialog.danger ? " danger-fill" : ""}`}
            disabled={dialog.kind === "prompt" && !dialog.allowEmpty && !value.trim()}
          >
            {dialog.confirmLabel ?? "OK"}
          </button>
        </div>
      </form>
    </div>
  );
}

export function ContextMenu() {
  const menu = useStore((s) => s.menu);
  const closeMenu = useStore((s) => s.closeMenu);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  // Keep the menu on screen.
  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(menu.x, window.innerWidth - r.width - 4)),
      y: Math.max(4, Math.min(menu.y, window.innerHeight - r.height - 4)),
    });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeMenu();
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", closeMenu);
    window.addEventListener("resize", closeMenu);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", closeMenu);
      window.removeEventListener("resize", closeMenu);
    };
  }, [menu, closeMenu]);

  if (!menu) return null;
  return (
    <div
      className="menu-backdrop"
      onMouseDown={closeMenu}
      onContextMenu={(e) => {
        e.preventDefault();
        closeMenu();
      }}
    >
      <div ref={ref} className="menu" role="menu" style={{ left: pos.x, top: pos.y }} onMouseDown={(e) => e.stopPropagation()}>
        {menu.items.map((item, i) =>
          item.separator ? (
            <div key={i} className="menu-sep" />
          ) : (
            <button
              key={i}
              role="menuitem"
              className={`menu-item${item.danger ? " danger" : ""}`}
              disabled={item.disabled}
              onClick={() => {
                closeMenu();
                item.onSelect?.();
              }}
            >
              <span>{item.label}</span>
              {item.hint && <span className="menu-hint">{item.hint}</span>}
            </button>
          ),
        )}
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} role={t.kind === "error" ? "alert" : "status"}>
          <pre>{t.text}</pre>
          <button className="icon-btn" onClick={() => dismiss(t.id)}>
            <IconClose size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
