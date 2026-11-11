// api/cron.js
// ده اللي بيشتغل تلقائيًا كل يوم (عن طريق Vercel Cron - متظبط في vercel.json)
// وبيطبّق دورة الـ 7 أيام:
//   يوم 1: صفحة جديدة كاملة
//   يوم 2: سؤال تثبيت على نفس الصفحة
//   يوم 3: صفحة جديدة كاملة (اللي بعدها)
//   يوم 4: سؤال تثبيت
//   يوم 5: صفحة جديدة كاملة
//   يوم 6: سؤال تثبيت
//   يوم 7: مراجعة شاملة على الصفحات التلاتة (كويز مُدمج)
//   يوم 8 (رقم خاص): يوم إعادة مُجمّع للصفحات التلاتة (لما المستخدم يختار "أعيد" بعد نتيجة مراجعة ضعيفة)
//   يوم 9 (رقم خاص): اختبار محطة إضافي (بعد صفحات زي 21/41/49) - بيتحط بعد يوم تثبيت صفحة المحطة
//     مباشرة، وبعد ما يخلص بيرجع الدورة تكمل من نفس اليوم اللي كانت هتيجي لو المحطة مكانتش موجودة.
// لو المستخدم لسه وسط كويز المراجعة أو اختبار المحطة ومجاوبش، الكرون بيفكّره بنفس السؤال بدل ما يبعتله حاجة جديدة.

const sheets = require('../lib/sheets');
const telegram = require('../lib/telegram');
const { sendNewPageDay, progressAfterNewPage } = require('../lib/daily');

// waitUntil بتخلي Vercel يكمّل شغل الدفعة في الخلفية بعد ما الرد يترجّع (مكتبة @vercel/functions).
// لو المكتبة مش متثبتة لأي سبب، الكرون يشتغل عادي من غير تسلسل الدفعات.
let waitUntil = null;
try {
  ({ waitUntil } = require('@vercel/functions'));
} catch (err) {
  waitUntil = null;
}

// إعدادات الدفعات: كل دفعة بتشتغل لحد 40 ثانية (من 60 المسموحة، والباقي هامش أمان)، وبعدها بتنده الدفعة اللي بعدها.
const TIME_BUDGET_MS = 40 * 1000;
const CONCURRENCY = 3; // عدد المستخدمين اللي بيتعالجوا مع بعض (قليل عشان حدود جوجل وتيليجرام)
const MAX_CHAIN_DEPTH = 40; // حماية من أي تسلسل لا نهائي

// ---------- حماية حد جوجل (60 قراءة و60 كتابة في الدقيقة) ----------
// نكتب في الشيت بمعدل أقل من 40 كتابة في الدقيقة (الباقي لضغطات المستخدمين)،
// ونقرا الشيت مرة كل CHUNK_SIZE مستخدم بدل مرة لكل مستخدم.
const WRITE_INTERVAL_MS = 1500;
const CHUNK_SIZE = 15;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let nextWriteAt = 0;

// بيحفظ تقدم مستخدم في الشيت (بالصف اللي في إيدنا، من غير قراءة تانية) وبينظّم سرعة الكتابة
async function saveUser(user, fields) {
  const now = Date.now();
  const at = Math.max(now, nextWriteAt);
  nextWriteAt = at + WRITE_INTERVAL_MS;
  if (at > now) await sleep(at - now);
  return sheets.updateUserFields(user.telegramId, fields, user.row);
}

