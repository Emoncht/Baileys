/**
 * Account Profile Presets — Maps accountType to AntiBan configuration
 *
 * fresh:       New WhatsApp number, conservative limits, full 7-day warm-up
 * established: Existing number with history, skip warm-up, moderate limits
 * trusted:     Well-aged number, skip warm-up, aggressive limits
 */

import type { AntiBanConfig } from "./antiban";

export type AccountType = "fresh" | "established" | "trusted";

const FRESH_PROFILE: AntiBanConfig = {
    rateLimiter: {
        maxPerMinute: 8,
        maxPerHour: 200,
        maxPerDay: 1500,
        minDelayMs: 1500,
        maxDelayMs: 5000,
        newChatDelayMs: 3000,
        maxIdenticalMessages: 3,
        burstAllowance: 3,
    },
    warmUp: {
        warmUpDays: 7,
        day1Limit: 20,
        growthFactor: 1.8,
        inactivityThresholdHours: 72,
    },
    health: {
        disconnectWarningThreshold: 3,
        disconnectCriticalThreshold: 5,
        failedMessageThreshold: 5,
        autoPauseAt: "high",
    },
    logging: true,
};

const ESTABLISHED_PROFILE: AntiBanConfig = {
    rateLimiter: {
        maxPerMinute: 15,
        maxPerHour: 400,
        maxPerDay: 3000,
        minDelayMs: 800,
        maxDelayMs: 3000,
        newChatDelayMs: 2000,
        maxIdenticalMessages: 5,
        burstAllowance: 5,
    },
    warmUp: {
        warmUpDays: 0,          // skip warm-up entirely
        day1Limit: 9999,
        growthFactor: 1,
        inactivityThresholdHours: 168, // 7 days before reset
    },
    health: {
        disconnectWarningThreshold: 5,
        disconnectCriticalThreshold: 8,
        failedMessageThreshold: 8,
        autoPauseAt: "high",
    },
    logging: true,
};

const TRUSTED_PROFILE: AntiBanConfig = {
    rateLimiter: {
        maxPerMinute: 25,
        maxPerHour: 800,
        maxPerDay: 5000,
        minDelayMs: 500,
        maxDelayMs: 2000,
        newChatDelayMs: 1000,
        maxIdenticalMessages: 8,
        burstAllowance: 8,
    },
    warmUp: {
        warmUpDays: 0,          // skip warm-up entirely
        day1Limit: 9999,
        growthFactor: 1,
        inactivityThresholdHours: 336, // 14 days before reset
    },
    health: {
        disconnectWarningThreshold: 8,
        disconnectCriticalThreshold: 12,
        failedMessageThreshold: 10,
        autoPauseAt: "critical",   // only pause at critical for trusted
    },
    logging: true,
};

const PROFILES: Record<AccountType, AntiBanConfig> = {
    fresh: FRESH_PROFILE,
    established: ESTABLISHED_PROFILE,
    trusted: TRUSTED_PROFILE,
};

/**
 * Get the AntiBan config preset for an account type.
 * Returns a deep copy so each session gets its own mutable config.
 */
export function getAccountProfile(accountType: AccountType = "fresh"): AntiBanConfig {
    const profile = PROFILES[accountType];
    if (!profile) {
        console.warn(`[antiban] Unknown accountType "${accountType}", falling back to "fresh"`);
        return JSON.parse(JSON.stringify(PROFILES.fresh));
    }
    return JSON.parse(JSON.stringify(profile));
}

/**
 * Deep-merge a user-provided override into a base config.
 * Only overrides keys that are explicitly provided.
 */
export function mergeAntiBanConfig(
    base: AntiBanConfig,
    override?: Partial<AntiBanConfig>
): AntiBanConfig {
    if (!override) return base;

    return {
        rateLimiter: { ...base.rateLimiter, ...override.rateLimiter },
        warmUp: { ...base.warmUp, ...override.warmUp },
        health: { ...base.health, ...override.health },
        logging: override.logging ?? base.logging,
    };
}
