require('dotenv').config();

const express = require('express');
const line = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.static('dashboard'));

// ─── LINE Client ──────────────────────────────────────────────────────────────
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});
const lineBlobClient = new line.messagingApi.MessagingApiBlobClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

// ─── Supabase Client ──────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── Webhook (LINE signature verification) ───────────────────────────────────
app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  line.middleware(lineConfig),
  (req, res) => {
    // ตอบ 200 ทันทีก่อน process เพราะ LINE timeout 1 วินาที
    res.status(200).send('OK');

    const events = req.body.events || [];
    events.forEach((event) => handleEvent(event).catch((err) => {
      console.error('[ERROR] handleEvent:', err.message);
    }));
  }
);

// ─── Event Router ─────────────────────────────────────────────────────────────
async function handleEvent(event) {
  if (event.type !== 'message') return;

  const userId = event.source.userId;
  const groupId = event.source.groupId || event.source.roomId || null;
  const replyTarget = groupId || userId;

  if (event.message.type === 'image') {
    await handleImageMessage(event, userId, groupId, replyTarget);
  } else if (event.message.type === 'text') {
    await handleTextMessage(event, userId, groupId, replyTarget);
  }
}

// ─── Image: วิเคราะห์ใบเสร็จ ─────────────────────────────────────────────────
async function handleImageMessage(event, userId, groupId, replyTarget) {
  console.log('[INFO] Image received — userId:', userId);

  // ดึงรูปจาก LINE ผ่าน axios โดยตรง (reliable กว่า SDK wrapper)
  let imageBase64;
  try {
    const response = await axios.get(
      `https://api-data.line.me/v2/bot/message/${event.message.id}/content`,
      {
        headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
        responseType: 'arraybuffer',
        timeout: 10000,
      }
    );
    imageBase64 = Buffer.from(response.data).toString('base64');
    console.log('[INFO] Image downloaded — size:', response.data.byteLength, 'bytes');
  } catch (err) {
    console.error('[ERROR] download image:', err.response?.status, err.message);
    await pushText(replyTarget, 'ไม่สามารถดาวน์โหลดรูปได้ กรุณาลองใหม่');
    return;
  }

  // วิเคราะห์ด้วย Gemini
  let parsed;
  try {
    parsed = await analyzeReceiptWithGemini(imageBase64);
  } catch (err) {
    console.error('[ERROR] Gemini:', err.message);
    await pushText(replyTarget, 'เกิดข้อผิดพลาดในการวิเคราะห์รูป กรุณาลองใหม่');
    return;
  }

  if (parsed.error === 'not_receipt') {
    await pushText(replyTarget, 'ไม่พบข้อมูลการจ่ายเงินในรูปนี้\nกรุณาส่งรูปใบเสร็จ, สลิปโอนเงิน หรือบิลค่าใช้จ่าย');
    return;
  }

  // ดึงชื่อผู้ใช้
  let displayName = 'Unknown';
  try {
    const profile = groupId
      ? await lineClient.getGroupMemberProfile(groupId, userId)
      : await lineClient.getProfile(userId);
    displayName = profile.displayName;
  } catch (err) {
    console.warn('[WARN] getProfile failed:', err.message);
  }

  // บันทึกลง Supabase
  const expenseDate = parsed.date || new Date().toISOString().split('T')[0];
  const { error: dbError } = await supabase.from('expenses').insert({
    line_user_id: userId,
    line_group_id: groupId,
    display_name: displayName,
    shop_name: parsed.shop_name || 'ไม่ระบุ',
    items: parsed.items || [],
    amount: parseFloat(parsed.amount) || 0,
    expense_date: expenseDate,
    raw_text: parsed.raw_text || '',
    created_at: new Date().toISOString(),
  });

  if (dbError) {
    console.error('[ERROR] Supabase insert:', dbError.message);
    await pushText(replyTarget, 'บันทึกข้อมูลไม่สำเร็จ กรุณาลองใหม่');
    return;
  }

  console.log('[INFO] Saved to DB — shop:', parsed.shop_name, 'amount:', parsed.amount);

  // ตอบกลับ
  const itemList = Array.isArray(parsed.items) && parsed.items.length
    ? parsed.items.map((i) => `  • ${i}`).join('\n')
    : '  • (ไม่มีรายการ)';

  const reply =
    `✅ บันทึกค่าใช้จ่ายแล้ว!\n\n` +
    `👤 ${displayName}\n` +
    `🏪 ร้าน: ${parsed.shop_name || 'ไม่ระบุ'}\n` +
    `📋 รายการ:\n${itemList}\n` +
    `💰 ยอดรวม: ${Number(parsed.amount || 0).toLocaleString()} บาท\n` +
    `📅 วันที่: ${expenseDate}`;

  await pushText(replyTarget, reply);
}

