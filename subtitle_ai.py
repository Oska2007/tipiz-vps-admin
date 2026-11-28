#!/usr/bin/env python3
"""Local-only subtitle generator for TIPIZ VPS Admin.

Speech recognition: Faster-Whisper (CPU INT8)
English -> Sinhala translation: HPLT English-Sinhala Marian model, converted to CTranslate2 INT8
No hosted API or API key is used.
"""

from __future__ import annotations

import argparse
import gc
import json
import os
import re
import sys
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
try:
    from dotenv import load_dotenv
    load_dotenv(BASE_DIR / ".env")
except Exception:
    pass

MODELS_DIR = BASE_DIR / "models"
HF_HOME = Path(os.environ.get("HF_HOME", MODELS_DIR / "huggingface"))
WHISPER_CACHE = Path(os.environ.get("FASTER_WHISPER_CACHE", MODELS_DIR / "faster-whisper"))
TRANSLATION_REPO = os.environ.get(
    "TRANSLATION_REPO", "HPLT/translate-en-si-v2.0-hplt_opus"
)
TRANSLATION_DIR = MODELS_DIR / "hplt-en-si-ct2-int8"

HF_HOME.mkdir(parents=True, exist_ok=True)
WHISPER_CACHE.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("HF_HOME", str(HF_HOME))
os.environ.setdefault("HUGGINGFACE_HUB_CACHE", str(HF_HOME / "hub"))
os.environ.setdefault("TRANSFORMERS_CACHE", str(HF_HOME / "transformers"))
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("OMP_NUM_THREADS", os.environ.get("TRANSLATION_CPU_THREADS", "1"))
os.environ.setdefault("MKL_NUM_THREADS", os.environ.get("TRANSLATION_CPU_THREADS", "1"))


def emit(event: str, **data: object) -> None:
    print(json.dumps({"event": event, **data}, ensure_ascii=False), flush=True)


def progress(stage: str, percent: int | None = None, detail: str = "") -> None:
    emit("progress", stage=stage, progress=percent, detail=detail)


def format_timestamp(seconds: float, srt: bool = True) -> str:
    milliseconds = max(0, int(round(float(seconds) * 1000)))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1000)
    separator = "," if srt else "."
    return f"{hours:02d}:{minutes:02d}:{secs:02d}{separator}{millis:03d}"


def clean_text(text: str) -> str:
    text = str(text or "").replace("\x00", " ")
    text = re.sub(r"\s+", " ", text).strip()
    text = text.replace("-->", "→")
    return text


