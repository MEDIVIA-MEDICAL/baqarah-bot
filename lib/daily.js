// lib/daily.js
// منطق إرسال "صفحة جديدة" مشترك بين الكرون (الإرسال اليومي الساعة 7) و/start (أول صفحة فورًا).

const sheets = require('./sheets');
const telegram = require('./telegram');

// الفاتحة (صفحة 1) صفحة تعريف: بتتبعت في يوم واحد بس من غير يوم تثبيت ومن غير مراجعة،
// وتاني يوم الدورة (7 أيام لكل 3 صفحات) تبدأ من صفحة 2 (أول البقرة).
const INTRO_PAGE = 1;

// حالة التقدم اللي لازم تتسجّل بعد إرسال صفحة جديدة في اليوم `day` من الدورة
function progressAfterNewPage(user, day) {
  if (user.currentPage === INTRO_PAGE && day === 1) {
    return { currentPage: INTRO_PAGE + 1, cycleDay: 1, blockStartPage: INTRO_PAGE + 1 };
  }
  const updates = { cycleDay: day + 1 };
  if (day === 1) updates.blockStartPage = user.currentPage;
  return updates;
}

// رسالة تحفيزية عشوائية (لو تاب Motivation فيه رسايل) ثم محتوى الصفحة كامل
async function sendPageContent(user, content) {
  const motivation = await sheets.getRandomMotivation();
  if (motivation) {
    await telegram.sendMotivation(user.chatId, motivation);
  }
  await telegram.sendDailyPage(user.chatId, content);
}

// بيبعت صفحة المستخدم الحالية (للكرون). بيرجع false لو الصفحة دي مفيهاش محتوى في الشيت.
async function sendNewPageDay(user) {
  const content = await sheets.getContentForPage(user.currentPage);
  if (!content) {
    // خلصت الصفحات المتاحة في الشيت لحد دلوقتي
    return false;
  }
  await sendPageContent(user, content);
  return true;
}

// بيبعت أول صفحة للمستخدم الجديد فورًا لحظة ما يبدأ البوت (يوم 1 من الدورة)، وبعدها
// الكرون يكمّل من يوم 2 الساعة 7 الصبح. بنسجّل اليوم في الشيت الأول وبعدين نبعت،
// عشان لو تيليجرام أعاد إرسال /start بسبب بطء الرد، ما تتبعتش الصفحة مرتين.
async function deliverFirstPage(user, todayStr) {
  const content = await sheets.getContentForPage(user.currentPage);
  if (!content) return false;

  await sheets.updateUserFields(user.telegramId, {
    ...progressAfterNewPage(user, 1),
    lastSentDate: todayStr,
  });

  await telegram.sendMessage(
    user.chatId,
    '🌿 هبعتلك أول صفحة دلوقتي. وبعد كده المحتوى بيوصلك كل يوم الساعة 7 الصبح.'
  );
  await sendPageContent(user, content);
  return true;
}

module.exports = { sendNewPageDay, deliverFirstPage, progressAfterNewPage };
