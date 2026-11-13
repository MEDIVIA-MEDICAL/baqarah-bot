// lib/polls.js
// استفتاءات عامة: بتكتبي السؤال والاختيارات في تاب Polls بالشيت، وتبعتيه للكل بأمر واحد، من غير ما تلمسي الكود.
// كل استفتاء له رقم تعريف (poll_id) وبيتتبّع لوحده:
//   - نفس الاستفتاء ما بيتبعتش تاني لمن اتبعتله أو جاوب عليه قبل كده.
//   - أي استفتاء جديد (poll_id جديد) بيتبعت للكل، حتى لو جاوبوا على استفتاءات تانية.
// ملف مستقل: مفيش علاقة بالكرون، وبيتصل بالشيت لوحده.
//
// تابات الشيت:
//   Polls        (إنتي بتكتبيه): poll_id | question | option_1 | option_2 | option_3 | option_4 | option_5 | option_6
//   PollAnswers  (البوت بيملاه):  poll_id | telegram_id | name | answer | at
//
// الأوامر (ليكي إنتي بس):
//   /polls                    قايمة الاستفتاءات
//   /testpoll رقم             يبعتلك الاستفتاء إنتي بس (تجربة، إجابتك ما بتتسجلش)
//   /sendpoll رقم             يعرضلك هيتبعت لكام واحد
//   /sendpoll رقم confirm     يبعته فعلًا لكل المشتركين النشطين
//   /pollresults رقم          النتيجة

