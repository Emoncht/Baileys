import rateLimit from "express-rate-limit";

export const qrRateLimiter = rateLimit({
    windowMs: 60 * 1000,    // 1 minute
    max: 10,                 // 10 QR requests per minute per IP
    message: { error: "Too many QR requests. Try again later." },
});

export const messageRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,                 // 60 messages per minute per IP
    message: { error: "Too many message requests. Try again later." },
});