// آخر صفحة في المحتوى (سورة البقرة بتخلص في صفحة 49). أول ما المستخدم يخلّص مراجعة آخر بلوك
// ويوصل لصفحة بعدها، بيستلم رسالة الختام مرة واحدة وبيتوقف الإرسال اليومي ليه.
// (ممكن تعدّلي نص الرسالة هنا زي ما تحبي)
const FINAL_PAGE = 49;
const CLOSING_MESSAGE =
  '🌿 <b>ما شاء الله، خلصت رحلتنا مع سورة البقرة!</b>\n\n' +
  'أتممت كل صفحات السورة بالتفسير والخرائط الذهنية والمراجعات، وده فضل كبير من الله.\n' +
  'نسأل الله أن يجعلها حجة لك، وأن يبارك لك في حفظك ويثبّته في قلبك.\n\n' +
  'المراجعة المستمرة هي سر الثبات، فارجع للصفحات وقت ما تحب. ' +
  'ولو عايز تفتح الرسالة المثبتة تاني اكتب /menu 🤍';

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function sendQuickCheckDay(user) {
  // بنبعت أول سؤال في الصفحة بس. كل ما المستخدم يجاوب، البوت بيبعتله السؤال اللي بعده.
  const quizzes = await sheets.getQuizRowsForPage(user.currentPage);
  if (quizzes.length === 0) {
    await telegram.sendMessage(
      user.chatId,
      `🔁 راجع صفحة ${user.currentPage} تاني كويس النهاردة قبل ما نكمل.`
    );
    return;
  }
  await telegram.sendQuickCheckQuestion(user.chatId, quizzes[0], user.currentPage, 0);
}

// بيبدأ يوم المراجعة: بيجمع كل أسئلة الصفحات التلاتة، يخلطها، ويبعت أول سؤال
async function startReviewDay(user) {
  const pages = [user.blockStartPage, user.blockStartPage + 1, user.blockStartPage + 2];
  const allQuizzes = await sheets.getQuizRowsForPages(pages);

  if (allQuizzes.length === 0) {
    // مفيش أسئلة متضافة لسه على الصفحات دي - نعدي المراجعة تلقائيًا
    await telegram.sendMessage(
      user.chatId,
      `🌟 خلصت صفحات ${pages[0]}-${pages[2]}! (مفيش أسئلة مراجعة متضافة لسه، هنكمل عادي).`
    );
    await saveUser(user, {
      currentPage: pages[2] + 1,
      blockStartPage: pages[2] + 1,
      cycleDay: 1,
      reviewQueue: [],
      reviewQuestionIndex: 0,
      reviewScore: 0,
    });
    return;
  }

  const queue = shuffle(allQuizzes).map((q) => `${q.pageNumber}:${q.occurrence}`);

  await telegram.sendMessage(
    user.chatId,
    `🌟 <b>يوم المراجعة!</b>\nخلصت صفحات ${pages[0]} - ${pages[2]}. دلوقتي وقت التثبيت 🌿\n` +
      'قبل ما تجاوب، جرّب تسمّع الصفحات التلاتة بصوت عالي من غير مساعدة.'
  );

  await saveUser(user, {
    reviewQueue: queue,
    reviewQuestionIndex: 0,
    reviewScore: 0,
  });

  const [firstPage, firstOccurrence] = queue[0].split(':');
  const firstQuiz = await sheets.getQuizByPageOccurrence(firstPage, parseInt(firstOccurrence, 10));
  if (firstQuiz.type === 'complete') {
    await telegram.sendReviewSelfCheck(user.chatId, firstQuiz, 1, queue.length);
  } else {
    await telegram.sendReviewQuestion(user.chatId, firstQuiz, 1, queue.length);
  }
}

// يوم الإعادة المُجمّع (cycle_day = 8): بيبعت الصفحات التلاتة مع بعض في رسايل متتالية،
// وبعدين يقفل البلوك ده ويتحرك للبلوك الجاي - "يشتغل عادي" تاني من بكرة
async function sendCombinedRepeatDay(user) {
  const pages = [user.blockStartPage, user.blockStartPage + 1, user.blockStartPage + 2];

  await telegram.sendMessage(
    user.chatId,
    `🔁 <b>مراجعة مُجمّعة لصفحات ${pages[0]} - ${pages[2]}</b>\nخدي وقتك وسمّعيهم كويس قبل ما نكمل 🌿`
  );

  for (const page of pages) {
    const content = await sheets.getContentForPage(page);
    if (content) {
      await telegram.sendDailyPage(user.chatId, content);
    }
  }

  await saveUser(user, {
    currentPage: pages[2] + 1,
    blockStartPage: pages[2] + 1,
    cycleDay: 1,
  });
}

