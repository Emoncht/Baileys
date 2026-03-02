import { Router, Request, Response } from "express";
import { sendMessage } from "../services/sessionManager";
import { messageRateLimiter } from "../middleware/rateLimiter";
import { SendMessageRequest } from "../types";

const router = Router();

// POST /message/send — Send a WhatsApp message
router.post("/send", messageRateLimiter, async (req: Request, res: Response) => {
    try {
        const { user_id, to, message } = req.body as SendMessageRequest;
        if (!user_id || !to || !message) {
            return res.status(400).json({ error: "user_id, to, and message are required" });
        }

        await sendMessage(user_id, to, message);
        res.json({ success: true });
    } catch (err: any) {
        console.error("Send message error:", err);
        res.status(500).json({ error: err.message });
    }
});

export default router;
