import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    downloadMediaMessage,
    jidNormalizedUser,
    WASocket,
    BaileysEventMap,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import QRCode from "qrcode";
import path from "path";
import fs from "fs";
import { sendWebhook } from "./webhookSender";
import { SessionInfo } from "../types";
import type { AccountType, AntiBanOverride } from "../types";
import { AntiBan, getAccountProfile, mergeAntiBanConfig } from "../lib/antiban";
import type { AntiBanConfig, AntiBanStats, HealthStatus } from "../lib/antiban";
import { getBrowserFingerprint } from "../lib/browserFingerprint";

/**
 * Resolve a JID to a phone-based JID.
 * - If already @s.whatsapp.net, return as-is with extracted phone digits
 * - If @lid, try to normalize via jidNormalizedUser
 */
function resolveJid(
    sock: WASocket,
    rawJid: string
): { resolvedJid: string; phoneNumber: string | null } {
    if (rawJid.endsWith("@s.whatsapp.net")) {
        const phone = rawJid.replace("@s.whatsapp.net", "");
        return { resolvedJid: rawJid, phoneNumber: phone };
    }

    if (rawJid.endsWith("@lid")) {
        try {
            const store = (sock as any).store;
            if (store?.contacts) {
                const contact = store.contacts[rawJid];
                if (contact?.id && contact.id.endsWith("@s.whatsapp.net")) {
                    const phone = contact.id.replace("@s.whatsapp.net", "");
                    console.log(`[JID] Resolved LID ${rawJid} → ${contact.id}`);
                    return { resolvedJid: contact.id, phoneNumber: phone };
                }
            }

            const normalized = jidNormalizedUser(rawJid);
            if (normalized && normalized !== rawJid && normalized.endsWith("@s.whatsapp.net")) {
                const phone = normalized.replace("@s.whatsapp.net", "");
                console.log(`[JID] Normalized LID ${rawJid} → ${normalized}`);
                return { resolvedJid: normalized, phoneNumber: phone };
            }
        } catch (err) {
            console.error(`[JID] Failed to resolve LID ${rawJid}:`, err);
        }

        console.warn(`[JID] Could not resolve LID ${rawJid} to phone JID`);
        return { resolvedJid: rawJid, phoneNumber: null };
    }

    return { resolvedJid: rawJid, phoneNumber: null };
}

interface WhatsAppSession {
    socket: WASocket | null;
    qr: string | null;          // base64 data URI of QR image
    connected: boolean;
    phoneNumber: string | null;
    lastActive: string | null;
    connecting: boolean;         // prevents duplicate startSession calls
    antiban: AntiBan | null;     // antiban instance for this session
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
            antiban: null,
        });
    }
    return sessions.get(sessionId)!;
}

/** Load persisted warm-up state for a session (survives restarts) */
function loadWarmUpState(sessionId: string) {
    const warmupPath = path.join(SESSIONS_DIR, sessionId, "warmup.json");
    try {
        if (fs.existsSync(warmupPath)) {
            return JSON.parse(fs.readFileSync(warmupPath, "utf-8"));
        }
    } catch { /* ignore – start fresh */ }
    return undefined;
}

/** Persist warm-up state so it survives restarts / redeployments */
function saveWarmUpState(sessionId: string, antiban: AntiBan) {
    const warmupPath = path.join(SESSIONS_DIR, sessionId, "warmup.json");
    try {
        const state = antiban.exportWarmUpState();
        fs.writeFileSync(warmupPath, JSON.stringify(state));
    } catch (err) {
        console.error(`[antiban] Failed to save warm-up state for ${sessionId}:`, err);
    }
}

