export interface WarmUpConfig {
    warmUpDays: number;
    day1Limit: number;
    growthFactor: number;
    inactivityThresholdHours: number;
}

const DEFAULT_CONFIG: WarmUpConfig = {
    warmUpDays: 7,
    day1Limit: 20,
    growthFactor: 1.8,
    inactivityThresholdHours: 72,
};

export interface WarmUpState {
    startedAt: number;
    lastActiveAt: number;
    dailyCounts: number[];
    graduated: boolean;
}

export class WarmUp {
    private config: WarmUpConfig;
    private state: WarmUpState;

    constructor(config: Partial<WarmUpConfig> = {}, existingState?: WarmUpState) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.state = existingState || this.freshState();
    }

    getDailyLimit(): number {
        if (this.state.graduated) return Infinity;
        const day = this.getCurrentDay();
        if (day >= this.config.warmUpDays) { this.state.graduated = true; return Infinity; }
        return Math.round(this.config.day1Limit * Math.pow(this.config.growthFactor, day));
    }

    canSend(): boolean {
        this.checkInactivity();
        if (this.state.graduated) return true;
        const day = this.getCurrentDay();
        const todayCount = this.state.dailyCounts[day] || 0;
        return todayCount < this.getDailyLimit();
    }

    record(): void {
        const now = Date.now();
        const day = this.getCurrentDay();
        while (this.state.dailyCounts.length <= day) this.state.dailyCounts.push(0);
        this.state.dailyCounts[day]++;
        this.state.lastActiveAt = now;
    }

    getStatus() {
        const day = this.getCurrentDay();
        const todaySent = this.state.dailyCounts[day] || 0;
        const limit = this.getDailyLimit();
        return {
            phase: (this.state.graduated ? "graduated" : "warming") as "graduated" | "warming",
            day: Math.min(day + 1, this.config.warmUpDays),
            totalDays: this.config.warmUpDays,
            todayLimit: limit === Infinity ? -1 : limit,
            todaySent,
            progress: this.state.graduated ? 100 : Math.round((day / this.config.warmUpDays) * 100),
        };
    }

    exportState(): WarmUpState { return { ...this.state }; }
    reset(): void { this.state = this.freshState(); }

    private getCurrentDay(): number { return Math.floor((Date.now() - this.state.startedAt) / 86400000); }

    private checkInactivity(): void {
        const hoursSinceActive = (Date.now() - this.state.lastActiveAt) / 3600000;
        if (hoursSinceActive > this.config.inactivityThresholdHours && this.state.graduated) {
            this.state = this.freshState();
            this.state.graduated = false;
        }
    }

    private freshState(): WarmUpState {
        const now = Date.now();
        return { startedAt: now, lastActiveAt: now, dailyCounts: [], graduated: false };
    }
}
