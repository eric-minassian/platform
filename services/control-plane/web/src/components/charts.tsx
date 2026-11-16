import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { fmtDateTime, tickFormatter } from '../format.ts';

export const SERIES_COLORS = {
  s2xx: 'var(--ok)',
  s3xx: 'var(--info)',
  s4xx: 'var(--warn)',
  s5xx: 'var(--bad)',
  p50: 'var(--info)',
  p95: 'var(--accent)',
  p99: 'var(--bad)',
  value: 'var(--accent)',
  cpu: 'var(--info)',
  memory: 'var(--accent)',
} as const;

export interface Series {
  key: string;
  label: string;
  color: string;
}

interface ChartProps {
  data: Array<Record<string, unknown>>;
  series: Series[];
  range: string;
  height?: number;
  format?: (v: number) => string;
  xKey?: string;
  /** Y-axis domain; e.g. a minimum top so an all-zero rate doesn't auto-scale to 0–400%. */
  yDomain?: [number, number | ((dataMax: number) => number)];
}

const axis = { stroke: 'var(--border)', tickLine: false, axisLine: false } as const;

function Frame({ height, children }: { height: number; children: React.ReactElement }) {
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </div>
  );
}

const tooltip = (format?: (v: number) => string) => (
  <Tooltip
    labelFormatter={(l) => (typeof l === 'string' || typeof l === 'number' ? fmtDateTime(l) : l)}
    formatter={(v) => (format && typeof v === 'number' ? format(v) : String(v))}
    cursor={{ stroke: 'var(--muted)', strokeOpacity: 0.3 }}
    contentStyle={{
      background: 'var(--panel)',
      border: '1px solid var(--border)',
      borderRadius: 6,
      fontSize: 12,
    }}
  />
);

export function StackedArea({ data, series, range, height = 180, format, xKey = 'ts', yDomain }: ChartProps) {
  return (
    <Frame height={height}>
      <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="var(--grid)" vertical={false} />
        <XAxis dataKey={xKey} tickFormatter={tickFormatter(range)} minTickGap={48} {...axis} />
        <YAxis width={44} tickFormatter={format} domain={yDomain ?? [0, 'auto']} {...axis} />
        {tooltip(format)}
        <Legend iconType="circle" iconSize={7} wrapperStyle={{ fontSize: 11 }} />
        {series.map((s) => (
          <Area
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.label}
            stackId="1"
            stroke={s.color}
            fill={s.color}
            fillOpacity={0.25}
            strokeWidth={1.25}
            isAnimationActive={false}
          />
        ))}
      </AreaChart>
    </Frame>
  );
}

export function Lines({ data, series, range, height = 180, format, xKey = 'ts', yDomain }: ChartProps) {
  return (
    <Frame height={height}>
      <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="var(--grid)" vertical={false} />
        <XAxis dataKey={xKey} tickFormatter={tickFormatter(range)} minTickGap={48} {...axis} />
        <YAxis width={44} tickFormatter={format} domain={yDomain ?? [0, 'auto']} {...axis} />
        {tooltip(format)}
        <Legend iconType="circle" iconSize={7} wrapperStyle={{ fontSize: 11 }} />
        {series.map((s) => (
          <Line
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.label}
            stroke={s.color}
            dot={false}
            strokeWidth={1.5}
            connectNulls
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </Frame>
  );
}

export function Bars({ data, series, range, height = 180, format, xKey = 'ts', yDomain }: ChartProps) {
  return (
    <Frame height={height}>
      <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="var(--grid)" vertical={false} />
        <XAxis dataKey={xKey} tickFormatter={tickFormatter(range)} minTickGap={32} {...axis} />
        <YAxis width={44} tickFormatter={format} domain={yDomain ?? [0, 'auto']} {...axis} />
        {tooltip(format)}
        {series.map((s) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.label}
            fill={s.color}
            radius={[2, 2, 0, 0]}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </Frame>
  );
}
