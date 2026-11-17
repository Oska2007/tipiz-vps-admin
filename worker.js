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
  const { title, url, subtitlePath } = jobData;
  const tempDir = path.join(__dirname, 'temp');
  
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const rawVideoPath = path.join(tempDir, `raw_${Date.now()}.mp4`);
  const outputVideoPath = path.join(tempDir, `out_${Date.now()}.mp4`);

  console.log(`\n[Job Started] ${title}`);

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

    // 2. FFmpeg Process
    console.log(`[2/4] Processing with FFmpeg...`);
    let ffmpegCmd = `ffmpeg -y -i "${rawVideoPath}" `;
    
    if (subtitlePath && fs.existsSync(subtitlePath)) {
      // Subtitle එකක් තියෙනවා නම් embed කරන්න
      ffmpegCmd += `-i "${subtitlePath}" -c:v copy -c:a copy -c:s mov_text `;
      console.log(`   -> Embedding subtitle...`);
    } else {
      ffmpegCmd += `-c:v copy -c:a copy `;
    }
    
    ffmpegCmd += `-movflags +faststart "${outputVideoPath}"`;

    await new Promise((resolve, reject) => {
      exec(ffmpegCmd, (error) => error ? reject(error) : resolve());
    });
    console.log(`✅ FFmpeg Processed.`);

    // 3. Upload & Sync
    console.log(`[3/4] Uploading...`);
    const permanentId = uuidv4();
    const r2Key = `videos/${permanentId}.mp4`;
    let telegramFileId = null;

    // 3.1 R2 Upload
    console.log(`☁️ Uploading to Cloudflare R2...`);
    const fileStream = fs.createReadStream(outputVideoPath);
    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: r2Key,
      Body: fileStream,
      ContentType: 'video/mp4'
    }));
    console.log(`✅ R2 Upload Complete!`);

    // 3.2 Telegram Upload
    console.log(`✈️ Uploading to Telegram...`);
    const form = new FormData();
    form.append('chat_id', process.env.TG_CHAT_ID);
    form.append('video', fs.createReadStream(outputVideoPath));
    form.append('caption', `🎬 ${title}\nID: ${permanentId}`);

    try {
      const tgRes = await axios.post(`https://api.telegram.org/bot${process.env.TG_BOT_TOKEN}/sendVideo`, form, {
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      });
      telegramFileId = tgRes.data.result.video.file_id;
      console.log(`✅ Telegram Upload Complete!`);
    } catch (tgErr) {
      console.log(`❌ Telegram Upload Failed: ${tgErr.message}`);
    }

    // 3.3 Cloudflare Database Sync
    console.log(`🔄 Syncing with Cloudflare Database...`);
    try {
      await axios.post(`https://tipiz.moviezonee.workers.dev/api/vps/sync`, {
        uuid: permanentId,
        title: title,
        r2_key: r2Key,
        telegram_file_id: telegramFileId,
        source_type: 'r2'
      }, {
        headers: { 'Authorization': `Bearer ${process.env.CF_VPS_API_KEY}` }
      });
      console.log(`✅ Database Sync Complete!`);
    } catch (syncErr) {
      console.error(`❌ Database Sync Failed:`, syncErr.response?.data || syncErr.message);
    }

    console.log(`✅ [DONE] Video ready! Permanent ID: ${permanentId}`);
    
    // Cleanup
    if (fs.existsSync(rawVideoPath)) fs.unlinkSync(rawVideoPath);
    if (fs.existsSync(outputVideoPath)) fs.unlinkSync(outputVideoPath);
    if (subtitlePath && fs.existsSync(subtitlePath)) fs.unlinkSync(subtitlePath);

  } catch (err) {
    console.error(`Job Failed: ${err.message}`);
    // Error වුණත් Temp files මකන්න
    if (fs.existsSync(rawVideoPath)) fs.unlinkSync(rawVideoPath);
    if (fs.existsSync(outputVideoPath)) fs.unlinkSync(outputVideoPath);
  }
}

module.exports = { processVideo };