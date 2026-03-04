import { Router, Request, Response } from "express";
import { sendMessage, sendPresence, sendRead, getAntiBanStats, updateAntiBanConfig } from "../services/sessionManager";
import { messageRateLimiter } from "../middleware/rateLimiter";
import type { SendMessageRequest, SendPresenceRequest, SendReadRequest, AntiBanOverride, AccountType } from "../types";

const router = Router();

// POST /message/send — Send a WhatsApp message (rate-limited by antiban automatically)
router.post("/send", messageRateLimiter, async (req: Request, res: Response) => {
    try {
        const { sessionId, to, message } = req.body as SendMessageRequest;
        if (!sessionId || !to || !message) {
            return res.status(400).json({ error: "sessionId, to, and message are required" });
        }

        await sendMessage(sessionId, to, message);
        res.json({ success: true });
    } catch (err: any) {
        console.error("Send message error:", err);
        res.status(500).json({ error: err.message });
    }
});

// POST /message/presence — Send a presence update (e.g. "composing" / typing)
router.post("/presence", async (req: Request, res: Response) => {
    try {
        const { sessionId, to, presence } = req.body as SendPresenceRequest;
        if (!sessionId || !to || !presence) {
            return res.status(400).json({ error: "sessionId, to, and presence are required" });
        }

        await sendPresence(sessionId, to, presence);
        res.json({ success: true });
    } catch (err: any) {
        console.error("Send presence error:", err);
        res.status(500).json({ error: err.message });
    }
});

// POST /message/read — Send a read receipt for a message
router.post("/read", async (req: Request, res: Response) => {
    try {
        const { sessionId, to, messageKey } = req.body as SendReadRequest;
        if (!sessionId || !messageKey) {
            return res.status(400).json({ error: "sessionId and messageKey are required" });
        }

        await sendRead(sessionId, messageKey);
        res.json({ success: true });
    } catch (err: any) {
        console.error("Send read error:", err);
        res.status(500).json({ error: err.message });
    }
});

// GET /message/antiban/stats/:sessionId — Get antiban health stats for a session
router.get("/antiban/stats/:sessionId", (req: Request, res: Response) => {
    try {
        const { sessionId } = req.params;
        const stats = getAntiBanStats(sessionId);
        if (!stats) return res.status(404).json({ error: "Session not found or antiban not active" });
        res.json(stats);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /message/antiban/config/:sessionId — Update antiban config on a running session
router.put("/antiban/config/:sessionId", (req: Request, res: Response) => {
    try {
        const { sessionId } = req.params;
        const { accountType, antiBanOverride } = req.body as {
            accountType?: AccountType;
            antiBanOverride?: AntiBanOverride;
        };

        const stats = updateAntiBanConfig(sessionId, accountType, antiBanOverride);
        if (!stats) return res.status(404).json({ error: "Session not found" });

        res.json({ success: true, stats });
    } catch (err: any) {
        console.error("Update antiban config error:", err);
        res.status(500).json({ error: err.message });
    }
});

export default router;
