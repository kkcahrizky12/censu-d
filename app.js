"use strict";

/*
  Censu'D POS — aplikasi kasir & katalog cendol.
  Semua data disimpan di localStorage browser (tanpa server).
  Catatan: hash PIN di sini hanya menyamarkan PIN di perangkat,
  bukan pengganti autentikasi di server untuk penggunaan multi-perangkat.
*/

const DB_KEY = "censud_pos_v2";
const SESSION_KEY = "censud_session_v2";
const WA_NUMBER = "6281234567890"; // Ganti dengan nomor WhatsApp Censu'D sebelum dipakai.

const ROLE_LABEL = { admin: "Admin", kasir: "Kasir", guest: "Tamu" };
const ROLE_DESC = { admin: "Kelola menu, akun, dan laporan", kasir: "Transaksi & struk", guest: "Lihat menu" };
const DEFAULT_TAB = { admin: "ringkasan", kasir: "kasir" };
const METHOD_LABEL = { tunai: "Tunai", qris: "QRIS", transfer: "Transfer" };
const RASA_COLORS = { original: "#2f8b3d", "gula aren": "#8a5a24", coklat: "#5b3a26" };

const SEED_PRODUCTS = [
  {
    id: "menu-original",
    nama: "Cendol Original",
    rasa: "Original",
    harga: 6000,
    stok: 60,
    aktif: true,
    warna: "#2f8b3d",
    deskripsi: "Cendol pandan, santan, dan gula jawa — rasa klasik yang menyegarkan."
  },
  {
    id: "menu-gula-aren",
    nama: "Cendol Gula Aren",
    rasa: "Gula Aren",
    harga: 6000,
    stok: 45,
    aktif: true,
    warna: "#8a5a24",
    deskripsi: "Manis legit gula aren berpadu santan gurih dan cendol kenyal."
  },
  {
    id: "menu-coklat",
    nama: "Cendol Coklat",
    rasa: "Coklat",
    harga: 6000,
    stok: 40,
    aktif: true,
    warna: "#5b3a26",
    deskripsi: "Cendol susu dengan siraman coklat lembut, favorit semua umur."
  }
];

const SEED_USERS = [
  { nama: "Admin Censu'D", username: "admin", pin: "admin123", role: "admin" },
  { nama: "Kasir Censu'D", username: "kasir", pin: "kasir123", role: "kasir" }
];

let db;
let session = null;
let cart = [];

const state = {
  loginRole: "kasir",
  tab: { admin: "ringkasan", kasir: "kasir" },
  posQuery: "",
  payMethod: "tunai",
  cash: "",
  adminTxDate: todayKey(),
  editingProduct: null,
  editingUser: null
};

/* ---------- util ---------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ESC_MAP[ch]);

const rp = (value) => "Rp " + Number(value || 0).toLocaleString("id-ID");

function uid(prefix) {
  return prefix + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function todayKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
}

function dayKey(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : todayKey(date);
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
}

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
}

function fmtDateTime(iso) {
  return fmtDate(iso) + " · " + fmtTime(iso);
}

function formatDateKey(key) {
  const date = new Date(key + "T00:00:00");
  if (Number.isNaN(date.getTime())) return key;
  return date.toLocaleDateString("id-ID", { day: "2-digit", month: "long", year: "numeric" });
}

function randSalt() {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

function hashPin(pin, salt) {
  const text = salt + "::" + String(pin);
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 16777619) >>> 0;
    b = Math.imul(b + code, 2654435761) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch (err) {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (err) {
    return false;
  }
}

let toastTimer;
function notify(message) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 2800);
}

/* ---------- database ---------- */

function makeUser(nama, username, pin, role) {
  const salt = randSalt();
  return {
    id: uid("user"),
    nama: nama,
    username: username.toLowerCase(),
    role: role,
    salt: salt,
    pinHash: hashPin(pin, salt),
    createdAt: new Date().toISOString()
  };
}

function seedDB() {
  return {
    version: 2,
    createdAt: new Date().toISOString(),
    users: SEED_USERS.map((u) => makeUser(u.nama, u.username, u.pin, u.role)),
    products: SEED_PRODUCTS.map((p) => Object.assign({}, p)),
    transactions: []
  };
}

function initDB() {
  const raw = readStorage(DB_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.users) && Array.isArray(parsed.products) && Array.isArray(parsed.transactions)) {
        db = parsed;
        return;
      }
    } catch (err) {
      /* data rusak, buat ulang */
    }
  }
  db = seedDB();
  persist();
}

function persist() {
  if (!writeStorage(DB_KEY, JSON.stringify(db))) {
    notify("Penyimpanan browser tidak tersedia. Perubahan tidak tersimpan.");
  }
}

/* ---------- sesi ---------- */

function loadSession() {
  const raw = readStorage(SESSION_KEY);
  if (!raw) return null;
  try {
    const saved = JSON.parse(raw);
    if (saved && saved.role === "guest") {
      return { role: "guest", username: "guest", nama: "Tamu" };
    }
    if (!saved || !saved.userId) return null;
    const user = db.users.find((u) => u.id === saved.userId);
    if (!user) return null;
    return { role: user.role, username: user.username, nama: user.nama, userId: user.id };
  } catch (err) {
    return null;
  }
}

function saveSession() {
  if (!session) {
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch (err) {
      /* abaikan */
    }
    return;
  }
  const payload = session.role === "guest" ? { role: "guest" } : { userId: session.userId };
  writeStorage(SESSION_KEY, JSON.stringify(payload));
}

/* ---------- modal ---------- */

function openModal(html) {
  const modal = $("#modal");
  $("#modalCard").innerHTML = html;
  modal.classList.remove("hidden");
  document.body.classList.add("modal-open");
}

function hideModal() {
  const modal = $("#modal");
  if (!modal) return;
  modal.classList.add("hidden");
  $("#modalCard").innerHTML = "";
  document.body.classList.remove("modal-open");
}

/* ---------- render shell ---------- */

