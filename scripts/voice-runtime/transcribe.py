"""Compatibility entry point for the main process; same contract as asr.py."""

from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from asr import main

if __name__ == "__main__":
    sys.exit(main())
