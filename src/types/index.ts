export interface WebhookPayload {
    session_id: string;
    from: string;           // sender's or recipient's WhatsApp JID
    message_body: string;
    timestamp: string;       // ISO 8601
    message_type: "text" | "image" | "video" | "document" | "audio" | "other";
    direction?: "inbound" | "outbound";  // "outbound" skips auto-reply on Supabase
    ai_generated?: boolean;              // false = human-sent
    image_base64?: string;               // base64-encoded image data (no data URI prefix)
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
}