// بيبدأ اختبار محطة (يوم إضافي بعد صفحات معينة زي 21/41/49) - مفيهوش أي إيقاف
// على النتيجة، بس تثبيت إضافي وبعدين يرجع يكمل عادي من حيث كان
async function startMilestoneDay(user) {
  const quizzes = await sheets.getMilestoneQuizRows(user.milestonePage);
  const resumeDay = user.pendingResumeDay || user.cycleDay + 1;

  if (quizzes.length === 0) {
    // مفيش أسئلة متضافة لصفحة المحطة دي لسه - نعدي عادي
    await saveUser(user, {
      cycleDay: resumeDay,
      milestonePage: '',
      pendingResumeDay: '',
    });
    return;
  }

  const queue = shuffle(quizzes).map((q) => `${q.occurrence}`);

  await telegram.sendMessage(
    user.chatId,
    `🏁 <b>اختبار محطة! وصلت لصفحة ${user.milestonePage}</b>\n` +
      'ده اختبار تثبيت إضافي بس، مفيش أي إيقاف حتى لو النتيجة مش كويسة 🌿'
  );

  await saveUser(user, {
    milestoneQueue: queue,
    milestoneQuestionIndex: 0,
    milestoneScore: 0,
  });

  const firstQuiz = await sheets.getMilestoneQuizByOccurrence(user.milestonePage, parseInt(queue[0], 10));
  await telegram.sendMilestoneQuestion(user.chatId, firstQuiz, 1, queue.length);
}

// لو المستخدم لسه وسط اختبار محطة ومجاوبش، فكّره بنفس السؤال
async function nudgeMilestoneQuestion(user) {
  const occurrence = user.milestoneQueue[user.milestoneQuestionIndex];
  if (occurrence === undefined) return;
  const quiz = await sheets.getMilestoneQuizByOccurrence(user.milestonePage, parseInt(occurrence, 10));
  if (!quiz) return;
  await telegram.sendMessage(user.chatId, '⏰ متنساش تكمل سؤال اختبار المحطة النهاردة:');
  await telegram.sendMilestoneQuestion(
    user.chatId,
    quiz,
    user.milestoneQuestionIndex + 1,
    user.milestoneQueue.length
  );
}

// لو المستخدم لسه في نص كويز المراجعة، فكّره بنفس السؤال بدل ما يستنى لأبد الآبدين
async function nudgeReviewQuestion(user) {
  const currentEntry = user.reviewQueue[user.reviewQuestionIndex];
  if (!currentEntry) return;
  const [page, occurrence] = currentEntry.split(':');
  const quiz = await sheets.getQuizByPageOccurrence(page, parseInt(occurrence, 10));
  if (!quiz) return;
  await telegram.sendMessage(user.chatId, '⏰ متنساش تكمل سؤال المراجعة النهاردة:');
  if (quiz.type === 'complete') {
    await telegram.sendReviewSelfCheck(
      user.chatId,
      quiz,
      user.reviewQuestionIndex + 1,
      user.reviewQueue.length
    );
  } else {
    await telegram.sendReviewQuestion(
      user.chatId,
      quiz,
      user.reviewQuestionIndex + 1,
      user.reviewQueue.length
    );
  }
}

