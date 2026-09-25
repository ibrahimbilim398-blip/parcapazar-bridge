// ParçaPazar Bridge — SystemSoft B2B platformlu tedarikçiler (Martaş, Özçete, Özaş,
// Bileşik, Akkaya, Öznur, Ada Oto) 2026-09'da istemci tarafında hesaplanan imzalı
// başlıklar (osm1/osm2/osm3) zorunlu kılmaya başladı; bunlar gerçek tarayıcının kendi
// JS'i tarafından üretiliyor ve PHP/cURL'den taklit edilemiyor. Bu servis gerçek bir
// (headless) Chromium çalıştırıp GERÇEK giriş formunu doldurup gönderiyor — sahte imza
// üretmiyor, gerçek bir istemci gibi davranıyor. ParçaPazar'ın PHP backend'i arama/giriş
// isteklerini buraya yönlendirir, bu servis sonucu JSON olarak döner.

const express = require('express');
const { chromium } = require('playwright');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const BRIDGE_KEY = process.env.BRIDGE_KEY || '';
const SESSION_IDLE_MS = 10 * 60 * 1000; // 10 dakika kullanılmazsa oturum kapatılır
const PENDING_SMS_TTL_MS = 3 * 60 * 1000; // SMS bekleyen oturum en fazla 3 dakika tutulur

const app = express();
app.use(express.json({ limit: '256kb' }));

// --- Basit paylaşılan-anahtar kimlik doğrulaması ------------------------------------
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const key = req.get('X-Bridge-Key') || '';
  if (!BRIDGE_KEY || !crypto.timingSafeEqual(Buffer.from(key.padEnd(64)), Buffer.from(BRIDGE_KEY.padEnd(64)))) {
    return res.status(401).json({ error: 'Yetkisiz.' });
  }
  next();
});

// key -> { browser, context, page, loggedIn, lastUsed }
const sessions = new Map();
// sessionId -> { key, browser, context, page, smsInputHandle, lastUsed }
const pendingSms = new Map();

function sessionKey(supplierCode, customerCode) {
  return `${supplierCode}|${customerCode}`;
}

async function closeSessionEntry(entry) {
  try { await entry.browser.close(); } catch (e) {}
}

setInterval(async () => {
  const now = Date.now();
  for (const [key, entry] of sessions.entries()) {
    if (now - entry.lastUsed > SESSION_IDLE_MS) {
      await closeSessionEntry(entry);
      sessions.delete(key);
    }
  }
  for (const [id, entry] of pendingSms.entries()) {
    if (now - entry.lastUsed > PENDING_SMS_TTL_MS) {
      await closeSessionEntry(entry);
      pendingSms.delete(id);
    }
  }
}, 60 * 1000).unref();

async function newBrowserPage() {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  });
  const page = await context.newPage();
  return { browser, context, page };
}

async function fillByHint(page, hints, value) {
  const inputs = await page.$$('input');
  for (const inp of inputs) {
    const id = (await inp.getAttribute('id')) || '';
    const name = (await inp.getAttribute('name')) || '';
    const ph = (await inp.getAttribute('placeholder')) || '';
    const combined = (id + ' ' + name + ' ' + ph).toLowerCase();
    if (hints.some((h) => combined.includes(h))) {
      await inp.fill(value).catch(() => {});
      return true;
    }
  }
  return false;
}

async function dismissModal(page) {
  for (let i = 0; i < 5; i++) {
    const closeBtn = await page.$(
      '.ant-modal-close, .ant-modal-close-x, button:has-text("×"), .close, [aria-label="Close"]'
    );
    if (!closeBtn) break;
    const visible = await closeBtn.isVisible().catch(() => false);
    if (!visible) break;
    await closeBtn.click({ force: true }).catch(() => {});
    await page.waitForTimeout(500);
  }
  // Kalan overlay varsa Escape ile de dene.
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);
}

function unwrapResult(body, key) {
  try {
    const outer = JSON.parse(body);
    if (!outer || typeof outer[key] !== 'string') return null;
    return JSON.parse(outer[key]);
  } catch (e) {
    return null;
  }
}

/**
 * Giriş formunu doldurup gönderir, Session servis yanıtını dinler.
 * @returns {ok, smsRequired, sessionResult}
 */
