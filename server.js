require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const session = require('express-session');

const app = express();
const PORT = process.env.PORT || 3000;

// =======================
// ENV CHECKS
// =======================
if (!process.env.MONGO_URI) {
    console.error("❌ Missing MONGO_URI");
    process.exit(1);
}
if (!process.env.ADMIN_CODE) {
    console.error("❌ Missing ADMIN_CODE in .env");
    process.exit(1);
}
if (!process.env.SESSION_SECRET) {
    console.error("❌ Missing SESSION_SECRET in .env");
    process.exit(1);
}

// =======================
// TRUST PROXY (required on Render for secure cookies)
// =======================
app.set('trust proxy', 1);

// =======================
// MIDDLEWARE
// =======================
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cors({ origin: true, credentials: true }));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('dev'));

// =======================
// SESSION
// =======================
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
        maxAge: 8 * 60 * 60 * 1000  // 8 hours
    }
}));

// =======================
// RATE LIMITERS
// =======================
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, max: 1000 }));

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: 'Too many attempts. Try again in 15 minutes.' }
});

// =======================
// DATABASE
// =======================
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ MongoDB connected'))
    .catch(err => { console.error('❌ MongoDB error:', err.message); process.exit(1); });

// =======================
// SCHEMAS
// =======================
const carSchema = new mongoose.Schema({
    make:        { type: String, required: true },
    model:       { type: String, required: true },
    year:        Number,
    price:       { type: Number, required: true },
    mileage:     Number,
    color:       String,
    description: String,
    image:       String,
    images:      [String],
    status:      { type: String, default: 'available' },
    soldDate:    String,
    createdAt:   { type: String, default: () => new Date().toISOString() }
});

const enquirySchema = new mongoose.Schema({
    carId:     { type: String, default: null },
    carMake:   String,
    carModel:  String,
    carYear:   Number,
    name:      { type: String, required: true },
    phone:     String,
    email:     String,
    message:   String,
    status:    { type: String, default: 'new' },
    repliedAt: String,
    createdAt: { type: String, default: () => new Date().toISOString() }
});

const Car     = mongoose.model('Car', carSchema);
const Enquiry = mongoose.model('Enquiry', enquirySchema);

function carOut(c) {
    const obj = c.toObject();
    obj.id = obj._id.toString();
    if (!obj.images || !obj.images.length) {
        obj.images = obj.image ? [obj.image] : [];
    }
    return obj;
}

function enqOut(e) {
    const obj = e.toObject();
    obj.id = obj._id.toString();
    return obj;
}

// =======================
// AUTH MIDDLEWARE
// =======================
function requireAdmin(req, res, next) {
    if (req.session && req.session.isAdmin) return next();
    res.status(401).json({ error: 'Unauthorized — please log in at /admin/login' });
}

function requireAdminPage(req, res, next) {
    if (req.session && req.session.isAdmin) return next();
    res.redirect('/admin/login');
}

// =======================
// cron check
// =======================
app.get('/health', async (req, res) => {
    const state = mongoose.connection.readyState;
    // 0=disconnected, 1=connected, 2=connecting, 3=disconnecting
    if (state === 1) {
        res.status(200).json({ status: 'ok', db: 'connected' });
    } else {
        res.status(503).json({ status: 'error', db: 'disconnected' });
    }
});

// =======================
// AUTH ROUTES
// =======================
app.post('/api/admin/login', loginLimiter, (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Code required' });

    if (code === process.env.ADMIN_CODE) {
        req.session.isAdmin = true;
        req.session.save(err => {
            if (err) return res.status(500).json({ error: 'Session error' });
            return res.json({ success: true });
        });
    } else {
        return res.status(401).json({ error: 'Invalid code' });
    }
});

app.post('/api/admin/logout', (req, res) => {
    req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/admin/check', (req, res) => {
    res.json({ authenticated: !!(req.session && req.session.isAdmin) });
});

// =======================
// CAR ROUTES
// =======================
app.get('/api/cars', async (req, res) => {
    try {
        const cars = await Car.find({ status: 'available' }).sort({ createdAt: -1 });
        res.json(cars.map(carOut));
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch cars" });
    }
});

app.get('/api/cars/:id', async (req, res) => {
    try {
        const car = await Car.findById(req.params.id);
        if (!car) return res.status(404).json({ error: "Not found" });
        res.json(carOut(car));
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch car" });
    }
});

app.post('/api/cars', requireAdmin, async (req, res) => {
    try {
        const { make, model, year, price, mileage, color, description, image, images } = req.body;
        if (!make || !model || !price) return res.status(400).json({ error: "Make, model, price required" });

        let imgs = [];
        if (Array.isArray(images) && images.length) imgs = images.slice(0, 10);
        else if (image) imgs = [image];

        const car = await new Car({
            make: make.trim(), model: model.trim(),
            year: year ? Number(year) : null,
            price: Number(price),
            mileage: mileage ? Number(mileage) : null,
            color: color || null, description: description || null,
            image: imgs[0] || null, images: imgs
        }).save();

        res.status(201).json({ success: true, ...carOut(car) });
    } catch (err) {
        console.error('❌ ADD CAR:', err.message);
        res.status(500).json({ error: "Failed to add car" });
    }
});

