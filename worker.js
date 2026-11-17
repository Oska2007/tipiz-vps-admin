const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// මේක තමයි අපේ Background Worker එක
async function processVideo(jobData) {
  const { title, url, subtitleUrl } = jobData;
  const tempDir = path.join(__dirname, 'temp');
  
  // Temp folder එක නැත්නම් හදන්න
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

  const rawVideoPath = path.join(tempDir, 'raw_video.mp4');
  const outputVideoPath = path.join(tempDir, 'output_x264.mp4');
  const subtitlePath = path.join(tempDir, 'subtitle.vtt');

  console.log(`[Job Started] ${title}`);

  try {
    // 1. Video එක ඩවුන්ලෝඩ් කිරීම
    console.log(`[1/4] Downloading video from: ${url}`);
    const response = await axios({ 
      url, 
      method: 'GET', 
      responseType: 'stream',
      headers: {
        // මේක තමයි වැදගත්ම: අපි බ්‍රව්සර් එකකින් එනවා වගේ පෙන්නන්න ඕන
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    // 2. Subtitle එක ඩවුන්ලෝඩ් කිරීම (තියෙනවා නම්)
    let hasSubtitle = false;
    if (subtitleUrl) {
      console.log(`[2/4] Downloading subtitle...`);
      const subRes = await axios({ url: subtitleUrl, method: 'GET', responseType: 'stream' });
      const subWriter = fs.createWriteStream(subtitlePath);
      subRes.data.pipe(subWriter);
      await new Promise((resolve) => subWriter.on('finish', resolve));
      hasSubtitle = true;
    }

    // 3. FFmpeg හරහා Process කිරීම (Subtitle Embed + x264 Check)
    console.log(`[3/4] Processing with FFmpeg... (This may take a while)`);
    
    // FFmpeg Command එක හදමු
    let ffmpegCmd = `ffmpeg -y -i "${rawVideoPath}" `;
    
    // Subtitle එකක් තියෙනවා නම් ඒක ඇතුළට දාන්න
    if (hasSubtitle) {
      ffmpegCmd += `-i "${subtitlePath}" -c:v copy -c:a copy -c:s mov_text `;
    } else {
      ffmpegCmd += `-c:v copy -c:a copy `;
    }
    
    ffmpegCmd += `-movflags +faststart "${outputVideoPath}"`;

    exec(ffmpegCmd, (error, stdout, stderr) => {
      if (error) {
        console.error(`FFmpeg Error: ${error.message}`);
        return;
      }
      console.log(`[4/4] ✅ Video Processed Successfully! Ready for Upload.`);
      
      // මෙතන තමයි පස්සේ අපි R2 සහ Telegram අප්ලෝඩ් කරන්නේ
      // uploadToR2(outputVideoPath);
      // uploadToTelegram(outputVideoPath);
      
      // වැඩේ ඉවර වුණාම Temp file මකන්න
      // fs.unlinkSync(rawVideoPath);
    });

  } catch (err) {
    console.error(`Job Failed: ${err.message}`);
  }
}

module.exports = { processVideo };