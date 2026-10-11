import AppKit
import Foundation
import ApplicationServices

struct CompanionConnection: Decodable {
    let server: String
    let token: String
    let `extension`: String
    static func load() throws -> CompanionConnection {
        let override = ProcessInfo.processInfo.environment["GLANCE_CONNECTION_FILE"]
        let path = override ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/JevGlance/connection.json").path
        guard let data = FileManager.default.contents(atPath: path), let config = try? JSONDecoder().decode(Self.self, from: data),
              let url = URL(string: config.server), url.scheme == "http", ["localhost", "127.0.0.1"].contains(url.host ?? ""),
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              config.token.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
            throw GlanceError.message("Pair Glance from your Jev repo with bun run companion:pair, then start its server.")
        }
        return config
    }
}
enum CompanionAPI {
    struct Health: Decodable { let service: String; let connected: Bool; let active: Bool; let jev: Bool; let exa: Bool }
    static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 48
        config.timeoutIntervalForResource = 50
        config.urlCache = nil; config.httpCookieStorage = nil
        return URLSession(configuration: config)
    }()
    static func request<T: Decodable>(_ path: String, body: [String: Any]? = nil, type: T.Type) async throws -> T {
        let config = try CompanionConnection.load()
        var request = URLRequest(url: URL(string: config.server + "/api/companion/" + path)!)
        request.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let data: Data, response: URLResponse
        do { (data, response) = try await session.data(for: request) }
        catch { try Task.checkCancellation(); throw GlanceError.message("Start your Jev repo's local server, then try again.") }
        try Task.checkCancellation()
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            let error = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            throw GlanceError.message(error?["error"] as? String ?? "The Jev server could not complete this request.")
        }
        do { return try JSONDecoder().decode(type, from: data) }
        catch { throw GlanceError.message("The Jev server returned an invalid response. Update the helper and server together.") }
    }
    static func health() async throws -> Health {
        let result = try await request("health", type: Health.self)
        guard result.service == "jev-glance-v1" else { throw GlanceError.message("The helper is paired with the wrong local server.") }
        return result
    }
}
struct GmailResult: Decodable {
    let text: String; let detail: String; let source: String; let from: String; let count: Int; let ms: Int
    func lookup() throws -> Lookup {
        guard let url = URL(string: source), url.scheme == "https", url.host == "mail.google.com" else {
            throw GlanceError.message("The Gmail server returned an invalid thread link.")
        }
        return Lookup(result: SearchResult(title: detail, url: source, publishedDate: nil, highlights: nil), text: text, query: "",
            elapsed: Double(ms) / 1000, note: "\(detail) · \(from) · Gmail · \(count) email\(count == 1 ? "" : "s")")
    }
}
@MainActor final class GmailBridge {
    func revealExtension() throws {
        let config = try CompanionConnection.load()
        let url = URL(fileURLWithPath: config.extension)
        guard FileManager.default.fileExists(atPath: url.appendingPathComponent("manifest.json").path) else {
            throw GlanceError.message("The paired extension folder moved. Run bun run companion:pair again.")
        }
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }
    func check(activeOnly: Bool = false) async throws -> Bool {
        let health = try await CompanionAPI.health(); return activeOnly ? health.active : health.connected
    }
    func lookup(mode: CaptureMode, criterion: String, required: Bool = false, target: Accessibility.Target) async throws -> Lookup? {
        guard try await check(activeOnly: true) else {
            if required { throw GlanceError.message("Focus Gmail in Chrome and reload the existing Jev extension first.") }
            return nil
        }
        try target.check()
        return try await CompanionAPI.request("gmail", body: ["mode": mode == .cursor ? "cursor" : "screen", "criterion": criterion], type: GmailResult.self).lookup()
    }
}

