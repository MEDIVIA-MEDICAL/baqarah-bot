// lib/sheets.js
// كل التعامل مع Google Sheets في مكان واحد.
// السبريد شيت لازم يحتوي على 3 تابات (sheets) بالأسماء دي بالظبط:
//   1) Content  -> المحتوى اليومي (صفحة - فيديو - صوت - خريطة ذهنية - تفسير)
//   2) Progress -> تقدم كل مستخدم (تلقائي، البوت هو اللي بيكتب فيه)
//   3) Quiz     -> بنك الأسئلة (ممكن أكتر من سؤال لنفس رقم الصفحة)

const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

// ---------- إعادة المحاولة + الكاش (عشان البوت يتحمّل مستخدمين كتير) ----------
// جوجل بتحدد عدد الطلبات في الدقيقة. لو الحد خلص بيرجع خطأ مؤقت، فبنستنى شوية ونحاول تاني
// بدل ما العملية تفشل. وتابات المحتوى (اللي أنتِ بس اللي بتعدليها) بنحفظها في الذاكرة 5 دقايق.
const RETRY_DELAYS_MS = [1500, 4000, 10000, 20000];
const TAB_CACHE_TTL_MS = 5 * 60 * 1000;

function isRetryableError(err) {
  const status = (err && (err.status || err.code || (err.response && err.response.status))) || 0;
  if (status === 429 || (status >= 500 && status < 600)) return true;
  const msg = String((err && err.message) || '');
  return /quota|rate limit|too many requests|429|ECONNRESET|ETIMEDOUT|socket hang up|50[0-4]/i.test(msg);
}

async function withRetry(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= RETRY_DELAYS_MS.length || !isRetryableError(err)) throw err;
      const jitter = Math.floor(Math.random() * 500);
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt] + jitter));
    }
  }
}

let docPromise = null;

async function getDoc() {
  if (!docPromise) {
    docPromise = (async () => {
      const serviceAccountAuth = new JWT({
        email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        scopes: SCOPES,
      });
      const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);
      await withRetry(() => doc.loadInfo());
      return doc;
    })();
    docPromise.catch(() => {
      docPromise = null; // لو فشل التحميل، نحاول من الأول في الطلب الجاي
    });
  }
  return docPromise;
}

// بترجع صفوف تاب للقراءة بس (Content / Quiz / Milestones / Motivation / Pinned) من الكاش.
// بترجع null لو التاب مش موجود.
const tabCache = new Map();

async function getTabRows(title) {
  const hit = tabCache.get(title);
  if (hit && Date.now() - hit.at < TAB_CACHE_TTL_MS) return hit.promise;

  const promise = (async () => {
    const doc = await getDoc();
    const sheet = doc.sheetsByTitle[title];
    if (!sheet) return null;
    return withRetry(() => sheet.getRows());
  })();
  tabCache.set(title, { at: Date.now(), promise });
  try {
    return await promise;
  } catch (err) {
    tabCache.delete(title);
    throw err;
  }
}

// بتمسح كاش التابات عشان القراءة الجاية تجيب أحدث نسخة من الشيت (بيستخدمها /preview و /quiz)
function clearTabCache() {
  tabCache.clear();
}

// ---------- المحتوى ----------

