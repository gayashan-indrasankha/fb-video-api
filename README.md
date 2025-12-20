# FB Video CDN Extractor API

Facebook video CDN URL extractor for Zinema.lk shots page.

## Features

- **HTTP-first extraction** (fast ~200-500ms) using regex patterns
- **Puppeteer fallback** (reliable ~3-8s) when HTTP fails
- CORS enabled for cross-origin requests
- Health check endpoint for monitoring

## Deployment to Render.com

1. Push this folder to a GitHub repository

2. Go to [Render.com](https://render.com) and create a new **Web Service**

3. Connect your GitHub repository

4. Configure:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Environment**: Node

5. Deploy and copy the URL (e.g., `https://fb-video-api.onrender.com`)

## API Endpoints

### Health Check
```
GET /health
```
Response:
```json
{
  "status": "ok",
  "timestamp": "2024-12-21T00:00:00.000Z",
  "uptime": 12345,
  "version": "1.0.0"
}
```

### Extract Video URL
```
GET /api/extract?url=<FACEBOOK_VIDEO_URL>
```
Response:
```json
{
  "success": true,
  "url": "https://scontent.xx.fbcdn.net/...",
  "method": "http",
  "duration_ms": 450
}
```

## Local Testing

```bash
cd fb-video-api
npm install
npm start
```

Then test:
```
http://localhost:3333/api/extract?url=https://www.facebook.com/share/v/1AKqPLQU7T/
```
