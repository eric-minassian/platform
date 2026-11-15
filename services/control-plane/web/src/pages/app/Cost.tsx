import { useQuery } from '@tanstack/react-query';
import { api } from '../../api.ts';
import { Bars, SERIES_COLORS } from '../../components/charts.tsx';
import { Card, Loaded, Stat } from '../../components/ui.tsx';
import { fmtUsd } from '../../format.ts';
import { useApp } from '../AppLayout.tsx';

export function CostTab() {
  const { app } = useApp();
  const q = useQuery({ queryKey: ['cost', app], queryFn: () => api.cost(app, 35), staleTime: 60 * 60_000 });
  return (
    <Loaded q={q}>
      {(c) => {
        const last7 = c.days.slice(-7).reduce((a, d) => a + d.usd, 0);
        return (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              <Stat label="Month to date" value={fmtUsd(c.monthToDateUsd)} />
              <Stat label="Last 7 days" value={fmtUsd(last7)} />
              <Stat
                label="Daily average"
                value={fmtUsd(c.days.length ? c.days.reduce((a, d) => a + d.usd, 0) / c.days.length : 0)}
              />
            </div>
            <Card title="Daily cost (tagged platform:app)">
              <Bars
                data={c.days.map((d) => ({ ...d, ts: d.date }))}
                range="35d"
                format={(v) => fmtUsd(v)}
                series={[{ key: 'usd', label: 'USD', color: SERIES_COLORS.value }]}
              />
              <p className="pt-2 text-[11px] text-muted">
                From Cost Explorer, refreshed daily. Shared platform resources (router, tables, buckets)
                appear under Admin.
              </p>
            </Card>
          </div>
        );
      }}
    </Loaded>
  );
}
