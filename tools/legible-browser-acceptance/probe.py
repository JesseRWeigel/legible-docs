"""ChromeDriver W3C input + Chrome accessibility tree for exact synthetic CI fixture."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile
import time
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
import re

LABELS = ["Jump to deadline", "Deadline location", "Deadline details",
          "Calendar begins", "Distinct deadline: 18 October",
          "Call registration for assistance.", "End of notice"]
TAB = "\ue004"
ENTER = "\ue007"


def check(condition, message):
    if not condition:
        raise AssertionError(message)


class Driver:
    def __init__(self, url):
        self.url = url
        self.session_id = None

    def call(self, method, endpoint, params=None):
        path = ("/session/" + self.session_id if self.session_id else "") + endpoint
        body = None if params is None else json.dumps(params).encode()
        req = Request(self.url + path, body, {"Content-Type": "application/json"}, method=method)
        try:
            with urlopen(req, timeout=15) as response:
                return json.load(response)["value"]
        except HTTPError as exc:
            raise RuntimeError(f"WebDriver {method} {endpoint}: {exc.read().decode()[:1500]}") from exc

    def script(self, js):
        return self.call("POST", "/execute/sync", {"script": js, "args": []})

    def key(self, value):
        self.call("POST", "/actions", {"actions": [{"type": "key", "id": "keyboard",
                    "actions": [{"type": "keyDown", "value": value},
                                {"type": "keyUp", "value": value}]}]})

    def cdp(self, name):
        return self.call("POST", "/goog/cdp/execute", {"cmd": name, "params": {}})


def accessibility(driver):
    nodes = driver.cdp("Accessibility.getFullAXTree")["nodes"]
    by_id = {item["nodeId"]: item for item in nodes}
    root = next(item for item in nodes if item.get("role", {}).get("value") == "RootWebArea")
    ordered = []
    seen = set()

    def visit(item):
        if item["nodeId"] in seen:
            return
        seen.add(item["nodeId"])
        if not item.get("ignored"):
            ordered.append((item.get("role", {}).get("value"), item.get("name", {}).get("value")))
        for name in item.get("childIds", []):
            if name in by_id:
                visit(by_id[name])

    visit(root)
    return ordered


def snapshot(driver, file):
    driver.call("POST", "/url", {"url": "about:blank"})
    driver.call("POST", "/url", {"url": file.resolve().as_uri()})
    dom = driver.script("""
        return {title:document.title,
          anchorCount:document.querySelectorAll('#deadline').length,
          deadlineCopies:document.body.innerText.split('Distinct deadline: 18 October').length - 1,
          targetHref:document.querySelector('#jump')?.getAttribute('href')};
    """)
    ax = accessibility(driver)
    active = "return document.activeElement.id"
    tabs = []
    for _ in range(5):
        driver.key(TAB)
        tabs.append(driver.script(active))
        if tabs[-1] == "jump":
            break
    driver.key(ENTER)
    target = driver.script("""
        return {hash:location.hash,
          id:document.querySelector(':target')?.id ?? null,
          focus:document.activeElement.id,
          targetText:document.querySelector(':target')?.innerText.trim() ?? null};
    """)
    after = []
    for _ in range(2):
        driver.key(TAB)
        after.append(driver.script(active))
    return {"dom": dom, "ax": ax, "tabs": tabs, "target": target, "after": after}


def verify_pair(base, fixed):
    for state in (base, fixed):
        check("Registration evidence" in state["dom"]["title"], "wrong document loaded")
        check(state["dom"]["targetHref"] == "#deadline", "fixture jump link missing")
        check(state["tabs"] == ["", "jump"], f"expected skip link then jump, got {state['tabs']}")
        check(state["target"]["hash"] == "#deadline", "Enter did not follow real link")
    check(base["dom"]["anchorCount"] == 0 and base["target"]["id"] is None,
          "negative control unexpectedly resolves the deadline anchor")
    check(base["dom"]["deadlineCopies"] == 2, "negative control did not duplicate the deadline")
    check(fixed["dom"]["anchorCount"] == 1 and fixed["target"]["id"] == "deadline",
          "fixed anchor did not resolve uniquely")
    check(fixed["target"]["focus"] == "deadline", "real fragment navigation did not focus the target")
    check(fixed["target"]["targetText"].startswith("Deadline location"),
          "fragment target points at the wrong content")
    check(fixed["after"] == ["details", "finish"],
          f"unexpected keyboard order after the anchor: {fixed['after']}")
    check(fixed["dom"]["deadlineCopies"] == 1, "fixed page still duplicates nested content")
    for text, count in (("Distinct deadline: 18 October", 2),):
        check(base["ax"].count(("StaticText", text)) == count,
              "negative control AX tree did not expose two deadline strings")
    fixed_text = [name for role, name in fixed["ax"] if role == "StaticText"]
    for label in LABELS:
        check(fixed_text.count(label) == 1, f"fixed AX tree did not expose one {label!r}")
    indices = [fixed_text.index(label) for label in LABELS]
    check(indices == sorted(indices), f"fixed AX tree has unexpected reading order: {indices}")
    for pair in (("table", "Session schedule"), ("columnheader", "Session date"),
                 ("rowheader", "Field botany"), ("cell", "Distinct deadline: 18 October")):
        check(fixed["ax"].count(pair) == 1, f"fixed AX tree did not preserve {pair!r}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("base", type=Path)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("--driver", required=True)
    parser.add_argument("--chrome", required=True)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="legible-ax-") as work:
        log = Path(work) / "driver.log"
        with log.open("wb") as stream, subprocess.Popen(
            [args.driver, "--port=0"], stdout=stream, stderr=subprocess.STDOUT,
        ) as proc:
            driver = None
            try:
                for _ in range(100):
                    match = re.search(r"started successfully on port (\d+)", log.read_text())
                    if match:
                        driver = Driver("http://127.0.0.1:" + match.group(1))
                        try:
                            if driver.call("GET", "/status").get("ready"):
                                break
                        except URLError:
                            pass
                    if proc.poll() is not None:
                        raise RuntimeError("ChromeDriver quit before serving: " + log.read_text())
                    time.sleep(.1)
                else:
                    raise RuntimeError("ChromeDriver readiness timed out: " + log.read_text())
                session = driver.call("POST", "/session", {"capabilities": {"alwaysMatch": {
                    "browserName": "chrome", "goog:chromeOptions": {"binary": args.chrome, "args": [
                        "--headless=new", "--no-first-run", "--disable-background-networking",
                        "--window-size=1200,800", "--user-data-dir=" + str(Path(work) / "profile"),
                    ]},
                }}})
                driver.session_id = session["sessionId"]
                base = snapshot(driver, args.base)
                fixed = snapshot(driver, args.candidate)
                print(json.dumps({"chrome": session["capabilities"]["browserVersion"],
                                  "base": base, "candidate": fixed}, indent=2), flush=True)
                verify_pair(base, fixed)
                print("PASS: real Chrome fragment focus, keyboard order, nested-row and AX tree controls")
            finally:
                try:
                    if driver and driver.session_id:
                        driver.call("DELETE", "")
                finally:
                    proc.terminate()
                    try:
                        proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        proc.kill()


if __name__ == "__main__":
    main()