def write_srt(cues: list[dict[str, object]], output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    blocks: list[str] = []
    for index, cue in enumerate(cues, start=1):
        text = clean_text(str(cue.get("text", "")))
        if not text:
            continue
        start = float(cue["start"])
        end = float(cue["end"])
        if end <= start:
            end = start + 0.8
        blocks.append(
            f"{index}\n{format_timestamp(start)} --> {format_timestamp(end)}\n{text}"
        )
    if not blocks:
        raise RuntimeError("No subtitle cues were generated.")
    output_path.write_text("\n\n".join(blocks) + "\n", encoding="utf-8")


def parse_subtitle_file(input_path: Path) -> list[dict[str, object]]:
    raw = input_path.read_text(encoding="utf-8-sig", errors="replace")
    raw = raw.replace("\r\n", "\n").replace("\r", "\n")
    blocks = re.split(r"\n\s*\n", raw.strip())
    cues: list[dict[str, object]] = []

    timestamp_pattern = re.compile(
        r"^(?P<start>(?:\d{1,2}:)?\d{2}:\d{2}[,.]\d{1,3})\s+-->\s+"
        r"(?P<end>(?:\d{1,2}:)?\d{2}:\d{2}[,.]\d{1,3})(?:\s+.*)?$"
    )

    def to_seconds(value: str) -> float:
        value = value.replace(",", ".")
        parts = value.split(":")
        if len(parts) == 2:
            hours = 0
            minutes = int(parts[0])
            seconds_part = parts[1]
        elif len(parts) == 3:
            hours = int(parts[0])
            minutes = int(parts[1])
            seconds_part = parts[2]
        else:
            raise ValueError(f"Invalid timestamp: {value}")
        seconds, millis = seconds_part.split(".", 1)
        millis = (millis + "000")[:3]
        return hours * 3600 + minutes * 60 + int(seconds) + int(millis) / 1000

    for block in blocks:
        lines = block.split("\n")
        timing_index = next((i for i, line in enumerate(lines) if "-->" in line), -1)
        if timing_index < 0:
            continue
        match = timestamp_pattern.match(lines[timing_index].strip())
        if not match:
            continue
        try:
            start = to_seconds(match.group("start"))
            end = to_seconds(match.group("end"))
        except (ValueError, IndexError):
            continue
        if end <= start:
            continue
        text_lines = lines[timing_index + 1 :]
        text = " ".join(line.strip() for line in text_lines if line.strip())
        text = re.sub(r"<[^>]*>", "", text)
        text = re.sub(r"\{\\[^}]+\}", "", text)
        text = clean_text(text)
        if text:
            cues.append({"start": start, "end": end, "text": text})

    return cues


def generate_english_subtitles(audio_path: Path, output_path: Path) -> None:
    progress("Loading Faster-Whisper model", 5, "Loading local speech-recognition model.")
    from faster_whisper import WhisperModel

    model_name = os.environ.get("WHISPER_MODEL", "small")
    cpu_threads = max(1, int(os.environ.get("WHISPER_CPU_THREADS", "1")))
    model = WhisperModel(
        model_name,
        device="cpu",
        compute_type=os.environ.get("WHISPER_COMPUTE_TYPE", "int8"),
        cpu_threads=cpu_threads,
        num_workers=1,
        download_root=str(WHISPER_CACHE),
    )

    progress("Transcribing audio to English", 12, "Whisper is recognizing speech and translating non-English speech to English.")
    segments, info = model.transcribe(
        str(audio_path),
        task="translate",
        beam_size=max(1, int(os.environ.get("WHISPER_BEAM_SIZE", "5"))),
        best_of=1,
        vad_filter=True,
        condition_on_previous_text=False,
        word_timestamps=False,
        without_timestamps=False,
    )

    cues: list[dict[str, object]] = []
    for segment in segments:
        text = clean_text(segment.text)
        if not text:
            continue
        cues.append({
            "start": float(segment.start),
            "end": float(segment.end),
            "text": text,
        })

    if not cues:
        raise RuntimeError("Whisper did not detect any speech in the audio.")

    write_srt(cues, output_path)
    language = getattr(info, "language", "unknown")
    probability = getattr(info, "language_probability", None)
    probability_text = f" ({probability:.0%})" if isinstance(probability, (int, float)) else ""
    emit("message", message=f"Whisper detected source language: {language}{probability_text}; English subtitle cues: {len(cues)}")
    progress("English subtitles generated", 55, f"Created {len(cues)} timestamped English subtitle cues.")

    del model
    gc.collect()


def ensure_hplt_translation_model() -> tuple[Path, Path]:
    """Download the CC-BY-4.0 HPLT EN->SI model and convert it to CT2 INT8 once.

    HPLT publishes Marian weights plus a SentencePiece model and vocabulary.
    CTranslate2's Marian converter expects YAML/JSON token->index vocabularies,
    so the published ordered vocabulary is converted into two JSON vocab files.
    """
    import ctranslate2
    from huggingface_hub import hf_hub_download

    model_dir = MODELS_DIR / "hplt-source"
    model_dir.mkdir(parents=True, exist_ok=True)

    progress("Checking HPLT Sinhala translation model", 58, "Preparing local English-to-Sinhala model files.")
    weights = Path(hf_hub_download(
        repo_id=TRANSLATION_REPO,
        filename="model.npz.best-chrf.npz",
        cache_dir=str(HF_HOME),
    ))
    spm_path = Path(hf_hub_download(
        repo_id=TRANSLATION_REPO,
        filename="model.en-si.spm",
        cache_dir=str(HF_HOME),
    ))
    vocab_path = Path(hf_hub_download(
        repo_id=TRANSLATION_REPO,
        filename="model.en-si.vocab",
        cache_dir=str(HF_HOME),
    ))

    if not TRANSLATION_DIR.exists() or not (TRANSLATION_DIR / "model.bin").exists():
        progress("Converting Sinhala model to CPU INT8", 64, "One-time conversion; this may use CPU and temporary disk space.")
        token_to_id: dict[str, int] = {}
        with vocab_path.open("r", encoding="utf-8") as vocab_file:
            for token_id, line in enumerate(vocab_file):
                line = line.rstrip("\r\n")
                if not line:
                    continue
                # HPLT's SentencePiece vocabulary stores: token<TAB>score.
                # Preserve its original row index because it is the model ID.
                token = line.rsplit("\t", 1)[0]
                token_to_id[token] = token_id

        if len(token_to_id) < 1000:
            raise RuntimeError("The downloaded HPLT vocabulary file is incomplete or invalid.")

        source_vocab = model_dir / "source-vocab.yml"
        target_vocab = model_dir / "target-vocab.yml"
        source_vocab.write_text(json.dumps(token_to_id, ensure_ascii=False), encoding="utf-8")
        target_vocab.write_text(json.dumps(token_to_id, ensure_ascii=False), encoding="utf-8")

        converter = ctranslate2.converters.MarianConverter(
            str(weights),
            [str(source_vocab), str(target_vocab)],
        )
        converter.convert(
            str(TRANSLATION_DIR),
            quantization="int8",
            force=True,
        )

    return TRANSLATION_DIR, spm_path


def translate_to_sinhala(input_path: Path, output_path: Path) -> None:
    cues = parse_subtitle_file(input_path)
    if not cues:
        raise RuntimeError("The English subtitle file contains no valid timestamped cues.")

    import ctranslate2
    import sentencepiece as sentencepiece

    model_path, spm_path = ensure_hplt_translation_model()
    cpu_threads = max(1, int(os.environ.get("TRANSLATION_CPU_THREADS", "1")))
    beam_size = max(1, int(os.environ.get("TRANSLATION_NUM_BEAMS", "4")))
    batch_size = max(1, min(8, int(os.environ.get("TRANSLATION_BATCH_SIZE", "4"))))
    max_decoding_length = max(64, int(os.environ.get("TRANSLATION_MAX_DECODING_LENGTH", "256")))

    progress("Loading HPLT Sinhala translation model", 68, "Loading the local INT8 model.")
    sp = sentencepiece.SentencePieceProcessor(model_file=str(spm_path))
    translator = ctranslate2.Translator(
        str(model_path),
        device="cpu",
        compute_type="int8",
        inter_threads=1,
        intra_threads=cpu_threads,
    )

    translated_cues: list[dict[str, object]] = []
    total = len(cues)

    for start_index in range(0, total, batch_size):
        batch = cues[start_index : start_index + batch_size]
        tokenized = [sp.encode(str(cue["text"]), out_type=str) for cue in batch]
        results = translator.translate_batch(
            tokenized,
            beam_size=beam_size,
            max_decoding_length=max_decoding_length,
            return_scores=False,
        )
        if len(results) != len(batch):
            raise RuntimeError("HPLT returned an unexpected number of translated subtitle cues.")

        for cue, result in zip(batch, results):
            hypothesis = result.hypotheses[0] if result.hypotheses else []
            # Marian may return EOS in the hypothesis; do not display it.
            hypothesis = [token for token in hypothesis if token not in {"</s>", "<pad>"}]
            translated = sp.decode(hypothesis).strip() if hypothesis else ""
            translated_text = clean_text(translated)
            if not translated_text:
                raise RuntimeError("HPLT returned an empty Sinhala translation for a subtitle cue.")
            translated_cues.append({
                "start": cue["start"],
                "end": cue["end"],
                "text": translated_text,
            })

        done = min(total, start_index + len(batch))
        pct = 70 + int((done / total) * 28)
        progress("Translating subtitles to Sinhala", pct, f"Translated {done}/{total} subtitle cues.")

    write_srt(translated_cues, output_path)
    emit("message", message=f"HPLT Sinhala translation completed for {len(translated_cues)} subtitle cues.")
    progress("Sinhala subtitle generated", 100, f"Created {len(translated_cues)} Sinhala subtitle cues.")


def download_models() -> None:
    progress("Downloading Faster-Whisper model", 5, "This is a one-time model download.")
    from faster_whisper import WhisperModel

    model_name = os.environ.get("WHISPER_MODEL", "small")
    model = WhisperModel(
        model_name,
        device="cpu",
        compute_type=os.environ.get("WHISPER_COMPUTE_TYPE", "int8"),
        cpu_threads=1,
        num_workers=1,
        download_root=str(WHISPER_CACHE),
    )
    del model
    gc.collect()

    progress("Downloading and converting HPLT Sinhala model", 55, "Downloading the model weights and preparing local INT8 files.")
    ensure_hplt_translation_model()
    progress("AI models ready", 100, "Whisper and HPLT models are downloaded and ready. No API key is required.")

def main() -> int:
    parser = argparse.ArgumentParser(description="TIPIZ local AI subtitle helper")
    subparsers = parser.add_subparsers(dest="command", required=True)

    generate_parser = subparsers.add_parser("generate")
    generate_parser.add_argument("--audio", required=True, type=Path)
    generate_parser.add_argument("--output", required=True, type=Path)

    translate_parser = subparsers.add_parser("translate")
    translate_parser.add_argument("--input", required=True, type=Path)
    translate_parser.add_argument("--output", required=True, type=Path)

    subparsers.add_parser("download-models")

    args = parser.parse_args()
    try:
        if args.command == "generate":
            if not args.audio.is_file():
                raise FileNotFoundError(f"Audio file does not exist: {args.audio}")
            generate_english_subtitles(args.audio, args.output)
        elif args.command == "translate":
            if not args.input.is_file():
                raise FileNotFoundError(f"Subtitle file does not exist: {args.input}")
            translate_to_sinhala(args.input, args.output)
        elif args.command == "download-models":
            download_models()
        return 0
    except Exception as error:  # Sent back to Node.js and surfaced in the job details.
        emit("message", message=f"ERROR: {type(error).__name__}: {error}")
        print(f"{type(error).__name__}: {error}", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
