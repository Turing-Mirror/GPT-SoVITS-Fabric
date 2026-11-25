"""Legacy UI presentation. Classification stays in the native shared crate.

Each generator invocation and child process owns its evidence. No historical log
tail is read. If the host is unavailable, use the catalog's unknown fallback.
"""
import contextvars
import functools
import html
import inspect
import json
import os
from pathlib import Path
import subprocess
import tempfile
import traceback
import uuid

_run = contextvars.ContextVar("fabric_diagnostic_run", default=None)
_catalogs = json.loads((Path(__file__).resolve().parents[1] / "configs/diagnostic_locales.json").read_text(encoding="utf-8"))


def catalog():
    return _catalogs.get(os.environ.get("FABRIC_DIAGNOSTICS_LOCALE", "zh-CN"), _catalogs["zh-CN"])


def diagnose(raw, feature="other", stage=None, batch=None, exit_code=None, retry_safe=False):
    run = _run.get()
    if run:
        feature, stage, batch = run["feature"], run["stage"], run["batch"]
        raw = "\n".join(run["failures"] + [raw])
        exit_code = run["exit_code"]
        retry_safe = True
    evidence = dict(feature=feature, stage=stage, text=raw, exit_code=exit_code,
                    error_id=run["error_id"] if run else str(uuid.uuid4()),
                    context=dict(outcome="failed", retry_safe=retry_safe,
                                 batch={stage: int(batch)} if batch is not None and stage else None))
    executable = os.environ.get("FABRIC_DIAGNOSTICS_EXE")
    if executable:
        try:
            result = subprocess.run([executable, "--diagnose-stdin"], input=json.dumps(evidence),
                                    encoding="utf-8", capture_output=True, timeout=20,
                                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            result.check_returncode()
            value = json.loads(result.stdout)
            if value.get("schema") == 1:
                return value
        except Exception:
            raw += "\n[diagnostic host unavailable]\n" + traceback.format_exc()
    msg = lambda key: dict(key=key, params={})
    return dict(schema=1, error_id=evidence["error_id"], code="diag.unknown",
                title=msg("diag.title." + feature), cause=msg("diag.cause.unknown"),
                steps=([msg("diag.step.retry")] if retry_safe else []) + [msg("diag.step.copyAndCommunity")],
                actions=[], detail=dict(text=raw, truncated=bool(executable), log_ref=None))


def failure_html(raw, feature="other", **context):
    d = diagnose(raw, feature, **context)
    words = catalog()
    def resolve(message):
        text = words[message["key"]]
        for key, value in message.get("params", {}).items():
            text = text.replace("{" + key + "}", str(value))
        return text
    title, cause = resolve(d["title"]), resolve(d["cause"])
    steps = [resolve(step) for step in d["steps"]]
    detail = d["detail"]["text"] + "\n\nerror_id: " + d["error_id"]
    copy = "\n".join([title, cause] + [f"{i + 1}. {step}" for i, step in enumerate(steps)] + [detail])
    esc = html.escape
    return (f'<section role="alert"><strong>{esc(title)}</strong><p>{esc(cause)}</p><ol>'
            + "".join(f"<li>{esc(step)}</li>" for step in steps) + "</ol>"
            + f'<button type="button" class="fabric-copy-error" data-copy="{esc(copy, quote=True)}" '
              f'data-copied="{esc(words["ui.error.copied"])}" data-failed="{esc(words["ui.error.copyFailed"])}">'
              f'{esc(words["diag.action.copy_error"])}</button>'
            + f'<details><summary>{esc(words["ui.error.details"])}</summary><pre style="white-space:pre-wrap">'
              f'{esc(detail)}</pre></details></section>')


COPY_HEAD = """<script>
document.addEventListener('click', async function(event) {
  const button = event.target.closest('.fabric-copy-error');
  if (!button) return;
  try { await navigator.clipboard.writeText(button.dataset.copy); button.textContent = button.dataset.copied; }
  catch (_) { button.textContent = button.dataset.failed; }
});
</script>"""


def warn(raw, feature="other"):
    import gradio as gr
    gr.Warning(failure_html(raw, feature), duration=0)


class Popen(subprocess.Popen):
    """Keep complete output for a failed child; never mix successful fallbacks."""
    def __init__(self, *args, **kwargs):
        self._evidence = tempfile.TemporaryFile() if _run.get() is not None else None
        if self._evidence:
            kwargs.update(stdout=self._evidence, stderr=subprocess.STDOUT)
        try:
            super().__init__(*args, **kwargs)
        except Exception:
            if self._evidence:
                self._evidence.close()
            raise

    def wait(self, *args, **kwargs):
        code = super().wait(*args, **kwargs)
        if self._evidence:
            if code and _run.get() is not None:
                self._evidence.seek(0)
                _run.get()["failures"].append(self._evidence.read().decode("utf-8", errors="replace"))
                _run.get()["exit_code"] = code
            self._evidence.close()
            self._evidence = None
        return code


def operation(feature, stage=None):
    def decorate(fn):
        @functools.wraps(fn)
        def generator(*args, **kwargs):
            bound = inspect.signature(fn).bind(*args, **kwargs)
            state = dict(feature=feature, stage=stage, batch=bound.arguments.get("batch_size"),
                         failures=[], exit_code=None, error_id=str(uuid.uuid4()))
            iterator = fn(*args, **kwargs)
            while True:
                token = _run.set(state)
                try:
                    value = next(iterator)
                except StopIteration:
                    return
                except Exception:
                    # Reuse the legacy warning surface; no additional dialog.
                    warn(traceback.format_exc(), feature)
                    return
                finally:
                    _run.reset(token)
                yield value
        return generator
    return decorate


def terminal_failure():
    state = _run.get()
    return bool(state and state["failures"])
