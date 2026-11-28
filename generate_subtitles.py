#!/usr/bin/env python3
"""
Local AI subtitle generator for Tipiz.
Creates:
  <prefix>_eng.srt
  <prefix>_sin.srt

Requires faster-whisper, torch, transformers, sentencepiece.
Models are downloaded once and cached locally.
"""
import argparse
import os
import re
import sys
from pathlib import Path

def srt_time(seconds: float) -> str:
    seconds = max(0.0, float(seconds))
    ms = round(seconds * 1000)
    hours, ms = divmod(ms, 3_600_000)
    minutes, ms = divmod(ms, 60_000)
    secs, ms = divmod(ms, 1000)
    return f"{hours:02}:{minutes:02}:{secs:02},{ms:03}"

def write_srt(path: Path, cues):
    with path.open("w", encoding="utf-8") as f:
        for i, (start, end, text) in enumerate(cues, 1):
            clean = re.sub(r"\s+", " ", str(text)).strip()
            if not clean:
                continue
            f.write(f"{i}\n{srt_time(start)} --> {srt_time(end)}\n{clean}\n\n")

def split_for_translation(cues, max_chars=850):
    """Combine nearby cue text for context, while retaining cue indexes."""
    groups = []
    current = []
    size = 0
    for idx, cue in enumerate(cues):
        txt = cue[2].strip()
        if not txt:
            continue
        if current and size + len(txt) > max_chars:
            groups.append(current)
            current, size = [], 0
        current.append((idx, txt))
        size += len(txt) + 1
    if current:
        groups.append(current)
    return groups

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="Input video/audio file")
    parser.add_argument("--output-prefix", required=True, help="Output path prefix")
    parser.add_argument("--model", default=os.getenv("WHISPER_MODEL", "medium"))
    parser.add_argument("--threads", type=int, default=int(os.getenv("AI_CPU_THREADS", "1")))
    parser.add_argument("--cache-dir", default=os.getenv("AI_MODEL_CACHE", str(Path.home() / ".cache" / "tipiz-ai")))
    args = parser.parse_args()

    input_path = Path(args.input).resolve()
    prefix = Path(args.output_prefix).resolve()
    prefix.parent.mkdir(parents=True, exist_ok=True)
    cache_dir = Path(args.cache_dir).resolve()
    cache_dir.mkdir(parents=True, exist_ok=True)

    # Import here so a missing dependency gives a clear error.
    try:
        from faster_whisper import WhisperModel
    except Exception as e:
        print("ERROR: faster-whisper is not installed. Run pip install -r ai-requirements.txt", file=sys.stderr)
        raise

    print(f"[AI subtitles] Loading Whisper {args.model} on CPU (int8)...", flush=True)
    whisper = WhisperModel(
        args.model,
        device="cpu",
        compute_type="int8",
        cpu_threads=max(1, args.threads),
        num_workers=1,
        download_root=str(cache_dir / "whisper"),
    )

    # Transcribe original speech, preserving timings.
    print("[AI subtitles] Transcribing audio...", flush=True)
    segments_iter, info = whisper.transcribe(
        str(input_path),
        task="transcribe",
        beam_size=5,
        vad_filter=True,
        condition_on_previous_text=True,
        word_timestamps=False,
    )
    original_cues = []
    for seg in segments_iter:
        text = (seg.text or "").strip()
        if text:
            original_cues.append((float(seg.start), float(seg.end), text))

    if not original_cues:
        raise RuntimeError("Whisper did not detect speech in this video.")

    detected = (getattr(info, "language", None) or "unknown").lower()
    print(f"[AI subtitles] Detected language: {detected}; cues: {len(original_cues)}", flush=True)

    # English subtitles: if source speech is English, use the transcript.
    # Otherwise ask Whisper's multilingual model to translate the audio to English.
    english_cues = original_cues
    if detected != "en":
        print("[AI subtitles] Creating English translation with Whisper...", flush=True)
        translated_iter, _ = whisper.transcribe(
            str(input_path),
            task="translate",
            beam_size=5,
            vad_filter=True,
            condition_on_previous_text=True,
            word_timestamps=False,
        )
        english_cues = []
        for seg in translated_iter:
            text = (seg.text or "").strip()
            if text:
                english_cues.append((float(seg.start), float(seg.end), text))
        if not english_cues:
            raise RuntimeError("Whisper English translation produced no speech.")

    # Free Whisper memory before loading the separate translation model.
    # This matters on small VPS instances.
    import gc
    del whisper
    gc.collect()

    # Sinhala subtitles: translate the English cue text locally using NLLB-200.
    print("[AI subtitles] Loading local NLLB Sinhala translation model...", flush=True)
    try:
        import torch
        from transformers import AutoTokenizer, AutoModelForSeq2SeqLM
    except Exception as e:
        print("ERROR: Translation dependencies are missing. Install ai-requirements.txt", file=sys.stderr)
        raise

    model_name = "facebook/nllb-200-distilled-600M"
    tokenizer = AutoTokenizer.from_pretrained(
        model_name,
        src_lang="eng_Latn",
        cache_dir=str(cache_dir / "nllb"),
    )
    translator = AutoModelForSeq2SeqLM.from_pretrained(
        model_name,
        cache_dir=str(cache_dir / "nllb"),
        torch_dtype=torch.float32,
    )
    translator.eval()
    try:
        torch.set_num_threads(max(1, args.threads))
    except Exception:
        pass

    sinhala_texts = [""] * len(english_cues)
    groups = split_for_translation(english_cues)
    target_id = tokenizer.convert_tokens_to_ids("sin_Sinh")

    with torch.inference_mode():
        for group_num, group in enumerate(groups, 1):
            texts = [t for _, t in group]
            inputs = tokenizer(
                texts,
                return_tensors="pt",
                padding=True,
                truncation=True,
                max_length=512,
            )
            generated = translator.generate(
                **inputs,
                forced_bos_token_id=target_id,
                max_length=512,
                num_beams=4,
            )
            outputs = tokenizer.batch_decode(generated, skip_special_tokens=True)
            for (cue_idx, _), translated in zip(group, outputs):
                sinhala_texts[cue_idx] = translated.strip()
            if group_num % 10 == 0 or group_num == len(groups):
                print(f"[AI subtitles] Sinhala translation {group_num}/{len(groups)} groups", flush=True)

    sinhala_cues = []
    for idx, cue in enumerate(english_cues):
        translated = sinhala_texts[idx].strip()
        if not translated:
            translated = cue[2]
        sinhala_cues.append((cue[0], cue[1], translated))

    eng_path = Path(str(prefix) + "_eng.srt")
    sin_path = Path(str(prefix) + "_sin.srt")
    write_srt(eng_path, english_cues)
    write_srt(sin_path, sinhala_cues)

    # Release large models before process exit.
    del translator, tokenizer
    gc.collect()
    print(f"[AI subtitles] Created: {eng_path}", flush=True)
    print(f"[AI subtitles] Created: {sin_path}", flush=True)

if __name__ == "__main__":
    main()
