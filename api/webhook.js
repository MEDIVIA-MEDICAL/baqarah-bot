// api/webhook.js
// ده اللي تيليجرام بيبعتله كل رسالة/ضغطة زرار من المستخدمين.
// رابطه هيبقى: https://<your-vercel-domain>/api/webhook

const sheets = require('../lib/sheets');
const telegram = require('../lib/telegram');
const { deliverFirstPage } = require('../lib/daily');

// إجابة سؤال تثبيت من نوع اختيارات (يوم 2/4/6)
async function handleQuickCheckAnswer(chatId, pageNumber, chosen, callbackQueryId) {
  const quiz = await sheets.getFirstQuizForPage(pageNumber);
  if (!quiz) return;
  const correct = chosen === quiz.correct;
  await telegram.answerCallbackQuery(
    callbackQueryId,
    correct ? '✅ إجابة صحيحة!' : '❌ إجابة غير صحيحة'
  );
  await telegram.sendMessage(
    chatId,
    correct
      ? '🎉 برافو! إجابة صحيحة، استمر في الحفظ.'
      : `الإجابة الصحيحة كانت: ${quiz.correct}) ${quiz.options[quiz.correct]}`
  );
}

// تأكيد "سمّعتها" لسؤال إكمال الآية في يوم التثبيت - مفيهوش تصحيح، مجرد تشجيع
async function handleQuickCheckDone(chatId, callbackQueryId) {
  await telegram.answerCallbackQuery(callbackQueryId, '🌿 تمام');
  await telegram.sendMessage(chatId, 'ما شاء الله عليك، استمر في الحفظ 🌿');
}

