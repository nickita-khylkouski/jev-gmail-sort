import AppKit
import SwiftUI
import Combine

let mint = Color(red: 0.56, green: 0.94, blue: 0.77)

@MainActor final class Preferences: ObservableObject {
    @Published var useJev = UserDefaults.standard.object(forKey: "useJev") as? Bool ?? true
    @Published var bareKeys = UserDefaults.standard.object(forKey: "bareKeys") as? Bool ?? true
    @Published var days = UserDefaults.standard.object(forKey: "days") as? Int ?? 90
    @Published var cursorAnswers = UserDefaults.standard.object(forKey: "cursorAnswers") as? Bool ?? true
    @Published var gmailEnabled = UserDefaults.standard.object(forKey: "gmailEnabled") as? Bool ?? true
    @Published var writingPurpose = UserDefaults.standard.string(forKey: "writingPurpose") ?? ""
    @Published var gmailCriterion = UserDefaults.standard.string(forKey: "gmailCriterion") ?? ""
    let gmail = GmailBridge()
    @Published var paused = false
    @Published var screenAllowed = CGPreflightScreenCaptureAccess()
    @Published var accessAllowed = AXIsProcessTrusted()
    @Published var message = ""
    @Published var checking = false
    var timer: AnyCancellable?
    init() {
        timer = Timer.publish(every: 2, on: .main, in: .common).autoconnect().sink { [weak self] _ in
            self?.screenAllowed = CGPreflightScreenCaptureAccess()
            self?.accessAllowed = AXIsProcessTrusted()
        }
    }
    func save() {
        UserDefaults.standard.set(useJev, forKey: "useJev")
        UserDefaults.standard.set(bareKeys, forKey: "bareKeys")
        UserDefaults.standard.set(days, forKey: "days")
        UserDefaults.standard.set(cursorAnswers, forKey: "cursorAnswers")
        UserDefaults.standard.set(gmailEnabled, forKey: "gmailEnabled")
        UserDefaults.standard.set(gmailCriterion, forKey: "gmailCriterion")
        UserDefaults.standard.set(writingPurpose, forKey: "writingPurpose")
        message = "Settings saved. Provider keys stay on the Jev server."
    }
    @MainActor func prepareGmail() {
        do { try gmail.revealExtension(); message = "Load this existing Jev extension at chrome://extensions, then refresh Gmail." }
        catch { message = error.localizedDescription }
    }
    @MainActor func checkGmail() async {
        do { message = try await gmail.check() ? "Gmail extension connected. K ranks; L checks the pointed-at email." : "Server ready. Reload the existing Jev extension in Chrome and focus Gmail." }
        catch { message = "Start the Jev server and pair the helper, then try again." }
    }
    @MainActor func check() async {
        guard !checking else { return }
        checking = true
        defer { checking = false }
        do {
            let health = try await CompanionAPI.health()
            message = "Jev server connected · Jev key \(health.jev ? "ready" : "missing") · Exa key \(health.exa ? "ready" : "missing")"
        } catch { message = error.localizedDescription }
    }
}

