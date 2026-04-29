"""Run FastAPI and the React dashboard dev server with one command."""

from __future__ import annotations

import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


@dataclass
class ManagedProcess:
    name: str
    command: list[str]
    process: subprocess.Popen | None = None


def load_dotenv(path: Path = ROOT / ".env") -> None:
    if not path.exists():
        return

    for line in path.read_text(encoding="utf-8").splitlines():
        text = line.strip()
        if not text or text.startswith("#") or "=" not in text:
            continue
        key, value = text.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def npm_command() -> str:
    return "npm.cmd" if os.name == "nt" else "npm"


def start_process(name: str, command: list[str]) -> ManagedProcess:
    print(f"Starting {name}: {' '.join(command)}", flush=True)
    process = subprocess.Popen(command, cwd=ROOT)
    return ManagedProcess(name=name, command=command, process=process)


def health_url(host: str, port: str) -> str:
    url_host = "127.0.0.1" if host in {"0.0.0.0", "::"} else host
    return f"http://{url_host}:{port}/health"


def dashboard_api_healthy(host: str, port: str) -> bool:
    try:
        with urllib.request.urlopen(health_url(host, port), timeout=1.5) as response:
            return response.status == 200
    except (OSError, urllib.error.URLError):
        return False


def port_is_open(host: str, port: str) -> bool:
    try:
        with socket.create_connection((host, int(port)), timeout=1.5):
            return True
    except OSError:
        return False


def python_command() -> str:
    return os.environ.get("PYTHON_BIN") or sys.executable


def venv_python() -> Path:
    if os.name == "nt":
        return ROOT / ".venv" / "Scripts" / "python.exe"
    return ROOT / ".venv" / "bin" / "python"


def run_python_setup() -> bool:
    print("FastAPI/Uvicorn not found. Running Python backend setup...", flush=True)
    result = subprocess.run(
        [sys.executable, "scripts/setup_python.py"],
        cwd=ROOT,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        print(
            "Python backend setup failed. On Ubuntu, run `sudo apt install -y python3-venv` "
            "then run `npm run setup:python`.",
            file=sys.stderr,
            flush=True,
        )
        return False

    os.environ["PYTHON_BIN"] = str(venv_python())
    return True


def run_api_preflight(allow_setup: bool = True) -> bool:
    result = subprocess.run(
        [
            python_command(),
            "-c",
            "import fastapi, uvicorn; import src.dashboard_api; print('Dashboard API import OK')",
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode == 0:
        return True

    print("Dashboard API preflight failed.", file=sys.stderr, flush=True)
    if result.stdout.strip():
        print(result.stdout.strip(), file=sys.stderr, flush=True)
    if result.stderr.strip():
        print(result.stderr.strip(), file=sys.stderr, flush=True)
    if allow_setup and "No module named" in result.stderr:
        return run_python_setup() and run_api_preflight(allow_setup=False)
    print(
        "Fix: run `npm run setup:python` from the project root, "
        "or set PYTHON_BIN to the Python that has FastAPI/Uvicorn installed.",
        file=sys.stderr,
        flush=True,
    )
    return False


def stop_processes(processes: list[ManagedProcess]) -> None:
    for managed in processes:
        if managed.process is None:
            continue
        if managed.process.poll() is None:
            if os.name == "nt":
                managed.process.terminate()
            else:
                managed.process.send_signal(signal.SIGTERM)
    for managed in processes:
        if managed.process is None:
            continue
        try:
            managed.process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            managed.process.kill()


def start_dashboard_api(api_host: str, api_port: str) -> ManagedProcess | None:
    if dashboard_api_healthy(api_host, api_port):
        print(f"Dashboard API already running at {health_url(api_host, api_port)}", flush=True)
        return None

    if port_is_open("127.0.0.1" if api_host == "0.0.0.0" else api_host, api_port):
        print(
            f"Port {api_port} is already in use, but {health_url(api_host, api_port)} is not healthy.",
            file=sys.stderr,
            flush=True,
        )
        print("Stop the process using that port or change DASHBOARD_API_PORT.", file=sys.stderr, flush=True)
        return ManagedProcess("Dashboard API", [])

    if not run_api_preflight():
        return ManagedProcess("Dashboard API", [])

    managed = start_process(
        "Dashboard API",
            [
                python_command(),
                "-m",
                "uvicorn",
            "src.dashboard_api:app",
            "--host",
            api_host,
            "--port",
            api_port,
        ],
    )
    deadline = time.time() + 15
    while time.time() < deadline:
        code = managed.process.poll() if managed.process else 1
        if code is not None:
            print(
                f"Dashboard API exited before becoming healthy with code {code}.",
                file=sys.stderr,
                flush=True,
            )
            return ManagedProcess("Dashboard API", [])
        if dashboard_api_healthy(api_host, api_port):
            print(f"Dashboard API health check passed: {health_url(api_host, api_port)}", flush=True)
            return managed
        time.sleep(0.5)

    print(f"Dashboard API did not become healthy at {health_url(api_host, api_port)}", file=sys.stderr, flush=True)
    stop_processes([managed])
    return ManagedProcess("Dashboard API", [])


def main() -> int:
    load_dotenv()

    api_host = os.environ.get("DASHBOARD_API_HOST", "127.0.0.1")
    api_port = os.environ.get("DASHBOARD_API_PORT", "8010")
    web_host = os.environ.get("DASHBOARD_WEB_HOST", "0.0.0.0")
    web_port = os.environ.get("DASHBOARD_WEB_PORT", "5173")

    if not shutil.which(npm_command()):
        print("npm is required for the React dashboard.", file=sys.stderr)
        return 1

    api = start_dashboard_api(api_host, api_port)
    if api and api.process is None:
        return 1

    web = start_process(
        "Dashboard web",
        [
            npm_command(),
            "--prefix",
            "dashboard-react",
            "run",
            "dev",
            "--",
            "--host",
            web_host,
            "--port",
            web_port,
        ],
    )

    print(f"Dashboard API: http://{api_host}:{api_port}")
    print(f"Dashboard Web: http://localhost:{web_port}")

    processes = [process for process in [api, web] if process is not None]
    exit_code = 0
    try:
        while True:
            for managed in processes:
                if managed.process is None:
                    continue
                code = managed.process.poll()
                if code is not None:
                    exit_code = code
                    command = " ".join(managed.command)
                    raise RuntimeError(f"{managed.name} exited with code {code}: {command}")
            time.sleep(1)
    except KeyboardInterrupt:
        exit_code = 0
    except RuntimeError as error:
        print(str(error), file=sys.stderr, flush=True)
    finally:
        stop_processes(processes)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
