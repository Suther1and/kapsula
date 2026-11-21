import type { VaultItem } from '@shared/types';

export interface ReminderRepositoryPort {
  getNextPendingReminder(): VaultItem | null;
  markReminderNotified(id: string, ts?: number): void;
  getItemById(id: string): VaultItem | null;
}

export class ReminderScheduler {
  private timer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(
    private readonly repo: ReminderRepositoryPort,
    private readonly onFire: (item: VaultItem) => void
  ) {}

  start(): void {
    this.disposed = false;
    this.refresh();
  }

  stop(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  refresh(): void {
    if (this.disposed) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const next = this.repo.getNextPendingReminder();
    if (!next || !next.remindAt) return;

    const now = Date.now();
    // Clamp max setTimeout delay to ~24 days to avoid Node 32-bit int overflow
    const rawDelay = Math.max(250, next.remindAt - now);
    const delay = Math.min(rawDelay, 2_000_000_000);

    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.disposed) return;

      const currentTime = Date.now();
      const candidate = this.repo.getNextPendingReminder();
      if (candidate && candidate.remindAt && candidate.remindAt <= currentTime + 1500) {
        this.repo.markReminderNotified(candidate.id, currentTime);
        const updated = this.repo.getItemById(candidate.id) ?? {
          ...candidate,
          remindedAt: currentTime,
        };
        try {
          this.onFire(updated);
        } catch {
          // Do not break scheduler chain on notification error
        }
      }
      this.refresh();
    }, delay);
  }
}

export type QuickReminderPreset = 'in_1h' | 'tonight' | 'tomorrow_morning' | 'weekend';

export function computeQuickReminderTimestamp(
  preset: QuickReminderPreset,
  now = Date.now()
): number {
  const d = new Date(now);
  switch (preset) {
    case 'in_1h':
      return now + 60 * 60 * 1000;
    case 'tonight': {
      const target = new Date(d);
      target.setHours(19, 0, 0, 0);
      if (target.getTime() <= now + 15 * 60 * 1000) {
        target.setDate(target.getDate() + 1);
      }
      return target.getTime();
    }
    case 'tomorrow_morning': {
      const target = new Date(d);
      target.setDate(target.getDate() + 1);
      target.setHours(9, 30, 0, 0);
      return target.getTime();
    }
    case 'weekend': {
      const target = new Date(d);
      const day = target.getDay(); // 0=Sun, 6=Sat
      const daysUntilSat = day === 6 ? 7 : (6 - day + 7) % 7 || 7;
      target.setDate(target.getDate() + daysUntilSat);
      target.setHours(11, 0, 0, 0);
      return target.getTime();
    }
  }
}