function renderApp() {
  const loginEl = $("#loginScreen");
  const appEl = $("#app");

  if (!session) {
    loginEl.classList.remove("hidden");
    appEl.classList.add("hidden");
    document.body.removeAttribute("data-role");
    $$("#rolePicker .role-card").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.role === state.loginRole);
    });
    return;
  }

  loginEl.classList.add("hidden");
  appEl.classList.remove("hidden");
  document.body.dataset.role = session.role;
  renderHeader();
  renderView();
}

function renderHeader() {
  const role = session.role;
  const nav = $("#mainNav");

  if (role === "guest") {
    nav.innerHTML = `<a class="nav-link" href="#guest-menu">Menu</a><a class="nav-link" href="#guest-kontak">Kontak</a>`;
  } else {
    const tabs = role === "kasir"
      ? [["kasir", "Kasir"], ["riwayat", "Riwayat"]]
      : [["ringkasan", "Ringkasan"], ["menu", "Menu"], ["transaksi", "Transaksi"], ["akun", "Akun"]];
    nav.innerHTML = tabs.map(([id, label]) => (
      `<button type="button" class="nav-link ${state.tab[role] === id ? "active" : ""}" data-action="tab" data-tab="${id}">${label}</button>`
    )).join("");
  }

  const initial = (session.nama || "?").trim().charAt(0).toUpperCase();
  $("#userChip").innerHTML = `
    <span class="avatar" aria-hidden="true">${esc(initial)}</span>
    <span class="user-meta"><strong>${esc(session.nama)}</strong><small>${ROLE_LABEL[role]}</small></span>
    <button type="button" class="btn btn-sm" data-action="logout">${role === "guest" ? "Masuk" : "Keluar"}</button>`;
}

function renderView() {
  const root = $("#viewRoot");

  if (session.role === "guest") {
    root.innerHTML = guestView();
    return;
  }

  if (session.role === "kasir") {
    root.innerHTML = state.tab.kasir === "riwayat" ? riwayatView() : kasirView();
    if (state.tab.kasir === "kasir") {
      renderPosMenu();
      renderCart();
    }
    return;
  }

  const tab = state.tab.admin;
  if (tab === "menu") root.innerHTML = adminMenuView();
  else if (tab === "transaksi") root.innerHTML = adminTxView();
  else if (tab === "akun") root.innerHTML = adminAkunView();
  else root.innerHTML = adminHomeView();
}

/* ---------- guest ---------- */

function productCard(p) {
  const habis = p.stok <= 0;
  const warna = esc(p.warna || RASA_COLORS[String(p.rasa).toLowerCase()] || "#2f8b3d");
  return `
  <article class="product-card">
    <div class="product-visual">
      <span class="product-tag">${esc(p.rasa)}</span>
      <span class="cup" style="--cup:${warna}"><span aria-hidden="true">🥤</span></span>
    </div>
    <div class="product-body">
      <h3>${esc(p.nama)}</h3>
      <p>${esc(p.deskripsi || "Cendol rumahan yang segar dan manis.")}</p>
      <div class="product-meta">
        <span class="price">${rp(p.harga)}</span>
        <span class="badge ${habis ? "badge-danger" : "badge-ok"}">${habis ? "Stok habis" : "Tersedia"}</span>
      </div>
      <button type="button" class="btn btn-primary btn-block" data-action="guest-order" data-id="${p.id}" ${habis ? "disabled" : ""}>
        ${habis ? "Stok habis" : "Pesan via WhatsApp"}
      </button>
    </div>
  </article>`;
}

function guestView() {
  const menu = db.products.filter((p) => p.aktif);
  const waLink = "https://wa.me/" + WA_NUMBER + "?text=" + encodeURIComponent("Halo Censu'D, saya ingin bertanya tentang menu cendol.");

  return `
  <section class="guest-hero">
    <div class="hero-art">
      <div class="hero-fallback" aria-hidden="true"><div class="glass"><span>🥤</span></div></div>
      <img class="hero-person" src="hero-cendol.png" alt="Perempuan menikmati cendol susu Censu'D"
           onerror="if (this.dataset.tried) { this.remove(); } else { this.dataset.tried = '1'; this.src = 'hero-cendol.jpg'; }">
      <div class="price-sticker">mulai dari<b>Rp 6K</b></div>
    </div>
    <div class="hero-copy">
      <p class="eyebrow">Segar · Manis · Rumahan</p>
      <h1>ES CENDOL<br>SUSU</h1>
      <p>Nikmati kesegaran cendol dawet dengan tiga rasa favorit: Original, Gula Aren, dan Coklat. Semuanya Rp 6.000 per gelas.</p>
      <div class="guest-actions">
        <a class="btn btn-primary" href="#guest-menu">Lihat menu</a>
        <a class="btn btn-outline" href="${waLink}" target="_blank" rel="noopener noreferrer">Hubungi kami</a>
      </div>
    </div>
  </section>

  <section class="guest-section" id="guest-menu">
    <div class="section-head">
      <h2>Menu Censu'D</h2>
      <p>Semua menu dibuat segar setiap hari. Pesan langsung melalui WhatsApp untuk ambil di tempat atau pesan antar.</p>
    </div>
    <div class="product-grid">
      ${menu.length ? menu.map(productCard).join("") : `<p class="empty-state">Belum ada menu yang ditampilkan.</p>`}
    </div>
  </section>

  <section class="guest-band" id="guest-kontak">
    <div>
      <h2>Ada rasa yang ingin kamu coba?</h2>
      <p>Buka setiap hari mulai pukul 10.00. Hubungi kami lewat WhatsApp untuk pesanan dalam jumlah banyak atau pertanyaan lainnya.</p>
    </div>
    <a class="btn btn-primary" href="${waLink}" target="_blank" rel="noopener noreferrer">Chat WhatsApp</a>
  </section>

  <footer class="guest-footer">
    <div><strong>CENSU'D</strong>Cendol rumahan · Rp 6.000 per gelas</div>
    <small>Menu dan harga dapat berubah sewaktu-waktu.</small>
  </footer>`;
}

