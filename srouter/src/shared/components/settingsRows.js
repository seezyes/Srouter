"use client";

// Import directly rather than pulling in the shared component barrel.
import Card from "./Card.js";
import Toggle from "./Toggle.js";

/**
 * The small presentational rows the developer settings pages are built from.
 *
 * Reusable rows for settings surfaces.
 * They are pure markup with no state of their own.
 */

export function Section({ icon, tint, title, subtitle, children, action }) {
  return (
    <Card>
      <div className="flex items-start justify-between gap-4 mb-5">
        <div className="flex items-center gap-3 min-w-0">
          <div className={`p-2 rounded-lg shrink-0 ${tint}`}>
            <span className="material-symbols-outlined text-[20px]">{icon}</span>
          </div>
          <div className="min-w-0">
            <h3 className="text-base sm:text-lg font-semibold">{title}</h3>
            {subtitle ? <p className="text-xs sm:text-sm text-text-muted">{subtitle}</p> : null}
          </div>
        </div>
        {action}
      </div>
      <div className="flex flex-col gap-5">{children}</div>
    </Card>
  );
}

export function ColorRow({ label, value, onChange, hint }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-text-main">{label}</p>
        {hint ? <p className="text-xs text-text-muted">{hint}</p> : null}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <code className="text-xs font-mono text-text-muted">{value}</code>
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 w-12 rounded-md border border-border bg-transparent cursor-pointer"
        />
      </div>
    </div>
  );
}

export function SliderRow({ label, value, min, max, step, onChange, display, hint, disabled }) {
  return (
    <div className={`flex flex-col gap-1.5 ${disabled ? "opacity-50" : ""}`}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-text-main">{label}</p>
        <code className="text-xs font-mono text-text-muted tabular-nums">
          {display ?? value}
        </code>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full cursor-pointer disabled:cursor-not-allowed"
      />
      {hint ? <p className="text-xs text-text-muted">{hint}</p> : null}
    </div>
  );
}

export function ToggleRow({ label, hint, checked, onChange }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-text-main">{label}</p>
        {hint ? <p className="text-xs text-text-muted">{hint}</p> : null}
      </div>
      <Toggle checked={checked} onChange={onChange} />
    </div>
  );
}

export function TextRow({ label, value, onChange, hint, mono = true, disabled }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-sm font-medium text-text-main">{label}</p>
      <input
        type="text"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm text-text-main focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50 ${mono ? "font-mono" : ""}`}
      />
      {hint ? <p className="text-xs text-text-muted">{hint}</p> : null}
    </div>
  );
}
