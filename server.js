require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const session = require('express-session');
const cloudinary = require('cloudinary').v2;

const app = express();
const PORT = process.env.PORT || 3000;

// =======================
// LOGGER
// =======================
const logDir = path.join(__dirname, 'logs');

if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir);
}

const logFile = path.join(logDir, 'app.log');

function writeLog(type, message, meta = {}) {
    const entry = {
        time: new Date().toISOString(),
        type,
        message,
        meta
    };

    fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');

    console.log(
        `[${entry.time}] ${type.toUpperCase()}: ${message}`,
        meta
    );
}

const logger = {
    info: (msg, meta) => writeLog('info', msg, meta),
    success: (msg, meta) => writeLog('success', msg, meta),
    warn: (msg, meta) => writeLog('warn', msg, meta),
    error: (msg, meta) => writeLog('error', msg, meta),
};

// =======================
// ASYNC HANDLER
// =======================
const asyncHandler = fn => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

// =======================
// ENV CHECKS
// =======================
const requiredEnv = [
    'MONGO_URI',
    'ADMIN_CODE',
    'SESSION_SECRET',
    'CLOUDINARY_CLOUD_NAME',
    'CLOUDINARY_API_KEY',
    'CLOUDINARY_API_SECRET'
];

for (const envVar of requiredEnv) {
    if (!process.env[envVar]) {
        console.error(`❌ Missing ${envVar}`);
        process.exit(1);
    }
}

// =======================
// CLOUDINARY CONFIG
// =======================
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

// =======================
// CLOUDINARY HELPERS
// =======================
async function uploadImage(imageStr) {
    if (!imageStr) return null;

    if (imageStr.includes('res.cloudinary.com')) {
        return imageStr;
    }

    const result = await cloudinary.uploader.upload(imageStr, {
        folder: 'tmmotors',
        resource_type: 'image',
    });

    return result.secure_url;
}

async function uploadImages(imagesArr = []) {
    const uploaded = [];

    for (const img of imagesArr) {
        try {
            const url = await uploadImage(img);

            if (url) uploaded.push(url);

        } catch (err) {
            logger.error('Image upload failed', {
                error: err.message
            });
        }
    }

    return uploaded;
}

async function deleteCloudinaryImage(imageUrl) {
    try {
        if (!imageUrl || !imageUrl.includes('res.cloudinary.com')) return;

        const parts = imageUrl.split('/');
        const filename = parts[parts.length - 1].split('.')[0];
        const folder = parts[parts.length - 2];
        const publicId = `${folder}/${filename}`;

        await cloudinary.uploader.destroy(publicId);

        logger.success('Cloudinary image deleted', {
            publicId
        });

    } catch (err) {
        logger.error('Cloudinary delete failed', {
            error: err.message
        });
    }
}

// =======================
// TRUST PROXY
// =======================
app.set('trust proxy', 1);

// =======================
// MIDDLEWARE
// =======================
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use(cors({
    origin: true,
    credentials: true
}));

app.use(helmet({
    contentSecurityPolicy: false
}));

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
        sameSite: process.env.NODE_ENV === 'production'
            ? 'none'
            : 'lax',
        maxAge: 8 * 60 * 60 * 1000
    }
}));

// =======================
// RATE LIMITERS
// =======================
app.use('/api', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000
}));

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,

    message: {
        error: 'Too many attempts. Try again in 15 minutes.'
    },

    handler: (req, res) => {

        logger.warn('Login rate limit exceeded', {
            ip: req.ip
        });

        res.status(429).json({
            error: 'Too many attempts. Try again later.'
        });
    }
});

// =======================
// DATABASE
// =======================
mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
    maxPoolSize: 10,
    heartbeatFrequencyMS: 10000,
})
.then(() => logger.success('MongoDB connected'))
.catch(err => {
    logger.error('MongoDB connection failed', {
        error: err.message
    });

    process.exit(1);
});

mongoose.connection.on('disconnected', () => {
    logger.warn('MongoDB disconnected');
});

mongoose.connection.on('reconnected', () => {
    logger.success('MongoDB reconnected');
});

mongoose.connection.on('error', (err) => {
    logger.error('MongoDB error', {
        error: err.message
    });
});

// =======================
// SCHEMAS
// =======================
const carSchema = new mongoose.Schema({

    make: {
        type: String,
        required: true
    },

    model: {
        type: String,
        required: true
    },

    year: Number,

    price: {
        type: Number,
        required: true
    },

    mileage: Number,
    color: String,
    description: String,

    image: String,

    images: [String],

    status: {
        type: String,
        default: 'available'
    },

    soldDate: String,

    createdAt: {
        type: String,
        default: () => new Date().toISOString()
    }

});

