// lib/broadcast.js
// /broadcast: رسالة تكتبيها (نص منسّق، أو صورة، أو صوت...) وتتبعت لكل المشتركين النشطين بضغطة تأكيد.
//
// الطريقة:
//   1) اكتبي رسالتك في شات البوت زي أي رسالة عادية.
//   2) اعملي Reply على رسالتك بالأمر /broadcast
//   3) البوت يعرضلك عدد المستلمين، وتضغطي "✅ إرسال للكل".
// البوت بينسخ رسالتك لكل مشترك بنفس شكلها بالظبط (copyMessage)، من غير "forwarded from".
// ملف مستقل: مفيش علاقة بالكرون.

const telegram = require('./telegram');
const sheets = require('./sheets');

const MAX_RECIPIENTS = 600; // أقصى عدد في المرة الواحدة (الإرسال بيتم في طلب واحد من تيليجرام)
const CONCURRENCY = 6; // رسايل بتتبعت مع بعض (تيليجرام بيسمح بحوالي 30 في الثانية)

const inProgress = new Set(); // عشان ضغطتين ورا بعض ما يبعتوش مرتين
const finished = new Set();

function ownerIds() {
  return String(process.env.OWNER_TELEGRAM_ID || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

// المشتركين النشطين (من غير حسابك إنتي)
function pickRecipients(users) {
  const owners = new Set(ownerIds());
  return users.filter((u) => u.subscribed && !owners.has(String(u.telegramId)));
}

async function handleCommand(chatId, message) {
  const source = message && message.reply_to_message;
  if (!source) {
    await telegram.sendMessage(
      chatId,
      '📣 <b>إزاي أبعت رسالة للكل؟</b>\n\n' +
        '1) اكتبي رسالتك هنا في الشات زي أي رسالة (ينفع نص منسّق أو صورة أو صوت).\n' +
        '2) اعملي Reply على رسالتك بالأمر /broadcast\n' +
        '3) هعرضلك عدد المستلمين وتضغطي "إرسال للكل".'
    );
    return;
  }

  const recipients = pickRecipients(await sheets.getAllUsers());
  if (recipients.length === 0) {
    await telegram.sendMessage(chatId, 'مفيش مشتركين نشطين أبعتلهم دلوقتي 🌿');
    return;
  }
  if (recipients.length > MAX_RECIPIENTS) {
    await telegram.sendMessage(
      chatId,
      `عدد المشتركين النشطين (${recipients.length}) أكبر من الحد الآمن للإرسال في مرة واحدة (${MAX_RECIPIENTS}). لازم نقسّمه، قوليلي.`
    );
    return;
  }

  await telegram.sendMessage(
    chatId,
    `📣 هتتبعت رسالتك (اللي عملتي لها Reply) لـ <b>${recipients.length}</b> مشترك نشط.\n` +
      'هتوصلك نسخة منها الأول عشان تشوفيها زي ما هتوصل لهم.',
    {
      reply_to_message_id: source.message_id,
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ إرسال للكل', callback_data: `bc:go:${source.message_id}` },
            { text: '❌ إلغاء', callback_data: 'bc:no' },
          ],
        ],
      },
    }
  );
}

async function handleCallback(cq, parts, isOwner) {
  if (!isOwner) {
    await telegram.answerCallbackQuery(cq.id, '🌿');
    return;
  }
  const chatId = cq.message.chat.id;
  const previewId = cq.message.message_id;

  if (parts[1] === 'no') {
    await telegram.answerCallbackQuery(cq.id, 'اتلغى');
    await telegram.editMessageText(chatId, previewId, '❌ اتلغى الإرسال.');
    return;
  }
  if (parts[1] !== 'go') {
    await telegram.answerCallbackQuery(cq.id, '🌿');
    return;
  }

  const sourceId = parseInt(parts[2], 10);
  const key = `${chatId}:${sourceId}`;
  if (inProgress.has(key) || finished.has(key)) {
    await telegram.answerCallbackQuery(cq.id, 'الرسالة دي اتبعتت أو بتتبعت بالفعل');
    return;
  }
  inProgress.add(key);

  try {
    await telegram.answerCallbackQuery(cq.id, '⏳ جاري الإرسال');
    await telegram.editMessageText(chatId, previewId, '⏳ جاري الإرسال... هبلّغك بالنتيجة أول ما أخلّص.');

    // نسخة ليكي الأول: لو الرسالة مش قابلة للنسخ (اتمسحت مثلًا) نوقف قبل ما نبعت لأي حد
    const test = await telegram.copyMessage(chatId, chatId, sourceId);
    if (!test || !test.ok) {
      await telegram.editMessageText(
        chatId,
        previewId,
        `❌ مقدرتش أنسخ الرسالة دي، فما بعتّش لأي حد.\n${(test && test.description) || ''}`
      );
      return;
    }

    const recipients = pickRecipients(await sheets.getAllUsers());
    if (recipients.length > MAX_RECIPIENTS) {
      await telegram.editMessageText(chatId, previewId, `❌ العدد (${recipients.length}) أكبر من ${MAX_RECIPIENTS}. ما بعتّش لأي حد.`);
      return;
    }

    let okCount = 0;
    const failedUsers = [];
    let cursor = 0;
    async function worker() {
      while (true) {
        const i = cursor++;
        if (i >= recipients.length) return;
        const user = recipients[i];
        const result = await telegram.copyMessage(user.chatId, chatId, sourceId);
        if (result && result.ok) okCount += 1;
        else failedUsers.push(user);
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    // نمسح علامة "حاظر" عشان الكرون ما يتأثرش بيها (هو بيتعامل مع الحظر بنفسه)
    failedUsers.forEach((u) => telegram.consumeBlocked(u.chatId));
    finished.add(key);

    let report = `✅ اتبعتت لـ <b>${okCount}</b> مشترك.`;
    if (failedUsers.length > 0) report += `\n🚫 ${failedUsers.length} ما وصلهمش (غالبًا حاظرين البوت).`;
    await telegram.editMessageText(chatId, previewId, report);
  } finally {
    inProgress.delete(key);
  }
}

module.exports = { handleCommand, handleCallback };
