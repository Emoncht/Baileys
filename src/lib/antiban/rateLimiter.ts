/**
 * Rate Limiter — Enforces human-like message pacing
 */

export interface RateLimiterConfig {
    maxPerMinute: number;
    maxPerHour: number;
    maxPerDay: number;
    minDelayMs: number;
    maxDelayMs: number;
    newChatDelayMs: number;
    maxIdenticalMessages: number;
    burstAllowance: number;
}

const DEFAULT_CONFIG: RateLimiterConfig = {
    maxPerMinute: 8,
    maxPerHour: 200,
    maxPerDay: 1500,
    minDelayMs: 1500,
    maxDelayMs: 5000,
    newChatDelayMs: 3000,
    maxIdenticalMessages: 3,
    burstAllowance: 3,
};

interface MessageRecord {
    timestamp: number;
    recipient: string;
    contentHash: string;
}

export class RateLimiter {
    private config: RateLimiterConfig;
    private messages: MessageRecord[] = [];
    private identicalCount = new Map<string, number>();
    private knownChats = new Set<string>();
    private burstCount = 0;
    private lastMessageTime = 0;

    constructor(config: Partial<RateLimiterConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    async getDelay(recipient: string, content: string): Promise<number> {
        const now = Date.now();
        this.cleanup(now);
        const contentHash = this.hashContent(content);

        const dayMessages = this.messages.filter(m => now - m.timestamp < 86400000);
        if (dayMessages.length >= this.config.maxPerDay) return -1;

        const hourMessages = this.messages.filter(m => now - m.timestamp < 3600000);
        if (hourMessages.length >= this.config.maxPerHour) {
            const oldest = hourMessages[0];
            return oldest ? (oldest.timestamp + 3600000) - now : 60000;
        }

        const minuteMessages = this.messages.filter(m => now - m.timestamp < 60000);
        if (minuteMessages.length >= this.config.maxPerMinute) {
            const oldest = minuteMessages[0];
            return oldest ? (oldest.timestamp + 60000) - now : 10000;
        }

        const identicalSent = this.identicalCount.get(contentHash) || 0;
        if (identicalSent >= this.config.maxIdenticalMessages) return -1;

        let delay = 0;
        if (this.burstCount < this.config.burstAllowance) {
            this.burstCount++;
            delay = this.jitter(this.config.minDelayMs * 0.5, this.config.minDelayMs);
        } else {
            delay = this.jitter(this.config.minDelayMs, this.config.maxDelayMs);
        }

        if (!this.knownChats.has(recipient)) {
            delay += this.jitter(this.config.newChatDelayMs * 0.5, this.config.newChatDelayMs);
        }

        const timeSinceLast = now - this.lastMessageTime;
        if (timeSinceLast < this.config.minDelayMs) {
            delay = Math.max(delay, this.config.minDelayMs - timeSinceLast);
        }

        const typingDelay = Math.min(content.length * 30, 3000);
        delay += this.jitter(typingDelay * 0.5, typingDelay);

        return Math.round(delay);
    }

    record(recipient: string, content: string): void {
        const now = Date.now();
        const contentHash = this.hashContent(content);
        this.messages.push({ timestamp: now, recipient, contentHash });
        this.knownChats.add(recipient);
        this.lastMessageTime = now;

        const count = (this.identicalCount.get(contentHash) || 0) + 1;
        this.identicalCount.set(contentHash, count);

        if (now - this.lastMessageTime > 30000) this.burstCount = 0;
    }

    getStats() {
        const now = Date.now();
        this.cleanup(now);
        return {
            lastMinute: this.messages.filter(m => now - m.timestamp < 60000).length,
            lastHour: this.messages.filter(m => now - m.timestamp < 3600000).length,
            lastDay: this.messages.filter(m => now - m.timestamp < 86400000).length,
            limits: { perMinute: this.config.maxPerMinute, perHour: this.config.maxPerHour, perDay: this.config.maxPerDay },
            knownChats: this.knownChats.size,
        };
    }

    private cleanup(now: number): void {
        this.messages = this.messages.filter(m => now - m.timestamp < 86400000);
        if (this.messages.length === 0) this.identicalCount.clear();
    }

    private jitter(min: number, max: number): number {
        const u1 = Math.random();
        const u2 = Math.random();
        const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        const normalized = (normal + 3) / 6;
        const clamped = Math.max(0, Math.min(1, normalized));
        return Math.round(min + clamped * (max - min));
    }

    private hashContent(content: string): string {
        let hash = 0;
        for (let i = 0; i < content.length; i++) {
            const char = content.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash |= 0;
        }
        return hash.toString(36);
    }
}