// بيتقدّم لسؤال المراجعة الجاي، أو يقفل المراجعة ويقرر يكمل ولا يعيد لو ده آخر سؤال.
// scoreIncrement بيكون 0 أو 1 لأسئلة الاختيارات، ومفيش تأثير خالص لأسئلة "سمّعتها".
async function advanceReview(telegramId, chatId, scoreIncrement) {
  const user = await sheets.getUserProgress(telegramId);
  if (!user || user.reviewQueue.length === 0) return;

  const newScore = user.reviewScore + scoreIncrement;
  const newIndex = user.reviewQuestionIndex + 1;

  // لسه فيه أسئلة في الكويز
  if (newIndex < user.reviewQueue.length) {
    await sheets.updateUserFields(telegramId, {
      reviewScore: newScore,
      reviewQuestionIndex: newIndex,
    });
    const [nextPage, nextOccurrence] = user.reviewQueue[newIndex].split(':');
    const nextQuiz = await sheets.getQuizByPageOccurrence(nextPage, parseInt(nextOccurrence, 10));
    if (nextQuiz.type === 'complete') {
      await telegram.sendReviewSelfCheck(chatId, nextQuiz, newIndex + 1, user.reviewQueue.length);
    } else {
      await telegram.sendReviewQuestion(chatId, nextQuiz, newIndex + 1, user.reviewQueue.length);
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
async function handleReviewAnswer(telegramId, chatId, chosen, callbackQueryId) {
  const user = await sheets.getUserProgress(telegramId);
  if (!user || user.reviewQueue.length === 0) return;

  const currentEntry = user.reviewQueue[user.reviewQuestionIndex];
  if (!currentEntry) return;
  const [page, occurrence] = currentEntry.split(':');
  const quiz = await sheets.getQuizByPageOccurrence(page, parseInt(occurrence, 10));
  if (!quiz) return;

  const correct = chosen === quiz.correct;
  await telegram.answerCallbackQuery(callbackQueryId, correct ? '✅ صح!' : '❌ غلط');
  await advanceReview(telegramId, chatId, correct ? 1 : 0);
}

// تأكيد "سمّعتها" لسؤال إكمال الآية جوه يوم المراجعة الكبير
async function handleReviewDone(telegramId, chatId, callbackQueryId) {
  await telegram.answerCallbackQuery(callbackQueryId, '🌿 تمام');
  await advanceReview(telegramId, chatId, 0);
}

// إجابة سؤال اختيارات ضمن اختبار محطة (صفحة 21/41/49 مثلاً) - مفيش إيقاف على النتيجة أبدًا
async function handleMilestoneAnswer(telegramId, chatId, chosen, callbackQueryId) {
  const user = await sheets.getUserProgress(telegramId);
  if (!user || user.milestoneQueue.length === 0) return;

  const occurrence = user.milestoneQueue[user.milestoneQuestionIndex];
  if (occurrence === undefined) return;
  const quiz = await sheets.getMilestoneQuizByOccurrence(user.milestonePage, parseInt(occurrence, 10));
  if (!quiz) return;

  const correct = chosen === quiz.correct;
  await telegram.answerCallbackQuery(callbackQueryId, correct ? '✅ صح!' : '❌ غلط');

  const newScore = user.milestoneScore + (correct ? 1 : 0);
  const newIndex = user.milestoneQuestionIndex + 1;

  if (newIndex < user.milestoneQueue.length) {
    await sheets.updateUserFields(telegramId, {
      milestoneScore: newScore,
      milestoneQuestionIndex: newIndex,
    });
    const nextOccurrence = user.milestoneQueue[newIndex];
    const nextQuiz = await sheets.getMilestoneQuizByOccurrence(user.milestonePage, parseInt(nextOccurrence, 10));
    await telegram.sendMilestoneQuestion(chatId, nextQuiz, newIndex + 1, user.milestoneQueue.length);
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

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(200).send('OK - webhook is alive');
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

      if (type === 'quick') {
        const [, pageNumber, chosen] = parts;
        await handleQuickCheckAnswer(chatId, pageNumber, chosen, cq.id);
      } else if (type === 'quickdone') {
        await handleQuickCheckDone(chatId, cq.id);
      } else if (type === 'review') {
        const [, chosen] = parts;
        await handleReviewAnswer(telegramId, chatId, chosen, cq.id);
      } else if (type === 'reviewdone') {
        await handleReviewDone(telegramId, chatId, cq.id);
      } else if (type === 'reviewchoice') {
        const [, choice] = parts;
        await handleReviewChoice(telegramId, chatId, choice, cq.id);
      } else if (type === 'milestone') {
        const [, chosen] = parts;
        await handleMilestoneAnswer(telegramId, chatId, chosen, cq.id);
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

    if (text === '/start') {
      const user = await sheets.upsertUser({ telegramId, chatId, name, startPage: 1 });
      await telegram.sendMessage(
        chatId,
        `أهلًا بيك يا ${name} 🌿\n\n` +
          'رحلتك في حفظ سورة البقرة هتكون كده:\n' +
          '📖 يوم صفحة جديدة (فيديو + صوت + خريطة ذهنية + تفسير)\n' +
          '🧩 يوم تثبيت عليها\n' +
          'وكل 3 صفحات هيجيلك يوم مراجعة شاملة عليهم كلهم.\n\n' +
          'لو حابب توقف الإرسال اليومي مؤقتًا اكتب /stop، ولو عايز ترجعه اكتب /resume.'
      );
      await showPinnedMenu(chatId, false);
      // مستخدم جديد: أول صفحة تتبعت فورًا، وباقي الأيام الكرون يبعتها الساعة 7
      if (user.isNew) {
        await deliverFirstPage(user, new Date().toISOString().slice(0, 10));
      }
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
        await telegram.sendMessage(
          chatId,
          `📊 إنت دلوقتي على صفحة ${progress.currentPage} (يوم ${progress.cycleDay} من دورة الـ 7 أيام).`
        );
      } else {
        await telegram.sendMessage(chatId, 'ابعت /start الأول عشان نبدأ.');
      }
      return res.status(200).send('OK');
    }

    // أي رسالة تانية
    await telegram.sendMessage(chatId, 'اكتب /start عشان تبدأ رحلة حفظ سورة البقرة 🌿');
    return res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(200).send('OK'); // نرجع OK دايمًا عشان تيليجرام متعملش retry لا نهائي
  }
};
