import { Router, Request, Response } from "express";
import {
    startSession,
    getSessionStatus,
    getQR,
    disconnectSession,
    getAllLidMappings,
    setLidMapping,
} from "../services/sessionManager";
import { qrRateLimiter } from "../middleware/rateLimiter";
import type { StartSessionRequest, SetLidMappingRequest } from "../types";

const router = Router();

// POST /session/start — Start a new WhatsApp session and get QR
router.post("/start", qrRateLimiter, async (req: Request, res: Response) => {
    try {
        const { sessionId, accountType, antiBanOverride } = req.body as StartSessionRequest;
        if (!sessionId) return res.status(400).json({ error: "sessionId is required" });

        const result = await startSession(sessionId, accountType, antiBanOverride);
        res.json(result);
    } catch (err: any) {
        console.error("Start session error:", err);
        res.status(500).json({ error: err.message });
    }
});

// GET /session/qr/:sessionId — Get current QR code
router.get("/qr/:sessionId", qrRateLimiter, (req: Request, res: Response) => {
    try {
        const { sessionId } = req.params;
        const qr = getQR(sessionId);
        res.json({ qr });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// GET /session/status/:sessionId — Get connection status
router.get("/status/:sessionId", (req: Request, res: Response) => {
    try {
        const { sessionId } = req.params;
        const status = getSessionStatus(sessionId);
        res.json(status);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// GET /session/lidmap/:sessionId — Get all known LID to phone mappings
router.get("/lidmap/:sessionId", (req: Request, res: Response) => {
    try {
        const { sessionId } = req.params;
        const mappings = getAllLidMappings(sessionId);
        res.json({ sessionId, total: Object.keys(mappings).length, mappings });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// POST /session/lidmap/:sessionId — Set or update a LID to phone mapping
router.post("/lidmap/:sessionId", (req: Request, res: Response) => {
    try {
        const { sessionId } = req.params;
        const { lid, phoneNumber } = req.body as SetLidMappingRequest;
        if (!lid || !phoneNumber) {
            return res.status(400).json({ error: "lid and phoneNumber are required" });
        }
        setLidMapping(sessionId, lid, phoneNumber);
        res.json({ success: true, message: `Mapped ${lid} -> ${phoneNumber}` });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// POST /session/disconnect/:sessionId — Disconnect and clean up
router.post("/disconnect/:sessionId", async (req: Request, res: Response) => {
    try {
        const { sessionId } = req.params;
        await disconnectSession(sessionId);
        res.json({ success: true });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