// بيرجع صف المحتوى الخاص برقم صفحة معينة
async function getContentForPage(pageNumber) {
  const rows = await getTabRows('Content');
  if (!rows) return null;
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
  const rows = await getTabRows('Motivation');
  if (!rows) return null;
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
  const rows = await getTabRows('Pinned');
  if (!rows) return null;

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
  const rows = (await getTabRows('Quiz')) || [];
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
  const rows = (await getTabRows('Quiz')) || [];
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
  const rows = await getTabRows('Milestones');
  if (!rows) return [];
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
    // تاريخ تنبيه "هنفضّي مكانك" للموقّفين (عمود اختياري warned_at)
    warnedAt: readOptional(row, 'warned_at'),
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

// آخر صف قريناه لمستخدم (5 ثواني). بيخلّي updateUserFields ما تقراش الشيت كله تاني بعد getUserProgress،
// فبنوفّر طلبات قراءة (حد جوجل 60 قراءة في الدقيقة).
const RECENT_ROW_TTL_MS = 5 * 1000;
const recentRows = new Map();

function rememberRow(telegramId, row) {
  recentRows.set(String(telegramId), { row, at: Date.now() });
  if (recentRows.size > 300) {
    const cutoff = Date.now() - RECENT_ROW_TTL_MS;
    for (const [key, value] of recentRows) if (value.at < cutoff) recentRows.delete(key);
  }
}

async function getUserProgress(telegramId) {
  const sheet = await getProgressSheet();
  const rows = await withRetry(() => sheet.getRows());
  const row = rows.find((r) => String(r.get('telegram_id')) === String(telegramId));
  if (!row) return null;
  rememberRow(telegramId, row);
  return rowToProgress(row);
}

// بيسجل مستخدم جديد أو يفعّل اشتراكه لو موجود بالفعل
async function upsertUser({ telegramId, chatId, name, startPage = 1 }) {
  recentRows.delete(String(telegramId));
  const sheet = await getProgressSheet();
  const existing = await getUserProgress(telegramId);

  if (existing) {
    existing.row.set('subscribed', 'TRUE');
    trySet(existing.row, 'warned_at', '');
    existing.row.set('chat_id', chatId);
    await withRetry(() => existing.row.save());
    return { ...rowToProgress(existing.row), isNew: false };
  }

  const created = await withRetry(() => sheet.addRow({
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
  }));
  let progress = rowToProgress(created);
  if (String(progress.telegramId) !== String(telegramId)) {
    progress = await getUserProgress(telegramId);
  }
  return { ...progress, isNew: true };
}

// بتكتب في عمود اختياري من غير ما تقع لو العمود مش موجود في الشيت
function trySet(row, column, value) {
  try {
    row.set(column, value);
    return true;
  } catch (err) {
    return false;
  }
}

async function setSubscribed(telegramId, value) {
  recentRows.delete(String(telegramId));
  const existing = await getUserProgress(telegramId);
  if (!existing) return;
  existing.row.set('subscribed', value ? 'TRUE' : 'FALSE');
  if (value) trySet(existing.row, 'warned_at', ''); // رجع، يبقى مفيش تنبيه مسح عليه
  await withRetry(() => existing.row.save());
}

// ---------- حد التسجيل وأكواد الدخول ----------
// قائمة أرقام المسجلين محفوظة في الذاكرة دقيقة، عشان لما ناس كتير تضغط /start مع بعض
// مانقراش الشيت مع كل واحد فيهم.
const IDS_CACHE_TTL_MS = 60 * 1000;
let idsCache = { at: 0, ids: new Set() };

async function getRegisteredIds(forceFresh = false) {
  if (!forceFresh && Date.now() - idsCache.at < IDS_CACHE_TTL_MS) return idsCache.ids;
  const sheet = await getProgressSheet();
  const rows = await withRetry(() => sheet.getRows());
  idsCache = { at: Date.now(), ids: new Set(rows.map((r) => String(r.get('telegram_id')))) };
  return idsCache.ids;
}

function noteRegistered(telegramId) {
  idsCache.ids.add(String(telegramId));
}

// بتجرّب تستخدم كود دخول من تاب Invites. الأعمدة: code, max_uses, used_count, last_used_by
// max_uses فاضي = الكود لمرة واحدة. بترجع true لو الكود صحيح ولسه فيه استخدامات.
async function redeemInviteCode(code, telegramId) {
  const cleaned = String(code || '').trim().toLowerCase();
  if (!cleaned || cleaned.length > 60) return false;

  const doc = await getDoc();
  let sheet = doc.sheetsByTitle['Invites'];
  if (!sheet) {
    // ممكن التاب اتضاف بعد ما البوت اشتغل، فنعيد تحميل بيانات الملف مرة واحدة
    await withRetry(() => doc.loadInfo());
    sheet = doc.sheetsByTitle['Invites'];
    if (!sheet) return false;
  }

  const rows = await withRetry(() => sheet.getRows());
  const row = rows.find((r) => readOptional(r, 'code').toLowerCase() === cleaned);
  if (!row) return false;

  const maxUses = parseInt(readOptional(row, 'max_uses'), 10) || 1;
  const used = parseInt(readOptional(row, 'used_count'), 10) || 0;
  if (used >= maxUses) return false;

  try {
    row.set('used_count', used + 1);
    row.set('last_used_by', String(telegramId));
    await withRetry(() => row.save());
  } catch (err) {
    // غالبًا أعمدة used_count / last_used_by مش موجودة في تاب Invites
    console.error('Invites tab is missing columns (used_count / last_used_by):', err.message);
    return false;
  }
  return true;
}

// ---------- تنظيف الموقّفين (أوامر /warn و /cleanup) ----------
// هل عمود معيّن موجود في تاب Progress؟
async function progressHasColumn(name) {
  const sheet = await getProgressSheet();
  await withRetry(() => sheet.loadHeaderRow());
  return sheet.headerValues.includes(name);
}

// بتسجّل تاريخ التنبيه في عمود warned_at لمجموعة مستخدمين (entries: [{ telegramId, value }])
async function markWarnedBatch(entries) {
  recentRows.clear();
  const sheet = await getProgressSheet();
  const rows = await withRetry(() => sheet.getRows());
  const byId = new Map(entries.map((e) => [String(e.telegramId), e.value]));
  let marked = 0;
  for (const row of rows) {
    const id = String(row.get('telegram_id'));
    if (!byId.has(id)) continue;
    if (!trySet(row, 'warned_at', byId.get(id))) continue;
    await withRetry(() => row.save());
    marked += 1;
  }
  return marked;
}

// بتمسح صفوف مستخدمين موقّفين (من تحت لفوق عشان أرقام الصفوف ما تتلخبطش).
// لو حد منهم رجع واشترك تاني في الأثناء، بنسيبه.
async function deleteUsers(telegramIds) {
  recentRows.clear();
  const sheet = await getProgressSheet();
  const rows = await withRetry(() => sheet.getRows());
  const ids = new Set(telegramIds.map(String));
  const targets = rows
    .filter((r) => ids.has(String(r.get('telegram_id'))))
    .filter((r) => String(r.get('subscribed')).toUpperCase() !== 'TRUE')
    .sort((a, b) => b.rowNumber - a.rowNumber);
  for (const row of targets) {
    await withRetry(() => row.delete());
  }
  idsCache.at = 0; // نحدّث عدّاد المسجلين
  return targets.length;
}

// كل المسجلين (المشتركين وغير المشتركين) - بيستخدمها أمر /stats
async function getAllUsers() {
  const sheet = await getProgressSheet();
  const rows = await withRetry(() => sheet.getRows());
  return rows.map(rowToProgress);
}

async function getAllSubscribedUsers() {
  const sheet = await getProgressSheet();
  const rows = await withRetry(() => sheet.getRows());
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
    await withRetry(() => user.row.save());
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
async function updateUserFields(telegramId, fields, knownRow) {
  // knownRow: صف جاهز (من الكرون). وإلا بنستخدم آخر صف اتقرا من ثواني، وإلا بنقرا الشيت.
  let row = knownRow;
  if (!row) {
    const recent = recentRows.get(String(telegramId));
    if (recent && Date.now() - recent.at < RECENT_ROW_TTL_MS) row = recent.row;
  }
  if (!row) {
    const existing = await getUserProgress(telegramId);
    if (!existing) return null;
    row = existing.row;
  }

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
    row.set(
      columnName,
      Array.isArray(value) ? value.join(',') : value
    );
  }
  await withRetry(() => row.save());
  rememberRow(telegramId, row);
  return rowToProgress(row);
}

module.exports = {
  progressHasColumn,
  markWarnedBatch,
  deleteUsers,
  getRegisteredIds,
  noteRegistered,
  redeemInviteCode,
  getAllUsers,
  clearTabCache,
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