function orderGuest(id) {
  const product = db.products.find((p) => p.id === id);
  if (!product) return;
  const message = "Halo Censu'D, saya ingin memesan " + product.nama + " (" + product.rasa + ") seharga " + rp(product.harga) + ". Apakah masih tersedia?";
  window.open("https://wa.me/" + WA_NUMBER + "?text=" + encodeURIComponent(message), "_blank", "noopener,noreferrer");
}

/* ---------- kasir ---------- */

function summarize(list) {
  return {
    count: list.length,
    omzet: list.reduce((sum, tx) => sum + tx.total, 0),
    items: list.reduce((sum, tx) => sum + tx.items.reduce((qty, item) => qty + item.qty, 0), 0)
  };
}

function kasirView() {
  const todayTx = db.transactions.filter((tx) => dayKey(tx.waktu) === todayKey());
  const summary = summarize(todayTx);
  const active = db.products.filter((p) => p.aktif).length;

  return `
  <div class="page-head">
    <div>
      <p class="eyebrow">Kasir</p>
      <h1>Transaksi baru</h1>
      <p>Ketuk menu untuk menambah pesanan, lalu proses pembayaran.</p>
    </div>
    <div class="head-actions">
      <div class="today-chip">Hari ini <strong>${summary.count} transaksi</strong> · ${rp(summary.omzet)}</div>
      <button type="button" class="btn btn-outline btn-sm" data-action="tab" data-tab="riwayat">Riwayat</button>
    </div>
  </div>
  <div class="pos-grid">
    <section class="panel">
      <div class="panel-head"><h2>Menu minuman</h2><span class="muted">${active} menu aktif</span></div>
      <div class="search-box">
        <input id="posSearch" type="search" placeholder="Cari menu atau rasa..." aria-label="Cari menu" value="${esc(state.posQuery)}">
      </div>
      <div class="menu-grid" id="menuGrid"></div>
    </section>
    <aside class="panel cart-panel" id="cartPanel"></aside>
  </div>`;
}

function renderPosMenu() {
  const grid = $("#menuGrid");
  if (!grid) return;
  const query = state.posQuery.trim().toLowerCase();
  const list = db.products.filter((p) => p.aktif && (!query || (p.nama + " " + p.rasa).toLowerCase().includes(query)));

  grid.innerHTML = list.length
    ? list.map((p) => {
        const habis = p.stok <= 0;
        const warna = esc(p.warna || RASA_COLORS[String(p.rasa).toLowerCase()] || "#2f8b3d");
        return `
        <button type="button" class="menu-card ${habis ? "is-empty" : ""}" data-action="add" data-id="${p.id}" style="--cup:${warna}" ${habis ? "disabled" : ""}>
          <span class="menu-cup"><span aria-hidden="true">🥤</span></span>
          <span class="menu-name">${esc(p.nama)}</span>
          <span class="menu-rasa">${esc(p.rasa)}</span>
          <span class="menu-price">${rp(p.harga)}</span>
          <span class="menu-stock">${habis ? "Stok habis" : "Stok " + p.stok}</span>
        </button>`;
      }).join("")
    : `<p class="empty-state">Menu tidak ditemukan.</p>`;
}

function cartLines() {
  return cart
    .map((line) => {
      const product = db.products.find((p) => p.id === line.id);
      return product ? { qty: line.qty, p: product } : null;
    })
    .filter(Boolean);
}

function cartTotal() {
  return cartLines().reduce((sum, line) => sum + line.p.harga * line.qty, 0);
}

function renderCart() {
  const panel = $("#cartPanel");
  if (!panel) return;

  cart = cart.filter((line) => db.products.some((p) => p.id === line.id));
  const lines = cartLines();
  const total = cartTotal();
  const cash = Number(state.cash) || 0;
  const change = state.payMethod === "tunai" ? Math.max(0, cash - total) : 0;
  const payDisabled = !lines.length || (state.payMethod === "tunai" && cash < total);
  const methods = [["tunai", "Tunai"], ["qris", "QRIS"], ["transfer", "Transfer bank"]];

  panel.innerHTML = `
    <div class="panel-head">
      <h2>Pesanan</h2>
      ${lines.length ? `<button type="button" class="link-btn" data-action="clear-cart">Kosongkan</button>` : ""}
    </div>
    ${lines.length ? `
      <ul class="cart-list">
        ${lines.map((line) => `
        <li class="cart-row">
          <div class="cart-info"><strong>${esc(line.p.nama)}</strong><small>${rp(line.p.harga)} · ${esc(line.p.rasa)}</small></div>
          <div class="qty">
            <button type="button" data-action="dec" data-id="${line.p.id}" aria-label="Kurangi ${esc(line.p.nama)}">−</button>
            <span>${line.qty}</span>
            <button type="button" data-action="inc" data-id="${line.p.id}" aria-label="Tambah ${esc(line.p.nama)}">+</button>
          </div>
          <div class="cart-sub">${rp(line.p.harga * line.qty)}</div>
        </li>`).join("")}
      </ul>` : `
      <div class="cart-empty"><span aria-hidden="true">🧾</span><p>Belum ada pesanan. Ketuk menu untuk menambahkan.</p></div>`}
    <div class="cart-summary">
      <div class="row total"><span>Total</span><strong>${rp(total)}</strong></div>
      <div class="field">
        <label for="payMethod">Metode pembayaran</label>
        <select id="payMethod">
          ${methods.map(([value, label]) => `<option value="${value}" ${state.payMethod === value ? "selected" : ""}>${label}</option>`).join("")}
        </select>
      </div>
      ${state.payMethod === "tunai" ? `
      <div class="field">
        <label for="cashInput">Uang diterima</label>
        <input id="cashInput" type="number" min="0" step="500" inputmode="numeric" placeholder="0" value="${esc(state.cash)}">
      </div>
      <div class="quick-cash">
        ${[10000, 20000, 50000].map((value) => `<button type="button" data-action="quick-cash" data-amount="${value}">${rp(value)}</button>`).join("")}
        ${total ? `<button type="button" data-action="quick-cash" data-amount="${total}">Uang pas</button>` : ""}
      </div>
      <div class="row change"><span>Kembalian</span><strong id="changeValue">${rp(change)}</strong></div>` : ""}
      <button type="button" class="btn btn-primary btn-block" id="payBtn" data-action="pay" ${payDisabled ? "disabled" : ""}>
        ${total ? "Bayar " + rp(total) : "Bayar"}
      </button>
    </div>`;
}

