import express from "express";
import { config } from "./config";
import { apiKeyAuth } from "./middleware/auth";
import sessionRoutes from "./routes/session";
import messageRoutes from "./routes/message";

const app = express();

app.use(express.json());

// Health check (no auth required)
app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// All other routes require API key
app.use("/session", apiKeyAuth, sessionRoutes);
app.use("/message", apiKeyAuth, messageRoutes);

app.listen(config.port, () => {
    console.log(`Baileys server running on port ${config.port}`);
});
