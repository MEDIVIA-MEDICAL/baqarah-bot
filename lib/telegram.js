// lib/telegram.js
// دوال بسيطة للإرسال عن طريق Telegram Bot API مباشرة (من غير polling)
// عشان تشتغل تمام جوه Vercel serverless functions.

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

async function callTelegram(method, payload) {
  const res = await fetch(`${TELEGRAM_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error(`Telegram API error (${method}):`, data);
  }
  return data;
}

function sendMessage(chatId, text, extra = {}) {
  return callTelegram('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...extra,
  });
}

function sendPhoto(chatId, photoUrl, caption = '') {
  return callTelegram('sendPhoto', {
    chat_id: chatId,
    photo: photoUrl,
    caption,
    parse_mode: 'HTML',
  });
}

function sendAudio(chatId, audioUrl, caption = '') {
  return callTelegram('sendAudio', {
    chat_id: chatId,
    audio: audioUrl,
    caption,
    parse_mode: 'HTML',
  });
}

function sendVideo(chatId, videoUrl, caption = '') {
  return callTelegram('sendVideo', {
    chat_id: chatId,
    video: videoUrl,
    caption,
    parse_mode: 'HTML',
  });
}

function answerCallbackQuery(callbackQueryId, text) {
  return callTelegram('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
    show_alert: false,
  });
}

// بيبعت صفحة اليوم كاملة: خريطة ذهنية + صوت + تفسير
async function sendDailyPage(chatId, content) {
  await sendMessage(
    chatId,
    `📖 <b>صفحة اليوم: ${content.pageNumber}</b>\n(${content.versesRange})`
  );

  if (content.quranPageImageUrl) {
    await sendPhoto(chatId, content.quranPageImageUrl, '📄 نص الصفحة من المصحف');
  }

  if (content.videoUrl) {
    await sendVideo(chatId, content.videoUrl, '🎥 فيديو قراءة الصفحة - د. أيمن سويد');
  }

  if (content.audioUrl) {
    await sendAudio(
      chatId,
      content.audioUrl,
      content.audioUrl2 ? '🎧 ملف صوتي (1/2)' : '🎧 ملف صوتي لتلاوة الصفحة'
    );
  }

  if (content.audioUrl2) {
    await sendAudio(chatId, content.audioUrl2, '🎧 ملف صوتي (2/2)');
  }

  if (content.mindmapImageUrl) {
    await sendPhoto(chatId, content.mindmapImageUrl, '🧠 الخريطة الذهنية للصفحة');
  }

  if (content.tafsirText) {
    await sendMessage(chatId, `📝 <b>التفسير:</b>\n${content.tafsirText}`);
  }
}

// بيبعت سؤال تثبيت بعد صفحة معينة (يوم 2/4/6 من الدورة) - نوعه اختيارات
function sendQuickCheck(chatId, quiz, pageNumber) {
  const buttons = Object.entries(quiz.options)
    .filter(([, text]) => text)
    .map(([key, text]) => [
      {
        text: `${key}) ${text}`,
        callback_data: `quick:${pageNumber}:${key}`,
      },
    ]);

  return sendMessage(chatId, `🧩 <b>سؤال تثبيت:</b>\n${quiz.question}`, {
    reply_markup: { inline_keyboard: buttons },
  });
}

// بيبعت سؤال "إكمال الآية" كزرار تعليم ذاتي بس - المستخدم يسمّع بنفسه من الصوت/الفيديو
// وبعدين يضغط الزرار عشان يأكّد إنه سمّعها، من غير أي تصحيح آلي للنص
function sendSelfCheck(chatId, quiz, callbackData) {
  return sendMessage(chatId, `🎙️ ${quiz.question}`, {
    reply_markup: {
      inline_keyboard: [[{ text: '✅ سمّعتها', callback_data: callbackData }]],
    },
  });
}

// بيبعت سؤال من ضمن كويز المراجعة الكبير (يوم 7) - نوعه اختيارات. رقم السؤال
// مش محتاج نبعته في الزرار، لأن البوت بيتابعه من شيت التقدم بتاع المستخدم نفسه.
function sendReviewQuestion(chatId, quiz, questionNumber, totalQuestions) {
  const buttons = Object.entries(quiz.options)
    .filter(([, text]) => text)
    .map(([key, text]) => [
      {
        text: `${key}) ${text}`,
        callback_data: `review:${key}`,
      },
    ]);

  return sendMessage(
    chatId,
    `🌟 <b>سؤال المراجعة (${questionNumber}/${totalQuestions}):</b>\n${quiz.question}`,
    { reply_markup: { inline_keyboard: buttons } }
  );
}

// نسخة "إكمال الآية" جوه يوم المراجعة الكبير - زرار تعليم ذاتي برضو
function sendReviewSelfCheck(chatId, quiz, questionNumber, totalQuestions) {
  return sendMessage(
    chatId,
    `🌟 <b>سؤال المراجعة (${questionNumber}/${totalQuestions}):</b>\n🎙️ ${quiz.question}`,
    {
      reply_markup: {
        inline_keyboard: [[{ text: '✅ سمّعتها', callback_data: 'reviewdone' }]],
      },
    }
  );
}

// بيبعت سؤال من ضمن اختبار محطة (صفحة 21/41/49 مثلاً) - نوعه اختيارات
function sendMilestoneQuestion(chatId, quiz, questionNumber, totalQuestions) {
  const buttons = Object.entries(quiz.options)
    .filter(([, text]) => text)
    .map(([key, text]) => [
      { text: `${key}) ${text}`, callback_data: `milestone:${key}` },
    ]);

  return sendMessage(
    chatId,
    `🏁 <b>سؤال اختبار المحطة (${questionNumber}/${totalQuestions}):</b>\n${quiz.question}`,
    { reply_markup: { inline_keyboard: buttons } }
  );
}

// بيبعت رسالة نتيجة اختبار المحطة - مفيهاش أي إيقاف، تشجيع بس والاستمرار عادي
function sendMilestoneResult(chatId, score, total) {
  return sendMessage(
    chatId,
    `🏁 <b>نتيجة اختبار المحطة: ${score} من ${total}</b>\n` +
      'استمر، كل اختبار بيثبّت حفظك أكتر 🌿'
  );
}

// بيبعت رسالة النتيجة + اختيار "تعيد ولا تكمل" لما نتيجة المراجعة تكون أقل من النص
function sendRepeatChoice(chatId, score, total) {
  return sendMessage(
    chatId,
    `📊 <b>نتيجتك في الاختيارات: ${score} من ${total}</b>\n` +
      'عايزة تعيدي نفس الصفحات التلاتة ولا تكمّلي عادي؟',
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔁 أعيد الصفحات', callback_data: 'reviewchoice:repeat' }],
          [{ text: '➡️ أكمّل', callback_data: 'reviewchoice:continue' }],
        ],
      },
    }
  );
}

// نسخة تذكير بس (من غير رقم النتيجة، لأنها بالفعل اتبعتت قبل كده)
function sendRepeatChoiceReminder(chatId) {
  return sendMessage(chatId, '⏰ متنسيش تختاري: تعيدي الصفحات ولا تكمّلي؟', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔁 أعيد الصفحات', callback_data: 'reviewchoice:repeat' }],
        [{ text: '➡️ أكمّل', callback_data: 'reviewchoice:continue' }],
      ],
    },
  });
}

// بيبعت رسالة تحفيزية قبل صفحة اليوم الجديدة
function sendMotivation(chatId, text) {
  return sendMessage(chatId, `🌟 ${text}`);
}

// ---------- الرسالة المثبتة ----------

// نص بيكتبه المستخدم (إنتِ) من الشيت ممكن فيه < أو & فتكسر تنسيق HTML، فبنهرّبهم
function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// تيليجرام بيرفض رسالة نصية أطول من 4096 حرف، فبنقسّم النص الطويل على أكتر من رسالة
function splitText(text, maxLen = 4000) {
  const chunks = [];
  let rest = String(text);
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf('\n', maxLen);
    if (cut < maxLen / 2) cut = maxLen;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim()) chunks.push(rest);
  return chunks;
}

// بيشوف هل في شات المستخدم رسالة مثبتة بالفعل (عشان منبعتش المثبت أكتر من مرة)
async function hasPinnedMessage(chatId) {
  const res = await callTelegram('getChat', { chat_id: chatId });
  return !!(res && res.ok && res.result && res.result.pinned_message);
}

// بيبعت الرسالة المثبتة (عنوان + زرار لكل قسم) ويثبتها في شات المستخدم مع البوت
async function sendAndPinMenu(chatId, config) {
  const introText = config.introText || 'اختاري من القائمة:';
  const buttons = config.sections.map((section, index) => [
    { text: section.name, callback_data: `info:${index}` },
  ]);

  const sent = await callTelegram('sendMessage', {
    chat_id: chatId,
    text: escapeHtml(introText),
    parse_mode: 'HTML',
    ...(buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {}),
  });

  const messageId = sent && sent.result && sent.result.message_id;
  if (!messageId) return;

  // نشيل أي تثبيت قديم الأول عشان ميتراكمش أكتر من رسالة مثبتة
  await callTelegram('unpinAllChatMessages', { chat_id: chatId });
  await callTelegram('pinChatMessage', {
    chat_id: chatId,
    message_id: messageId,
    disable_notification: true,
  });
}

// تيليجرام بيرفض تعليق (caption) أطول من 1024 حرف تحت صورة/فيديو/صوت،
// فلو التعليق طويل بنبعت الملف من غير تعليق وبعده التعليق كرسالة نصية عادية
const CAPTION_LIMIT = 1000;

async function sendMediaItem(chatId, sender, item) {
  const caption = item.caption || '';
  if (caption.length > CAPTION_LIMIT) {
    await sender(chatId, item.content, '');
    for (const chunk of splitText(caption)) {
      await sendMessage(chatId, escapeHtml(chunk));
    }
  } else {
    await sender(chatId, item.content, caption ? escapeHtml(caption) : '');
  }
}

// بيبعت كل محتوى قسم معين (نصوص / صور / فيديوهات / صوت) بالترتيب
async function sendSectionItems(chatId, items) {
  for (const item of items) {
    if (item.type === 'photo') {
      await sendMediaItem(chatId, sendPhoto, item);
    } else if (item.type === 'video') {
      await sendMediaItem(chatId, sendVideo, item);
    } else if (item.type === 'audio') {
      await sendMediaItem(chatId, sendAudio, item);
    } else {
      for (const chunk of splitText(item.content)) {
        await sendMessage(chatId, escapeHtml(chunk));
      }
    }
  }
}

module.exports = {
  sendMessage,
  sendPhoto,
  sendAudio,
  sendVideo,
  sendRepeatChoice,
  sendRepeatChoiceReminder,
  sendMotivation,
  sendAndPinMenu,
  hasPinnedMessage,
  sendSectionItems,
  sendDailyPage,
  sendQuickCheck,
  sendSelfCheck,
  sendReviewQuestion,
  sendReviewSelfCheck,
  sendMilestoneQuestion,
  sendMilestoneResult,
  answerCallbackQuery,
};
