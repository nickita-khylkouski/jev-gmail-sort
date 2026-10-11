import AppKit
import ApplicationServices
import ScreenCaptureKit
import Vision

enum CaptureMode { case screen, cursor }
struct ScreenText { let text: String; let selected: String; let candidates: [Candidate] }

enum Accessibility {
    struct Target {
        let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let element = Accessibility.focused()
        let window: AXUIElement? = {
            guard let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier,
                  let value = Accessibility.attribute(AXUIElementCreateApplication(pid), kAXFocusedWindowAttribute),
                  CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
            return (value as! AXUIElement)
        }()
        func check() throws {
            guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid, !Accessibility.isSecure() else {
                throw GlanceError.message("Focus changed. Press the shortcut again on the intended content.")
            }
            if let element {
                guard let current = Accessibility.focused(), CFEqual(element, current) else {
                    throw GlanceError.message("Focus changed. Press the shortcut again on the intended content.")
                }
            }
            if let window, let pid {
                guard let current = Accessibility.attribute(AXUIElementCreateApplication(pid), kAXFocusedWindowAttribute), CFEqual(window, current) else {
                    throw GlanceError.message("Window changed. Press the shortcut again on the intended content.")
                }
            }
        }
    }
    static func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var result: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &result) == .success else { return nil }
        return result
    }
    static func focused() -> AXUIElement? {
        let system = AXUIElementCreateSystemWide()
        guard let value = attribute(system, kAXFocusedUIElementAttribute), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return (value as! AXUIElement)
    }
    static func isEditing() -> Bool {
        // Skip plain letter shortcuts while typing. Option-K/L remains available.
        guard AXIsProcessTrusted(), let element = focused() else { return true }
        let role = attribute(element, kAXRoleAttribute) as? String ?? ""
        let subrole = attribute(element, kAXSubroleAttribute) as? String ?? ""
        if subrole == kAXSecureTextFieldSubrole { return true }
        if [kAXTextFieldRole, kAXTextAreaRole, kAXComboBoxRole].contains(role) { return true }
        if (attribute(element, "AXEditable") as? Bool) == true { return true }
        var settable = DarwinBoolean(false)
        AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable)
        return settable.boolValue
    }
    static func isSecure() -> Bool {
        guard let element = focused() else { return false }
        return attribute(element, kAXSubroleAttribute) as? String == kAXSecureTextFieldSubrole
    }
    static func selectedText() -> String {
        guard AXIsProcessTrusted(), let element = focused(), !isSecure() else { return "" }
        return String((attribute(element, kAXSelectedTextAttribute) as? String ?? "").prefix(1500))
    }
    static func chromeShowsGmail() -> Bool {
        guard AXIsProcessTrusted(), let app = NSWorkspace.shared.frontmostApplication,
              app.bundleIdentifier == "com.google.Chrome" else { return false }
        let element = AXUIElementCreateApplication(app.processIdentifier)
        guard let value = attribute(element, kAXFocusedWindowAttribute), CFGetTypeID(value) == AXUIElementGetTypeID() else { return false }
        let window = value as! AXUIElement
        let title = attribute(window, kAXTitleAttribute) as? String ?? ""
        let document = attribute(window, kAXDocumentAttribute) as? String ?? ""
        return title.hasSuffix(" - Gmail") || title.contains(" - Gmail - ") || URL(string: document)?.host == "mail.google.com"
    }
}

enum Capture {
    static func screen(at point: NSPoint) -> NSScreen {
        NSScreen.screens.first(where: { $0.frame.contains(point) }) ?? NSScreen.main ?? NSScreen.screens[0]
    }
    static func crop(screen: CGRect, cursor: CGPoint) -> CGRect {
        CGRect(x: cursor.x - 320, y: cursor.y - 180, width: 640, height: 360).intersection(screen)
    }
    @MainActor static func read(mode: CaptureMode, cursor: NSPoint, target focus: Accessibility.Target) async throws -> ScreenText {
        try focus.check()
        guard !Accessibility.isSecure() else { throw GlanceError.message("Move away from the password field before looking up.") }
        guard CGPreflightScreenCaptureAccess() else {
            throw GlanceError.message("Enable Screen Recording for Glance in Settings, then reopen Glance.")
        }
        let selected = mode == .screen ? Accessibility.selectedText() : ""
        let target = screen(at: cursor)
        let id = (target.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as! NSNumber).uint32Value
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        try focus.check()
        guard let display = content.displays.first(where: { $0.displayID == id }) else {
            throw GlanceError.message("Could not find this display.")
        }
        let ownApps = content.applications.filter { $0.processID == ProcessInfo.processInfo.processIdentifier }
        let filter = SCContentFilter(display: display, excludingApplications: ownApps, exceptingWindows: [])
        let config = SCStreamConfiguration()
        config.showsCursor = false
        let scale = target.backingScaleFactor
        var region = CGRect(origin: .zero, size: target.frame.size)
        if mode == .cursor {
            // ScreenCaptureKit uses top-left display-local coordinates, AppKit bottom-left global coordinates.
            let local = CGPoint(x: cursor.x - target.frame.minX, y: target.frame.maxY - cursor.y)
            region = crop(screen: region, cursor: local)
        }
        config.sourceRect = region
        config.width = Int(region.width * scale)
        config.height = Int(region.height * scale)
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        try Task.checkCancellation()
        let text = try await Task.detached(priority: .userInitiated) {
            try recognize(image, nearCursor: mode == .cursor, point: CGPoint(
                x: (cursor.x - target.frame.minX - region.minX) / region.width,
                y: 1 - (target.frame.maxY - cursor.y - region.minY) / region.height))
        }.value
        try Task.checkCancellation()
        try focus.check()
        return ScreenText(text: text, selected: selected, candidates: TextTools.candidates(text, selected: selected))
    }
    static func recognize(_ image: CGImage, nearCursor: Bool, point: CGPoint = CGPoint(x: 0.5, y: 0.5)) throws -> String {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .fast
        request.usesLanguageCorrection = true
        try VNImageRequestHandler(cgImage: image).perform([request])
        var observations = request.results ?? []
        if nearCursor {
            // Status badges, timestamps, and email addresses must not crowd out the topic.
            observations = observations.filter {
                !TextTools.cursorLine($0.topCandidates(1).first?.string ?? "").isEmpty
            }
            observations.sort {
                let a = hypot($0.boundingBox.midX - point.x, ($0.boundingBox.midY - point.y) * 0.65)
                let b = hypot($1.boundingBox.midX - point.x, ($1.boundingBox.midY - point.y) * 0.65)
                return a < b
            }
            observations = Array(observations.prefix(6))
            // Restore reading order after choosing nearby lines so sentences remain coherent.
            observations.sort {
                if abs($0.boundingBox.midY - $1.boundingBox.midY) > 0.015 { return $0.boundingBox.midY > $1.boundingBox.midY }
                return $0.boundingBox.minX < $1.boundingBox.minX
            }
        } else {
            observations.sort {
                if abs($0.boundingBox.midY - $1.boundingBox.midY) > 0.015 { return $0.boundingBox.midY > $1.boundingBox.midY }
                return $0.boundingBox.minX < $1.boundingBox.minX
            }
        }
        return String(observations.compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n").prefix(16000))
    }
}
