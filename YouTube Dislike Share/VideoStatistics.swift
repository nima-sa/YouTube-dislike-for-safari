import Foundation

// Shared links never submit votes or use the Safari extension's installation ID.
enum SharedVideo {
    static func id(in text: String) -> String? {
        guard text.utf8.count <= 16384 else { return nil }
        let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
        let range = NSRange(text.startIndex..., in: text)
        let urls = detector?.matches(in: text, range: range).compactMap(\.url) ?? []
        let ids = Set(urls.compactMap(id(from:)))
        return ids.count == 1 ? ids.first : nil
    }

    static func id(from url: URL) -> String? {
        guard ["https", "http"].contains(url.scheme?.lowercased() ?? ""),
              url.user == nil, url.password == nil, url.port == nil,
              let host = url.host?.lowercased() else { return nil }
        let parts = url.path.split(separator: "/").map(String.init)
        var candidate: String?
        if host == "youtu.be", parts.count == 1 { candidate = parts[0] }
        else if ["youtube.com", "www.youtube.com", "m.youtube.com"].contains(host) {
            if url.path == "/watch" {
                let values = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.filter { $0.name == "v" } ?? []
                if values.count == 1 { candidate = values[0].value }
            } else if parts.count == 2, ["shorts", "live", "embed"].contains(parts[0]) { candidate = parts[1] }
        }
        guard let candidate, candidate.range(of: "^[A-Za-z0-9_-]{11}$", options: .regularExpression) != nil else { return nil }
        return candidate
    }
}

struct VideoStatistics: Decodable {
    let id: String?
    let likes: Int64
    let dislikes: Int64
    func validated(for videoID: String) throws -> Self {
        guard (id == nil || id == videoID), likes >= 0, dislikes >= 0,
              likes <= 9_007_199_254_740_991, dislikes <= 9_007_199_254_740_991 else { throw StatisticsError.invalidResponse }
        return self
    }
}

enum StatisticsError: Error { case invalidResponse }

private final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

enum StatisticsClient {
    static func fetch(videoID: String) async throws -> VideoStatistics {
        guard let url = URL(string: "https://returnyoutubedislikeapi.com/votes?videoId=\(videoID)"),
              videoID.range(of: "^[A-Za-z0-9_-]{11}$", options: .regularExpression) != nil else { throw StatisticsError.invalidResponse }
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCache = nil
        config.timeoutIntervalForRequest = 10
        config.timeoutIntervalForResource = 10
        let session = URLSession(configuration: config, delegate: NoRedirects(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200, data.count < 1_048_576 else { throw StatisticsError.invalidResponse }
        return try JSONDecoder().decode(VideoStatistics.self, from: data).validated(for: videoID)
    }
}
