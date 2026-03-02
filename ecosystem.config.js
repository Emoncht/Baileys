module.exports = {
    apps: [
        {
            name: "whatsapp-baileys",
            script: "dist/index.js",
            instances: 1,
            autorestart: true,
            max_memory_restart: "500M",
            env: {
                NODE_ENV: "production",
            },
        },
    ],
};
