// lib/sheets.js
// كل التعامل مع Google Sheets في مكان واحد.
// السبريد شيت لازم يحتوي على 3 تابات (sheets) بالأسماء دي بالظبط:
//   1) Content  -> المحتوى اليومي (صفحة - فيديو - صوت - خريطة ذهنية - تفسير)
//   2) Progress -> تقدم كل مستخدم (تلقائي، البوت هو اللي بيكتب فيه)
//   3) Quiz     -> بنك الأسئلة (ممكن أكتر من سؤال لنفس رقم الصفحة)

const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

let cachedDoc = null;

async function getDoc() {
  if (cachedDoc) return cachedDoc;

  const serviceAccountAuth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: SCOPES,
  });

  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);
  await doc.loadInfo();
  cachedDoc = doc;
  return doc;
}

// ---------- المحتوى ----------

// بيرجع صف المحتوى الخاص برقم صفحة معينة
async function getContentForPage(pageNumber) {
  const doc = await getDoc();
  const sheet = doc.sheetsByTitle['Content'];
  const rows = await sheet.getRows();
  const row = rows.find((r) => String(r.get('page_number')) === String(pageNumber));
  if (!row) return null;
  return {
    pageNumber: row.get('page_number'),
    versesRange: row.get('verses_range'),
    quranPageImageUrl: row.get('quran_page_image_url'),
    videoUrl: row.get('video_url'),
    audioUrl: row.get('audio_url'),
    audioUrl2: row.get('audio_url_2'),
    mindmapImageUrl: row.get('mindmap_image_url'),
    tafsirText: row.get('tafsir_text'),
  };
}

// ---------- الرسائل التحفيزية ----------

// بيرجع رسالة تحفيزية عشوائية من تاب Motivation (لو موجود وفيه رسايل)
async function getRandomMotivation() {
  const doc = await getDoc();
  const sheet = doc.sheetsByTitle['Motivation'];
  if (!sheet) return null;
  const rows = await sheet.getRows();
  const messages = rows.map((r) => r.get('message')).filter(Boolean);
  if (messages.length === 0) return null;
  return messages[Math.floor(Math.random() * messages.length)];
}

// ---------- الرسالة المثبتة (Pinned) ----------
// تاب اختياري اسمه Pinned، أعمدته: section | order | type | content | caption
//  - صف بـ section = _pinned و type = text → نص الرسالة المثبتة نفسها (العنوان اللي فوق الأزرار)
//  - أي section تاني → بيبقى زرار في الرسالة المثبتة، ولما المستخدم يدوس عليه
//    البوت يبعتله كل صفوف الـ section ده بالترتيب (order)
//  - type: text (نص) | photo (صورة) | video (فيديو) | audio (صوت)
//  - content: النص نفسه لو text، أو الرابط المباشر (raw) لو صورة/فيديو/صوت
async function getPinnedConfig() {
  const doc = await getDoc();
  const sheet = doc.sheetsByTitle['Pinned'];
  if (!sheet) return null;
  const rows = await sheet.getRows();

  const items = rows
    .map((r) => ({
      section: (r.get('section') || '').trim(),
      order: parseFloat(r.get('order') || '0'),
      type: (r.get('type') || 'text').trim().toLowerCase(),
      content: r.get('content') || '',
      caption: r.get('caption') || '',
    }))
    .filter((i) => i.section && i.content);

  items.sort((a, b) => a.order - b.order);

  const introItem = items.find((i) => i.section === '_pinned' && i.type === 'text');

  // ترتيب الأقسام حسب أول ظهور ليها في الشيت (ده اللي بيحدد رقم كل زرار)
  const sectionNames = [];
  for (const i of items) {
    if (i.section !== '_pinned' && !sectionNames.includes(i.section)) {
      sectionNames.push(i.section);
    }
  }

  const sections = sectionNames.map((name) => ({
    name,
    items: items.filter((i) => i.section === name),
  }));

  if (!introItem && sections.length === 0) return null;
  return { introText: introItem ? introItem.content : '', sections };
}

