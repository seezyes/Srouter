import { UPSTREAM_LINES, UPSTREAM_LINES_NOTE, formatUpstreamLine } from "@/shared/constants/config";

/**
 * The upstream lines Srouter is built on, rendered under its own version.
 * Each number is the last upstream release merged in full; the trailing "+++"
 * says that newer upstream releases have been ported only partially since.
 */
export default function UpstreamLines() {
  return (
    <div
      className="flex flex-col gap-0.5"
      title="+++ means newer upstream versions were partially incorporated"
    >
      <span className="text-[10px] tracking-wide text-text-muted/70">
        {UPSTREAM_LINES_NOTE}
      </span>
      {UPSTREAM_LINES.map((line) => (
        <span key={line.name} className="text-[11px] leading-tight text-text-muted">
          {formatUpstreamLine(line)}
        </span>
      ))}
    </div>
  );
}
