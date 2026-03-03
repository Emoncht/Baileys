import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    downloadMediaMessage,
    WASocket,
    BaileysEventMap,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import QRCode from "qrcode";
import path from "path";
import fs from "fs";
import { sendWebhook } from "./webhookSender";
import { SessionInfo } from "../types";

interface WhatsAppSession {
    socket: WASocket | null;
    qr: string | null;          // base64 data URI of QR image
    connected: boolean;
    phoneNumber: string | null;
    lastActive: string | null;
    connecting: boolean;         // prevents duplicate startSession calls
}

const sessions = new Map<string, WhatsAppSession>();
const SESSIONS_DIR = path.join(process.cwd(), "sessions");

// Ensure sessions directory exists
if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

function getSession(sessionId: string): WhatsAppSession {
    if (!sessions.has(sessionId)) {
        sessions.set(sessionId, {
            socket: null,
            qr: null,
            connected: false,
            phoneNumber: null,
            lastActive: null,
            connecting: false,
        });
    }
    return sessions.get(sessionId)!;
}

export async function startSession(sessionId: string): Promise<SessionInfo> {
    const session = getSession(sessionId);

    // Already connected
    if (session.connected && session.socket) {
        return {
            connected: true,
            phone_number: session.phoneNumber,
            qr: null,
            last_active: session.lastActive,
        };
    }

    // Already in the process of connecting — return current QR
    if (session.connecting) {
        return {
            connected: false,
            phone_number: null,
            qr: session.qr,
            last_active: null,
        };
    }

    session.connecting = true;
    session.qr = null;

    const authDir = path.join(SESSIONS_DIR, sessionId);
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    // Fetch the latest compatible WhatsApp web version to avoid 405 errors
    const { version } = await fetchLatestBaileysVersion();
    console.log(`Using WA version: ${version}`);

    const sock = makeWASocket({
        auth: state,
        version,
        printQRInTerminal: false,
        browser: ["WhatsApp AutoReply", "Chrome", "1.0.0"],
    });

    session.socket = sock;

    // Handle credentials update (save auth state)
    sock.ev.on("creds.update", saveCreds);

    // Handle connection updates (QR code, connect, disconnect)
    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            // Convert QR string to base64 data URI image
            try {
                session.qr = await QRCode.toDataURL(qr);
            } catch (err) {
                console.error(`QR generation error for session ${sessionId}:`, err);
            }
        }

        if (connection === "open") {
            session.connected = true;
            session.connecting = false;
            session.qr = null;
            session.lastActive = new Date().toISOString();
            // Extract phone number from socket user info
            session.phoneNumber = sock.user?.id?.split(":")[0] || null;
            console.log(`Session connected for ${sessionId}: ${session.phoneNumber}`);
        }

        if (connection === "close") {
            session.connected = false;
            session.connecting = false;
            const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.log(
                `Session closed for ${sessionId}. Status: ${statusCode}. Reconnect: ${shouldReconnect}`
            );

            if (shouldReconnect) {
                // Auto-reconnect after a brief delay
                setTimeout(() => startSession(sessionId), 3000);
            } else {
                // User logged out — clean up auth files
                session.socket = null;
                session.phoneNumber = null;
                if (fs.existsSync(authDir)) {
                    fs.rmSync(authDir, { recursive: true, force: true });
                }
            }
        }
    });

    // Handle incoming and outgoing messages
    sock.ev.on("messages.upsert", async ({ messages: msgs, type }) => {
        if (type !== "notify") return;

        for (const msg of msgs) {
            // Skip status broadcasts and messages with no content
            if (msg.key.remoteJid === "status@broadcast") continue;
            if (!msg.message) continue;

            const from = msg.key.remoteJid || "";
            // Only handle individual chats (not groups)
            if (from.endsWith("@g.us")) continue;

            // Extract text body and detect message type
            let messageBody = "";
            let messageType: "text" | "image" | "video" | "document" | "audio" | "other" = "other";
            let imageBase64: string | undefined;

            if (msg.message.conversation) {
                messageBody = msg.message.conversation;
                messageType = "text";
            } else if (msg.message.extendedTextMessage?.text) {
                messageBody = msg.message.extendedTextMessage.text;
                messageType = "text";
            } else if (msg.message.imageMessage) {
                // Image message — download and base64-encode regardless of caption
                messageBody = msg.message.imageMessage.caption || "";
                messageType = "image";
                try {
                    const buffer = await downloadMediaMessage(msg, "buffer", {}) as Buffer;
                    imageBase64 = buffer.toString("base64");
                } catch (err) {
                    console.error(`Image download error for session ${sessionId}:`, err);
                }
            } else if (msg.message.videoMessage?.caption) {
                messageBody = msg.message.videoMessage.caption;
                messageType = "video";
            } else if (msg.message.documentMessage) {
                messageBody = msg.message.documentMessage.caption || "[Document]";
                messageType = "document";
            } else if (msg.message.audioMessage) {
                messageBody = "[Voice Message]";
                messageType = "audio";
            } else {
                messageBody = "[Unsupported message type]";
                messageType = "other";
            }

            // Skip truly empty non-image messages and bracket-only placeholders
            const isImage = messageType === "image";
            if (!isImage && (!messageBody || messageBody.startsWith("["))) continue;
            // For images, skip if we couldn't download the image data and there's no caption
            if (isImage && !imageBase64 && !messageBody) continue;

            const timestamp = new Date((msg.messageTimestamp as number) * 1000).toISOString();

            // Handle OUTBOUND messages (sent from the connected WhatsApp phone by the user)
            if (msg.key.fromMe) {
                await sendWebhook({
                    session_id: sessionId,
                    from,
                    message_body: messageBody,
                    timestamp,
                    message_type: messageType,
                    direction: "outbound",
                    ai_generated: false,
                    ...(imageBase64 && { image_base64: imageBase64 }),
                });
                continue;
            }

            // Handle INBOUND messages (received from others)
            await sendWebhook({
                session_id: sessionId,
                from,
                message_body: messageBody,
                timestamp,
                message_type: messageType,
                direction: "inbound",
                ...(imageBase64 && { image_base64: imageBase64 }),
            });
        }
    });

    // Wait briefly for QR to generate (can take up to a few seconds on first run)
    await new Promise((r) => setTimeout(r, 5000));

    return {
        connected: session.connected,
        phone_number: session.phoneNumber,
        qr: session.qr,
        last_active: session.lastActive,
    };
}