const enquirySchema = new mongoose.Schema({

    carId: {
        type: String,
        default: null
    },

    carMake: String,
    carModel: String,
    carYear: Number,

    name: {
        type: String,
        required: true
    },

    phone: String,
    email: String,
    message: String,

    status: {
        type: String,
        default: 'new'
    },

    repliedAt: String,

    createdAt: {
        type: String,
        default: () => new Date().toISOString()
    }

});

const preOrderSchema = new mongoose.Schema({

    name: {
        type: String,
        required: true
    },

    phone: String,
    email: String,

    make: {
        type: String,
        required: true
    },

    model: {
        type: String,
        required: true
    },

    year: String,
    spec: String,
    transmission: String,
    color1: String,
    color2: String,
    budget: String,
    extraNotes: String,

    status: {
        type: String,
        default: 'new'
    },

    createdAt: {
        type: String,
        default: () => new Date().toISOString()
    }

});

// =======================
// AUDIT LOG SCHEMA
// =======================
const auditSchema = new mongoose.Schema({

    action: String,
    target: String,
    targetId: String,

    details: Object,

    createdAt: {
        type: String,
        default: () => new Date().toISOString()
    }

});

const Car = mongoose.model('Car', carSchema);
const Enquiry = mongoose.model('Enquiry', enquirySchema);
const PreOrder = mongoose.model('PreOrder', preOrderSchema);
const Audit = mongoose.model('Audit', auditSchema);

// =======================
// NOTIFICATION SYSTEM
// =======================
async function notify({
    action,
    target,
    targetId,
    details = {}
}) {

    logger.success(action, details);

    try {

        await Audit.create({
            action,
            target,
            targetId,
            details
        });

    } catch (err) {

        logger.error('Audit failed', {
            error: err.message
        });

    }
}

// =======================
// HELPERS
// =======================
function carOut(c) {

    const obj = c.toObject();

    obj.id = obj._id.toString();

    if (!obj.images || !obj.images.length) {
        obj.images = obj.image
            ? [obj.image]
            : [];
    }

    return obj;
}

function enqOut(e) {
    const obj = e.toObject();
    obj.id = obj._id.toString();
    return obj;
}

function preOrderOut(p) {
    const obj = p.toObject();
    obj.id = obj._id.toString();
    return obj;
}

// =======================
// AUTH MIDDLEWARE
// =======================
function requireAdmin(req, res, next) {

    if (req.session && req.session.isAdmin) {
        return next();
    }

    logger.warn('Unauthorized API access', {
        ip: req.ip,
        route: req.originalUrl
    });

    return res.status(401).json({
        error: 'Unauthorized'
    });
}

function requireAdminPage(req, res, next) {

    if (req.session && req.session.isAdmin) {
        return next();
    }

    logger.warn('Unauthorized page access', {
        ip: req.ip,
        route: req.originalUrl
    });

    return res.redirect('/admin/login');
}

// =======================
// HEALTH CHECK
// =======================
app.get('/health', asyncHandler(async (req, res) => {

    const state = mongoose.connection.readyState;

    if (state === 1) {

        return res.status(200).json({
            status: 'ok',
            db: 'connected'
        });

    }

    return res.status(503).json({
        status: 'error',
        db: 'disconnected'
    });

}));

// =======================
// AUTH ROUTES
// =======================
app.post('/api/admin/login',
    loginLimiter,
    asyncHandler(async (req, res) => {

        const { code } = req.body;

        if (!code) {
            return res.status(400).json({
                error: 'Code required'
            });
        }

        if (code !== process.env.ADMIN_CODE) {

            logger.warn('Failed admin login', {
                ip: req.ip
            });

            return res.status(401).json({
                error: 'Invalid code'
            });
        }

        req.session.isAdmin = true;

        req.session.save(async err => {

            if (err) {

                logger.error('Session save failed', {
                    error: err.message
                });

                return res.status(500).json({
                    error: 'Session error'
                });
            }

            await notify({
                action: 'ADMIN_LOGIN',
                target: 'session',
                details: {
                    ip: req.ip
                }
            });

            res.json({
                success: true,
                message: 'Login successful'
            });

        });

    })
);

// =======================
// ADD CAR
// =======================
app.post('/api/cars',
    requireAdmin,
    asyncHandler(async (req, res) => {

        const {
            make,
            model,
            year,
            price,
            mileage,
            color,
            description,
            image,
            images
        } = req.body;

        if (!make || !model || !price) {

            return res.status(400).json({
                error: 'Make, model, and price required'
            });
        }

        let rawImgs = [];

        if (Array.isArray(images) && images.length) {
            rawImgs = images.slice(0, 10);
        } else if (image) {
            rawImgs = [image];
        }

        logger.info('Uploading car images', {
            count: rawImgs.length
        });

        const uploadedImgs = await uploadImages(rawImgs);

        const car = await new Car({

            make: make.trim(),
            model: model.trim(),

            year: year
                ? Number(year)
                : null,

            price: Number(price),

            mileage: mileage
                ? Number(mileage)
                : null,

            color: color || null,
            description: description || null,

            image: uploadedImgs[0] || null,
            images: uploadedImgs

        }).save();

        await notify({

            action: 'CAR_CREATED',
            target: 'car',
            targetId: car._id.toString(),

            details: {
                make: car.make,
                model: car.model,
                price: car.price
            }

        });

        res.status(201).json({

            success: true,
            message: 'Car added successfully',
            car: carOut(car)

        });

    })
);

