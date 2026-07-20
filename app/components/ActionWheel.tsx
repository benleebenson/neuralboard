"use client";

import type { CSSProperties } from "react";

export type ActionWheelItem = {
  label: string;
  icon?: string;
  disabled?: boolean;
  onSelect: () => void;
};

export function ActionWheel({ open, items, onDismiss, menuOpen, menuItems }: {
  open: boolean;
  items: ActionWheelItem[];
  onDismiss: () => void;
  menuOpen: boolean;
  menuItems: ActionWheelItem[];
}) {
  if (!open) return null;
  return (
    <div
      data-action-wheel-overlay
      onPointerDown={(event) => { if (event.target === event.currentTarget) onDismiss(); }}
      style={{ position: "fixed", inset: 0, zIndex: 10030, display: "grid", placeItems: "center", background: "rgba(17,17,17,.42)", fontFamily: "'Patrick Hand', cursive", touchAction: "manipulation" }}
    >
      <div data-action-wheel style={{ position: "relative", width: "min(70vmin, 360px)", aspectRatio: "1", borderRadius: "48% 52% 50% 47%", border: "3px solid #2a2a2a", background: "rgba(255,253,245,.96)", boxShadow: "5px 6px 0 rgba(42,42,42,.8)", transform: "rotate(-.4deg)" }}>
        {items.map((item, index) => {
          const angle = -Math.PI / 2 + index * Math.PI * 2 / items.length;
          const radius = 36;
          return <button key={item.label} type="button" disabled={item.disabled} onClick={() => { if (!item.disabled) item.onSelect(); }} style={{ ...slot, left: `${50 + Math.cos(angle) * radius}%`, top: `${50 + Math.sin(angle) * radius}%`, opacity: item.disabled ? .38 : 1, cursor: item.disabled ? "not-allowed" : "pointer" }}>
            <span aria-hidden="true" style={{ fontSize: 22, lineHeight: 1 }}>{item.icon}</span>
            <span>{item.label}</span>
            {item.disabled && <small style={{ fontSize: 11 }}>soon</small>}
          </button>;
        })}
        <button type="button" aria-label="Close action wheel" onClick={onDismiss} style={{ position: "absolute", left: "50%", top: "50%", translate: "-50% -50%", width: "27%", aspectRatio: "1", borderRadius: "50% 47% 52% 48%", border: "2px solid #2a2a2a", background: "#f4b942", font: "700 clamp(15px, 4vmin, 21px) 'Patrick Hand', cursive", cursor: "pointer", boxShadow: "2px 3px 0 #2a2a2a" }}>MENU</button>
        {menuOpen && <div data-action-wheel-menu style={{ position: "absolute", left: "50%", top: "50%", translate: "-50% -50%", width: "58%", padding: 10, border: "2px solid #2a2a2a", background: "#fffdf5", boxShadow: "3px 4px 0 #2a2a2a", zIndex: 2, transform: "rotate(.4deg)" }}>
          {menuItems.map((item) => <button key={item.label} type="button" disabled={item.disabled} onClick={() => { if (!item.disabled) item.onSelect(); }} style={{ width: "100%", padding: "7px 8px", border: 0, borderBottom: "1px dashed rgba(42,42,42,.45)", background: "transparent", font: "700 17px 'Patrick Hand', cursive", textAlign: "left", cursor: item.disabled ? "not-allowed" : "pointer", opacity: item.disabled ? .4 : 1 }}>{item.icon} {item.label}</button>)}
          <button type="button" onClick={onDismiss} style={{ width: "100%", marginTop: 6, padding: 5, border: "1.5px solid #2a2a2a", background: "#f4b942", font: "700 16px 'Patrick Hand', cursive", cursor: "pointer" }}>Close</button>
        </div>}
      </div>
    </div>
  );
}

export const wheelTriggerStyle: CSSProperties = { position: "fixed", right: "max(18px, env(safe-area-inset-right))", bottom: "max(22px, calc(env(safe-area-inset-bottom) + 18px))", zIndex: 10020, width: 48, height: 48, borderRadius: "47% 53% 49% 51%", border: "2px solid #2a2a2a", background: "#f4b942", boxShadow: "3px 4px 0 #2a2a2a", font: "700 25px 'Patrick Hand', cursive", cursor: "pointer" };

const slot: CSSProperties = { position: "absolute", translate: "-50% -50%", width: "28%", minHeight: "22%", border: "1.5px dashed #2a2a2a", borderRadius: "46% 54% 49% 51%", background: "#fffdf5", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", font: "700 clamp(13px, 3.5vmin, 18px) 'Patrick Hand', cursive", lineHeight: 1 };
