import AppKit
import Foundation

func runSelfTests() throws {
    var count = 0
    func check(_ condition: @autoclosure () -> Bool, _ label: String) throws {
        guard condition() else { throw GlanceError.message("FAIL: \(label)") }
        count += 1
        print("PASS: \(label)")
    }
    let secret = "apikey_" + String(repeating: "a", count: 72)
    let cleaned = TextTools.redact("Contact person@example.com using \(secret) or password=hidden. https://example.com?q=private")
    try check(!cleaned.contains(secret) && !cleaned.contains("person@example.com") && !cleaned.contains("hidden"), "credential and email redaction")
    try check(!cleaned.contains("q=private"), "URL query redaction")
    let candidates = TextTools.candidates("Open menu\nPreferences panel\nHow to fix a Swift async await compilation error?\nThe build failed with a timeout.")
    try check(candidates.first?.text.contains("error") == true, "error and question prioritization")
    let selection = "How do Swift actors protect shared mutable state?"
    try check(TextTools.candidates("Unrelated background article text goes here", selected: selection).first?.text == selection, "selected text priority")
    try check(TextTools.candidates("").isEmpty, "empty screen handling")
    let result = SearchResult(title: "Fallback title", url: "https://example.com", publishedDate: nil,
        highlights: ["One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen."])
    try check(TextTools.excerpt(result).split(separator: " ").count == 15, "15-word excerpt bound")
    let longAnswer = "Actors prevent data races by using a serial executor to process tasks one at a time."
    try check(TextTools.brief(longAnswer).hasSuffix("sequentially.") && TextTools.brief(longAnswer).split(separator: " ").count <= 15, "shorten verbose answers without cutting a final phrase")
    let markdown = SearchResult(title: "A title", url: "https://example.com", publishedDate: nil,
        highlights: ["# A repeated headline\n\nActors serialize access to isolated state so concurrent tasks can coordinate safely within the application."])
    try check(TextTools.excerpt(markdown).hasPrefix("Actors serialize"), "skip Markdown headings in source excerpts")
    let fixture = Data(#"{"results":[{"title":"A title","url":"https://example.com","publishedDate":"2026-10-01T00:00:00Z","highlights":["A useful source excerpt."]}],"resolvedSearchType":"instant"}"#.utf8)
    let decoded = try JSONDecoder().decode(SearchResponse.self, from: fixture)
    try check(decoded.results.count == 1 && decoded.resolvedSearchType == "instant", "Exa response contract")
    let jevFixture = Data(#"{"answers":{"focus":{"choice":"region_1","confidence":0.91,"probabilities":{"region_1":0.95}}}}"#.utf8)
    let jevDecoded = try JSONDecoder().decode(JevResponse.self, from: jevFixture)
    try check(jevDecoded.answers["focus"]?.choice == "region_1", "Jev response contract")
    let outputFixture = Data(#"{"results":[],"output":{"content":"One grounded useful answer.","grounding":[{"citations":[{"url":"https://example.com","title":"Source"}]}]}}"#.utf8)
    let outputDecoded = try JSONDecoder().decode(SearchResponse.self, from: outputFixture)
    try check(outputDecoded.output?.grounding?.first?.citations?.first?.url == "https://example.com", "Exa synthesis citation contract")
    let connectionText = "Connect Gmail for short summaries of new emails.\nbut cannot send, edit, or delete it.\nconnected\nperson@example.com\nLast received 10/11/2026, 11:46:51 AM\nDisconnect email"
    let cursorQuery = TextTools.cursorQuery(connectionText)
    try check(cursorQuery.contains("Gmail") && cursorQuery.contains("cannot send"), "cursor preserves descriptive context")
    try check(!cursorQuery.contains("connected") && !cursorQuery.contains("received") && !cursorQuery.contains("2026") && !cursorQuery.contains("@"), "cursor removes account status, timestamps, and email")
    try check(TextTools.cursorQuery("connected\nperson@example.com\nLast received 10/11/2026, 11:46:51 AM\nDisconnect email").isEmpty, "interface-only cursor region is not searched")
    let answerFixture = Data(#"{"results":[],"output":{"content":{"answer":"Read-only access lets apps view email without sending, modifying, or deleting messages.[1]","supported":true},"grounding":[{"field":"answer","confidence":"high","citations":[{"url":"https://example.com","title":"Evidence"}]}]}}"#.utf8)
    let answerDecoded = try JSONDecoder().decode(SearchResponse.self, from: answerFixture)
    let (source, sentence) = try answerDecoded.briefAnswer()
    try check(source.url == "https://example.com" && !sentence.contains("[1]"), "structured answer decoding and citation-marker removal")
    try check((10...15).contains(sentence.split(separator: " ").count) && sentence.hasSuffix("."), "complete short answer")
    try check(TextTools.answerSentence("One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen.") == nil, "verbose answers are rejected instead of cut off")
    func rejects(_ data: Data) -> Bool {
        do { _ = try JSONDecoder().decode(SearchResponse.self, from: data).briefAnswer(); return false }
        catch { return true }
    }
    let answerJSON = String(data: answerFixture, encoding: .utf8)!
    try check(rejects(Data(answerJSON.replacingOccurrences(of: "\"supported\":true", with: "\"supported\":false").utf8)), "unsupported answers never fall back to excerpts")
    try check(rejects(Data(answerJSON.replacingOccurrences(of: "\"field\":\"answer\"", with: "\"field\":\"supported\"").utf8)), "citations must ground the answer field")
    try check(rejects(Data(answerJSON.replacingOccurrences(of: "\"confidence\":\"high\"", with: "\"confidence\":\"low\"").utf8)), "low-confidence explanations are rejected")
    let screen = CGRect(x: 0, y: 0, width: 1440, height: 900)
    let edgeCrop = Capture.crop(screen: screen, cursor: CGPoint(x: 5, y: 5))
    try check(screen.contains(edgeCrop) && edgeCrop.minX == 0 && edgeCrop.minY == 0, "cursor crop clips at display edges")
    let centerCrop = Capture.crop(screen: screen, cursor: CGPoint(x: 720, y: 450))
    try check(centerCrop.width == 640 && centerCrop.height == 360, "cursor region dimensions")
    let gmailFixture = Data(#"{"text":"Read first: Meeting confirmation","detail":"Meeting confirmation","source":"https://mail.google.com/mail/u/0/#inbox/abc12345","from":"Alex","count":3,"ms":250}"#.utf8)
    let gmail = try JSONDecoder().decode(GmailResult.self, from: gmailFixture).lookup()
    try check(gmail.result.url.hasPrefix("https://mail.google.com/") && gmail.text.contains("Meeting confirmation"), "Gmail recommendation and thread link contract")
    do {
        let invalid = GmailResult(text: "Invalid", detail: "Invalid", source: "https://mail.google.com.evil.test/", from: "", count: 1, ms: 0)
        _ = try invalid.lookup()
        throw GlanceError.message("FAIL: Gmail source validation")
    } catch GlanceError.message(let message) {
        try check(message.contains("invalid thread link"), "Gmail source validation")
    }
    let spellingText = "🙂 teh reply"
    let spellingChanges = [SpellingResult.Change(start: 3, end: 6, original: "teh", replacement: "the")]
    let validatedSpelling = try SpellingEdits.validate(spellingChanges, text: spellingText)
    try check(validatedSpelling.count == 1, "spelling validates UTF-16 offsets")
    do {
        _ = try SpellingEdits.validate([SpellingResult.Change(start: 0, end: 1, original: "x", replacement: "<html>")], text: "x")
        throw GlanceError.message("FAIL: spelling rejects malformed replacements")
    } catch GlanceError.message(let message) { try check(message.contains("Invalid spelling"), "spelling rejects malformed replacements") }
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1000, pixelsHigh: 220,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    NSColor.white.setFill()
    NSBezierPath(rect: CGRect(x: 0, y: 0, width: 1000, height: 220)).fill()
    ("Swift concurrency helps organize async tasks" as NSString).draw(at: CGPoint(x: 30, y: 110), withAttributes: [
        .font: NSFont.systemFont(ofSize: 34), .foregroundColor: NSColor.black])
    NSGraphicsContext.restoreGraphicsState()
    let ocr = try Capture.recognize(bitmap.cgImage!, nearCursor: false).lowercased()
    try check(ocr.contains("swift") && ocr.contains("async"), "Vision OCR on a synthetic image")
    print("\(count) checks passed. No screen captured; no network requests made.")
}

if CommandLine.arguments.contains("--self-test") {
    do { try runSelfTests(); exit(0) }
    catch { print(error.localizedDescription); exit(1) }
}
if CommandLine.arguments.contains("--check-server") {
    Task {
        do { let h = try await CompanionAPI.health(); print("Jev server connected; Jev configured: \(h.jev); Exa configured: \(h.exa)"); exit(0) }
        catch { print(error.localizedDescription); exit(1) }
    }
    dispatchMain()
}
if CommandLine.arguments.contains("--check-lookups") {
    Task {
        do {
            for cursor in [false, true] {
                let r = try await API.lookup(candidates: [Candidate(id: "test", text: "How do Swift actors prevent data races?")], nearCursor: cursor, useJev: true, days: 0)
                print("\(cursor ? "L" : "K"): \(r.text) [\(r.result.url)]")
            }
            exit(0)
        } catch { print(error.localizedDescription); exit(1) }
    }
    dispatchMain()
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let delegate = AppDelegate()
    app.delegate = delegate
    withExtendedLifetime(delegate) { app.run() }
}
