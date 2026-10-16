"""Usage: transcribe.py <audio-path>. Prints the Spanish transcript as one line; errors go to stderr, exit non-zero.
Exit 3: the real duration is over 10 min or unknown (nothing is transcribed)."""
import os
import sys

os.environ["HF_HUB_OFFLINE"] = "1"  # the model must already be in the HF cache; audio never leaves the Mac

import av

MAX_SECONDS = 600


def duration_seconds(path):
    # The sender declares `seconds` in WhatsApp metadata; this reads the file itself before any transcription work.
    with av.open(path) as c:
        if c.duration is not None:
            return c.duration / av.time_base
        s = c.streams.audio[0] if c.streams.audio else None
        return float(s.duration * s.time_base) if s and s.duration is not None and s.time_base else None


def main():
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    seconds = duration_seconds(sys.argv[1])
    if seconds is None or seconds > MAX_SECONDS:
        print(f"audio duration {seconds} s is unknown or over {MAX_SECONDS} s: not transcribed", file=sys.stderr)
        return 3
    from faster_whisper import WhisperModel  # after the duration gate: loading it is the slow part

    model_id = os.environ.get("WHA_STT_MODEL", "deepdml/faster-whisper-large-v3-turbo-ct2")
    model = WhisperModel(model_id, device="cpu", compute_type="int8", local_files_only=True)
    segments, _ = model.transcribe(sys.argv[1], language="es", vad_filter=True)
    print(" ".join(" ".join(s.text for s in segments).split()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
