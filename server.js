const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

// --- 1. MIDDLEWARE ---
app.use(cors());
app.use(express.json({ limit: '15mb' })); 
app.use(express.urlencoded({ limit: '15mb', extended: true }));
app.use(express.static('public'));

// --- 2. DATABASE ---
const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'geobencana',
    password: '12345678', // GANTI PASSWORD ANDA
    port: 5432,
});

pool.connect((err) => {
    if (err) console.error('❌ Database Error:', err.stack);
    else console.log('✅ Sistem Pusdatin & Surat Perintah Aktif');
});

// --- 3. AUTHENTICATION ---
app.post('/api/auth/register', async (req, res) => {
    const { full_name, region, username, password } = req.body;
    try {
        await pool.query('INSERT INTO users (full_name, region, username, password) VALUES ($1, $2, $3, $4)', [full_name, region, username, password]);
        res.json({ message: "Registrasi Berhasil" });
    } catch (err) { res.status(400).json({ error: "Username sudah digunakan" }); }
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1 AND password = $2', [username, password]);
        if (result.rows.length > 0) {
            const u = result.rows[0];
            res.json({ success: true, user: { name: u.full_name, region: u.region } });
        } else { res.status(401).json({ error: "Gagal Login" }); }
    } catch (err) { res.status(500).json({ error: "Server Error" }); }
});

// --- 4. DATA REPORTS (PUBLIC & ADMIN) ---
app.get('/api/reports/public', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, disaster_type, city_district, kecamatan, photo, status_bencana, status_perintah,
            ST_X(location::geometry) as longitude, ST_Y(location::geometry) as latitude, created_at 
            FROM reports WHERE is_approved = true AND status_bencana != 'Selesai'
            ORDER BY created_at DESC
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
});

/** ==========================================
 *  AMBIL DATA ADMIN (DENGAN FILTER WILAYAH)
 *  ========================================== */
app.get('/api/reports/admin', async (req, res) => {
    const { region, role } = req.query; 

    try {
        let query;
        let params = [];

        if (role === 'SUPER_ADMIN') {
            // ADMIN PUSAT: Ambil semua tanpa kecuali
            query = `SELECT *, ST_X(location::geometry) as longitude, ST_Y(location::geometry) as latitude FROM reports ORDER BY created_at DESC`;
        } else {
            // ADMIN CABANG: Ambil berdasarkan region miliknya saja
            query = `SELECT *, ST_X(location::geometry) as longitude, ST_Y(location::geometry) as latitude FROM reports WHERE city_district = $1 ORDER BY created_at DESC`;
            params = [region];
        }

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
});

// SIMPAN LAPORAN WARGA
app.post('/api/report-form', async (req, res) => {
    const { reporter_name, whatsapp_number, disaster_type, description, latitude, longitude, photo } = req.body;
    try {
        const query = `INSERT INTO reports (reporter_name, whatsapp_number, disaster_type, description, location, photo, is_approved, status_bencana, status_perintah) 
                       VALUES ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($5, $6), 4326), $7, false, 'Pending', 'None')`;
        await pool.query(query, [reporter_name, whatsapp_number, disaster_type, description, longitude, latitude, photo]);
        res.json({ message: "Laporan diterima" });
    } catch (err) { res.status(500).send(err.message); }
});

// --- 5. FITUR SURAT PERINTAH (LOGIKA BARU) ---

// Admin mengajukan Draft SP ke Ketua
app.post('/api/reports/draft-sp', async (req, res) => {
    const { id, petugas_ditunjuk, armada, instruksi_khusus } = req.body;
    try {
        const spData = JSON.stringify({ petugas_ditunjuk, armada, instruksi_khusus, tanggal_draft: new Date() });
        await pool.query(
            "UPDATE reports SET surat_perintah_data = $1, status_perintah = 'Drafted' WHERE id = $2",
            [spData, id]
        );
        res.json({ message: "Draft Surat Perintah telah dikirim ke Ketua" });
    } catch (err) { res.status(500).send(err.message); }
});

// Ketua menyetujui SP
app.post('/api/reports/approve-sp', async (req, res) => {
    const { id, chairman_name } = req.body;
    try {
        await pool.query(
            "UPDATE reports SET status_perintah = 'Approved', approved_by_chairman = $1, status_bencana = 'Penanganan' WHERE id = $2",
            [chairman_name, id]
        );
        res.json({ message: "Surat Perintah Disetujui! Tim dipersilakan merespon." });
    } catch (err) { res.status(500).send(err.message); }
});

/** ==========================================
 *  AMBIL SEMUA AKSI (DENGAN FILTER WILAYAH)
 *  ========================================== */
app.get('/api/actions/all', async (req, res) => {
    const { region, role } = req.query;
    try {
        let query;
        let params = [];

        if (role === 'SUPER_ADMIN') {
            query = `SELECT a.*, r.disaster_type, r.city_district FROM nu_actions a JOIN reports r ON a.report_id = r.id ORDER BY a.created_at DESC`;
        } else {
            query = `SELECT a.*, r.disaster_type, r.city_district FROM nu_actions a JOIN reports r ON a.report_id = r.id WHERE r.city_district = $1 ORDER BY a.created_at DESC`;
            params = [region];
        }

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
});
app.post('/api/actions/admin-create', async (req, res) => {
    const { report_id, kluster, kegiatan, paket, penerima, photo } = req.body;
    try {
        await pool.query('INSERT INTO nu_actions (report_id, kluster, nama_kegiatan, jumlah_paket, penerima_manfaat, photo) VALUES ($1, $2, $3, $4, $5, $6)', [report_id, kluster, kegiatan, paket, penerima, photo]);
        res.json({ message: "Aksi Respon Berhasil Dicatat" });
    } catch (err) { res.status(500).send(err.message); }
});

app.post('/api/reports/approve', async (req, res) => {
    const { id } = req.body;
    await pool.query("UPDATE reports SET is_approved = true, status_bencana = 'Verified' WHERE id = $1", [id]);
    res.json({ message: "Laporan Disetujui" });
});

app.post('/api/update-assessment', async (req, res) => {
    const { id, status } = req.body;
    await pool.query('UPDATE reports SET status_bencana = $1 WHERE id = $2', [status, id]);
    res.json({ message: "Status Diperbarui" });
});
app.post('/api/reports/close', async (req, res) => {
    const { id } = req.body;
    try {
        await pool.query("UPDATE reports SET status_bencana = 'Closed' WHERE id = $1", [id]);
        res.json({ message: "Laporan Berhasil Ditutup & Masuk Arsip" });
    } catch (err) { res.status(500).send(err.message); }
});

// --- 7. START SERVER ---
app.listen(port, () => {
    console.log(`============================================`);
    console.log(`🚀 SERVER NU PEDULI JATENG ONLINE`);
    console.log(`📍 Port: ${port}`);
    console.log('============================================');
    console.log(`Server online pada port ${port}`);
});