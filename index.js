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

// ─── Supabase Client ──────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── In-memory stores ────────────────────────────────────────────────────────
// pendingExpenses: รอ user เลือก project
// Key: line_user_id → { expense, replyTarget, displayName, parsed }
const pendingExpenses = new Map();

// pendingNewProject: รอ user พิมพ์ชื่อ project ใหม่
// Key: line_user_id → { expense, replyTarget, displayName, parsed }
const pendingNewProject = new Map();

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

  // ดึงรูปจาก LINE ผ่าน axios โดยตรง
  let imageBuffer;
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
    imageBuffer = Buffer.from(response.data);
    imageBase64 = imageBuffer.toString('base64');
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

  // อัปโหลดรูปไป Supabase Storage
  const imageUrl = await uploadReceiptImage(imageBuffer, userId);

  const expenseDate = parsed.date || new Date().toISOString().split('T')[0];
  const expenseData = {
    line_user_id: userId,
    line_group_id: groupId,
    display_name: displayName,
    shop_name: parsed.shop_name || 'ไม่ระบุ',
    items: parsed.items || [],
    amount: parseFloat(parsed.amount) || 0,
    expense_date: expenseDate,
    raw_text: parsed.raw_text || '',
    image_url: imageUrl,
    created_at: new Date().toISOString(),
  };

  // ดึง projects จาก DB เพื่อทำ Quick Reply
  const { data: projects, error: projectsError } = await supabase
    .from('projects')
    .select('id, name')
    .order('name', { ascending: true });

  if (projectsError) {
    console.error('[ERROR] fetch projects:', projectsError.message);
  }

  // ถ้าไม่มี project เลย ให้บันทึกทันที โดยไม่ต้องถาม
  if (!projects || projects.length === 0) {
    await saveExpense({ ...expenseData, project_id: null }, replyTarget, displayName, parsed);
    await pushText(replyTarget, '💡 ยังไม่มี Project ในระบบ สามารถสร้างได้ด้วยคำสั่ง /addproject ชื่อProject');
    return;
  }

  // เก็บ pending expense ไว้รอ user เลือก project
  // ถ้า user ส่งรูปใหม่ก่อนเลือก project จะ overwrite entry เดิม
  pendingExpenses.set(userId, {
    expense: expenseData,
    replyTarget,
    groupId,
    displayName,
    parsed,
  });

  // สร้าง Quick Reply buttons (LINE รองรับสูงสุด 13 items)
  // เผื่อ 2 slots: "➕ สร้าง Project ใหม่" + "ไม่ระบุ Project"
  const maxProjectButtons = 11;
  const projectButtons = projects.slice(0, maxProjectButtons).map((p) => ({
    type: 'action',
    action: {
      type: 'message',
      label: `📁 ${p.name}`.substring(0, 20),
      text: `📁 ${p.name}`,
    },
  }));

  projectButtons.push({
    type: 'action',
    action: {
      type: 'message',
      label: '➕ สร้าง Project ใหม่',
      text: '➕ สร้าง Project ใหม่',
    },
  });

  projectButtons.push({
    type: 'action',
    action: {
      type: 'message',
      label: 'ไม่ระบุ Project',
      text: 'ไม่ระบุ Project',
    },
  });

  const itemList = Array.isArray(parsed.items) && parsed.items.length
    ? parsed.items.map((i) => `  • ${i}`).join('\n')
    : '  • (ไม่มีรายการ)';

  const previewMsg =
    `🧾 วิเคราะห์ใบเสร็จแล้ว\n\n` +
    `🏪 ร้าน: ${parsed.shop_name || 'ไม่ระบุ'}\n` +
    `📋 รายการ:\n${itemList}\n` +
    `💰 ยอดรวม: ${Number(parsed.amount || 0).toLocaleString()} บาท\n` +
    `📅 วันที่: ${expenseDate}\n\n` +
    `ค่าใช้จ่ายนี้เป็นของ Project ไหน?`;

  try {
    await lineClient.pushMessage({
      to: replyTarget,
      messages: [
        {
          type: 'text',
          text: previewMsg,
          quickReply: {
            items: projectButtons,
          },
        },
      ],
    });
  } catch (err) {
    console.error('[ERROR] pushMessage with quickReply:', err.message);
    // Fallback: บันทึกโดยไม่มี project
    pendingExpenses.delete(userId);
    await saveExpense({ ...expenseData, project_id: null }, replyTarget, displayName, parsed);
  }
}

