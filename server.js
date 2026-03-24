const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT_SERVER = process.env.PORT || 3000; // Nama variabel diganti agar unik

// --- 1. MIDDLEWARE ---
app.use(cors());
app.use(express.json({ limit: '15mb' })); 
app.use(express.urlencoded({ limit: '15mb', extended: true }));
app.use(express.static('public'));
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
}); 

// --- 2. DATABASE (Railway Optimized) ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

pool.connect((err) => {
    if (err) console.error('❌ Database Error:', err.stack);
    else console.log('✅ Sistem Pusdatin Online');
});

/** ==========================================
 *  SECTION 1: AUTHENTICATION
 *  ========================================== */

app.post('/api/auth/register', async (req, res) => {
    const { full_name, region, username, password } = req.body;
    try {
        await pool.query('INSERT INTO users (full_name, region, username, password, role) VALUES ($1, $2, $3, $4, \'PCNU\')', [full_name, region, username, password]);
        res.json({ message: "Registrasi Berhasil" });
    } catch (err) { res.status(400).json({ error: "Username sudah digunakan" }); }
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1 AND password = $2', [username, password]);
        if (result.rows.length > 0) {
            const u = result.rows[0];
            res.json({ success: true, user: { name: u.full_name, region: u.region, role: u.role } });
        } else { res.status(401).json({ error: "Username atau Password salah" }); }
    } catch (err) { res.status(500).json({ error: "Server Error" }); }
});

/** ==========================================
 *  SECTION 2: DATA REPORTS
 *  ========================================== */

app.get('/api/reports/public', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, disaster_type, city_district, kecamatan, desa, photo, status_bencana, kebutuhan, dampak_manusia, sebaran_dampak, kondisi_mutakhir,
            ST_X(location::geometry) as longitude, ST_Y(location::geometry) as latitude, created_at 
            FROM reports WHERE is_approved = true AND status_bencana != 'Closed'
            ORDER BY created_at DESC
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
});

app.get('/api/reports/admin', async (req, res) => {
    const { region, role } = req.query; 
    try {
        let query;
        let params = [];
        if (role === 'SUPER_ADMIN') {
            query = `SELECT *, ST_X(location::geometry) as longitude, ST_Y(location::geometry) as latitude FROM reports ORDER BY created_at DESC`;
        } else {
            query = `SELECT *, ST_X(location::geometry) as longitude, ST_Y(location::geometry) as latitude FROM reports WHERE city_district = $1 ORDER BY created_at DESC`;
            params = [region];
        }
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
});

app.post('/api/report-form', async (req, res) => {
    const { reporter_name, whatsapp_number, disaster_type, description, latitude, longitude, photo } = req.body;
    let kab = "Jawa Tengah"; let kec = "-";
    try {
        try {
            const geo = await axios.get(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${latitude}&lon=${longitude}&zoom=18`, { headers: { 'User-Agent': 'NUPeduli' }, timeout: 3000 });
            if (geo.data.address) {
                const a = geo.data.address;
                kab = a.city || a.town || a.county || kab;
                kec = a.suburb || a.district || a.village || kec;
            }
        } catch (e) { console.log("Geocoding lambat."); }

        const query = `INSERT INTO reports (reporter_name, whatsapp_number, disaster_type, description, city_district, kecamatan, location, photo, is_approved, status_bencana, status_perintah) 
                       VALUES ($1, $2, $3, $4, $5, $6, ST_SetSRID(ST_MakePoint($7, $8), 4326), $9, false, 'Pending', 'None')`;
        await pool.query(query, [reporter_name, whatsapp_number, disaster_type, description, kab, kec, longitude, latitude, photo]);
        res.json({ message: "Laporan diterima" });
    } catch (err) { res.status(500).send(err.message); }
});

app.post('/api/reports/admin-create', async (req, res) => {
    const { type, date, time, kab, kec, desa, lat, lng, kondisi_mutakhir, upaya_penanganan, sebaran_dampak, photo, kebutuhan, dampak_manusia, dampak_rumah, dampak_vital, dampak_lingkungan } = req.body;
    try {
        const query = `INSERT INTO reports 
            (disaster_type, event_date, event_time, city_district, kecamatan, desa, location, kondisi_mutakhir, upaya_penanganan, sebaran_dampak, photo, kebutuhan, dampak_manusia, dampak_rumah, dampak_vital, dampak_lingkungan, is_approved, is_admin_report, status_bencana) 
            VALUES ($1, $2, $3, $4, $5, $6, ST_SetSRID(ST_MakePoint($7, $8), 4326), $9, $10, $11, $12, $13, $14, $15, $16, $17, true, true, 'Verified')`;
        await pool.query(query, [type, date, time, kab, kec, desa, lng, lat, kondisi_mutakhir, upaya_penanganan, sebaran_dampak, photo, kebutuhan, dampak_manusia, dampak_rumah, dampak_vital, dampak_lingkungan]);
        res.json({ message: "Assessment Berhasil" });
    } catch (err) { res.status(500).send(err.message); }
});

/** ==========================================
 *  SECTION 3: SURAT PERINTAH & AKSI
 *  ========================================== */

app.post('/api/reports/draft-sp', async (req, res) => {
    const { id, petugas_ditunjuk, instruksi_khusus } = req.body;
    try {
        const spData = JSON.stringify({ petugas_ditunjuk, instruksi_khusus, tanggal_draft: new Date() });
        await pool.query("UPDATE reports SET surat_perintah_data = $1, status_perintah = 'Drafted' WHERE id = $2", [spData, id]);
        res.json({ message: "Draft SP Terkirim" });
    } catch (err) { res.status(500).send(err.message); }
});

app.post('/api/reports/approve-sp', async (req, res) => {
    const { id, chairman_name } = req.body;
    try {
        await pool.query("UPDATE reports SET status_perintah = 'Approved', approved_by_chairman = $1, status_bencana = 'On-Operation' WHERE id = $2", [chairman_name, id]);
        res.json({ message: "SP Disetujui" });
    } catch (err) { res.status(500).send(err.message); }
});

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
        res.json({ message: "Aksi Respon Dicatat" });
    } catch (err) { res.status(500).send(err.message); }
});

app.post('/api/reports/approve', async (req, res) => {
    const { id } = req.body;
    await pool.query("UPDATE reports SET is_approved = true, status_bencana = 'Verified' WHERE id = $1", [id]);
    res.json({ message: "Disetujui" });
});

app.post('/api/reports/close', async (req, res) => {
    const { id } = req.body;
    await pool.query("UPDATE reports SET status_bencana = 'Closed' WHERE id = $1", [id]);
    res.json({ message: "Laporan Ditutup" });
});

// --- 4. START SERVER ---
app.listen(PORT_SERVER, "0.0.0.0", () => {
    console.log(`🚀 SERVER ONLINE PORT ${PORT_SERVER}`);
});