app.put('/api/cars/:id', requireAdmin, async (req, res) => {
    try {
        const { make, model, year, price, mileage, color, description, image, images } = req.body;
        let imgs = [];
        if (Array.isArray(images) && images.length) imgs = images.slice(0, 10);
        else if (image) imgs = [image];

        await Car.findByIdAndUpdate(req.params.id, {
            make, model,
            year: year ? Number(year) : null,
            price: Number(price),
            mileage: mileage ? Number(mileage) : null,
            color, description,
            image: imgs[0] || null,
            images: imgs
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Failed to update car" });
    }
});

app.delete('/api/cars/:id', requireAdmin, async (req, res) => {
    try {
        await Car.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Failed to delete car" });
    }
});

app.post('/api/sell', requireAdmin, async (req, res) => {
    try {
        await Car.findByIdAndUpdate(req.body.id, { status: 'sold', soldDate: new Date().toISOString() });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Failed to sell car" });
    }
});

app.get('/api/sold', requireAdmin, async (req, res) => {
    try {
        const sold = await Car.find({ status: 'sold' }).sort({ soldDate: -1 });
        res.json(sold.map(carOut));
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch sold cars" });
    }
});

app.post('/api/restore', requireAdmin, async (req, res) => {
    try {
        await Car.findByIdAndUpdate(req.body.id, { status: 'available', soldDate: null });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Restore failed" });
    }
});

// =======================
// ENQUIRY ROUTES
// =======================
app.post('/api/enquiries', async (req, res) => {
    try {
        const { carId, carMake, carModel, carYear, name, phone, email, message } = req.body;
        if (!name) return res.status(400).json({ error: "Name is required" });

        const enquiry = await new Enquiry({
            carId: carId || null, carMake: carMake || null,
            carModel: carModel || null, carYear: carYear || null,
            name, phone: phone || null, email: email || null,
            message: message || null, status: 'new'
        }).save();

        res.json({ success: true, id: enquiry._id });
    } catch (err) {
        console.error('❌ ENQUIRY:', err.message);
        res.status(500).json({ error: "Failed to submit enquiry" });
    }
});

app.get('/api/enquiries', requireAdmin, async (req, res) => {
    try {
        const data = await Enquiry.find().sort({ createdAt: -1 });
        res.json(data.map(enqOut));
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch enquiries" });
    }
});

app.get('/api/enquiries/:id', requireAdmin, async (req, res) => {
    try {
        const e = await Enquiry.findById(req.params.id);
        if (!e) return res.status(404).json({ error: "Not found" });
        res.json(enqOut(e));
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch enquiry" });
    }
});

app.put('/api/enquiries/:id/replied', requireAdmin, async (req, res) => {
    try {
        await Enquiry.findByIdAndUpdate(req.params.id, { status: 'replied', repliedAt: new Date().toISOString() });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Failed to update enquiry" });
    }
});

app.delete('/api/enquiries/:id', requireAdmin, async (req, res) => {
    try {
        await Enquiry.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Failed to delete enquiry" });
    }
});

// =======================
// ANALYTICS
// =======================
app.get('/api/analytics/enquiries-per-day', requireAdmin, async (req, res) => {
    try {
        const data = await Enquiry.aggregate([
            { $group: { _id: { $substr: ["$createdAt", 0, 10] }, total: { $sum: 1 } } },
            { $sort: { _id: 1 } },
            { $project: { date: "$_id", total: 1, _id: 0 } }
        ]);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: "Analytics failed" });
    }
});

app.get('/api/analytics/top-cars', requireAdmin, async (req, res) => {
    try {
        const data = await Enquiry.aggregate([
            { $group: { _id: "$carId", make: { $first: "$carMake" }, model: { $first: "$carModel" }, total: { $sum: 1 } } },
            { $sort: { total: -1 } }, { $limit: 5 }
        ]);
        res.json(data.map(d => ({ id: d._id, make: d.make || '?', model: d.model || '?', total: d.total })));
    } catch (err) {
        res.status(500).json({ error: "Analytics failed" });
    }
});

app.get('/api/analytics/conversion', requireAdmin, async (req, res) => {
    try {
        const enquiries = await Enquiry.countDocuments();
        const sold      = await Car.countDocuments({ status: 'sold' });
        res.json({ enquiries, sold, conversionRate: enquiries ? ((sold / enquiries) * 100).toFixed(1) : 0 });
    } catch (err) {
        res.status(500).json({ error: "Analytics failed" });
    }
});

// =======================
// STATIC + PAGE ROUTES
// =======================

// Root → redirect to login
app.get('/', (req, res) => res.redirect('/admin/login'));

// Login — public
app.get('/admin/login', (req, res) => {
    if (req.session && req.session.isAdmin) return res.redirect('/admin/dashboard');
    res.sendFile(path.join(__dirname, 'admin', 'login.html'));
});

// /admin root → login
app.get('/admin', (req, res) => res.redirect('/admin/login'));

// Protected pages
app.get('/admin/dashboard', requireAdminPage, (req, res) => {
    res.sendFile(path.join(__dirname, 'admin', 'dashboard.html'));
});

app.get('/admin/enquiries', requireAdminPage, (req, res) => {
    res.sendFile(path.join(__dirname, 'admin', 'que.html'));
});

// Protected static admin assets
app.use('/admin', requireAdminPage, express.static(path.join(__dirname, 'admin')));

// 404
app.use((req, res) => res.status(404).json({ error: `${req.method} ${req.url} not found` }));

app.listen(PORT, () => console.log(`🚗 T&M Admin running on http://localhost:${PORT}`));
