import { Router, Request, Response } from "express";
import {
    startSession,
    getSessionStatus,
    getQR,
    disconnectSession,
} from "../services/sessionManager";
import { qrRateLimiter } from "../middleware/rateLimiter";

const router = Router();

// POST /session/start — Start a new WhatsApp session and get QR
router.post("/start", qrRateLimiter, async (req: Request, res: Response) => {
    try {
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ error: "userId is required" });

        const result = await startSession(userId);
        res.json(result);
    } catch (err: any) {
        console.error("Start session error:", err);
        res.status(500).json({ error: err.message });
    }
});

// GET /session/qr/:userId — Get current QR code
router.get("/qr/:userId", qrRateLimiter, (req: Request, res: Response) => {
    try {
        const { userId } = req.params;
        const qr = getQR(userId);
        res.json({ qr });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// GET /session/status/:userId — Get connection status
router.get("/status/:userId", (req: Request, res: Response) => {
    try {
        const { userId } = req.params;
        const status = getSessionStatus(userId);
        res.json(status);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// POST /session/disconnect/:userId — Disconnect and clean up
router.post("/disconnect/:userId", async (req: Request, res: Response) => {
    try {
        const { userId } = req.params;
        await disconnectSession(userId);
        res.json({ success: true });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