function updateCashUI() {
  const total = cartTotal();
  const cash = Number(state.cash) || 0;
  const changeEl = $("#changeValue");
  if (changeEl) changeEl.textContent = rp(Math.max(0, cash - total));
  const payBtn = $("#payBtn");
  if (payBtn) payBtn.disabled = !cart.length || (state.payMethod === "tunai" && cash < total);
}

function addToCart(id) {
  const product = db.products.find((p) => p.id === id);
  if (!product || !product.aktif || product.stok <= 0) return;
  const line = cart.find((item) => item.id === id);
  const qty = line ? line.qty : 0;
  if (qty + 1 > product.stok) {
    notify("Stok " + product.nama + " hanya " + product.stok + ".");
    return;
  }
  if (line) line.qty += 1;
  else cart.push({ id: id, qty: 1 });
  renderCart();
}

function changeQty(id, delta) {
  const line = cart.find((item) => item.id === id);
  if (!line) return;
  const product = db.products.find((p) => p.id === id);
  if (!product) {
    cart = cart.filter((item) => item.id !== id);
    renderCart();
    return;
  }
  const next = line.qty + delta;
  if (next <= 0) {
    cart = cart.filter((item) => item.id !== id);
  } else if (next > product.stok) {
    notify("Stok " + product.nama + " hanya " + product.stok + ".");
    return;
  } else {
    line.qty = next;
  }
  renderCart();
}

function nextTxCode(date) {
  const key = todayKey(date).replace(/-/g, "");
  const sequence = db.transactions.filter((tx) => dayKey(tx.waktu) === todayKey(date)).length + 1;
  return "CSD-" + key + "-" + String(sequence).padStart(3, "0");
}

function checkout() {
  if (!cart.length) {
    notify("Keranjang masih kosong.");
    return;
  }

  const lines = cartLines();
  for (const line of lines) {
    if (!line.p.aktif || line.p.stok < line.qty) {
      notify("Stok " + line.p.nama + " tidak mencukupi.");
      renderCart();
      return;
    }
  }

  const total = lines.reduce((sum, line) => sum + line.p.harga * line.qty, 0);
  let bayar = total;
  let kembali = 0;

  if (state.payMethod === "tunai") {
    bayar = Number(state.cash) || 0;
    if (bayar < total) {
      notify("Uang diterima kurang dari total.");
      return;
    }
    kembali = bayar - total;
  }

  const now = new Date();
  const tx = {
    id: uid("tx"),
    kode: nextTxCode(now),
    waktu: now.toISOString(),
    kasir: session.nama,
    kasirUsername: session.username,
    metode: state.payMethod,
    items: lines.map((line) => ({
      productId: line.p.id,
      nama: line.p.nama,
      rasa: line.p.rasa,
      harga: line.p.harga,
      qty: line.qty,
      subtotal: line.p.harga * line.qty
    })),
    total: total,
    bayar: bayar,
    kembali: kembali
  };

  db.products = db.products.map((product) => {
    const line = lines.find((item) => item.p.id === product.id);
    return line ? Object.assign({}, product, { stok: product.stok - line.qty }) : product;
  });
  db.transactions.unshift(tx);
  persist();

  cart = [];
  state.cash = "";
  state.payMethod = "tunai";
  renderApp();
  openReceipt(tx);
  notify("Pembayaran " + rp(total) + " berhasil.");
}

function riwayatView() {
  const todayTx = db.transactions.filter((tx) => dayKey(tx.waktu) === todayKey());
  const summary = summarize(todayTx);

  return `
  <div class="page-head">
    <div>
      <p class="eyebrow">Kasir</p>
      <h1>Riwayat hari ini</h1>
      <p>Transaksi yang sudah dibayar pada ${formatDateKey(todayKey())}.</p>
    </div>
    <div class="head-actions">
      <button type="button" class="btn btn-primary btn-sm" data-action="tab" data-tab="kasir">Transaksi baru</button>
    </div>
  </div>
  <div class="stats">
    <div class="stat"><small>Transaksi</small><strong>${summary.count}</strong></div>
    <div class="stat"><small>Item terjual</small><strong>${summary.items}</strong></div>
    <div class="stat"><small>Omzet</small><strong>${rp(summary.omzet)}</strong></div>
    <div class="stat"><small>Rata-rata / transaksi</small><strong>${rp(summary.count ? Math.round(summary.omzet / summary.count) : 0)}</strong></div>
  </div>
  <section class="panel">
    <div class="table-wrap">
      <table class="data">
        <thead><tr><th>Waktu</th><th>Kode</th><th>Item</th><th>Metode</th><th>Total</th><th>Aksi</th></tr></thead>
        <tbody>
          ${todayTx.length ? todayTx.map((tx) => `
          <tr>
            <td>${fmtTime(tx.waktu)}</td>
            <td>${esc(tx.kode)}</td>
            <td>${tx.items.reduce((sum, item) => sum + item.qty, 0)} item</td>
            <td><span class="badge">${METHOD_LABEL[tx.metode] || esc(tx.metode)}</span></td>
            <td><strong>${rp(tx.total)}</strong></td>
            <td><button type="button" class="mini" data-action="view-tx" data-id="${tx.id}">Struk</button></td>
          </tr>`).join("") : `<tr><td colspan="6"><p class="empty-state">Belum ada transaksi hari ini.</p></td></tr>`}
        </tbody>
      </table>
    </div>
  </section>`;
}

/* ---------- admin ---------- */