// ---------- بنك الأسئلة ----------

// بتتجاهل أي صف أسئلة لسه ناقص (مثلاً صف جاهز في الشيت لسه ممليتهوش)، عشان البوت
// ميبعتش سؤال فاضي لتيليجرام. سؤال mcq لازم يكون فيه إجابة صح واختيارين على الأقل.
function isUsableQuizRow(row) {
  const question = (row.get('question') || '').trim();
  if (!question) return false;
  const type = (readOptional(row, 'question_type') || 'mcq').toLowerCase();
  if (type === 'complete') return true;
  const optionCount = ['option_a', 'option_b', 'option_c', 'option_d']
    .filter((k) => (row.get(k) || '').trim()).length;
  const correct = (row.get('correct_option') || '').trim();
  return optionCount >= 2 && correct !== '';
}

// بتقرا عمود اختياري (زي explanation) من غير ما تقع لو العمود مش موجود في الشيت
function readOptional(row, column) {
  try {
    return String(row.get(column) || '').trim();
  } catch (err) {
    return '';
  }
}

function rowToQuiz(row) {
  const type = (readOptional(row, 'question_type') || 'mcq').toLowerCase();
  return {
    type, // 'mcq' (اختيارات) أو 'complete' (زرار تعليم ذاتي بعد الاستماع - سؤال إكمال الآية)
    question: row.get('question'),
    options: {
      a: row.get('option_a'),
      b: row.get('option_b'),
      c: row.get('option_c'),
      d: row.get('option_d'),
    },
    correct: (row.get('correct_option') || '').trim().toLowerCase(),
    explanation: readOptional(row, 'explanation'),
  };
}

// بيرجع كل أسئلة صفحة معينة بالترتيب اللي هي متكتبة بيه في الشيت
async function getQuizRowsForPage(pageNumber) {
  const doc = await getDoc();
  const sheet = doc.sheetsByTitle['Quiz'];
  const rows = await sheet.getRows();
  return rows
    .filter((r) => String(r.get('page_number')) === String(pageNumber) && isUsableQuizRow(r))
    .map(rowToQuiz);
}

// بيرجع أول سؤال بس لصفحة معينة (مستخدم في "يوم التثبيت" - يوم 2/4/6)
async function getFirstQuizForPage(pageNumber) {
  const quizzes = await getQuizRowsForPage(pageNumber);
  return quizzes.length ? quizzes[0] : null;
}

// بيرجع كل الأسئلة الخاصة بمجموعة صفحات (مستخدم في يوم المراجعة الكبيرة)
// كل عنصر فيه pageNumber + occurrence (ترتيبه بين أسئلة نفس الصفحة) عشان نقدر نرجعله بعدين
async function getQuizRowsForPages(pages) {
  const doc = await getDoc();
  const sheet = doc.sheetsByTitle['Quiz'];
  const rows = await sheet.getRows();
  const result = [];
  for (const page of pages) {
    const matching = rows.filter(
      (r) => String(r.get('page_number')) === String(page) && isUsableQuizRow(r)
    );
    matching.forEach((r, occurrence) => {
      result.push({ pageNumber: page, occurrence, ...rowToQuiz(r) });
    });
  }
  return result;
}

// بيرجع سؤال معين بالظبط عن طريق رقم الصفحة + ترتيبه (مستخدم وقت تقييم إجابة المراجعة)
async function getQuizByPageOccurrence(pageNumber, occurrence) {
  const quizzes = await getQuizRowsForPage(pageNumber);
  return quizzes[occurrence] || null;
}

// ---------- اختبارات المحطات (Milestones) ----------
// تاب اختياري اسمه Milestones، نفس شكل تاب Quiz بس مفتاحه milestone_page بدل page_number.
// بيُستخدم لاختبارات كبيرة بعد صفحات معينة (زي صفحة 21، 41، 49) غير مرتبطة بدورة الـ7 أيام العادية.