// ─── Gemini Vision API ────────────────────────────────────────────────────────
async function analyzeReceiptWithGemini(imageBase64, retryCount = 0) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;

  const prompt =
    'วิเคราะห์รูปนี้ว่าเป็นเอกสารการจ่ายเงินหรือไม่ เช่น ใบเสร็จ, สลิปโอนเงิน, สลิปธนาคาร, QR payment, บิลค่าใช้จ่าย, invoice ทุกประเภท ' +
    'ถ้าใช่ให้ตอบ JSON เท่านั้น (ห้ามมี markdown หรือ ```): ' +
    '{"shop_name":"ชื่อร้านหรือชื่อผู้รับเงิน","items":["รายการ1","รายการ2"],"amount":"ยอดเงินรวม (ตัวเลขเท่านั้น)","date":"YYYY-MM-DD","raw_text":"ข้อความสำคัญในภาพ"} ' +
    'สำหรับสลิปโอนเงิน: shop_name คือชื่อผู้รับ, items คือ ["โอนเงิน"] ' +
    'ถ้ารูปไม่เกี่ยวกับการจ่ายเงินเลย ให้ตอบ {"error":"not_receipt"}';

  try {
    const { data } = await axios.post(url, {
      contents: [
        {
          parts: [
            { inline_data: { mime_type: 'image/jpeg', data: imageBase64 } },
            { text: prompt },
          ],
        },
      ],
    });

    console.log('[INFO] Gemini response received');
    const rawText = data.candidates[0].content.parts[0].text;

    // ล้าง markdown code block ถ้ามี
    const cleaned = rawText
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim();

    return JSON.parse(cleaned);
  } catch (err) {
    // Retry เมื่อ rate limit 429
    if (err.response?.status === 429 && retryCount < 1) {
      console.warn('[WARN] Gemini 429 — retrying in 2s...');
      await sleep(2000);
      return analyzeReceiptWithGemini(imageBase64, retryCount + 1);
    }
    throw err;
  }
}

// ─── Text Commands ────────────────────────────────────────────────────────────
async function handleTextMessage(event, userId, groupId, replyTarget) {
  const text = event.message.text.trim().toLowerCase();

  if (text === '/myexpense') {
    await cmdMyExpense(userId, replyTarget);
  } else if (text === '/summary') {
    await cmdSummary(groupId, userId, replyTarget);
  } else if (text === '/help') {
    await cmdHelp(replyTarget);
  }
}

async function cmdMyExpense(userId, replyTarget) {
  const { year, month } = currentYearMonth();

  const { data, error } = await supabase
    .from('expenses')
    .select('shop_name, amount, expense_date, items')
    .eq('line_user_id', userId)
    .gte('expense_date', `${year}-${month}-01`)
    .lte('expense_date', `${year}-${month}-31`)
    .order('expense_date', { ascending: false });

  if (error) {
    console.error('[ERROR] /myexpense query:', error.message);
    await pushText(replyTarget, 'ดึงข้อมูลไม่สำเร็จ');
    return;
  }

  if (!data || data.length === 0) {
    await pushText(replyTarget, `ยังไม่มีรายการค่าใช้จ่ายของคุณในเดือน ${month}/${year}`);
    return;
  }

  const total = data.reduce((sum, r) => sum + (r.amount || 0), 0);
  const lines = data.map(
    (r) => `📅 ${r.expense_date} | 🏪 ${r.shop_name} | 💰 ${Number(r.amount).toLocaleString()} บาท`
  );

  const msg =
    `📊 ค่าใช้จ่ายของคุณ (${month}/${year})\n\n` +
    lines.join('\n') +
    `\n\n💰 รวม: ${total.toLocaleString()} บาท (${data.length} รายการ)`;

  await pushText(replyTarget, msg);
}

