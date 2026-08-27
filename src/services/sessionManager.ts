import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    downloadMediaMessage,
    jidNormalizedUser,
    isLidUser,
    areJidsSameUser,
    WASocket,
    BaileysEventMap,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import QRCode from "qrcode";
import path from "path";
import fs from "fs";
import pino from "pino";
import { sendWebhook } from "./webhookSender";
import { SessionInfo } from "../types";
import type { AccountType, AntiBanOverride } from "../types";
import { AntiBan, getAccountProfile, mergeAntiBanConfig } from "../lib/antiban";
import type { AntiBanConfig, AntiBanStats, HealthStatus } from "../lib/antiban";
import { getBrowserFingerprint } from "../lib/browserFingerprint";

// ── Per-session LID → phone map (populated dynamically from contacts & messages) ──────
const lidMaps = new Map<string, Map<string, string>>();  // sessionId → (lid → phoneJid)

export function getLidMap(sessionId: string): Map<string, string> {
    if (!lidMaps.has(sessionId)) {
        lidMaps.set(sessionId, new Map());
        // Try to load persisted map from disk
        const mapPath = path.join(SESSIONS_DIR, sessionId, "lidmap.json");
        try {
            if (fs.existsSync(mapPath)) {
                const data = JSON.parse(fs.readFileSync(mapPath, "utf-8"));
                const map = lidMaps.get(sessionId)!;
                for (const [lid, phone] of Object.entries(data)) {
                    map.set(lid, phone as string);
                }
                console.log(`[JID] Loaded ${map.size} LID mappings for session ${sessionId}`);
            }
        } catch { /* ignore */ }
    }
    return lidMaps.get(sessionId)!;
}

export function saveLidMap(sessionId: string) {
    const map = lidMaps.get(sessionId);
    if (!map || map.size === 0) return;
    const mapPath = path.join(SESSIONS_DIR, sessionId, "lidmap.json");
    try {
        const obj: Record<string, string> = {};
        for (const [lid, phone] of map) obj[lid] = phone;
        fs.writeFileSync(mapPath, JSON.stringify(obj, null, 2));
    } catch { /* ignore */ }
}

export function getAllLidMappings(sessionId: string): Record<string, string> {
    const map = getLidMap(sessionId);
    const obj: Record<string, string> = {};
    for (const [lid, phone] of map) obj[lid] = phone;
    return obj;
}

export function setLidMapping(sessionId: string, lid: string, phone: string): void {
    const cleanLid = lid.endsWith("@lid") ? lid : `${lid}@lid`;
    const cleanPhone = phone.endsWith("@s.whatsapp.net") ? phone : `${phone.replace(/\D/g, "")}@s.whatsapp.net`;
    const map = getLidMap(sessionId);
    if (map.get(cleanLid) !== cleanPhone) {
        map.set(cleanLid, cleanPhone);
        saveLidMap(sessionId);
    }
}

/**
 * Resolve a JID to a phone-based JID and clean digits.
 * Multi-tier resolution strategy:
 * 1. Direct phone JID (@s.whatsapp.net)
 * 2. Alt fields (remoteJidAlt / participantAlt) if provided by Baileys v7+
 * 3. Session's persistent lidmap.json and in-memory cache
 * 4. Baileys Signal Repository lidMapping lookup (sock.signalRepository.lidMapping)
 * 5. Baileys contact store (sock.store.contacts)
 * 6. jidNormalizedUser fallback
 */
