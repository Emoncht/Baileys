# 🚀 WhatsApp Baileys Integration Guide (For Lovable / Frontend)

This document provides everything the frontend team needs to connect Lovable / React / Next.js to the WhatsApp Baileys server, including session pairing (QR code), sending messages, typing indicators, read receipts, and handling incoming webhooks.

---

## 📌 1. Server Configuration & Authentication

* **Base URL**: `https://baileys-production-b956.up.railway.app`
* **Default Session ID**: `default`
* **API Key Header**: `x-api-key: 3214` (Required for all routes except `/health`)

```typescript
export const BAILEYS_CONFIG = {
  baseUrl: "https://baileys-production-b956.up.railway.app",
  apiKey: "3214",
  sessionId: "default",
};

export const apiHeaders = {
  "Content-Type": "application/json",
  "x-api-key": BAILEYS_CONFIG.apiKey,
};
```

---

## 📱 2. QR Code & Session Connection (Link Device)

### A. Start Session & Fetch QR Code
* **Endpoint**: `POST /session/start`
* **Request Body**:
```json
{
  "sessionId": "default"
}
```
* **Response (when pairing needed)**:
```json
{
  "connected": false,
  "phone_number": null,
  "qr": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...",
  "last_active": null
}
```

### B. Check Connection Status (Polling)
* **Endpoint**: `GET /session/status/:sessionId`
* **Response (when connected)**:
```json
{
  "connected": true,
  "phone_number": "8801533021652",
  "qr": null,
  "last_active": "2026-08-27T17:50:00.000Z"
}
```