// ─── Upload receipt image to Supabase Storage ────────────────────────────────
async function uploadReceiptImage(imageBuffer, userId) {
  const filename = `${userId}_${Date.now()}.jpg`;
  const uploadUrl = `${process.env.SUPABASE_URL}/storage/v1/object/receipts/${filename}`;

  try {
    await axios.post(uploadUrl, imageBuffer, {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'image/jpeg',
        'x-upsert': 'true',
      },
      timeout: 15000,
    });

    const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/receipts/${filename}`;
    console.log('[INFO] Image uploaded to Storage:', publicUrl);
    return publicUrl;
  } catch (err) {
    // การ upload รูปล้มเหลวไม่ควรหยุด flow หลัก
    console.error('[ERROR] Storage upload:', err.response?.status, err.response?.data || err.message);
    return null;
  }
}

// ─── Save expense to Supabase and send confirmation ──────────────────────────
async function saveExpense(expenseData, replyTarget, displayName, parsed) {
  // ดึง _projectName ออกก่อน insert (ไม่มีคอลัมน์นี้ใน DB)
  const { _projectName, ...dbData } = expenseData;
  const { error: dbError } = await supabase.from('expenses').insert(dbData);

  if (dbError) {
    console.error('[ERROR] Supabase insert:', dbError.message);
    await pushText(replyTarget, 'บันทึกข้อมูลไม่สำเร็จ กรุณาลองใหม่');
    return;
  }

  console.log('[INFO] Saved to DB — shop:', expenseData.shop_name, 'amount:', expenseData.amount);

  const itemList = Array.isArray(parsed.items) && parsed.items.length
    ? parsed.items.map((i) => `  • ${i}`).join('\n')
    : '  • (ไม่มีรายการ)';

  const projectLabel = expenseData.project_id ? '' : '';

  const reply =
    `✅ บันทึกค่าใช้จ่ายแล้ว!\n\n` +
    `👤 ${displayName}\n` +
    `🏪 ร้าน: ${expenseData.shop_name || 'ไม่ระบุ'}\n` +
    `📋 รายการ:\n${itemList}\n` +
    `💰 ยอดรวม: ${Number(expenseData.amount || 0).toLocaleString()} บาท\n` +
    `📅 วันที่: ${expenseData.expense_date}` +
    (expenseData._projectName ? `\n📁 Project: ${expenseData._projectName}` : '');

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

    const cleaned = rawText
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim();

    return JSON.parse(cleaned);
  } catch (err) {
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
  const rawText = event.message.text.trim();
  const text = rawText.toLowerCase();

  // 1) รอ user พิมพ์ชื่อ project ใหม่ (กด "➕ สร้าง Project ใหม่" ไปแล้ว)
  if (pendingNewProject.has(userId)) {
    await handleNewProjectName(userId, rawText, replyTarget);
    return;
  }

  // 2) user กด "➕ สร้าง Project ใหม่" จาก Quick Reply
  if (rawText === '➕ สร้าง Project ใหม่') {
    const pending = pendingExpenses.get(userId);
    if (pending) {
      pendingNewProject.set(userId, pending);
      pendingExpenses.delete(userId);
      await pushText(replyTarget, '📝 พิมพ์ชื่อ Project ที่ต้องการสร้าง:');
    }
    return;
  }

  // 3) user เลือก project จาก Quick Reply
  if (rawText === 'ไม่ระบุ Project' || rawText.startsWith('📁 ')) {
    await handleProjectSelection(userId, rawText);
    return;
  }

  if (text === '/myexpense') {
    await cmdMyExpense(userId, replyTarget);
  } else if (text === '/summary') {
    await cmdSummary(groupId, userId, replyTarget);
  } else if (text === '/help') {
    await cmdHelp(replyTarget);
  } else if (text === '/projects') {
    await cmdListProjects(replyTarget);
  } else if (text.startsWith('/addproject ')) {
    const projectName = rawText.substring('/addproject '.length).trim();
    await cmdAddProject(projectName, replyTarget);
  }
}

// ─── Project selection handler ────────────────────────────────────────────────
async function handleProjectSelection(userId, text) {
  const pending = pendingExpenses.get(userId);
  if (!pending) {
    // ไม่มี pending expense — ไม่ต้องตอบอะไร (อาจเป็น message อื่นที่ขึ้นต้นด้วย 📁)
    return;
  }

  const { expense, replyTarget, displayName, parsed } = pending;
  pendingExpenses.delete(userId);

  let projectId = null;
  let projectName = null;

  if (text !== 'ไม่ระบุ Project') {
    // ตัด prefix "📁 " ออกเพื่อหา project name
    const selectedName = text.replace(/^📁\s*/, '').trim();

    const { data: project, error } = await supabase
      .from('projects')
      .select('id, name')
      .eq('name', selectedName)
      .single();

    if (error || !project) {
      console.error('[ERROR] find project by name:', error?.message);
      await pushText(replyTarget, `ไม่พบ Project "${selectedName}" กรุณาลองใหม่`);
      return;
    }

    projectId = project.id;
    projectName = project.name;
  }

  await saveExpense(
    { ...expense, project_id: projectId, _projectName: projectName },
    replyTarget,
    displayName,
    parsed
  );
}

// ─── New project name handler (after user typed name) ────────────────────────
async function handleNewProjectName(userId, projectName, replyTarget) {
  const pending = pendingNewProject.get(userId);
  pendingNewProject.delete(userId);

  if (!pending) return;

  const { expense, displayName, parsed } = pending;

  // สร้าง project ใหม่
  const { data: newProject, error: createError } = await supabase
    .from('projects')
    .insert({ name: projectName, color: '#06c755' })
    .select('id, name')
    .single();

  if (createError) {
    console.error('[ERROR] create project:', createError.message);
    // ถ้า duplicate name
    if (createError.code === '23505') {
      await pushText(replyTarget, `⚠️ Project "${projectName}" มีอยู่แล้ว\nกำลังบันทึกค่าใช้จ่ายภายใต้ Project นี้...`);
      // หา project ที่มีอยู่แล้ว
      const { data: existing } = await supabase
        .from('projects').select('id, name').eq('name', projectName).single();
      if (existing) {
        await saveExpense({ ...expense, project_id: existing.id, _projectName: existing.name }, replyTarget, displayName, parsed);
        return;
      }
    }
    await pushText(replyTarget, 'สร้าง Project ไม่สำเร็จ กรุณาลองใหม่');
    return;
  }

  console.log('[INFO] Created project:', newProject.name);
  await saveExpense(
    { ...expense, project_id: newProject.id, _projectName: newProject.name },
    replyTarget,
    displayName,
    parsed
  );
}

// ─── /projects command ────────────────────────────────────────────────────────
async function cmdListProjects(replyTarget) {
  const { data, error } = await supabase
    .from('projects')
    .select('id, name, description')
    .order('name', { ascending: true });

  if (error) {
    console.error('[ERROR] /projects query:', error.message);
    await pushText(replyTarget, 'ดึงข้อมูล Project ไม่สำเร็จ');
    return;
  }

  if (!data || data.length === 0) {
    await pushText(replyTarget, 'ยังไม่มี Project\nสร้างด้วยคำสั่ง: /addproject ชื่อProject');
    return;
  }

  const lines = data.map((p) => `📁 ${p.name}${p.description ? ` — ${p.description}` : ''}`);
  await pushText(replyTarget, `📋 รายการ Projects (${data.length} project)\n\n${lines.join('\n')}`);
}

// ─── /addproject command ──────────────────────────────────────────────────────
async function cmdAddProject(name, replyTarget) {
  if (!name) {
    await pushText(replyTarget, 'กรุณาระบุชื่อ Project เช่น /addproject การตลาด');
    return;
  }

  const { error } = await supabase.from('projects').insert({ name });

  if (error) {
    console.error('[ERROR] /addproject insert:', error.message);
    // unique constraint violation
    if (error.code === '23505') {
      await pushText(replyTarget, `Project "${name}" มีอยู่แล้วในระบบ`);
    } else {
      await pushText(replyTarget, `สร้าง Project ไม่สำเร็จ: ${error.message}`);
    }
    return;
  }

  console.log('[INFO] Project created:', name);
  await pushText(replyTarget, `✅ สร้าง Project "${name}" สำเร็จแล้ว!`);
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
    '/projects → ดูรายการ Projects ทั้งหมด\n' +
    '/addproject ชื่อ → สร้าง Project ใหม่\n' +
    '/help → แสดงคำสั่งทั้งหมด';
  await pushText(replyTarget, msg);
}

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) =>
  res.json({ status: 'ok', version: '2.0.1', fix: 'project-save-field-strip' })
);

// ─── API Endpoints ────────────────────────────────────────────────────────────
app.use(express.json());

// GET /api/expenses — list expenses with optional filters
app.get('/api/expenses', async (req, res) => {
  const { group_id, month, year, project_id } = req.query;
  const y = year || new Date().getFullYear();
  const m = month ? String(month).padStart(2, '0') : String(new Date().getMonth() + 1).padStart(2, '0');

  let query = supabase
    .from('expenses')
    .select('*')
    .gte('expense_date', `${y}-${m}-01`)
    .lte('expense_date', `${y}-${m}-31`)
    .order('created_at', { ascending: false });

  if (group_id) query = query.eq('line_group_id', group_id);
  if (project_id) query = query.eq('project_id', project_id);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/expenses/:id — get single expense
app.get('/api/expenses/:id', async (req, res) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from('expenses')
    .select('*')
    .eq('id', id)
    .single();

  if (error) return res.status(404).json({ error: error.message });
  res.json(data);
});

// PUT /api/expenses/:id — update expense
app.put('/api/expenses/:id', async (req, res) => {
  const { id } = req.params;
  const { shop_name, amount, expense_date, project_id, items } = req.body;

  const updates = {};
  if (shop_name !== undefined) updates.shop_name = shop_name;
  if (amount !== undefined) updates.amount = parseFloat(amount);
  if (expense_date !== undefined) updates.expense_date = expense_date;
  // Allow explicitly setting project_id to null (ไม่ระบุ project)
  if (project_id !== undefined) updates.project_id = project_id || null;
  if (items !== undefined) {
    // Accept both array and comma-separated string
    updates.items = Array.isArray(items)
      ? items
      : String(items).split(',').map((s) => s.trim()).filter(Boolean);
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  const { data, error } = await supabase
    .from('expenses')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /api/expenses/:id — delete expense
app.delete('/api/expenses/:id', async (req, res) => {
  const { id } = req.params;

  const { error } = await supabase.from('expenses').delete().eq('id', id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// GET /api/projects — list all projects
app.get('/api/projects', async (req, res) => {
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .order('name', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/projects — create project
app.post('/api/projects', async (req, res) => {
  const { name, description, color } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Project name is required' });
  }

  const { data, error } = await supabase
    .from('projects')
    .insert({ name: name.trim(), description: description || null, color: color || '#06c755' })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: `Project "${name}" already exists` });
    }
    return res.status(500).json({ error: error.message });
  }

  res.status(201).json(data);
});

// GET /api/summary — per-person summary for current month
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