function adminHomeView() {
  const todayTx = db.transactions.filter((tx) => dayKey(tx.waktu) === todayKey());
  const summary = summarize(todayTx);
  const activeProducts = db.products.filter((p) => p.aktif);
  const totalStock = activeProducts.reduce((sum, p) => sum + p.stok, 0);
  const lowStock = activeProducts.filter((p) => p.stok <= 10).sort((a, b) => a.stok - b.stok);
  const recent = db.transactions.slice(0, 5);

  return `
  <div class="page-head">
    <div>
      <p class="eyebrow">Admin</p>
      <h1>Ringkasan toko</h1>
      <p>Pantau penjualan hari ini, stok, dan aktivitas terakhir.</p>
    </div>
    <div class="head-actions">
      <button type="button" class="btn btn-outline btn-sm" data-action="tab" data-tab="menu">Kelola menu</button>
      <button type="button" class="btn btn-primary btn-sm" data-action="tab" data-tab="transaksi">Lihat transaksi</button>
    </div>
  </div>

  <div class="stats">
    <div class="stat"><small>Menu aktif</small><strong>${activeProducts.length}</strong><span class="hint">dari ${db.products.length} menu</span></div>
    <div class="stat"><small>Total stok</small><strong>${totalStock}</strong><span class="hint">gelas siap jual</span></div>
    <div class="stat"><small>Transaksi hari ini</small><strong>${summary.count}</strong><span class="hint">${summary.items} item terjual</span></div>
    <div class="stat"><small>Omzet hari ini</small><strong>${rp(summary.omzet)}</strong><span class="hint">${rp(summary.count ? Math.round(summary.omzet / summary.count) : 0)} rata-rata</span></div>
  </div>

  <div class="admin-grid">
    <section class="panel">
      <div class="panel-head"><h2>Stok perlu perhatian</h2><span class="badge badge-amber">≤ 10 gelas</span></div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>Menu</th><th>Stok</th></tr></thead>
          <tbody>
            ${lowStock.length ? lowStock.map((p) => `
            <tr><td class="cell-name">${esc(p.nama)}<small>${esc(p.rasa)}</small></td><td><span class="badge ${p.stok === 0 ? "badge-danger" : "badge-amber"}">${p.stok} gelas</span></td></tr>`).join("")
              : `<tr><td colspan="2"><p class="empty-state">Semua stok menu masih aman.</p></td></tr>`}
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>Transaksi terakhir</h2><button type="button" class="link-btn" data-action="tab" data-tab="transaksi">Semua</button></div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>Waktu</th><th>Kode</th><th>Total</th><th>Aksi</th></tr></thead>
          <tbody>
            ${recent.length ? recent.map((tx) => `
            <tr>
              <td>${fmtDateTime(tx.waktu)}</td>
              <td>${esc(tx.kode)}</td>
              <td><strong>${rp(tx.total)}</strong></td>
              <td><button type="button" class="mini" data-action="view-tx" data-id="${tx.id}">Struk</button></td>
            </tr>`).join("") : `<tr><td colspan="4"><p class="empty-state">Belum ada transaksi.</p></td></tr>`}
          </tbody>
        </table>
      </div>
    </section>
  </div>`;
}