// =======================
// DELETE CAR
// =======================
app.delete('/api/cars/:id',
    requireAdmin,
    asyncHandler(async (req, res) => {

        const car = await Car.findById(req.params.id);

        if (!car) {

            return res.status(404).json({
                error: 'Car not found'
            });
        }

        if (car.images?.length) {

            for (const img of car.images) {
                await deleteCloudinaryImage(img);
            }

        }

        await Car.findByIdAndDelete(req.params.id);

        await notify({

            action: 'CAR_DELETED',
            target: 'car',
            targetId: req.params.id,

            details: {
                make: car.make,
                model: car.model
            }

        });

        res.json({

            success: true,
            message: 'Car deleted successfully'

        });

    })
);

// =======================
// SELL CAR
// =======================
app.post('/api/sell',
    requireAdmin,
    asyncHandler(async (req, res) => {

        await Car.findByIdAndUpdate(
            req.body.id,
            {
                status: 'sold',
                soldDate: new Date().toISOString()
            }
        );

        await notify({

            action: 'CAR_SOLD',
            target: 'car',
            targetId: req.body.id

        });

        res.json({

            success: true,
            message: 'Car marked as sold'

        });

    })
);

// =======================
// ENQUIRIES
// =======================
app.post('/api/enquiries',
    asyncHandler(async (req, res) => {

        const {
            carId,
            carMake,
            carModel,
            carYear,
            name,
            phone,
            email,
            message
        } = req.body;

        if (!name) {

            return res.status(400).json({
                error: 'Name is required'
            });
        }

        const enquiry = await new Enquiry({

            carId: carId || null,
            carMake: carMake || null,
            carModel: carModel || null,
            carYear: carYear || null,

            name,

            phone: phone || null,
            email: email || null,
            message: message || null,

            status: 'new'

        }).save();

        await notify({

            action: 'ENQUIRY_CREATED',
            target: 'enquiry',
            targetId: enquiry._id.toString(),

            details: {
                customer: name
            }

        });

        res.status(201).json({

            success: true,
            message: 'Enquiry submitted successfully',
            id: enquiry._id

        });

    })
);

// =======================
// PREORDERS
// =======================
app.post('/api/preorders',
    asyncHandler(async (req, res) => {

        const {
            name,
            phone,
            email,
            make,
            model,
            year,
            spec,
            transmission,
            color1,
            color2,
            budget,
            extraNotes
        } = req.body;

        if (!name || !make || !model) {

            return res.status(400).json({
                error: 'Name, make, and model required'
            });
        }

        const order = await new PreOrder({

            name,

            phone: phone || null,
            email: email || null,

            make: make.trim(),
            model: model.trim(),

            year: year || null,
            spec: spec || null,
            transmission: transmission || null,
            color1: color1 || null,
            color2: color2 || null,
            budget: budget || null,
            extraNotes: extraNotes || null,

            status: 'new'

        }).save();

        await notify({

            action: 'PREORDER_CREATED',
            target: 'preorder',
            targetId: order._id.toString(),

            details: {
                customer: name,
                make,
                model
            }

        });

        res.status(201).json({

            success: true,
            message: 'Pre-order submitted successfully',
            id: order._id

        });

    })
);

// =======================
// STATIC ROUTES
// =======================
app.get('/', (req, res) => {
    res.redirect('/admin/login');
});

app.get('/admin/login', (req, res) => {

    if (req.session?.isAdmin) {
        return res.redirect('/admin/dashboard');
    }

    res.sendFile(path.join(__dirname, 'admin', 'login.html'));

});

app.get('/admin/dashboard',
    requireAdminPage,
    (req, res) => {

        res.sendFile(
            path.join(__dirname, 'admin', 'dashboard.html')
        );

    }
);

app.use('/admin',
    requireAdminPage,
    express.static(path.join(__dirname, 'admin'))
);

// =======================
// 404
// =======================
app.use((req, res) => {

    logger.warn('404 route', {
        method: req.method,
        route: req.originalUrl
    });

    res.status(404).json({
        error: `${req.method} ${req.url} not found`
    });

});

// =======================
// GLOBAL ERROR HANDLER
// =======================
app.use((err, req, res, next) => {

    logger.error(err.message, {

        route: req.originalUrl,
        method: req.method,
        stack: err.stack

    });

    res.status(500).json({
        error: 'Internal server error'
    });

});

// =======================
// SERVER START
// =======================
app.listen(PORT, () => {

    logger.success(`T&M Admin running`, {
        port: PORT
    });

});