// ---------- تنبيهات ليكي على تيليجرام لو فيه مشكلة في الكرون ----------
// بتتبعت لرقم/أرقام OWNER_TELEGRAM_ID. لو التنبيه نفسه فشل، الكرون مش بيتأثر.
function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function notifyOwner(text) {
  const ids = String(process.env.OWNER_TELEGRAM_ID || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  for (const id of ids) {
    try {
      await telegram.sendMessage(id, text);
    } catch (err) {
      console.error('notifyOwner failed:', err.message);
    }
  }
}

// بيعالج مستخدم واحد. بيرجع true لو اتعدّ كمرسَل (نفس منطق الكرون القديم بالظبط).
let blockedThisBatch = 0;

// لو المستخدم حاظر البوت، بنوقّف الإرسال ليه (لو رجع وكتب /start بيرجع تلقائي)
async function processUser(user, todayStr) {
  const result = await processUserInner(user, todayStr);
  if (telegram.consumeBlocked(user.chatId)) {
    blockedThisBatch += 1;
    try {
      await sheets.setSubscribed(user.telegramId, false);
    } catch (err) {
      console.error('Failed to pause blocked user:', err.message);
    }
  }
  return result;
}

async function processUserInner(user, todayStr) {
  // المستخدم لسه وسط كويز مراجعة مجاوبوش خالص
  if (user.reviewQueue.length > 0 && user.reviewQuestionIndex < user.reviewQueue.length) {
    await nudgeReviewQuestion(user);
    await saveUser(user, { lastSentDate: todayStr });
    return true;
  }

  // المستخدم لسه وسط اختبار محطة مجاوبوش خالص
  if (user.milestoneQueue.length > 0 && user.milestoneQuestionIndex < user.milestoneQueue.length) {
    await nudgeMilestoneQuestion(user);
    await saveUser(user, { lastSentDate: todayStr });
    return true;
  }

  // المستخدم لسه مقررش يعيد ولا يكمل بعد نتيجة مراجعة ضعيفة
  if (user.pendingChoice === 'low_score') {
    await telegram.sendRepeatChoiceReminder(user.chatId);
    await saveUser(user, { lastSentDate: todayStr });
    return true;
  }

  const day = user.cycleDay;

  if (day === 9) {
    await startMilestoneDay(user);
    await saveUser(user, { lastSentDate: todayStr });
    return true;
  }

  if (day === 8) {
    await sendCombinedRepeatDay(user);
    await saveUser(user, { lastSentDate: todayStr });
    return true;
  }

  if (day === 7) {
    await startReviewDay(user);
    await saveUser(user, { lastSentDate: todayStr });
    return true;
  }

  const isNewPageDay = day === 1 || day === 3 || day === 5;

  if (isNewPageDay) {
    // خلّص كل الصفحات: رسالة الختام مرة واحدة، وبعدها نوقف الإرسال اليومي ليه
    if (user.currentPage > FINAL_PAGE) {
      await telegram.sendMessage(user.chatId, CLOSING_MESSAGE);
      await sheets.setSubscribed(user.telegramId, false);
      return true;
    }
    const sent = await sendNewPageDay(user);
    if (!sent) return false; // خلصت الصفحات، متتحركش
    // يوم 1 هو أول يوم في البلوك، نسجل بداية البلوك هنا
    const updates = { ...progressAfterNewPage(user, day), lastSentDate: todayStr };
    await saveUser(user, updates);
    return true;
  }

  // يوم تثبيت (2 أو 4 أو 6)
  await sendQuickCheckDay(user);
  const checkedPage = user.currentPage;
  const updates = { lastSentDate: todayStr };

  // لو الصفحة دي صفحة محطة (زي 21/41/49)، ندخل يوم اختبار إضافي قبل ما نكمل عادي
  const milestoneQuizzes = await sheets.getMilestoneQuizRows(checkedPage);
  if (milestoneQuizzes.length > 0) {
    updates.cycleDay = 9;
    updates.milestonePage = checkedPage;
    updates.pendingResumeDay = day + 1;
  } else {
    updates.cycleDay = day + 1;
  }

  // بعد يوم التثبيت (غير آخر واحد يوم 6) بنتحرك للصفحة الجاية
  if (day === 2 || day === 4) {
    updates.currentPage = user.currentPage + 1;
  }
  await saveUser(user, updates);
  return true;
}

// بينده الدفعة اللي بعدها على نفس الرابط. الدفعة الجاية بترد فورًا (202) وتكمّل في الخلفية.
async function triggerNextBatch(req, nextDepth) {
  // بنفضّل رابط الإنتاج الرسمي (بيكون مفتوح)، لأن رابط الـ deployment الفرعي ممكن يكون محمي من Vercel
  const host =
    process.env.VERCEL_PROJECT_PRODUCTION_URL || req.headers['x-forwarded-host'] || req.headers.host;
  const proto = process.env.VERCEL_PROJECT_PRODUCTION_URL ? 'https' : req.headers['x-forwarded-proto'] || 'https';
  const headers = {};
  if (process.env.CRON_SECRET) headers['authorization'] = `Bearer ${process.env.CRON_SECRET}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10 * 1000);
  try {
    const r = await fetch(`${proto}://${host}/api/cron?chain=1&depth=${nextDepth}`, {
      headers,
      signal: controller.signal,
    });
    if (!r.ok) {
      console.error(`Next cron batch was rejected: HTTP ${r.status} from ${host}`);
      return { ok: false, reason: `HTTP ${r.status}` };
    }
    return { ok: true };
  } catch (err) {
    console.error('Failed to trigger next cron batch:', err.message);
    return { ok: false, reason: err.message };
  } finally {
    clearTimeout(timer);
  }
}

