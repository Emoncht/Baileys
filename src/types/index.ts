export interface WebhookPayload {
    user_id: string;
    from: string;           // sender's WhatsApp JID e.g. "923001234567@s.whatsapp.net"
    message_body: string;
    timestamp: string;       // ISO 8601
    message_type: "text" | "image" | "video" | "document" | "audio" | "other";
    direction?: "inbound" | "outbound";  // NEW: "outbound" skips auto-reply on Supabase
    ai_generated?: boolean;              // NEW: false = human-sent
}

export interface SendMessageRequest {
    user_id: string;
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
    userId: string;
}