async function cmdSummary(groupId, userId, replyTarget) {
  const { year, month } = currentYearMonth();

  // ถ้าอยู่ใน group ดึงของทั้งกลุ่ม ถ้าไม่ใช่ดึงของ user นั้น
  let query = supabase
    .from('expenses')
    .select('display_name, amount, line_user_id')
    .gte('expense_date', `${year}-${month}-01`)
    .lte('expense_date', `${year}-${month}-31`);

  if (groupId) {
    query = query.eq('line_group_id', groupId);
  } else {
    query = query.eq('line_user_id', userId);
  }

  const { data, error } = await query;

  if (error) {
    console.error('[ERROR] /summary query:', error.message);
    await pushText(replyTarget, 'ดึงข้อมูลไม่สำเร็จ');
    return;
  }

  if (!data || data.length === 0) {
    await pushText(replyTarget, `ยังไม่มีรายการค่าใช้จ่ายของกลุ่มในเดือน ${month}/${year}`);
    return;
  }

  // รวมยอดรายคน
  const summaryMap = {};
  data.forEach((r) => {
    const name = r.display_name || r.line_user_id;
    if (!summaryMap[name]) summaryMap[name] = { total: 0, count: 0 };
    summaryMap[name].total += r.amount || 0;
    summaryMap[name].count += 1;
  });

  const sorted = Object.entries(summaryMap).sort((a, b) => b[1].total - a[1].total);
  const grandTotal = data.reduce((s, r) => s + (r.amount || 0), 0);

  const lines = sorted.map(
    ([name, s], i) =>
      `${i + 1}. ${name}\n   ${s.count} ครั้ง | ${s.total.toLocaleString()} บาท`
  );

  const msg =
    `📊 สรุปค่าใช้จ่ายกลุ่ม (${month}/${year})\n\n` +
    lines.join('\n\n') +
    `\n\n💰 รวมทั้งหมด: ${grandTotal.toLocaleString()} บาท`;

  await pushText(replyTarget, msg);
}

async function cmdHelp(replyTarget) {
  const msg =
    '📌 คำสั่งที่ใช้ได้\n\n' +
    '📷 ส่งรูปใบเสร็จ → บันทึกค่าใช้จ่ายอัตโนมัติ\n\n' +
    '/myexpense → ดูรายการค่าใช้จ่ายของคุณเดือนนี้\n' +
    '/summary → สรุปค่าใช้จ่ายทุกคนในกลุ่มเดือนนี้\n' +
    '/help → แสดงคำสั่งทั้งหมด';
  await pushText(replyTarget, msg);
}

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', version: '851f36b', imageMethod: 'axios-direct', prompt: 'slip-aware' }));

// ─── API Endpoints สำหรับ Dashboard ──────────────────────────────────────────
app.use(express.json());

app.get('/api/expenses', async (req, res) => {
  const { group_id, month, year } = req.query;
  const y = year || new Date().getFullYear();
  const m = month ? String(month).padStart(2, '0') : String(new Date().getMonth() + 1).padStart(2, '0');

  let query = supabase
    .from('expenses')
    .select('*')
    .gte('expense_date', `${y}-${m}-01`)
    .lte('expense_date', `${y}-${m}-31`)
    .order('created_at', { ascending: false });

  if (group_id) query = query.eq('line_group_id', group_id);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/api/summary', async (req, res) => {
  const { group_id } = req.query;
  const { year, month } = currentYearMonth();

  let query = supabase
    .from('expenses')
    .select('display_name, line_user_id, amount')
    .gte('expense_date', `${year}-${month}-01`)
    .lte('expense_date', `${year}-${month}-31`);

  if (group_id) query = query.eq('line_group_id', group_id);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const summaryMap = {};
  data.forEach((r) => {
    const name = r.display_name || r.line_user_id;
    if (!summaryMap[name]) summaryMap[name] = { total: 0, count: 0 };
    summaryMap[name].total += r.amount || 0;
    summaryMap[name].count += 1;
  });

  const result = Object.entries(summaryMap)
    .map(([name, s]) => ({ name, ...s }))
    .sort((a, b) => b.total - a.total);

  res.json(result);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function currentYearMonth() {
  const now = new Date();
  return {
    year: now.getFullYear(),
    month: String(now.getMonth() + 1).padStart(2, '0'),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pushText(to, text) {
  try {
    await lineClient.pushMessage({ to, messages: [{ type: 'text', text }] });
  } catch (err) {
    console.error('[ERROR] pushMessage:', err.message);
  }
}

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[INFO] Server running on port ${PORT}`);
  console.log(`[INFO] Webhook URL: http://localhost:${PORT}/webhook`);
});
