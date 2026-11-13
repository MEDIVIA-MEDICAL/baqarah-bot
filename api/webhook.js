// api/webhook.js
// ده اللي تيليجرام بيبعتله كل رسالة/ضغطة زرار من المستخدمين.
// رابطه هيبقى: https://<your-vercel-domain>/api/webhook

const sheets = require('../lib/sheets');
const telegram = require('../lib/telegram');
const { deliverFirstPage, communityLine } = require('../lib/daily');

// ملفات اختيارية: لو الملف مش مرفوع على GitHub البوت بيشتغل عادي من غيره والأمر بتاعه بس ما بيشتغلش.
// (لازم يفضل require بالاسم الصريح عشان Vercel يضمّ الملف.)
let rating = null; // lib/rating.js (استفتاء جودة البوت)
try {
  rating = require('../lib/rating');
} catch (err) {
  if (!err || err.code !== 'MODULE_NOT_FOUND') console.error('Failed to load lib/rating.js:', err);
}
let polls = null; // lib/polls.js (استفتاءات عامة: أسئلة جديدة بتكتبيها في الشيت)
try {
  polls = require('../lib/polls');
} catch (err) {
  if (!err || err.code !== 'MODULE_NOT_FOUND') console.error('Failed to load lib/polls.js:', err);
}
let broadcast = null; // lib/broadcast.js (رسالة للكل)
try {
  broadcast = require('../lib/broadcast');
} catch (err) {
  if (!err || err.code !== 'MODULE_NOT_FOUND') console.error('Failed to load lib/broadcast.js:', err);
}

// ---------- حد التسجيل ----------
// أول MAX_FREE_USERS مستخدم بيدخلوا عادي. بعد كده الدخول بكود من تاب Invites في الشيت.
// ممكن تغيّري الرقم من Vercel (متغير MAX_FREE_USERS) من غير ما تلمسي الكود.
const MAX_FREE_USERS = parseInt(process.env.MAX_FREE_USERS || '300', 10);

// الرسالة اللي بتظهر لمن يحاول يسجل بعد اكتمال العدد (عدّلي طريقة التواصل زي ما تحبي)
const ACCESS_FULL_TEXT =
  '🌿 أهلًا بيك!\n\n' +
  'البوت وصل دلوقتي للعدد الأقصى من المشتركين الجدد.\n' +
  'لو معاك كود دخول ابعته هنا في رسالة، أو افتح الرابط اللي فيه الكود.\n' +
  'ولو عايز تطلب كود، تواصل مع القائمين على البوت.';
const ACCESS_INVALID_TEXT =
  'لو كنت بتكتب كود دخول، فهو مش صحيح أو اتستخدم قبل كده 🌿\n' +
  'ولو محتاج كود، تواصل مع القائمين على البوت.';

// ---------- طلب دخول بزرار ----------
// لما العدد يكتمل، المستخدم بيلاقي زرار "اطلب دخول". بيوصلك إشعار فيه اسمه وزرار قبول/رفض.
const ACCESS_NOTIFY_CAP = 30; // أقصى عدد إشعارات طلبات في اليوم (الباقي بيتسجل وتشوفيه في /requests)
const REQUEST_BUTTON = { text: '📩 اطلب دخول', callback_data: 'reqaccess' };
const requestCooldown = new Map(); // لو تاب Requests مش موجود: منع تكرار الإشعار من نفس الشخص

async function sendAccessMessage(chatId, text) {
  const community = await communityLine();
  return telegram.sendMessage(chatId, community ? `${text}\n\n${community}` : text, {
    reply_markup: { inline_keyboard: [[REQUEST_BUTTON]] },
  });
}