export function getSessionStatus(sessionId: string): SessionInfo {
    const session = getSession(sessionId);
    return {
        connected: session.connected,
        phone_number: session.phoneNumber,
        qr: session.qr,
        last_active: session.lastActive,
    };
}

export function getQR(sessionId: string): string | null {
    return getSession(sessionId).qr;
}

export async function sendMessage(
    sessionId: string,
    to: string,
    message: string
): Promise<boolean> {
    const session = getSession(sessionId);
    if (!session.connected || !session.socket) {
        throw new Error("Session not connected");
    }
    try {
        await session.socket.sendMessage(to, { text: message });
        session.lastActive = new Date().toISOString();
        return true;
    } catch (err) {
        console.error(`Send message error for session ${sessionId}:`, err);
        throw err;
    }
}

export async function disconnectSession(sessionId: string): Promise<void> {
    const session = getSession(sessionId);
    if (session.socket) {
        await session.socket.logout();
        session.socket = null;
    }
    session.connected = false;
    session.connecting = false;
    session.qr = null;
    session.phoneNumber = null;

    const authDir = path.join(SESSIONS_DIR, sessionId);
    if (fs.existsSync(authDir)) {
        fs.rmSync(authDir, { recursive: true, force: true });
    }

    sessions.delete(sessionId);
}