const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const telegram = require('./telegram');
const sheets = require('./sheets');

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const MAX_OPTIONS = 6;
const SEND_CONCURRENCY = 5; // رسايل بتتبعت مع بعض
const MAX_SEND_PER_RUN = 500; // أقصى عدد في الأمر الواحد

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function esc(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function ownerIds() {
  return String(process.env.OWNER_TELEGRAM_ID || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

// ---------- الاتصال بالشيت (مستقل عن sheets.js) ----------
let docPromise = null;
let docLoadedAt = 0;
const DOC_REFRESH_MS = 5 * 60 * 1000; // نجدّد معرفة التابات كل 5 دقايق

async function retry(fn) {
  const delays = [1500, 4000, 10000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = (err && (err.status || err.code || (err.response && err.response.status))) || 0;
      const retryable = status === 429 || (status >= 500 && status < 600) || /quota|rate limit|429/i.test(String(err && err.message));
      if (attempt >= delays.length || !retryable) throw err;
      await sleep(delays[attempt]);
    }
  }
}

async function getDoc() {
  if (!docPromise) {
    docPromise = (async () => {
      const auth = new JWT({
        email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        scopes: SCOPES,
      });
      const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
      await retry(() => doc.loadInfo());
      docLoadedAt = Date.now();
      return doc;
    })();
    docPromise.catch(() => {
      docPromise = null;
    });
  }
  return docPromise;
}

async function getTab(title, forceRefresh = false) {
  const doc = await getDoc();
  if (forceRefresh || Date.now() - docLoadedAt > DOC_REFRESH_MS) {
    await retry(() => doc.loadInfo());
    docLoadedAt = Date.now();
  }
  let sheet = doc.sheetsByTitle[title];
  if (!sheet) {
    await retry(() => doc.loadInfo()); // ممكن التاب اتضاف بعد ما البوت اشتغل
    docLoadedAt = Date.now();
    sheet = doc.sheetsByTitle[title];
  }
  return sheet || null;
}

function cell(row, column) {
  try {
    const value = row.get(column);
    return value === undefined || value === null ? '' : String(value);
  } catch (err) {
    return '';
  }
}

// ---------- قراءة الاستفتاءات والإجابات ----------
// بترجع Map (رقم -> استفتاء) أو null لو تاب Polls مش موجود
async function readPolls(forceRefresh = false) {
  const sheet = await getTab('Polls', forceRefresh);
  if (!sheet) return null;
  const rows = await retry(() => sheet.getRows());
  const polls = new Map();
  for (const row of rows) {
    const id = cell(row, 'poll_id').trim();
    const question = cell(row, 'question').trim();
    if (!/^[A-Za-z0-9_-]{1,12}$/.test(id) || !question) continue;
    const options = [];
    for (let i = 1; i <= MAX_OPTIONS; i++) {
      const text = cell(row, `option_${i}`).trim();
      if (text) options.push({ index: i, text });
    }
    if (options.length >= 2) polls.set(id.toLowerCase(), { id, question, options });
  }
  return polls;
}

// صفوف تاب PollAnswers، أو null لو مش موجود
async function readAnswerRows(forceRefresh = false) {
  const sheet = await getTab('PollAnswers', forceRefresh);
  if (!sheet) return null;
  const rows = await retry(() => sheet.getRows());
  return rows.map((r) => ({
    pollId: cell(r, 'poll_id').trim().toLowerCase(),
    id: cell(r, 'telegram_id').trim(),
    name: cell(r, 'name'),
    answer: parseInt(cell(r, 'answer'), 10) || 0,
  }));
}

// بتفصل إجابات استفتاء واحد (آخر إجابة لكل مستخدم) عن اللي اتبعتلهم
function analyze(rows, pollId) {
  const answers = new Map();
  const sent = new Set();
  for (const row of rows) {
    if (row.pollId !== pollId) continue;
    if (row.id === '_sent') {
      row.name.split(',').map((x) => x.trim()).filter(Boolean).forEach((id) => sent.add(id));
      continue;
    }
    if (!row.id || row.id.startsWith('_')) continue;
    answers.set(row.id, row);
  }
  return { answers, sent };
}

async function recordAnswer({ pollId, telegramId, name, answer }) {
  const sheet = await getTab('PollAnswers');
  if (!sheet) throw new Error('PollAnswers tab is missing');
  await retry(() =>
    sheet.addRow({
      poll_id: pollId,
      telegram_id: String(telegramId),
      name: name || '',
      answer: String(answer),
      at: new Date().toISOString(),
    })
  );
}

// نسجّل مين اتبعتله الاستفتاء (صف لكل 2000 مستخدم عشان حد حجم الخانة)
async function markSent(pollId, ids) {
  if (ids.length === 0) return;
  const sheet = await getTab('PollAnswers');
  if (!sheet) throw new Error('PollAnswers tab is missing');
  for (let i = 0; i < ids.length; i += 2000) {
    await retry(() =>
      sheet.addRow({
        poll_id: pollId,
        telegram_id: '_sent',
        name: ids.slice(i, i + 2000).join(','),
        answer: '',
        at: new Date().toISOString(),
      })
    );
  }
}

// ---------- شكل الرسالة ----------
function pollText(poll) {
  return `📊 <b>استفتاء سريع</b>\n\n${esc(poll.question)}`;
}

function pollKeyboard(poll) {
  return {
    inline_keyboard: poll.options.map((o) => [{ text: o.text, callback_data: `pl:${poll.id}:${o.index}` }]),
  };
}

function sendPoll(chatId, poll) {
  return telegram.sendMessage(chatId, pollText(poll), { reply_markup: pollKeyboard(poll) });
}

// ---------- ضغطة زرار اختيار (pl:رقم:اختيار) ----------
const recentlyAnswered = new Set(); // لو نفس الشخص ضغط مرتين بسرعة، ما نسجّلش مرتين

async function handleCallback(cq, parts, isOwner) {
  const chatId = cq.message.chat.id;
  const messageId = cq.message.message_id;
  const telegramId = cq.from.id;
  const pollId = String(parts[1] || '').toLowerCase();
  const choice = parseInt(parts[2], 10);
  if (!pollId || !(choice >= 1 && choice <= MAX_OPTIONS)) {
    await telegram.answerCallbackQuery(cq.id, '🌿');
    return;
  }

  // نص الاختيار بنجيبه من الزرار نفسه (من غير قراءة من الشيت)
  const buttons = ((cq.message.reply_markup && cq.message.reply_markup.inline_keyboard) || []).flat();
  const pressed = buttons.find((b) => b.callback_data === cq.data);
  const label = pressed ? pressed.text : `الاختيار ${choice}`;

  // إنتي (المالك): ده وضع تجربة، الإجابة ما بتتسجلش
  if (isOwner) {
    await telegram.answerCallbackQuery(cq.id, 'تجربة: الإجابة ما اتسجلتش');
    await telegram.editMessageText(chatId, messageId, `🧪 (تجربة) اخترتي: ${esc(label)}`);
    return;
  }

  const key = `${pollId}:${telegramId}`;
  if (!recentlyAnswered.has(key)) {
    const name = [cq.from.first_name, cq.from.last_name].filter(Boolean).join(' ');
    try {
      await recordAnswer({ pollId, telegramId, name, answer: choice });
    } catch (err) {
      // الأزرار بتفضل ظاهرة عشان يجرّب تاني
      await telegram.answerCallbackQuery(cq.id, 'حصلت مشكلة، جرّب تاني بعد شوية 🌿');
      throw err;
    }
    recentlyAnswered.add(key);
  }
  await telegram.answerCallbackQuery(cq.id, 'شكرًا 🤍');
  await telegram.editMessageText(chatId, messageId, `🤍 شكرًا ليك! اخترت: ${esc(label)}`);
}

// ---------- أوامرك ----------
async function tabsMissingMessage(chatId) {
  await telegram.sendMessage(
    chatId,
    'محتاجة تعملي تابين جداد في الشيت:\n\n' +
      '1) <b>Polls</b> وصفه الأول: poll_id | question | option_1 | option_2 | option_3 | option_4 | option_5 | option_6\n' +
      '2) <b>PollAnswers</b> وصفه الأول: poll_id | telegram_id | name | answer | at\n\n' +
      'وبعدين اكتبي استفتاءك في Polls. لسه ما بعتّش حاجة لأي حد.'
  );
}

function unknownPollMessage(polls, id) {
  const ids = [...polls.values()].map((p) => p.id).join('، ') || '(مفيش استفتاءات صالحة)';
  return `مفيش استفتاء رقمه "${esc(id || '')}" 🌿\nالموجود: ${esc(ids)}\n(لازم يبقى له سؤال واختيارين على الأقل في تاب Polls)`;
}

async function handleCommand(cmd, args, chatId) {
  const polls = await readPolls(true);
  if (polls === null) {
    await tabsMissingMessage(chatId);
    return;
  }

  // /polls
  if (cmd === '/polls') {
    if (polls.size === 0) {
      await telegram.sendMessage(chatId, 'مفيش استفتاءات صالحة في تاب Polls لسه 🌿');
      return;
    }
    const rows = (await readAnswerRows(true)) || [];
    const lines = [...polls.values()].map((p) => {
      const { answers, sent } = analyze(rows, p.id.toLowerCase());
      return `• <b>${esc(p.id)}</b>: ${esc(p.question.slice(0, 45))}\n   اتبعت لـ ${sent.size}، جاوب ${answers.size}`;
    });
    await telegram.sendMessage(chatId, `📊 <b>الاستفتاءات:</b>\n\n${lines.join('\n')}`);
    return;
  }

  const pollKey = String(args[0] || '').toLowerCase();
  const poll = polls.get(pollKey);
  if (!poll) {
    await telegram.sendMessage(chatId, unknownPollMessage(polls, args[0]));
    return;
  }

  // /testpoll رقم
  if (cmd === '/testpoll') {
    await sendPoll(chatId, poll);
    return;
  }

  // /pollresults رقم
  if (cmd === '/pollresults') {
    const rows = await readAnswerRows(true);
    if (rows === null) {
      await tabsMissingMessage(chatId);
      return;
    }
    const owners = new Set(ownerIds());
    const { answers, sent } = analyze(rows, pollKey);
    const list = [...answers.values()].filter((a) => !owners.has(a.id));
    if (list.length === 0) {
      await telegram.sendMessage(chatId, `لسه محدش جاوب على "${esc(poll.id)}" 🌿 (اتبعت لـ ${sent.size})`);
      return;
    }
    const base = Math.max(sent.size, list.length);
    const lines = poll.options.map((o) => {
      const count = list.filter((a) => a.answer === o.index).length;
      const percent = Math.round((count / list.length) * 100);
      return `• ${esc(o.text)}: ${count} (${percent}%)`;
    });
    await telegram.sendMessage(
      chatId,
      `📊 <b>${esc(poll.id)}</b>: ${esc(poll.question)}\n\n` +
        `📨 اتبعت لـ ${sent.size}\n✍️ جاوب ${list.length} (${Math.round((list.length / base) * 100)}%)\n\n` +
        lines.join('\n')
    );
    return;
  }

  // /sendpoll رقم [confirm]
  if (cmd === '/sendpoll') {
    const rows = await readAnswerRows(true);
    if (rows === null) {
      await tabsMissingMessage(chatId);
      return;
    }
    const owners = new Set(ownerIds());
    const { answers, sent } = analyze(rows, pollKey);
    const users = await sheets.getAllUsers();
    const eligible = users.filter(
      (u) =>
        u.subscribed &&
        !owners.has(String(u.telegramId)) &&
        !answers.has(String(u.telegramId)) &&
        !sent.has(String(u.telegramId))
    );

    if (eligible.length === 0) {
      await telegram.sendMessage(
        chatId,
        `مفيش حد مؤهل لاستفتاء "${esc(poll.id)}" دلوقتي 🌿\n(اتبعت لـ ${sent.size}، وجاوب ${answers.size})`
      );
      return;
    }

    if (String(args[1] || '').toLowerCase() !== 'confirm') {
      await telegram.sendMessage(
        chatId,
        `📨 استفتاء "<b>${esc(poll.id)}</b>" هيتبعت لـ <b>${eligible.length}</b> مشترك نشط (اللي ما اتبعتلهمش ولا جاوبوا عليه قبل كده).\n\n` +
          `${esc(poll.question)}\n${poll.options.map((o) => `• ${esc(o.text)}`).join('\n')}\n\n` +
          `جرّبيه على نفسك الأول بـ /testpoll ${esc(poll.id)}\nولو متأكدة اكتبي: /sendpoll ${esc(poll.id)} confirm`
      );
      return;
    }

    const batch = eligible.slice(0, MAX_SEND_PER_RUN);
    const okIds = [];
    let failed = 0;
    let cursor = 0;
    async function worker() {
      while (true) {
        const i = cursor++;
        if (i >= batch.length) return;
        const user = batch[i];
        const result = await sendPoll(user.chatId, poll);
        if (result && result.ok) okIds.push(String(user.telegramId));
        else {
          failed += 1;
          telegram.consumeBlocked(user.chatId); // الكرون بيتعامل مع الحظر بنفسه
        }
      }
    }
    await Promise.all(Array.from({ length: SEND_CONCURRENCY }, worker));
    await markSent(pollKey, okIds);

    let msg = `✅ اتبعت استفتاء "${esc(poll.id)}" لـ ${okIds.length} مستخدم.`;
    if (failed > 0) msg += `\n🚫 ${failed} ما وصلهمش (غالبًا حاظرين البوت).`;
    if (eligible.length > batch.length) msg += `\n\nفاضل ${eligible.length - batch.length} لسه، اكتبي الأمر تاني.`;
    msg += `\n\nشوفي النتيجة بـ /pollresults ${esc(poll.id)}`;
    await telegram.sendMessage(chatId, msg);
  }
}

module.exports = { handleCommand, handleCallback };
