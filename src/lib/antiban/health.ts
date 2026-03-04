export type BanRiskLevel = "low" | "medium" | "high" | "critical";

export interface HealthStatus {
    risk: BanRiskLevel;
    score: number;
    reasons: string[];
    recommendation: string;
    stats: {
        disconnectsLastHour: number;
        failedMessagesLastHour: number;
        forbiddenErrors: number;
        uptimeMs: number;
        lastDisconnectReason?: string;
    };
}

export interface HealthMonitorConfig {
    disconnectWarningThreshold: number;
    disconnectCriticalThreshold: number;
    failedMessageThreshold: number;
    onRiskChange?: (status: HealthStatus) => void;
    autoPauseAt: BanRiskLevel;
}

const DEFAULT_CONFIG: HealthMonitorConfig = {
    disconnectWarningThreshold: 3,
    disconnectCriticalThreshold: 5,
    failedMessageThreshold: 5,
    autoPauseAt: "high",
};

interface HealthEvent {
    type: "disconnect" | "forbidden" | "loggedOut" | "messageFailed" | "reconnect";
    timestamp: number;
    detail?: string;
}

export class HealthMonitor {
    private config: HealthMonitorConfig;
    private events: HealthEvent[] = [];
    private startTime = Date.now();
    private paused = false;
    private lastRisk: BanRiskLevel = "low";

    constructor(config: Partial<HealthMonitorConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    recordDisconnect(reason: string | number): void {
        const r = String(reason);
        if (r === "403" || r === "forbidden") this.events.push({ type: "forbidden", timestamp: Date.now(), detail: r });
        else if (r === "401" || r === "loggedOut") this.events.push({ type: "loggedOut", timestamp: Date.now(), detail: r });
        else this.events.push({ type: "disconnect", timestamp: Date.now(), detail: r });
        this.checkAndNotify();
    }

    recordReconnect(): void { this.events.push({ type: "reconnect", timestamp: Date.now() }); }

    recordMessageFailed(error?: string): void {
        this.events.push({ type: "messageFailed", timestamp: Date.now(), detail: error });
        this.checkAndNotify();
    }

    getStatus(): HealthStatus {
        const now = Date.now();
        this.cleanup(now);
        const hourEvents = this.events.filter(e => now - e.timestamp < 3600000);
        const disconnects = hourEvents.filter(e => e.type === "disconnect").length;
        const forbidden = hourEvents.filter(e => e.type === "forbidden").length;
        const loggedOut = hourEvents.filter(e => e.type === "loggedOut").length;
        const failedMessages = hourEvents.filter(e => e.type === "messageFailed").length;

        let score = 0;
        const reasons: string[] = [];

        if (forbidden > 0) { score += 40 * forbidden; reasons.push(`${forbidden} forbidden (403) error${forbidden > 1 ? "s" : ""} in last hour`); }
        if (loggedOut > 0) { score += 60; reasons.push("Logged out by WhatsApp — possible temporary ban"); }
        if (disconnects >= this.config.disconnectCriticalThreshold) { score += 30; reasons.push(`${disconnects} disconnects in last hour (critical threshold)`); }
        else if (disconnects >= this.config.disconnectWarningThreshold) { score += 15; reasons.push(`${disconnects} disconnects in last hour`); }
        if (failedMessages >= this.config.failedMessageThreshold) { score += 20; reasons.push(`${failedMessages} failed messages in last hour`); }

        score = Math.min(100, score);
        let risk: BanRiskLevel;
        if (score >= 85) risk = "critical";
        else if (score >= 60) risk = "high";
        else if (score >= 30) risk = "medium";
        else risk = "low";

        let recommendation: string;
        switch (risk) {
            case "critical": recommendation = "STOP ALL MESSAGING IMMEDIATELY. Disconnect and wait 24-48 hours."; break;
            case "high": recommendation = "Reduce messaging rate by 80%. Consider pausing for 1-2 hours."; break;
            case "medium": recommendation = "Reduce messaging rate by 50%. Increase delays between messages."; break;
            default: recommendation = "Operating normally. Continue monitoring.";
        }

        const lastDisconnect = [...this.events].reverse().find(e => e.type === "disconnect" || e.type === "forbidden" || e.type === "loggedOut");
        return {
            risk, score,
            reasons: reasons.length ? reasons : ["No issues detected"],
            recommendation,
            stats: { disconnectsLastHour: disconnects, failedMessagesLastHour: failedMessages, forbiddenErrors: forbidden, uptimeMs: now - this.startTime, lastDisconnectReason: lastDisconnect?.detail },
        };
    }

    isPaused(): boolean {
        if (this.paused) return true;
        const status = this.getStatus();
        const riskOrder: BanRiskLevel[] = ["low", "medium", "high", "critical"];
        return riskOrder.indexOf(status.risk) >= riskOrder.indexOf(this.config.autoPauseAt);
    }

    setPaused(paused: boolean): void { this.paused = paused; }
    reset(): void { this.events = []; this.startTime = Date.now(); this.paused = false; this.lastRisk = "low"; }

    private cleanup(now: number): void { this.events = this.events.filter(e => now - e.timestamp < 21600000); }

    private checkAndNotify(): void {
        const status = this.getStatus();
        if (status.risk !== this.lastRisk) { this.lastRisk = status.risk; this.config.onRiskChange?.(status); }
    }
}
