const express = require('express');
const cors = require('cors');
const got = require('got');

const app = express();
const PORT = process.env.PORT || 3333;

// CORS configuration
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// ============================================
// CONFIGURATION
// ============================================
const USER_AGENT = 'facebookexternalhit/1.1';
const HTTP_TIMEOUT = 10000; // 10 seconds
const PUPPETEER_TIMEOUT = 30000; // 30 seconds

// ============================================
// HTTP EXTRACTION (FAST - Primary Method)
// ============================================

/**
 * Clean and unescape URL from Facebook's escaped format
 */
const cleanUrl = (url) => {
    if (!url) return null;
    return url
        .replace(/\\u0025/g, '%')
        .replace(/\\u003C/g, '<')
        .replace(/\\u003E/g, '>')
        .replace(/\\u0026/g, '&')
        .replace(/\\\//g, '/')
        .replace(/\\"/g, '"');
};

/**
 * Normalize Facebook URL to www version
 */
const normalizeUrl = (link) => {
    return link
        .replace('://m.facebook.com/', '://www.facebook.com/')
        .replace('://web.facebook.com/', '://www.facebook.com/')
        .replace('://touch.facebook.com/', '://www.facebook.com/')
        .replace('/share/v/', '/reel/'); // Convert share URL to reel URL format
};

/**
 * Collect ALL matches for a regex pattern in HTML.
 * Returns array of { url, index } objects.
 */
const getAllMatches = (html, regex) => {
    const results = [];
    let match;
    while ((match = regex.exec(html)) !== null) {
        const cleaned = cleanUrl(match[1]);
        if (cleaned) {
            results.push({ url: cleaned, index: match.index });
        }
    }
    return results;
};

/**
 * Extract BOTH HD and SD video URLs from HTML.
 * 
 * Strategy: Facebook pages embed multiple video objects (target + related/promoted).
 * We collect ALL HD and SD URL occurrences, then pick the LAST pair — Facebook
 * typically places the actual target video's data after related content.
 * 
 * Returns { hdUrl, sdUrl } - either or both may be null.
 */
const extractVideoUrlsFromHtml = (html) => {
    // --- Collect all HD URL matches ---
    let allHd = getAllMatches(html, /"playable_url_quality_hd"\s*:\s*"([^"]+)"/g);
    if (allHd.length === 0) {
        allHd = getAllMatches(html, /"browser_native_hd_url"\s*:\s*"([^"]+)"/g);
    }
    if (allHd.length === 0) {
        allHd = getAllMatches(html, /hd_src\s*:\s*"([^"]+)"/g);
    }

    // --- Collect all SD URL matches ---
    let allSd = getAllMatches(html, /"playable_url"\s*:\s*"([^"]+)"/g);
    if (allSd.length === 0) {
        allSd = getAllMatches(html, /"browser_native_sd_url"\s*:\s*"([^"]+)"/g);
    }
    if (allSd.length === 0) {
        allSd = getAllMatches(html, /sd_src\s*:\s*"([^"]+)"/g);
    }

    // Pick the LAST occurrence of each (target video is usually last)
    const hdUrl = allHd.length > 0 ? allHd[allHd.length - 1].url : null;
    const sdUrl = allSd.length > 0 ? allSd[allSd.length - 1].url : null;

    // Log match counts for debugging
    console.log(`   🔍 Found ${allHd.length} HD URLs, ${allSd.length} SD URLs in page`);

    return { hdUrl, sdUrl };
};

/**
 * HTTP-based extraction (fast, ~200-500ms)
 */
const extractViaHttp = async (videoUrl) => {
    const normalizedUrl = normalizeUrl(videoUrl);

    const response = await got(normalizedUrl, {
        headers: {
            'User-Agent': USER_AGENT,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate',
            'Connection': 'keep-alive',
        },
        followRedirect: true,
        timeout: { request: HTTP_TIMEOUT }
    });

    const { hdUrl, sdUrl } = extractVideoUrlsFromHtml(response.body);

    if (hdUrl || sdUrl) {
        return { success: true, hdUrl, sdUrl, method: 'http' };
    }

    return null;
};

// ============================================
// PUPPETEER EXTRACTION (FALLBACK - Slower but reliable)
// ============================================

let chromium = null;
let puppeteer = null;

/**
 * Lazy load Puppeteer and Chromium (only when needed)
 */
const loadPuppeteer = async () => {
    if (!puppeteer) {
        puppeteer = require('puppeteer-core');
        chromium = require('@sparticuz/chromium');

        // Configure chromium for Render
        chromium.setHeadlessMode = true;
        chromium.setGraphicsMode = false;
    }
    return { puppeteer, chromium };
};