struct SpellingResult: Decodable {
    struct Change: Decodable { let start: Int; let end: Int; let original: String; let replacement: String }
    let changes: [Change]; let checked: Int; let ms: Int
}
// Pure validation before any Accessibility mutation; offsets use the server's UTF-16 convention.
enum SpellingEdits {
    static func validate(_ changes: [SpellingResult.Change], text: String) throws -> [SpellingResult.Change] {
        guard changes.count <= 24 else { throw GlanceError.message("Invalid spelling response; text unchanged.") }
        let sorted = changes.sorted { $0.start < $1.start }, value = text as NSString
        var previous = 0
        for change in sorted {
            guard change.start >= previous, change.end > change.start, change.end <= value.length,
                  value.substring(with: NSRange(location: change.start, length: change.end - change.start)) == change.original,
                  change.replacement.range(of: "^[A-Za-z][A-Za-z '’–-]{0,47}$", options: .regularExpression) != nil else {
                throw GlanceError.message("Invalid spelling response; text unchanged.")
            }
            previous = change.end
        }
        return sorted
    }
}
@MainActor enum NativeSpelling {
    static func correct(purpose: String) async throws -> Int {
        guard AXIsProcessTrusted(), let app = NSWorkspace.shared.frontmostApplication, let editor = Accessibility.focused(),
              Accessibility.attribute(editor, kAXSubroleAttribute) as? String != kAXSecureTextFieldSubrole, Accessibility.isEditing(), let text = Accessibility.attribute(editor, kAXValueAttribute) as? String,
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.utf16.count <= 12_000 else {
            throw GlanceError.message("Focus an editable English draft of up to 12,000 characters first.")
        }
        for attribute in [kAXSelectedTextAttribute, kAXSelectedTextRangeAttribute] {
            var settable = DarwinBoolean(false)
            AXUIElementIsAttributeSettable(editor, attribute as CFString, &settable)
            guard settable.boolValue else { throw GlanceError.message("This editor cannot safely replace text through Accessibility. In Gmail, use its Spell check button.") }
        }
        let appElement = AXUIElementCreateApplication(app.processIdentifier)
        var title = ""
        if let value = Accessibility.attribute(appElement, kAXFocusedWindowAttribute), CFGetTypeID(value) == AXUIElementGetTypeID() {
            title = Accessibility.attribute(value as! AXUIElement, kAXTitleAttribute) as? String ?? ""
        }
        let saved = Accessibility.attribute(editor, kAXSelectedTextRangeAttribute)
        let result = try await CompanionAPI.request("spellcheck", body: ["draft": text, "context": ["subject": String(title.prefix(300)), "purpose": String("\(purpose) Writing in \(app.localizedName ?? "this editor"); preserve the author's intent and tone.".prefix(300))]], type: SpellingResult.self)
        try Task.checkCancellation()
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier,
              let focused = Accessibility.focused(), CFEqual(focused, editor), Accessibility.attribute(editor, kAXValueAttribute) as? String == text else {
            throw GlanceError.message("Draft or focus changed. Press F8 again in this draft.")
        }
        if let saved, let current = Accessibility.attribute(editor, kAXSelectedTextRangeAttribute), !CFEqual(saved, current) {
            throw GlanceError.message("Selection changed. Press F8 again in this draft.")
        }
        let changes = try SpellingEdits.validate(result.changes, text: text)
        var expected = text, applied = 0
        for change in changes.reversed() {
            try Task.checkCancellation()
            guard let current = Accessibility.focused(), CFEqual(current, editor), Accessibility.attribute(editor, kAXValueAttribute) as? String == expected else { break }
            var range = CFRange(location: change.start, length: change.end - change.start)
            guard let value = AXValueCreate(.cfRange, &range),
                  AXUIElementSetAttributeValue(editor, kAXSelectedTextRangeAttribute as CFString, value) == .success,
                  AXUIElementSetAttributeValue(editor, kAXSelectedTextAttribute as CFString, change.replacement as CFString) == .success else { break }
            expected = (expected as NSString).replacingCharacters(in: NSRange(location: change.start, length: change.end - change.start), with: change.replacement)
            applied += 1
        }
        if let saved, CFGetTypeID(saved) == AXValueGetTypeID() {
            var range = CFRange(); if AXValueGetValue(saved as! AXValue, .cfRange, &range) {
                range.location = min(range.location, expected.utf16.count); range.length = min(range.length, expected.utf16.count - range.location)
                if let value = AXValueCreate(.cfRange, &range) { AXUIElementSetAttributeValue(editor, kAXSelectedTextRangeAttribute as CFString, value) }
            }
        }
        if applied == 0 && !changes.isEmpty { throw GlanceError.message("This editor could not apply the spelling fixes. Your text is unchanged.") }
        return applied
    }
}