function adminMenuView() {
  const editing = state.editingProduct ? db.products.find((p) => p.id === state.editingProduct) : null;
  const rows = db.products.map((p) => `
    <tr>
      <td class="cell-name">${esc(p.nama)}<small>${esc(p.deskripsi || "—")}</small></td>
      <td>${esc(p.rasa)}</td>
      <td>${rp(p.harga)}</td>
      <td>${p.stok}</td>
      <td>
        <span class="badge ${p.aktif ? "badge-ok" : ""}">${p.aktif ? "Tampil" : "Disembunyikan"}</span>
        ${p.stok <= 10 ? `<span class="badge badge-amber">Stok tipis</span>` : ""}
      </td>
      <td>
        <div class="table-actions">
          <button type="button" class="mini" data-action="edit-product" data-id="${p.id}">Edit</button>
          <button type="button" class="mini danger" data-action="delete-product" data-id="${p.id}">Hapus</button>
        </div>
      </td>
    </tr>`).join("");

  return `
  <div class="page-head">
    <div>
      <p class="eyebrow">Admin</p>
      <h1>Kelola menu</h1>
      <p>Tambah menu baru, perbarui harga Rp 6.000, atau atur stok harian.</p>
    </div>
    <div class="head-actions">
      <button type="button" class="btn btn-outline btn-sm" data-action="tab" data-tab="ringkasan">Ringkasan</button>
    </div>
  </div>

  <div class="admin-grid">
    <form class="panel" id="productForm">
      <div class="panel-head"><h2>${editing ? "Edit menu" : "Tambah menu"}</h2></div>
      <input type="hidden" id="pId" value="${editing ? esc(editing.id) : ""}">
      <div class="field">
        <label for="pName">Nama menu *</label>
        <input id="pName" maxlength="60" required placeholder="Cendol Original" value="${editing ? esc(editing.nama) : ""}">
      </div>
      <div class="field">
        <label for="pRasa">Rasa *</label>
        <input id="pRasa" list="rasaOptions" maxlength="30" required placeholder="Original" value="${editing ? esc(editing.rasa) : ""}">
        <datalist id="rasaOptions">
          <option value="Original"></option>
          <option value="Gula Aren"></option>
          <option value="Coklat"></option>
        </datalist>
      </div>
      <div class="field-row">
        <div class="field">
          <label for="pPrice">Harga (Rp) *</label>
          <input id="pPrice" type="number" min="0" step="500" required value="${editing ? editing.harga : 6000}">
        </div>
        <div class="field">
          <label for="pStock">Stok (gelas) *</label>
          <input id="pStock" type="number" min="0" step="1" required value="${editing ? editing.stok : 30}">
        </div>
      </div>
      <div class="field">
        <label for="pDesc">Deskripsi</label>
        <textarea id="pDesc" maxlength="160" placeholder="Deskripsi singkat menu">${editing ? esc(editing.deskripsi) : ""}</textarea>
      </div>
      <label class="check"><input type="checkbox" id="pAktif" ${!editing || editing.aktif ? "checked" : ""}> Tampilkan menu ke tamu &amp; kasir</label>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit">${editing ? "Simpan perubahan" : "Simpan menu"}</button>
        <button class="btn btn-outline" type="button" data-action="reset-product">${editing ? "Batal edit" : "Reset form"}</button>
      </div>
    </form>

    <section class="panel">
      <div class="panel-head"><h2>Daftar menu</h2><span class="muted">${db.products.length} menu</span></div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>Menu</th><th>Rasa</th><th>Harga</th><th>Stok</th><th>Status</th><th>Aksi</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="6"><p class="empty-state">Belum ada menu.</p></td></tr>`}</tbody>
        </table>
      </div>
    </section>
  </div>`;
}

function adminTxView() {
  const date = state.adminTxDate || todayKey();
  const list = db.transactions.filter((tx) => dayKey(tx.waktu) === date);
  const summary = summarize(list);

  return `
  <div class="page-head">
    <div>
      <p class="eyebrow">Admin</p>
      <h1>Laporan transaksi</h1>
      <p>Semua transaksi tersimpan di perangkat ini.</p>
    </div>
  </div>
  <div class="stats">
    <div class="stat"><small>Transaksi</small><strong>${summary.count}</strong></div>
    <div class="stat"><small>Item terjual</small><strong>${summary.items}</strong></div>
    <div class="stat"><small>Omzet</small><strong>${rp(summary.omzet)}</strong></div>
    <div class="stat"><small>Tanggal</small><strong style="font-size:1rem;line-height:1.6">${formatDateKey(date)}</strong></div>
  </div>
  <section class="panel">
    <div class="panel-head">
      <h2>Daftar transaksi</h2>
      <div class="field" style="margin:0;min-width:170px">
        <label for="adminTxDate">Pilih tanggal</label>
        <input id="adminTxDate" type="date" value="${date}">
      </div>
    </div>
    <div class="table-wrap">
      <table class="data">
        <thead><tr><th>Waktu</th><th>Kode</th><th>Kasir</th><th>Item</th><th>Metode</th><th>Total</th><th>Aksi</th></tr></thead>
        <tbody>
          ${list.length ? list.map((tx) => `
          <tr>
            <td>${fmtTime(tx.waktu)}</td>
            <td>${esc(tx.kode)}</td>
            <td>${esc(tx.kasir)}</td>
            <td>${tx.items.reduce((sum, item) => sum + item.qty, 0)} item</td>
            <td><span class="badge">${METHOD_LABEL[tx.metode] || esc(tx.metode)}</span></td>
            <td><strong>${rp(tx.total)}</strong></td>
            <td><button type="button" class="mini" data-action="view-tx" data-id="${tx.id}">Struk</button></td>
          </tr>`).join("") : `<tr><td colspan="7"><p class="empty-state">Tidak ada transaksi pada tanggal ini.</p></td></tr>`}
        </tbody>
      </table>
    </div>
  </section>`;
}

function adminAkunView() {
  const editing = state.editingUser ? db.users.find((u) => u.id === state.editingUser) : null;
  const rows = db.users.map((u) => {
    const isSelf = u.id === session.userId;
    return `
    <tr>
      <td class="cell-name">${esc(u.nama)}${isSelf ? `<span class="badge badge-role" style="margin-left:6px">Anda</span>` : ""}<small>@${esc(u.username)}</small></td>
      <td><span class="badge badge-role">${ROLE_LABEL[u.role]}</span></td>
      <td>${fmtDate(u.createdAt)}</td>
      <td>
        <div class="table-actions">
          <button type="button" class="mini" data-action="edit-user" data-id="${u.id}" ${isSelf ? `disabled title="Tidak bisa mengubah akun yang sedang dipakai"` : ""}>Edit</button>
          <button type="button" class="mini danger" data-action="delete-user" data-id="${u.id}" ${isSelf ? "disabled" : ""}>Hapus</button>
        </div>
      </td>
    </tr>`;
  }).join("");

  return `
  <div class="page-head">
    <div>
      <p class="eyebrow">Admin</p>
      <h1>Akun pengguna</h1>
      <p>Buat akun kasir atau admin baru dan atur ulang PIN.</p>
    </div>
  </div>

  <div class="admin-grid">
    <form class="panel" id="userForm">
      <div class="panel-head"><h2>${editing ? "Edit akun" : "Tambah akun"}</h2></div>
      <input type="hidden" id="uId" value="${editing ? esc(editing.id) : ""}">
      <div class="field">
        <label for="uNama">Nama lengkap *</label>
        <input id="uNama" maxlength="60" required placeholder="Kasir Shift Pagi" value="${editing ? esc(editing.nama) : ""}">
      </div>
      <div class="field">
        <label for="uUsername">Username *</label>
        <input id="uUsername" maxlength="20" required placeholder="kasir2" value="${editing ? esc(editing.username) : ""}">
      </div>
      <div class="field">
        <label for="uPin">${editing ? "PIN baru (kosongkan bila tetap)" : "PIN *"}</label>
        <input id="uPin" type="password" inputmode="numeric" maxlength="24" autocomplete="new-password" placeholder="Minimal 4 karakter">
      </div>
      <div class="field">
        <label for="uRole">Peran *</label>
        <select id="uRole">
          <option value="kasir" ${!editing || editing.role === "kasir" ? "selected" : ""}>Kasir</option>
          <option value="admin" ${editing && editing.role === "admin" ? "selected" : ""}>Admin</option>
        </select>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit">${editing ? "Simpan perubahan" : "Buat akun"}</button>
        <button class="btn btn-outline" type="button" data-action="reset-user">${editing ? "Batal edit" : "Reset form"}</button>
      </div>
    </form>

    <section class="panel">
      <div class="panel-head"><h2>Daftar akun</h2><span class="muted">${db.users.length} akun</span></div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>Akun</th><th>Peran</th><th>Dibuat</th><th>Aksi</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>
  </div>

  <div class="panel danger-zone">
    <div>
      <h2>Pulihkan data demo</h2>
      <p>Kembalikan menu (Original, Gula Aren, Coklat) dan hapus semua transaksi. Akun pengguna tidak terhapus.</p>
    </div>
    <button type="button" class="btn btn-outline btn-sm" data-action="reset-demo">Reset data demo</button>
  </div>`;
}

/* ---------- aksi produk & akun ---------- */

function saveProduct(event) {
  event.preventDefault();
  const id = $("#pId").value;
  const nama = $("#pName").value.trim();
  const rasa = $("#pRasa").value.trim();
  const harga = Number($("#pPrice").value);
  const stok = Number($("#pStock").value);
  const deskripsi = $("#pDesc").value.trim();
  const aktif = $("#pAktif").checked;

  if (!nama || !rasa) {
    notify("Nama menu dan rasa wajib diisi.");
    return;
  }
  if (!Number.isInteger(harga) || harga < 0) {
    notify("Harga harus angka bulat ≥ 0.");
    return;
  }
  if (!Number.isInteger(stok) || stok < 0) {
    notify("Stok harus bilangan bulat ≥ 0.");
    return;
  }

  if (id) {
    db.products = db.products.map((p) => (
      p.id === id ? Object.assign({}, p, { nama: nama, rasa: rasa, harga: harga, stok: stok, deskripsi: deskripsi, aktif: aktif }) : p
    ));
    notify("Menu berhasil diperbarui.");
  } else {
    db.products.push({
      id: uid("menu"),
      nama: nama,
      rasa: rasa,
      harga: harga,
      stok: stok,
      deskripsi: deskripsi,
      aktif: aktif,
      warna: RASA_COLORS[rasa.toLowerCase()] || "#2f8b3d"
    });
    notify("Menu baru ditambahkan.");
  }

  state.editingProduct = null;
  persist();
  renderApp();
}

function deleteProduct(id) {
  const product = db.products.find((p) => p.id === id);
  if (!product) return;
  if (!confirm('Hapus menu "' + product.nama + '"? Riwayat transaksi tidak ikut terhapus.')) return;
  db.products = db.products.filter((p) => p.id !== id);
  cart = cart.filter((line) => line.id !== id);
  if (state.editingProduct === id) state.editingProduct = null;
  persist();
  renderApp();
  notify("Menu dihapus.");
}

function saveUser(event) {
  event.preventDefault();
  const id = $("#uId").value;
  const nama = $("#uNama").value.trim();
  const username = $("#uUsername").value.trim().toLowerCase();
  const pin = $("#uPin").value;
  const role = $("#uRole").value;

  if (!nama || !username) {
    notify("Nama dan username wajib diisi.");
    return;
  }
  if (!/^[a-z0-9._-]{3,20}$/.test(username)) {
    notify("Username 3–20 karakter: huruf kecil, angka, . _ -");
    return;
  }
  if (db.users.some((u) => u.username === username && u.id !== id)) {
    notify("Username sudah digunakan.");
    return;
  }
  if (role !== "admin" && role !== "kasir") {
    notify("Peran tidak valid.");
    return;
  }

  if (!id) {
    if (pin.length < 4) {
      notify("PIN minimal 4 karakter.");
      return;
    }
    db.users.push(makeUser(nama, username, pin, role));
    notify("Akun baru dibuat.");
  } else {
    if (id === session.userId) {
      notify("Tidak bisa mengubah akun yang sedang dipakai.");
      return;
    }
    const target = db.users.find((u) => u.id === id);
    if (!target) return;
    if (target.role === "admin" && role !== "admin" && db.users.filter((u) => u.role === "admin").length <= 1) {
      notify("Minimal satu akun admin harus tersisa.");
      return;
    }
    if (pin && pin.length < 4) {
      notify("PIN minimal 4 karakter.");
      return;
    }
    db.users = db.users.map((u) => {
      if (u.id !== id) return u;
      if (pin) {
        const salt = randSalt();
        return Object.assign({}, u, { nama: nama, username: username, role: role, salt: salt, pinHash: hashPin(pin, salt) });
      }
      return Object.assign({}, u, { nama: nama, username: username, role: role });
    });
    notify("Akun diperbarui.");
  }

  state.editingUser = null;
  persist();
  renderApp();
}

function deleteUser(id) {
  if (id === session.userId) {
    notify("Tidak bisa menghapus akun yang sedang dipakai.");
    return;
  }
  const target = db.users.find((u) => u.id === id);
  if (!target) return;
  if (target.role === "admin" && db.users.filter((u) => u.role === "admin").length <= 1) {
    notify("Minimal satu akun admin harus tersisa.");
    return;
  }
  if (!confirm('Hapus akun "@' + target.username + '"?')) return;
  db.users = db.users.filter((u) => u.id !== id);
  if (state.editingUser === id) state.editingUser = null;
  persist();
  renderApp();
  notify("Akun dihapus.");
}

function resetDemo() {
  if (!confirm("Pulihkan menu demo dan hapus semua transaksi? Akun tetap disimpan.")) return;
  db.products = SEED_PRODUCTS.map((p) => Object.assign({}, p));
  db.transactions = [];
  state.editingProduct = null;
  cart = [];
  persist();
  renderApp();
  notify("Data demo berhasil dipulihkan.");
}

/* ---------- struk ---------- */

function openReceipt(tx) {
  openModal(`
    <div class="modal-head no-print">
      <h2>Struk pembayaran</h2>
      <button type="button" class="icon-btn" data-action="close-modal" aria-label="Tutup">✕</button>
    </div>
    <div class="receipt" id="receiptCard">
      <div class="receipt-brand">CENSU'D<small>Cendol rumahan · Rp 6.000 / gelas</small></div>
      <div class="receipt-meta">
        <span>${esc(tx.kode)}</span>
        <span>${fmtDateTime(tx.waktu)}</span>
        <span>Kasir: ${esc(tx.kasir)}</span>
      </div>
      <table class="receipt-items">
        <tbody>
          ${tx.items.map((item) => `
          <tr>
            <td>${esc(item.nama)}${item.qty > 1 ? " ×" + item.qty : ""}<br><small>${rp(item.harga)}</small></td>
            <td>${rp(item.subtotal)}</td>
          </tr>`).join("")}
        </tbody>
      </table>
      <div class="receipt-row total"><span>TOTAL</span><span>${rp(tx.total)}</span></div>
      <div class="receipt-row"><span>${METHOD_LABEL[tx.metode] || esc(tx.metode)}</span><span>${rp(tx.bayar)}</span></div>
      <div class="receipt-row"><span>Kembalian</span><span>${rp(tx.kembali)}</span></div>
      <p class="receipt-thanks">Terima kasih sudah menikmati Censu'D!</p>
    </div>
    <div class="modal-actions no-print">
      <button type="button" class="btn btn-outline" data-action="close-modal">Tutup</button>
      <button type="button" class="btn btn-primary" data-action="print">Cetak struk</button>
    </div>`);
}

/* ---------- login & logout ---------- */

function handleLogin(event) {
  event.preventDefault();
  const username = $("#loginUser").value.trim().toLowerCase();
  const pin = $("#loginPin").value;
  const user = db.users.find((u) => u.username === username);
  const errorEl = $("#loginError");

  if (!user || user.role !== state.loginRole || hashPin(pin, user.salt) !== user.pinHash) {
    errorEl.textContent = "Username atau PIN tidak cocok untuk peran " + ROLE_LABEL[state.loginRole] + ".";
    errorEl.classList.remove("hidden");
    $("#loginPin").value = "";
    $("#loginPin").focus();
    return;
  }

  errorEl.classList.add("hidden");
  session = { role: user.role, username: user.username, nama: user.nama, userId: user.id };
  saveSession();
  state.tab[user.role] = DEFAULT_TAB[user.role];
  cart = [];
  state.cash = "";
  state.posQuery = "";
  state.editingProduct = null;
  state.editingUser = null;
  $("#loginForm").reset();
  renderApp();
  notify("Selamat datang, " + user.nama + ".");
}

function handleGuest() {
  session = { role: "guest", username: "guest", nama: "Tamu" };
  saveSession();
  $("#loginError").classList.add("hidden");
  $("#loginForm").reset();
  renderApp();
}

function logout() {
  session = null;
  cart = [];
  state.cash = "";
  state.posQuery = "";
  state.editingProduct = null;
  state.editingUser = null;
  state.payMethod = "tunai";
  state.loginRole = "kasir";
  saveSession();
  hideModal();
  renderApp();
  notify("Anda telah keluar.");
}

/* ---------- events ---------- */

function onRolePick(event) {
  const btn = event.target.closest("[data-role]");
  if (!btn) return;
  state.loginRole = btn.dataset.role;
  $$("#rolePicker .role-card").forEach((card) => card.classList.toggle("active", card === btn));
  $("#loginError").classList.add("hidden");
  $("#loginUser").placeholder = state.loginRole === "admin" ? "admin" : "kasir";
}

function onActionClick(event) {
  const el = event.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;

  if (el.tagName === "A") event.preventDefault();

  switch (action) {
    case "home":
      if (!session) return;
      if (session.role === "guest") {
        window.scrollTo({ top: 0, behavior: "smooth" });
      } else {
        state.tab[session.role] = DEFAULT_TAB[session.role];
        state.editingProduct = null;
        state.editingUser = null;
        renderApp();
      }
      break;
    case "logout":
      logout();
      break;
    case "tab":
      if (!session || session.role === "guest") return;
      state.tab[session.role] = el.dataset.tab;
      state.editingProduct = null;
      state.editingUser = null;
      hideModal();
      renderApp();
      window.scrollTo({ top: 0 });
      break;
    case "add":
      addToCart(el.dataset.id);
      break;
    case "inc":
      changeQty(el.dataset.id, 1);
      break;
    case "dec":
      changeQty(el.dataset.id, -1);
      break;
    case "clear-cart":
      cart = [];
      state.cash = "";
      renderCart();
      break;
    case "quick-cash":
      state.cash = String(el.dataset.amount);
      renderCart();
      break;
    case "pay":
      checkout();
      break;
    case "print":
      window.print();
      break;
    case "close-modal":
      hideModal();
      break;
    case "view-tx": {
      const tx = db.transactions.find((item) => item.id === el.dataset.id);
      if (tx) openReceipt(tx);
      break;
    }
    case "edit-product":
      state.editingProduct = el.dataset.id;
      state.tab.admin = "menu";
      renderApp();
      break;
    case "delete-product":
      deleteProduct(el.dataset.id);
      break;
    case "reset-product":
      state.editingProduct = null;
      renderApp();
      break;
    case "edit-user":
      state.editingUser = el.dataset.id;
      state.tab.admin = "akun";
      renderApp();
      break;
    case "delete-user":
      deleteUser(el.dataset.id);
      break;
    case "reset-user":
      state.editingUser = null;
      renderApp();
      break;
    case "reset-demo":
      resetDemo();
      break;
    case "guest-order":
      orderGuest(el.dataset.id);
      break;
    default:
      break;
  }
}

function onInput(event) {
  if (event.target.id === "posSearch") {
    state.posQuery = event.target.value;
    renderPosMenu();
  } else if (event.target.id === "cashInput") {
    state.cash = event.target.value;
    updateCashUI();
  }
}

function onChange(event) {
  if (event.target.id === "payMethod") {
    state.payMethod = event.target.value;
    renderCart();
  } else if (event.target.id === "adminTxDate") {
    state.adminTxDate = event.target.value || todayKey();
    renderApp();
  }
}

function onSubmit(event) {
  if (event.target.id === "productForm") saveProduct(event);
  else if (event.target.id === "userForm") saveUser(event);
}

/* ---------- boot ---------- */

initDB();
session = loadSession();

$("#rolePicker").addEventListener("click", onRolePick);
$("#loginForm").addEventListener("submit", handleLogin);
$("#guestBtn").addEventListener("click", handleGuest);
$("#modal").addEventListener("click", (event) => {
  if (event.target.id === "modal") hideModal();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideModal();
});
document.addEventListener("click", onActionClick);
document.addEventListener("input", onInput);
document.addEventListener("change", onChange);
document.addEventListener("submit", onSubmit);

renderApp();