struct SettingsView: View {
    @ObservedObject var model: Preferences
    var body: some View {
        ScrollView {
        VStack(alignment: .leading, spacing: 20) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 7) {
                    HStack(spacing: 9) {
                        Image(systemName: "viewfinder").foregroundStyle(mint)
                        Text("Glance").fontWeight(.semibold)
                    }.font(.system(size: 29))
                    Text("A little context. Right when you need it.")
                        .font(.system(size: 14)).foregroundStyle(.secondary)
                }
                Spacer()
                Text(model.paused ? "PAUSED" : "ON DEMAND")
                    .font(.system(size: 10, weight: .bold, design: .monospaced))
                    .foregroundStyle(mint).padding(.horizontal, 12).padding(.vertical, 7)
                    .background(mint.opacity(0.10), in: Capsule())
            }
            HStack(spacing: 12) {
                shortcut("K", name: "The big picture", detail: "Read this display · Jev picks a topic", symbol: "rectangle.dashed")
                shortcut("L", name: "A closer look", detail: "Read near your cursor · Exa instant", symbol: "cursorarrow.rays")
            }
            VStack(alignment: .leading, spacing: 12) {
                label("01", "CONNECT")
                Text("Connected through your existing Jev server.")
                Toggle("Let Jev select the topic for K", isOn: $model.useJev).tint(mint)
                Text("Provider keys stay on the server. Web lookup with L skips Jev; Gmail uses Jev.")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
            }.textFieldStyle(.roundedBorder)
            VStack(alignment: .leading, spacing: 11) {
                label("02", "ALLOW ACCESS")
                permission("Screen Recording", detail: "Read visible text with local OCR", allowed: model.screenAllowed) {
                    CGRequestScreenCaptureAccess()
                    openPrivacy("Privacy_ScreenCapture")
                }
                permission("Accessibility", detail: "Listen for shortcuts and detect text fields", allowed: model.accessAllowed) {
                    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true]
                    AXIsProcessTrustedWithOptions(options as CFDictionary)
                    openPrivacy("Privacy_Accessibility")
                }
            }
            VStack(alignment: .leading, spacing: 11) {
                label("03", "GMAIL × JEV")
                Toggle("Use structured Gmail context for K and L in Chrome", isOn: $model.gmailEnabled).tint(mint)
                TextField("Ranking criterion (blank uses the Gmail toolbar's choice)", text: $model.gmailCriterion).textFieldStyle(.roundedBorder)
                HStack {
                    Button("Show Jev extension folder") { model.prepareGmail() }
                    Button("Check Gmail connection") { Task { await model.checkGmail() } }
                }
                Text("K uses the existing Gmail Sort flow for the last 24 hours. L checks the pointed-at or open conversation. Gmail text goes only to Jev.")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 11) {
                label("04", "MAKE IT YOURS")
                Toggle("Enable plain K and L outside text fields", isOn: $model.bareKeys).tint(mint)
                TextField("Writing purpose for other apps (optional)", text: $model.writingPurpose).textFieldStyle(.roundedBorder)
                Text("F8 checks spelling in the focused draft. Gmail also has a Spell check button; on media-key keyboards, use Fn-F8.").font(.system(size: 11)).foregroundStyle(.secondary)
                HStack {
                    Text("L shows")
                    Spacer()
                    Picker("L shows", selection: $model.cursorAnswers) {
                        Text("Brief answer").tag(true)
                        Text("Source excerpt · fastest").tag(false)
                    }.labelsHidden().frame(width: 210)
                }
                Text("Brief answers explain the topic in 10–15 words. Allow about 1–2 seconds for generation.")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                HStack {
                    Text("Search freshness")
                    Spacer()
                    Picker("Search freshness", selection: $model.days) {
                        Text("Past 30 days").tag(30)
                        Text("Past 90 days").tag(90)
                        Text("Past year").tag(365)
                        Text("Any time").tag(0)
                    }.labelsHidden().frame(width: 160)
                }
                Text("Option-K / Option-L work while editing. Escape dismisses. Pause from the menu bar.")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
            }
            Divider().opacity(0.4)
            HStack(spacing: 10) {
                Button("Save settings") { model.save() }.buttonStyle(.borderedProminent).tint(mint).foregroundStyle(.black)
                Button(model.checking ? "Connecting…" : "Test connection") { Task { await model.check() } }.disabled(model.checking)
                Spacer()
                Button(model.paused ? "Resume" : "Pause") { model.paused.toggle() }
            }
            Text(model.message.isEmpty ? "Shortcuts or Glance Sort trigger a lookup. Screen text goes to Jev / Exa; Gmail goes only to Jev." : model.message)
                .font(.system(size: 11)).foregroundStyle(model.message.contains("returned") ? .orange : .secondary)
                .frame(height: 30, alignment: .topLeading)
        }.padding(28).frame(width: 650)
        }.frame(width: 650, height: min(850, (NSScreen.main?.visibleFrame.height ?? 930) - 60))
            .background(Color(red: 0.065, green: 0.078, blue: 0.092))
            .preferredColorScheme(.dark)
    }
    func label(_ number: String, _ text: String) -> some View {
        HStack(spacing: 9) {
            Text(number).foregroundStyle(mint)
            Text(text).foregroundStyle(.secondary)
        }.font(.system(size: 10, weight: .bold, design: .monospaced)).tracking(1.4)
    }
    func shortcut(_ key: String, name: String, detail: String, symbol: String) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                Image(systemName: symbol).font(.system(size: 19)).foregroundStyle(mint)
                Spacer()
                Text(key).font(.system(size: 18, weight: .medium, design: .monospaced))
                    .frame(width: 32, height: 32).background(.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 7))
            }
            Text(name).font(.system(size: 16, weight: .medium))
            Text(detail).font(.system(size: 11)).foregroundStyle(.secondary)
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(.white.opacity(0.035), in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.white.opacity(0.07)))
    }
    func permission(_ name: String, detail: String, allowed: Bool, action: @escaping () -> Void) -> some View {
        HStack(spacing: 11) {
            Image(systemName: allowed ? "checkmark.circle.fill" : "circle.dashed")
                .foregroundStyle(allowed ? mint : .secondary)
            VStack(alignment: .leading, spacing: 3) {
                Text(name).font(.system(size: 13, weight: .medium))
                Text(detail).font(.system(size: 11)).foregroundStyle(.secondary)
            }
            Spacer()
            Button(allowed ? "Open settings" : "Enable", action: action).controlSize(.small)
        }
    }
    func openPrivacy(_ anchor: String) {
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)")!)
    }
}

