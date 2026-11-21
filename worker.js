const { exec, execSync } = require('child_process');
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
  const { title, url, subtitle1, subtitle2, updateStatus } = jobData;
  const tempDir = path.join(__dirname, 'temp');
  
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const rawVideoPath = path.join(tempDir, `raw_${Date.now()}.mp4`);
  const outputVideoPath = path.join(tempDir, `out_${Date.now()}.mp4`);

  try {
    // 1. Download
    console.log(`\n[Job Started] ${title}`);
    updateStatus('Downloading video...', 10);
    console.log(`[1/5] Downloading video...`);
    
    const response = await axios({ url, method: 'GET', responseType: 'stream', headers: { 'User-Agent': 'Mozilla/5.0' } });
    await pipeline(response.data, fs.createWriteStream(rawVideoPath));
    console.log(`✅ Video downloaded.`);

    // 2. FFprobe Check
    updateStatus('Checking codec...', 25);
    console.log(`[2/5] Checking codec...`);
    let isX264 = false;
    try {
      const probe = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "${rawVideoPath}"`).toString().trim();
      isX264 = (probe === 'h264');
    } catch (e) { console.log('ffprobe failed, forcing convert.'); }

    // 3. FFmpeg Process
    let ffmpegCmd = `ffmpeg -y -i "${rawVideoPath}" `;
    
    if (subtitle1) ffmpegCmd += `-i "${subtitle1}" `;
    if (subtitle2) ffmpegCmd += `-i "${subtitle2}" `;

    ffmpegCmd += `-map 0:v -map 0:a `;
    if (subtitle1) ffmpegCmd += `-map 1:0 `;
    if (subtitle2) ffmpegCmd += `-map 2:0 `;

    if (isX264) {
      updateStatus('Fast Processing (Copying video)...', 40);
      console.log(`[3/5] Processing (Fast Copy mode)...`);
      ffmpegCmd += `-c:v copy -c:a copy `;
    } else {
      updateStatus('Transcoding to x264 (Slow)...', 40);
      console.log(`[3/5] Transcoding to x264 (Slow mode)...`);
      ffmpegCmd += `-c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k `;
    }

    if (subtitle1) {
      ffmpegCmd += `-c:s mov_text -metadata:s:s:0 language=sin -metadata:s:s:0 title="Sinhala" -disposition:s:0 default `;
      console.log(`   -> Embedding Sinhala Subtitle (Default)`);
    }
    if (subtitle2) {
      const subIndex = subtitle1 ? 1 : 0;
      ffmpegCmd += `-c:s mov_text -metadata:s:s:${subIndex} language=eng -metadata:s:s:${subIndex} title="English" `;
      console.log(`   -> Embedding English Subtitle`);
    }
    
    ffmpegCmd += `-movflags +faststart "${outputVideoPath}"`;

    await new Promise((resolve, reject) => {
      exec(ffmpegCmd, { maxBuffer: 1024 * 1024 * 100, timeout: 7200000 }, (error) => error ? reject(error) : resolve());
    });
    console.log(`✅ FFmpeg Processed.`);

    // 4. Upload
    updateStatus('Uploading to R2...', 60);
    console.log(`[4/5] Uploading to Cloudflare R2...`);
    const permanentId = uuidv4();
    const r2Key = `videos/${permanentId}.mp4`;
    const fileSize = fs.statSync(outputVideoPath).size;
    const fileSizeGB = fileSize / (1024 * 1024 * 1024);

    const fileStream = fs.createReadStream(outputVideoPath);
    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME, Key: r2Key, Body: fileStream, ContentType: 'video/mp4'
    }));
    console.log(`✅ R2 Upload Complete!`);

           // 5. Telegram Upload (With Custom Thumbnail & Duration)
    let telegramFileId = null;
    if (fileSizeGB < 1.95) { 
      updateStatus('Uploading to Telegram...', 80);
      console.log(`[5/5] Uploading to Telegram... (Size: ${fileSizeGB.toFixed(2)} GB)`);
      
      // 1. වීඩියෝ එකෙන් පොඩි පින්තූරයක් (Thumbnail) හදාගන්නවා (තත්පර 1ක තැනින්)
      const thumbPath = path.join(tempDir, `thumb_${Date.now()}.jpg`);
      console.log(`   -> Generating thumbnail...`);
      await new Promise((resolve, reject) => {
        exec(`ffmpeg -y -i "${outputVideoPath}" -ss 00:00:01 -vframes 1 -vf "scale=320:-1" "${thumbPath}"`, (err) => {
          if (err) { console.log('Thumbnail generation failed, continuing...'); resolve(); } 
          else resolve();
        });
      });

      // 2. වීඩියෝ එකේ කාලය (Duration) හොයාගන්නවා
      let duration = 0;
      try {
        const durationStr = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${outputVideoPath}"`).toString().trim();
        duration = Math.round(parseFloat(durationStr));
      } catch(e) {}

      const form = new FormData();
      form.append('chat_id', process.env.TG_CHAT_ID);
      form.append('video', fs.createReadStream(outputVideoPath)); 
      form.append('caption', `🎬 ${title}\nID: ${permanentId}`);
      
      // Thumbnail එක සහ Duration එක Telegram එකට එවන්න
      if (fs.existsSync(thumbPath)) {
        form.append('thumbnail', fs.createReadStream(thumbPath));
      }
      if (duration > 0) {
        form.append('duration', duration.toString());
      }

      try {
        const tgRes = await axios.post(`http://localhost:8081/bot${process.env.TG_BOT_TOKEN}/sendVideo`, form, {
          headers: form.getHeaders(), 
          maxBodyLength: Infinity, 
          maxContentLength: Infinity
        });
        telegramFileId = tgRes.data.result.video.file_id;
        console.log(`✅ Telegram Upload Complete! File ID: ${telegramFileId}`);
      } catch (e) { 
        console.log(`❌ TG Upload Failed: ` + (e.response?.data?.description || e.message)); 
      } finally {
        if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath); // ඉවර වුණාම Thumbnail එක මකන්න
      }
    } else {
      updateStatus('Skipping Telegram (Over 2GB limit)...', 80);
      console.log(`⚠️ Skipping Telegram (File > 1.95GB)`);
    }
    // 6. Sync DB
    updateStatus('Syncing Database...', 90);
    console.log(`[Sync] Syncing Database...`);
    await axios.post(`https://tipiz.moviezonee.workers.dev/api/vps/sync`, {
      uuid: permanentId, title: title, r2_key: r2Key, telegram_file_id: telegramFileId, source_type: 'r2'
    }, { headers: { 'Authorization': `Bearer ${process.env.CF_VPS_API_KEY}` } });
    console.log(`✅ Database Sync Complete!`);

    updateStatus('Completed!', 100);
    console.log(`✅ [DONE] Video ready! Permanent ID: ${permanentId}`);
    
    // Cleanup
    if (fs.existsSync(rawVideoPath)) fs.unlinkSync(rawVideoPath);
    if (fs.existsSync(outputVideoPath)) fs.unlinkSync(outputVideoPath);
    if (subtitle1) fs.unlinkSync(subtitle1);
    if (subtitle2) fs.unlinkSync(subtitle2);

  } catch (err) {
    updateStatus('Failed: ' + err.message, 100);
    console.log(`❌ Job Failed: ${err.message}`);
    if (fs.existsSync(rawVideoPath)) fs.unlinkSync(rawVideoPath);
    if (fs.existsSync(outputVideoPath)) fs.unlinkSync(outputVideoPath);
  }
}

module.exports = { processVideo };