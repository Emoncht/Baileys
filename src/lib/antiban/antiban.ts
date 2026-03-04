import { RateLimiter, type RateLimiterConfig } from "./rateLimiter";
import { WarmUp, type WarmUpConfig, type WarmUpState } from "./warmup";
import { HealthMonitor, type HealthMonitorConfig, type HealthStatus } from "./health";

export interface AntiBanConfig {
    rateLimiter?: Partial<RateLimiterConfig>;
    warmUp?: Partial<WarmUpConfig>;
    health?: Partial<HealthMonitorConfig>;
    logging?: boolean;
}

export interface SendDecision {
    allowed: boolean;
    delayMs: number;
    reason?: string;
    health: HealthStatus;
    warmUpDay?: number;
}

export interface AntiBanStats {
    messagesAllowed: number;
    messagesBlocked: number;
    totalDelayMs: number;
    health: HealthStatus;
    warmUp: ReturnType<WarmUp["getStatus"]>;
    rateLimiter: ReturnType<RateLimiter["getStats"]>;
}

export class AntiBan {
    private rateLimiter: RateLimiter;
    private warmUp: WarmUp;
    private health: HealthMonitor;
    private logging: boolean;

    private stats = { messagesAllowed: 0, messagesBlocked: 0, totalDelayMs: 0 };

    constructor(config: AntiBanConfig = {}, warmUpState?: WarmUpState) {
        this.rateLimiter = new RateLimiter(config.rateLimiter);
        this.warmUp = new WarmUp(config.warmUp, warmUpState);
        this.health = new HealthMonitor({
            ...config.health,
            onRiskChange: (status: HealthStatus) => {
                if (this.logging) {
                    const emoji: Record<string, string> = { low: "🟢", medium: "🟡", high: "🟠", critical: "🔴" };
                    console.log(`[baileys-antiban] ${emoji[status.risk]} Risk: ${status.risk.toUpperCase()} (score: ${status.score})`);
                    console.log(`[baileys-antiban] ${status.recommendation}`);
                    status.reasons.forEach((r: string) => console.log(`[baileys-antiban]   → ${r}`));
                }
                config.health?.onRiskChange?.(status);
            },
        });
        this.logging = config.logging ?? true;
    }

    async beforeSend(recipient: string, content: string): Promise<SendDecision> {
        const healthStatus = this.health.getStatus();

        if (this.health.isPaused()) {
            this.stats.messagesBlocked++;
            if (this.logging) console.log(`[baileys-antiban] ⛔ BLOCKED — health risk too high (${healthStatus.risk})`);
            return { allowed: false, delayMs: 0, reason: `Health risk ${healthStatus.risk}: ${healthStatus.recommendation}`, health: healthStatus };
        }

        if (!this.warmUp.canSend()) {
            this.stats.messagesBlocked++;
            const wu = this.warmUp.getStatus();
            if (this.logging) console.log(`[baileys-antiban] ⏳ BLOCKED — warm-up day ${wu.day}/${wu.totalDays}, limit reached`);
            return { allowed: false, delayMs: 0, reason: `Warm-up limit: ${wu.todaySent}/${wu.todayLimit} messages today`, health: healthStatus, warmUpDay: wu.day };
        }

        const delay = await this.rateLimiter.getDelay(recipient, content);

        if (delay === -1) {
            this.stats.messagesBlocked++;
            if (this.logging) console.log(`[baileys-antiban] 🚫 BLOCKED — rate limit or identical message spam`);
            return { allowed: false, delayMs: 0, reason: "Rate limit exceeded or identical message spam detected", health: healthStatus };
        }

        this.stats.totalDelayMs += delay;
        return { allowed: true, delayMs: delay, health: healthStatus };
    }

    afterSend(recipient: string, content: string): void {
        this.rateLimiter.record(recipient, content);
        this.warmUp.record();
        this.stats.messagesAllowed++;
    }

    afterSendFailed(error?: string): void { this.health.recordMessageFailed(error); }
    onDisconnect(reason: string | number): void { this.health.recordDisconnect(reason); }
    onReconnect(): void { this.health.recordReconnect(); }

    getStats(): AntiBanStats {
        return { ...this.stats, health: this.health.getStatus(), warmUp: this.warmUp.getStatus(), rateLimiter: this.rateLimiter.getStats() };
    }

    exportWarmUpState(): WarmUpState { return this.warmUp.exportState(); }
    pause(): void { this.health.setPaused(true); if (this.logging) console.log("[baileys-antiban] ⏸️  Paused"); }
    resume(): void { this.health.setPaused(false); if (this.logging) console.log("[baileys-antiban] ▶️  Resumed"); }
    reset(): void { this.health.reset(); this.warmUp.reset(); this.stats = { messagesAllowed: 0, messagesBlocked: 0, totalDelayMs: 0 }; }
}