function ownerIds() {
  return String(process.env.OWNER_TELEGRAM_ID || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function requestKeyboard(targetId) {
  return {
    inline_keyboard: [
      [
        { text: '✅ قبول', callback_data: `approve:${targetId}` },
        { text: '❌ رفض', callback_data: `reject:${targetId}` },
      ],
    ],
  };
}

function requestText(req) {
  return (
    '📩 <b>طلب دخول</b>\n\n' +
    `👤 ${esc(req.name || 'بدون اسم')}\n` +
    (req.username ? `🔗 @${esc(req.username)}\n` : '') +
    `🆔 ${req.telegramId}`
  );
}

async function notifyOwnersOfRequest(req) {
  for (const id of ownerIds()) {
    await telegram.sendMessage(id, requestText(req), { reply_markup: requestKeyboard(req.telegramId) });
  }
}

// بتحدد المستخدم مسجل ولا لأ، والتسجيل الجديد مفتوح ولا العدد اكتمل (المالك دايمًا مسموح له)
async function registrationStatus(telegramId) {
  if (isOwner(telegramId)) return { registered: true, full: false };
  let ids = await sheets.getRegisteredIds();
  if (ids.has(String(telegramId))) return { registered: true, full: false };
  // لو قرّبنا من الحد، نقرا الشيت بأحدث نسخة قبل ما نقرر (عشان ما نتعداش الحد)
  if (ids.size >= MAX_FREE_USERS - 10) {
    ids = await sheets.getRegisteredIds(true);
    if (ids.has(String(telegramId))) return { registered: true, full: false };
  }
  return { registered: false, full: ids.size >= MAX_FREE_USERS };
}

function escapeHtmlLocal(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// نص بعد "سمّعتها": تشجيع، ومعاه التعليق لو موجود في الشيت
function selfCheckDoneText(quiz) {
  const base = 'ما شاء الله عليك، استمر في الحفظ 🌿';
  return quiz && quiz.explanation ? `${base}\n\n💡 ${escapeHtmlLocal(quiz.explanation)}` : base;
}

// بيبعت سؤال التثبيت اللي بعد اللي اتجاوب (لو فيه). سؤال ورا سؤال بدل ما كلهم يتبعتوا مع بعض.
async function sendNextQuickQuestion(chatId, pageNumber, nextOccurrence) {
  const quizzes = await sheets.getQuizRowsForPage(pageNumber);
  if (nextOccurrence < quizzes.length) {
    await telegram.sendQuickCheckQuestion(chatId, quizzes[nextOccurrence], pageNumber, nextOccurrence);
  }
}

// إجابة سؤال تثبيت من نوع اختيارات (يوم 2/4/6)
async function handleQuickCheckAnswer(chatId, pageNumber, chosen, callbackQueryId, occurrence = 0, messageId) {
  const quiz = await sheets.getQuizByPageOccurrence(pageNumber, occurrence);
  if (!quiz) return;
  const correct = chosen === quiz.correct;
  await telegram.answerCallbackQuery(
    callbackQueryId,
    correct ? '✅ إجابة صحيحة!' : '❌ إجابة غير صحيحة'
  );
  // الاختيارات بتفضل ظاهرة في رسالة السؤال مع علامة الصح/الغلط
  await telegram.finishQuestionMessage(chatId, messageId, telegram.QUICK_HEADER, quiz, chosen);
  await telegram.sendAnswerFeedback(chatId, quiz, correct, '🎉 ممتاز! إجابة صحيحة');
  await sendNextQuickQuestion(chatId, pageNumber, occurrence + 1);
}

// تأكيد "سمّعتها" لسؤال إكمال الآية في يوم التثبيت - مفيهوش تصحيح، مجرد تشجيع
async function handleQuickCheckDone(chatId, callbackQueryId, pageNumber, occurrence = 0, messageId) {
  await telegram.answerCallbackQuery(callbackQueryId, '🌿 تمام');
  const quiz = pageNumber ? await sheets.getQuizByPageOccurrence(pageNumber, occurrence) : null;
  if (quiz) await telegram.finishQuestionMessage(chatId, messageId, '', quiz);
  else await telegram.clearKeyboard(chatId, messageId);
  // لو أنتِ كاتبة تعليق للسؤال ده في الشيت بيظهر مع التشجيع
  await telegram.sendMessage(chatId, selfCheckDoneText(quiz));
  if (pageNumber) await sendNextQuickQuestion(chatId, pageNumber, occurrence + 1);
}

// بيتقدّم لسؤال المراجعة الجاي، أو يقفل المراجعة ويقرر يكمل ولا يعيد لو ده آخر سؤال.
// scoreIncrement بيكون 0 أو 1 لأسئلة الاختيارات، ومفيش تأثير خالص لأسئلة "سمّعتها".
async function advanceReview(telegramId, chatId, scoreIncrement) {
  const user = await sheets.getUserProgress(telegramId);
  if (!user || user.reviewQueue.length === 0) return;

  const newScore = user.reviewScore + scoreIncrement;
  const newIndex = user.reviewQuestionIndex + 1;

  // لسه فيه أسئلة في الكويز (ولو سؤال اتمسح من الشيت بنعديه بدل ما البوت يقف)
  let nextIndex = newIndex;
  let nextQuiz = null;
  while (nextIndex < user.reviewQueue.length) {
    const [nextPage, nextOccurrence] = user.reviewQueue[nextIndex].split(':');
    nextQuiz = await sheets.getQuizByPageOccurrence(nextPage, parseInt(nextOccurrence, 10));
    if (nextQuiz) break;
    nextIndex += 1;
  }
  if (nextQuiz) {
    await sheets.updateUserFields(telegramId, {
      reviewScore: newScore,
      reviewQuestionIndex: nextIndex,
    });
    if (nextQuiz.type === 'complete') {
      await telegram.sendReviewSelfCheck(chatId, nextQuiz, nextIndex + 1, user.reviewQueue.length);
    } else {
      await telegram.sendReviewQuestion(chatId, nextQuiz, nextIndex + 1, user.reviewQueue.length);
    }
    return;
  }

  // خلص الكويز - نحسب النتيجة من أسئلة الاختيارات بس (أسئلة "سمّعتها" مالهاش تصحيح)
  const allEntryQuizzes = await Promise.all(
    user.reviewQueue.map((entry) => {
      const [page, occurrence] = entry.split(':');
      return sheets.getQuizByPageOccurrence(page, parseInt(occurrence, 10));
    })
  );
  const mcqTotal = allEntryQuizzes.filter((q) => q && q.type !== 'complete').length;
  const passed = mcqTotal === 0 || newScore / mcqTotal >= 0.5;
  const pages = [user.blockStartPage, user.blockStartPage + 1, user.blockStartPage + 2];

  // في الحالتين بنقفل جلسة المراجعة؛ لو النتيجة ضعيفة، منقررش إحنا، نسيب المستخدم يختار
  await sheets.updateUserFields(telegramId, {
    reviewQueue: [],
    reviewQuestionIndex: 0,
    reviewScore: 0,
    pendingChoice: passed ? '' : 'low_score',
  });

  if (passed) {
    await sheets.updateUserFields(telegramId, {
      currentPage: pages[2] + 1,
      blockStartPage: pages[2] + 1,
      cycleDay: 1,
    });
    await telegram.sendMessage(
      chatId,
      `🎉 <b>نتيجتك في الاختيارات: ${newScore} من ${mcqTotal}</b>\n` +
        'ما شاء الله، ثبّتّ الصفحات كويس. بكرة هتبدأ صفحة جديدة إن شاء الله 🌿'
    );
  } else {
    await telegram.sendRepeatChoice(chatId, newScore, mcqTotal);
  }
}

// اختيار المستخدم بعد نتيجة مراجعة ضعيفة: يعيد الصفحات التلاتة ولا يكمّل عادي
async function handleReviewChoice(telegramId, chatId, choice, callbackQueryId) {
  const user = await sheets.getUserProgress(telegramId);
  if (!user || user.pendingChoice !== 'low_score') return;

  const pages = [user.blockStartPage, user.blockStartPage + 1, user.blockStartPage + 2];

  if (choice === 'continue') {
    await telegram.answerCallbackQuery(callbackQueryId, '🌿 تمام');
    await sheets.updateUserFields(telegramId, {
      currentPage: pages[2] + 1,
      blockStartPage: pages[2] + 1,
      cycleDay: 1,
      pendingChoice: '',
    });
    await telegram.sendMessage(chatId, 'تمام، بكرة هتبدأ صفحة جديدة إن شاء الله 🌿');
  } else {
    // "repeat": هنبعت الصفحات التلاتة مع بعض في يوم واحد بكرة (مش موزعة على 6 أيام زي الأول)
    await telegram.answerCallbackQuery(callbackQueryId, '🌿 تمام');
    await sheets.updateUserFields(telegramId, {
      cycleDay: 8, // رقم خاص يعني "يوم إعادة مُجمّع" - الكرون هيتعرف عليه
      pendingChoice: '',
    });
    await telegram.sendMessage(
      chatId,
      `تمام، بكرة هتوصلك صفحات ${pages[0]} - ${pages[2]} التلاتة مع بعض كمراجعة مُجمّعة، وبعدها نكمل عادي 🌿`
    );
  }
}

// إجابة سؤال اختيارات ضمن يوم المراجعة الكبير
async function handleReviewAnswer(telegramId, chatId, chosen, callbackQueryId, messageId) {
  const user = await sheets.getUserProgress(telegramId);
  if (!user || user.reviewQueue.length === 0) return;

  const currentEntry = user.reviewQueue[user.reviewQuestionIndex];
  if (!currentEntry) return;
  const [page, occurrence] = currentEntry.split(':');
  const quiz = await sheets.getQuizByPageOccurrence(page, parseInt(occurrence, 10));
  if (!quiz) return;

  const correct = chosen === quiz.correct;
  await telegram.answerCallbackQuery(callbackQueryId, correct ? '✅ صح!' : '❌ غلط');
  const header = `🌟 <b>سؤال المراجعة (${user.reviewQuestionIndex + 1}/${user.reviewQueue.length}):</b>\n`;
  await telegram.finishQuestionMessage(chatId, messageId, header, quiz, chosen);
  // لو السؤال ليه تعليق في الشيت نعرضه قبل السؤال اللي بعده
  await telegram.sendAnswerFeedback(chatId, quiz, correct);
  await advanceReview(telegramId, chatId, correct ? 1 : 0);
}

// تأكيد "سمّعتها" لسؤال إكمال الآية جوه يوم المراجعة الكبير
async function handleReviewDone(telegramId, chatId, callbackQueryId, messageId) {
  await telegram.answerCallbackQuery(callbackQueryId, '🌿 تمام');
  const user = await sheets.getUserProgress(telegramId);
  if (!user || user.reviewQueue.length === 0) return;
  const currentEntry = user.reviewQueue[user.reviewQuestionIndex];
  if (!currentEntry) return;
  const [page, occurrence] = currentEntry.split(':');
  const quiz = await sheets.getQuizByPageOccurrence(page, parseInt(occurrence, 10));
  const header = `🌟 <b>سؤال المراجعة (${user.reviewQuestionIndex + 1}/${user.reviewQueue.length}):</b>\n`;
  if (quiz) await telegram.finishQuestionMessage(chatId, messageId, header, quiz);
  // لو فيه تعليق للسؤال ده في الشيت نعرضه قبل ما نكمل
  if (quiz && quiz.explanation) {
    await telegram.sendMessage(chatId, `💡 ${escapeHtmlLocal(quiz.explanation)}`);
  }
  await advanceReview(telegramId, chatId, 0);
}

// إجابة سؤال اختيارات ضمن اختبار محطة (صفحة 21/41/49 مثلاً) - مفيش إيقاف على النتيجة أبدًا
async function handleMilestoneAnswer(telegramId, chatId, chosen, callbackQueryId, messageId) {
  const user = await sheets.getUserProgress(telegramId);
  if (!user || user.milestoneQueue.length === 0) return;

  const occurrence = user.milestoneQueue[user.milestoneQuestionIndex];
  if (occurrence === undefined) return;
  const quiz = await sheets.getMilestoneQuizByOccurrence(user.milestonePage, parseInt(occurrence, 10));
  if (!quiz) return;

  const correct = chosen === quiz.correct;
  await telegram.answerCallbackQuery(callbackQueryId, correct ? '✅ صح!' : '❌ غلط');
  const header = `🏁 <b>سؤال اختبار المحطة (${user.milestoneQuestionIndex + 1}/${user.milestoneQueue.length}):</b>\n`;
  await telegram.finishQuestionMessage(chatId, messageId, header, quiz, chosen);
  await telegram.sendAnswerFeedback(chatId, quiz, correct);

  const newScore = user.milestoneScore + (correct ? 1 : 0);
  const newIndex = user.milestoneQuestionIndex + 1;

  let nextIndex = newIndex;
  let nextQuiz = null;
  while (nextIndex < user.milestoneQueue.length) {
    nextQuiz = await sheets.getMilestoneQuizByOccurrence(
      user.milestonePage,
      parseInt(user.milestoneQueue[nextIndex], 10)
    );
    if (nextQuiz) break;
    nextIndex += 1; // سؤال اتمسح من الشيت، نعديه
  }
  if (nextQuiz) {
    await sheets.updateUserFields(telegramId, {
      milestoneScore: newScore,
      milestoneQuestionIndex: nextIndex,
    });
    await telegram.sendMilestoneQuestion(chatId, nextQuiz, nextIndex + 1, user.milestoneQueue.length);
    return;
  }

  // خلص اختبار المحطة - بنعرض النتيجة بس ونرجع نكمل عادي من حيث كنا، من غير أي إيقاف
  await telegram.sendMilestoneResult(chatId, newScore, user.milestoneQueue.length);
  await sheets.updateUserFields(telegramId, {
    cycleDay: user.pendingResumeDay || 1,
    milestonePage: '',
    milestoneQueue: [],
    milestoneQuestionIndex: 0,
    milestoneScore: 0,
    pendingResumeDay: '',
  });
}

// بيبعت الرسالة المثبتة (لو تاب Pinned موجود في الشيت) ويثبتها في شات المستخدم.
// force = false (مع /start): لو فيه رسالة مثبتة بالفعل في الشات منبعتش تاني، فتتبعت مرة واحدة بس.
// force = true (مع /menu): تتبعت وتتثبت تاني حتى لو موجودة.
async function showPinnedMenu(chatId, force) {
  try {
    const config = await sheets.getPinnedConfig();
    if (!config) return;
    if (!force && (await telegram.hasPinnedMessage(chatId))) return;
    await telegram.sendAndPinMenu(chatId, config);
  } catch (err) {
    console.error('Pinned menu error:', err);
  }
}

// لما المستخدم يدوس على زرار قسم في الرسالة المثبتة، نبعتله محتوى القسم ده مرة واحدة بس.
async function handleInfoSection(telegramId, chatId, sectionIndex, callbackQueryId) {
  const config = await sheets.getPinnedConfig();
  const section = config && config.sections[sectionIndex];
  if (!section) {
    await telegram.answerCallbackQuery(callbackQueryId, '🌿');
    return;
  }

  const seen = await sheets.getPinnedSeen(telegramId);
  if (seen.includes(String(sectionIndex))) {
    await telegram.answerCallbackQuery(callbackQueryId, 'المحتوى ده اتبعت قبل كده، هتلاقيه فوق في الشات 🌿');
    return;
  }

  await telegram.answerCallbackQuery(callbackQueryId, '🌿');
  // بنسجّل الأول عشان لو داس مرتين ورا بعض مايتبعتش مرتين
  await sheets.markPinnedSeen(telegramId, sectionIndex);
  await telegram.sendSectionItems(chatId, section.items);
}

// ---------- أوامر المعاينة (ليكي إنتي بس) ----------
// OWNER_TELEGRAM_ID: متغير في Vercel فيه رقم تيليجرام بتاعك (ممكن أكتر من رقم مفصولين بفاصلة).
// الأوامر دي مش بتلمس تقدم أي مستخدم ومش بتكتب حاجة في الشيت.
function isOwner(telegramId) {
  const ids = String(process.env.OWNER_TELEGRAM_ID || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  return ids.includes(String(telegramId));
}

function previewHeader(pageKey, occ, total) {
  const isMilestone = /^m/i.test(pageKey);
  const page = pageKey.replace(/^m/i, '');
  return `🧪 <b>معاينة سؤال ${occ + 1}/${total} (${isMilestone ? 'محطة ' : 'صفحة '}${page}):</b>\n`;
}

// بيبعت سؤال معاينة واحد. pageKey زي "5" لأسئلة صفحة، أو "m21" لأسئلة محطة.
async function sendPreviewQuestion(chatId, pageKey, occ, quizzes) {
  const isMilestone = /^m/i.test(pageKey);
  const page = pageKey.replace(/^m/i, '');
  const quiz = quizzes[occ];
  const title = previewHeader(pageKey, occ, quizzes.length).trimEnd();

  if (quiz.type === 'complete') {
    await telegram.sendMessage(chatId, `${title}\n🎙️ ${quiz.question}`, {
      reply_markup: {
        inline_keyboard: [[{ text: '✅ سمّعتها', callback_data: `qprevdone:${pageKey}:${occ}` }]],
      },
    });
    return;
  }
  const buttons = Object.entries(quiz.options)
    .filter(([, text]) => text)
    .map(([key, text]) => [
      { text: `${key}) ${text}`, callback_data: `qprev:${pageKey}:${occ}:${key}` },
    ]);
  await telegram.sendMessage(chatId, `${title}\n${quiz.question}`, {
    reply_markup: { inline_keyboard: buttons },
  });
}

async function getPreviewQuizzes(pageKey) {
  const isMilestone = /^m/i.test(pageKey);
  const page = pageKey.replace(/^m/i, '');
  return isMilestone ? sheets.getMilestoneQuizRows(page) : sheets.getQuizRowsForPage(page);
}

// /stats -> إحصائيات سريعة عن المستخدمين (ليكي إنتي بس). قراءة بس، مفيش أي كتابة.
const FINAL_PAGE = 49; // لازم تفضل زي FINAL_PAGE في api/cron.js

// ---------- تنظيف الموقّفين (ليكي إنتي بس) ----------
// الموقّف = قفل الإرسال بـ /stop ولسه ما خلّصش السورة. بنعتمد على last_sent_date كتاريخ تقريبي للوقف.
const WARN_AFTER_DAYS = 7; // بعد كام يوم من الوقف نبعتله تنبيه
const GRACE_DAYS = 7; // المهلة بعد التنبيه قبل ما نفضّي مكانه
const PAUSED_WARNING_TEXT =
  '🌿 أهلًا بيك!\n\n' +
  'إنت موقّف الإرسال اليومي من فترة. لو لسه حابب تكمل رحلتك مع سورة البقرة اضغط /resume وهتكمل من حيث وقفت.\n\n' +
  `ولو مش هتكمل دلوقتي، هنفضّي مكانك بعد ${GRACE_DAYS} أيام عشان حد تاني يستفيد، وتقدر ترجع في أي وقت لو فيه مكان 🤍`;

function esc(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function daysSince(dateStr, todayStr) {
  const t = Date.parse(String(dateStr).slice(0, 10));
  if (!t) return null;
  return Math.floor((Date.parse(todayStr) - t) / 86400000);
}

function classifyPaused(users) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const c = { all: [], recent: [], toWarn: [], inGrace: [], toRemove: [], unknown: [], oldestDays: null, todayStr };
  for (const u of users) {
    if (u.subscribed || u.currentPage > FINAL_PAGE || isOwner(u.telegramId)) continue;
    c.all.push(u);
    if (u.warnedAt) {
      const blocked = u.warnedAt.includes('blocked'); // مش بيوصله تنبيه (حاظر البوت)
      const d = daysSince(u.warnedAt, todayStr);
      if (blocked || (d !== null && d >= GRACE_DAYS)) c.toRemove.push(u);
      else c.inGrace.push(u);
      continue;
    }
    const d = daysSince(u.lastSentDate, todayStr);
    if (d === null) {
      c.unknown.push(u);
      continue;
    }
    if (c.oldestDays === null || d > c.oldestDays) c.oldestDays = d;
    if (d >= WARN_AFTER_DAYS) c.toWarn.push(u);
    else c.recent.push(u);
  }
  return c;
}

// /inactive -> ملخص الموقّفين (قراءة بس)
async function handleOwnerInactive(chatId) {
  const c = classifyPaused(await sheets.getAllUsers());
  if (c.all.length === 0) {
    await telegram.sendMessage(chatId, '⏸️ مفيش مستخدمين موقّفين دلوقتي 🌿');
    return;
  }
  await telegram.sendMessage(
    chatId,
    `⏸️ <b>الموقّفين: ${c.all.length}</b>\n\n` +
      `🕐 وقفوا من أقل من ${WARN_AFTER_DAYS} أيام: ${c.recent.length}\n` +
      `✉️ جاهزين للتنبيه (/warn): ${c.toWarn.length}\n` +
      `⏳ اتنبّهوا وفي المهلة: ${c.inGrace.length}\n` +
      `🧹 جاهزين للمسح (/cleanup): ${c.toRemove.length}\n` +
      `❔ تاريخهم مش معروف: ${c.unknown.length}` +
      (c.oldestDays !== null ? `\n\nأقدم واحد وقف من حوالي ${c.oldestDays} يوم.` : '')
  );
}

// /warn -> يبعت تنبيه للموقّفين اللي بقالهم أكتر من WARN_AFTER_DAYS ويسجّل التاريخ
async function handleOwnerWarn(chatId) {
  const c = classifyPaused(await sheets.getAllUsers());
  if (c.toWarn.length === 0) {
    await telegram.sendMessage(chatId, 'مفيش حد محتاج تنبيه دلوقتي 🌿');
    return;
  }
  if (!(await sheets.progressHasColumn('warned_at'))) {
    await telegram.sendMessage(
      chatId,
      'محتاجة تضيفي عمود جديد في تاب Progress اسمه warned_at (اكتبيه في أول خانة فاضية في صف العناوين بعد pinned_seen)، وبعدين جرّبي /warn تاني. لسه ما بعتّش حاجة لأي حد.'
    );
    return;
  }

  const batch = c.toWarn.slice(0, 40); // نص دفعة صغيرة عشان الأمان
  const entries = [];
  const unreachable = [];
  let sent = 0;
  for (const u of batch) {
    const r = await telegram.sendMessage(u.chatId, PAUSED_WARNING_TEXT);
    if (r && r.ok) {
      sent += 1;
      entries.push({ telegramId: u.telegramId, value: c.todayStr });
    } else {
      unreachable.push(u);
      entries.push({ telegramId: u.telegramId, value: `${c.todayStr} blocked` });
    }
  }
  await sheets.markWarnedBatch(entries);

  let msg = `✉️ اتبعت تنبيه لـ ${sent} مستخدم. هيتنضّفوا بعد ${GRACE_DAYS} أيام لو ما رجعوش.`;
  if (unreachable.length > 0) {
    msg += `\n\n🚫 ${unreachable.length} مش بيوصلهم (غالبًا حاظرين البوت)، وجاهزين للمسح على طول:\n` +
      unreachable.slice(0, 10).map((u) => `• ${esc(u.name || u.telegramId)}`).join('\n');
  }
  if (c.toWarn.length > batch.length) {
    msg += `\n\nفاضل ${c.toWarn.length - batch.length} لسه، اكتبي /warn تاني.`;
  }
  await telegram.sendMessage(chatId, msg);
}

// /cleanup -> يعرض مين جاهز للمسح، و /cleanup confirm يمسح صفوفهم فعلًا
async function handleOwnerCleanup(chatId, arg) {
  const c = classifyPaused(await sheets.getAllUsers());
  if (c.toRemove.length === 0) {
    await telegram.sendMessage(
      chatId,
      `مفيش حد جاهز للمسح دلوقتي 🌿${c.inGrace.length ? `\n(فيه ${c.inGrace.length} لسه في مهلة الـ ${GRACE_DAYS} أيام)` : ''}`
    );
    return;
  }
  if (String(arg || '').toLowerCase() !== 'confirm') {
    const sample = c.toRemove.slice(0, 10).map((u) => `• ${esc(u.name || u.telegramId)}${u.warnedAt.includes('blocked') ? ' (حاظر البوت)' : ''}`).join('\n');
    await telegram.sendMessage(
      chatId,
      `🧹 <b>جاهزين للمسح: ${c.toRemove.length}</b>\n\n${sample}\n\n` +
        'المسح بيشيل صفوفهم من Progress وتقدمهم بيضيع نهائيًا.\n' +
        'لو متأكدة اكتبي: /cleanup confirm\n(الأحسن تعمليه في وقت هادي)'
    );
    return;
  }
  const removed = await sheets.deleteUsers(c.toRemove.map((u) => u.telegramId));
  await telegram.sendMessage(chatId, `🧹 اتمسح ${removed} مستخدم موقّف، واتفضّى ${removed} مكان 🌿`);
}

async function handleOwnerStats(chatId) {
  const users = await sheets.getAllUsers();
  const todayStr = new Date().toISOString().slice(0, 10);

  const finished = users.filter((u) => u.currentPage > FINAL_PAGE).length;
  const active = users.filter((u) => u.subscribed && u.currentPage <= FINAL_PAGE);
  const sentToday = active.filter((u) => u.lastSentDate === todayStr).length;
  const waiting = active.length - sentToday;
  const stopped = users.filter((u) => !u.subscribed && u.currentPage <= FINAL_PAGE).length;

  await telegram.sendMessage(
    chatId,
    `📊 <b>إحصائيات البوت</b>\n\n` +
      `👥 إجمالي المسجلين: ${users.length} (الحد: ${MAX_FREE_USERS})\n` +
      `🟢 مشتركين نشطين: ${active.length}\n` +
      `   ✉️ استلموا النهاردة: ${sentToday}\n` +
      `   ⏳ لسه متبعتلهمش النهاردة: ${waiting}\n` +
      `🏁 خلّصوا السورة: ${finished}\n` +
      `⏸️ موقّفين الإرسال: ${stopped}`
  );
}

// /preview 5  -> يبعتلك محتوى صفحة 5 كاملًا زي ما بيوصل للمستخدمين
// /quiz 5     -> يبعتلك أسئلة صفحة 5 سؤال ورا سؤال (كل ما تجاوبي يظهر اللي بعده)
// /quiz m21   -> نفس الحاجة لأسئلة اختبار محطة صفحة 21
async function handleOwnerPreview(cmd, arg, chatId) {
  if (!arg) {
    await telegram.sendMessage(chatId, 'اكتبي الأمر مع رقم الصفحة، مثلًا: /preview 5 أو /quiz 5 أو /quiz m21');
    return;
  }

  // نمسح الكاش عشان تشوفي أحدث تعديل في الشيت
  sheets.clearTabCache();

  if (cmd === '/preview') {
    const content = await sheets.getContentForPage(parseInt(arg, 10));
    if (!content) {
      await telegram.sendMessage(chatId, `مفيش محتوى لصفحة ${arg} في تاب Content.`);
      return;
    }
    await telegram.sendDailyPage(chatId, content);
    return;
  }

  // /quiz
  const quizzes = await getPreviewQuizzes(arg);
  if (quizzes.length === 0) {
    const label = /^m/i.test(arg) ? 'للمحطة' : 'لصفحة';
    await telegram.sendMessage(chatId, `مفيش أسئلة جاهزة ${label} ${arg.replace(/^m/i, '')}.`);
    return;
  }
  await sendPreviewQuestion(chatId, arg, 0, quizzes);
}

// إجابة سؤال معاينة: بتقيّم وتعرض نفس رد المستخدمين وبعدها السؤال اللي بعده، من غير ما تغيّر أي تقدم
async function handleQuizPreviewAnswer(telegramId, chatId, parts, callbackQueryId, messageId) {
  if (!isOwner(telegramId)) {
    await telegram.answerCallbackQuery(callbackQueryId, '🌿');
    return;
  }
  const [, pageKey, occRaw, chosen] = parts;
  const occ = parseInt(occRaw, 10);
  const quizzes = await getPreviewQuizzes(pageKey);
  const quiz = quizzes[occ];
  if (!quiz) {
    await telegram.answerCallbackQuery(callbackQueryId, 'السؤال مش موجود، جرّبي /quiz تاني');
    return;
  }
  const correct = chosen === quiz.correct;
  await telegram.answerCallbackQuery(callbackQueryId, correct ? '✅ صح!' : '❌ غلط');
  await telegram.finishQuestionMessage(chatId, messageId, previewHeader(pageKey, occ, quizzes.length), quiz, chosen);
  await telegram.sendAnswerFeedback(chatId, quiz, correct);
  if (occ + 1 < quizzes.length) await sendPreviewQuestion(chatId, pageKey, occ + 1, quizzes);
}

// زرار "سمّعتها" في المعاينة: يكمّل للسؤال اللي بعده
async function handleQuizPreviewDone(telegramId, chatId, parts, callbackQueryId, messageId) {
  if (!isOwner(telegramId)) {
    await telegram.answerCallbackQuery(callbackQueryId, '🌿');
    return;
  }
  const [, pageKey, occRaw] = parts;
  const occ = parseInt(occRaw, 10);
  await telegram.answerCallbackQuery(callbackQueryId, '🌿 تمام');
  const quizzes = await getPreviewQuizzes(pageKey);
  const quiz = quizzes[occ];
  if (quiz) {
    await telegram.finishQuestionMessage(chatId, messageId, previewHeader(pageKey, occ, quizzes.length), quiz);
    await telegram.sendMessage(chatId, selfCheckDoneText(quiz));
  } else {
    await telegram.clearKeyboard(chatId, messageId);
  }
  if (occ + 1 < quizzes.length) await sendPreviewQuestion(chatId, pageKey, occ + 1, quizzes);
}

// ---------- /today وزرار "ابعتلي صفحة اليوم": بيبعت آخر صفحة وصلت للمستخدم تاني ----------
// آخر صفحة اتبعتت بتتحدد من يوم الدورة الحالي:
//   2/4/6/7: آخر صفحة جديدة اتبعتت هي currentPage
//   1/3/5:   currentPage لسه اتقدمت (بعد يوم تثبيت أو بلوك جديد) فاللي اتبعتت هو اللي قبلها
//   9:       صفحة المحطة
function lastSentContentPage(user) {
  const d = user.cycleDay;
  if (d === 9 && user.milestonePage) return user.milestonePage;
  if (d === 1 || d === 3 || d === 5) return user.currentPage - 1;
  return user.currentPage;
}

const todayCooldown = new Map(); // عشان ضغط الزرار ورا بعض ما يبعتش الصفحة كذا مرة
const TODAY_COOLDOWN_MS = 15 * 1000;

async function handleToday(telegramId, chatId) {
  const now = Date.now();
  if (now - (todayCooldown.get(String(telegramId)) || 0) < TODAY_COOLDOWN_MS) return;
  todayCooldown.set(String(telegramId), now);

  const user = await sheets.getUserProgress(telegramId);
  if (!user) {
    await telegram.sendMessage(chatId, 'اكتب /start عشان تبدأ رحلة حفظ سورة البقرة 🌿');
    return;
  }

  // لسه ماستلمش ولا صفحة: نبعتله أول صفحة (نفس /start)
  if (!user.lastSentDate && user.currentPage === 1 && user.cycleDay === 1) {
    await deliverFirstPage(user, new Date().toISOString().slice(0, 10));
    return;
  }

  const page = lastSentContentPage(user);
  const content = page >= 1 ? await sheets.getContentForPage(page) : null;
  if (!content) {
    await telegram.sendMessage(chatId, 'مفيش صفحة جديدة اتبعتتلك لسه 🌿 هتوصلك في معادها إن شاء الله.');
    return;
  }
  await telegram.sendDailyPage(chatId, content);
}

// المستخدم ضغط "اطلب دخول"
async function handleAccessRequest(cq, telegramId, chatId) {
  const { registered, full } = await registrationStatus(telegramId);
  if (registered) {
    await telegram.answerCallbackQuery(cq.id, 'إنت مسجل بالفعل 🌿');
    return;
  }
  if (!full) {
    // اتفتح مكان من وقت ما الرسالة اتبعتت
    await telegram.answerCallbackQuery(cq.id, '🌿');
    await telegram.sendMessage(chatId, 'فيه مكان متاح دلوقتي 🌿 اكتب /start وابدأ رحلتك.');
    return;
  }

  const name = [cq.from.first_name, cq.from.last_name].filter(Boolean).join(' ') || String(telegramId);
  const username = cq.from.username || '';
  let record = null;
  try {
    record = await sheets.addAccessRequest({ telegramId, name, username });
  } catch (err) {
    console.error('addAccessRequest failed:', err.message);
  }

  if (record && !record.created) {
    await telegram.answerCallbackQuery(cq.id, '🌿');
    await telegram.sendMessage(
      chatId,
      record.status === 'rejected'
        ? 'نعتذر، مفيش مكان متاح حاليًا 🌿 ولو معاك كود دخول ابعته هنا.'
        : 'طلبك وصل قبل كده 🌿 هيتراجع وهيجيلك رد هنا إن شاء الله.'
    );
    return;
  }

  if (!record) {
    // تاب Requests مش موجود: على الأقل نمنع تكرار الإشعار من نفس الشخص
    const last = requestCooldown.get(String(telegramId)) || 0;
    if (Date.now() - last < 60 * 1000) {
      await telegram.answerCallbackQuery(cq.id, '🌿');
      return;
    }
    requestCooldown.set(String(telegramId), Date.now());
  }

  await telegram.answerCallbackQuery(cq.id, '📩 وصل طلبك');
  await telegram.sendMessage(chatId, 'وصل طلبك 🌿 هيتراجع وهيجيلك رد هنا إن شاء الله.');

  const todayCount = record ? record.todayCount : 0;
  if (todayCount <= ACCESS_NOTIFY_CAP) {
    await notifyOwnersOfRequest({ telegramId, name, username });
  } else if (todayCount === ACCESS_NOTIFY_CAP + 1) {
    for (const id of ownerIds()) {
      await telegram.sendMessage(
        id,
        `📩 وصلت لحد إشعارات الطلبات النهاردة (${ACCESS_NOTIFY_CAP}). باقي الطلبات بيتسجل، شوفيها بـ /requests`
      );
    }
  }
}

// أنتِ ضغطتي قبول أو رفض على طلب
async function handleAccessDecision(action, targetId, cq, telegramId, chatId) {
  if (!isOwner(telegramId)) {
    await telegram.answerCallbackQuery(cq.id, '🌿');
    return;
  }
  const messageId = cq.message.message_id;

  let record = null;
  try {
    record = await sheets.getAccessRequest(targetId);
  } catch (err) {
    console.error('getAccessRequest failed:', err.message);
  }

  if (action === 'reject') {
    await telegram.answerCallbackQuery(cq.id, 'اترفض');
    try {
      await sheets.setAccessRequestStatus(targetId, 'rejected');
    } catch (err) {
      console.error('setAccessRequestStatus failed:', err.message);
    }
    await telegram.sendMessage(targetId, 'نعتذر، مفيش مكان متاح حاليًا 🌿 ولو معاك كود دخول ابعته هنا.');
    await telegram.editMessageText(
      chatId,
      messageId,
      `❌ اترفض: ${esc((record && record.name) || targetId)} (${targetId})`
    );
    return;
  }

  // approve
  const { registered } = await registrationStatus(targetId);
  if (registered) {
    await telegram.answerCallbackQuery(cq.id, 'متسجل بالفعل');
    await telegram.editMessageText(chatId, messageId, `✅ ده متسجل بالفعل (${targetId})`);
    return;
  }
  let name = record && record.name;
  if (!name) {
    const info = await telegram.getChatInfo(targetId);
    name = [info.first_name, info.last_name].filter(Boolean).join(' ') || String(targetId);
  }
  await telegram.answerCallbackQuery(cq.id, '✅ اتقبل');
  await telegram.sendMessage(targetId, '🎉 تم قبول طلبك! أهلًا بيك في رحلة حفظ سورة البقرة 🌿');
  await handleStart(targetId, targetId, name);
  try {
    await sheets.setAccessRequestStatus(targetId, 'approved');
  } catch (err) {
    console.error('setAccessRequestStatus failed:', err.message);
  }
  await telegram.editMessageText(chatId, messageId, `✅ اتقبل: ${esc(name)} (${targetId})`);
}

// /requests -> الطلبات المستنية (أول 5 بأزرار قبول/رفض)
async function handleOwnerRequests(chatId) {
  const { total, items } = await sheets.getPendingRequests(5);
  if (total === 0) {
    await telegram.sendMessage(chatId, 'مفيش طلبات مستنية دلوقتي 🌿');
    return;
  }
  await telegram.sendMessage(chatId, `📩 طلبات مستنية: ${total}${total > items.length ? ` (هعرضلك أول ${items.length})` : ''}`);
  for (const item of items) {
    await telegram.sendMessage(chatId, requestText(item), { reply_markup: requestKeyboard(item.telegramId) });
  }
}

// تسجيل/ترحيب بمستخدم (جديد أو قديم) عند /start
async function handleStart(telegramId, chatId, name) {
  const user = await sheets.upsertUser({ telegramId, chatId, name, startPage: 1 });
  sheets.noteRegistered(telegramId);
  const community = await communityLine();
  await telegram.sendMessage(
    chatId,
    `أهلًا بيك يا ${name} 🌿\n\n` +
      'رحلتك في حفظ سورة البقرة هتكون كده:\n' +
      '📖 يوم صفحة جديدة (فيديو + صوت + خريطة ذهنية + تفسير)\n' +
      '🧩 يوم تثبيت عليها\n' +
      'وكل 3 صفحات هيجيلك يوم مراجعة شاملة عليهم كلهم.\n\n' +
      (community ? `${community}\n\n` : '') +
      'لو الصفحة ماوصلتش أو عايز تشوفها تاني اضغط "ابعتلي صفحة اليوم" في الرسالة المثبتة أو اكتب /today.\n' +
      'ولو حابب توقف الإرسال اليومي مؤقتًا اكتب /stop، ولو عايز ترجعه اكتب /resume.'
  );
  // مستخدم جديد: نبعت المثبت دايمًا (حتى لو تيليجرام لسه فاكر مثبت قديم بعد مسح الشات)
  // مستخدم قديم عمل /start تاني: ما نبعتهوش لو عنده مثبت بالفعل
  await showPinnedMenu(chatId, user.isNew);
  // مستخدم جديد: أول صفحة تتبعت فورًا، وباقي الأيام الكرون يبعتها الساعة 7
  // وكمان لو مستخدم مسجل بس لسه ماستلمش ولا صفحة (مثلًا /start الأولاني وقف في النص بخطأ)،
  // فلما يكتب /start تاني نبعتله أول صفحة. (deliverFirstPage بتسجّل اليوم الأول، فمفيش تكرار)
  const neverReceivedAnything = !user.lastSentDate && user.currentPage === 1 && user.cycleDay === 1;
  if (user.isNew || neverReceivedAnything) {
    await deliverFirstPage(user, new Date().toISOString().slice(0, 10));
  }
}

// تنبيه ليكي لو حصل خطأ في الـ webhook (مرة كل 10 دقايق بالكتير عشان ما يتكررش)
let lastErrorAlertAt = 0;
async function alertOwnerOfError(err) {
  if (Date.now() - lastErrorAlertAt < 10 * 60 * 1000) return;
  lastErrorAlertAt = Date.now();
  const msg = String((err && err.message) || err).slice(0, 300);
  for (const id of ownerIds()) {
    try {
      await telegram.sendMessage(id, `⚠️ <b>خطأ في البوت</b>\n\n${esc(msg)}`);
    } catch (e) {
      console.error('alertOwnerOfError failed:', e.message);
    }
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(200).send('OK - webhook is alive');
  }

  // حماية اختيارية: لو TELEGRAM_WEBHOOK_SECRET متضاف في Vercel، بنقبل بس الطلبات اللي جاية من تيليجرام
  // (لازم تكوني ضبطتي نفس الكلمة في setWebhook عن طريق secret_token)
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (webhookSecret && req.headers['x-telegram-bot-api-secret-token'] !== webhookSecret) {
    return res.status(401).send('Unauthorized');
  }

  try {
    const update = req.body;

    // 1) لما المستخدم يضغط أي زرار
    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message.chat.id;
      const telegramId = cq.from.id;
      const parts = (cq.data || '').split(':');
      const type = parts[0];
      const messageId = cq.message.message_id;

      if (type === 'quick') {
        // الصيغة الجديدة quick:الصفحة:ترتيب_السؤال:الاختيار (والقديمة quick:الصفحة:الاختيار لسه شغالة)
        const pageNumber = parts[1];
        const occurrence = parts.length >= 4 ? parseInt(parts[2], 10) || 0 : 0;
        const chosen = parts.length >= 4 ? parts[3] : parts[2];
        await handleQuickCheckAnswer(chatId, pageNumber, chosen, cq.id, occurrence, messageId);
      } else if (type === 'quickdone') {
        const occurrence = parseInt(parts[2], 10) || 0;
        await handleQuickCheckDone(chatId, cq.id, parts[1], occurrence, messageId);
      } else if (type === 'review') {
        const [, chosen] = parts;
        await handleReviewAnswer(telegramId, chatId, chosen, cq.id, messageId);
      } else if (type === 'reviewdone') {
        await handleReviewDone(telegramId, chatId, cq.id, messageId);
      } else if (type === 'reviewchoice') {
        const [, choice] = parts;
        await handleReviewChoice(telegramId, chatId, choice, cq.id);
      } else if (type === 'milestone') {
        const [, chosen] = parts;
        await handleMilestoneAnswer(telegramId, chatId, chosen, cq.id, messageId);
      } else if (type === 'rate' && rating) {
        await rating.handleCallback(cq, parts);
      } else if (type === 'pl' && polls) {
        await polls.handleCallback(cq, parts, isOwner(telegramId));
      } else if (type === 'bc' && broadcast) {
        await broadcast.handleCallback(cq, parts, isOwner(telegramId));
      } else if (type === 'reqaccess') {
        await handleAccessRequest(cq, telegramId, chatId);
      } else if (type === 'approve' || type === 'reject') {
        await handleAccessDecision(type, parts[1], cq, telegramId, chatId);
      } else if (type === 'today') {
        await telegram.answerCallbackQuery(cq.id, '📖');
        await handleToday(telegramId, chatId);
      } else if (type === 'qprev') {
        await handleQuizPreviewAnswer(telegramId, chatId, parts, cq.id, messageId);
      } else if (type === 'qprevdone') {
        await handleQuizPreviewDone(telegramId, chatId, parts, cq.id, messageId);
      } else if (type === 'info') {
        const [, sectionIndex] = parts;
        await handleInfoSection(telegramId, chatId, parseInt(sectionIndex, 10), cq.id);
      }
      return res.status(200).send('OK');
    }

    // 2) رسالة نصية عادية / أمر
    const msg = update.message;
    if (!msg || !msg.text) {
      return res.status(200).send('OK');
    }

    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const name = msg.from.first_name || '';
    const text = msg.text.trim();

    // أوامر المعاينة: شغالة لحسابك إنتي بس، وأي حد تاني بيكمل عادي في الردود اللي تحت
    const [rawCmd, cmdArg] = text.split(/\s+/);
    const cmd = rawCmd.split('@')[0].toLowerCase();
    if (cmd === '/rate' && rating) {
      await rating.handleRateCommand(telegramId, chatId);
      return res.status(200).send('OK');
    }
    if ((cmd === '/sendrate' || cmd === '/results') && rating && isOwner(telegramId)) {
      if (cmd === '/sendrate') await rating.handleSendCommand(chatId, cmdArg);
      else await rating.handleResultsCommand(chatId);
      return res.status(200).send('OK');
    }
    if (['/polls', '/testpoll', '/sendpoll', '/pollresults'].includes(cmd) && polls && isOwner(telegramId)) {
      await polls.handleCommand(cmd, text.split(/\s+/).slice(1), chatId);
      return res.status(200).send('OK');
    }
    if (cmd === '/broadcast' && broadcast && isOwner(telegramId)) {
      await broadcast.handleCommand(chatId, msg);
      return res.status(200).send('OK');
    }
    if (cmd === '/requests' && isOwner(telegramId)) {
      await handleOwnerRequests(chatId);
      return res.status(200).send('OK');
    }
    if (['/inactive', '/warn', '/cleanup'].includes(cmd) && isOwner(telegramId)) {
      if (cmd === '/inactive') await handleOwnerInactive(chatId);
      else if (cmd === '/warn') await handleOwnerWarn(chatId);
      else await handleOwnerCleanup(chatId, cmdArg);
      return res.status(200).send('OK');
    }
    if (cmd === '/stats' && isOwner(telegramId)) {
      await handleOwnerStats(chatId);
      return res.status(200).send('OK');
    }
    if ((cmd === '/preview' || cmd === '/quiz') && isOwner(telegramId)) {
      await handleOwnerPreview(cmd, cmdArg, chatId);
      return res.status(200).send('OK');
    }

    if (cmd === '/start') {
      const { registered, full } = await registrationStatus(telegramId);
      if (!registered && full) {
        // العدد اكتمل: الدخول بكود بس (/start الكود، أو الكود في رسالة لوحده)
        const ok = cmdArg ? await sheets.redeemInviteCode(cmdArg, telegramId) : false;
        if (!ok) {
          await sendAccessMessage(chatId, cmdArg ? ACCESS_INVALID_TEXT : ACCESS_FULL_TEXT);
          return res.status(200).send('OK');
        }
      }
      await handleStart(telegramId, chatId, name);
      return res.status(200).send('OK');
    }

    if (cmd === '/today') {
      await handleToday(telegramId, chatId);
      return res.status(200).send('OK');
    }

    // أمر /menu: يبعت الرسالة المثبتة ويثبتها تاني (مفيد لو حدّثتي محتواها في الشيت)
    if (text === '/menu') {
      await sheets.resetPinnedSeen(telegramId);
      await showPinnedMenu(chatId, true);
      return res.status(200).send('OK');
    }

    if (text === '/stop') {
      await sheets.setSubscribed(telegramId, false);
      await telegram.sendMessage(chatId, 'تم إيقاف الإرسال اليومي. اكتب /resume في أي وقت للرجوع.');
      return res.status(200).send('OK');
    }

    if (text === '/resume') {
      await sheets.setSubscribed(telegramId, true);
      await telegram.sendMessage(chatId, 'تمام، هتستلم صفحة اليوم الجاية إن شاء الله 🌿');
      return res.status(200).send('OK');
    }

    if (text === '/status') {
      const progress = await sheets.getUserProgress(telegramId);
      if (progress) {
        const community = await communityLine();
        await telegram.sendMessage(
          chatId,
          `📊 إنت دلوقتي على صفحة ${progress.currentPage} (يوم ${progress.cycleDay} من دورة الـ 7 أيام).` +
            (community ? `\n\n${community}` : '')
        );
      } else {
        await telegram.sendMessage(chatId, 'ابعت /start الأول عشان نبدأ.');
      }
      return res.status(200).send('OK');
    }

    // أي رسالة تانية
    // مستخدم مش مسجل والعدد اكتمل: لو كتب كود في رسالة، نجرّبه
    const access = await registrationStatus(telegramId);
    if (!access.registered && access.full) {
      if (!text.startsWith('/') && (await sheets.redeemInviteCode(text, telegramId))) {
        await handleStart(telegramId, chatId, name);
        return res.status(200).send('OK');
      }
      await sendAccessMessage(chatId, text.startsWith('/') ? ACCESS_FULL_TEXT : ACCESS_INVALID_TEXT);
      return res.status(200).send('OK');
    }

    // رسالة عادية منك إنتي (مثلًا بتكتبي إعلان عشان /broadcast): ما نردش عليها
    if (isOwner(telegramId)) return res.status(200).send('OK');

    await telegram.sendMessage(chatId, 'اكتب /start عشان تبدأ رحلة حفظ سورة البقرة 🌿');
    return res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook error:', err);
    await alertOwnerOfError(err);
    return res.status(200).send('OK'); // نرجع OK دايمًا عشان تيليجرام متعملش retry لا نهائي
  }
};