/**
 * Puppeteer-based extraction (slower, ~3-8s, but more reliable)
 */
const extractViaPuppeteer = async (videoUrl) => {
    const { puppeteer, chromium } = await loadPuppeteer();

    let browser = null;

    try {
        browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        });

        const page = await browser.newPage();

        await page.setUserAgent(USER_AGENT);
        await page.setRequestInterception(true);

        // Block unnecessary resources
        page.on('request', (request) => {
            const resourceType = request.resourceType();
            if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
                request.abort();
            } else {
                request.continue();
            }
        });

        const normalizedUrl = normalizeUrl(videoUrl);
        await page.goto(normalizedUrl, {
            waitUntil: 'domcontentloaded',
            timeout: PUPPETEER_TIMEOUT
        });

        // Wait a bit for any JS to execute
        await new Promise(resolve => setTimeout(resolve, 2000));

        const html = await page.content();
        const { hdUrl, sdUrl } = extractVideoUrlsFromHtml(html);

        if (hdUrl || sdUrl) {
            return { success: true, hdUrl, sdUrl, method: 'puppeteer' };
        }

        return null;
    } finally {
        if (browser) {
            await browser.close();
        }
    }
};

// ============================================
// API ROUTES
// ============================================

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        version: '2.0.0'
    });
});

/**
 * API info endpoint
 */
app.get('/', (req, res) => {
    res.json({
        name: 'FB Video CDN Extractor API',
        version: '2.0.0',
        endpoints: {
            'GET /health': 'Health check',
            'GET /api/extract?url=<FB_URL>': 'Extract CDN URL from Facebook video (returns hd_url + sd_url)'
        }
    });
});

/**
 * Main extraction endpoint
 * Uses HTTP-first approach with Puppeteer fallback
 * Returns separate hd_url and sd_url fields
 */
app.get('/api/extract', async (req, res) => {
    const videoUrl = req.query.url;

    if (!videoUrl) {
        return res.status(400).json({
            success: false,
            error: 'Missing required parameter: url'
        });
    }

    // Validate Facebook URL
    if (!videoUrl.includes('facebook.com') && !videoUrl.includes('fb.com')) {
        return res.status(400).json({
            success: false,
            error: 'Invalid URL: Must be a Facebook video URL'
        });
    }

    console.log(`\n📥 [${new Date().toISOString()}] Extraction request`);
    console.log(`🔗 URL: ${videoUrl}`);

    const startTime = Date.now();

    try {
        // Step 1: Try HTTP extraction first (fast)
        console.log('🚀 Attempting HTTP extraction...');
        let result = await extractViaHttp(videoUrl);

        // Step 2: If HTTP fails, try Puppeteer (slower but reliable)
        if (!result) {
            console.log('⚠️ HTTP extraction failed, trying Puppeteer...');
            result = await extractViaPuppeteer(videoUrl);
        }

        const duration = Date.now() - startTime;

        if (result) {
            console.log(`✅ Success via ${result.method} in ${duration}ms`);
            console.log(`   HD: ${result.hdUrl ? 'Yes' : 'No'}, SD: ${result.sdUrl ? 'Yes' : 'No'}`);
            return res.json({
                success: true,
                hd_url: result.hdUrl || null,
                sd_url: result.sdUrl || null,
                // Backward compatible: url = HD preferred, SD fallback
                url: result.hdUrl || result.sdUrl,
                method: result.method,
                duration_ms: duration
            });
        }

        console.log(`❌ Extraction failed after ${duration}ms`);
        return res.status(404).json({
            success: false,
            error: 'Could not extract video URL. The video may be private or deleted.',
            duration_ms: duration
        });

    } catch (error) {
        const duration = Date.now() - startTime;
        console.error(`❌ Error after ${duration}ms:`, error.message);

        return res.status(500).json({
            success: false,
            error: error.message,
            duration_ms: duration
        });
    }
});

// ============================================
// SERVER STARTUP
// ============================================

app.listen(PORT, () => {
    console.log('═'.repeat(50));
    console.log('🎬 FB Video CDN Extractor API');
    console.log('═'.repeat(50));
    console.log(`✅ Server running at: http://localhost:${PORT}`);
    console.log('');
    console.log('Endpoints:');
    console.log(`  GET /health          - Health check`);
    console.log(`  GET /api/extract     - Extract video CDN URL`);
    console.log('');
    console.log('Strategy: HTTP-first with Puppeteer fallback');
    console.log('═'.repeat(50));
    console.log('');
    console.log('📋 Waiting for requests...');
});
