import { Router, Request, Response } from "express";
import { sendMessage, getAntiBanStats } from "../services/sessionManager";
import { messageRateLimiter } from "../middleware/rateLimiter";
import { SendMessageRequest } from "../types";

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

export default router;
