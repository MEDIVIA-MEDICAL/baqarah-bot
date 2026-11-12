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

// سطر "كام واحد معانا": بيشجّع المستخدمين إنهم مش لوحدهم. بنعرض رقم تقريبي (أقل من الحقيقي دايمًا)
// وما بنعرضوش لو العدد صغير. لو عايزة تقفليه خالص: متغير SHOW_USER_COUNT=false في Vercel.
const COMMUNITY_MIN = 30;

async function communityLine() {
  if (process.env.SHOW_USER_COUNT === 'false') return '';
  try {
    const total = (await sheets.getRegisteredIds()).size;
    if (total < COMMUNITY_MIN) return '';
    const step = total > 100 ? 50 : 10;
    const rounded = Math.floor((total - 1) / step) * step; // "أكتر من" رقم أقل من العدد الحقيقي
    return `👥 معاك في الرحلة أكتر من ${rounded} مشترك بيحفظوا سورة البقرة 🌿`;
  } catch (err) {
    return '';
  }
}

// رسالة تحفيزية عشوائية (لو تاب Motivation فيه رسايل) ثم محتوى الصفحة كامل.
// أول يوم في كل دورة (يوم 1) بنضيف سطر عدد المشتركين مرة واحدة في الأسبوع.
async function sendPageContent(user, content, options = {}) {
  const motivation = await sheets.getRandomMotivation();
  if (motivation) {
    await telegram.sendMotivation(user.chatId, motivation);
  }
  if (user.cycleDay === 1 && !options.skipCommunity) {
    const community = await communityLine();
    if (community) await telegram.sendMessage(user.chatId, community);
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
  await sendPageContent(user, content, { skipCommunity: true }); // اتعرض في رسالة الترحيب
  return true;
}

module.exports = { sendNewPageDay, deliverFirstPage, progressAfterNewPage, communityLine };
