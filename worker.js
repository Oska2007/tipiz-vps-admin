const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { pipeline } = require('stream/promises');
const FormData = require('form-data');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { v4: uuidv4 } = require('uuid');

const s3Client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

async function processVideo(jobData) {
  const { title, url, subtitleUrl } = jobData;
  const tempDir = path.join(__dirname, 'temp');
  
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const rawVideoPath = path.join(tempDir, 'raw_video.mp4');
  const outputVideoPath = path.join(tempDir, 'output_x264.mp4');
  const subtitlePath = path.join(tempDir, 'subtitle.vtt');

  console.log(`[Job Started] ${title}`);

  try {
    // 1. Download Video
    console.log(`[1/4] Downloading video from: ${url}`);
    const response = await axios({ 
      url, method: 'GET', responseType: 'stream',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    await pipeline(response.data, fs.createWriteStream(rawVideoPath));
    
    const stats = fs.statSync(rawVideoPath);
    console.log(`✅ Video downloaded. Size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

    // 2. Download Subtitle
    let hasSubtitle = false;
    if (subtitleUrl) {
      console.log(`[2/4] Downloading subtitle...`);
      try {
        const subRes = await axios({ url: subtitleUrl, method: 'GET', responseType: 'stream', headers: { 'User-Agent': 'Mozilla/5.0' } });
        await pipeline(subRes.data, fs.createWriteStream(subtitlePath));
        hasSubtitle = true;
        console.log(`✅ Subtitle downloaded.`);
      } catch (e) { console.log(`⚠️ Subtitle failed.`); }
    }

    // 3. FFmpeg Process
    console.log(`[3/4] Processing with FFmpeg...`);
    let ffmpegCmd = `ffmpeg -y -i "${rawVideoPath}" `;
    if (hasSubtitle) ffmpegCmd += `-i "${subtitlePath}" -c:v copy -c:a copy -c:s mov_text `;
    else ffmpegCmd += `-c:v copy -c:a copy `;
    ffmpegCmd += `-movflags +faststart "${outputVideoPath}"`;

    await new Promise((resolve, reject) => {
      exec(ffmpegCmd, (error) => {
        if (error) return reject(error);
        resolve();
      });
    });
    console.log(`✅ FFmpeg Processed.`);

    // 4. Upload (R2 & Telegram)
    console.log(`[4/4] Uploading...`);
    
    const permanentId = uuidv4();
    const r2Key = `videos/${permanentId}.mp4`;

    // 4.1 R2 Upload
    console.log(`☁️ Uploading to Cloudflare R2 as ${r2Key}...`);
    const fileStream = fs.createReadStream(outputVideoPath);
    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: r2Key,
      Body: fileStream,
      ContentType: 'video/mp4'
    }));
    console.log(`✅ R2 Upload Complete!`);

    // 4.2 Telegram Upload
    console.log(`✈️ Uploading to Telegram...`);
    const form = new FormData();
    form.append('chat_id', process.env.TG_CHAT_ID);
    form.append('video', fs.createReadStream(outputVideoPath));
    form.append('caption', `🎬 ${title}\nID: ${permanentId}`);

    try {
      await axios.post(`https://api.telegram.org/bot${process.env.TG_BOT_TOKEN}/sendVideo`, form, {
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      });
      console.log(`✅ Telegram Upload Complete!`);
    } catch (tgErr) {
      console.log(`❌ Telegram Upload Failed: ${tgErr.message}`);
    }

    console.log(`✅ [DONE] Video ready! Permanent ID: ${permanentId}`);
    
    // Cleanup Temp files
    fs.unlinkSync(rawVideoPath);
    fs.unlinkSync(outputVideoPath);
    if (hasSubtitle) fs.unlinkSync(subtitlePath);

  } catch (err) {
    console.error(`Job Failed: ${err.message}`);
    // Cleanup on error
    if (fs.existsSync(rawVideoPath)) fs.unlinkSync(rawVideoPath);
    if (fs.existsSync(outputVideoPath)) fs.unlinkSync(outputVideoPath);
  }
}

module.exports = { processVideo };