final class ToastModel: ObservableObject {
    @Published var text = "Reading the screen…"
    @Published var detail = ""
    @Published var source: URL?
    @Published var busy = true
    @Published var error = false
}
struct ToastView: View {
    @ObservedObject var model: ToastModel
    let close: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 7) {
                Image(systemName: "viewfinder").foregroundStyle(mint)
                Text("GLANCE").tracking(2).font(.system(size: 10, weight: .bold, design: .monospaced))
                Spacer()
                if model.busy { ProgressView().controlSize(.small).scaleEffect(0.7) }
                Button(action: close) { Image(systemName: "xmark").font(.system(size: 10, weight: .semibold)) }
                    .buttonStyle(.plain).foregroundStyle(.secondary).help("Dismiss")
            }
            Text(model.text).font(.system(size: model.busy ? 17 : 19, weight: .medium))
                .foregroundStyle(model.error ? Color.orange : .white).lineLimit(4)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 8) {
                Text(model.detail).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
                Spacer(minLength: 5)
                if let source = model.source {
                    Button { NSWorkspace.shared.open(source); close() } label: {
                        Image(systemName: "arrow.up.right").foregroundStyle(mint)
                    }.buttonStyle(.plain).help("Open source")
                    Button {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(model.text + "\n" + source.absoluteString, forType: .string)
                    } label: { Image(systemName: "doc.on.doc").foregroundStyle(.secondary) }
                    .buttonStyle(.plain).help("Copy text and source")
                }
            }
        }.padding(20).frame(width: 410, height: 184, alignment: .topLeading)
            .background(Color(red: 0.065, green: 0.078, blue: 0.092).opacity(0.98), in: RoundedRectangle(cornerRadius: 17))
            .overlay(RoundedRectangle(cornerRadius: 17).strokeBorder(mint.opacity(0.22)))
            .preferredColorScheme(.dark)
    }
}

