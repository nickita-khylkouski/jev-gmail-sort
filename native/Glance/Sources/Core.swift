import Foundation

enum GlanceError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}

struct Candidate: Codable, Equatable {
    let id: String
    let text: String
}

enum TextTools {
    static func words(_ text: String, limit: Int) -> String {
        text.split(whereSeparator: { $0.isWhitespace }).prefix(limit).joined(separator: " ")
    }
    static func brief(_ text: String) -> String {
        var clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        for (long, short) in [("by using", "using"), ("in order to", "to"),
                              ("one at a time", "sequentially"), ("is able to", "can")] {
            clean = clean.replacingOccurrences(of: long, with: short, options: .caseInsensitive)
        }
        guard clean.split(whereSeparator: { $0.isWhitespace }).count > 15 else { return clean }
        var parts = clean.split(whereSeparator: { $0.isWhitespace }).prefix(15).map(String.init)
        let trailing = Set(["a", "an", "the", "to", "at", "by", "of", "for", "and", "or", "with", "in", "on", "from"])
        while let last = parts.last, trailing.contains(last.lowercased()) { parts.removeLast() }
        return parts.joined(separator: " ").trimmingCharacters(in: CharacterSet(charactersIn: ",;:")) + "…"
    }
    static func redact(_ text: String) -> String {
        var result = text
        let patterns = [
            #"(?i)\b(?:authorization\s*:\s*)?bearer\s+[A-Za-z0-9._~+/\-]+=*"#,
            #"(?i)\b(?:apikey_|sk-|ghp_|github_pat_)[A-Za-z0-9_\-]{8,}\b"#,
            #"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"#,
            #"\b[A-Za-z0-9+/=_\-]{40,}\b"#,
            #"[A-Z0-9a-z._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}"#,
            #"(?i)(?:api[_ -]?key|password|secret|bearer|token)\s*[:=]\s*\S+"#,
            #"https?://[^\s?]+\?[^\s]+"#
        ]
        for pattern in patterns {
            result = result.replacingOccurrences(of: pattern, with: "[redacted]", options: .regularExpression)
        }
        return result
    }
    static func score(_ text: String) -> Int {
        let lower = text.lowercased()
        var score = min(text.count, 180) / 15
        for hint in ["?", "error", "failed", "exception", "how to", "why", "what is", "compare", "release", "research", "issue"] {
            if lower.contains(hint) { score += 15 }
        }
        if lower.contains("[redacted]") { score -= 40 }
        if text.split(separator: " ").count < 4 { score -= 15 }
        return score
    }
    static func candidates(_ text: String, selected: String = "") -> [Candidate] {
        let lines = redact(text).components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { $0.count > 12 && $0.count < 900 }
        var blocks: [String] = []
        if !selected.isEmpty { blocks.append(String(redact(selected).prefix(500))) }
        for i in stride(from: 0, to: lines.count, by: 2) {
            blocks.append(String(lines[i..<min(i + 3, lines.count)].joined(separator: " ").prefix(500)))
        }
        var seen = Set<String>()
        let ranked = blocks.filter { seen.insert($0).inserted }
            .sorted { score($0) > score($1) }
        var picked = Array(ranked.prefix(24))
        let cleanSelected = String(redact(selected).prefix(500))
        if !cleanSelected.isEmpty {
            picked.removeAll { $0 == cleanSelected }
            picked.insert(cleanSelected, at: 0)
            picked = Array(picked.prefix(24))
        }
        return picked.enumerated().map { Candidate(id: "region_\($0.offset)", text: $0.element) }
    }
    static func cursorLine(_ text: String) -> String {
        var clean = redact(text).replacingOccurrences(of: "[redacted]", with: "")
        clean = clean.replacingOccurrences(of: #"(?i)\b(last (received|synced|updated)|signed in as)\b.*$"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\b\d{1,4}[/:-]\d{1,2}(?:[/:-]\d{1,4})?\b"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?\b"#, with: "", options: [.regularExpression, .caseInsensitive])
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let labels = Set(["connected", "disconnected", "disconnect", "disconnect email", "connect email", "connect gmail", "settings", "save", "cancel", "close", "back", "next", "continue", "sign in", "sign out", "am", "pm"])
        guard clean.rangeOfCharacter(from: .letters) != nil, !labels.contains(clean.lowercased()) else { return "" }
        return clean
    }
    static func cursorQuery(_ text: String) -> String {
        words(text.components(separatedBy: .newlines).map(cursorLine).filter { !$0.isEmpty }.joined(separator: " "), limit: 55)
    }
    static func answerSentence(_ text: String) -> String? {
        var clean = text.replacingOccurrences(of: #"\[\d+(?:[, -]+\d+)*\]"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\[([^\]]+)\]\([^\)]+\)"#, with: "$1", options: .regularExpression)
            .replacingOccurrences(of: #"[*_`#]+"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        for (long, short) in [("by using", "using"), ("in order to", "to"), ("one at a time", "sequentially"), ("is able to", "can")] {
            clean = clean.replacingOccurrences(of: long, with: short, options: .caseInsensitive)
        }
        // Never turn a verbose generated answer into another cut-off excerpt.
        let count = clean.split(whereSeparator: { $0.isWhitespace }).count
        guard (10...15).contains(count), let last = clean.last, ".!?".contains(last) else { return nil }
        return clean
    }
    static func excerpt(_ result: SearchResult) -> String {
        let raw = result.highlights?.first(where: { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) ?? result.title
        let paragraphs = raw.components(separatedBy: .newlines).map {
            $0.replacingOccurrences(of: #"\[([^\]]+)\]\([^\)]+\)"#, with: "$1", options: .regularExpression)
              .trimmingCharacters(in: .whitespacesAndNewlines)
        }.filter { !$0.hasPrefix("#") && !$0.hasPrefix("![") && $0.split(separator: " ").count >= 10 }
        let clean = (paragraphs.first ?? raw)
            .replacingOccurrences(of: #"[#*_`]+"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        let shortened = words(clean, limit: 15)
        return clean.split(whereSeparator: { $0.isWhitespace }).count > 15 ? shortened + "…" : shortened
    }
}

struct SearchResult: Codable {
    let title: String
    let url: String
    let publishedDate: String?
    let highlights: [String]?
}
struct SearchResponse: Codable {
    struct Output: Codable {
        struct Answer: Codable { let answer: String; let supported: Bool }
        enum Content: Codable {
            case text(String), answer(Answer)
            init(from decoder: Decoder) throws {
                let value = try decoder.singleValueContainer()
                if let answer = try? value.decode(Answer.self) { self = .answer(answer) }
                else { self = .text(try value.decode(String.self)) }
            }
            func encode(to encoder: Encoder) throws {
                var value = encoder.singleValueContainer()
                switch self {
                case .text(let text): try value.encode(text)
                case .answer(let answer): try value.encode(answer)
                }
            }
            var supportedText: String? {
                switch self {
                case .text(let text): return text
                case .answer(let answer): return answer.supported ? answer.answer : nil
                }
            }
        }
        struct Grounding: Codable {
            struct Citation: Codable { let url: String; let title: String? }
            let field: String?
            let citations: [Citation]?
            let confidence: String?
        }
        let content: Content?
        let grounding: [Grounding]?
    }
    let results: [SearchResult]
    let resolvedSearchType: String?
    let output: Output?
    func briefAnswer() throws -> (SearchResult, String) {
        guard let raw = output?.content?.supportedText else {
            throw GlanceError.message("No reliable explanation found. Point at a clearer topic or widen the date range.")
        }
        guard let text = TextTools.answerSentence(raw) else {
            throw GlanceError.message("Exa did not return a complete short answer. Try the lookup again.")
        }
        // Structured outputs can cite each field separately. Use evidence for the actual answer.
        guard let citation = output?.grounding?.filter({
            ($0.field == nil || $0.field == "answer" || $0.field == "content" || $0.field == "content.answer") && $0.confidence != "low"
        }).flatMap({ $0.citations ?? [] }).first(where: { API.validURL($0.url) }) else {
            throw GlanceError.message("Exa could not support this explanation with a source. Try a more specific topic.")
        }
        let source = results.first(where: { $0.url == citation.url }) ?? SearchResult(
            title: citation.title ?? "Source", url: citation.url, publishedDate: nil, highlights: nil)
        return (source, text)
    }
}
struct Lookup: Decodable {
    let result: SearchResult
    let text: String
    let query: String
    let elapsed: TimeInterval
    let note: String?
}
struct JevResponse: Decodable {
    struct Answer: Decodable { let choice: String; let confidence: Double }
    let answers: [String: Answer]
}

enum API {
    static func validURL(_ text: String) -> Bool {
        guard let url = URL(string: text) else { return false }
        return ["https", "http"].contains(url.scheme?.lowercased() ?? "") && url.host != nil
    }
    static func lookup(candidates: [Candidate], nearCursor: Bool, useJev: Bool, days: Int, cursorAnswers: Bool = true) async throws -> Lookup {
        let value = try await CompanionAPI.request("context", body: [
            "mode": nearCursor ? "cursor" : "screen", "candidates": candidates.map { ["id": $0.id, "text": $0.text] },
            "useJev": useJev, "days": days, "brief": cursorAnswers
        ], type: Lookup.self)
        guard validURL(value.result.url), !value.text.isEmpty else { throw GlanceError.message("Invalid context response.") }
        return value
    }
}
