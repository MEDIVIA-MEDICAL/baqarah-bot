// scripts/set-webhook.js
// تشغيل مرة واحدة بس بعد ما ترفعي المشروع على Vercel، عشان توصلي البوت بالرابط بتاعه.
// طريقة التشغيل من التيرمينال:
//   TELEGRAM_BOT_TOKEN=xxxx VERCEL_URL=https://your-project.vercel.app node scripts/set-webhook.js

const token = process.env.TELEGRAM_BOT_TOKEN;
const url = process.env.VERCEL_URL;

if (!token || !url) {
  console.error('محتاجة TELEGRAM_BOT_TOKEN و VERCEL_URL');
  process.exit(1);
}

fetch(`https://api.telegram.org/bot${token}/setWebhook?url=${url}/api/webhook`)
  .then((r) => r.json())
  .then((data) => console.log(data))
  .catch((err) => console.error(err));