async function performLogin(page, baseUrl, customerCode, username, password) {
  const sessionRespPromise = page
    .waitForResponse((r) => /\/Service(\/JsonService\.svc)?\/Session$/.test(new URL(r.url()).pathname), { timeout: 20000 })
    .catch(() => null);

  await page.goto(`${baseUrl}/web/login`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(800);

  await fillByHint(page, ['musteri', 'müşteri', 'customer', 'cari', 'firma', 'cust'], customerCode);
  await fillByHint(page, ['kullanici', 'kullanıcı', 'username', 'user', 'login'], username);
  await fillByHint(page, ['sifre', 'şifre', 'password', 'parola', 'pass'], password);

  const buttons = await page.$$('button');
  let loginBtn = null;
  for (const b of buttons) {
    const t = ((await b.textContent()) || '').trim().toLowerCase();
    if (t.includes('giriş') || t.includes('login')) { loginBtn = b; break; }
  }
  if (!loginBtn) loginBtn = buttons[buttons.length - 1];
  await loginBtn.click().catch(() => {});

  const resp = await sessionRespPromise;
  if (!resp) {
    return { ok: false, smsRequired: false, error: 'Tedarikçi sistemi zamanında yanıt vermedi.' };
  }
  const body = await resp.text().catch(() => '');
  const inner = unwrapResult(body, 'SessionResult');
  const state = inner ? inner.SessionResult : null;

  if (state === 1) {
    await dismissModal(page);
    return { ok: true, smsRequired: false };
  }
  if (state === 10) {
    return { ok: false, smsRequired: true, captchaGuid: inner.CaptchaGuid };
  }
  return { ok: false, smsRequired: false, error: (inner && inner.LoginMessage) || 'Müşteri kodu, kullanıcı adı veya parola hatalı.' };
}

async function findNewInput(page, beforeCount) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const inputs = await page.$$('input');
    if (inputs.length > beforeCount) return inputs[inputs.length - 1];
    await page.waitForTimeout(300);
  }
  return null;
}

function mapProduct(p) {
  const nameParts = [p.Name_PType, p.Name_Cars].filter(Boolean);
  const net = Number(p.NetPriceWoVat ?? p.ListPriceWoVAT ?? 0);
  const netVat = Number(p.NetPriceWVat ?? p.LocalListPriceWVat ?? 0);
  const orig = Number(p.ListPriceWoVAT ?? 0);
  const discountRate = orig > 0 ? Math.round((1 - net / orig) * 100) : 0;
  const warehouses = (p.Availability || []).map((a) => ({ warehouse: String(a.WarehouseID ?? ''), quantity: Number(a.Amount ?? 0) }));
  const totalStock = Number(p.StockAmount ?? warehouses.reduce((s, w) => s + w.quantity, 0));
  const oem = String(p.OemNr ?? '');

  return {
    stockCode: oem !== '' ? oem : '—',
    name: nameParts.join(' ') || '(İsimsiz Ürün)',
    oem,
    alternativeOem: [],
    brand: String(p.Brand ?? ''),
    price: Math.round(net * 100) / 100,
    listPrice: Math.round(orig * 100) / 100,
    priceWithVat: Math.round(netVat * 100) / 100,
    currency: 'TL',
    vatRate: 20,
    discountRate,
    unit: p.UnitType || null,
    inStock: totalStock > 0,
    warehouses,
    totalStock,
  };
}

// --- Uç noktalar ---------------------------------------------------------------------

app.get('/health', (req, res) => res.json({ ok: true, sessions: sessions.size, pendingSms: pendingSms.size }));

app.post('/login', async (req, res) => {
  const { supplierCode, baseUrl, customerCode, username, password } = req.body || {};
  if (!supplierCode || !baseUrl || !customerCode || !username || !password) {
    return res.status(400).json({ error: 'Eksik parametre.' });
  }

  const key = sessionKey(supplierCode, customerCode);
  let entry = sessions.get(key);
  if (entry) { await closeSessionEntry(entry); sessions.delete(key); }

  const { browser, context, page } = await newBrowserPage();
  const beforeInputCount = 3;

  try {
    const result = await performLogin(page, baseUrl, customerCode, username, password);

    if (result.ok) {
      sessions.set(key, { browser, context, page, loggedIn: true, lastUsed: Date.now() });
      return res.json({ success: true });
    }

    if (result.smsRequired) {
      const smsInput = await findNewInput(page, beforeInputCount);
      if (!smsInput) {
        await closeSessionEntry({ browser });
        return res.json({ success: false, error: 'SMS doğrulama kutusu bulunamadı.' });
      }
      const sessionId = crypto.randomUUID();
      pendingSms.set(sessionId, { key, browser, context, page, smsInput, lastUsed: Date.now() });
      return res.json({ success: false, smsRequired: true, sessionId });
    }

    await closeSessionEntry({ browser });
    return res.json({ success: false, error: result.error });
  } catch (e) {
    await closeSessionEntry({ browser });
    return res.status(500).json({ error: 'Sunucu hatası: ' + e.message });
  }
});

