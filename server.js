const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json({ limit: '10kb' }));

// เว็บที่อนุญาตให้เรียกเซิร์ฟเวอร์นี้ (แก้/เพิ่มได้)
const ALLOWED_ORIGINS = [
  'https://suphasan887-beep.github.io',
  'https://nongchang887-prog.github.io'
];
app.use(cors({
  origin: function (origin, cb) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('origin not allowed'));
  }
}));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// กันกดรัว: 1 ผู้ใช้ รับซองได้ไม่เกิน 5 ครั้ง/นาที
const hits = new Map();
function tooMany(uid) {
  const now = Date.now();
  const list = (hits.get(uid) || []).filter(function (t) { return now - t < 60000; });
  list.push(now);
  hits.set(uid, list);
  return list.length > 5;
}

async function getUser(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  return error || !data ? null : data.user;
}

app.get('/', function (req, res) { res.send('truemoney server ok'); });

// ===== รับซอง TrueMoney แล้วบวกแต้มเงิน =====
app.post('/api/redeem-truemoney', async function (req, res) {
  try {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบใหม่' });
    if (tooMany(user.id)) return res.status(429).json({ error: 'ลองบ่อยเกินไป รอ 1 นาทีแล้วลองใหม่' });

    const link = String((req.body && req.body.link) || '').trim();
    const m = link.match(/^https:\/\/gift\.truemoney\.com\/campaign\/\?v=([0-9A-Za-z]{10,64})$/);
    if (!m) return res.status(400).json({ error: 'ลิงก์ซองไม่ถูกต้อง' });
    const code = m[1];

    // จองรหัสซองก่อน (ซ้ำ = insert พัง = ใช้แล้ว)
    const ins = await supabase.from('tw_vouchers')
      .insert({ voucher_code: code, user_id: user.id, amount: 0 });
    if (ins.error) return res.status(400).json({ error: 'ซองนี้ถูกใช้แล้ว' });

    const r = await fetch('https://gift.truemoney.com/campaign/vouchers/' + code + '/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      body: JSON.stringify({ mobile: process.env.TW_PHONE, voucher_hash: code })
    });
    const raw = await r.text();
let j = {};
try { j = JSON.parse(raw); } catch (e) {}
console.log('TW http', r.status, raw.slice(0, 500));

    if (!j.status || j.status.code !== 'SUCCESS') {
      await supabase.from('tw_vouchers').delete().eq('voucher_code', code); // คืนสิทธิ์ให้ลองใหม่
      const c = j.status && j.status.code;
      const msg = c === 'VOUCHER_OUT_OF_STOCK' ? 'ซองนี้ถูกรับไปแล้ว'
                : c === 'VOUCHER_EXPIRED' ? 'ซองหมดอายุแล้ว'
                : c === 'VOUCHER_NOT_FOUND' ? 'ไม่พบซองนี้'
                : 'รับซองไม่สำเร็จ';
      console.log('redeem fail', code, JSON.stringify(j).slice(0, 300));
      return res.status(400).json({ error: msg });
    }

    // อ่านยอดจริงจากผลลัพธ์ ไม่เชื่อค่าจากหน้าเว็บ
        console.log('redeem ok response:', JSON.stringify(j).slice(0, 800));
    const amount = parseFloat(j.data && j.data.my_ticket && j.data.my_ticket.amount_baht);
    if (!amount || amount <= 0) {
      return res.status(500).json({ error: 'อ่านยอดเงินไม่ได้ กรุณาติดต่อแอดมิน (ซอง ' + code + ')' });
    }

    await supabase.from('tw_vouchers').update({ amount: amount }).eq('voucher_code', code);
    const add = await supabase.rpc('add_money', { p_user: user.id, p_amount: amount });
    if (add.error) {
      return res.status(500).json({ error: 'บวกแต้มไม่สำเร็จ กรุณาติดต่อแอดมิน (ซอง ' + code + ')' });
    }

    res.json({ message: 'เติมเงินสำเร็จ +' + amount + ' แต้ม ✅', amount: amount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'เซิร์ฟเวอร์ผิดพลาด' });
  }
});

// ===== ดูยอดเงินของตัวเอง =====
app.get('/api/my-money', async function (req, res) {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบใหม่' });
  const p = await supabase.from('profiles').select('money_balance').eq('id', user.id).single();
  res.json({ money_balance: p.data ? p.data.money_balance : 0 });
});

app.listen(process.env.PORT || 3000, function () {
  console.log('truemoney server running');
});