@MainActor final class Toast {
    let model = ToastModel()
    var panel: NSPanel!
    var dismiss: Timer?
    init() {
        panel = NSPanel(contentRect: CGRect(x: 0, y: 0, width: 410, height: 184),
            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.sharingType = .none
        panel.contentView = NSHostingView(rootView: ToastView(model: model) { [weak self] in self?.hide() })
    }
    func hide() { dismiss?.invalidate(); panel.orderOut(nil) }
    func show(mode: CaptureMode, at cursor: NSPoint) {
        dismiss?.invalidate()
        let visible = Capture.screen(at: cursor).visibleFrame
        let width: CGFloat = 410, height: CGFloat = 184
        var origin = mode == .screen
            ? NSPoint(x: visible.midX - width / 2, y: visible.maxY - height - 16)
            : NSPoint(x: cursor.x - width / 2, y: cursor.y + 22)
        if mode == .cursor && origin.y + height > visible.maxY { origin.y = cursor.y - height - 22 }
        origin.x = max(visible.minX + 8, min(origin.x, visible.maxX - width - 8))
        origin.y = max(visible.minY + 8, min(origin.y, visible.maxY - height - 8))
        panel.setFrameOrigin(origin)
        panel.orderFrontRegardless()
    }
    func expire(after seconds: TimeInterval = 12) {
        dismiss?.invalidate()
        dismiss = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.hide() }
        }
    }
}

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate {
    let prefs = Preferences()
    lazy var toast = Toast()
    var status: NSStatusItem!
    var settings: NSWindow?
    var globalMonitor: Any?
    var localMonitor: Any?
    var lookupTask: Task<Void, Never>?
    var requestID = UUID()
    var lastTrigger = Date.distantPast
    var subscriptions = Set<AnyCancellable>()
    func applicationDidFinishLaunching(_ notification: Notification) {
        status = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        status.button?.image = NSImage(systemSymbolName: "viewfinder", accessibilityDescription: "Glance")
        status.button?.toolTip = "Glance · K for screen · L for cursor"
        rebuildMenu()
        prefs.$paused.dropFirst().sink { [weak self] paused in
            DispatchQueue.main.async {
                self?.status.button?.appearsDisabled = paused
                if paused { self?.cancel() }
                self?.rebuildMenu()
            }
        }.store(in: &subscriptions)
        installMonitor()
        prefs.$accessAllowed.dropFirst().removeDuplicates().sink { [weak self] _ in
            DispatchQueue.main.async { self?.installMonitor() }
        }.store(in: &subscriptions)
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.keyCode == 53 { MainActor.assumeIsolated { self?.cancel() } }
            return event
        }
        showSettings()
        if CommandLine.arguments.contains("--demo") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                guard let self else { return }
                self.toast.model.busy = false
                self.toast.model.text = "Swift actors protect shared mutable state by serializing access to their isolated properties."
                self.toast.model.detail = "Preview · swift.org · no screen captured"
                self.toast.model.source = URL(string: "https://www.swift.org/documentation/")
                self.toast.show(mode: .screen, at: NSEvent.mouseLocation)
            }
        }
    }
    func installMonitor() {
        if let globalMonitor { NSEvent.removeMonitor(globalMonitor); self.globalMonitor = nil }
        guard AXIsProcessTrusted() else { return }
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            MainActor.assumeIsolated { self?.handle(event) }
        }
    }
    func rebuildMenu() {
        let menu = NSMenu()
        func item(_ title: String, _ selector: Selector) {
            let row = NSMenuItem(title: title, action: selector, keyEquivalent: "")
            row.target = self
            menu.addItem(row)
        }
        item("Look at screen    K / ⌥K", #selector(screenLookup))
        item("Look near cursor    L / ⌥L", #selector(cursorLookup))
        item("Rank Gmail", #selector(gmailLookup))
        menu.addItem(.separator())
        item(prefs.paused ? "Resume shortcuts" : "Pause shortcuts", #selector(togglePause))
        item("Settings…", #selector(showSettings))
        menu.addItem(.separator())
        item("Quit Glance", #selector(quit))
        status.menu = menu
    }
    @objc func showSettings() {
        if settings == nil {
            let view = NSHostingView(rootView: SettingsView(model: prefs))
            let window = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 650, height: 770),
                styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
            window.title = "Glance"
            window.isReleasedWhenClosed = false
            window.contentView = view
            window.setContentSize(view.fittingSize)
            window.center()
            window.appearance = NSAppearance(named: .darkAqua)
            settings = window
        }
        NSApp.activate(ignoringOtherApps: true)
        settings?.makeKeyAndOrderFront(nil)
    }
    @objc func togglePause() { prefs.paused.toggle() }
    @objc func quit() { cancel(); NSApp.terminate(nil) }
    @objc func screenLookup() { trigger(.screen) }
    @objc func cursorLookup() { trigger(.cursor) }
    @objc func gmailLookup() { trigger(.screen, gmailOnly: true) }
    func handle(_ event: NSEvent) {
        if event.keyCode == 53 { cancel(); return }
        guard !prefs.paused, !event.isARepeat, Date().timeIntervalSince(lastTrigger) > 0.4 else { return }
        let flags = event.modifierFlags.intersection([.command, .control, .shift, .option])
        if event.keyCode == 100 && flags.isEmpty { spellingLookup(); return }
        guard flags.isEmpty || flags == .option else { return }
        if flags.isEmpty && (!prefs.bareKeys || Accessibility.isEditing()) { return }
        if event.keyCode == 40 { trigger(.screen) }
        else if event.keyCode == 37 { trigger(.cursor) }
    }
    func cancel() { requestID = UUID(); lookupTask?.cancel(); lookupTask = nil; toast.hide() }
    func trigger(_ mode: CaptureMode, gmailOnly: Bool = false) {
        guard !prefs.paused else { return }
        lastTrigger = Date()
        cancel()
        let id = requestID
        let target = Accessibility.Target()
        let cursor = NSEvent.mouseLocation
        let useJev = prefs.useJev, days = prefs.days, cursorAnswers = prefs.cursorAnswers
        let tryGmail = gmailOnly || (prefs.gmailEnabled && NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.google.Chrome")
        let requireGmail = gmailOnly || (prefs.gmailEnabled && Accessibility.chromeShowsGmail())
        let criterion = prefs.gmailCriterion
        toast.model.text = mode == .screen ? "Reading the screen…" : "Looking closer…"
        toast.model.detail = "Local OCR → \(mode == .screen && useJev ? "Jev → " : "")Exa instant"
        toast.model.busy = true
        toast.model.error = false
        toast.model.source = nil
        toast.show(mode: mode, at: cursor)
        lookupTask = Task { [weak self] in
            guard let self else { return }
            let start = Date()
            do {
                if tryGmail || requireGmail {
                    self.toast.model.text = mode == .screen ? "Checking Gmail…" : "Checking this email…"
                    if let answer = try await self.prefs.gmail.lookup(mode: mode, criterion: criterion, required: requireGmail, target: target) {
                        try Task.checkCancellation()
                        guard self.requestID == id else { return }
                        self.show(answer, start: start, gmail: true)
                        return
                    }
                }
                let context = try await Capture.read(mode: mode, cursor: cursor, target: target)
                try Task.checkCancellation()
                self.toast.model.text = mode == .screen && useJev ? "Finding the useful part…" : "Searching for context…"
                // In cursor mode preserve proximity instead of the full-screen heuristic ranking.
                let candidates: [Candidate]
                if mode == .cursor {
                    let text = TextTools.cursorQuery(context.text)
                    candidates = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? [] : [Candidate(id: "cursor", text: String(text.prefix(500)))]
                } else { candidates = context.candidates }
                let answer = try await API.lookup(candidates: candidates, nearCursor: mode == .cursor,
                    useJev: useJev, days: days, cursorAnswers: cursorAnswers)
                try Task.checkCancellation()
                guard self.requestID == id else { return }
                self.show(answer, start: start)
            } catch {
                guard !Task.isCancelled, self.requestID == id else { return }
                self.toast.model.text = error.localizedDescription
                self.toast.model.detail = "Glance · Settings are in the menu bar"
                self.toast.model.busy = false
                self.toast.model.error = true
                self.toast.expire(after: 14)
            }
        }
    }
    @objc func spellingLookup() {
        guard !prefs.paused else { return }
        let targetPID = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let targetEditor = Accessibility.focused()
        let chrome = NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.google.Chrome"
        cancel(); lastTrigger = Date()
        let id = requestID
        lookupTask = Task { [weak self] in
            guard let self else { return }
            do {
                // Gmail's content script handles F8 directly, preserving native rich-text Undo.
                if chrome {
                    if try await self.prefs.gmail.check(activeOnly: true) { return }
                }
                guard NSWorkspace.shared.frontmostApplication?.processIdentifier == targetPID,
                      let targetEditor, let focused = Accessibility.focused(), CFEqual(targetEditor, focused) else {
                    throw GlanceError.message("Focus changed. Press F8 again in your draft.")
                }
                let count = try await NativeSpelling.correct(purpose: self.prefs.writingPurpose)
                guard self.requestID == id, !Task.isCancelled else { return }
                self.toast.model.text = count == 0 ? "No confident spelling fixes found." : "Fixed \(count) word\(count == 1 ? "" : "s")."
                self.toast.model.detail = "Jev · spelling in the focused editor"
                self.toast.model.busy = false; self.toast.model.error = false
                self.toast.show(mode: .cursor, at: NSEvent.mouseLocation); self.toast.expire()
            } catch {
                guard self.requestID == id, !Task.isCancelled else { return }
                self.toast.model.text = error.localizedDescription; self.toast.model.detail = "Glance · spelling"
                self.toast.model.busy = false; self.toast.model.error = true
                self.toast.show(mode: .cursor, at: NSEvent.mouseLocation); self.toast.expire()
            }
        }
    }
    func show(_ answer: Lookup, start: Date, gmail: Bool = false) {
        toast.model.text = answer.text
        toast.model.source = URL(string: answer.result.url)
        let ms = Int(Date().timeIntervalSince(start) * 1000)
        if gmail {
            toast.model.detail = "\(answer.note ?? "Gmail") · \(ms) ms"
        } else {
            let host = URL(string: answer.result.url)?.host ?? "Source"
            let date = answer.result.publishedDate.map { String($0.prefix(10)) } ?? "Date unavailable"
            toast.model.detail = "\(answer.note ?? "Source excerpt") · \(host) · \(date) · \(ms) ms"
        }
        toast.model.busy = false
        toast.expire()
    }
    func applicationWillTerminate(_ notification: Notification) {
        if let globalMonitor { NSEvent.removeMonitor(globalMonitor) }
        if let localMonitor { NSEvent.removeMonitor(localMonitor) }
        lookupTask?.cancel()
    }
}
