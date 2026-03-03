import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    WASocket,
    BaileysEventMap,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import QRCode from "qrcode";
import path from "path";
import fs from "fs";
import { sendWebhook } from "./webhookSender";
import { SessionInfo } from "../types";

interface UserSession {
    socket: WASocket | null;
    qr: string | null;          // base64 data URI of QR image
    connected: boolean;
    phoneNumber: string | null;
    lastActive: string | null;
    connecting: boolean;         // prevents duplicate startSession calls
}

const sessions = new Map<string, UserSession>();
const SESSIONS_DIR = path.join(process.cwd(), "sessions");

// Ensure sessions directory exists
if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

function getSession(userId: string): UserSession {
    if (!sessions.has(userId)) {
        sessions.set(userId, {
            socket: null,
            qr: null,
            connected: false,
            phoneNumber: null,
            lastActive: null,
            connecting: false,
        });
    }
    return sessions.get(userId)!;
}

export async function startSession(userId: string): Promise<SessionInfo> {
    const session = getSession(userId);

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

    const authDir = path.join(SESSIONS_DIR, userId);
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
                console.error(`QR generation error for ${userId}:`, err);
            }
        }

        if (connection === "open") {
            session.connected = true;
            session.connecting = false;
            session.qr = null;
            session.lastActive = new Date().toISOString();
            // Extract phone number from socket user info
            session.phoneNumber = sock.user?.id?.split(":")[0] || null;
            console.log(`Session connected for user ${userId}: ${session.phoneNumber}`);
        }

        if (connection === "close") {
            session.connected = false;
            session.connecting = false;
            const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.log(
                `Session closed for ${userId}. Status: ${statusCode}. Reconnect: ${shouldReconnect}`
            );

            if (shouldReconnect) {
                // Auto-reconnect after a brief delay
                setTimeout(() => startSession(userId), 3000);
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

            // Extract text body from various message types
            let messageBody = "";
            let messageType: "text" | "image" | "video" | "document" | "audio" | "other" = "other";

            if (msg.message.conversation) {
                messageBody = msg.message.conversation;
                messageType = "text";
            } else if (msg.message.extendedTextMessage?.text) {
                messageBody = msg.message.extendedTextMessage.text;
                messageType = "text";
            } else if (msg.message.imageMessage?.caption) {
                messageBody = msg.message.imageMessage.caption;
                messageType = "image";
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

            // Skip empty bodies and non-text placeholder types
            if (!messageBody || messageBody.startsWith("[")) continue;

            // Handle OUTBOUND messages (sent from the connected WhatsApp phone by the user)
            if (msg.key.fromMe) {
                await sendWebhook({
                    user_id: userId,
                    from,                   // recipient's JID
                    message_body: messageBody,
                    timestamp: new Date((msg.messageTimestamp as number) * 1000).toISOString(),
                    message_type: messageType,
                    direction: "outbound",  // tells Supabase to skip auto-reply
                    ai_generated: false,    // human-sent
                });
                continue; // skip inbound processing
            }

            // Handle INBOUND messages (received from others)
            await sendWebhook({
                user_id: userId,
                from,
                message_body: messageBody,
                timestamp: new Date((msg.messageTimestamp as number) * 1000).toISOString(),
                message_type: messageType,
                direction: "inbound",
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

export function getSessionStatus(userId: string): SessionInfo {
    const session = getSession(userId);
    return {
        connected: session.connected,
        phone_number: session.phoneNumber,
        qr: session.qr,
        last_active: session.lastActive,
    };
}

export function getQR(userId: string): string | null {
    return getSession(userId).qr;
}

export async function sendMessage(
    userId: string,
    to: string,
    message: string
): Promise<boolean> {
    const session = getSession(userId);
    if (!session.connected || !session.socket) {
        throw new Error("Session not connected");
    }
    try {
        await session.socket.sendMessage(to, { text: message });
        session.lastActive = new Date().toISOString();
        return true;
    } catch (err) {
        console.error(`Send message error for ${userId}:`, err);
        throw err;
    }
}

export async function disconnectSession(userId: string): Promise<void> {
    const session = getSession(userId);
    if (session.socket) {
        await session.socket.logout();
        session.socket = null;
    }
    session.connected = false;
    session.connecting = false;
    session.qr = null;
    session.phoneNumber = null;

    const authDir = path.join(SESSIONS_DIR, userId);
    if (fs.existsSync(authDir)) {
        fs.rmSync(authDir, { recursive: true, force: true });
    }

    sessions.delete(userId);
}
