import Foundation

struct BuildIdentity {
    let commit: String
    let url: URL

    init?(info: [String: Any]) {
        guard let repository = info["CIRepository"] as? String,
              repository == "skar404/youtube-dislike-for-safari",
              let commit = info["CICommit"] as? String,
              commit.range(of: "^[0-9a-f]{40}$", options: .regularExpression) != nil,
              let version = info["CIVersion"] as? String,
              version == info["CFBundleShortVersionString"] as? String,
              let build = info["CIBuild"] as? String,
              build == info["CFBundleVersion"] as? String,
              let run = info["CIRun"] as? String,
              run.range(of: "^[1-9][0-9]*$", options: .regularExpression) != nil,
              let attempt = info["CIAttempt"] as? String,
              attempt.range(of: "^[1-9][0-9]*$", options: .regularExpression) != nil,
              let url = URL(string: "https://github.com/\(repository)/actions/runs/\(run)/attempts/\(attempt)") else { return nil }
        self.commit = commit
        self.url = url
    }
    var label: String { "CI · \(commit.prefix(7))" }
}