async function getMilestoneQuizRows(milestonePage) {
  const doc = await getDoc();
  const sheet = doc.sheetsByTitle['Milestones'];
  if (!sheet) return [];
  const rows = await sheet.getRows();
  return rows
    .filter((r) => String(r.get('milestone_page')) === String(milestonePage) && isUsableQuizRow(r))
    .map((r, occurrence) => ({ occurrence, ...rowToQuiz(r) }));
}

async function getMilestoneQuizByOccurrence(milestonePage, occurrence) {
  const rows = await getMilestoneQuizRows(milestonePage);
  return rows[occurrence] || null;
}

// ---------- تقدم المستخدمين ----------

async function getProgressSheet() {
  const doc = await getDoc();
  return doc.sheetsByTitle['Progress'];
}

function rowToProgress(row) {
  return {
    row,
    telegramId: row.get('telegram_id'),
    chatId: row.get('chat_id'),
    name: row.get('name'),
    currentPage: parseInt(row.get('current_page') || '1', 10),
    subscribed: String(row.get('subscribed')).toUpperCase() === 'TRUE',
    lastSentDate: row.get('last_sent_date') || '',
    cycleDay: parseInt(row.get('cycle_day') || '1', 10),
    blockStartPage: row.get('block_start_page')
      ? parseInt(row.get('block_start_page'), 10)
      : null,
    // review_queue شكلها: "12:0,12:1,13:0,14:0" (رقم صفحة:ترتيب السؤال جوه صفحته)، مفصولة بفواصل
    reviewQueue: row.get('review_queue')
      ? row.get('review_queue').split(',').filter(Boolean)
      : [],
    reviewQuestionIndex: parseInt(row.get('review_question_index') || '0', 10),
    reviewScore: parseInt(row.get('review_score') || '0', 10),
    // لما تكون النتيجة أقل من النص، بننتظر اختيار المستخدم (repeat / continue) قبل ما نكمل
    pendingChoice: row.get('pending_choice') || '',
    // بيانات اختبار المحطة (يوم إضافي بعد صفحات معينة زي 21/41/49)
    milestonePage: row.get('milestone_page') ? parseInt(row.get('milestone_page'), 10) : null,
    milestoneQueue: row.get('milestone_queue')
      ? row.get('milestone_queue').split(',').filter(Boolean)
      : [],
    milestoneQuestionIndex: parseInt(row.get('milestone_question_index') || '0', 10),
    milestoneScore: parseInt(row.get('milestone_score') || '0', 10),
    // الـ cycle_day اللي نرجع نكمل عليه بعد ما اختبار المحطة يخلص
    pendingResumeDay: row.get('pending_resume_day')
      ? parseInt(row.get('pending_resume_day'), 10)
      : null,
  };
}

async function getUserProgress(telegramId) {
  const sheet = await getProgressSheet();
  const rows = await sheet.getRows();
  const row = rows.find((r) => String(r.get('telegram_id')) === String(telegramId));
  if (!row) return null;
  return rowToProgress(row);
}

// بيسجل مستخدم جديد أو يفعّل اشتراكه لو موجود بالفعل
async function upsertUser({ telegramId, chatId, name, startPage = 1 }) {
  const sheet = await getProgressSheet();
  const existing = await getUserProgress(telegramId);

  if (existing) {
    existing.row.set('subscribed', 'TRUE');
    existing.row.set('chat_id', chatId);
    await existing.row.save();
    return { ...(await getUserProgress(telegramId)), isNew: false };
  }

  await sheet.addRow({
    telegram_id: telegramId,
    chat_id: chatId,
    name: name || '',
    current_page: startPage,
    subscribed: 'TRUE',
    last_sent_date: '',
    cycle_day: 1,
    block_start_page: startPage,
    review_queue: '',
    review_question_index: 0,
    review_score: 0,
    pending_choice: '',
    milestone_page: '',
    milestone_queue: '',
    milestone_question_index: 0,
    milestone_score: 0,
    pending_resume_day: '',
  });
  return { ...(await getUserProgress(telegramId)), isNew: true };
}