export async function startSession(
    sessionId: string,
    accountType: AccountType = "fresh",
    antiBanOverride?: AntiBanOverride
): Promise<SessionInfo> {
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

    // ── Anti-ban setup (profile-based) ───────────────────────────────
    const baseConfig = getAccountProfile(accountType);
    const finalConfig = mergeAntiBanConfig(baseConfig, {
        ...antiBanOverride,
        health: {
            ...antiBanOverride?.health,
            onRiskChange: (status: HealthStatus) => {
                console.log(`[antiban][${sessionId}] Risk: ${status.risk} — ${status.recommendation}`);
            },
        },
    });
    console.log(`[antiban][${sessionId}] Using "${accountType}" profile`);

    const warmUpState = loadWarmUpState(sessionId);
    const antiban = new AntiBan(finalConfig, warmUpState);
    session.antiban = antiban;

    // Persist warm-up state every 5 minutes
    const warmupInterval = setInterval(() => saveWarmUpState(sessionId, antiban), 5 * 60 * 1000);
    // ────────────────────────────────────────────────────────────────

    const authDir = path.join(SESSIONS_DIR, sessionId);
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    // Fetch the latest compatible WhatsApp web version to avoid 405 errors
    const { version } = await fetchLatestBaileysVersion();
    console.log(`Using WA version: ${version}`);

    // ── Real browser fingerprint ─────────────────────────────────────
    const browserFingerprint = getBrowserFingerprint(sessionId, SESSIONS_DIR);

    const sock = makeWASocket({
        auth: state,
        version,
        printQRInTerminal: false,
        browser: browserFingerprint,
    });

    session.socket = sock;

    // Handle credentials update (save auth state)
    sock.ev.on("creds.update", saveCreds);

    // Handle connection updates (QR code, connect, disconnect)
    sock.ev.on("connection.update", async (update: any) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
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
            session.phoneNumber = sock.user?.id?.split(":")[0] || null;
            antiban.onReconnect();
            console.log(`Session connected for ${sessionId}: ${session.phoneNumber}`);
        }

        if (connection === "close") {
            session.connected = false;
            session.connecting = false;
            const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            antiban.onDisconnect(statusCode || "unknown");
            saveWarmUpState(sessionId, antiban);
            clearInterval(warmupInterval);

            console.log(
                `Session closed for ${sessionId}. Status: ${statusCode}. Reconnect: ${shouldReconnect}`
            );

            if (shouldReconnect) {
                setTimeout(() => startSession(sessionId), 3000);
            } else {
                session.socket = null;
                session.phoneNumber = null;
                session.antiban = null;
                if (fs.existsSync(authDir)) {
                    fs.rmSync(authDir, { recursive: true, force: true });
                }
            }
        }
    });

    // Handle incoming and outgoing messages
    sock.ev.on("messages.upsert", async ({ messages: msgs, type }: any) => {
        if (type !== "notify") return;

        for (const msg of msgs) {
            if (msg.key.remoteJid === "status@broadcast") continue;
            if (!msg.message) continue;

            const rawJid = msg.key.remoteJid || "";
            if (rawJid.endsWith("@g.us")) continue;

            const { resolvedJid: from, phoneNumber } = resolveJid(sock, rawJid);

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

            const isImage = messageType === "image";
            if (!isImage && (!messageBody || messageBody.startsWith("["))) continue;
            if (isImage && !imageBase64 && !messageBody) continue;

            const timestamp = new Date((msg.messageTimestamp as number) * 1000).toISOString();

            if (msg.key.fromMe) {
                await sendWebhook({
                    session_id: sessionId,
                    from,
                    phone_number: phoneNumber || undefined,
                    message_body: messageBody,
                    timestamp,
                    message_type: messageType,
                    direction: "outbound",
                    ai_generated: false,
                    ...(imageBase64 && { image_base64: imageBase64 }),
                });
                continue;
            }

            await sendWebhook({
                session_id: sessionId,
                from,
                phone_number: phoneNumber || undefined,
                message_body: messageBody,
                timestamp,
                message_type: messageType,
                direction: "inbound",
                ...(imageBase64 && { image_base64: imageBase64 }),
            });
        }
    });

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

export function getAntiBanStats(sessionId: string): AntiBanStats | null {
    const session = sessions.get(sessionId);
    return session?.antiban?.getStats() || null;
}

/**
 * Update antiban config on a running session.
 * Creates a new AntiBan instance with the merged config while preserving warm-up state.
 */
export function updateAntiBanConfig(
    sessionId: string,
    accountType: AccountType = "fresh",
    antiBanOverride?: AntiBanOverride
): AntiBanStats | null {
    const session = sessions.get(sessionId);
    if (!session) return null;

    // Preserve existing warm-up state
    const existingWarmUpState = session.antiban?.exportWarmUpState();

    const baseConfig = getAccountProfile(accountType);
    const finalConfig = mergeAntiBanConfig(baseConfig, {
        ...antiBanOverride,
        health: {
            ...antiBanOverride?.health,
            onRiskChange: (status: HealthStatus) => {
                console.log(`[antiban][${sessionId}] Risk: ${status.risk} — ${status.recommendation}`);
            },
        },
    });

    const antiban = new AntiBan(finalConfig, existingWarmUpState);
    session.antiban = antiban;
    console.log(`[antiban][${sessionId}] Config updated to "${accountType}" profile with overrides`);

    return antiban.getStats();
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

export async function sendPresence(
    sessionId: string,
    to: string,
    presence: "unavailable" | "available" | "composing" | "recording" | "paused"
): Promise<boolean> {
    const session = getSession(sessionId);
    if (!session.connected || !session.socket) {
        throw new Error("Session not connected");
    }
    try {
        await session.socket.sendPresenceUpdate(presence, to);
        session.lastActive = new Date().toISOString();
        return true;
    } catch (err) {
        console.error(`Send presence error for session ${sessionId}:`, err);
        throw err;
    }
}

export async function sendRead(
    sessionId: string,
    messageKey: { remoteJid?: string; id?: string; fromMe?: boolean; participant?: string }
): Promise<boolean> {
    const session = getSession(sessionId);
    if (!session.connected || !session.socket) {
        throw new Error("Session not connected");
    }
    try {
        // Baileys readMessages takes an array of message keys
        await session.socket.readMessages([messageKey as any]);
        session.lastActive = new Date().toISOString();
        return true;
    } catch (err) {
        console.error(`Send read receipt error for session ${sessionId}:`, err);
        throw err;
    }
}

export async function disconnectSession(sessionId: string): Promise<void> {
    const session = getSession(sessionId);

    // Save warm-up state before disconnecting
    if (session.antiban) saveWarmUpState(sessionId, session.antiban);

    if (session.socket) {
        await session.socket.logout();
        session.socket = null;
    }
    session.connected = false;
    session.connecting = false;
    session.qr = null;
    session.phoneNumber = null;
    session.antiban = null;

    const authDir = path.join(SESSIONS_DIR, sessionId);
    if (fs.existsSync(authDir)) {
        fs.rmSync(authDir, { recursive: true, force: true });
    }

    sessions.delete(sessionId);
}
