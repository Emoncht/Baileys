import dotenv from "dotenv";
dotenv.config();

export const config = {
    port: parseInt(process.env.PORT || "3500", 10),
    apiKey: process.env.API_KEY || "",
    webhookUrl: process.env.WEBHOOK_URL || "",
    webhookSecret: process.env.WEBHOOK_SECRET || "",
};

if (!config.apiKey) throw new Error("API_KEY is required");
if (!config.webhookUrl) throw new Error("WEBHOOK_URL is required");
if (!config.webhookSecret) throw new Error("WEBHOOK_SECRET is required");
