import { CronExpressionParser } from 'cron-parser';

/**
 * Local stand-in for EventBridge Scheduler (the emulator creates schedules but
 * never fires them). Same expressions as plat.config.ts: 5-field cron in UTC
 * (or the cron's timezone) or `rate(n unit)`.
 */
export interface LocalCron {
  name: string;
  schedule: string;
  timezone?: string;
}

export function nextRun(cron: LocalCron, from = new Date()): Date {
  const rate = /^rate\(\s*(\d+)\s+(minute|minutes|hour|hours|day|days)\s*\)$/.exec(cron.schedule.trim());
  if (rate) {
    const unit = rate[2]!.startsWith('minute')
      ? 60_000
      : rate[2]!.startsWith('hour')
        ? 3_600_000
        : 86_400_000;
    return new Date(from.getTime() + Number(rate[1]) * unit);
  }
  return CronExpressionParser.parse(cron.schedule, { currentDate: from, tz: cron.timezone ?? 'UTC' })
    .next()
    .toDate();
}

export interface CronScheduler {
  next(name: string): Date | undefined;
  stop(): void;
}

export function scheduleCrons(
  crons: LocalCron[],
  fire: (name: string) => void | Promise<void>,
): CronScheduler {
  const timers = new Map<string, NodeJS.Timeout>();
  const nexts = new Map<string, Date>();
  const arm = (c: LocalCron) => {
    const at = nextRun(c);
    nexts.set(c.name, at);
    // setTimeout caps at ~24.8 days; re-arm in steps.
    const delay = Math.min(at.getTime() - Date.now(), 2 ** 31 - 1);
    timers.set(
      c.name,
      setTimeout(
        async () => {
          if (Date.now() >= at.getTime() - 5) {
            try {
              await fire(c.name);
            } catch {
              // reported by `fire`
            }
          }
          arm(c);
        },
        Math.max(delay, 0),
      ),
    );
  };
  for (const c of crons) arm(c);
  return {
    next: (name) => nexts.get(name),
    stop: () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}
