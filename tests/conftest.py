import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

os.environ["ENGINE"] = "fake"
os.environ["FAKE_DELAY"] = "0.05"
os.environ["DATA_DIR"] = tempfile.mkdtemp(prefix="proyavka-test-")