async function setSubscribed(telegramId, value) {
  const existing = await getUserProgress(telegramId);
  if (!existing) return;
  existing.row.set('subscribed', value ? 'TRUE' : 'FALSE');
  await existing.row.save();
}

async function getAllSubscribedUsers() {
  const sheet = await getProgressSheet();
  const rows = await sheet.getRows();
  return rows
    .filter((r) => String(r.get('subscribed')).toUpperCase() === 'TRUE')
    .map(rowToProgress);
}

// ---------- متابعة أقسام الرسالة المثبتة اللي المستخدم شافها ----------
// عمود اختياري اسمه pinned_seen في تاب Progress (أرقام الأقسام مفصولة بفواصل).
// لو العمود مش موجود، البوت يشتغل عادي ويبعت المحتوى كل مرة بدل ما يقع.

async function getPinnedSeen(telegramId) {
  const user = await getUserProgress(telegramId);
  if (!user) return [];
  try {
    const raw = user.row.get('pinned_seen');
    return raw ? String(raw).split(',').map((x) => x.trim()).filter(Boolean) : [];
  } catch (err) {
    return [];
  }
}

// بيرجع true لو اتسجّل، وfalse لو العمود مش موجود أو حصل خطأ
async function setPinnedSeen(telegramId, indexes) {
  const user = await getUserProgress(telegramId);
  if (!user) return false;
  try {
    user.row.set('pinned_seen', indexes.join(','));
    await user.row.save();
    return true;
  } catch (err) {
    console.error('pinned_seen column missing or not writable:', err.message);
    return false;
  }
}

async function markPinnedSeen(telegramId, sectionIndex) {
  const seen = await getPinnedSeen(telegramId);
  const key = String(sectionIndex);
  if (!seen.includes(key)) seen.push(key);
  return setPinnedSeen(telegramId, seen);
}

async function resetPinnedSeen(telegramId) {
  return setPinnedSeen(telegramId, []);
}

// تحديث عام لأي مجموعة حقول في صف مستخدم معين (بيوفر تكرار الكود)
async function updateUserFields(telegramId, fields) {
  const existing = await getUserProgress(telegramId);
  if (!existing) return null;

  const map = {
    currentPage: 'current_page',
    cycleDay: 'cycle_day',
    blockStartPage: 'block_start_page',
    reviewQueue: 'review_queue',
    reviewQuestionIndex: 'review_question_index',
    reviewScore: 'review_score',
    lastSentDate: 'last_sent_date',
    pendingChoice: 'pending_choice',
    milestonePage: 'milestone_page',
    milestoneQueue: 'milestone_queue',
    milestoneQuestionIndex: 'milestone_question_index',
    milestoneScore: 'milestone_score',
    pendingResumeDay: 'pending_resume_day',
  };

  for (const [key, value] of Object.entries(fields)) {
    const columnName = map[key];
    if (!columnName) continue;
    existing.row.set(
      columnName,
      Array.isArray(value) ? value.join(',') : value
    );
  }
  await existing.row.save();
  return getUserProgress(telegramId);
}

module.exports = {
  getContentForPage,
  getRandomMotivation,
  getPinnedConfig,
  getPinnedSeen,
  markPinnedSeen,
  resetPinnedSeen,
  getQuizRowsForPage,
  getFirstQuizForPage,
  getQuizRowsForPages,
  getQuizByPageOccurrence,
  getMilestoneQuizRows,
  getMilestoneQuizByOccurrence,
  getUserProgress,
  upsertUser,
  setSubscribed,
  getAllSubscribedUsers,
  updateUserFields,
};