// دفعة واحدة: بتعالج المستخدمين اللي لسه متبعتلهمش النهاردة لحد ما الوقت المحدد يخلص.
// لو لسه فيه ناس، بتنده الدفعة اللي بعدها. (lastSentDate بيمنع أي تكرار)
async function runBatch(req, depth) {
  const startedAt = Date.now();
  const todayStr = new Date().toISOString().slice(0, 10);

  let users;
  try {
    users = await sheets.getAllSubscribedUsers();
  } catch (err) {
    // غالبًا حد جوجل خلص: بنكمل في دفعة جديدة بعد ما نستنى (القراءة نفسها بتحاول كذا مرة)
    console.error('Cron initial read failed:', err);
    if (depth < MAX_CHAIN_DEPTH) {
      const next = await triggerNextBatch(req, depth + 1);
      if (next.ok) return { ok: false, retried: true, depth };
    }
    throw err;
  }
  const pending = users.filter((u) => u.lastSentDate !== todayStr);

  let sentCount = 0;
  let failedCount = 0;
  let skippedCount = 0; // مستخدمين واقفين لأن محتوى صفحتهم لسه مش مضاف في الشيت
  let nextIndex = 0;
  const failures = [];

  // نسخة الصفوف الطازة: بنجدّدها كل CHUNK_SIZE مستخدم (قراءة واحدة لكل مجموعة)
  let freshById = new Map(users.map((u) => [String(u.telegramId), u]));
  let freshOk = true;
  let currentChunk = 0;
  let chunkReady = Promise.resolve();

  async function refreshRows() {
    try {
      const fresh = await sheets.getAllSubscribedUsers();
      freshById = new Map(fresh.map((u) => [String(u.telegramId), u]));
      freshOk = true;
    } catch (err) {
      freshOk = false; // لو فشلنا نكمل بالصفوف اللي معانا
      console.error('Cron chunk refresh failed:', err.message);
    }
  }

  async function worker() {
    while (Date.now() - startedAt < TIME_BUDGET_MS) {
      const i = nextIndex++;
      if (i >= pending.length) return;
      const chunk = Math.floor(i / CHUNK_SIZE);
      if (chunk !== currentChunk) {
        currentChunk = chunk;
        chunkReady = refreshRows();
      }
      await chunkReady;

      let user = freshById.get(String(pending[i].telegramId));
      if (!user) {
        if (freshOk) continue; // وقّف الإرسال أو اتمسح في الأثناء
        user = pending[i];
      }
      if (user.lastSentDate === todayStr) continue; // اتبعتله خلاص

      try {
        if (await processUser(user, todayStr)) sentCount += 1;
        else skippedCount += 1;
      } catch (err) {
        // مستخدم واحد فشل متوقفش الباقي؛ هيتحاول تاني في الدفعة الجاية لأن lastSentDate متسجلش
        failedCount += 1;
        failures.push(`${user.telegramId}: ${err && err.message ? err.message : err}`);
        console.error(`Cron error for user ${user.telegramId}:`, err);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const remaining = Math.max(0, pending.length - nextIndex);
  let chained = false;
  const problems = [];

  if (failedCount > 0) {
    const sample = failures.slice(0, 3).map(escapeHtml).join('\n');
    problems.push(`❌ ${failedCount} مستخدم فشل الإرسال ليهم (هيتحاول تاني في الدفعة الجاية):\n${sample}`);
  }

  if (remaining > 0 && depth < MAX_CHAIN_DEPTH) {
    chained = true;
    const next = await triggerNextBatch(req, depth + 1);
    if (!next.ok) {
      problems.push(
        `⛔ الدفعة اللي بعدها متشغلتش (${escapeHtml(next.reason)}). فيه ${remaining} مستخدم لسه متبعتلهمش النهاردة.`
      );
    }
  } else if (remaining > 0) {
    problems.push(`⛔ وصلت لأقصى عدد دفعات وفيه ${remaining} مستخدم لسه متبعتلهمش النهاردة.`);
  }

  if (problems.length > 0) {
    await notifyOwner(`⚠️ <b>تنبيه من بوت أخذها بركة (الكرون)</b>\n\n${problems.join('\n\n')}`);
  }

  // ملخص يومي: بيتبعت لما آخر دفعة تخلص بس. لو وصلتك الرسالة دي يبقى الكرون اشتغل.
  // (محسوب من البيانات اللي اتقرت أصلًا، فمفيش قراءة زيادة من الشيت)
  if (remaining === 0) {
    const sentToday = users.length - pending.length + sentCount;
    let summary = `✅ <b>الكرون خلص النهاردة</b>\n\n📨 اتبعت لـ ${sentToday} من ${users.length} مشترك نشط`;
    if (skippedCount > 0) summary += `\n⏸️ ${skippedCount} واقفين لأن محتوى صفحتهم لسه مش مضاف`;
    if (blockedThisBatch > 0) summary += `\n🚫 ${blockedThisBatch} حاظرين البوت (اتوقّف الإرسال ليهم)`;
    if (failedCount > 0) summary += `\n❌ ${failedCount} فشلوا (هيتحاولوا تاني)`;
    await notifyOwner(summary);
  }

  return { ok: true, sent: sentCount, failed: failedCount, skipped: skippedCount, remaining, chained, depth, total: users.length };
}

module.exports = async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).send('Unauthorized');
  }

  const query = req.query || {};
  const depth = parseInt(query.depth || '0', 10) || 0;
  const isChained = query.chain === '1';

  // دفعة متسلسلة: نرد فورًا ونكمل الشغل في الخلفية (عشان الدفعة اللي قبلها متستناش)
  if (isChained && waitUntil) {
    res.status(202).json({ accepted: true, depth });
    waitUntil(
      runBatch(req, depth)
        .then((result) => console.log('Cron batch done:', JSON.stringify(result)))
        .catch(async (err) => {
          console.error('Cron batch error:', err);
          await notifyOwner(`⚠️ <b>تنبيه من بوت أخذها بركة (الكرون)</b>\n\nالكرون وقف بخطأ: ${escapeHtml(err && err.message ? err.message : err)}`);
        })
    );
    return;
  }

  try {
    const result = await runBatch(req, depth);
    console.log('Cron batch done:', JSON.stringify(result));
    return res.status(200).json(result);
  } catch (err) {
    console.error('Cron error:', err);
    await notifyOwner(`⚠️ <b>تنبيه من بوت أخذها بركة (الكرون)</b>\n\nالكرون وقف بخطأ: ${escapeHtml(err && err.message ? err.message : err)}`);
    return res.status(500).json({ ok: false, error: String(err) });
  }
};
