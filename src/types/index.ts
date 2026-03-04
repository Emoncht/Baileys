import type { RateLimiterConfig } from "../lib/antiban/rateLimiter";
import type { WarmUpConfig } from "../lib/antiban/warmup";
import type { HealthMonitorConfig } from "../lib/antiban/health";

export type AccountType = "fresh" | "established" | "trusted";

export interface AntiBanOverride {
    rateLimiter?: Partial<RateLimiterConfig>;
    warmUp?: Partial<WarmUpConfig>;
    health?: Partial<Omit<HealthMonitorConfig, "onRiskChange">>;
}

export interface WebhookPayload {
    session_id: string;
    from: string;           // sender's or recipient's WhatsApp JID
    phone_number?: string;  // clean phone digits e.g. "8801533021652"
    message_body: string;
    timestamp: string;       // ISO 8601
    message_type: "text" | "image" | "video" | "document" | "audio" | "ptt" | "call" | "other";
    direction?: "inbound" | "outbound";  // "outbound" skips auto-reply on Supabase
    ai_generated?: boolean;              // false = human-sent
    image_base64?: string;               // base64-encoded image data (no data URI prefix)
    message_key?: {                      // raw Baileys message key for read receipts
        remoteJid?: string;
        id?: string;
        fromMe?: boolean;
    };
}

export interface SendMessageRequest {
    sessionId: string;
    to: string;              // recipient WhatsApp JID
    message: string;
}

export interface SessionInfo {
    connected: boolean;
    phone_number: string | null;
    qr: string | null;       // base64 QR code image (data URI)
    last_active: string | null;
}

export interface StartSessionRequest {
    sessionId: string;
    accountType?: AccountType;         // defaults to "fresh"
    antiBanOverride?: AntiBanOverride; // optional power-user overrides
}

export interface SendPresenceRequest {
    sessionId: string;
    to: string;
    presence: "unavailable" | "available" | "composing" | "recording" | "paused";
}

export interface SendReadRequest {
    sessionId: string;
    to: string;
    messageKey: {
        remoteJid?: string;
        id?: string;
        fromMe?: boolean;
        participant?: string;
    };
}
