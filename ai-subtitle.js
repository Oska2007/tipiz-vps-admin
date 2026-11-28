'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Generate local AI subtitles with Whisper Medium + NLLB.
 * Returns { sinhalaSrt, englishSrt }.
 */
function generateAiSubtitles(inputPath, outputPrefix, updateStatus = () => {}) {
    return new Promise((resolve, reject) => {
        const projectDir = __dirname;
        const pythonPath = process.env.AI_PYTHON_PATH ||
            path.join(projectDir, 'ai-venv', 'bin', 'python');
        const scriptPath = process.env.AI_SUBTITLE_SCRIPT ||
            path.join(projectDir, 'generate_subtitles.py');
        const model = process.env.WHISPER_MODEL || 'medium';
        const threads = process.env.AI_CPU_THREADS || '1';

        if (!fs.existsSync(pythonPath)) {
            return reject(new Error(
                `AI Python not found: ${pythonPath}. Install the venv as described in README.md`
            ));
        }
        if (!fs.existsSync(scriptPath)) {
            return reject(new Error(`AI subtitle script not found: ${scriptPath}`));
        }

        const child = spawn(pythonPath, [
            scriptPath,
            '--input', inputPath,
            '--output-prefix', outputPrefix,
            '--model', model,
            '--threads', String(threads)
        ], {
            cwd: projectDir,
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', chunk => {
            const text = chunk.toString();
            stdout += text;
            if (stdout.length > 30000) stdout = stdout.slice(-30000);

            for (const line of text.split(/\r?\n/).filter(Boolean)) {
                console.log(`[AI Subtitle] ${line}`);
                updateStatus('Generating AI subtitles', null, { detail: line });
            }
        });

        child.stderr.on('data', chunk => {
            const text = chunk.toString();
            stderr += text;
            if (stderr.length > 30000) stderr = stderr.slice(-30000);
            for (const line of text.split(/\r?\n/).filter(Boolean)) {
                console.error(`[AI Subtitle] ${line}`);
            }
        });

        child.on('error', reject);

        child.on('close', code => {
            if (code !== 0) {
                return reject(new Error(
                    `AI subtitle process exited with code ${code}: ${stderr.slice(-5000)}`
                ));
            }

            const sinhalaSrt = `${outputPrefix}_sin.srt`;
            const englishSrt = `${outputPrefix}_eng.srt`;

            if (!fs.existsSync(sinhalaSrt) || !fs.existsSync(englishSrt)) {
                return reject(new Error(
                    `AI subtitle output missing. ${stdout.slice(-3000)}`
                ));
            }

            resolve({ sinhalaSrt, englishSrt });
        });
    });
}

module.exports = { generateAiSubtitles };
