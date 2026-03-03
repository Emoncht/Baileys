import { config } from "../config";
import { WebhookPayload } from "../types";

export async function sendWebhook(payload: WebhookPayload): Promise<void> {
    try {
        const res = await fetch(config.webhookUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-webhook-secret": config.webhookSecret,
            },
            body: JSON.stringify(payload),
        });

        if (!res.ok) {
            const text = await res.text();
            console.error(`Webhook failed (${res.status}):`, text);
        } else {
            console.log(`Webhook sent (${payload.direction || "inbound"}) for user ${payload.user_id} from ${payload.from}`);
        }
    } catch (err) {
        console.error("Webhook send error:", err);
    }
}
