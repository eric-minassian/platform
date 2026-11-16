/**
 * A trend in a table cell or a figure: a small line with a faint area and
 * its last value marked. Plain SVG: tables can hold dozens of these, and
 * they need no axes, focus or tooltip.
 */
export function Sparkline({
  values,
  width = 88,
  height = 24,
  color = 'var(--chart-1)',
  label,
}: {
  values: ReadonlyArray<number | null>;
  width?: number;
  height?: number;
  color?: string;
  /** What it shows, for screen readers; omitted when the figure beside it says it. */
  label?: string;
}) {
  const points = values.map((v) => (v === null || !Number.isFinite(v) ? null : v));
  const max = Math.max(0, ...points.filter((v): v is number => v !== null));
  if (points.length < 2) return <svg width={width} height={height} aria-hidden />;
  const step = width / (points.length - 1);
  const y = (v: number) => height - 2 - (max > 0 ? ((height - 4) * v) / max : 0);
  let line = '';
  let pen = false;
  points.forEach((v, i) => {
    if (v === null) {
      pen = false;
      return;
    }
    line += `${pen ? 'L' : 'M'}${(i * step).toFixed(1)} ${y(v).toFixed(1)}`;
    pen = true;
  });
  const lastIndex = points.findLastIndex((v) => v !== null);
  const last = lastIndex >= 0 ? points[lastIndex] : null;
  const firstIndex = points.findIndex((v) => v !== null);
  const area =
    firstIndex >= 0 && lastIndex > firstIndex
      ? `${line}L${(lastIndex * step).toFixed(1)} ${height}L${(firstIndex * step).toFixed(1)} ${height}Z`
      : '';
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="overflow-visible"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {area && <path d={area} fill={color} fillOpacity={0.14} />}
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {last !== null && last !== undefined && (
        <circle cx={lastIndex * step} cy={y(last)} r={2.25} fill={color} />
      )}
    </svg>
  );
}
