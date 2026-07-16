// Career-Ops Web — native macOS wrapper (WKWebView).
// Replaces the Chrome --app launcher: Chrome-based windows show up in the Dock
// as "Google Chrome", and clicking that icon opens a blank new-tab window. A
// native app owns its Dock icon, so clicking it always focuses Career-Ops.
//
// Built by web/desktop/build-desktop-app.sh, which bakes WEB_DIR_PLACEHOLDER.

import Cocoa
import WebKit

// Baked in by the build script via Info.plist (plutil escapes any path safely)
let webDir: String = {
    guard let dir = Bundle.main.object(forInfoDictionaryKey: "CareerOpsWebDir") as? String else {
        fatalError("CareerOpsWebDir missing from Info.plist — rebuild with build-desktop-app.sh")
    }
    return dir
}()
let appURL = URL(string: "http://localhost:3000")!

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKUIDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var server: Process?

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()

        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1280, height: 860), configuration: cfg)
        webView.uiDelegate = self
        webView.navigationDelegate = self

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 860),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "Career-Ops"
        window.contentView = webView
        window.delegate = self
        window.setFrameAutosaveName("CareerOpsMainWindow")
        if window.frame.width < 400 { window.center() }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        showSplash()
        startServerIfNeeded { [weak self] in self?.waitAndLoad(attempt: 0) }
    }

    // ── server lifecycle ────────────────────────────────────────────────────

    func ping(_ done: @escaping (Bool) -> Void) {
        // Probe the app's own version endpoint, not just "anything answers on
        // :3000" — an unrelated dev server on the port must not be mistaken
        // for career-ops.
        var req = URLRequest(url: appURL.appendingPathComponent("api/version"))
        req.timeoutInterval = 2
        URLSession.shared.dataTask(with: req) { data, resp, _ in
            let ok = (resp as? HTTPURLResponse)?.statusCode == 200
                && data.map { String(decoding: $0, as: UTF8.self).contains("\"version\"") } == true
            done(ok)
        }.resume()
    }

    func startServerIfNeeded(_ then: @escaping () -> Void) {
        ping { up in
            DispatchQueue.main.async {
                if !up {
                    let p = Process()
                    p.executableURL = URL(fileURLWithPath: "/bin/bash")
                    // exec: bash is replaced by next, so terminate() reaches next itself
                    p.arguments = ["-c", "exec ./node_modules/.bin/next dev >> /tmp/career-ops-web.log 2>&1"]
                    p.currentDirectoryURL = URL(fileURLWithPath: webDir)
                    // GUI apps get a bare PATH without node; next's shebang is /usr/bin/env node
                    var env = ProcessInfo.processInfo.environment
                    let extra = "/usr/local/bin:/opt/homebrew/bin:\(NSHomeDirectory())/.local/bin"
                    env["PATH"] = "\(extra):\(env["PATH"] ?? "/usr/bin:/bin")"
                    p.environment = env
                    do { try p.run(); self.server = p } catch {
                        NSLog("career-ops: failed to start server: \(error)")
                    }
                }
                then()
            }
        }
    }

    func waitAndLoad(attempt: Int) {
        ping { up in
            DispatchQueue.main.async {
                if up {
                    self.webView.load(URLRequest(url: appURL))
                } else if attempt < 60 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.waitAndLoad(attempt: attempt + 1) }
                } else {
                    self.showSplash(error: "Could not reach http://localhost:3000 — check /tmp/career-ops-web.log")
                }
            }
        }
    }

    func showSplash(error: String? = nil) {
        let msg = error ?? "Starting career-ops…"
        let html = """
        <!doctype html><meta charset='utf-8'>
        <body style='margin:0;display:grid;place-items:center;height:100vh;background:#141210;color:#e8e2da;font:15px -apple-system'>
        <div style='text-align:center'><div style='font-size:34px;margin-bottom:12px'>co</div>\(msg)</div></body>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    func applicationWillTerminate(_ note: Notification) {
        if let s = server, s.isRunning { s.terminate() }
    }

    // ── window / dock behavior ──────────────────────────────────────────────

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { window?.makeKeyAndOrderFront(nil) }
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // ── link handling: keep the app in the window, the web in the browser ───

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // Host allowlist for EVERY navigation type — redirects, form posts and
        // script-driven navigations must not replace the app inside the window.
        // Non-http(s) schemes (about:blank splash, data:) stay allowed.
        if let url = navigationAction.request.url,
           let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
           url.host != "localhost", url.host != "127.0.0.1" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    // ── minimal menu so Cmd+Q/W/C/V/R work ──────────────────────────────────

    @objc func reloadPage() { webView.load(URLRequest(url: appURL)) }

    func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Reload", action: #selector(reloadPage), keyEquivalent: "r")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Quit Career-Ops", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(NSMenuItem.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit

        let winItem = NSMenuItem(); main.addItem(winItem)
        let win = NSMenu(title: "Window")
        win.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        winItem.submenu = win

        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
