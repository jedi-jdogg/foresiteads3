// Agent Hub for macOS: a window around the hub's web console.
// Starts the hub (which updates itself, installs packages and serves on localhost), waits until it answers,
// then shows it. Quitting the app stops the hub. External links open in the default browser.
import Cocoa
import WebKit

let resources = Bundle.main.resourceURL!
let repoPath = (try? String(contentsOf: resources.appendingPathComponent("hub.path"), encoding: .utf8))?
    .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
let hubDir = repoPath + "/agent-hub"

func readPort() -> Int {
    guard let env = try? String(contentsOfFile: hubDir + "/.env", encoding: .utf8) else { return 4747 }
    for line in env.split(separator: "\n") where line.hasPrefix("HUB_PORT=") {
        if let p = Int(line.dropFirst("HUB_PORT=".count).trimmingCharacters(in: .whitespaces)), p > 0 { return p }
    }
    return 4747
}

final class App: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var proc: Process?
    var log = ""
    var exited = false
    var exitCode: Int32 = 0
    var showing = false
    let port = readPort()
    var home: URL { URL(string: "http://127.0.0.1:\(port)/")! }

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.setActivationPolicy(.regular)
        buildMenu()
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1320, height: 880),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Agent Hub"
        window.minSize = NSSize(width: 720, height: 480)
        window.center()
        window.setFrameAutosaveName("AgentHubMain")
        window.delegate = self
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()
        web = WKWebView(frame: window.contentView!.bounds, configuration: cfg)
        web.autoresizingMask = [.width, .height]
        web.navigationDelegate = self
        web.uiDelegate = self
        window.contentView?.addSubview(web)
        renderSplash("Starting the hub…")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        startHub()
        poll(attempt: 0)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ note: Notification) { stopHub() }

    // MARK: hub process
    func startHub() {
        guard !repoPath.isEmpty, FileManager.default.fileExists(atPath: hubDir + "/start-mac.command") else {
            log = "Could not find the hub at \(hubDir). Run the installer again."
            exited = true; exitCode = 1; renderSplash("Hub not found"); return
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        // A login shell so node is found wherever it was installed (nodejs.org, Homebrew, nvm).
        p.arguments = ["-lc", "export PATH=\"/opt/homebrew/bin:/usr/local/bin:$HOME/.agent-hub/bin:$PATH\"; cd \"\(hubDir)\" && HUB_NO_OPEN=1 exec ./start-mac.command"]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { [weak self] h in
            let data = h.availableData
            guard let self = self, let text = String(data: data, encoding: .utf8), !text.isEmpty else { return }
            DispatchQueue.main.async {
                self.log += text
                if self.log.count > 20000 { self.log = String(self.log.suffix(20000)) }
                if !self.showing { self.renderSplash("Starting the hub…") }
            }
        }
        p.terminationHandler = { [weak self] proc in
            pipe.fileHandleForReading.readabilityHandler = nil
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.exited = true
                self.exitCode = proc.terminationStatus
                if !self.showing { self.renderSplash("The hub stopped") }
            }
        }
        do { try p.run(); proc = p } catch {
            log = "Could not start the hub: \(error.localizedDescription)"
            exited = true; exitCode = 1; renderSplash("Could not start")
        }
    }

    func stopHub() {
        guard let p = proc, p.isRunning else { return }
        p.terminate()
        // Give node a moment to close the port cleanly.
        let deadline = Date().addingTimeInterval(2)
        while p.isRunning && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
        if p.isRunning { kill(p.processIdentifier, SIGKILL) }
    }

    // Wait until the console answers, then load it. Gives npm install on a first run up to three minutes.
    func poll(attempt: Int) {
        if showing { return }
        if exited && exitCode != 0 { return }
        if attempt > 360 { renderSplash("The hub did not answer"); return }
        var req = URLRequest(url: home.appendingPathComponent("api/roster"))
        req.timeoutInterval = 1
        URLSession.shared.dataTask(with: req) { [weak self] _, resp, _ in
            guard let self = self else { return }
            if let r = resp as? HTTPURLResponse, r.statusCode == 200 {
                DispatchQueue.main.async {
                    self.showing = true
                    self.web.load(URLRequest(url: self.home))
                }
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.poll(attempt: attempt + 1) }
            }
        }.resume()
    }

    // MARK: splash
    func renderSplash(_ title: String) {
        let failed = exited && exitCode != 0 || title.hasPrefix("The hub") || title.hasPrefix("Could not") || title.hasPrefix("Hub not")
        let esc = log.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
        let hint = failed
            ? "<p class=hint>Something went wrong. Copy the text below and paste it to Claude, who can fix it. Then relaunch Agent Hub.</p>"
            : "<p class=hint>First launch installs packages and can take a minute. Later launches update to the latest version, then open.</p>"
        let html = """
        <!doctype html><meta charset=utf-8><style>
        :root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 -apple-system,system-ui;background:#eef1f5;color:#16212b}
        @media(prefers-color-scheme:dark){body{background:#0f1419;color:#e6ebf0}pre{background:#161c23!important;border-color:#2a333d!important}}
        .box{width:min(720px,92vw)}h1{font-size:20px;margin:0 0 6px;display:flex;align-items:center;gap:10px}
        .mark{width:28px;height:28px;border-radius:7px;background:#0f6e86;display:inline-block}
        .hint{color:#5d6b79;margin:0 0 14px}pre{background:#fff;border:1px solid #d9dfe6;border-radius:10px;padding:12px 14px;font:12.5px/1.45 ui-monospace,Menlo,monospace;white-space:pre-wrap;max-height:50vh;overflow:auto;margin:0}
        .spin{width:12px;height:12px;border:2px solid #d9dfe6;border-top-color:#0f6e86;border-radius:50%;animation:s .8s linear infinite;display:inline-block}@keyframes s{to{transform:rotate(360deg)}}
        </style><div class=box><h1><span class=mark></span>\(title) \(failed ? "" : "<span class=spin></span>")</h1>\(hint)<pre>\(esc.isEmpty ? "…" : esc)</pre></div>
        """
        web.loadHTMLString(html, baseURL: nil)
    }

    // MARK: links
    func isLocal(_ url: URL) -> Bool { url.host == "127.0.0.1" || url.host == "localhost" || url.scheme == "about" }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, !isLocal(url), action.navigationType == .linkActivated {
            NSWorkspace.shared.open(url); decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    // MARK: menu (Edit menu is what makes ⌘V paste work inside the web view)
    func buildMenu() {
        let menubar = NSMenu()
        let appItem = NSMenuItem(); menubar.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Agent Hub", action: #selector(about), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Agent Hub", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Agent Hub", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let editItem = NSMenuItem(); menubar.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit

        let viewItem = NSMenuItem(); menubar.addItem(viewItem)
        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        view.addItem(withTitle: "Open in Browser", action: #selector(openInBrowser), keyEquivalent: "b")
        view.addItem(.separator())
        view.addItem(withTitle: "Show Hub Folder in Finder", action: #selector(showFolder), keyEquivalent: "")
        viewItem.submenu = view

        let windowItem = NSMenuItem(); menubar.addItem(windowItem)
        let win = NSMenu(title: "Window")
        win.addItem(withTitle: "Minimize", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Zoom", action: #selector(NSWindow.zoom(_:)), keyEquivalent: "")
        windowItem.submenu = win
        NSApp.windowsMenu = win
        NSApp.mainMenu = menubar
    }
    @objc func reload() { if showing { web.reload() } else { poll(attempt: 0) } }
    @objc func openInBrowser() { NSWorkspace.shared.open(home) }
    @objc func showFolder() { NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: hubDir) }
    @objc func about() {
        let a = NSAlert()
        a.messageText = "Agent Hub"
        a.informativeText = "One place to brief every agent.\nFolder: \(hubDir)\nConsole: \(home.absoluteString)"
        a.runModal()
    }
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.run()