export function resolveJid(
    sock: WASocket,
    rawJid: string,
    sessionId?: string,
    altJid?: string
): { resolvedJid: string; phoneNumber: string | null } {
    if (!rawJid) return { resolvedJid: "", phoneNumber: null };

    // 1. Direct phone JID
    if (rawJid.endsWith("@s.whatsapp.net")) {
        const phone = rawJid.replace("@s.whatsapp.net", "");
        return { resolvedJid: rawJid, phoneNumber: phone };
    }

    // 2. Check if altJid is provided and is a valid phone JID
    if (altJid && altJid.endsWith("@s.whatsapp.net")) {
        const phone = altJid.replace("@s.whatsapp.net", "");
        if (sessionId && (rawJid.endsWith("@lid") || isLidUser(rawJid))) {
            setLidMapping(sessionId, rawJid, altJid);
            console.log(`[JID] Resolved & learned LID ${rawJid} → ${altJid} (from Alt field)`);
        }
        return { resolvedJid: altJid, phoneNumber: phone };
    }

    // 3. LID Resolution
    if (rawJid.endsWith("@lid") || isLidUser(rawJid)) {
        // Priority 1: Check session's persistent LID map
        if (sessionId) {
            const lidMap = getLidMap(sessionId);
            const mapped = lidMap.get(rawJid);
            if (mapped) {
                const phone = mapped.replace("@s.whatsapp.net", "");
                return { resolvedJid: mapped, phoneNumber: phone };
            }
        }

        // Priority 2: Check Baileys native signalRepository lidMapping (Baileys v7+ / internal signal store)
        try {
            const signalRepo = (sock as any).signalRepository;
            if (signalRepo?.lidMapping) {
                const pn = typeof signalRepo.lidMapping.getPNForLID === "function"
                    ? signalRepo.lidMapping.getPNForLID(rawJid)
                    : null;
                if (pn && typeof pn === "string" && pn.endsWith("@s.whatsapp.net")) {
                    const phone = pn.replace("@s.whatsapp.net", "");
                    if (sessionId) setLidMapping(sessionId, rawJid, pn);
                    console.log(`[JID] Resolved LID ${rawJid} → ${pn} (from signalRepository.lidMapping)`);
                    return { resolvedJid: pn, phoneNumber: phone };
                }
            }
        } catch { /* ignore */ }

        // Priority 3: Try sock.store.contacts
        try {
            const store = (sock as any).store;
            if (store?.contacts) {
                const contact = store.contacts[rawJid];
                if (contact?.id && contact.id.endsWith("@s.whatsapp.net")) {
                    const phone = contact.id.replace("@s.whatsapp.net", "");
                    if (sessionId) setLidMapping(sessionId, rawJid, contact.id);
                    console.log(`[JID] Resolved LID ${rawJid} → ${contact.id} (from store.contacts)`);
                    return { resolvedJid: contact.id, phoneNumber: phone };
                }
            }

            // Priority 4: Try jidNormalizedUser
            const normalized = jidNormalizedUser(rawJid);
            if (normalized && normalized !== rawJid && normalized.endsWith("@s.whatsapp.net")) {
                const phone = normalized.replace("@s.whatsapp.net", "");
                if (sessionId) setLidMapping(sessionId, rawJid, normalized);
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

interface SessionPersistedConfig {
    accountType: AccountType;
    antiBanOverride?: AntiBanOverride;
}

/** Load persisted antiban config for a session (survives restarts) */
function loadSessionConfig(sessionId: string): SessionPersistedConfig | undefined {
    const configPath = path.join(SESSIONS_DIR, sessionId, "config.json");
    try {
        if (fs.existsSync(configPath)) {
            return JSON.parse(fs.readFileSync(configPath, "utf-8"));
        }
    } catch { /* ignore */ }
    return undefined;
}

/** Persist antiban config so it survives restarts */
function saveSessionConfig(sessionId: string, accountType: AccountType, override?: AntiBanOverride) {
    const dir = path.join(SESSIONS_DIR, sessionId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const configPath = path.join(dir, "config.json");
    try {
        const data: SessionPersistedConfig = { accountType, antiBanOverride: override };
        fs.writeFileSync(configPath, JSON.stringify(data));
    } catch (err) {
        console.error(`[antiban] Failed to save config for ${sessionId}:`, err);
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
    let finalAccountType = accountType;
    let finalOverride = antiBanOverride;

    // If explicit args weren't passed (e.g., auto-restore), try loading from disk
    if (accountType === "fresh" && !antiBanOverride) {
        const savedConfig = loadSessionConfig(sessionId);
        if (savedConfig) {
            finalAccountType = savedConfig.accountType;
            finalOverride = savedConfig.antiBanOverride;
        }
    } else {
        // Explicit args were passed (e.g. from /session/start), save them to disk
        saveSessionConfig(sessionId, accountType, antiBanOverride);
    }

    const baseConfig = getAccountProfile(finalAccountType);
    const finalConfig = mergeAntiBanConfig(baseConfig, {
        ...finalOverride,
        health: {
            ...finalOverride?.health,
            onRiskChange: (status: HealthStatus) => {
                console.log(`[antiban][${sessionId}] Risk: ${status.risk} — ${status.recommendation}`);
            },
        },
    });
    console.log(`[antiban][${sessionId}] Using "${finalAccountType}" profile`);

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
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        logger: pino({ level: "silent" }),
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

    // ── Build LID→phone map from contacts events ──────────────────────
    sock.ev.on("contacts.upsert", (contacts: any[]) => {
        const lidMap = getLidMap(sessionId);
        let newMappings = 0;
        for (const contact of contacts) {
            // Baileys contact objects can have id (phone JID) and lid fields
            const phoneJid = contact.id;  // e.g. "8801533021652@s.whatsapp.net"
            const lid = contact.lid;       // e.g. "37619769577647@lid"

            if (lid && phoneJid && phoneJid.endsWith("@s.whatsapp.net") && lid.endsWith("@lid")) {
                if (!lidMap.has(lid)) {
                    lidMap.set(lid, phoneJid);
                    newMappings++;
                }
            }
        }
        if (newMappings > 0) {
            console.log(`[JID] Learned ${newMappings} new LID→phone mappings (total: ${lidMap.size}) for session ${sessionId}`);
            saveLidMap(sessionId);
        }
    });

    sock.ev.on("contacts.update", (updates: any[]) => {
        const lidMap = getLidMap(sessionId);
        let newMappings = 0;
        for (const update of updates) {
            const phoneJid = update.id;
            const lid = update.lid;
            if (lid && phoneJid && phoneJid.endsWith("@s.whatsapp.net") && lid.endsWith("@lid")) {
                if (!lidMap.has(lid)) {
                    lidMap.set(lid, phoneJid);
                    newMappings++;
                }
            }
        }
        if (newMappings > 0) {
            console.log(`[JID] Updated ${newMappings} LID→phone mappings (total: ${lidMap.size}) for session ${sessionId}`);
            saveLidMap(sessionId);
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

            // Extract protocol Alt fields (remoteJidAlt / participantAlt) if available
            const rawAlt = (msg.key as any).remoteJidAlt || (msg.key as any).participantAlt;
            let { resolvedJid: from, phoneNumber } = resolveJid(sock, rawJid, sessionId, rawAlt);

            // Fallback for @lid: try resolving phone number from participant
            if (!phoneNumber && (rawJid.includes("@lid") || isLidUser(rawJid)) && msg.key.participant) {
                const participantJid = msg.key.participant;
                if (participantJid.endsWith("@s.whatsapp.net")) {
                    phoneNumber = participantJid.replace("@s.whatsapp.net", "");
                    setLidMapping(sessionId, rawJid, participantJid);
                    console.log(`[JID] Resolved phone from participant for LID ${rawJid} → ${phoneNumber}`);
                }
            }

            let messageBody = "";
            let messageType: "text" | "image" | "video" | "document" | "audio" | "ptt" | "call" | "other" = "other";
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
                const isPtt = msg.message.audioMessage.ptt;
                messageBody = isPtt ? "[🎙️ Voice Message]" : "[🎵 Audio]";
                messageType = isPtt ? "ptt" : "audio";
            } else if ((msg.message as any).pttMessage) {
                messageBody = "[🎙️ Voice Message]";
                messageType = "ptt";
            } else {
                messageBody = "[Unsupported message type]";
                messageType = "other";
            }

            const isImage = messageType === "image";
            const isVoice = messageType === "audio" || messageType === "ptt";
            if (!isImage && !isVoice && (!messageBody || messageBody.startsWith("["))) continue;
            if (isImage && !imageBase64 && !messageBody) continue;

            const timestamp = new Date((msg.messageTimestamp as number) * 1000).toISOString();

            const messageKeyPayload = {
                remoteJid: msg.key.remoteJid || undefined,
                remoteJidAlt: (msg.key as any).remoteJidAlt || undefined,
                id: msg.key.id || undefined,
                fromMe: msg.key.fromMe || undefined,
                participant: msg.key.participant || undefined,
                participantAlt: (msg.key as any).participantAlt || undefined,
            };

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
                    message_key: messageKeyPayload,
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
                message_key: messageKeyPayload,
                ...(imageBase64 && { image_base64: imageBase64 }),
            });
        }
    });

    // Handle incoming calls
    sock.ev.on("call", async (calls: any[]) => {
        for (const call of calls) {
            // Only process incoming calls when they are offered (ringing)
            if (call.status !== "offer") continue;

            const rawJid = call.from;
            if (!rawJid) continue;

            const { resolvedJid: from, phoneNumber } = resolveJid(sock, rawJid, sessionId);
            const timestamp = new Date((call.date?.getTime() || Date.now())).toISOString();

            await sendWebhook({
                session_id: sessionId,
                from,
                phone_number: phoneNumber || undefined,
                message_body: "[📞 Incoming call]",
                timestamp,
                message_type: "call",
                direction: "inbound",
                ai_generated: false,
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

    // Save the new config exactly as given so it survives restarts
    saveSessionConfig(sessionId, accountType, antiBanOverride);

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
        // Normalize recipient JID (support plain digits, @s.whatsapp.net, or @lid)
        let targetJid = to.trim();
        if (!targetJid.includes("@")) {
            targetJid = `${targetJid.replace(/\D/g, "")}@s.whatsapp.net`;
        }

        await session.socket.sendMessage(targetJid, { text: message });
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
        let targetJid = to.trim();
        if (!targetJid.includes("@")) {
            targetJid = `${targetJid.replace(/\D/g, "")}@s.whatsapp.net`;
        }

        await session.socket.sendPresenceUpdate(presence, targetJid);
        session.lastActive = new Date().toISOString();
        return true;
    } catch (err) {
        console.error(`Send presence error for session ${sessionId}:`, err);
        throw err;
    }
}

export async function sendRead(
    sessionId: string,
    messageKey: {
        remoteJid?: string;
        remoteJidAlt?: string;
        id?: string;
        fromMe?: boolean;
        participant?: string;
        participantAlt?: string;
    }
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

/** Automatically restart all existing sessions with valid credentials */
export async function restoreSessions(): Promise<void> {
    console.log(`[system] Auto-restoring sessions from disk...`);

    try {
        const contents = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
        let restoredCount = 0;

        for (const item of contents) {
            if (item.isDirectory()) {
                const sessionId = item.name;
                const credsPath = path.join(SESSIONS_DIR, sessionId, "creds.json");

                if (fs.existsSync(credsPath)) {
                    console.log(`[system] Restoring session: ${sessionId}`);
                    // Start in the background to avoid blocking server boot
                    startSession(sessionId).catch(err => {
                        console.error(`[system] Failed to restore session ${sessionId}:`, err);
                    });
                    restoredCount++;
                }
            }
        }

        console.log(`[system] Restoring ${restoredCount} sessions in background...`);
    } catch (err) {
        console.error(`[system] Error reading sessions directory for auto-restore:`, err);
    }
}