app.post('/verify-sms', async (req, res) => {
  const { sessionId, code } = req.body || {};
  const entry = pendingSms.get(sessionId);
  if (!entry) {
    return res.status(404).json({ success: false, error: 'Doğrulama oturumunun süresi dolmuş, lütfen tekrar bağlanmayı deneyin.' });
  }
  pendingSms.delete(sessionId);
  entry.lastUsed = Date.now();

  try {
    const { page } = entry;
    const submitPromise = page
      .waitForResponse((r) => r.url().includes('SubmitCaptchaText'), { timeout: 15000 })
      .catch(() => null);

    await entry.smsInput.fill(code).catch(() => {});
    const buttons = await page.$$('button');
    let confirmBtn = null;
    for (const b of buttons) {
      const t = ((await b.textContent()) || '').trim().toLowerCase();
      if (t.includes('onayla') || t.includes('doğrula') || t.includes('confirm')) { confirmBtn = b; break; }
    }
    if (!confirmBtn) confirmBtn = buttons[buttons.length - 1];
    await confirmBtn.click().catch(() => {});

    const resp = await submitPromise;
    if (!resp) {
      await closeSessionEntry(entry);
      return res.json({ success: false, error: 'Doğrulama zaman aşımına uğradı.' });
    }
    const body = await resp.text().catch(() => '');
    const inner = unwrapResult(body, 'SubmitCaptchaTextResult');

    if (inner && inner.SessionResult === 1) {
      await dismissModal(page);
      sessions.set(entry.key, { browser: entry.browser, context: entry.context, page: entry.page, loggedIn: true, lastUsed: Date.now() });
      return res.json({ success: true });
    }

    await closeSessionEntry(entry);
    return res.json({ success: false, error: (inner && inner.LoginMessage) || 'Kod hatalı veya süresi doldu.' });
  } catch (e) {
    await closeSessionEntry(entry);
    return res.status(500).json({ error: 'Sunucu hatası: ' + e.message });
  }
});

app.post('/search', async (req, res) => {
  const { supplierCode, baseUrl, customerCode, username, password, query } = req.body || {};
  if (!supplierCode || !baseUrl || !customerCode || !username || !password) {
    return res.status(400).json({ error: 'Eksik parametre.' });
  }

  const key = sessionKey(supplierCode, customerCode);
  let entry = sessions.get(key);

  try {
    if (!entry || !entry.loggedIn) {
      const { browser, context, page } = await newBrowserPage();
      const result = await performLogin(page, baseUrl, customerCode, username, password);
      if (!result.ok) {
        await closeSessionEntry({ browser });
        if (result.smsRequired) {
          return res.json({ error: 'Bu firma bağlantısı SMS doğrulaması bekliyor. Firmalarım sayfasından yeniden bağlanın.', products: [] });
        }
        return res.json({ error: result.error, products: [] });
      }
      entry = { browser, context, page, loggedIn: true, lastUsed: Date.now() };
      sessions.set(key, entry);
    }
    entry.lastUsed = Date.now();

    const { page } = entry;
    if (!page.url().includes('/web/')) {
      await page.goto(`${baseUrl}/web/login`, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
    }

    await dismissModal(page);
    const searchInput = await page.$('#searchInput, textarea.productSearch');
    if (!searchInput) {
      sessions.delete(key);
      await closeSessionEntry(entry);
      return res.json({ error: 'Arama kutusu bulunamadı, oturum sıfırlandı — tekrar deneyin.', products: [] });
    }

    const searchRespPromise = page.waitForResponse((r) => r.url().includes('ProductSearch'), { timeout: 15000 }).catch(() => null);
    await searchInput.click();
    await searchInput.fill('');
    await searchInput.fill(query || '');
    await page.keyboard.press('Enter');

    const searchResp = await searchRespPromise;
    if (!searchResp) {
      return res.json({ error: 'Tedarikçi arama isteğine yanıt vermedi.', products: [] });
    }
    const searchBody = await searchResp.text().catch(() => '');
    const searchInner = unwrapResult(searchBody, 'ProductSearchResult');
    const ids = (searchInner && searchInner.RemainingProductIds ? searchInner.RemainingProductIds : []).slice(0, 50);

    if (ids.length === 0) {
      return res.json({ products: [] });
    }

    const detailRespPromise = page.waitForResponse((r) => r.url().includes('RemainingProducts'), { timeout: 15000 }).catch(() => null);
    // Bazı sürümlerde detay isteği aramadan hemen sonra otomatik tetikleniyor; tetiklenmediyse
    // sayfanın kendi mekanizmasını beklemek yerine olumsuz sonuç dönmek daha güvenli.
    const detailResp = await detailRespPromise;
    if (!detailResp) {
      return res.json({ products: [] });
    }
    const detailBody = await detailResp.text().catch(() => '');
    const detailInner = unwrapResult(detailBody, 'RemainingProductsResult');
    const rows = (detailInner && detailInner.ResultDetailed) || [];

    return res.json({ products: rows.map(mapProduct) });
  } catch (e) {
    return res.status(500).json({ error: 'Sunucu hatası: ' + e.message, products: [] });
  }
});

app.listen(PORT, () => {
  console.log(`parcapazar-bridge listening on :${PORT}`);
});
