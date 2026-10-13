"""Copy this helper into a Python backend; report only after initialization."""
import json


def report_ready(url):
    print(json.dumps({"type": "dev-ready", "url": url}), flush=True)