### C. Frontend React Hook / Function Example:
```typescript
import { useState, useEffect } from "react";

export function useWhatsAppSession(sessionId = "default") {
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [connected, setConnected] = useState<boolean>(false);
  const [phoneNumber, setPhoneNumber] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  // 1. Initialize session and get first QR
  const startSession = async () => {
    setLoading(true);
    try {
      const res = await fetch(`https://baileys-production-b956.up.railway.app/session/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "3214" },
        body: JSON.stringify({ sessionId }),
      });
      const data = await res.json();
      setConnected(data.connected);
      setPhoneNumber(data.phone_number);
      setQrCode(data.qr);
    } catch (err) {
      console.error("Failed to start session:", err);
    } finally {
      setLoading(false);
    }
  };

  // 2. Poll status every 3 seconds until connected
  useEffect(() => {
    startSession();
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`https://baileys-production-b956.up.railway.app/session/status/${sessionId}`, {
          headers: { "x-api-key": "3214" },
        });
        const data = await res.json();
        setConnected(data.connected);
        setPhoneNumber(data.phone_number);
        if (data.connected) {
          setQrCode(null);
          clearInterval(interval);
        } else if (data.qr) {
          setQrCode(data.qr);
        }
      } catch (err) {
        console.error("Failed to check status:", err);
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [sessionId]);

  return { qrCode, connected, phoneNumber, loading, refreshSession: startSession };
}
```

---

## 💬 3. Sending Outbound Messages

### A. Send Text Message
* **Endpoint**: `POST /message/send`
* **Address Formats Supported in `to`**:
  * Plain Phone Digits: `"8801533021652"` or `"+880 1533-021652"`
  * Phone JID: `"8801533021652@s.whatsapp.net"`
  * WhatsApp LID: `"37619769577647@lid"`
* **Request Body**:
```json
{
  "sessionId": "default",
  "to": "8801533021652",
  "message": "Hello! Your appointment is confirmed."
}
```
* **Response**:
```json
{
  "success": true
}
```

### B. Frontend Function to Send Message:
```typescript
export async function sendWhatsAppMessage(to: string, message: string, sessionId = "default") {
  const res = await fetch("https://baileys-production-b956.up.railway.app/message/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": "3214",
    },
    body: JSON.stringify({ sessionId, to, message }),
  });

  if (!res.ok) {
    const error = await res.json();
    throw new Error(error.error || "Failed to send message");
  }

  return await res.json();
}
```

---

## ⌨️ 4. Typing Indicators & Read Receipts

### A. Show "Typing..." / "Recording..." Indicator
* **Endpoint**: `POST /message/presence`
* **Presence values**: `"composing"` | `"recording"` | `"paused"` | `"available"` | `"unavailable"`
```json
{
  "sessionId": "default",
  "to": "8801533021652",
  "presence": "composing"
}
```

### B. Send Read Receipt (Blue Ticks)
* **Endpoint**: `POST /message/read`
* **Request Body** (pass the exact `message_key` received from the webhook):
```json
{
  "sessionId": "default",
  "to": "8801533021652@s.whatsapp.net",
  "messageKey": {
    "remoteJid": "37619769577647@lid",
    "remoteJidAlt": "8801533021652@s.whatsapp.net",
    "id": "3EB0123456789ABCDEF",
    "fromMe": false
  }
}
```

---

## 📥 5. Inbound Webhooks (How Messages Arrive at Backend/Frontend)

When a customer sends a message on WhatsApp, your webhook URL receives this payload:

### Webhook Event Payload Type Definition:
```typescript
export interface WhatsAppWebhookPayload {
  session_id: string;
  from: string;                  // e.g. "8801533021652@s.whatsapp.net"
  phone_number?: string;         // Clean numeric phone number: "8801533021652"
  message_body: string;          // Extracted text or caption
  timestamp: string;             // ISO 8601 string: "2026-08-27T17:50:00.000Z"
  message_type: "text" | "image" | "video" | "document" | "audio" | "ptt" | "call" | "other";
  direction: "inbound" | "outbound";
  ai_generated?: boolean;
  image_base64?: string;         // Base64 image data without prefix (for images)
  message_key?: {
    remoteJid?: string;          // Protocol address (@lid or @s.whatsapp.net)
    remoteJidAlt?: string;       // Alternate phone JID (@s.whatsapp.net)
    id?: string;                 // WhatsApp Message ID
    fromMe?: boolean;
    participant?: string;
    participantAlt?: string;
  };
}
```

### Frontend UI Display Rules:
1. **Chat Contact Title**: Always display `payload.phone_number` if available (e.g. `+880 1533-021652`).
2. **Replying**: Use either `phone_number` or `message_key.remoteJid` as the `to` field when calling `POST /message/send`.
3. **Outbound Sync**: If `direction === "outbound"`, this is a message sent either via your API or by a human typing on the physical phone — append it to the chat thread as an outgoing message bubble.

---

## 🔌 6. Disconnect / Logout Session

* **Endpoint**: `POST /session/disconnect/:sessionId`
* **Headers**: `x-api-key: 3214`
```bash
curl -X POST https://baileys-production-b956.up.railway.app/session/disconnect/default \
  -H "x-api-key: 3214"
```
* **Response**: `{ "success": true }`

---

## 📋 7. Summary Table of All Endpoints

| Endpoint | Method | Purpose | Auth Header |
| :--- | :--- | :--- | :--- |
| `/health` | `GET` | Server health status | None |
| `/session/start` | `POST` | Start session & generate QR code | `x-api-key: 3214` |
| `/session/status/:sessionId` | `GET` | Check if session is connected | `x-api-key: 3214` |
| `/session/qr/:sessionId` | `GET` | Get current QR code Base64 | `x-api-key: 3214` |
| `/session/lidmap/:sessionId` | `GET` | View learned LID $\leftrightarrow$ Phone mappings | `x-api-key: 3214` |
| `/session/disconnect/:sessionId`| `POST`| Disconnect & clear credentials | `x-api-key: 3214` |
| `/message/send` | `POST` | Send outbound text message | `x-api-key: 3214` |
| `/message/presence` | `POST` | Show typing / recording status | `x-api-key: 3214` |
| `/message/read` | `POST` | Send read receipt (blue checkmarks) | `x-api-key: 3214` |
